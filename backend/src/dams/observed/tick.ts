// The worker's side of the dam observations (issue #604 R5; handover.ts for
// the files, 249_dam_observation.sql). Not a job: runTick (jobs/runner.ts)
// calls runDamsTick once per tick, with no user, beside the DWS tick.
//
// Only with DAM_OBSERVATIONS=on (off by default; in production the worker's
// environment in infra/jobs.tf must set it from dam_observations_enabled, a
// change still to make there, docs/deployment.md § Dam observations), and only against a bucket the
// passes read: MIRROR_URL in a live process, else a MIRROR_URL of its own
// (never the committed synthetic copy; `pnpm dev:dams:run` uses a scratch
// directory). Each tick:
//   1. Matches every traced dam polygon whose match is missing or older than
//      the reference set's last load (match.ts), at most MATCHES_PER_TICK.
//   2. Publishes dams/wanted.json: the uids of the matched dams and every
//      dam's outline with the date WOfS should start from, written only when
//      it differs from what this process last wrote (one GET when it hasn't).
//   3. Loads what the passes fetched: for each source, its status, then each
//      key whose last good fetch this process hasn't loaded, its file, into
//      dam_observation (app_dam_observation_load). A Waterbodies file is
//      loaded again when the dams matched to its uid change, so a dam matched
//      after the file was fetched gets its series. A 304 week moves a key's
//      last good fetch, so each unchanged file is read and loaded again once a
//      week (one GET and one call each); the function skips rows it already
//      holds unchanged, so that, and a restarted worker reloading every file,
//      rewrites nothing.
// A failure is logged and left to the next tick; the rest of the tick goes on.
// The log names counts only, never a dam, uid or project.
import { withoutUser, type Db } from '../../db/tx.js';
import { logEvent } from '../../logging/logEvent.js';
import { safeError } from '../../logging/safeError.js';
import type { MirrorStore } from '../../mirror/store.js';
import {
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
import { damOutlines, matchAndWrite } from './match.js';

type Env = Record<string, string | undefined>;

/** The most dams matched in one tick (each one a box query and an overlap); the rest wait for the next. */
export const MATCHES_PER_TICK = 200;

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
	/** Rows inserted or changed. */
	rows: number;
}

/** Per process: the wanted list last written, and per source and key what was last loaded. */
let published: string | null = null;
const loaded = new Map<string, string>();
/** Forget what this process saw (tests). */
export function resetDamsTick(): void {
	published = null;
	loaded.clear();
}

/** One tick's dams work (see the header); null when it is off. Never throws. */
export async function runDamsTick(o: { store?: MirrorStore; env?: Env; now?: () => number } = {}): Promise<DamsTickResult | null> {
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
	const result: DamsTickResult = { dams: 0, matched: 0, matchFailed: 0, published: false, loaded: 0, unreached: 0, failed: 0, rows: 0 };
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
		for (const d of outlines.filter((x) => x.match_stale).slice(0, MATCHES_PER_TICK)) {
			try {
				const r = await withoutUser((db) => matchAndWrite(db, d));
				if (r.applied) {
					d.status = r.result.status;
					d.uid = r.result.uid;
					d.match_stale = false;
					result.matched++;
				}
			} catch (err) {
				result.matchFailed++;
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
				outlines: outlines.map((d) => ({ featureId: d.feature_id, geometry: d.geometry, since: d.wofs_newest ? nextDay(d.wofs_newest) : WOFS_FIRST_DATE }))
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

	// 3. What the passes fetched.
	const matchedTo = new Map<string, string[]>();
	for (const d of outlines) if (d.status === 'matched' && d.uid) matchedTo.set(d.uid, [...(matchedTo.get(d.uid) ?? []), d.feature_id]);
	for (const source of OBSERVATION_SOURCES) {
		try {
			const status = await readStatus(store, source);
			for (const [key, s] of Object.entries(status?.perKey ?? {})) {
				if (!s.lastGood) continue;
				// A Waterbodies file reaches the dams matched to its uid: when they change, load it again.
				const mark = source === 'waterbodies' ? `${s.lastGood}|${[...(matchedTo.get(key) ?? [])].sort().join(',')}` : s.lastGood;
				const id = `${source}:${key}`;
				if (loaded.get(id) === mark) continue;
				if (source === 'waterbodies' && !matchedTo.has(key)) continue;
				try {
					const file = await readObservationFile(store, source as ObservationSource, key);
					// A pass writes the file before the status names its fetch, so a listed fetch has its file; a missing one is retried next tick.
					if (!file) {
						result.failed++;
						continue;
					}
					const r = await withoutUser((db) => loadObservationFile(db, file));
					if (r === false) result.unreached++;
					else {
						result.loaded++;
						result.rows += r.written;
					}
					loaded.set(id, mark);
				} catch (err) {
					result.failed++;
					logEvent('error', { event: 'dams_load_failed', source, ...safeError(err) });
				}
			}
		} catch (err) {
			logEvent('error', { event: 'dams_tick_failed', step: 'status', source, ...safeError(err) });
		}
	}
	if (result.matched || result.matchFailed || result.published || result.loaded || result.failed) {
		logEvent(result.failed || result.matchFailed ? 'warn' : 'info', { event: 'dams_tick', ...result });
	}
	return result;
}
