// The weekly DWS pass: DWS verified daily flow for the stations our feeds
// read, into the mirror bucket, for the worker to load into the gauge record
// store (issue #604 R3-B, design D14; 247_gauge_record.sql,
// docs/architecture.md § Data feeds → DWS gauge records). The fetcher Lambda
// runs it on a weekly EventBridge schedule (lambda-fetcher.ts,
// `{"mode":"dws-weekly"}`, infra/feeds.tf), outside the VPC.
//
// Why through the bucket: the fetcher has internet but no database, and the
// worker has the database but no internet (docs/architecture.md § System).
// Each side already reaches the mirror bucket, so it carries the handover:
//
//   worker tick ──put──► dws/stations.json   the stations enabled DWS feeds name
//                         (feeds/gaugeRecordLoad.ts, app_dws_feed_stations)
//   fetcher, weekly ─get─► dws/stations.json
//                   ─GET─► DWS HyData.aspx, one station at a time, 1 a second
//                   ─put─► dws/<station>.json  its rows, with their quality codes
//                   ─put─► dws/status.json     per station the last good fetch; stale + why
//   worker tick ──get──► dws/status.json, then each newer dws/<station>.json
//                ──────► app_gauge_record_load_web (source dws-web)
//
// What a run does: reads the station list and the last status, and fetches
// each station whose last good fetch is REFRESH_DAYS old or more (never
// fetched first, then the oldest), until the list is done or the deadline
// (the Lambda's time left) comes; the rest go first next run. A station is
// asked for the newest two years (DWS_WINDOW_DAYS, today included), the
// window a feed asks for, parsed by the feed's own reader (sources/dws.ts
// parseDwsRows, on the engine's row reader) with the same checks. Requests
// wait REQUEST_INTERVAL_MS for each other.
//
// Politeness (#604 "The rule"): one User-Agent (feeds/http.ts), at most one
// request a second, and an HTTP 403 (FeedRefusedError), throttling (429/503)
// or DWS's ScriptServer error page (FeedServerError) stops the run at once,
// never retried: status.json says the source is stale and why, the lag
// metric keeps growing (MirrorLagDays{Product=dws}, alarmed in
// infra/feeds.tf), and the invocation fails. A station whose own page fails
// another way (a changed layout, not found, a timeout) is skipped, counted, and tried
// again next run; the others go on.
//
// Locally (FEED_SOURCE=fixtures) the client is the synthetic one and pacing
// is off; MIRROR_URL must name a directory of its own (dailyMirrorUrl).
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { DWS_RIVER_GAUGE } from '../feeds/config.js';
import { FeedFormatError, FeedRefusedError, FeedServerError, FeedThrottledError, FeedUnavailableError } from '../feeds/errors.js';
import type { FeedHttp } from '../feeds/http.js';
import { DWS_FORMAT_FAILURES, DWS_WINDOW_DAYS, dwsUrl, parseDwsRows } from '../feeds/sources/dws.js';
import type { MirrorStore } from '../mirror/store.js';
import { MIRROR_LAG_METRIC, MIRROR_METRIC_NAMESPACE, pacedHttp, REQUEST_INTERVAL_MS } from './daily.js';

/** A station is fetched again once its last good fetch is this many days old (the schedule is weekly: a day's slack). */
export const REFRESH_DAYS = 6;
/** The most stations the list may hold (app_dws_feed_stations returns at most this many). */
export const MAX_STATIONS = 500;
/** The product the lag metric and alarm name (infra/feeds.tf). */
export const DWS_LAG_PRODUCT = 'dws';

export const STATIONS_KEY = '/dws/stations.json' as AbsolutePath;
export const STATUS_KEY = '/dws/status.json' as AbsolutePath;
export const stationKey = (station: string) => `/dws/${station}.json` as AbsolutePath;

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoTime = z.string().datetime({ offset: true });
const Station = z.string().regex(DWS_RIVER_GAUGE);

/** dws/stations.json: the worker's list (feeds/gaugeRecordLoad.ts). `at` is when the list last changed. */
export const StationsFile = z
	.object({ v: z.literal(1), at: IsoTime, stations: z.array(Station).max(MAX_STATIONS) })
	.strict()
	.refine((f) => new Set(f.stations).size === f.stations.length, 'a station is listed twice');
export type StationsFile = z.output<typeof StationsFile>;

/** One listed day: [day, flow in m³/s or null for a gap, quality code or null]. */
const Row = z.tuple([IsoDay, z.number().finite().min(0).max(100_000).nullable(), z.string().regex(/^[A-Za-z0-9]{1,8}$/).nullable()]);

/** dws/<station>.json: one station's newest window as the page listed it. */
export const StationFile = z
	.object({ v: z.literal(1), station: Station, from: IsoDay, to: IsoDay, fetchedAt: IsoTime, rows: z.array(Row).max(DWS_WINDOW_DAYS + 1) })
	.strict()
	.refine((f) => f.from <= f.to && toEpochDay(f.to) - toEpochDay(f.from) < DWS_WINDOW_DAYS + 1, 'not a window of the pass')
	.refine((f) => f.rows.every(([d], i) => d >= f.from && d <= f.to && (i === 0 || d > f.rows[i - 1]![0])), 'rows outside the window or out of order');
export type StationFile = z.output<typeof StationFile>;

/** dws/status.json: how the last run ended, and per station its last good fetch. */
export const StatusFile = z
	.object({
		v: z.literal(1),
		runAt: IsoTime,
		/** The last run stopped on a refusal, throttling or the ScriptServer page: the copy is not being kept up. */
		stale: z.boolean(),
		reason: z.enum(['refused', 'throttled', 'server_error']).nullable(),
		stations: z.record(Station, z.object({ okAt: IsoTime.nullable(), triedAt: IsoTime }).strict())
	})
	.strict();
export type StatusFile = z.output<typeof StatusFile>;

async function readJson<T>(store: MirrorStore, key: AbsolutePath, schema: z.ZodType<T>, what: string): Promise<T | null> {
	const bytes = await store.get(key);
	if (bytes === undefined) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new FeedFormatError(`the mirror's ${what} is not JSON`);
	}
	const r = schema.safeParse(raw);
	if (!r.success) throw new FeedFormatError(`the mirror's ${what} is not valid`);
	return r.data;
}

const writeJson = (store: MirrorStore, key: AbsolutePath, value: unknown) => store.set(key, new TextEncoder().encode(JSON.stringify(value)));

export const readStations = (store: MirrorStore) => readJson(store, STATIONS_KEY, StationsFile, 'DWS station list');
export const readStatus = (store: MirrorStore) => readJson(store, STATUS_KEY, StatusFile, 'DWS status');
export const readStationFile = (store: MirrorStore, station: string) => readJson(store, stationKey(station), StationFile, `DWS file of ${station}`);
export const writeStations = (store: MirrorStore, f: StationsFile) => writeJson(store, STATIONS_KEY, f);

export interface DwsWeeklyOptions {
	store: MirrorStore;
	http: FeedHttp;
	/** Today (UTC), ISO: the window's last day. */
	today: string;
	/** Epoch ms after which no new station is started. */
	deadline?: number;
	/** Minimum gap between two requests' starts; 0 in fixtures mode. */
	intervalMs?: number;
	refreshDays?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface DwsWeeklyResult {
	/** Stations fetched and written this run, in order. */
	fetched: string[];
	/** Stations whose page failed another way (skipped, tried next run). */
	failed: string[];
	/** Listed stations fetched recently enough to wait. */
	fresh: number;
	/** No list yet; every due station done; the deadline; or stopped by DWS (refused, throttled, server_error). */
	stopped: 'no_stations' | 'done' | 'deadline' | 'refused' | 'throttled' | 'server_error';
	requests: number;
	/** Today minus the oldest last good fetch of a listed station (one never fetched counts from the list's date); null with no list or none listed. */
	lagDays: number | null;
	/** What stopped the run, or null. */
	error: unknown;
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** Which way DWS stopped the run, or null for a failure of one station's page. */
function stopReason(err: unknown): 'refused' | 'throttled' | 'server_error' | null {
	if (err instanceof FeedRefusedError) return 'refused';
	if (err instanceof FeedThrottledError) return 'throttled';
	if (err instanceof FeedServerError) return 'server_error';
	return null;
}

/** One weekly pass (see the header). Throws only for the mirror itself (unreadable, unwritable); DWS's failures are reported. */
export async function runDwsWeekly(opts: DwsWeeklyOptions): Promise<DwsWeeklyResult> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const { http, counter } = pacedHttp(opts.http, opts.intervalMs ?? REQUEST_INTERVAL_MS, now, sleep);
	const { store, today } = opts;
	const refreshMs = (opts.refreshDays ?? REFRESH_DAYS) * 86_400_000;

	const list = await readStations(store);
	const previous = await readStatus(store);
	const stations: StatusFile['stations'] = {};
	// Only the listed stations are kept: a feed switched off drops out of the status too.
	for (const s of list?.stations ?? []) if (previous?.stations[s]) stations[s] = previous.stations[s]!;

	const lag = () => {
		if (!list || !list.stations.length) return null;
		const t = toEpochDay(today);
		return Math.max(...list.stations.map((s) => t - toEpochDay(dayOf(stations[s]?.okAt ?? list.at))));
	};
	if (!list) return { fetched: [], failed: [], fresh: 0, stopped: 'no_stations', requests: 0, lagDays: null, error: null };

	const okAt = (s: string) => (stations[s]?.okAt ? Date.parse(stations[s]!.okAt!) : -Infinity);
	const due = list.stations.filter((s) => okAt(s) <= now() - refreshMs).sort((a, b) => okAt(a) - okAt(b) || (a < b ? -1 : 1));
	const from = fromEpochDay(toEpochDay(today) - (DWS_WINDOW_DAYS - 1));

	const fetched: string[] = [];
	const failed: string[] = [];
	let stopped: DwsWeeklyResult['stopped'] = 'done';
	let error: unknown = null;
	for (const station of due) {
		if (opts.deadline !== undefined && now() >= opts.deadline) {
			stopped = 'deadline';
			break;
		}
		const triedAt = new Date(now()).toISOString();
		try {
			const page = await http.text(dwsUrl(station, from, today));
			if (page === null) throw new FeedFormatError(DWS_FORMAT_FAILURES.notFound[0]);
			const parsed = parseDwsRows(page, { start: from, end: today });
			const file: StationFile = {
				v: 1,
				station,
				from,
				to: today,
				fetchedAt: triedAt,
				rows: parsed.rows.map((r): [string, number | null, string | null] => [r.day, r.value, r.quality])
			};
			await writeJson(store, stationKey(station), StationFile.parse(file));
			stations[station] = { okAt: triedAt, triedAt };
			fetched.push(station);
		} catch (err) {
			const reason = stopReason(err);
			if (reason) {
				stopped = reason;
				error = err;
				stations[station] = { okAt: stations[station]?.okAt ?? null, triedAt };
				break;
			}
			// A page that failed (changed layout, not found, timed out) is that station's; anything else (the mirror
			// write failing) is ours: stop, and let the invocation fail.
			if (!(err instanceof FeedFormatError || err instanceof FeedUnavailableError)) throw err;
			failed.push(station);
			stations[station] = { okAt: stations[station]?.okAt ?? null, triedAt };
		}
	}

	const stale = stopped === 'refused' || stopped === 'throttled' || stopped === 'server_error';
	const status: StatusFile = { v: 1, runAt: new Date(now()).toISOString(), stale, reason: stale ? (stopped as StatusFile['reason']) : null, stations };
	await writeJson(store, STATUS_KEY, status);
	return { fetched, failed, fresh: list.stations.length - due.length, stopped, requests: counter.requests, lagDays: lag(), error };
}

/** The pass's freshness as a CloudWatch Embedded Metric Format line: MirrorLagDays, Product=dws (daily.ts lagMetricLine's shape). */
export function dwsLagMetricLine(lagDays: number, now = Date.now()): string {
	return JSON.stringify({
		_aws: {
			Timestamp: now,
			CloudWatchMetrics: [{ Namespace: MIRROR_METRIC_NAMESPACE, Dimensions: [['Product']], Metrics: [{ Name: MIRROR_LAG_METRIC, Unit: 'None' }] }]
		},
		Product: DWS_LAG_PRODUCT,
		[MIRROR_LAG_METRIC]: lagDays
	});
}
