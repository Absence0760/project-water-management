// The WOfS pass: Digital Earth Africa's per-scene water layer summed inside
// each of our traced dam outlines, into the mirror bucket for the worker to
// load into dam_observation (issue #604 R5-C; 261_dam_observation.sql,
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
// What a run does. First every due dam's NEWEST scenes, then, with the time
// left, older history, so every dam is current before any time goes on the
// past (and the recency alarm doesn't fire through a first backfill). The
// dams go in turn (never tried first, then by their last turn, oldest first,
// so one that keeps failing goes behind the rest). The fetcher runs the pass
// every hour (infra/dam_observations.tf), but a dam's newest scenes are
// checked at most once a UTC day (REFRESH_DAYS, the state's checkedOn): a
// forward turn that ended, well or on a failure, waits until the next day,
// and only one the deadline cut short goes on in the next run. Every other
// run's time goes to the backward backfill, so a dam's history from 2013
// fills in days, not weeks. Per dam, `dams/wofs-state.json` keeps the span
// read so far, [backfilledFrom, scannedThrough]:
//
//   forward   from scannedThrough + 1 (or the worker's `since`) to today; a
//             dam's first turn starts LOOKBACK_DAYS back (the newest weeks),
//             and sets backfilledFrom there
//   backward  from backfilledFrom − 1 down to WOFS_BACKFILL_FROM (2013, the
//             Landsat 8 era), a year a search, newest date first
//
// Each STAC search is a year (WINDOW_DAYS) over the outline's box; its scenes
// are taken a date at a time: each scene's header, then the tiles under the
// outline (raster/cog.ts), summed inside it (raster/mask.ts, sum.ts). Two scenes on one date
// (neighbouring Landsat rows overlap) give ONE row: the scene that saw the
// most of the dam clearly, then the one covering most of it, then the lower
// item id. They aren't combined pixel by pixel: the rows' grids needn't line
// up, and the better view is what a reader would pick. After each date the
// cursor moves to it, so at the deadline a dam stops there and the next run
// goes on from it: a first backfill (about 90 scenes a year over a dam, 2–3
// requests each) runs over several runs.
//
// A dam scanned to within LOOKBACK_DAYS of today re-searches that tail each
// time: DE Africa publishes a scene days to weeks after it is taken, and the
// two paths over a dam are processed apart, so a scene can appear behind a
// date we've passed. Only scenes not read before are read: a STAC item id is
// one processing of one scene and never changes, so a scene whose id is in
// the file's upstream items, or in the state's tailItems (every scene the
// tail's turns read, kept for LOOKBACK_DAYS, including those that lost to an
// overlapping scene or didn't see the dam), keeps its stored row and costs no
// request. A late-published scene (a new id) is read; on a date that already
// has a row, that date's other scenes are read again with it, so the better
// view still wins (`better`). A row is written again only if it changed (the
// loader upserts).
//
// An outline that changed (its hash differs from the one in the state file)
// starts again: its file is rewritten from scratch (empty until the new scan
// writes rows), as 249's trigger deletes the old outline's rows. Otherwise
// the file keeps every row read, never cut back: the newest rows reach the
// worker first, so its `since` says nothing of the history still to load,
// and a row dropped before the worker loaded it would be lost. It is about
// 90 rows a year from 2013 (MAX_ROWS allows 20 000), and the worker
// reloads it only when a run changed it.
//
// Politeness (#604 "The rule"): one User-Agent (feeds/http.ts), STAC asked
// at most once a second (STAC_INTERVAL_MS) and the bucket at most five times
// a second (SCENE_INTERVAL_MS: S3 is built for it, and a dam is two or three
// small ranges a scene), one request in flight. An HTTP 403 or throttling
// (429/503) from either host stops the run at once, never retried: the
// status says stopped and why, the recency metric grows (R5-A's
// DamObservationAgeDays{Source=wofs}, alarmed in infra/dam_observations.tf),
// and the invocation fails. The source is then left alone for a day (or a
// longer Retry-After): the next runs ask nothing, write nothing and publish
// no heartbeat, so the heartbeat alarm is the alert (handover.ts
// pausedUntil). A scene that can't be read (a format the reader
// refuses, a missing object) is skipped, counted and logged; a search that
// fails another way, or a timeout, ends that dam's turn and the next dam
// goes on. Anything else is a bug and throws (the status is written first).
//
// Locally (FEED_SOURCE=fixtures) the client is the synthetic one
// (wofs/fixtures.ts) and pacing is off.
//
// The same pass runs Sentinel-2 (issue #624 step 4, ../sentinel/pass.ts):
// runScenePass takes the source's own collection search, scene reader, state
// file and backfill start (a ScenePassSource), and everything above holds
// for it as written, with `dams/s2-…` for `dams/wofs-…`.
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
	pausedUntil,
	stopRetryAfter,
	type ObservationFile,
	type ObservationSource,
	type PassStatus,
	type WantedOutline
} from '../handover.js';
import { openCog, readWindow, type RangeRead } from '../../../raster/cog.js';
import { outlineMask, sceneWindow, type OutlineMask } from '../../../raster/mask.js';
import { searchScenes, type SceneItem, type WofsScene } from './stac.js';
import { observation, tally, WOFS_ACCEPT } from './sum.js';

/** The first-backfill window's start: the Landsat 8 era (Landsat 7 beside it). Earlier history isn't fetched. */
export const WOFS_BACKFILL_FROM = '2013-01-01';
/**
 * Days between two checks of a dam's newest scenes (the forward turn): once a
 * UTC day. The pass runs hourly for the backfill's sake; scenes come every
 * ~8 days and are published days late, so checking more often asks STAC for
 * nothing new.
 */
export const REFRESH_DAYS = 1;
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

/** dams/wofs-state.json (dams/s2-state.json for Sentinel-2): the pass's own bookkeeping, per dam. Never read by the worker. */
export const WofsState = z
	.object({
		v: z.literal(1),
		dams: z.record(
			z.string().regex(FEATURE_ID),
			z
				.object({
					/** SHA-256 of the outline the rows were summed in (outlineHash). */
					outline: z.string().regex(/^[0-9a-f]{64}$/),
					/** Every scene from backfilledFrom up to and including this date has been read. */
					scannedThrough: IsoDay.optional(),
					/** The oldest date read back to: the history before it is still to come (until WOFS_BACKFILL_FROM). */
					backfilledFrom: IsoDay.optional(),
					/** The dam's last turn, good or not. */
					triedAt: IsoTime.optional(),
					/** The UTC day its newest scenes were last checked: a forward turn that ended (well or on a failure), not one the deadline cut. */
					checkedOn: IsoDay.optional(),
					/** The scenes the tail's turns read, [date, STAC item id], kept for LOOKBACK_DAYS: not read again (see the header). */
					tailItems: z
						.array(z.tuple([IsoDay, z.string().min(1).max(200)]))
						.max(5000)
						.optional()
				})
				.strict()
		)
	})
	.strict();
export type WofsState = z.output<typeof WofsState>;

export async function readState(store: MirrorStore, key: AbsolutePath = STATE_KEY): Promise<WofsState | null> {
	const bytes = await store.get(key);
	if (bytes === undefined) return null;
	try {
		const r = WofsState.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
		// Our own file: if it can't be read, start the bookkeeping again (a full re-scan) rather than stop every run.
		return r.success ? r.data : null;
	} catch {
		return null;
	}
}
const writeState = (store: MirrorStore, key: AbsolutePath, s: WofsState) => store.set(key, new TextEncoder().encode(JSON.stringify(s)));

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
export type WofsStop = 'no_list' | 'done' | 'deadline' | 'refused' | 'throttled' | 'paused';

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
	/** Days between two checks of a dam's newest scenes (REFRESH_DAYS). */
	refreshDays?: number;
	lookbackDays?: number;
	backfillFrom?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/**
	 * The STAC pacer to use instead of a new one (stacIntervalMs then unused): the fetcher hands the WOfS pass's to the
	 * Sentinel-2 pass after it, so the explorer sees one request a second across both. Its count is read as a delta.
	 */
	stac?: ReturnType<typeof pacedHttp>;
}

export interface WofsPassResult {
	/** Dams whose file was written this run, in order. */
	written: string[];
	/** Dams whose turn ended on a failure (a search, a timeout), each with why, for the log. */
	failures: { featureId: string; code: string; error: unknown }[];
	/** Scenes skipped because they couldn't be read, for the log. */
	sceneFailures: { featureId: string; itemId: string; error: unknown }[];
	/** Listed dams whose newest scenes were checked within the refresh days, so had no forward turn. */
	fresh: number;
	/** Dams whose turn started this run. */
	turns: number;
	stopped: WofsStop;
	/** While paused (the last run stopped refused or throttled), when the pause ends (ISO). */
	pausedUntil?: string;
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
export interface SceneView<S extends SceneItem = WofsScene> {
	scene: S;
	etag?: string;
	wetAreaM2: number;
	pctObserved: number;
	clearPx: number;
	coveredPx: number;
}

/** A range reader for one URL that keeps the object's first ETag (not a Last-Modified stand-in) in `tag.etag`. */
export function taggedReader(http: FeedHttp, url: string): { read: RangeRead; tag: { etag?: string } } {
	const tag: { etag?: string } = {};
	const read: RangeRead = async (start, end) => {
		if (http.rangeTagged) {
			const got = await http.rangeTagged(url, start, end);
			if (got?.tag && !got.tag.startsWith('lm:') && tag.etag === undefined) tag.etag = got.tag;
			return got?.bytes ?? null;
		}
		return http.range(url, start, end);
	};
	return { read, tag };
}

/** The outline's mask on a scene's grid, made once per grid (scenes of one path/row, or one MGRS tile, share it). */
export function maskFor(masks: Map<string, OutlineMask>, outline: WantedOutline, grid: Parameters<typeof outlineMask>[1]): OutlineMask {
	const gridKey = `${grid.epsg}/${grid.originX}/${grid.originY}/${grid.pixelSizeX}/${grid.pixelSizeY}`;
	let mask = masks.get(gridKey);
	if (!mask) {
		mask = outlineMask(outline.geometry, grid);
		masks.set(gridKey, mask);
	}
	return mask;
}

/** Reads one scene's header and the tiles under the outline, and sums them. */
async function viewScene(http: FeedHttp, scene: WofsScene, outline: WantedOutline, masks: Map<string, OutlineMask>): Promise<SceneView | null> {
	const { read, tag } = taggedReader(http, scene.url);
	const cog = await openCog(read, WOFS_ACCEPT);
	if (!cog) throw new FeedFormatError('the scene STAC lists is not in the bucket');
	const mask = maskFor(masks, outline, cog);
	if (mask.inside === 0) return null;
	const win = sceneWindow(mask, cog);
	if (!win) return null;
	const samples = await readWindow(read, cog, win);
	const o = observation(tally(mask, win, samples), mask.pixelAreaM2);
	return o && { scene, ...(tag.etag ? { etag: tag.etag } : {}), ...o };
}

/** The better of two views of one date: most seen clearly, then most covered, then the lower item id. */
export function better<S extends SceneItem>(a: SceneView<S>, b: SceneView<S>): SceneView<S> {
	if (a.clearPx !== b.clearPx) return a.clearPx > b.clearPx ? a : b;
	if (a.coveredPx !== b.coveredPx) return a.coveredPx > b.coveredPx ? a : b;
	return a.scene.itemId <= b.scene.itemId ? a : b;
}

/** A dam's turn: the newest scenes (forward, to today) or older history (backward, toward backfillFrom). */
type Direction = 'forward' | 'backward';

/** What a per-scene source brings to the pass (see the header): WOfS's is WOFS_PASS, Sentinel-2's is in ../sentinel/pass.ts. */
export interface ScenePassSource<S extends SceneItem> {
	source: Exclude<ObservationSource, 'waterbodies'>;
	/** The pass's own state file (STATE_KEY for WOfS). */
	stateKey: AbsolutePath;
	/** The default backfill start (opts.backfillFrom overrides it). */
	backfillFrom: string;
	/** The default pause between two bucket reads' starts (opts.sceneIntervalMs overrides it). */
	sceneIntervalMs: number;
	/** The first date the worker says the pass needs for a dam (the day after the newest row it holds). */
	since(o: WantedOutline): string;
	/** The scenes over a box, [from, to] inclusive (stac.ts searchItems with the collection's item parser). */
	search(http: FeedHttp, bbox: readonly [number, number, number, number], from: string, to: string): Promise<S[]>;
	/** One scene's view of the dam, or null when it didn't see it; FeedFormatError for a scene that can't be read (skipped). */
	view(http: FeedHttp, scene: S, outline: WantedOutline, masks: Map<string, OutlineMask>): Promise<SceneView<S> | null>;
}

/** WOfS's source: wofs_ls through searchScenes, one water layer a scene (viewScene), from 2013. */
export const WOFS_PASS: ScenePassSource<WofsScene> = {
	source: 'wofs',
	stateKey: STATE_KEY,
	backfillFrom: WOFS_BACKFILL_FROM,
	sceneIntervalMs: SCENE_INTERVAL_MS,
	since: (o) => o.since,
	search: searchScenes,
	view: viewScene
};

/** One WOfS pass (see the header). Throws only for the mirror itself or a bug; the upstreams' failures are reported. */
export const runWofsPass = (opts: WofsPassOptions): Promise<WofsPassResult> => runScenePass(WOFS_PASS, opts);

/** One pass of a per-scene source (see the header). Throws only for the mirror itself or a bug; the upstreams' failures are reported. */
export async function runScenePass<S extends SceneItem>(src: ScenePassSource<S>, opts: WofsPassOptions): Promise<WofsPassResult> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const stac = opts.stac ?? pacedHttp(opts.http, opts.stacIntervalMs ?? STAC_INTERVAL_MS, now, sleep);
	const stacBefore = stac.counter.requests;
	const s3 = pacedHttp(opts.http, opts.sceneIntervalMs ?? src.sceneIntervalMs, now, sleep);
	const { store, today } = opts;
	const source = src.source;
	const refreshDays = opts.refreshDays ?? REFRESH_DAYS;
	const lookbackDays = opts.lookbackDays ?? LOOKBACK_DAYS;
	const backfillFrom = opts.backfillFrom ?? src.backfillFrom;
	const isoNow = () => new Date(now()).toISOString();
	const pastDeadline = () => opts.deadline !== undefined && now() >= opts.deadline;

	const result: WofsPassResult = {
		written: [],
		failures: [],
		sceneFailures: [],
		fresh: 0,
		turns: 0,
		stopped: 'done',
		stacRequests: 0,
		sceneRequests: 0,
		scenesRead: 0,
		recencyDays: null,
		error: null
	};
	const previous = await readStatus(store, source);
	// Paused after a refusal or throttling: ask nothing, write nothing (the status, and so the pause, stand).
	const until = pausedUntil(previous);
	if (until !== null && now() < until) return { ...result, stopped: 'paused', pausedUntil: new Date(until).toISOString(), recencyDays: recencyDays(previous!, today) };
	const wanted = await readWanted(store);
	if (!wanted) return { ...result, stopped: 'no_list' };
	const prevState = await readState(store, src.stateKey);

	// Only the listed dams are kept: a dam deleted drops out of the status and the state too.
	const perKey: PassStatus['perKey'] = {};
	const state: WofsState = { v: 1, dams: {} };
	const changed = new Set<string>();
	for (const o of wanted.outlines) {
		const hash = outlineHash(o);
		const prev = prevState?.dams[o.featureId];
		if (prev && prev.outline !== hash) changed.add(o.featureId);
		state.dams[o.featureId] = prev && prev.outline === hash ? prev : { outline: hash, ...(prev?.triedAt ? { triedAt: prev.triedAt } : {}) };
		const pk = previous?.perKey[o.featureId];
		if (pk) perKey[o.featureId] = pk;
	}

	const turn = (id: string) => state.dams[id]!.triedAt ?? '';
	const byTurn = (a: WantedOutline, b: WantedOutline) => (turn(a.featureId) < turn(b.featureId) ? -1 : turn(a.featureId) > turn(b.featureId) ? 1 : a.featureId < b.featureId ? -1 : 1);
	// Checked on a day after this one: no forward turn yet (refreshDays 1 = once a UTC day).
	const freshAfter = addDays(today, -refreshDays);
	const isFresh = (id: string) => (state.dams[id]!.checkedOn ?? '') > freshAfter && !changed.has(id);
	const due = wanted.outlines.filter((o) => !isFresh(o.featureId)).sort(byTurn);
	result.fresh = wanted.outlines.length - due.length;
	const touched = new Set<string>();
	const sceneFailed = new Set<string>();
	let stop: 'refused' | 'throttled' | null = null;

	/** One dam's turn in one direction; false when the run must stop (the deadline, a 403, throttling). */
	const takeTurn = async (outline: WantedOutline, direction: Direction): Promise<boolean> => {
		const id = outline.featureId;
		const st = state.dams[id]!;
		touched.add(id);
		if (direction === 'forward') st.triedAt = isoNow();
		const since = maxDay(backfillFrom, src.since(outline));

		// The rows the worker may not hold yet, by date; a changed outline's are dropped.
		let existing: ObservationFile | null = null;
		if (!changed.has(id)) {
			try {
				existing = await readObservationFile(store, source, id);
			} catch (err) {
				// Our own file unreadable: rebuilt from the scan.
				if (!(err instanceof FeedFormatError)) throw err;
			}
		}
		const rows = new Map<string, ObservationFile['rows'][number]>();
		const upstream = new Map<string, ObservationFile['upstream'][number]>();
		for (const r of existing?.rows ?? []) rows.set(r.date, r);
		for (const u of existing?.upstream ?? []) if (u.itemId) upstream.set(u.itemId, u);
		// The scenes already read (see the header): the file's, and the tail's that left no row.
		const tail = addDays(today, -lookbackDays);
		const tailItems = new Map<string, string>((st.tailItems ?? []).filter(([d]) => d >= tail).map(([d, item]) => [item, d]));
		const known = (itemId: string) => upstream.has(itemId) || tailItems.has(itemId);
		// Written when a row is new, changed or dropped, or the outline changed (its old file must not be loaded again).
		const reset = changed.has(id);
		let dirty = reset;
		changed.delete(id);

		const masks = new Map<string, OutlineMask>();
		const bbox = outlineBbox(outline);
		let failure: { code: string; error: unknown } | null = null;
		let deadline = false;

		/** Reads one date's scenes and keeps the best view as its row. */
		const readDate = async (date: string, scenes: S[]) => {
			// Nothing new on this date: its stored row stands, and no scene is asked for.
			if (scenes.every((sc) => known(sc.itemId))) return;
			// A new scene beside a stored row: the date's scenes are compared again, so the better view wins.
			const toRead = rows.has(date) ? scenes : scenes.filter((sc) => !known(sc.itemId));
			let best: SceneView<S> | null = null;
			for (const scene of toRead) {
				let view: SceneView<S> | null;
				try {
					view = await src.view(s3.http, scene, outline, masks);
					result.scenesRead++;
					if (date >= tail) tailItems.set(scene.itemId, date);
				} catch (err) {
					if (err instanceof FeedFormatError) {
						result.sceneFailures.push({ featureId: id, itemId: scene.itemId, error: err });
						sceneFailed.add(id);
						continue;
					}
					throw err;
				}
				if (view) best = best ? better(best, view) : view;
			}
			if (!best) return;
			const was = rows.get(date);
			const row = { date, wetAreaM2: best.wetAreaM2, pctObserved: best.pctObserved, upstreamKey: best.scene.itemId };
			// A re-scanned tail's unchanged row doesn't make the worker load the file again.
			if (!was || was.wetAreaM2 !== row.wetAreaM2 || was.pctObserved !== row.pctObserved || was.upstreamKey !== row.upstreamKey) dirty = true;
			rows.set(date, row);
			upstream.set(best.scene.itemId, { url: best.scene.url, itemId: best.scene.itemId, ...(best.etag ? { etag: best.etag } : {}) });
		};
		/** The scenes of [from, to], by date. */
		const search = async (from: string, to: string) => {
			const scenes = await src.search(stac.http, bbox, from, to);
			const byDate = new Map<string, S[]>();
			for (const s of scenes) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
			return byDate;
		};

		try {
			if (direction === 'forward') {
				// First time: the newest weeks (the re-scanned tail's span), so the dam is current at once; the rest is backfilled backward.
				if (!st.scannedThrough) st.backfilledFrom = maxDay(since, addDays(today, -lookbackDays));
				const cursor = st.scannedThrough ? maxDay(since, addDays(st.scannedThrough, 1)) : st.backfilledFrom!;
				// Caught up: re-search the tail for scenes published late.
				const scanFrom = cursor > tail ? maxDay(backfillFrom, tail, st.backfilledFrom) : cursor;
				for (let from = scanFrom; from <= today; from = addDays(from, WINDOW_DAYS)) {
					if (pastDeadline()) throw new Deadline();
					const end = addDays(from, WINDOW_DAYS - 1);
					const to = end > today ? today : end;
					const byDate = await search(from, to);
					for (const date of [...byDate.keys()].sort()) {
						if (pastDeadline()) throw new Deadline();
						await readDate(date, byDate.get(date)!);
						if (date > (st.scannedThrough ?? '')) st.scannedThrough = date;
					}
					if (to > (st.scannedThrough ?? '')) st.scannedThrough = to;
				}
			} else {
				while (st.backfilledFrom && st.backfilledFrom > backfillFrom) {
					if (pastDeadline()) throw new Deadline();
					const to = addDays(st.backfilledFrom, -1);
					const from = maxDay(backfillFrom, addDays(st.backfilledFrom, -WINDOW_DAYS));
					const byDate = await search(from, to);
					// Newest first, so the cursor can follow each date down.
					for (const date of [...byDate.keys()].sort().reverse()) {
						if (pastDeadline()) throw new Deadline();
						await readDate(date, byDate.get(date)!);
						st.backfilledFrom = date;
					}
					st.backfilledFrom = from;
				}
			}
		} catch (err) {
			if (err instanceof Deadline) {
				deadline = true;
			} else if (stopReason(err)) {
				stop = stopReason(err);
				result.error = err;
			} else if (err instanceof FeedFormatError || err instanceof FeedUnavailableError) {
				// A search that couldn't be read, or a timeout: this dam's turn ends, the next goes on.
				failure = { code: err instanceof FeedFormatError ? 'stac_format' : 'unavailable', error: err };
			} else {
				throw err;
			}
		}

		if (tailItems.size) st.tailItems = [...tailItems].map(([item, d]): [string, string] => [d, item]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
		else delete st.tailItems;
		// What was read before a failure is kept: written, and the worker loads it.
		if (dirty) {
			const sorted = [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
			const used = new Set(sorted.map((r) => r.upstreamKey));
			await writeObservationFile(store, {
				source,
				key: id,
				fetchedAt: isoNow(),
				upstream: [...upstream.values()].filter((u) => used.has(u.itemId!)),
				rows: sorted
			});
			if (!result.written.includes(id)) result.written.push(id);
			// The newest date held: the file's (or the one before, which a file never holds less than); none after a reset.
			const { newest: before, ...rest } = perKey[id] ?? {};
			const newest = [reset ? undefined : before, sorted.at(-1)?.date].filter((d): d is string => !!d).sort().at(-1);
			perKey[id] = { ...rest, lastGood: isoNow(), ...(newest ? { newest } : {}) };
		}
		if (failure) {
			result.failures.push({ featureId: id, ...failure });
			perKey[id] = { ...perKey[id], error: failure.code };
		} else if (stop) {
			perKey[id] = { ...perKey[id], error: stop };
		} else if (sceneFailed.has(id)) {
			perKey[id] = { ...perKey[id], error: 'scene_format' };
		} else if (!deadline && perKey[id]?.error) {
			// A clean turn clears the last one's error.
			const { error: _, ...rest } = perKey[id]!;
			perKey[id] = rest;
		}
		// The newest scenes count as checked today unless the deadline cut the turn (the next run goes on from it);
		// a failure (a 403 too) waits for tomorrow rather than asking again within the hour.
		if (direction === 'forward' && !deadline) st.checkedOn = today;
		if (deadline) result.stopped = 'deadline';
		if (stop) result.stopped = stop;
		return !deadline && !stop;
	};

	let threw = false;
	try {
		// First every due dam's newest scenes, so each is current; then, with the time left, older history.
		let going = true;
		for (const outline of due) {
			if (pastDeadline()) {
				result.stopped = 'deadline';
				going = false;
				break;
			}
			if (!(await takeTurn(outline, 'forward'))) {
				going = false;
				break;
			}
		}
		if (going) {
			const behind = wanted.outlines.filter((o) => {
				const st = state.dams[o.featureId]!;
				return st.scannedThrough !== undefined && st.backfilledFrom !== undefined && st.backfilledFrom > backfillFrom;
			});
			for (const outline of behind.sort(byTurn)) {
				if (pastDeadline()) {
					result.stopped = 'deadline';
					break;
				}
				if (!(await takeTurn(outline, 'backward'))) break;
			}
		}
	} catch (err) {
		threw = true;
		throw err;
	} finally {
		result.turns = touched.size;
		result.stacRequests = stac.counter.requests - stacBefore;
		result.sceneRequests = s3.counter.requests;
		const stopped = result.stopped === 'refused' || result.stopped === 'throttled';
		const retryAfterSeconds = stopped ? stopRetryAfter(result.error) : undefined;
		const status: PassStatus = {
			source,
			ranAt: isoNow(),
			stopped,
			...(stopped ? { reason: result.stopped } : {}),
			...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
			perKey
		};
		result.recencyDays = recencyDays(status, today);
		try {
			// The status last: the worker reads it to find the files written.
			await writeState(store, src.stateKey, state);
			await writeStatus(store, status);
		} catch (err) {
			if (!threw) throw err;
		}
	}
	return result;
}
