// The handover between the worker and the fetcher Lambda for dam observations
// (issue #604 Round 5; 249_dam_observation.sql, docs/architecture.md § Dam
// observations). The same pattern as the weekly DWS pass (ingest/dws.ts): the
// fetcher has internet but no database, the worker has the database but no
// internet, and both reach the mirror bucket (MIRROR_URL), so it carries:
//
//   worker tick ──put──► dams/wanted.json            uids of matched dams + every dam outline
//   fetcher, daily ─get─► dams/wanted.json
//     Waterbodies pass ──► dams/waterbodies/<uid>.json, dams/waterbodies-status.json   (waterbodies.ts)
//     WOfS pass        ──► dams/wofs/<featureId>.json,  dams/wofs-status.json          (R5-C)
//   worker tick ──get──► each status, then every file whose last good fetch is newer than what it loaded
//                ──────► app_dam_observation_load (load.ts)
//
// Every file is checked against its schema on read: what the fetcher wrote is
// untrusted input on the worker's side (it came from the internet).
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { FeedFormatError } from '../../feeds/errors.js';
import type { MirrorStore } from '../../mirror/store.js';

export type Position = [number, number];
export type DamOutlineGeometry = { type: 'Polygon'; coordinates: Position[][] } | { type: 'MultiPolygon'; coordinates: Position[][][] };

export type ObservationSource = 'waterbodies' | 'wofs';
export const OBSERVATION_SOURCES: readonly ObservationSource[] = ['waterbodies', 'wofs'];

export interface WantedOutline {
	featureId: string;
	/** The dam's traced outline, GeoJSON lon/lat. */
	geometry: DamOutlineGeometry;
	/** The first date the WOfS pass needs for this dam (ISO): the day after the newest WOfS row held, or WOFS_FIRST_DATE. */
	since: string;
}
export interface WantedList {
	generatedAt: string;
	/** The uids of the dams matched to a waterbody (dam_waterbody_match status 'matched'), each once. */
	waterbodies: string[];
	/** EVERY traced dam polygon in any project: WOfS observes each one, matched or not. */
	outlines: WantedOutline[];
}
export interface ObservationRow {
	/** ISO date of the satellite pass. */
	date: string;
	/** The wet area seen, m² (of the part seen clearly). */
	wetAreaM2: number;
	/** The share of the outline seen clearly, 0–100. */
	pctObserved: number;
}
export interface ObservationFile {
	source: ObservationSource;
	/** The uid (waterbodies), or the featureId (wofs). */
	key: string;
	fetchedAt: string;
	upstream: { url: string; etag?: string; lastModified?: string; itemId?: string }[];
	rows: (ObservationRow & { upstreamKey: string })[];
}
export interface PassStatus {
	source: ObservationSource;
	ranAt: string;
	/** The run stopped early on the upstream's answer (an HTTP 403, throttling): the copy is not being kept up. */
	stopped: boolean;
	reason?: string;
	/** Per key: the last good fetch (ISO time), the newest observation date held, the last error (a fixed code). */
	perKey: Record<string, { lastGood?: string; newest?: string; error?: string }>;
}

// --- Keys -----------------------------------------------------------------------------
export const WANTED_KEY = '/dams/wanted.json' as AbsolutePath;
export const statusKey = (source: ObservationSource) => `/dams/${source}-status.json` as AbsolutePath;
export const observationKey = (source: ObservationSource, key: string) => `/dams/${source}/${key}.json` as AbsolutePath;

// --- Limits and shapes ----------------------------------------------------------------
/** The most dams the wanted list holds (app_dam_outlines returns at most this many). */
export const MAX_OUTLINES = 5000;
/** The most rows one observation file holds (app_dam_observation_load's bound). */
export const MAX_ROWS = 20_000;
/** Landsat's record starts here; neither source has earlier dates. */
export const WOFS_FIRST_DATE = '1984-01-01';
/** A Waterbodies uid (a geohash; 249's waterbody_reference.uid). */
export const WATERBODY_UID = /^[0-9a-z]{6,12}$/;
const FEATURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoTime = z.string().datetime({ offset: true });
const Printable = (max: number) => z.string().min(1).max(max).regex(/^[!-~]+$/);
const Lon = z.number().finite().min(-180).max(180);
const Lat = z.number().finite().min(-90).max(90);
const Ring = z.array(z.tuple([Lon, Lat])).min(4).max(50_000);

const Outline = z
	.object({
		featureId: z.string().regex(FEATURE_ID),
		geometry: z.union([
			z.object({ type: z.literal('Polygon'), coordinates: z.array(Ring).min(1) }).strict(),
			z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(Ring).min(1)).min(1) }).strict()
		]),
		since: IsoDay
	})
	.strict();

export const WantedListSchema = z
	.object({
		generatedAt: IsoTime,
		waterbodies: z.array(z.string().regex(WATERBODY_UID)).max(MAX_OUTLINES),
		outlines: z.array(Outline).max(MAX_OUTLINES)
	})
	.strict()
	.refine((w) => new Set(w.waterbodies).size === w.waterbodies.length, 'a uid is listed twice')
	.refine((w) => new Set(w.outlines.map((o) => o.featureId)).size === w.outlines.length, 'a dam is listed twice');

const Row = z
	.object({
		date: IsoDay,
		wetAreaM2: z.number().finite().min(0).max(1e12),
		pctObserved: z.number().finite().min(0).max(100),
		upstreamKey: Printable(200)
	})
	.strict();

export const ObservationFileSchema = z
	.object({
		source: z.enum(['waterbodies', 'wofs']),
		key: z.string(),
		fetchedAt: IsoTime,
		upstream: z
			.array(
				z
					.object({ url: z.string().url().max(2000), etag: Printable(200).optional(), lastModified: z.string().max(100).optional(), itemId: Printable(200).optional() })
					.strict()
			)
			.max(MAX_ROWS),
		rows: z.array(Row).max(MAX_ROWS)
	})
	.strict()
	.refine((f) => (f.source === 'waterbodies' ? WATERBODY_UID : FEATURE_ID).test(f.key), 'the key is not a uid or a dam id')
	.refine((f) => new Set(f.rows.map((r) => r.date)).size === f.rows.length, 'a date is listed twice');

export const PassStatusSchema = z
	.object({
		source: z.enum(['waterbodies', 'wofs']),
		ranAt: IsoTime,
		stopped: z.boolean(),
		reason: z.string().max(100).optional(),
		perKey: z.record(
			z.string().max(64),
			z.object({ lastGood: IsoTime.optional(), newest: IsoDay.optional(), error: z.string().max(100).optional() }).strict()
		)
	})
	.strict();

// --- Read and write -------------------------------------------------------------------
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

export const readWanted = (store: MirrorStore): Promise<WantedList | null> => readJson(store, WANTED_KEY, WantedListSchema, 'wanted dams list') as Promise<WantedList | null>;
export const writeWanted = (store: MirrorStore, w: WantedList) => writeJson(store, WANTED_KEY, WantedListSchema.parse(w));
export const readStatus = (store: MirrorStore, source: ObservationSource): Promise<PassStatus | null> =>
	readJson(store, statusKey(source), PassStatusSchema, `${source} status`) as Promise<PassStatus | null>;
export const writeStatus = (store: MirrorStore, s: PassStatus) => writeJson(store, statusKey(s.source), PassStatusSchema.parse(s));
/** One file; null when absent. A file whose source or key isn't the one asked for is refused. */
export async function readObservationFile(store: MirrorStore, source: ObservationSource, key: string): Promise<ObservationFile | null> {
	const f = (await readJson(store, observationKey(source, key), ObservationFileSchema, `${source} file`)) as ObservationFile | null;
	if (f && (f.source !== source || f.key !== key)) throw new FeedFormatError(`the mirror's ${source} file is for another key`);
	return f;
}
export const writeObservationFile = (store: MirrorStore, f: ObservationFile) => writeJson(store, observationKey(f.source, f.key), ObservationFileSchema.parse(f));

// --- Metrics (CloudWatch Embedded Metric Format, from the fetcher's log) ---------------
// infra/dam_observations.tf alarms on them; every completed pass of either
// source publishes both, whatever it fetched (R5-C's WOfS pass too, with
// Source = 'wofs', through damPassMetricLine).
/** The namespace both sources' pass metrics go to. */
export const DAM_METRIC_NAMESPACE = 'water-management/DamObservations';
/** Heartbeat: 1 per completed pass, dimension Source. Alarmed when missing for two days (each source). */
export const DAM_PASS_METRIC = 'DamPassCompleted';
/** Data recency: days from today back to the newest observation date any key holds, dimension Source. Alarmed for wofs only. */
export const DAM_RECENCY_METRIC = 'DamObservationAgeDays';
/** The dimension's name. */
export const DAM_METRIC_DIMENSION = 'Source';

/** A completed pass's two metrics as one EMF line (logging/logEvent.ts emitMetricLine); the recency only when some key holds a date. */
export function damPassMetricLine(source: ObservationSource, recencyDays: number | null, now = Date.now()): string {
	const metrics: { Name: string; Unit: string }[] = [{ Name: DAM_PASS_METRIC, Unit: 'Count' }];
	if (recencyDays !== null) metrics.push({ Name: DAM_RECENCY_METRIC, Unit: 'None' });
	return JSON.stringify({
		_aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: DAM_METRIC_NAMESPACE, Dimensions: [[DAM_METRIC_DIMENSION]], Metrics: metrics }] },
		[DAM_METRIC_DIMENSION]: source,
		[DAM_PASS_METRIC]: 1,
		...(recencyDays !== null ? { [DAM_RECENCY_METRIC]: recencyDays } : {})
	});
}

/** Days from `today` back to the newest `newest` date in a status, or null when no key holds one. */
export function recencyDays(status: Pick<PassStatus, 'perKey'>, today: string): number | null {
	let newest: string | null = null;
	for (const k of Object.values(status.perKey)) if (k.newest && (newest === null || k.newest > newest)) newest = k.newest;
	if (newest === null) return null;
	return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000);
}
