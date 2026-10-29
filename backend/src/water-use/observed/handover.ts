// The handover between the worker and the fetcher Lambda for observed actual
// ET (issue #623 step 4; 276_et_observation.sql, 280_et_units.sql,
// docs/architecture.md § Observed actual ET). The dam observations' pattern
// (dams/observed/handover.ts): the fetcher has internet but no database, the
// worker has the database but no internet, and both reach the mirror bucket
// (MIRROR_URL), so it carries:
//
//   worker tick ──put──► et/wanted.json          every unit's parcels (and their cropland), tick.ts
//   fetcher, et-dekadal ─get─► et/wanted.json
//     WaPOR pass ──► et/wapor/<unitKey>.json, et/wapor-status.json, et/wapor-state.json   (pass.ts)
//   worker tick ──get──► the status, then every file whose last good fetch is newer than what it loaded
//                ──────► app_et_observation_load
//
// Every file is checked against its schema on read: what the fetcher wrote is
// untrusted input on the worker's side (it came from the internet), and what
// the worker wrote is checked by the fetcher too. A unit's key is its node id
// (a UUID): no name, project or person crosses the bucket.
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { FeedFormatError } from '../../feeds/errors.js';
import { fixtureMirrorUrl, mirrorStore } from '../../mirror/source.js';
import { openStore, type MirrorStore } from '../../mirror/store.js';

export type Position = [number, number];
/** A unit's parcels as one MultiPolygon, GeoJSON lon/lat. */
export interface ParcelsGeometry {
	type: 'MultiPolygon';
	coordinates: Position[][][];
}

/** The sources with a pass. SSEBop (276 allows it) is #623 step 6, only if FAO declines. */
export type EtSource = 'wapor';
export const ET_SOURCES: readonly EtSource[] = ['wapor'];

/** The land cover's cropland under a unit's parcels: cell (row, col) is the square with south-west corner (col × cellDeg, row × cellDeg). */
export interface WantedCropland {
	/** The land-cover dataset's label (cropland_dataset.dataset). */
	dataset: string;
	cellDeg: number;
	/** [row, col, the cell's cropland share 0–1]: only cells with cropland; a cell not listed has none. */
	cells: [number, number, number][];
}
export interface WantedUnit {
	/** The unit's node id. */
	unitKey: string;
	parcels: ParcelsGeometry;
	/** When the unit's parcels last changed (276's load mark), so a change back to the same shape still changes the list. */
	changedAt?: string;
	/** Absent when no land cover is loaded there: the mean is then over the whole parcels ('parcel'). */
	cropland?: WantedCropland;
}
export interface WantedList {
	/** When the worker read the parcels: a pass file made from this list says so (parcelsAt), and the loader refuses it if the parcels changed since. */
	generatedAt: string;
	units: WantedUnit[];
}
export interface EtRow {
	/** The dekad's first day (the 1st, 11th or 21st), ISO. */
	dekad: string;
	/** The area-weighted mean actual ET over the valid part of the area, mm/day. 0 when validShare is 0 (nothing seen). */
	etaMmDay: number;
	/** The share of the area with a valid pixel, 0–1. */
	validShare: number;
	/** The area the mean covers, m². */
	areaM2: number;
	/** The upstream file's name, and its ETag when it had one. */
	file: string;
	etag?: string;
}
export interface EtFile {
	source: EtSource;
	unitKey: string;
	/** When this file was written: the worker reloads it when this is newer than what it loaded. */
	fetchedAt: string;
	/** The wanted list's generatedAt the parcels came from: the loader's p_fetched_at (276 refuses rows older than a parcel change). */
	parcelsAt: string;
	/** The product version (WAPOR-3). */
	version: string;
	mask: 'cropland' | 'parcel';
	rows: EtRow[];
}
export interface EtPassStatus {
	source: EtSource;
	ranAt: string;
	/** The run stopped early on the upstream's answer (an HTTP 403, throttling): the copy is not being kept up. */
	stopped: boolean;
	reason?: string;
	/** A throttled stop's Retry-After, in seconds, when the source gave one: the pause lasts at least this long. */
	retryAfterSeconds?: number;
	/** Per unit: the last time its file was written, the newest dekad it holds, and the last error (a fixed code). */
	perKey: Record<string, { lastGood?: string; newest?: string; error?: string }>;
}

type Env = Record<string, string | undefined>;

/** The bucket the handover goes through: MIRROR_URL, never the committed synthetic copy (a live process must name one). */
export function etStore(env: Env = process.env): MirrorStore {
	const v = env.MIRROR_URL?.trim();
	if (!v || v.replace(/\/?$/, '/') === fixtureMirrorUrl()) {
		throw new Error('MIRROR_URL must name the bucket (or a scratch directory) the ET pass reads; the committed synthetic copy is never written');
	}
	return env === process.env ? mirrorStore(env) : openStore(v);
}

// --- Keys -----------------------------------------------------------------------------
export const WANTED_KEY = '/et/wanted.json' as AbsolutePath;
export const statusKey = (source: EtSource) => `/et/${source}-status.json` as AbsolutePath;
export const etFileKey = (source: EtSource, unitKey: string) => `/et/${source}/${unitKey}.json` as AbsolutePath;

// --- Limits and shapes ----------------------------------------------------------------
/** The most units the wanted list holds (app_et_units returns at most this many). */
export const MAX_UNITS = 5000;
/** The most rows one file holds (app_et_observation_load's bound: 55 years of dekads). */
export const MAX_ROWS = 2000;
/** The most cropland cells one unit carries (about 0.5° × 0.5° at 0.0025°); past it the unit is read over its whole parcels. */
export const MAX_CROPLAND_CELLS = 40_000;
/** The most vertices one unit's parcels hold together (map_feature allows 50 000 a feature). */
export const MAX_PARCEL_POINTS = 200_000;
/** The most polygons one unit's parcels hold together. */
export const MAX_PARCEL_POLYGONS = 1000;

const UNIT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A real calendar date (2023-02-31 is not one), ISO. */
const isCalendarDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
/** A dekad's first day, from 2012 (SSEBop's start; 276's bound) to today (UTC). */
export const isDekadStart = (d: string) => isCalendarDate(d) && ['01', '11', '21'].includes(d.slice(8)) && d >= '2012-01-01';
const Dekad = z.string().refine(isDekadStart, 'not a dekad’s first day').refine((d) => d <= new Date().toISOString().slice(0, 10), 'in the future');
const IsoTime = z.string().datetime({ offset: true });
const Printable = (max: number) => z.string().min(1).max(max).regex(/^[!-~]+$/);
/** As fileTag keeps a tag and 276 bounds it: printable ASCII, no edge spaces, at most 200. */
const Tag = z.string().min(1).max(200).regex(/^[!-~](?:[ -~]*[!-~])?$/);
const Lon = z.number().finite().min(-180).max(180);
const Lat = z.number().finite().min(-90).max(90);
const Ring = z.array(z.tuple([Lon, Lat])).min(4).max(50_000);

const Parcels = z
	.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(Ring).min(1)).min(1).max(MAX_PARCEL_POLYGONS) })
	.strict()
	.refine((g) => g.coordinates.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0) <= MAX_PARCEL_POINTS, 'the parcels have too many points');

const Cropland = z
	.object({
		dataset: z.string().min(1).max(50),
		cellDeg: z.number().finite().gt(0).max(1),
		cells: z.array(z.tuple([z.number().int(), z.number().int(), z.number().finite().gt(0).max(1)])).max(MAX_CROPLAND_CELLS)
	})
	.strict();

export const WantedListSchema = z
	.object({
		generatedAt: IsoTime,
		units: z
			.array(z.object({ unitKey: z.string().regex(UNIT_KEY), parcels: Parcels, changedAt: IsoTime.optional(), cropland: Cropland.optional() }).strict())
			.max(MAX_UNITS)
	})
	.strict()
	.refine((w) => new Set(w.units.map((u) => u.unitKey)).size === w.units.length, 'a unit is listed twice');

const Row = z
	.object({
		dekad: Dekad,
		etaMmDay: z.number().finite().min(0).max(50),
		validShare: z.number().finite().min(0).max(1),
		areaM2: z.number().finite().gt(0).lt(1e11),
		file: Printable(300),
		etag: Tag.optional()
	})
	.strict();

export const EtFileSchema = z
	.object({
		source: z.enum(['wapor']),
		unitKey: z.string().regex(UNIT_KEY),
		fetchedAt: IsoTime,
		parcelsAt: IsoTime,
		version: Printable(50),
		mask: z.enum(['cropland', 'parcel']),
		rows: z.array(Row).max(MAX_ROWS)
	})
	.strict()
	.refine((f) => new Set(f.rows.map((r) => r.dekad)).size === f.rows.length, 'a dekad is listed twice');

export const EtPassStatusSchema = z
	.object({
		source: z.enum(['wapor']),
		ranAt: IsoTime,
		stopped: z.boolean(),
		reason: z.string().max(100).optional(),
		retryAfterSeconds: z.number().int().min(0).max(31_536_000).optional(),
		perKey: z.record(
			z.string().regex(UNIT_KEY),
			z.object({ lastGood: IsoTime.optional(), newest: Dekad.optional(), error: z.string().max(100).optional() }).strict()
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

export const readWanted = (store: MirrorStore): Promise<WantedList | null> => readJson(store, WANTED_KEY, WantedListSchema, 'wanted ET units list') as Promise<WantedList | null>;
export const writeWanted = async (store: MirrorStore, w: WantedList) => writeJson(store, WANTED_KEY, WantedListSchema.parse(w));
export const readStatus = (store: MirrorStore, source: EtSource): Promise<EtPassStatus | null> =>
	readJson(store, statusKey(source), EtPassStatusSchema, `${source} ET status`) as Promise<EtPassStatus | null>;
export const writeStatus = async (store: MirrorStore, s: EtPassStatus) => writeJson(store, statusKey(s.source), EtPassStatusSchema.parse(s));
/** One unit's file; null when absent. A file whose source or unit isn't the one asked for is refused. */
export async function readEtFile(store: MirrorStore, source: EtSource, unitKey: string): Promise<EtFile | null> {
	const f = (await readJson(store, etFileKey(source, unitKey), EtFileSchema, `${source} ET file`)) as EtFile | null;
	if (f && (f.source !== source || f.unitKey !== unitKey)) throw new FeedFormatError(`the mirror's ${source} ET file is for another unit`);
	return f;
}
export const writeEtFile = async (store: MirrorStore, f: EtFile) => writeJson(store, etFileKey(f.source, f.unitKey), EtFileSchema.parse(f));

// --- Metrics (CloudWatch Embedded Metric Format, from the fetcher's log) ---------------
// infra/et_observations.tf alarms on them; every completed pass publishes them, whatever it fetched.
/** The namespace the ET pass's metrics go to. */
export const ET_METRIC_NAMESPACE = 'water-management/EtObservations';
/** Heartbeat: 1 per completed pass, dimension Source. */
export const ET_PASS_METRIC = 'EtPassCompleted';
/** Data recency: days from today back to the newest dekad (its first day) any unit holds, dimension Source. */
export const ET_RECENCY_METRIC = 'EtObservationAgeDays';
export const ET_METRIC_DIMENSION = 'Source';

/** A completed pass's metrics as one EMF line (logging/logEvent.ts emitMetricLine); the recency only when some unit holds a dekad. */
export function etPassMetricLine(source: EtSource, recencyDays: number | null, now = Date.now()): string {
	const metrics: { Name: string; Unit: string }[] = [{ Name: ET_PASS_METRIC, Unit: 'Count' }];
	if (recencyDays !== null) metrics.push({ Name: ET_RECENCY_METRIC, Unit: 'None' });
	return JSON.stringify({
		_aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: ET_METRIC_NAMESPACE, Dimensions: [[ET_METRIC_DIMENSION]], Metrics: metrics }] },
		[ET_METRIC_DIMENSION]: source,
		[ET_PASS_METRIC]: 1,
		...(recencyDays !== null ? { [ET_RECENCY_METRIC]: recencyDays } : {})
	});
}

/** Days from `today` back to the newest dekad in a status, or null when no unit holds one. */
export function recencyDays(status: Pick<EtPassStatus, 'perKey'>, today: string): number | null {
	let newest: string | null = null;
	for (const k of Object.values(status.perKey)) if (k.newest && (newest === null || k.newest > newest)) newest = k.newest;
	if (newest === null) return null;
	return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000);
}
