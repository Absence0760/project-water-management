// The daily ingest: CHIRPS v3 preliminary `sat` days into the rain data copy
// (issue #604 R2-B, D7; docs/deployment.md § The data mirror). The fetcher
// Lambda runs it once a day on an EventBridge schedule (lambda-fetcher.ts,
// `{"mode":"daily-ingest"}`), outside the VPC, beside its per-feed mode.
//
// What a run does:
//   1. Reads the `prelim` manifest (what the copy holds) and the `sat` one
//      (how far the finals reach).
//   2. Drops the preliminary days the finals now hold: out of the manifest,
//      and their chunks deleted where the store has a `delete` (a local
//      directory does; mirror/store.ts S3Store doesn't yet, so in the bucket
//      the chunks stay until it does). Readers prefer a final anyway
//      (mirror/readCells.ts reads a day as `p` only past the finals), so a
//      day not yet dropped is never read in place of its final.
//   3. Copies each new day, oldest first, from the day after the finals end
//      (never a day the finals hold): for each, CHC's preliminary GeoTIFF is
//      opened (the header and the image directory with its strip table, 2
//      range requests), and the region's rows are read across the whole
//      width (sources/tiff.ts readRows: about 2 more, the strips being back
//      to back). Every request waits for the one before by REQUEST_INTERVAL_MS,
//      so CHC sees at most one a second, and a day with nothing new costs one
//      request (the 404 of the next day's header). The first day not
//      published ends the run: CHC publishes a pentad's days together.
//   4. Each day is checked (0–2000 mm, as every other read), hashed
//      (manifestHash, D8: the region's float32 values in (lat, lon) order,
//      row 0 the southernmost), written into the `prelim` daily array (D2),
//      and recorded in the manifest, which is saved after every day, so a run
//      cut short keeps what it copied.
//
// `prelimThrough` follows the rule `finalThrough` got (manifest.ts
// finalsCoverage): the end of the contiguous run of copied days from the
// first day the copy is meant to hold (the day after the finals end, or the
// array's first day if later). It never jumps a day that is missing, so a
// reader never takes a missing day as "no data".
//
// Throttling (HTTP 429/503) is waited out and the same request asked again
// (pacedHttp's `retry`, CHC's advice of 2026-11-10, as ingest/polite.py does):
// the Retry-After CHC gave, else THROTTLE_DEFAULT_SECONDS doubling (60, 120,
// 240 s), at most THROTTLE_MAX_RETRIES times, and only while the deadline
// leaves room for the wait and the request (THROTTLE_RETRY_REQUEST_MS). The
// default wait is never shorter than the pause the live client (feeds/http.ts
// THROTTLED) puts on the host, so a retry is a real request, not the pause's
// instant refusal. Each 429/503 is logged (`mirror_ingest_throttled`: the
// attempt, the Retry-After, the wait, whether it retries). Every retry goes
// through the pacing and counts as a request. A throttling that outlasts the
// retries or the deadline ends the run; a refusal (HTTP 403) ends it at once,
// never retried (the live client pauses the host for an hour as well); so does
// any other failure. What was copied before it is kept. The run reports the
// error rather than throwing it, so the caller can still publish the lag
// metric and log the outcome before it fails the invocation.
//
// The revision (D8) moves only on a real change of values: a preliminary
// file is published once, so a new day is an addition, not a revision.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { AbsolutePath } from '@zarrita/storage';
import { FeedFormatError, FeedThrottledError, FeedUnavailableError } from '../feeds/errors.js';
import { type FeedHttp, THROTTLE_DEFAULT_SECONDS, THROTTLE_MAX_SECONDS } from '../feeds/http.js';
import { chirpsPrelimUrl } from '../feeds/sources/chirps.js';
import { type GridInfo, openGrid, readRows } from '../feeds/sources/tiff.js';
import { logEvent } from '../logging/logEvent.js';
import { DAILY_CHUNK, ensureDaily, MirrorFormatError, openDaily, writeDailyDays } from '../mirror/arrays.js';
import { dayIndex, gridOf, MIRROR_REGION, MIRROR_STEP, type Region, regionSize } from '../mirror/grid.js';
import { type Manifest, manifestHash, readManifest, writeManifest } from '../mirror/manifest.js';
import type { MirrorStore } from '../mirror/store.js';

/** At most one request to CHC a second (issue #604, "a polite client"). */
export const REQUEST_INTERVAL_MS = 1000;
/** Days copied per run at most: ~4 requests each at 1 a second fit the fetcher's 120 s with room to save. */
export const DAILY_MAX_FILES = 20;
/** With no finals and no copy yet (a fresh local copy), the first day tried is this many days before today. */
export const PRELIM_LOOKBACK_DAYS = 30;
/** The CloudWatch namespace and metric the freshness alarms read (infra/ingest.tf). */
export const MIRROR_METRIC_NAMESPACE = 'water-management/Mirror';
export const MIRROR_LAG_METRIC = 'MirrorLagDays';

const PRELIM_URL_DAY = /\/chirps-v3\.0\.prelim\.(\d{4})\.(\d{2})\.(\d{2})\.tif$/;

/** The day a preliminary file's URL names, or null. */
export function prelimDayOf(url: string): string | null {
	const m = PRELIM_URL_DAY.exec(url);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export interface DailyIngestOptions {
	store: MirrorStore;
	http: FeedHttp;
	/** Today (UTC), ISO. */
	today: string;
	/** Epoch ms after which no new day is started (the Lambda's time left, less the time to save). */
	deadline?: number;
	maxFiles?: number;
	lookbackDays?: number;
	/** Minimum gap between two requests' starts; 0 in fixtures mode. */
	intervalMs?: number;
	/** The clock and the wait (tests swap both). */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	region?: Region;
	/** Each 429/503 met (tests capture it); by default logged as `mirror_ingest_throttled`. */
	onThrottled?: (t: ThrottledAttempt) => void;
}

export interface DailyIngestResult {
	/** Days copied this run, in order. */
	copied: string[];
	/** Preliminary days dropped this run because the finals now hold them. */
	dropped: string[];
	prelimThrough: string | null;
	/** The sat finals' end the run read (null without a sat manifest). */
	finalThrough: string | null;
	/** Today minus the newest sat day the copy holds (final or preliminary), or null when it holds none. */
	lagDays: number | null;
	/** Why the run stopped: nothing more published, the per-run cap, the deadline, or an error. */
	stopped: 'not_published' | 'up_to_date' | 'max_files' | 'deadline' | 'error';
	/** Requests sent to the source. */
	requests: number;
	/** The failure that stopped the run (a 403 included), or null. */
	error: unknown;
}

/** Retries of one request after a 429/503 (CHC's advice of 2026-11-10; ingest/polite.py keeps the same 3). */
export const THROTTLE_MAX_RETRIES = 3;
/** Room the deadline must leave after a retry's wait, for the request itself: the live client's per-request timeout (feeds/http.ts). */
export const THROTTLE_RETRY_REQUEST_MS = 20_000;

/** One 429/503 a paced request met, and what pacedHttp does about it. */
export interface ThrottledAttempt {
	url: string;
	status: 429 | 503;
	/** This request's attempt that met it (1 = the first ask), of `of` at most. */
	attempt: number;
	of: number;
	/** The source's Retry-After in seconds, or null when it gave none. */
	retryAfterSeconds: number | null;
	/** The wait before the retry, in seconds. */
	waitSeconds: number;
	/** False when the run stops on it: retries used up, a wait past THROTTLE_MAX_SECONDS, or no room before the deadline. */
	retrying: boolean;
}

/** How a paced client waits out a 429/503 (see daily.ts's header). Without one, a 429/503 is thrown at once. */
export interface ThrottleRetry {
	/** Epoch ms: a retry only when its wait plus THROTTLE_RETRY_REQUEST_MS ends by then. */
	deadline?: number;
	maxRetries?: number;
	onThrottled?: (t: ThrottledAttempt) => void;
}

/**
 * The wait before retry `n` (1-based) after a 429/503: the source's
 * Retry-After, else THROTTLE_DEFAULT_SECONDS doubling. The default first wait
 * is exactly the pause feeds/http.ts puts on the host without a Retry-After
 * (with one, the pause is min(Retry-After, THROTTLE_MAX_SECONDS) and the wait
 * the Retry-After), so the retry never meets that pause's instant refusal.
 */
export function throttleWaitSeconds(err: FeedThrottledError, n: number): number {
	return err.retryAfterSeconds ?? THROTTLE_DEFAULT_SECONDS * 2 ** (n - 1);
}

/** The default `onThrottled`: one warn line a 429/503, so CloudWatch shows what the source asked. */
export const logThrottled = (product: string) => (t: ThrottledAttempt) =>
	logEvent('warn', {
		event: 'mirror_ingest_throttled',
		product,
		url: t.url,
		status: t.status,
		attempt: t.attempt,
		of: t.of,
		retryAfter: t.retryAfterSeconds ?? 'absent',
		waitSeconds: t.waitSeconds,
		retrying: t.retrying
	});

/**
 * `http`, each request waiting until `intervalMs` after the previous one
 * started; counts them. With `retry`, a request that meets a 429/503 is asked
 * again after the wait (throttleWaitSeconds), each retry paced and counted
 * like any request; a 403 or any other failure is thrown at once.
 */
export function pacedHttp(http: FeedHttp, intervalMs: number, now: () => number, sleep: (ms: number) => Promise<void>, retry?: ThrottleRetry) {
	let last = -Infinity;
	const counter = { requests: 0 };
	const wait = async () => {
		const left = last + intervalMs - now();
		if (left > 0) await sleep(left);
		last = now();
		counter.requests++;
	};
	const ask = async <T>(url: string, call: () => Promise<T>): Promise<T> => {
		const max = retry?.maxRetries ?? THROTTLE_MAX_RETRIES;
		for (let attempt = 1; ; attempt++) {
			await wait();
			try {
				return await call();
			} catch (err) {
				if (!retry || !(err instanceof FeedThrottledError)) throw err;
				const waitSeconds = throttleWaitSeconds(err, attempt);
				const retrying =
					attempt <= max &&
					waitSeconds <= THROTTLE_MAX_SECONDS &&
					(retry.deadline === undefined || now() + waitSeconds * 1000 + THROTTLE_RETRY_REQUEST_MS <= retry.deadline);
				retry.onThrottled?.({ url, status: err.status, attempt, of: max + 1, retryAfterSeconds: err.retryAfterSeconds, waitSeconds, retrying });
				if (!retrying) throw err;
				await sleep(waitSeconds * 1000);
			}
		}
	};
	const paced: FeedHttp = {
		range: (url, start, end) => ask(url, () => http.range(url, start, end)),
		text: (url) => ask(url, () => http.text(url)),
		...(http.rangeTagged ? { rangeTagged: (url: string, start: number, end: number) => ask(url, () => http.rangeTagged!(url, start, end)) } : {})
	};
	return { http: paced, counter };
}

/**
 * Where the region sits in a grid file, in whole cells: the file row of the
 * region's northernmost row and the file column of its westernmost. Refuses
 * a file not on CHC's 0.05° grid, or not aligned with it.
 */
export function regionPlacement(grid: Pick<GridInfo, 'originLat' | 'originLon' | 'scaleLat' | 'scaleLon'>, region: Region = MIRROR_REGION) {
	if (grid.scaleLat !== MIRROR_STEP || grid.scaleLon !== MIRROR_STEP) throw new FeedFormatError(`the grid is not on the ${MIRROR_STEP}° CHIRPS grid`);
	const north = (grid.originLat - region.n) / MIRROR_STEP;
	const west = (region.w - grid.originLon) / MIRROR_STEP;
	const r = Math.round(north);
	const c = Math.round(west);
	if (Math.abs(north - r) > 1e-3 || Math.abs(west - c) > 1e-3) throw new FeedFormatError('the grid is not aligned with the CHIRPS 0.05° grid');
	return { northRow: r, westCol: c };
}

/**
 * One grid file's values over the region, in the copy's order: (lat, lon)
 * with row 0 the southernmost, NaN for no data and for any cell the file
 * doesn't cover. Null when the file isn't published (404). Every read of the
 * file must carry the same tag, or it changed while being read.
 */
export async function readRegionDay(
	http: FeedHttp,
	url: string,
	region: Region = MIRROR_REGION
): Promise<{ values: Float32Array; tag: string | null } | null> {
	let tag: string | null | undefined;
	const read = async (start: number, end: number) => {
		if (!http.rangeTagged) return http.range(url, start, end);
		const got = await http.rangeTagged(url, start, end);
		if (!got) return null;
		if (tag === undefined) tag = got.tag;
		else if (got.tag !== tag) throw new FeedUnavailableError('a file changed while it was being read');
		return got.bytes;
	};
	const grid = await openGrid(read);
	if (!grid) return null;
	const { rows, cols } = regionSize(region);
	const { northRow, westCol } = regionPlacement(grid, region);
	// Region row y is file row northRow + (rows - 1 - y); column x is file column westCol + x.
	const fileRow = (y: number) => northRow + rows - 1 - y;
	const y0 = Math.max(0, rows - 1 - (grid.height - 1 - northRow)); // southernmost region row in the file
	const y1 = Math.min(rows - 1, rows - 1 + northRow); // northernmost
	const x0 = Math.max(0, -westCol);
	const x1 = Math.min(cols - 1, grid.width - 1 - westCol);
	const out = new Float32Array(rows * cols).fill(Number.NaN);
	if (y0 > y1 || x0 > x1) throw new FeedFormatError('the grid does not cover the region the copy holds');
	const r0 = fileRow(y1);
	const band = await readRows(read, grid, r0, fileRow(y0));
	for (let y = y0; y <= y1; y++) {
		const from = (fileRow(y) - r0) * grid.width + westCol;
		for (let x = x0; x <= x1; x++) {
			const v = band[from + x]!;
			if (!Number.isNaN(v) && (v < 0 || v > 2000)) throw new FeedFormatError(`the grid has an implausible rainfall of ${v} mm`);
			out[y * cols + x] = v;
		}
	}
	return { values: out, tag: tag ?? null };
}

const dayAfter = (iso: string) => fromEpochDay(toEpochDay(iso) + 1);
const maxDay = (a: string, b: string) => (a > b ? a : b);

/** The end of the run of consecutive days in `held` starting at `from`, or null when `from` isn't held. */
export function contiguousThrough(held: ReadonlySet<string>, from: string): string | null {
	if (!held.has(from)) return null;
	let d = from;
	while (held.has(dayAfter(d))) d = dayAfter(d);
	return d;
}

type Deletable = { delete?: (key: AbsolutePath) => Promise<unknown> };

/** Delete one day's chunks of the `prelim` array, where the store can delete (a missing chunk is fine). */
async function deleteDayChunks(store: MirrorStore, index: number, region: Region): Promise<boolean> {
	const del = (store as Deletable).delete?.bind(store);
	if (!del) return false;
	const { rows, cols } = regionSize(region);
	for (let cy = 0; cy < Math.ceil(rows / DAILY_CHUNK[1]); cy++) {
		for (let cx = 0; cx < Math.ceil(cols / DAILY_CHUNK[2]); cx++) {
			try {
				await del(`/prelim/c/${index}/${cy}/${cx}` as AbsolutePath);
			} catch (err) {
				const e = err as { code?: string; name?: string };
				if (e.code !== 'ENOENT' && e.name !== 'NoSuchKey' && e.name !== 'NotFound') throw err;
			}
		}
	}
	return true;
}

/** Copy the new preliminary days into the copy (see the header). Never throws for a source failure: it reports it. */
export async function runDailyIngest(opts: DailyIngestOptions): Promise<DailyIngestResult> {
	const region = opts.region ?? MIRROR_REGION;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const maxFiles = opts.maxFiles ?? DAILY_MAX_FILES;
	const { http, counter } = pacedHttp(opts.http, opts.intervalMs ?? REQUEST_INTERVAL_MS, now, sleep, {
		deadline: opts.deadline,
		onThrottled: opts.onThrottled ?? logThrottled('prelim')
	});
	const { store, today } = opts;

	const sat = await readManifest(store, 'sat');
	const finalThrough = sat?.finalThrough ?? null;
	const existing = await readManifest(store, 'prelim');
	let arr = await openDaily(store, 'prelim');
	if (existing && !arr) throw new MirrorFormatError('the rain data copy has a prelim manifest but no prelim array');

	// The first day the copy holds, fixed once the array exists.
	const firstDay = arr?.firstDay ?? (finalThrough ? dayAfter(finalThrough) : fromEpochDay(toEpochDay(today) - (opts.lookbackDays ?? PRELIM_LOOKBACK_DAYS)));
	const anchor = finalThrough ? maxDay(dayAfter(finalThrough), firstDay) : firstDay;

	const files = new Map<string, Manifest['files'][number]>();
	for (const f of existing?.files ?? []) {
		const day = prelimDayOf(f.url);
		if (!day) throw new MirrorFormatError(`the rain data copy's prelim manifest lists a file that names no day: ${f.url}`);
		files.set(day, f);
	}
	const revision = existing?.revision ?? 1;
	const changes = existing?.changes ?? [];

	const manifest = (): Manifest => {
		const held = new Set(files.keys());
		const prelimThrough = contiguousThrough(held, anchor);
		const years = [...held, ...(prelimThrough ? [prelimThrough] : [])].map((d) => Number(d.slice(0, 4)));
		const y = Number(today.slice(0, 4));
		return {
			product: 'prelim',
			revision,
			region: { ...region },
			grid: gridOf(region),
			years: years.length ? { first: Math.min(...years), last: Math.max(...years) } : { first: y, last: y },
			finalThrough: null,
			prelimThrough,
			files: [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, f]) => f),
			changes
		};
	};

	// 2. Drop the days the finals now hold: out of the manifest first, then their chunks, so a run cut
	// short in between leaves chunks nothing lists (harmless), never a listed day with no chunks.
	const dropped = finalThrough ? [...files.keys()].filter((day) => day <= finalThrough).sort() : [];
	if (dropped.length) {
		for (const day of dropped) files.delete(day);
		await writeManifest(store, manifest());
		for (const day of dropped) if (arr && day >= arr.firstDay) await deleteDayChunks(store, dayIndex(arr.firstDay, day), region);
	}

	// 3. Copy the new days, oldest first.
	const copied: string[] = [];
	let stopped: DailyIngestResult['stopped'] = 'up_to_date';
	let error: unknown = null;
	const { rows, cols } = regionSize(region);
	const block = { y0: 0, x0: 0, h: rows, w: cols };
	const last = fromEpochDay(toEpochDay(today) - 1);
	try {
		for (let day = anchor; day <= last; day = dayAfter(day)) {
			if (files.has(day)) continue;
			if (copied.length >= maxFiles) {
				stopped = 'max_files';
				break;
			}
			if (opts.deadline !== undefined && now() >= opts.deadline) {
				stopped = 'deadline';
				break;
			}
			const url = chirpsPrelimUrl(day);
			const got = await readRegionDay(http, url, region);
			if (!got) {
				stopped = 'not_published';
				break;
			}
			arr = await ensureDaily(store, 'prelim', firstDay, dayIndex(firstDay, day) + 1, { region });
			await writeDailyDays(arr, dayIndex(firstDay, day), block, got.values);
			const lm = got.tag?.startsWith('lm:') ? got.tag.slice(3) : null;
			files.set(day, {
				url,
				etag: got.tag !== null && lm === null ? got.tag : null,
				lastModified: lm,
				size: null,
				valuesSha256: manifestHash([got.values]),
				revision,
				fetchedAt: new Date(now()).toISOString()
			});
			copied.push(day);
			// Saved after every day: a run cut short keeps what it copied.
			await writeManifest(store, manifest());
		}
	} catch (err) {
		stopped = 'error';
		error = err;
	}

	const m = manifest();
	// The finals moved on with nothing dropped or copied: prelimThrough may still have moved with them. (A copy
	// with no manifest yet and nothing copied stays without one until its first day.)
	if (existing && !copied.length && !dropped.length && existing.prelimThrough !== m.prelimThrough) await writeManifest(store, m);
	const newest = [m.prelimThrough, finalThrough].filter((d): d is string => d !== null).sort().at(-1) ?? null;
	return {
		copied,
		dropped,
		prelimThrough: m.prelimThrough,
		finalThrough,
		lagDays: newest === null ? null : toEpochDay(today) - toEpochDay(newest),
		stopped,
		requests: counter.requests,
		error
	};
}

/**
 * The run's freshness as a CloudWatch Embedded Metric Format line: metric
 * MirrorLagDays, dimension Product=prelim, in the namespace the alarms read
 * (infra/ingest.tf). No PutMetricData, so no SDK client and no IAM grant:
 * CloudWatch Logs extracts it from the function's own log (logging/logEvent.ts
 * emitMetricLine).
 */
export function lagMetricLine(lagDays: number, now = Date.now()): string {
	return JSON.stringify({
		_aws: {
			Timestamp: now,
			CloudWatchMetrics: [{ Namespace: MIRROR_METRIC_NAMESPACE, Dimensions: [['Product']], Metrics: [{ Name: MIRROR_LAG_METRIC, Unit: 'None' }] }]
		},
		Product: 'prelim',
		[MIRROR_LAG_METRIC]: lagDays
	});
}

/**
 * The copy the daily ingest writes: MIRROR_URL, which must be set. Unlike a
 * reader (mirror/source.ts mirrorUrl), it never falls back to the committed
 * synthetic copy: a local run writes a copy of its own (file:///abs/path).
 */
export function dailyMirrorUrl(env: Record<string, string | undefined> = process.env): string {
	const v = env.MIRROR_URL?.trim();
	if (!v) throw new Error('MIRROR_URL is not set: the daily ingest writes the copy it names (file:///abs/path locally, never the committed fixture)');
	if (/\/backend\/fixtures\/mirror\/?$/.test(v)) throw new Error('MIRROR_URL names the committed synthetic copy, which the daily ingest never writes');
	return v;
}
