// The GEFS pass: the newest complete CHIRPS-GEFS v3 issue into the rain data
// copy (issue #604 R3-A; docs/deployment.md § The data mirror). The fetcher
// Lambda runs it on its own EventBridge rule (lambda-fetcher.ts,
// `{"mode":"daily-ingest","pass":"gefs"}`, infra/feeds.tf), not after the
// preliminary pass at 03:00: CHC issues each forecast around 08:26–08:30 UTC,
// so a 03:00 run would always copy yesterday's, and the two passes together
// (up to ~80 + ~64 requests at one a second) don't fit the fetcher's 120 s.
// The rule runs a few minutes before the CHIRPS-GEFS feeds fall due (08:45
// UTC, 111_feed_daily_only) and hourly after, for a late issue; a run that
// finds the day's issue held asks CHC nothing.
//
// What a run does:
//   1. Reads the index (`gefs/index.json`: the issues held, newest first).
//   2. Tries today's issue, then yesterday's, the rule the per-feed fetch
//      keeps (feeds/sources/chirps.ts fetchGefs): an issue is copied whole
//      or not at all, since CHC writes its 16 files one after another and a
//      run can catch the leading days only. An issue already held ends the
//      run (`up_to_date`). For one not held, the 16th day's file is read
//      first: when it is missing the issue isn't complete (or not out), and
//      the run moves to yesterday's. Then the other 15. Each file is opened
//      (header and strip table) and the region's rows read across the whole
//      width (sources/tiff.ts readRows), about 3–4 requests, every request
//      paced at least REQUEST_INTERVAL_MS after the one before (daily.ts
//      pacedHttp): about 50–64 requests an issue.
//   3. Each day is checked (0–2000 mm, daily.ts readRegionDay), hashed
//      (manifestHash, D8), and written into the Zarr array `gefs/<issue>` in
//      the daily layout (D2: (day, lat, lon), chunk (1, 110, 124), attribute
//      `firstDay` = the issue date, the first forecast day).
//   4. Only once all 16 are written: the issue's manifest
//      (`gefs/<issue>/manifest.json`, its 16 files in day order), then the
//      index. A reader goes by the index and the manifest, so a run cut short
//      (a deadline, a missing file, a 403) publishes nothing: its chunks are
//      overwritten by the next run of that issue, or swept (5.).
//   5. Keeps the newest GEFS_KEEP_ISSUES (7) issues: the index first, then
//      the dropped issues' arrays deleted (chunks, zarr.json, manifest), and
//      any array of an unlisted issue in the fortnight before the newest
//      (a run cut short) swept the same way.
//
// A refusal (HTTP 403) or throttling ends the run at once, with no retry, as
// in the preliminary pass; the run reports the error rather than throwing, so
// the caller still publishes the lag metric (days since the newest issue
// held) and logs the outcome. An issue is published once by CHC, so its
// manifest's revision is always 1.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { isIsoDate } from '@water-management/engine/calendar';
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import type { FeedHttp } from '../feeds/http.js';
import { GEFS_DAYS, gefsUrl } from '../feeds/sources/chirps.js';
import { DAILY_CHUNK, type DailyProduct, ensureDaily, writeDailyDays } from '../mirror/arrays.js';
import { gridOf, MIRROR_REGION, type Region, regionSize } from '../mirror/grid.js';
import { type Manifest, manifestHash, MirrorManifestError, writeManifest } from '../mirror/manifest.js';
import type { MirrorStore } from '../mirror/store.js';
import { MIRROR_LAG_METRIC, MIRROR_METRIC_NAMESPACE, pacedHttp, readRegionDay, REQUEST_INTERVAL_MS } from './daily.js';

/** The newest issues the copy keeps; older ones are deleted. */
export const GEFS_KEEP_ISSUES = 7;
/** How far before the oldest kept issue a run looks for arrays a cut-short run left (days). */
export const GEFS_SWEEP_DAYS = 14;
/** Concurrent deletes in our own bucket (no upstream is asked). */
const DELETE_CONCURRENCY = 8;

/** The product (Zarr array path) of one issue. */
export const gefsProduct = (issue: string): DailyProduct => `gefs/${issue}`;

const INDEX_KEY = '/gefs/index.json' as AbsolutePath;
const IsoDay = z.string().refine(isIsoDate, 'an ISO date (YYYY-MM-DD)');

/** `gefs/index.json`: the complete issues the copy holds, newest first. */
export const GefsIndex = z
	.object({ issues: z.array(IsoDay).max(GEFS_KEEP_ISSUES * 4) })
	.strict()
	.refine((x) => x.issues.every((d, i) => i === 0 || d < x.issues[i - 1]!), 'issues newest first, each once');
export type GefsIndex = z.output<typeof GefsIndex>;

/** The issues the copy holds, newest first, or null when it holds none yet (no index). */
export async function readGefsIndex(store: MirrorStore): Promise<string[] | null> {
	const bytes = await store.get(INDEX_KEY);
	if (bytes === undefined) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new MirrorManifestError('the rain data copy’s gefs/index.json is not valid JSON');
	}
	const r = GefsIndex.safeParse(raw);
	if (!r.success) throw new MirrorManifestError(`the rain data copy’s gefs/index.json is invalid: ${r.error.issues[0]!.message}`);
	return r.data.issues;
}

export async function writeGefsIndex(store: MirrorStore, issues: readonly string[]): Promise<void> {
	const ok = GefsIndex.parse({ issues: [...issues] });
	await store.set(INDEX_KEY, new TextEncoder().encode(`${JSON.stringify(ok, null, 2)}\n`));
}

export interface GefsIngestOptions {
	store: MirrorStore;
	http: FeedHttp;
	/** Today (UTC), ISO. */
	today: string;
	/** Epoch ms after which no new file is started (the Lambda's time left, less the time to save). */
	deadline?: number;
	/** Minimum gap between two requests' starts; 0 in fixtures mode. */
	intervalMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	region?: Region;
	keep?: number;
}

export interface GefsIngestResult {
	/** The issue copied this run, or null. */
	copied: string | null;
	/** An issue found partly published (its 16th day missing, or a day before it), or null. */
	partial: string | null;
	/** The issues held after the run, newest first. */
	held: string[];
	/** Issues whose arrays were deleted this run (dropped past GEFS_KEEP_ISSUES, or left by a cut-short run). */
	deleted: string[];
	/** Today minus the newest issue held, or null when none is. */
	lagDays: number | null;
	/** `copied`; `up_to_date` (the newest issue there is was held already); `not_published` (neither today's nor yesterday's is complete); `deadline`; `error`. */
	stopped: 'copied' | 'up_to_date' | 'not_published' | 'deadline' | 'error';
	requests: number;
	/** The failure that stopped the run (a 403 included), or null. */
	error: unknown;
}

type Deletable = { delete?: (key: AbsolutePath) => Promise<unknown> };

const missing = (err: unknown) => {
	const e = err as { code?: string; name?: string };
	return e.code === 'ENOENT' || e.name === 'NoSuchKey' || e.name === 'NotFound';
};

/** Delete one issue's array and manifest, where the store can delete (a missing key is fine). */
export async function deleteGefsIssue(store: MirrorStore, issue: string, region: Region = MIRROR_REGION): Promise<boolean> {
	const del = (store as Deletable).delete?.bind(store);
	if (!del) return false;
	const { rows, cols } = regionSize(region);
	const keys: string[] = [];
	for (let d = 0; d < GEFS_DAYS; d++) {
		for (let cy = 0; cy < Math.ceil(rows / DAILY_CHUNK[1]); cy++) for (let cx = 0; cx < Math.ceil(cols / DAILY_CHUNK[2]); cx++) keys.push(`/gefs/${issue}/c/${d}/${cy}/${cx}`);
	}
	const one = async (k: string) => {
		try {
			await del(k as AbsolutePath);
		} catch (err) {
			if (!missing(err)) throw err;
		}
	};
	for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) await Promise.all(keys.slice(i, i + DELETE_CONCURRENCY).map(one));
	// The metadata last: an array whose zarr.json is gone is gone, whatever chunks a failure left.
	await one(`/gefs/${issue}/zarr.json`);
	await one(`/gefs/${issue}/manifest.json`);
	return true;
}

const addDays = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

/** Copy the newest complete issue into the copy (see the header). Never throws for a source failure: it reports it. */
export async function runGefsIngest(opts: GefsIngestOptions): Promise<GefsIngestResult> {
	const region = opts.region ?? MIRROR_REGION;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const keep = opts.keep ?? GEFS_KEEP_ISSUES;
	const { http, counter } = pacedHttp(opts.http, opts.intervalMs ?? REQUEST_INTERVAL_MS, now, sleep);
	const { store, today } = opts;
	const { rows, cols } = regionSize(region);
	const block = { y0: 0, x0: 0, h: rows, w: cols };

	let held = (await readGefsIndex(store)) ?? [];
	const deleted: string[] = [];
	let copied: string | null = null;
	let partial: string | null = null;
	let stopped: GefsIngestResult['stopped'] = 'not_published';
	let error: unknown = null;

	/** One issue whole: 'copied', or why not. */
	const copyIssue = async (issue: string): Promise<'copied' | 'not_published' | 'deadline'> => {
		const product = gefsProduct(issue);
		const files: (Manifest['files'][number] | null)[] = new Array(GEFS_DAYS).fill(null);
		// The 16th day first: CHC writes the days in order, so without it the issue isn't complete.
		const order = [GEFS_DAYS - 1, ...Array.from({ length: GEFS_DAYS - 1 }, (_, i) => i)];
		for (const d of order) {
			if (opts.deadline !== undefined && now() >= opts.deadline) return 'deadline';
			const url = gefsUrl(issue, addDays(issue, d));
			const got = await readRegionDay(http, url, region);
			if (!got) {
				if (d !== GEFS_DAYS - 1 || files.some((f) => f !== null)) partial = issue;
				return 'not_published';
			}
			const arr = await ensureDaily(store, product, issue, GEFS_DAYS, { region });
			await writeDailyDays(arr, d, block, got.values);
			const lm = got.tag?.startsWith('lm:') ? got.tag.slice(3) : null;
			files[d] = {
				url,
				etag: got.tag !== null && lm === null ? got.tag : null,
				lastModified: lm,
				size: null,
				valuesSha256: manifestHash([got.values]),
				revision: 1,
				fetchedAt: new Date(now()).toISOString()
			};
		}
		await writeManifest(store, {
			product,
			revision: 1,
			region: { ...region },
			grid: gridOf(region),
			years: { first: Number(issue.slice(0, 4)), last: Number(addDays(issue, GEFS_DAYS - 1).slice(0, 4)) },
			finalThrough: null,
			prelimThrough: null,
			files: files as Manifest['files'],
			changes: []
		});
		return 'copied';
	};

	try {
		for (const back of [0, 1]) {
			const issue = addDays(today, -back);
			if (held.includes(issue)) {
				stopped = 'up_to_date';
				break;
			}
			const r = await copyIssue(issue);
			if (r === 'copied') {
				copied = issue;
				stopped = 'copied';
				break;
			}
			stopped = r;
			if (r === 'deadline') break;
		}
		if (copied !== null) {
			const all = [...new Set([copied, ...held])].sort().reverse();
			const kept = all.slice(0, keep);
			const dropped = all.slice(keep);
			// The index first, so a reader never finds a listed issue whose chunks are being deleted.
			await writeGefsIndex(store, kept);
			held = kept;
			for (const issue of dropped) if (await deleteGefsIssue(store, issue, region)) deleted.push(issue);
			// Arrays a cut-short run left: an unlisted issue in the fortnight before the newest.
			const oldest = kept.at(-1)!;
			for (let d = addDays(oldest, -GEFS_SWEEP_DAYS); d < kept[0]!; d = addDays(d, 1)) {
				if (kept.includes(d) || dropped.includes(d)) continue;
				if ((await store.get(`/gefs/${d}/zarr.json` as AbsolutePath)) === undefined) continue;
				if (await deleteGefsIssue(store, d, region)) deleted.push(d);
			}
		}
	} catch (err) {
		stopped = 'error';
		error = err;
	}

	return {
		copied,
		partial,
		held,
		deleted,
		lagDays: held.length ? toEpochDay(today) - toEpochDay(held[0]!) : null,
		stopped,
		requests: counter.requests,
		error
	};
}

/**
 * The run's freshness as a CloudWatch Embedded Metric Format line: metric
 * MirrorLagDays, dimension Product=gefs, days since the newest issue held,
 * in the namespace the alarms read (infra/ingest.tf mirror_lag_gefs).
 */
export function gefsLagMetricLine(lagDays: number, now = Date.now()): string {
	return JSON.stringify({
		_aws: {
			Timestamp: now,
			CloudWatchMetrics: [{ Namespace: MIRROR_METRIC_NAMESPACE, Dimensions: [['Product']], Metrics: [{ Name: MIRROR_LAG_METRIC, Unit: 'None' }] }]
		},
		Product: 'gefs',
		[MIRROR_LAG_METRIC]: lagDays
	});
}
