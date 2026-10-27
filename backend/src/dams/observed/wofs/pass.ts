// The WOfS pass: Digital Earth Africa's per-scene water layer summed inside
// each of our traced dam outlines, into the mirror bucket for the worker to
// load into dam_observation (issue #604 R5-C; 249_dam_observation.sql,
// docs/architecture.md § Dam observations → WOfS). The fetcher Lambda runs it
// in its `dams-weekly` mode (lambda-fetcher.ts), outside the VPC, after the
// Waterbodies pass; the handover is R5-A's (../handover.ts):
//
//   worker tick ──put──► dams/wanted.json        every dam outline, with `since`
//   fetcher ─get─► dams/wanted.json, dams/wofs-status.json, dams/wofs-state.json
//           ─GET─► explorer.digitalearth.africa/stac/search  (per dam, per year window)
//           ─GET─► deafrica-services…/wofs_ls/…_water.tif     (header + the dam's tiles)
//           ─put─► dams/wofs/<featureId>.json  ObservationFile: rows + each scene's item id, URL, ETag
//           ─put─► dams/wofs-status.json        PassStatus: per dam lastGood / newest / error
//           ─put─► dams/wofs-state.json         ours: per dam the outline's hash and how far it's scanned
//   worker tick ──get──► the status, then each newer dams/wofs/<featureId>.json → app_dam_observation_load
//
// What a run does. The dams go in turn (never tried first, then by their
// last turn, oldest first, so one that keeps failing goes behind the rest),
// skipping a dam scanned up to within refreshDays of today. For each dam it
// searches STAC year by year from where it left off (`scannedThrough` + 1,
// or the worker's `since`, never before WOFS_BACKFILL_FROM), and takes the
// scenes a date at a time, in date order: each scene's header, then the
// tiles under the outline (cog.ts), summed inside it (sum.ts). Two scenes on
// one date (neighbouring Landsat rows overlap) give ONE row: the scene that
// saw the most of the dam clearly, then the one covering most of it, then the
// lower item id. They aren't combined pixel by pixel: the rows' grids needn't
// line up, and the better view is what a reader would pick. After each date
// `scannedThrough` moves to it; at the deadline the dam stops there and the
// next run goes on from it. So the first backfill (2013 on: about 90 scenes
// a year over a dam, 2–3 requests each) runs over several runs.
//
// A dam scanned to within LOOKBACK_DAYS of today re-scans that tail each
// time: DE Africa publishes a scene days to weeks after it is taken, and the
// two paths over a dam are processed apart, so a scene can appear behind a
// date we've passed. Its row is written again (the loader upserts).
//
// An outline that changed (its hash differs from the one in the state file)
// starts again: its file is rewritten from scratch (empty until the new scan
// writes rows), as 249's trigger deletes the old outline's rows. The file
// keeps the rows from the worker's `since` on (the ones it doesn't hold yet)
// plus the re-scanned tail; older ones are dropped.
//
// Politeness (#604 "The rule"): one User-Agent (feeds/http.ts), STAC asked
// at most once a second (STAC_INTERVAL_MS) and the bucket at most five times
// a second (SCENE_INTERVAL_MS: S3 is built for it, and a dam is two or three
// small ranges a scene), one request in flight. An HTTP 403 or throttling
// (429/503) from either host stops the run at once, never retried: the
// status says stopped and why, the recency metric grows (R5-A's
// DamObservationAgeDays{Source=wofs}, alarmed in infra/dam_observations.tf),
// and the invocation fails. A scene that can't be read (a format the reader
// refuses, a missing object) is skipped, counted and logged; a search that
// fails another way, or a timeout, ends that dam's turn and the next dam
// goes on. Anything else is a bug and throws (the status is written first).
//
// Locally (FEED_SOURCE=fixtures) the client is the synthetic one
// (wofs/fixtures.ts) and pacing is off.
import { createHash } from 'node:crypto';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { FeedFormatError, FeedRefusedError, FeedThrottledError, FeedUnavailableError } from '../../../feeds/errors.js';
import type { FeedHttp } from '../../../feeds/http.js';
import { pacedHttp } from '../../../ingest/daily.js';
import type { MirrorStore } from '../../../mirror/store.js';
import {
	readObservationFile,
	readStatus,
	readWanted,
	recencyDays,
	writeObservationFile,
	writeStatus,
	type ObservationFile,
	type PassStatus,
	type WantedOutline
} from '../handover.js';
import { openCog, readWindow, type RangeRead } from './cog.js';
import { searchScenes, type WofsScene } from './stac.js';
import { observation, outlineMask, sceneWindow, tally, type OutlineMask } from './sum.js';

/** The first-backfill window's start: the Landsat 8 era (Landsat 7 beside it). Earlier history isn't fetched. */
export const WOFS_BACKFILL_FROM = '2013-01-01';
/** A dam scanned to within this many days of today waits. The pass runs daily; scenes come every ~8 days. */
export const REFRESH_DAYS = 6;
/** The tail re-scanned each time a dam is caught up: scenes are published days to weeks late. */
export const LOOKBACK_DAYS = 45;
/** One STAC search's dates. */
export const WINDOW_DAYS = 366;
/** Minimum gap between two STAC requests' starts (the explorer is one server: 1 a second). */
export const STAC_INTERVAL_MS = 1000;
/** Minimum gap between two scene reads' starts (an S3 bucket: 5 a second). */
export const SCENE_INTERVAL_MS = 200;

export const STATE_KEY = '/dams/wofs-state.json' as AbsolutePath;

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoTime = z.string().datetime({ offset: true });
const FEATURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** dams/wofs-state.json: the pass's own bookkeeping, per dam. Never read by the worker. */
export const WofsState = z
	.object({
		v: z.literal(1),
		dams: z.record(
			z.string().regex(FEATURE_ID),
			z
				.object({
					/** SHA-256 of the outline the rows were summed in (outlineHash). */
					outline: z.string().regex(/^[0-9a-f]{64}$/),
					/** Every scene up to and including this date has been read. */
					scannedThrough: IsoDay.optional(),
					/** The dam's last turn, good or not. */
					triedAt: IsoTime.optional()
				})
				.strict()
		)
	})
	.strict();
export type WofsState = z.output<typeof WofsState>;

export async function readState(store: MirrorStore): Promise<WofsState | null> {
	const bytes = await store.get(STATE_KEY);
	if (bytes === undefined) return null;
	try {
		const r = WofsState.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
		// Our own file: if it can't be read, start the bookkeeping again (a full re-scan) rather than stop every run.
		return r.success ? r.data : null;
	} catch {
		return null;
	}
}
const writeState = (store: MirrorStore, s: WofsState) => store.set(STATE_KEY, new TextEncoder().encode(JSON.stringify(s)));

/** The outline's fingerprint: SHA-256 of its GeoJSON as the wanted list gives it. */
export const outlineHash = (o: Pick<WantedOutline, 'geometry'>) => createHash('sha256').update(JSON.stringify(o.geometry)).digest('hex');

/** The outline's lon/lat box: west, south, east, north. */
export function outlineBbox(o: Pick<WantedOutline, 'geometry'>): [number, number, number, number] {
	const polys = o.geometry.type === 'Polygon' ? [o.geometry.coordinates] : o.geometry.coordinates;
	let w = Infinity;
	let s = Infinity;
	let e = -Infinity;
	let n = -Infinity;
	for (const rings of polys) {
		for (const [lon, lat] of rings[0] ?? []) {
			w = Math.min(w, lon);
			e = Math.max(e, lon);
			s = Math.min(s, lat);
			n = Math.max(n, lat);
		}
	}
	return [w, s, e, n];
}

/** Why the run stopped. */
export type WofsStop = 'no_list' | 'done' | 'deadline' | 'refused' | 'throttled';

export interface WofsPassOptions {
	store: MirrorStore;
	http: FeedHttp;
	/** Today (UTC), ISO. */
	today: string;
	/** Epoch ms after which no new request is started. */
	deadline?: number;
	/** 0 in fixtures mode. */
	stacIntervalMs?: number;
	sceneIntervalMs?: number;
	refreshDays?: number;
	lookbackDays?: number;
	backfillFrom?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface WofsPassResult {
	/** Dams whose file was written this run, in order. */
	written: string[];
	/** Dams whose turn ended on a failure (a search, a timeout), each with why, for the log. */
	failures: { featureId: string; code: string; error: unknown }[];
	/** Scenes skipped because they couldn't be read, for the log. */
	sceneFailures: { featureId: string; itemId: string; error: unknown }[];
	/** Listed dams scanned recently enough to wait. */
	fresh: number;
	stopped: WofsStop;
	/** Requests to STAC and to the bucket. */
	stacRequests: number;
	sceneRequests: number;
	/** Scenes read (header and tiles). */
	scenesRead: number;
	/** Days from today back to the newest observation any dam's file holds (the recency metric), or null. */
	recencyDays: number | null;
	/** What stopped the run (a 403, throttling), or null. */
	error: unknown;
}

/** A 403 or throttling: the run stops. */
function stopReason(err: unknown): 'refused' | 'throttled' | null {
	if (err instanceof FeedRefusedError) return 'refused';
	if (err instanceof FeedThrottledError) return 'throttled';
	return null;
}

class Deadline extends Error {}

const addDays = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);
const maxDay = (...ds: (string | undefined)[]) => ds.filter((d): d is string => !!d).reduce((a, b) => (a > b ? a : b));

/** One scene's view of a dam, or null when it didn't see it (sum.ts observation). */
interface SceneView {
	scene: WofsScene;
	etag?: string;
	wetAreaM2: number;
	pctObserved: number;
	clearPx: number;
	coveredPx: number;
}

/** Reads one scene's header and the tiles under the outline, and sums them. */
async function viewScene(http: FeedHttp, scene: WofsScene, outline: WantedOutline, masks: Map<string, OutlineMask>): Promise<SceneView | null> {
	let etag: string | undefined;
	const read: RangeRead = async (start, end) => {
		if (http.rangeTagged) {
			const got = await http.rangeTagged(scene.url, start, end);
			if (got?.tag && !got.tag.startsWith('lm:') && etag === undefined) etag = got.tag;
			return got?.bytes ?? null;
		}
		return http.range(scene.url, start, end);
	};
	const cog = await openCog(read);
	if (!cog) throw new FeedFormatError('the scene STAC lists is not in the bucket');
	// Scenes of one path/row share a grid: the mask is made once for it.
	const gridKey = `${cog.epsg}/${cog.originX}/${cog.originY}/${cog.pixelSizeX}/${cog.pixelSizeY}`;
	let mask = masks.get(gridKey);
	if (!mask) {
		mask = outlineMask(outline.geometry, cog);
		masks.set(gridKey, mask);
	}
	if (mask.inside === 0) return null;
	const win = sceneWindow(mask, cog);
	if (!win) return null;
	const samples = await readWindow(read, cog, win);
	const o = observation(tally(mask, win, samples), mask.pixelAreaM2);
	return o && { scene, ...(etag ? { etag } : {}), ...o };
}

/** The better of two views of one date: most seen clearly, then most covered, then the lower item id. */
export function better(a: SceneView, b: SceneView): SceneView {
	if (a.clearPx !== b.clearPx) return a.clearPx > b.clearPx ? a : b;
	if (a.coveredPx !== b.coveredPx) return a.coveredPx > b.coveredPx ? a : b;
	return a.scene.itemId <= b.scene.itemId ? a : b;
}

/** One pass (see the header). Throws only for the mirror itself or a bug; the upstreams' failures are reported. */
export async function runWofsPass(opts: WofsPassOptions): Promise<WofsPassResult> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const stac = pacedHttp(opts.http, opts.stacIntervalMs ?? STAC_INTERVAL_MS, now, sleep);
	const s3 = pacedHttp(opts.http, opts.sceneIntervalMs ?? SCENE_INTERVAL_MS, now, sleep);
	const { store, today } = opts;
	const refreshDays = opts.refreshDays ?? REFRESH_DAYS;
	const lookbackDays = opts.lookbackDays ?? LOOKBACK_DAYS;
	const backfillFrom = opts.backfillFrom ?? WOFS_BACKFILL_FROM;
	const isoNow = () => new Date(now()).toISOString();
	const pastDeadline = () => opts.deadline !== undefined && now() >= opts.deadline;

	const result: WofsPassResult = {
		written: [],
		failures: [],
		sceneFailures: [],
		fresh: 0,
		stopped: 'done',
		stacRequests: 0,
		sceneRequests: 0,
		scenesRead: 0,
		recencyDays: null,
		error: null
	};
	const wanted = await readWanted(store);
	if (!wanted) return { ...result, stopped: 'no_list' };
	const previous = await readStatus(store, 'wofs');
	const prevState = await readState(store);

	// Only the listed dams are kept: a dam deleted drops out of the status and the state too.
	const perKey: PassStatus['perKey'] = {};
	const state: WofsState = { v: 1, dams: {} };
	for (const o of wanted.outlines) {
		const hash = outlineHash(o);
		const prev = prevState?.dams[o.featureId];
		state.dams[o.featureId] = prev && prev.outline === hash ? prev : { outline: hash, ...(prev?.triedAt ? { triedAt: prev.triedAt } : {}) };
		const pk = previous?.perKey[o.featureId];
		if (pk) perKey[o.featureId] = pk;
	}
	const changed = new Set(wanted.outlines.filter((o) => prevState?.dams[o.featureId] && prevState.dams[o.featureId]!.outline !== state.dams[o.featureId]!.outline).map((o) => o.featureId));

	const freshFrom = addDays(today, -refreshDays);
	const isFresh = (id: string) => (state.dams[id]!.scannedThrough ?? '') >= freshFrom && !changed.has(id);
	const turn = (id: string) => state.dams[id]!.triedAt ?? '';
	const due = wanted.outlines.filter((o) => !isFresh(o.featureId)).sort((a, b) => (turn(a.featureId) < turn(b.featureId) ? -1 : turn(a.featureId) > turn(b.featureId) ? 1 : a.featureId < b.featureId ? -1 : 1));
	result.fresh = wanted.outlines.length - due.length;

	let threw = false;
	try {
		for (const outline of due) {
			if (pastDeadline()) {
				result.stopped = 'deadline';
				break;
			}
			const id = outline.featureId;
			const st = state.dams[id]!;
			st.triedAt = isoNow();
			const since = maxDay(backfillFrom, outline.since);
			const cursor = st.scannedThrough ? maxDay(since, addDays(st.scannedThrough, 1)) : since;
			// Caught up: re-scan the tail for scenes published late.
			const tail = addDays(today, -lookbackDays);
			const scanFrom = cursor > tail ? maxDay(backfillFrom, tail) : cursor;
			const keepFrom = scanFrom < since ? scanFrom : since;

			// The rows the worker may not hold yet, by date; a changed outline's are dropped.
			let existing: ObservationFile | null = null;
			if (!changed.has(id)) {
				try {
					existing = await readObservationFile(store, 'wofs', id);
				} catch (err) {
					// Our own file unreadable: rebuilt from the scan.
					if (!(err instanceof FeedFormatError)) throw err;
				}
			}
			const rows = new Map<string, ObservationFile['rows'][number]>();
			const upstream = new Map<string, ObservationFile['upstream'][number]>();
			for (const r of existing?.rows ?? []) if (r.date >= keepFrom) rows.set(r.date, r);
			for (const u of existing?.upstream ?? []) if (u.itemId) upstream.set(u.itemId, u);
			// Written when a row is new or dropped, or the outline changed (its old file must not be loaded again).
			let dirty = changed.has(id) || rows.size !== (existing?.rows.length ?? 0);

			const masks = new Map<string, OutlineMask>();
			const bbox = outlineBbox(outline);
			let stop: 'refused' | 'throttled' | null = null;
			let failure: { code: string; error: unknown } | null = null;
			try {
				for (let from = scanFrom; from <= today; from = addDays(from, WINDOW_DAYS)) {
					if (pastDeadline()) throw new Deadline();
					const end = addDays(from, WINDOW_DAYS - 1);
					const to = end > today ? today : end;
					let scenes: WofsScene[];
					try {
						scenes = await searchScenes(stac.http, bbox, from, to);
					} catch (err) {
						if (err instanceof FeedFormatError) {
							failure = { code: 'stac_format', error: err };
							break;
						}
						throw err;
					}
					const dates = [...new Set(scenes.map((s) => s.date))];
					for (const date of dates) {
						if (pastDeadline()) throw new Deadline();
						let best: SceneView | null = null;
						for (const scene of scenes.filter((s) => s.date === date)) {
							let view: SceneView | null;
							try {
								view = await viewScene(s3.http, scene, outline, masks);
								result.scenesRead++;
							} catch (err) {
								if (err instanceof FeedFormatError) {
									result.sceneFailures.push({ featureId: id, itemId: scene.itemId, error: err });
									perKey[id] = { ...perKey[id], error: 'scene_format' };
									continue;
								}
								throw err;
							}
							if (view) best = best ? better(best, view) : view;
						}
						if (best) {
							const was = rows.get(date);
							const row = { date, wetAreaM2: best.wetAreaM2, pctObserved: best.pctObserved, upstreamKey: best.scene.itemId };
							// A re-scanned tail's unchanged row doesn't make the worker load the file again.
							if (!was || was.wetAreaM2 !== row.wetAreaM2 || was.pctObserved !== row.pctObserved || was.upstreamKey !== row.upstreamKey) dirty = true;
							rows.set(date, row);
							upstream.set(best.scene.itemId, { url: best.scene.url, itemId: best.scene.itemId, ...(best.etag ? { etag: best.etag } : {}) });
						}
						st.scannedThrough = date;
					}
					if (to > (st.scannedThrough ?? '')) st.scannedThrough = to;
				}
			} catch (err) {
				if (err instanceof Deadline) {
					result.stopped = 'deadline';
				} else if (stopReason(err)) {
					stop = stopReason(err);
					result.error = err;
				} else if (err instanceof FeedUnavailableError) {
					failure = { code: 'unavailable', error: err };
				} else {
					throw err;
				}
			}

			// What was read before a failure is kept: written, and the worker loads it.
			if (dirty) {
				const sorted = [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
				const used = new Set(sorted.map((r) => r.upstreamKey));
				await writeObservationFile(store, {
					source: 'wofs',
					key: id,
					fetchedAt: isoNow(),
					upstream: [...upstream.values()].filter((u) => used.has(u.itemId!)),
					rows: sorted
				});
				result.written.push(id);
				const newest = sorted.at(-1)?.date;
				perKey[id] = { ...perKey[id], lastGood: isoNow(), ...(newest ? { newest } : {}) };
				if (changed.has(id) && !newest) delete perKey[id]!.newest;
			}
			if (failure) {
				result.failures.push({ featureId: id, ...failure });
				perKey[id] = { ...perKey[id], error: failure.code };
			} else if (!stop && result.stopped !== 'deadline' && perKey[id]?.error && !result.sceneFailures.some((f) => f.featureId === id)) {
				// A clean turn clears the last one's error.
				const { error: _, ...rest } = perKey[id]!;
				perKey[id] = rest;
			}
			if (stop) {
				result.stopped = stop;
				perKey[id] = { ...perKey[id], error: stop };
				break;
			}
			if (result.stopped === 'deadline') break;
		}
	} catch (err) {
		threw = true;
		throw err;
	} finally {
		result.stacRequests = stac.counter.requests;
		result.sceneRequests = s3.counter.requests;
		const stopped = result.stopped === 'refused' || result.stopped === 'throttled';
		const status: PassStatus = { source: 'wofs', ranAt: isoNow(), stopped, ...(stopped ? { reason: result.stopped } : {}), perKey };
		result.recencyDays = recencyDays(status, today);
		try {
			// The status last: the worker reads it to find the files written.
			await writeState(store, state);
			await writeStatus(store, status);
		} catch (err) {
			if (!threw) throw err;
		}
	}
	return result;
}
