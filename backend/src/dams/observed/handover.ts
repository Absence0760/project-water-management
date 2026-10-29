// The handover between the worker and the fetcher Lambda for dam observations
// (issue #604 Round 5; 261_dam_observation.sql, docs/architecture.md § Dam
// observations). The same pattern as the weekly DWS pass (ingest/dws.ts): the
// fetcher has internet but no database, the worker has the database but no
// internet, and both reach the mirror bucket (MIRROR_URL), so it carries:
//
//   worker tick ──put──► dams/wanted.json            uids of matched dams + every dam outline
//   fetcher, hourly ─get─► dams/wanted.json
//     Waterbodies pass ──► dams/waterbodies/<uid>.json, dams/waterbodies-status.json   (waterbodies.ts)
//     WOfS pass        ──► dams/wofs/<featureId>.json,  dams/wofs-status.json          (R5-C)
//     Sentinel-2 pass  ──► dams/s2/<featureId>.json,    dams/s2-status.json            (#624 step 4)
//     Sentinel-1 pass  ──► dams/s1/<featureId>.json,    dams/s1-status.json,
//                          dams/s1-agreement.json (sentinel/agreement.ts)                (#624 step 5)
//   worker tick ──get──► each status, then every file whose last good fetch is newer than what it loaded
//                ──────► app_dam_observation_load (load.ts)
//
// Every file is checked against its schema on read: what the fetcher wrote is
// untrusted input on the worker's side (it came from the internet).
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { FeedFormatError } from '../../feeds/errors.js';
import { fixtureMirrorUrl, mirrorStore } from '../../mirror/source.js';
import { openStore, type MirrorStore } from '../../mirror/store.js';

export type Position = [number, number];
export type DamOutlineGeometry = { type: 'Polygon'; coordinates: Position[][] } | { type: 'MultiPolygon'; coordinates: Position[][][] };

export type ObservationSource = 'waterbodies' | 'wofs' | 's2' | 's1';
export const OBSERVATION_SOURCES: readonly ObservationSource[] = ['waterbodies', 'wofs', 's2', 's1'];
/** The sources that observe every traced dam over its own outline (a pass file per dam, keyed by its feature id). */
export type OutlineSource = Exclude<ObservationSource, 'waterbodies'>;
/** The Sentinel sources, each behind its own flag as well as DAM_OBSERVATIONS (damSourceOn). */
export type SentinelSource = 's2' | 's1';

/**
 * Whether the fetcher runs a Sentinel source's pass: DAM_OBSERVATIONS_S2 / DAM_OBSERVATIONS_S1 on, off or unset (off).
 * infra/dam_observations.tf sets it on only with dam_observations_enabled and the source's own variable.
 */
export function damSourceOn(source: SentinelSource, env: Record<string, string | undefined> = process.env): boolean {
	// Each flag named in full, so the settings inventory (config/production.security.test.ts) sees it read.
	const [name, raw] = source === 's2' ? ['DAM_OBSERVATIONS_S2', env.DAM_OBSERVATIONS_S2] : ['DAM_OBSERVATIONS_S1', env.DAM_OBSERVATIONS_S1];
	const v = raw?.trim() ?? '';
	if (v !== '' && v !== 'on' && v !== 'off') throw new Error(`unknown ${name} "${v}" (expected on or off)`);
	return v === 'on';
}

export interface WantedOutline {
	featureId: string;
	/** The dam's traced outline, GeoJSON lon/lat. */
	geometry: DamOutlineGeometry;
	/** The first date the WOfS pass needs for this dam (ISO): the day after the newest WOfS row held, or WOFS_FIRST_DATE. */
	since: string;
	/** The same for the Sentinel sources, only for a source the dam holds a row of (else the pass's own backfill start). */
	sinceBy?: Partial<Record<SentinelSource, string>>;
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
	/** The uid (waterbodies), or the featureId (wofs, s2, s1). */
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
	/** A throttled stop's Retry-After, in seconds, when the source gave one: the pause (pausedUntil) lasts at least this long. */
	retryAfterSeconds?: number;
	/**
	 * Per key: the last good fetch (ISO time), the newest observation date held, the last error (a fixed code), and
	 * the last time it was asked for at all (Waterbodies only: a key that keeps failing is asked again a day later, not every run).
	 */
	perKey: Record<string, { lastGood?: string; newest?: string; error?: string; triedAt?: string }>;
}

type Env = Record<string, string | undefined>;

/** The bucket the handover goes through: MIRROR_URL, never the committed synthetic copy (a live process must name one). */
export function damsStore(env: Env = process.env): MirrorStore {
	const v = env.MIRROR_URL?.trim();
	if (!v || v.replace(/\/?$/, '/') === fixtureMirrorUrl()) {
		throw new Error('MIRROR_URL must name the bucket (or a scratch directory) the dam passes read; the committed synthetic copy is never written');
	}
	return env === process.env ? mirrorStore(env) : openStore(v);
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
/** A Waterbodies uid (a geohash; 261's waterbody_reference.uid). */
export const WATERBODY_UID = /^[0-9a-z]{6,12}$/;
export const FEATURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A real calendar date (2023-02-31 is not one), ISO. */
export const isCalendarDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const IsoDay = z.string().refine(isCalendarDate, 'not a calendar date');
/** An observation's date: a calendar date from Landsat's start to tomorrow (UTC), as app_dam_observation_load bounds it. */
const ObsDay = IsoDay.refine((d) => d >= '1984-01-01' && d <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), 'outside 1984 to tomorrow');
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
		since: IsoDay,
		sinceBy: z.object({ s2: IsoDay.optional(), s1: IsoDay.optional() }).strict().optional()
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
		date: ObsDay,
		wetAreaM2: z.number().finite().min(0).max(1e12),
		pctObserved: z.number().finite().min(0).max(100),
		upstreamKey: Printable(200)
	})
	.strict();

export const ObservationFileSchema = z
	.object({
		source: z.enum(['waterbodies', 'wofs', 's2', 's1']),
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
		source: z.enum(['waterbodies', 'wofs', 's2', 's1']),
		ranAt: IsoTime,
		stopped: z.boolean(),
		reason: z.string().max(100).optional(),
		retryAfterSeconds: z.number().int().min(0).max(31_536_000).optional(),
		perKey: z.record(
			z.string().max(64),
			z.object({ lastGood: IsoTime.optional(), newest: IsoDay.optional(), error: z.string().max(100).optional(), triedAt: IsoTime.optional() }).strict()
		)
	})
	.strict();

// --- Read and write -------------------------------------------------------------------
/** One of the handover's JSON files, checked against `schema`; null when it isn't there. */
export async function readJson<T>(store: MirrorStore, key: AbsolutePath, schema: z.ZodType<T>, what: string): Promise<T | null> {
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
/** Writes one of the handover's JSON files. */
export const writeJson = (store: MirrorStore, key: AbsolutePath, value: unknown) => store.set(key, new TextEncoder().encode(JSON.stringify(value)));

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

// --- The pause after a refusal ------------------------------------------------------------
// Issue #604's rule: an HTTP 403 stops the run and alerts, never a retry. So
// once a pass stopped refused (403) or throttled (429/503), that source is
// left alone for REFUSED_PAUSE_HOURS from the stopped run's ranAt (or a
// longer Retry-After the source gave): its pass asks nothing, writes nothing
// (so the stopped status, and the pause, stand) and publishes no heartbeat,
// so the heartbeat alarm (infra/dam_observations.tf, 18 h without one) is
// the alert. Each source pauses on its own; the other goes on.
/** How long a source is left alone after its pass stopped on a refusal or throttling. */
export const REFUSED_PAUSE_HOURS = 24;

/** Until when (epoch ms) a source is paused by its last status, or null when it isn't (see above). */
export function pausedUntil(status: Pick<PassStatus, 'ranAt' | 'stopped' | 'reason' | 'retryAfterSeconds'> | null): number | null {
	if (!status?.stopped || (status.reason !== 'refused' && status.reason !== 'throttled')) return null;
	const ran = Date.parse(status.ranAt);
	return ran + Math.max(REFUSED_PAUSE_HOURS * 3600, status.retryAfterSeconds ?? 0) * 1000;
}

/** The Retry-After (seconds) a stopping error carries, for the status. */
export const stopRetryAfter = (err: unknown): number | undefined => {
	const s = (err as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
	return typeof s === 'number' && Number.isFinite(s) && s >= 0 ? Math.min(Math.ceil(s), 31_536_000) : undefined;
};

// --- Metrics (CloudWatch Embedded Metric Format, from the fetcher's log) ---------------
// infra/dam_observations.tf alarms on them; every completed pass of any
// source publishes both, whatever it fetched (R5-C's WOfS pass too, with
// Source = 'wofs', and #624's Sentinel-2 pass with Source = 's2', through
// damPassMetricLine).
/** The namespace both sources' pass metrics go to. */
export const DAM_METRIC_NAMESPACE = 'water-management/DamObservations';
/** Heartbeat: 1 per completed pass, dimension Source. Alarmed when missing for two days (each source). */
export const DAM_PASS_METRIC = 'DamPassCompleted';
/** Data recency: days from today back to the newest observation date any key holds, dimension Source. Alarmed for wofs and s2 (not the frozen waterbodies). */
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
