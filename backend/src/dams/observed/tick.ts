// The worker's side of the dam observations (issue #604 R5; handover.ts for
// the files, 261_dam_observation.sql). Not a job: runTick (jobs/runner.ts)
// calls runDamsTick once per tick, with no user, beside the DWS tick.
//
// Only with DAM_OBSERVATIONS=on (off by default; in production the worker's
// environment in infra/jobs.tf must set it from dam_observations_enabled, a
// change still to make there, docs/deployment.md § Dam observations), and only against a bucket the
// passes read: MIRROR_URL in a live process, else a MIRROR_URL of its own
// (never the committed synthetic copy; `pnpm dev:dams:run` uses a scratch
// directory). Each tick:
//   1. Matches every traced dam polygon whose match is missing or older than
//      the reference set's last load (match.ts), at most MATCHES_PER_TICK,
//      oldest traced first, with the dams whose match failed in this process
//      after the others, so one project's failing dams can't take every slot
//      tick after tick. A dam that can't be compared (too large, too complex)
//      is recorded 'none' with its reason and leaves the stale list.
//   2. Publishes dams/wanted.json: the uids of the matched dams and every
//      dam's outline with the date WOfS should start from (and Sentinel-2's
//      and Sentinel-1's, once the dam holds a row of either), written only when
//      it differs from what this process last wrote (one GET when it hasn't).
//   3. Loads what the passes fetched, into dam_observation
//      (app_dam_observation_load). What was loaded is kept in the database
//      (dam_observation_load_mark, per source and key: the status's lastGood
//      it was checked against, the file's fetchedAt, a digest of the matched
//      dams it was loaded for), so a restarted or cold worker repeats nothing.
//      A key is due when its status lastGood is newer than its mark's, or (a
//      Waterbodies uid) the dams matched to it changed, by feature or by
//      matched_at, so a dam matched or redrawn after the file was fetched gets
//      its series. A key that isn't due costs no GET. A due key's file is
//      read; it is loaded only when its fetchedAt is newer than the mark's or
//      its dams changed (a week with nothing new upstream moves lastGood but
//      not the file, so it costs one GET a week and no load). At most LOADS_PER_TICK files are
//      read a tick, the oldest lastGood first and keys whose last attempt
//      failed after the others; the rest wait for the next tick.
//   4. Radar (s1) only as DAM_OBSERVATIONS_S1 allows (handover.ts damS1Mode;
//      issue #624 open question 3): in `on`, a dam's s1 file is loaded only
//      when its own S1/S2 agreement passes (dams/s1-agreement.json,
//      sentinel/agreement.ts s1Shows), with hysteresis: a dam starts at the
//      85 % bar and, once shown, stays down to 80 % (S1_AGREEMENT.keepBar).
//      Whether it was shown is its s1 load mark: targets '' with a lastGood
//      (a load that succeeded), so the state needs no file or table of its
//      own and survives a restart. In `measure` and `off`, never. A
//      dam's s1 key that may not be loaded is withheld instead: its rows are
//      removed (app_dam_s1_withhold, 283; none on a first look) and its mark
//      written with targets S1_WITHHELD, without reading the file. The mark's
//      targets ('' loaded, S1_WITHHELD withheld) make the key due again when
//      the dam starts or stops passing, so a dam that stops passing loses its
//      radar on the next tick, and one that passes again is reloaded from the
//      file. Withholding reads no file, so it has its own cap (LOADS_PER_TICK).
//      Besides the keys dams/s1-status.json lists, every s1 load mark still
//      shown is checked too, so radar loaded before is withheld even when the
//      status file is gone (or no longer lists the dam).
//      An agreement report that can't be read leaves s1 alone that tick.
// A failure is logged and left to the next tick; the rest of the tick goes on.
// The log names counts only, never a dam, uid or project.
import { createHash } from 'node:crypto';
import { withoutUser, type Db } from '../../db/tx.js';
import { logEvent } from '../../logging/logEvent.js';
import { safeError } from '../../logging/safeError.js';
import type { MirrorStore } from '../../mirror/store.js';
import {
	damS1Mode,
	damsStore,
	MAX_OUTLINES,
	OBSERVATION_SOURCES,
	type ObservationFile,
	type ObservationSource,
	readObservationFile,
	readStatus,
	readWanted,
	type WantedList,
	WOFS_FIRST_DATE,
	writeWanted
} from './handover.js';
import { damOutlines, type DamOutlineRow, matchAndWrite } from './match.js';
import { readAgreement, s1Passing } from './sentinel/agreement.js';

type Env = Record<string, string | undefined>;

/** The most dams matched in one tick (each one a box query and an overlap); the rest wait for the next. */
export const MATCHES_PER_TICK = 200;
/**
 * The most pass files read (and loaded) in one tick. Each is one GET from the mirror bucket inside the VPC and one
 * app_dam_observation_load call: a Waterbodies series is ~1,000–2,000 rows and a dam's WOfS file at most a few
 * thousand, a fraction of a second together, so 200 is well under a minute of the worker's 300 s budget, which the
 * tick's other work and the queued jobs share. A cold start with both status files full (up to ~10,000 keys) then
 * takes ~50 ticks (about four hours on the 5-minute schedule) instead of one invocation that times out.
 */
export const LOADS_PER_TICK = 200;

/** Whether this process runs the dams tick: DAM_OBSERVATIONS on, off or unset (off). */
export function damObservationsOn(env: Env = process.env): boolean {
	const v = env.DAM_OBSERVATIONS?.trim() ?? '';
	if (v !== '' && v !== 'on' && v !== 'off') throw new Error(`unknown DAM_OBSERVATIONS "${v}" (expected on or off)`);
	return v === 'on';
}

/** Load one observation file, as the worker (no user): rows written, the dams it reached, or false when it reached none. */
export async function loadObservationFile(db: Db, f: ObservationFile): Promise<{ written: number; dams: number } | false> {
	const { rows } = await db.query<{ written: number; dams: number; applied: boolean }>(
		'SELECT written, dams, applied FROM app_dam_observation_load($1, $2, $3::date[], $4::float8[], $5::float8[], $6::text[], $7)',
		[f.source, f.key, f.rows.map((r) => r.date), f.rows.map((r) => r.wetAreaM2), f.rows.map((r) => r.pctObserved), f.rows.map((r) => r.upstreamKey), f.fetchedAt]
	);
	const r = rows[0]!;
	return r.applied ? { written: r.written, dams: r.dams } : false;
}

/**
 * The load mark's targets for a dam's s1 key whose radar is withheld (step 4): a fixed digest (the column takes '' or
 * 64 hex digits), so the key is due again whenever the dam moves between loaded ('') and withheld.
 */
export const S1_WITHHELD = createHash('sha256').update('s1:withheld').digest('hex');

/** Remove one dam's radar rows, as the worker: how many were removed. */
export async function withholdS1(db: Db, key: string): Promise<number> {
	const { rows } = await db.query<{ removed: number }>('SELECT removed FROM app_dam_s1_withhold($1)', [key]);
	return rows[0]!.removed;
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export interface DamsTickResult {
	/** Traced dam polygons. */
	dams: number;
	/** Dams matched this tick, and those whose match failed (logged). */
	matched: number;
	matchFailed: number;
	/** The wanted list was written this tick. */
	published: boolean;
	/** Files loaded, files that reached no dam, files that failed (logged; tried next tick). */
	loaded: number;
	unreached: number;
	failed: number;
	/** Files read whose fetch was already loaded (a week with nothing new upstream): the mark moved, nothing was loaded. */
	unchanged: number;
	/** Due files left for the next tick (past LOADS_PER_TICK). */
	deferred: number;
	/** Rows inserted or changed. */
	rows: number;
	/** Dams' radar (s1) keys withheld this tick (step 4), and the rows that removed. */
	withheld: number;
	withheldRows: number;
}

/** Per process: the wanted list last written, and when each dam's match last failed (those go after the others). */
let published: string | null = null;
const matchFailedAt = new Map<string, number>();
/** Forget what this process saw (tests: a fresh process). What was loaded is in the database, not here. */
export function resetDamsTick(): void {
	published = null;
	matchFailedAt.clear();
}

/**
 * The stale dams to match this tick, at most `cap`: oldest traced first (app_dam_outlines' order; the sort is
 * stable), the dams whose match failed in this process after the rest, oldest failure first, so failures can't
 * hold every slot tick after tick. After a restart the failures are forgotten: they take one tick's slots again.
 */
export function matchQueue<T extends Pick<DamOutlineRow, 'feature_id' | 'match_stale'>>(outlines: readonly T[], failedAt: ReadonlyMap<string, number>, cap: number): T[] {
	const at = (d: T) => failedAt.get(d.feature_id) ?? 0;
	return outlines
		.filter((d) => d.match_stale)
		.sort((a, b) => at(a) - at(b))
		.slice(0, cap);
}

/** A load mark as app_dam_load_marks returns it. */
interface LoadMark {
	source: ObservationSource;
	key: string;
	last_good: Date | null;
	fetched_at: Date | null;
	targets: string;
	failed_at: Date | null;
}

/** The digest of the dams a Waterbodies file reaches: each matched dam's feature id and matched_at, sorted. */
export function targetsDigest(dams: readonly Pick<DamOutlineRow, 'feature_id' | 'matched_at'>[]): string {
	const parts = dams.map((d) => `${d.feature_id}@${d.matched_at ? new Date(d.matched_at).toISOString() : ''}`).sort();
	return createHash('sha256').update(parts.join(',')).digest('hex');
}

const ms = (d: Date | null | undefined) => (d ? new Date(d).getTime() : -Infinity);

/** Whether a dam's radar was shown at the worker's last decision: its s1 mark's last success loaded it (targets ''). */
const s1Shown = (mark: LoadMark | undefined): boolean => !!mark && mark.targets === '' && mark.last_good !== null;

const writeMark = (db: Db, source: ObservationSource, key: string, lastGood: string | null, fetchedAt: string | null, targets: string, failed: boolean) =>
	db.query('SELECT applied FROM app_dam_load_mark_write($1, $2, $3, $4, $5, $6)', [source, key, lastGood, fetchedAt, targets, failed]);

/** One tick's dams work (see the header); null when it is off. Never throws. */
export async function runDamsTick(
	o: { store?: MirrorStore; env?: Env; now?: () => number; matchesPerTick?: number; loadsPerTick?: number } = {}
): Promise<DamsTickResult | null> {
	const env = o.env ?? process.env;
	let on: boolean;
	try {
		on = damObservationsOn(env);
	} catch (err) {
		logEvent('error', { event: 'dams_tick_failed', step: 'config', ...safeError(err) });
		return null;
	}
	if (!on) return null;
	const now = o.now ?? Date.now;
	const matchesPerTick = o.matchesPerTick ?? MATCHES_PER_TICK;
	const loadsPerTick = o.loadsPerTick ?? LOADS_PER_TICK;
	const result: DamsTickResult = { dams: 0, matched: 0, matchFailed: 0, published: false, loaded: 0, unreached: 0, failed: 0, unchanged: 0, deferred: 0, rows: 0, withheld: 0, withheldRows: 0 };
	let store: MirrorStore;
	try {
		store = o.store ?? damsStore(env);
	} catch (err) {
		logEvent('error', { event: 'dams_tick_failed', step: 'store', ...safeError(err) });
		return result;
	}

	// 1. Matches.
	let outlines: Awaited<ReturnType<typeof damOutlines>> = [];
	let outlinesRead = false;
	try {
		outlines = await withoutUser(damOutlines);
		outlinesRead = true;
		result.dams = outlines.length;
		if (outlines.length >= MAX_OUTLINES) logEvent('warn', { event: 'dams_outline_cap', cap: MAX_OUTLINES });
		for (const d of matchQueue(outlines, matchFailedAt, matchesPerTick)) {
			try {
				const r = await withoutUser((db) => matchAndWrite(db, d));
				matchFailedAt.delete(d.feature_id);
				if (r.applied) {
					d.status = r.result.status;
					d.uid = r.result.uid;
					d.matched_at = r.matchedAt;
					d.match_stale = false;
					result.matched++;
				}
			} catch (err) {
				result.matchFailed++;
				matchFailedAt.set(d.feature_id, now());
				logEvent('error', { event: 'dams_match_failed', ...safeError(err) });
			}
		}
	} catch (err) {
		logEvent('error', { event: 'dams_tick_failed', step: 'outlines', ...safeError(err) });
	}

	// 2. The wanted list (only once the outlines were read: an empty list would tell the passes to drop everything).
	if (outlinesRead) {
		try {
			const wanted: Omit<WantedList, 'generatedAt'> = {
				waterbodies: [...new Set(outlines.filter((d) => d.status === 'matched' && d.uid).map((d) => d.uid!))].sort(),
				outlines: outlines.map((d) => {
					// A Sentinel source's `since` only once the dam holds a row of it: until then its pass starts from its own backfill.
					const sinceBy = { ...(d.s2_newest ? { s2: nextDay(d.s2_newest) } : {}), ...(d.s1_newest ? { s1: nextDay(d.s1_newest) } : {}) };
					return {
						featureId: d.feature_id,
						geometry: d.geometry,
						since: d.wofs_newest ? nextDay(d.wofs_newest) : WOFS_FIRST_DATE,
						...(Object.keys(sinceBy).length ? { sinceBy } : {})
					};
				})
			};
			const key = JSON.stringify(wanted);
			if (published !== key) {
				const there = await readWanted(store).catch(() => null);
				if (!there || JSON.stringify({ waterbodies: there.waterbodies, outlines: there.outlines }) !== key) {
					await writeWanted(store, { generatedAt: new Date(now()).toISOString(), ...wanted });
					result.published = true;
				}
				published = key;
			}
		} catch (err) {
			logEvent('error', { event: 'dams_tick_failed', step: 'wanted', ...safeError(err) });
		}
	}

	// 3. What the passes fetched (see the header).
	const matchedTo = new Map<string, DamOutlineRow[]>();
	for (const d of outlines) if (d.status === 'matched' && d.uid) matchedTo.set(d.uid, [...(matchedTo.get(d.uid) ?? []), d]);
	let marks: Map<string, LoadMark> | null = null;
	try {
		marks = new Map((await withoutUser(async (db) => (await db.query<LoadMark>('SELECT source, key, last_good, fetched_at, targets, failed_at FROM app_dam_load_marks()')).rows)).map((m) => [`${m.source}:${m.key}`, m]));
	} catch (err) {
		logEvent('error', { event: 'dams_tick_failed', step: 'marks', ...safeError(err) });
	}
	// 4. Which dams' radar may be loaded (see the header); null: leave s1 alone this tick.
	let s1Loads: ((key: string) => boolean) | null = null;
	if (marks) {
		try {
			const mode = damS1Mode(env);
			if (mode === 'on') {
				const shown = new Set([...marks.values()].filter((m) => m.source === 's1' && s1Shown(m)).map((m) => m.key));
				const passing = s1Passing(await readAgreement(store), shown);
				s1Loads = (key) => passing.has(key);
			} else s1Loads = () => false;
		} catch (err) {
			logEvent('error', { event: 'dams_tick_failed', step: 's1_agreement', ...safeError(err) });
		}
	}
	if (marks) {
		type Due = { source: ObservationSource; key: string; lastGood: string; targets: string; mark: LoadMark | undefined };
		const due: Due[] = [];
		const withhold: Due[] = [];
		for (const source of OBSERVATION_SOURCES) {
			if (source === 's1' && !s1Loads) continue;
			try {
				const status = await readStatus(store, source);
				if (source === 's1') {
					// Radar shown before for a dam the status no longer lists (the file deleted, or the dam dropped from it):
					// withheld by its mark alone when it may not be shown now. One that may stays as it is: there is no file to read.
					const listed = (key: string) => {
						const s = status && Object.hasOwn(status.perKey, key) ? status.perKey[key] : undefined;
						return !!s?.lastGood && !Number.isNaN(Date.parse(s.lastGood));
					};
					for (const mark of marks.values()) {
						if (mark.source !== 's1' || !s1Shown(mark) || listed(mark.key) || s1Loads!(mark.key)) continue;
						const lastGood = new Date(mark.last_good!).toISOString();
						withhold.push({ source, key: mark.key, lastGood, targets: S1_WITHHELD, mark });
					}
				}
				for (const [key, s] of Object.entries(status?.perKey ?? {})) {
					if (!s.lastGood || Number.isNaN(Date.parse(s.lastGood))) continue;
					// A Waterbodies file reaches the dams matched to its uid only: none, nothing to load.
					if (source === 'waterbodies' && !matchedTo.has(key)) continue;
					const withheld = source === 's1' && !s1Loads!(key);
					const targets = source === 'waterbodies' ? targetsDigest(matchedTo.get(key)!) : withheld ? S1_WITHHELD : '';
					const mark = marks.get(`${source}:${key}`);
					if (mark && Date.parse(s.lastGood) <= ms(mark.last_good) && mark.targets === targets) continue;
					(withheld ? withhold : due).push({ source, key, lastGood: s.lastGood, targets, mark });
				}
			} catch (err) {
				logEvent('error', { event: 'dams_tick_failed', step: 'status', source, ...safeError(err) });
			}
		}
		// Never-failed (or since succeeded) first, oldest lastGood first; then the failing ones, oldest failure first.
		const failedAt = (d: Due) => (d.mark?.failed_at ? ms(d.mark.failed_at) : 0);
		const order = (a: Due, b: Due) => failedAt(a) - failedAt(b) || Date.parse(a.lastGood) - Date.parse(b.lastGood) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
		due.sort(order);
		withhold.sort(order);
		result.deferred = Math.max(0, due.length - loadsPerTick) + Math.max(0, withhold.length - loadsPerTick);
		// Radar withheld: no file read; the rows go, the mark says withheld (its fetchedAt kept, else the status's lastGood).
		for (const { source, key, lastGood, targets, mark } of withhold.slice(0, loadsPerTick)) {
			try {
				const removed = await withoutUser(async (db) => {
					const n = await withholdS1(db, key);
					await writeMark(db, source, key, lastGood, mark?.fetched_at ? new Date(mark.fetched_at).toISOString() : lastGood, targets, false);
					return n;
				});
				result.withheld++;
				result.withheldRows += removed;
			} catch (err) {
				result.failed++;
				logEvent('error', { event: 'dams_load_failed', source, step: 'withhold', ...safeError(err) });
				await withoutUser((db) => writeMark(db, source, key, null, null, targets, true)).catch((e) =>
					logEvent('error', { event: 'dams_tick_failed', step: 'mark', source, ...safeError(e) })
				);
			}
		}
		for (const { source, key, lastGood, targets, mark } of due.slice(0, loadsPerTick)) {
			try {
				const file = await readObservationFile(store, source, key);
				// A pass writes the file before the status names its fetch, so a listed fetch has its file; a missing one is retried next tick.
				if (!file) throw new Error('the status names a fetch whose file is missing');
				const fresh = !mark || Date.parse(file.fetchedAt) > ms(mark.fetched_at) || mark.targets !== targets;
				const r = await withoutUser(async (db) => {
					const loadedNow = fresh ? await loadObservationFile(db, file) : null;
					await writeMark(db, source, key, lastGood, file.fetchedAt, targets, false);
					return loadedNow;
				});
				if (r === null) result.unchanged++;
				else if (r === false) result.unreached++;
				else {
					result.loaded++;
					result.rows += r.written;
				}
			} catch (err) {
				result.failed++;
				logEvent('error', { event: 'dams_load_failed', source, ...safeError(err) });
				await withoutUser((db) => writeMark(db, source, key, null, null, targets, true)).catch((e) =>
					logEvent('error', { event: 'dams_tick_failed', step: 'mark', source, ...safeError(e) })
				);
			}
		}
	}
	if (result.matched || result.matchFailed || result.published || result.loaded || result.failed || result.deferred || result.withheldRows) {
		logEvent(result.failed || result.matchFailed ? 'warn' : 'info', { event: 'dams_tick', ...result });
	}
	return result;
}
