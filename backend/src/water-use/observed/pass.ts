// The WaPOR pass: FAO's dekadal actual ET averaged over each unit's parcels,
// into the mirror bucket for the worker to load into et_observation (issue
// #623 step 4; 276_et_observation.sql, docs/architecture.md § Observed
// actual ET). The fetcher Lambda runs it in its `et-dekadal` mode
// (lambda-fetcher.ts), outside the VPC; the handover is handover.ts's:
//
//   worker tick ──put──► et/wanted.json            every unit's parcels (∩ cropland where loaded)
//   fetcher ─get─► et/wanted.json, et/wapor-status.json, et/wapor-state.json, each unit's file
//           ─GET─► storage.googleapis.com/fao-gismgr-wapor-3-data/…/WAPOR-3.L2-AETI-D.<YYYY-MM-Dn>.tif
//                  (the header, then per unit the tile tables' slice and the tiles under its parcels)
//           ─put─► et/wapor/<unitKey>.json     EtFile: one row per dekad, with the file and its ETag
//           ─put─► et/wapor-state.json         ours: per dekad file the ETag read and when, per unit its hash
//           ─put─► et/wapor-status.json        EtPassStatus: per unit lastGood / newest / error
//   worker tick ──get──► the status, then each newer et/wapor/<unitKey>.json → app_et_observation_load
//
// What a run does. The dekads go newest first, from the last one that has
// ended back to WAPOR_FIRST_DEKAD (2018), so every unit is current before
// any time goes on the past, and a first backfill (about 300 dekads) runs
// over several runs, each going on below where the last stopped (a dekad
// every unit holds costs nothing). For each dekad:
//
//   - a unit is read when its file has no row for the dekad, or its row came
//     from another version of the file (its ETag isn't the file's now);
//   - the file is asked for when some unit is to be read, or when its ETag
//     was last checked RECHECK_DAYS ago or more: then it is a conditional
//     GET of the header (If-None-Match, the ETag read last), which a 304
//     answers with nothing. FAO rewrites files in place (2025 files were
//     rewritten in 2026-05), so a changed ETag re-reads every unit's row of
//     that dekad, and the loader counts the row's revision;
//   - a 404 for a dekad that ended in the last RECENT_DAYS is not published
//     yet: asked again next run. An older one is noted missing and asked
//     again after RECHECK_DAYS.
//
// One file's reads all carry its ETag: a response with another (FAO rewrote
// it mid-read) abandons that dekad for this run, nothing kept from it.
//
// A unit's read (wapor.ts): the header once per dekad, then for each unit
// the slice of the tile tables for its window's tile rows and the tiles
// under its parcels' bounding box (raster/cog.ts readWindow), never the
// file; about 3 requests a unit a dekad. A unit no pixel centre falls in, or
// too large for one window, can't be observed: noted with its code, and not
// read again until its parcels change.
//
// A unit whose parcels or cropland changed (its hash in the state file
// differs) starts again: its file is rewritten from scratch, as 276's
// trigger drops its rows. Otherwise the file keeps every row read, never cut
// back, and is rewritten only when a row is new or changed, or the wanted
// list it was made from changed (parcelsAt, which the loader checks against
// the parcels' last change).
//
// Politeness (#604 "The rule"): one User-Agent (feeds/http.ts), at most one
// request a second (REQUEST_INTERVAL_MS), one in flight. An HTTP 403 or
// throttling (429/503) stops the run at once, never retried: the status says
// stopped and why (with a Retry-After when given), and the source is left
// alone for a day or the Retry-After, whichever is longer (dams/observed/
// handover.ts pausedUntil, the same rule): the next runs ask nothing, write
// nothing and publish no heartbeat, so the heartbeat alarm is the alert
// (infra/et_observations.tf). A file the reader refuses, or a timeout, ends
// that unit's read of that dekad (counted, with a code); anything else is a
// bug and throws (the files read so far, the state and the status are
// written first).
//
// Locally (FEED_SOURCE=fixtures) the client is the synthetic one
// (fixtures.ts) and pacing is off.
import { createHash } from 'node:crypto';
import { toEpochDay } from '@water-management/engine/calendar';
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { FeedFormatError, FeedRefusedError, FeedThrottledError, FeedUnavailableError } from '../../feeds/errors.js';
import type { FeedHttp } from '../../feeds/http.js';
import type { MirrorStore } from '../../mirror/store.js';
import { HEADER_READ_BYTES, openCog, readWindow, type CogInfo, type RangeRead } from '../../raster/cog.js';
import { outlineMask, sceneWindow } from '../../raster/mask.js';
import { pausedUntil, stopRetryAfter } from '../../dams/observed/handover.js';
import { type EtFile, type EtPassStatus, type EtRow, readEtFile, readStatus, readWanted, recencyDays, type WantedUnit, writeEtFile, writeStatus } from './handover.js';
import { dekadEnd, endedDekads, unitMean, unitWeights, WAPOR_ACCEPT, WAPOR_FIRST_DEKAD, WAPOR_SCALE, WAPOR_VERSION, waporFileName, waporUrl, type UnitWeights } from './wapor.js';

/** Minimum gap between two requests' starts: one a second, to one host. */
export const REQUEST_INTERVAL_MS = 1000;
/** A dekad file's ETag is checked again this long after it was last read or checked. */
export const RECHECK_DAYS = 30;
/** A dekad that ended this recently and answers 404 isn't published yet: asked again next run, not noted missing. */
export const RECENT_DAYS = 30;

export const STATE_KEY = '/et/wapor-state.json' as AbsolutePath;

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const UNIT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** et/wapor-state.json: the pass's own bookkeeping. Never read by the worker. */
export const WaporState = z
	.object({
		v: z.literal(1),
		/** Per dekad file read or asked for: its ETag (when it had one) and the day it was last read or checked, or that it was missing. */
		files: z.record(
			IsoDay,
			z.object({ etag: z.string().min(1).max(200).optional(), missing: z.literal(true).optional(), checkedOn: IsoDay }).strict()
		),
		/** Per unit: the SHA-256 of its parcels and cropland as last read, and why it can't be observed, when it can't. */
		units: z.record(z.string().regex(UNIT_KEY), z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), unobservable: z.string().max(40).optional() }).strict())
	})
	.strict();
export type WaporState = z.output<typeof WaporState>;

export async function readState(store: MirrorStore): Promise<WaporState | null> {
	const bytes = await store.get(STATE_KEY);
	if (bytes === undefined) return null;
	try {
		const r = WaporState.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
		// Our own file: if it can't be read, start the bookkeeping again rather than stop every run. Without the units' hashes no file can be
		// trusted to match its unit's parcels, so every unit is read again from scratch (a few hours of runs).
		return r.success ? r.data : null;
	} catch {
		return null;
	}
}
const writeState = (store: MirrorStore, s: WaporState) => store.set(STATE_KEY, new TextEncoder().encode(JSON.stringify(s)));

/** A unit's fingerprint: SHA-256 of its parcels and cropland as the wanted list gives them. */
export const unitHash = (u: Pick<WantedUnit, 'parcels' | 'cropland'>) => createHash('sha256').update(JSON.stringify({ parcels: u.parcels, cropland: u.cropland ?? null })).digest('hex');

export type WaporStop = 'no_list' | 'done' | 'deadline' | 'refused' | 'throttled' | 'paused';

export interface WaporPassOptions {
	store: MirrorStore;
	http: FeedHttp;
	/** Today (UTC), ISO. */
	today: string;
	/** Epoch ms after which no new request is started. */
	deadline?: number;
	/** 0 in fixtures mode. */
	intervalMs?: number;
	recheckDays?: number;
	firstDekad?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface WaporPassResult {
	/** Units whose file was written this run. */
	written: string[];
	/** Unit reads that failed (a format the reader refused, a timeout), each with its code, for the log. */
	failures: { unitKey: string; dekad: string; code: string; error: unknown }[];
	/** Units that can't be observed (no pixel inside, too large), noted this run. */
	unobservable: number;
	/** Dekad files whose header was read, and those found changed (a new ETag: their units re-read). */
	filesRead: number;
	filesChanged: number;
	/** Conditional checks answered not modified. */
	notModified: number;
	/** Dekads abandoned because the file changed while being read. */
	changedMidRead: number;
	requests: number;
	stopped: WaporStop;
	pausedUntil?: string;
	recencyDays: number | null;
	/** What stopped the run (a 403, throttling), or null. */
	error: unknown;
}

/** A response carried another ETag than the file's header: FAO rewrote it while we read. */
class FileChanged extends Error {}
class Deadline extends Error {}

const stopReason = (err: unknown): 'refused' | 'throttled' | null => (err instanceof FeedRefusedError ? 'refused' : err instanceof FeedThrottledError ? 'throttled' : null);
/** A tag kept with a row: a real ETag only (fileTag's `lm:` Last-Modified stand-in isn't one). */
const rowTag = (tag: string | null | undefined) => (tag && !tag.startsWith('lm:') ? tag : undefined);

interface UnitWork {
	unit: WantedUnit;
	rows: Map<string, EtRow>;
	mask: EtFile['mask'] | null;
	dirty: boolean;
	/** Per grid (a key of the grid's numbers): the weights, or why it can't be observed. */
	weights: Map<string, UnitWeights | string>;
	read: boolean;
	failed: string | null;
}

/** One pass (see the header). Throws only for the mirror itself or a bug; the upstream's failures are reported. */
export async function runWaporPass(opts: WaporPassOptions): Promise<WaporPassResult> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const intervalMs = opts.intervalMs ?? REQUEST_INTERVAL_MS;
	const recheckDays = opts.recheckDays ?? RECHECK_DAYS;
	const { store, today } = opts;
	const isoNow = () => new Date(now()).toISOString();
	const result: WaporPassResult = {
		written: [],
		failures: [],
		unobservable: 0,
		filesRead: 0,
		filesChanged: 0,
		notModified: 0,
		changedMidRead: 0,
		requests: 0,
		stopped: 'done',
		recencyDays: null,
		error: null
	};

	// One request at a time (each awaited), at most one a second.
	let last = -Infinity;
	const pace = async () => {
		const left = Math.max(0, last + intervalMs - now());
		// No request starts at or past the deadline, the wait included.
		if (opts.deadline !== undefined && now() + left >= opts.deadline) throw new Deadline();
		if (left > 0) await sleep(left);
		last = now();
		result.requests++;
	};
	const http = opts.http;
	if (!http.rangeTagged) throw new Error('the ET pass needs a client that reports each response’s tag');
	const tagged = async (url: string, start: number, end: number) => (await pace(), http.rangeTagged!(url, start, end));
	const conditional = async (url: string, start: number, end: number, etag: string) => {
		await pace();
		if (http.rangeConditional) return http.rangeConditional(url, start, end, etag);
		const got = await http.rangeTagged!(url, start, end);
		return got === null ? null : got.tag === etag ? ({ status: 'not-modified' } as const) : ({ status: 'ok', bytes: got.bytes, tag: got.tag } as const);
	};

	const previous = await readStatus(store, 'wapor');
	// Paused after a refusal or throttling: ask nothing, write nothing (the status, and so the pause, stand).
	const until = pausedUntil(previous);
	if (until !== null && now() < until) return { ...result, stopped: 'paused', pausedUntil: new Date(until).toISOString(), recencyDays: recencyDays(previous!, today) };
	const wanted = await readWanted(store);
	if (!wanted) return { ...result, stopped: 'no_list' };
	const prevState = await readState(store);

	// Only the listed units are kept: a unit whose parcels were all removed drops out of the status and the state.
	const state: WaporState = { v: 1, files: { ...(prevState?.files ?? {}) }, units: {} };
	const perKey: EtPassStatus['perKey'] = {};
	const work: UnitWork[] = [];
	for (const unit of wanted.units) {
		const hash = unitHash(unit);
		const prev = prevState?.units[unit.unitKey];
		const same = prev?.hash === hash;
		state.units[unit.unitKey] = { hash, ...(same && prev.unobservable ? { unobservable: prev.unobservable } : {}) };
		let existing: EtFile | null = null;
		if (same) {
			try {
				existing = await readEtFile(store, 'wapor', unit.unitKey);
			} catch (err) {
				// Our own file unreadable: rebuilt from the dekads.
				if (!(err instanceof FeedFormatError)) throw err;
			}
		}
		const rows = new Map((existing?.rows ?? []).map((r) => [r.dekad, r]));
		const pk = previous?.perKey[unit.unitKey];
		if (pk) perKey[unit.unitKey] = same ? { ...pk } : {};
		work.push({
			unit,
			rows,
			mask: existing?.mask ?? null,
			// A changed unit's old file must not be loaded again; one made from an older wanted list is relabelled (parcelsAt).
			dirty: !same || !existing || existing.parcelsAt !== wanted.generatedAt,
			weights: new Map(),
			read: false,
			failed: null
		});
	}
	const observable = (w: UnitWork) => !state.units[w.unit.unitKey]!.unobservable;

	/** One unit's row for a dekad from an open file, or the unit noted unobservable. */
	const readUnit = async (w: UnitWork, cog: CogInfo, read: RangeRead, dekad: string, tag: string | undefined): Promise<void> => {
		const gridKey = `${cog.originX}/${cog.originY}/${cog.pixelSizeX}/${cog.pixelSizeY}`;
		let weights = w.weights.get(gridKey);
		if (weights === undefined) {
			try {
				const mask = outlineMask(w.unit.parcels, cog);
				weights = mask.inside === 0 ? 'no_pixels' : unitWeights(mask, cog, w.unit.cropland);
			} catch (err) {
				if (!(err instanceof FeedFormatError)) throw err;
				weights = 'too_large';
			}
			w.weights.set(gridKey, weights);
		}
		const win = typeof weights === 'string' ? null : sceneWindow(weights.mask, cog);
		const mean = typeof weights === 'string' ? null : unitMean(weights, win, win ? await readWindow(read, cog, win) : null, cog);
		if (typeof weights === 'string' || mean === null) {
			state.units[w.unit.unitKey]!.unobservable = typeof weights === 'string' ? weights : win ? 'no_pixels' : 'off_the_grid';
			result.unobservable++;
			return;
		}
		if (w.mask !== null && w.mask !== weights.label) {
			// The same parcels and cropland always give the same label; a file that says otherwise is rebuilt.
			w.rows.clear();
		}
		w.mask = weights.label;
		const row: EtRow = { dekad, ...mean, file: waporFileName(dekad), ...(tag ? { etag: tag } : {}) };
		const was = w.rows.get(dekad);
		if (!was || JSON.stringify(was) !== JSON.stringify(row)) w.dirty = true;
		w.rows.set(dekad, row);
		w.read = true;
	};

	let stop: 'refused' | 'throttled' | null = null;
	let threw = false;
	try {
		const firstDekad = opts.firstDekad ?? WAPOR_FIRST_DEKAD;
		for (const dekad of endedDekads(firstDekad, today)) {
			const url = waporUrl(dekad);
			const f = state.files[dekad];
			// Never checked (a lost state file) counts as due: the rows held say which ETag to send.
			const recheckDue = !f || toEpochDay(f.checkedOn) <= toEpochDay(today) - recheckDays;
			const units = work.filter(observable);
			const lacking = units.filter((w) => !w.rows.has(dekad));
			const holding = units.filter((w) => w.rows.has(dekad));
			// Rows read from another version of the file than the one last seen (a re-read the deadline cut short).
			const stale = f && !f.missing ? holding.filter((w) => rowTag(f.etag) !== w.rows.get(dekad)!.etag) : [];
			if (f?.missing && !recheckDue) continue;
			if (!lacking.length && !stale.length && !(recheckDue && holding.length)) continue;

			// The header: conditional when only a re-check is due and there's an ETag to send.
			let header: Uint8Array;
			let tag: string | null;
			const known = f && !f.missing ? rowTag(f.etag) : holding.map((w) => w.rows.get(dekad)!.etag).find((t) => t !== undefined);
			try {
				if (!lacking.length && !stale.length && known) {
					const got = await conditional(url, 0, HEADER_READ_BYTES - 1, known);
					if (got === null) {
						state.files[dekad] = { missing: true, checkedOn: today };
						continue;
					}
					if (got.status === 'not-modified') {
						state.files[dekad] = { etag: known, checkedOn: today };
						result.notModified++;
						continue;
					}
					header = got.bytes;
					tag = got.tag;
				} else {
					const got = await tagged(url, 0, HEADER_READ_BYTES - 1);
					if (got === null) {
						// Not published yet (a recent dekad), else noted missing and asked again after the re-check days.
						if (toEpochDay(dekadEnd(dekad)) < toEpochDay(today) - RECENT_DAYS) state.files[dekad] = { missing: true, checkedOn: today };
						continue;
					}
					header = got.bytes;
					tag = got.tag;
				}
			} catch (err) {
				// A timeout (not a 403 or throttling, which stop the run): the units wanting this dekad wait for the next run.
				if (stopReason(err) || !(err instanceof FeedUnavailableError)) throw err;
				for (const w of [...lacking, ...stale]) {
					w.failed = 'unavailable';
					result.failures.push({ unitKey: w.unit.unitKey, dekad, code: 'unavailable', error: err });
				}
				continue;
			}
			result.filesRead++;
			const current = rowTag(tag);
			if (known !== undefined && known !== current) result.filesChanged++;
			const toRead = units.filter((w) => !w.rows.has(dekad) || w.rows.get(dekad)!.etag !== current);

			// Every read of the file after the header must carry its tag, or it changed while we read.
			const read: RangeRead = async (start, end) => {
				if (start === 0 && end < header.length) return header.subarray(0, end + 1);
				const got = await tagged(url, start, end);
				if (!got) throw new FileChanged();
				if ((got.tag ?? null) !== (tag ?? null)) throw new FileChanged();
				return got.bytes;
			};
			let cog: CogInfo | null;
			try {
				cog = await openCog(read, WAPOR_ACCEPT);
				if (!cog) throw new FeedFormatError('the dekad’s file is empty');
				if (cog.scale !== WAPOR_SCALE || cog.offset !== 0) throw new FeedFormatError(`the file’s band scale is ${cog.scale} and offset ${cog.offset}, not ${WAPOR_SCALE} and 0`);
				if (cog.nodata === null) throw new FeedFormatError('the file has no nodata value');
			} catch (err) {
				if (err instanceof FileChanged) {
					result.changedMidRead++;
					continue;
				}
				// A 403 or throttling is a FeedUnavailableError too: it stops the run, never just this dekad.
				if (stopReason(err)) throw err;
				if (err instanceof FeedFormatError || err instanceof FeedUnavailableError) {
					// The whole dekad's file can't be read: each unit wanting it carries the failure.
					for (const w of toRead) {
						w.failed = err instanceof FeedFormatError ? 'format' : 'unavailable';
						result.failures.push({ unitKey: w.unit.unitKey, dekad, code: w.failed, error: err });
					}
					continue;
				}
				throw err;
			}
			let complete = true;
			for (const w of toRead) {
				try {
					await readUnit(w, cog, read, dekad, current);
				} catch (err) {
					if (err instanceof FileChanged) {
						result.changedMidRead++;
						complete = false;
						break;
					}
					if (stopReason(err)) throw err;
					if (err instanceof FeedFormatError || err instanceof FeedUnavailableError) {
						w.failed = err instanceof FeedFormatError ? 'format' : 'unavailable';
						result.failures.push({ unitKey: w.unit.unitKey, dekad, code: w.failed, error: err });
						complete = false;
						continue;
					}
					throw err;
				}
			}
			// The file's version is kept once every unit wanting it read it: until then its rows from the old one are stale.
			if (complete) state.files[dekad] = { ...(current ? { etag: current } : {}), checkedOn: today };
		}
	} catch (err) {
		if (err instanceof Deadline) {
			result.stopped = 'deadline';
		} else if (stopReason(err)) {
			stop = stopReason(err);
			result.stopped = stop!;
			result.error = err;
		} else {
			threw = true;
			throw err;
		}
	} finally {
		try {
			for (const w of work) {
				const key = w.unit.unitKey;
				if (w.dirty) {
					const rows = [...w.rows.values()].sort((a, b) => (a.dekad < b.dekad ? -1 : 1));
					await writeEtFile(store, {
						source: 'wapor',
						unitKey: key,
						fetchedAt: isoNow(),
						parcelsAt: wanted.generatedAt,
						version: WAPOR_VERSION,
						mask: w.mask ?? (w.unit.cropland ? 'cropland' : 'parcel'),
						rows
					});
					result.written.push(key);
					const newest = rows.at(-1)?.dekad;
					const { newest: _n, lastGood: _l, ...rest } = perKey[key] ?? {};
					perKey[key] = { ...rest, lastGood: isoNow(), ...(newest ? { newest } : {}) };
				}
				const unobservable = state.units[key]!.unobservable;
				if (unobservable) perKey[key] = { ...perKey[key], error: unobservable };
				else if (w.failed) perKey[key] = { ...perKey[key], error: w.failed };
				else if (stop && !w.read) perKey[key] = { ...perKey[key], error: stop };
				else if (w.read && perKey[key]?.error) {
					// A clean read clears the last run's error.
					const { error: _, ...rest } = perKey[key]!;
					perKey[key] = rest;
				}
			}
			const stopped = result.stopped === 'refused' || result.stopped === 'throttled';
			const retryAfterSeconds = stopped ? stopRetryAfter(result.error) : undefined;
			const status: EtPassStatus = {
				source: 'wapor',
				ranAt: isoNow(),
				stopped,
				...(stopped ? { reason: result.stopped } : {}),
				...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
				perKey
			};
			result.recencyDays = recencyDays(status, today);
			// The status last: the worker reads it to find the files written.
			await writeState(store, state);
			await writeStatus(store, status);
		} catch (err) {
			if (!threw) throw err;
		}
	}
	return result;
}
