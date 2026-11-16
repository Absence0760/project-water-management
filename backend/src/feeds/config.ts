// What a data feed is (018_feeds.sql, roadmap WP-2.10): a source, where in
// that source to read (grid cells, a box of them, or a gauge station), and which of the
// project's series the values merge into. Pure: the routes, the handlers and
// the fetcher Lambda all validate with these schemas.
import type { SeriesKind } from '@water-management/engine';
// Subpaths, not the package root: the fetcher Lambda reaches this module (lambda-fetcher.test.ts).
import { dayText } from '@water-management/engine/calendar';
import { CHIRPS_V3_RNL, CHIRPS_V3_SAT, type SeriesProvenance } from '@water-management/engine/provenance';
import { z } from 'zod';
import { type StationFormat, stationFormatProblem, timeFormatProblem } from '@water-management/engine/station-format';
import { SeriesStartDate } from '../series/limits.js';
import { FeedCredential } from './credential.js';
import { headerProblem, MAX_HEADERS, urlProblem } from './stationUrl.js';

export const FEED_SOURCES = ['chirps', 'chirps_gefs', 'dws', 'ecmwf_ens', 'agera5_et0', 'station_api'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];

/**
 * The forecast sources and how many days an issue holds: CHIRPS-GEFS 16, the
 * ECMWF ENS mean 15 (issue #604 R4-C, ingest/ecmwf_forecast.py). A forecast result is
 * one whole issue keyed by its issue date (feeds/ingest.ts).
 */
export const FORECAST_DAYS = { chirps_gefs: 16, ecmwf_ens: 15 } as const satisfies Partial<Record<FeedSource, number>>;
export type ForecastSource = keyof typeof FORECAST_DAYS;
export const isForecastSource = (s: FeedSource): s is ForecastSource => s in FORECAST_DAYS;

/**
 * Daily only (111_feed_daily_only): no source publishes more often (CHIRPS
 * daily at most, CHIRPS-GEFS one issue a day, verified DWS flow months
 * behind), so an hourly feed only re-read the same days. The field stays in
 * the API for compatibility; anything but 'daily' is a 400.
 */
export const FEED_SCHEDULES = ['daily'] as const;
export type FeedSchedule = (typeof FEED_SCHEDULES)[number];

export interface SourceSpec {
	label: string;
	/** Series kinds a feed of this source may write, the first being the default. */
	kinds: readonly SeriesKind[];
	unit: string;
	/**
	 * A feed is stale when its newest day is more than this many days before
	 * today (in the project's time zone, health.ts): the source's normal publishing lag plus a margin. Negative
	 * for a forecast, whose newest day is in the future.
	 */
	staleAfterDays: number;
	/**
	 * The data_stale alert's default level for a feed of this source: days
	 * past staleAfterDays before it fires (WP-2.13; an editor changes it per
	 * feed, alerts/routes.ts). A daily forecast matters within days; verified
	 * DWS flow arrives in irregular batches, so a month.
	 */
	staleAlertDays: number;
}

export const SOURCES: Record<FeedSource, SourceSpec> = {
	// Preliminary CHIRPS v3 comes out two days after each pentad ends, so the
	// newest day is normally 2–7 days old.
	chirps: { label: 'CHIRPS daily rainfall', kinds: ['rain_chirps_mm', 'rain_catchment_mm'], unit: 'mm', staleAfterDays: 12, staleAlertDays: 3 },
	// A new 16-day forecast is issued daily; at least 12 days ahead means one
	// was issued in the last few days.
	chirps_gefs: { label: 'CHIRPS-GEFS rainfall forecast', kinds: ['rain_forecast_mm'], unit: 'mm', staleAfterDays: -12, staleAlertDays: 2 },
	// The ECMWF ENS mean from our copy (issue #604 R4-C): 15 days from each
	// day's 00 UTC run; at least 11 days ahead means an issue of the last few days.
	ecmwf_ens: { label: 'ECMWF ENS rainfall forecast', kinds: ['rain_forecast_mm'], unit: 'mm', staleAfterDays: -11, staleAlertDays: 2 },
	// Daily FAO-56 reference ET from our copy (issue #604 R5-E, feeds/fromMirrorEt0.ts): AgERA5, about a week behind
	// and copied a month at a time, with NASA POWER's computed ET₀ on the newest days (2–7 days behind); 15 days is
	// POWER's lag plus a margin, so a feed goes stale when both copies have stopped.
	agera5_et0: { label: 'AgERA5 daily reference evapotranspiration', kinds: ['evap_et0_mm'], unit: 'mm', staleAfterDays: 15, staleAlertDays: 7 },
	// Verified DWS flow lags by months (docs/architecture.md § Data feeds).
	dws: { label: 'DWS gauge flow', kinds: ['flow_observed_m3s', 'flow_reference_m3s', 'flow_logger_m3s'], unit: 'm³/s', staleAfterDays: 240, staleAlertDays: 30 },
	// A rainfall station's own web API (issue #784): a logger reports within the day, so its newest whole rain day is
	// yesterday's; 3 days allows a day's outage at the provider before the card turns stale.
	station_api: { label: 'Weather station API', kinds: ['rain_catchment_mm'], unit: 'mm', staleAfterDays: 3, staleAlertDays: 2 }
};

const Lat = z.number().finite().min(-60).max(60);
const Lon = z.number().finite().min(-180).max(180);

/**
 * CHIRPS begins on this day; every earlier day is a 404. A start date before
 * it would make the first window all empty, and with no newest day to move
 * on from, every later fetch would read that same empty window again.
 */
export const CHIRPS_FIRST_DAY = '1981-01-01';

/**
 * CHIRPS v3's two daily products (sources/chirps.ts): `sat` (IMERG
 * disaggregation, from 1998, final + preliminary; the default) and `rnl`
 * (ERA5 disaggregation, from 1981, final only: a month at a time, with the
 * `sat` finals, 11–26 days after it ends in 2026). They share
 * the pentad totals but not the daily timing, so a feed reads one product end
 * to end, and the series records which (issue #40 part c): a feed never
 * splices `rnl` before 1998 onto `sat` after it. A record that must start
 * before 1998 uses `rnl` throughout.
 */
export const CHIRPS_DAILY_PRODUCTS = ['sat', 'rnl'] as const;
export type ChirpsDailyProduct = (typeof CHIRPS_DAILY_PRODUCTS)[number];
export const CHIRPS_PRODUCT_FIRST_DAY: Record<ChirpsDailyProduct, string> = { sat: '1998-01-01', rnl: CHIRPS_FIRST_DAY };

/** The CHIRPS grid's cell size in degrees; its cell edges fall on multiples of it (the product's grid starts at 180° W, 60° S / 60° N). */
export const CHIRPS_CELL_DEG = 0.05;
/** The most cells a bounding box (or a list of cells) may cover, and the most grid rows (a fetch reads one strip per row per day, sources/tiff.ts). */
export const BBOX_MAX_CELLS = 100;
export const BBOX_MAX_ROWS = 25;
export const BBOX_LIMIT_MESSAGE = `a bounding box covers at most ${BBOX_MAX_CELLS} of the 0.05° grid cells in at most ${BBOX_MAX_ROWS} rows (about 0.5° × 0.5°, and at most 1.25° from south to north)`;

const Cell = z.object({ lat: Lat, lon: Lon, weight: z.number().finite().positive().max(1000).default(1) }).strict();
/**
 * Where a feed's listed cells came from, when the map proposed them
 * (issue #326 B-rain, feeds/fromBoundary.ts): the project's catchment
 * boundary as it was (its id, name, and when it was last changed) and its
 * area. Only the from-boundary route writes it; the plain feed routes refuse
 * it, and a new list of cells drops it. A boundary changed since is how the
 * Map tab and the panel know to propose the cells again.
 */
const BoundaryMark = z
	.object({
		featureId: z.uuid(),
		name: z.string().max(100),
		updatedAt: z.iso.datetime({ offset: true }),
		areaKm2: z.number().finite().nonnegative()
	})
	.strict();
export type BoundaryMark = z.output<typeof BoundaryMark>;
/**
 * The land unit a feed's listed cells came from (issue #482,
 * feeds/fromUnits.ts): the unit (its node id), its map polygon (the farm
 * parcel's id and when it was last changed) and the polygon's area. Only the
 * from-units route writes it; the plain feed routes refuse it, and a new list
 * of cells drops it. A feed with it writes that unit's own rain: the series it
 * creates is sited at the unit (209_unit_rain_series' time_series_site_from_feed).
 */
const UnitMark = z
	.object({
		nodeId: z.uuid(),
		featureId: z.uuid(),
		updatedAt: z.iso.datetime({ offset: true }),
		areaKm2: z.number().finite().nonnegative()
	})
	.strict();
export type UnitMark = z.output<typeof UnitMark>;
/**
 * A box in degrees (south < north, west < east, no antimeridian crossing).
 * The feed reads every 0.05° cell the box overlaps, weighted by area (gridCells).
 */
const Bbox = z
	.object({ south: Lat, west: Lon, north: Lat, east: Lon })
	.strict()
	.refine((b) => b.south < b.north, { message: 'the south edge must be below the north edge', path: ['north'] })
	.refine((b) => b.west < b.east, { message: 'the west edge must be west of the east edge (a box may not cross 180°)', path: ['east'] });
export type Bbox = z.output<typeof Bbox>;

/** A grid cell a feed reads: its centre and its weight in the mean (sources/chirps.ts gridMean). */
export interface WeightedCell {
	lat: number;
	lon: number;
	weight: number;
}

/**
 * Cell edges within this many cells of a box edge count as on it, so float
 * error in a box drawn on grid lines (−20.1 / 0.05 = −402.00000000000006)
 * never adds a sliver cell.
 */
const EDGE_EPS = 1e-6;
const round = (x: number) => Number(x.toFixed(9));

/** The cell indices [first, last) a box edge pair spans along one axis. */
function span(lo: number, hi: number): [number, number] {
	return [Math.floor(lo / CHIRPS_CELL_DEG + EDGE_EPS), Math.ceil(hi / CHIRPS_CELL_DEG - EDGE_EPS)];
}

/**
 * The 0.05° cells a bounding box overlaps: each cell's centre, weighted by
 * the share of the cell inside the box × cos(the centre's latitude), so the
 * mean is area weighted (a 0.05° cell is narrower further from the equator).
 * Pure; `bboxCellCount` is the same count without the list.
 */
export function bboxCells(b: Bbox): WeightedCell[] {
	const [r0, r1] = span(b.south, b.north);
	const [c0, c1] = span(b.west, b.east);
	const out: WeightedCell[] = [];
	for (let r = r0; r < r1; r++) {
		const bottom = r * CHIRPS_CELL_DEG;
		const fLat = (Math.min(b.north, bottom + CHIRPS_CELL_DEG) - Math.max(b.south, bottom)) / CHIRPS_CELL_DEG;
		const lat = round((r + 0.5) * CHIRPS_CELL_DEG);
		for (let c = c0; c < c1; c++) {
			const left = c * CHIRPS_CELL_DEG;
			const fLon = (Math.min(b.east, left + CHIRPS_CELL_DEG) - Math.max(b.west, left)) / CHIRPS_CELL_DEG;
			out.push({ lat, lon: round((c + 0.5) * CHIRPS_CELL_DEG), weight: round(Math.min(1, fLat) * Math.min(1, fLon) * Math.cos((lat * Math.PI) / 180)) });
		}
	}
	return out;
}

/** How many grid rows and cells a box covers, without listing them. */
export function bboxCellCount(b: Bbox): { rows: number; cells: number } {
	const [r0, r1] = span(b.south, b.north);
	const [c0, c1] = span(b.west, b.east);
	const rows = Math.max(0, r1 - r0);
	return { rows, cells: rows * Math.max(0, c1 - c0) };
}

/**
 * CHIRPS / CHIRPS-GEFS: the rainfall is the weighted mean of these 0.05°
 * cells (`cells`, 1–100 points in at most 25 grid rows, each naming the
 * cell that holds it; the catchment boundary's, feeds/boundaryCells.ts), or of
 * the cells a bounding box overlaps (`bbox`, gridCells). Exactly one of the two.
 */
export const GridConfig = z
	.object({
		cells: z.array(Cell).min(1).max(BBOX_MAX_CELLS).optional(),
		bbox: Bbox.optional(),
		/** Listed cells only: the catchment boundary they were computed from (BoundaryMark). */
		boundary: BoundaryMark.optional(),
		/** Listed cells only: the land unit's polygon they were computed from (UnitMark); never with `boundary`. */
		unit: UnitMark.optional(),
		/** First day to fetch when the feed has no data yet (default: 60 days back), and never fetched before. */
		startDate: SeriesStartDate.refine((d) => d >= CHIRPS_FIRST_DAY, `CHIRPS begins on ${dayText(CHIRPS_FIRST_DAY)}`).optional(),
		staleAfterDays: z.number().int().min(-15).max(3650).optional(),
		/** CHIRPS only: which v3 daily product (absent = `sat`). FeedInput checks it against the source and the start date. */
		product: z.enum(CHIRPS_DAILY_PRODUCTS).optional(),
		/**
		 * A bounding box only: leave out the box's no-data (sea) cells and
		 * renormalise the others' weights (sources/chirps.ts NoDataPolicy). Listed
		 * cells stay strict: a listed sea cell is a mistake in the list.
		 */
		skipNoData: z.boolean().optional()
	})
	.strict()
	.superRefine((g, ctx) => {
		if (g.skipNoData !== undefined && g.bbox === undefined) {
			ctx.addIssue({ code: 'custom', path: ['skipNoData'], message: 'only a bounding box can leave out its sea cells; listed cells must each have data' });
			return;
		}
		if (g.boundary !== undefined && g.cells === undefined) {
			ctx.addIssue({ code: 'custom', path: ['boundary'], message: 'only listed cells come from the catchment boundary' });
			return;
		}
		if (g.unit !== undefined && (g.cells === undefined || g.boundary !== undefined)) {
			ctx.addIssue({ code: 'custom', path: ['unit'], message: 'only listed cells come from a unit’s polygon, and never also from the catchment boundary' });
			return;
		}
		if ((g.cells === undefined) === (g.bbox === undefined)) {
			ctx.addIssue({ code: 'custom', path: ['cells'], message: 'give either grid cells or a bounding box (bbox), not both' });
			return;
		}
		if (g.cells) {
			// The same read cost as a box: one strip per grid row per day.
			const rows = new Set(g.cells.map((c) => Math.floor(c.lat / CHIRPS_CELL_DEG + EDGE_EPS))).size;
			if (rows > BBOX_MAX_ROWS) ctx.addIssue({ code: 'custom', path: ['cells'], message: `listed cells may lie in at most ${BBOX_MAX_ROWS} rows of the 0.05° grid; these lie in ${rows}` });
		}
		if (g.bbox) {
			const n = bboxCellCount(g.bbox);
			if (n.cells === 0) ctx.addIssue({ code: 'custom', path: ['bbox'], message: 'the bounding box is too thin to cover a grid cell' });
			else if (n.cells > BBOX_MAX_CELLS || n.rows > BBOX_MAX_ROWS) {
				ctx.addIssue({ code: 'custom', path: ['bbox'], message: `${BBOX_LIMIT_MESSAGE}; this one covers ${n.cells} cells in ${n.rows} rows: shrink it, or list cells instead` });
			}
		}
	});

/** The weighted cells a grid feed reads: its own list, or its box's cells. */
export const gridCells = (config: GridConfig): WeightedCell[] => (config.bbox ? bboxCells(config.bbox) : config.cells!);

/**
 * The sources whose series is a record a feed builds up day by day over its
 * cells, so new cells must never be spliced onto it (296_feed_area_replace):
 * CHIRPS and the reference ET feed. A forecast replaces itself each issue,
 * and DWS reads a station, not cells.
 */
export const AREA_SOURCES: readonly FeedSource[] = ['chirps', 'agera5_et0'];

/** A grid config's area as the mean sees it: each 0.05° grid cell read, with its share of the weight, in grid order. */
function areaKey(c: GridConfig): string {
	const by = new Map<string, number>();
	let total = 0;
	for (const w of gridCells(c)) {
		const key = `${Math.floor(w.lat / CHIRPS_CELL_DEG + EDGE_EPS)},${Math.floor(w.lon / CHIRPS_CELL_DEG + EDGE_EPS)}`;
		const weight = w.weight ?? 1;
		by.set(key, (by.get(key) ?? 0) + weight);
		total += weight;
	}
	const cells = [...by].map(([k, w]) => `${k}:${(w / total).toFixed(9)}`).sort();
	return `${c.skipNoData ? 'skip' : 'all'}|${cells.join(';')}`;
}

/**
 * Whether two grid configs average the same area: the same grid cells with
 * the same shares of the weight (a cell listed twice, or weights scaled
 * alike, is the same mean), and the same sea-cell rule. The boundary or unit
 * mark, the product and the dates don't change the area.
 */
export const sameArea = (a: GridConfig, b: GridConfig): boolean => areaKey(a) === areaKey(b);

/** data_feed.replace_series_from for an area replacement (296): `area:` and what the feed writes (`area:CHIRPS sat/3.0`; `area:` with no version). */
export const AREA_REPLACE_PREFIX = 'area:';
export const isAreaReplace = (replaceFrom: string | null | undefined): boolean => !!replaceFrom && replaceFrom.startsWith(AREA_REPLACE_PREFIX);

/** DWS: a station code, e.g. X0H000 (letter, digit, letter, three digits; synthetic here). */
export const DWS_STATION = /^[A-Z]\d[A-Z]\d{3}$/;
/**
 * The stations a DWS feed may read: river flow gauges, whose third letter is
 * H. The letter is the station's kind in DWS's catalogue: its per-WMA River
 * lists hold only H codes, the Reservoir lists only R codes, and archived
 * pages ask for R stations with SiteType=RES and E stations with MET
 * (docs/architecture.md § Data feeds). Every other letter is refused: a
 * reservoir's daily table (variable 100.00, SiteType=RES) is its spillway
 * discharge computed from the dam level ("X0R000 (SPILLWAY)"), not the
 * river's flow, so it would land in a flow series as the wrong quantity;
 * E and N are weather and rainfall stations, T tidal, and no letter but H
 * has evidence of what its daily table holds.
 */
export const DWS_RIVER_GAUGE = /^[A-Z]\d[H]\d{3}$/;
export const DWS_RIVER_GAUGE_MESSAGE =
	'only a DWS river gauge can be fed (an H code, e.g. A2H012): a reservoir’s (R) daily table is its spillway discharge, not the river’s flow';
export const DwsConfig = z
	.object({
		station: z
			.string()
			.trim()
			.transform((s) => s.toUpperCase())
			.pipe(z.string().regex(DWS_STATION, 'a DWS station code looks like A2H012'))
			.pipe(z.string().regex(DWS_RIVER_GAUGE, DWS_RIVER_GAUGE_MESSAGE)),
		/** First day to fetch when the feed has no data yet (default: 10 years back), and never fetched before. */
		startDate: SeriesStartDate.optional(),
		staleAfterDays: z.number().int().min(1).max(3650).optional()
	})
	.strict();

export type GridConfig = z.output<typeof GridConfig>;

/** The CHIRPS daily product a feed reads (absent = `sat`, what every feed read before `rnl` was offered). */
export const chirpsProduct = (config: FeedConfig): ChirpsDailyProduct => ('product' in config && config.product) || 'sat';

/**
 * An `rnl` feed's usual delay: `rnl` has no preliminary product, so its
 * newest day is the end of the last month CHC finalised. Just before the
 * next month comes out it is that month's length (31 at most) plus the
 * release delay (CHC's daily/final/rnl/ listing, 2026: 11–26 days after the
 * month ends) old, 57 days at worst; 62 leaves five days' slack.
 */
export const CHIRPS_RNL_STALE_AFTER_DAYS = 62;

/**
 * How old a feed's newest day may be before it is stale (health.ts) and the
 * data_stale alert counts from (alerts/evaluate.ts): the feed's own
 * staleAfterDays; else, for a CHIRPS `rnl` feed,
 * CHIRPS_RNL_STALE_AFTER_DAYS (the source's 12 days fits `sat`'s
 * preliminary files); else its source's.
 */
export function feedStaleAfterDays(source: FeedSource, config: FeedConfig): number {
	if (config.staleAfterDays !== undefined) return config.staleAfterDays;
	if (source === 'chirps' && chirpsProduct(config) === 'rnl') return CHIRPS_RNL_STALE_AFTER_DAYS;
	return SOURCES[source].staleAfterDays;
}
export type DwsConfig = z.output<typeof DwsConfig>;

/**
 * A station API feed (issue #784): a rainfall station read from whatever web API its provider offers. The URL is a
 * template; the key is never in it (it is sealed apart, feeds/credential.ts, in data_feed_credential, so viewers who
 * read a feed's config never see it, and changing it doesn't reset the feed). How to read the answer is the engine's
 * StationFormat (@water-management/engine/station-format), shared with the attach card's sample preview.
 */
export const STATION_URL_MAX = 2000;
/** The most requests one fetch makes (one per maxDaysPerRequest days); a longer backfill continues on the next fetch. */
export const STATION_MAX_REQUESTS = 24;
/** Query parameter names that carry a key: one in the typed URL is refused, so a key never sits where viewers read it. */
export const STATION_KEY_PARAMS = /key|token|secret|pass|^pwd$|sig|auth|app_?id|credential|session|jwt|bearer|hmac|^code$|^otp$|^pin$|^hash$|^access$|licen[cs]e/i;
/** Header names that carry a key the same way: refused as extra headers (choose “Header” as how the key is sent). */
export const STATION_KEY_HEADERS = /key|token|secret|passw|auth|sig|credential|session|cookie/i;
/**
 * The earliest day a station feed may start from. A backfill is walked a capped window at a time, so a far start date
 * against an API that answers nothing would keep the fetcher asking for weeks (issue #784 security review); logger
 * APIs hold nothing older, and an older record is a one-off upload. A fixed day, not one counted back from today, so a
 * saved feed never stops parsing as the years pass (the fetcher re-parses every config it is sent).
 */
export const STATION_FIRST_DAY = '2000-01-01';
export const STATION_PLACEHOLDERS = ['{station}', '{start}', '{end}'] as const;

const StationId = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9 _.:@-]+$/, 'a station ID is letters, digits, spaces and . _ : @ -');

/** How the key is sent. The secret part is the credential; a header or parameter name is not secret. */
export const StationAuth = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }).strict(),
	/** Authorization: Bearer <key> */
	z.object({ kind: z.literal('bearer') }).strict(),
	/** <name>: <prefix><key> (X-Api-Key, X-Api-Secret, …) */
	z.object({ kind: z.literal('header'), name: z.string().trim().min(1).max(64), prefix: z.string().max(32).default('') }).strict(),
	/** ?<name>=<key>, added to the URL when the request is made (never stored in it) */
	z.object({ kind: z.literal('query'), name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, 'a parameter name is letters, digits and _ . -') }).strict(),
	/** Authorization: Basic (the credential's user and secret) */
	z.object({ kind: z.literal('basic') }).strict()
]);
export type StationAuth = z.output<typeof StationAuth>;

const Field = z.string().trim().max(200);
/** The engine's StationFormat, as the API accepts it (feeds/sources/station.ts checks what the fields mean together). */
export const StationFormatSchema = z
	.object({
		format: z.enum(['json', 'csv']),
		records: Field.optional(),
		recordsKeyedByTime: z.boolean().optional(),
		delimiter: z.enum([',', ';', '\t', '|']).optional(),
		skipLines: z.number().int().min(0).max(50).optional(),
		headerRow: z.boolean().optional(),
		decimalComma: z.boolean().optional(),
		time: Field,
		value: Field.min(1),
		timeFormat: z.string().trim().min(1).max(40),
		timeZone: z.string().trim().min(1).max(64).optional(),
		resolution: z.enum(['daily', 'subdaily']),
		stampMarks: z.enum(['end', 'start']).optional(),
		valueKind: z.enum(['amount', 'cumulative']).optional(),
		scale: z.number().finite().positive().max(1000).optional(),
		missing: z.array(z.string().max(32)).max(20).optional(),
		dayStartHour: z.number().int().min(0).max(23).optional(),
		creditDayTo: z.enum(['start', 'end']).optional(),
		noReadingsMeans: z.enum(['gap', 'zero']).optional()
	})
	.strict()
	.superRefine((f, ctx) => {
		const problem = stationFormatProblem(f as StationFormat);
		if (problem) ctx.addIssue({ code: 'custom', message: problem });
		if (!f.recordsKeyedByTime && f.time === '') ctx.addIssue({ code: 'custom', path: ['time'], message: 'name the time field or column' });
	});

export const StationApiConfig = z
	.object({
		/** https://…, with {station}, {start} and {end} filled in per request (each URL-encoded). */
		url: z
			.string()
			.trim()
			.min(1)
			.max(STATION_URL_MAX)
			.superRefine((raw, ctx) => {
				const problem = stationUrlProblem(raw);
				if (problem) ctx.addIssue({ code: 'custom', message: problem });
			}),
		station: StationId.optional(),
		auth: StationAuth,
		/** Extra headers the API wants (not secret: viewers can read them). */
		headers: z.record(z.string().trim().min(1).max(64), z.string().max(1024)).optional(),
		/** How {start} and {end} are written: 'iso', 'epoch_s', 'epoch_ms' or a pattern (YYYY-MM-DD). Default YYYY-MM-DD. */
		urlTimeFormat: z.string().trim().min(1).max(40).optional(),
		/** The most days one request asks for (the provider's own limit per call). Default 31. */
		maxDaysPerRequest: z.number().int().min(1).max(366).optional(),
		/** Days before the newest one that every fetch reads again (late or corrected readings). Default 7. */
		revisionDays: z.number().int().min(0).max(60).optional(),
		format: StationFormatSchema,
		/** First day to fetch when the feed has no data yet (default: 90 days back); not before STATION_FIRST_DAY. */
		startDate: SeriesStartDate.refine((d) => d >= STATION_FIRST_DAY, `a station feed starts on ${dayText(STATION_FIRST_DAY)} at the earliest: upload an older record instead`).optional(),
		staleAfterDays: z.number().int().min(1).max(3650).optional()
	})
	.strict()
	.superRefine((c, ctx) => {
		if (c.url.includes('{station}') && !c.station) ctx.addIssue({ code: 'custom', path: ['station'], message: 'the URL has {station}: give the station’s ID' });
		if (c.urlTimeFormat !== undefined) {
			const p = timeFormatProblem(c.urlTimeFormat);
			if (p) ctx.addIssue({ code: 'custom', path: ['urlTimeFormat'], message: p });
		}
		const names = Object.keys(c.headers ?? {});
		if (names.length > MAX_HEADERS) ctx.addIssue({ code: 'custom', path: ['headers'], message: `at most ${MAX_HEADERS} extra headers` });
		for (const n of names) {
			const p = headerProblem(n, c.headers![n]!);
			if (p) ctx.addIssue({ code: 'custom', path: ['headers', n], message: p });
			if (STATION_KEY_HEADERS.test(n)) {
				ctx.addIssue({ code: 'custom', path: ['headers', n], message: `the ${n} header carries a key: choose “Header” as how the key is sent, and enter the key in the key field` });
			}
		}
		if (c.auth.kind === 'header') {
			const p = headerProblem(c.auth.name, 'x');
			if (p) ctx.addIssue({ code: 'custom', path: ['auth', 'name'], message: p });
			else if (names.some((n) => n.toLowerCase() === (c.auth as { name: string }).name.toLowerCase())) {
				ctx.addIssue({ code: 'custom', path: ['auth', 'name'], message: 'that header is also an extra header' });
			}
		}
		if (c.auth.kind === 'query' && new URL(c.url.replace(/\{(station|start|end)\}/g, 'x')).searchParams.has(c.auth.name)) {
			ctx.addIssue({ code: 'custom', path: ['auth', 'name'], message: `the URL already has a ${c.auth.name} parameter: take it out, the key is added when the request is made` });
		}
	});
export type StationApiConfig = z.output<typeof StationApiConfig>;

/**
 * Why a URL template can't be saved, or null: a valid https URL once its placeholders are filled, a public host
 * (feeds/stationHttp.ts urlProblem), no key in its query (STATION_KEY_PARAMS), and only the known placeholders.
 * The fetcher checks again, address included, before every request.
 */
export function stationUrlProblem(raw: string): string | null {
	const unknown = raw.match(/\{[^}]*\}/g)?.find((p) => !(STATION_PLACEHOLDERS as readonly string[]).includes(p));
	if (unknown) return `${unknown} is not a placeholder: use {station}, {start} and {end}`;
	// The site itself is fixed: a placeholder in the host would let an edit of the station ID (or the dates) send the
	// key to another site while its binding (credential.ts credentialBinding) still read the same origin.
	const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw.trim())?.[1] ?? '';
	if (authority.includes('{')) return 'the URL’s site (its host) must be written out: put {station}, {start} and {end} in its path or query';
	const url = URL.parse(raw.replace(/\{(station|start|end)\}/g, 'x'));
	if (!url) return 'not a valid URL (it starts https://)';
	const problem = urlProblem(url);
	if (problem) return problem;
	for (const k of url.searchParams.keys()) {
		if (STATION_KEY_PARAMS.test(k)) return `the URL carries a key (${k}=…): take it out and enter the key in the key field, where it is kept sealed; choose “Query parameter ${k}” as how it is sent`;
	}
	if (url.hash) return 'the URL has a #fragment, which is never sent: take it out';
	return null;
}

export type FeedConfig = GridConfig | DwsConfig | StationApiConfig;

/**
 * What a feed writes, as the series records it (032_series_provenance.sql),
 * or null for a source whose series carry no product version (the forecast
 * and DWS). The feed refuses to write into a series that holds another one
 * without an owner's confirmation (feeds/ingest.ts).
 */
export function feedProvenance(source: FeedSource, config: FeedConfig): SeriesProvenance | null {
	if (source !== 'chirps') return null;
	return chirpsProduct(config) === 'rnl' ? CHIRPS_V3_RNL : CHIRPS_V3_SAT;
}

/**
 * Where a feed's days come from, as the series it creates records it
 * (107_series_source.sql): "DWS gauge flow data feed, station A2H012", or
 * the product's own label for CHIRPS. At most SOURCE_MAX characters.
 */
export function feedSourceText(source: FeedSource, config: FeedConfig): string {
	// A station API feed names its host and station, never the URL's path or query (feeds/stationHttp.ts safeUrl).
	if (source === 'station_api') {
		const c = config as StationApiConfig;
		const host = URL.parse(c.url.replace(/\{(station|start|end)\}/g, 'x'))?.hostname ?? 'its API';
		return `${SOURCES[source].label} data feed, ${host}${c.station ? `, station ${c.station}` : ''}`.slice(0, 100);
	}
	const station = 'station' in config ? `, station ${config.station}` : '';
	return `${SOURCES[source].label} data feed${station}`;
}

/** The config schema for a source. */
export const configSchema = (source: FeedSource) => (source === 'dws' ? DwsConfig : source === 'station_api' ? StationApiConfig : GridConfig);

/** Parse a feed's source + config + target together; zod issues point at the field. */
export const FeedInput = z
	.object({
		source: z.enum(FEED_SOURCES),
		config: z.unknown(),
		targetKind: z.string().optional(),
		targetName: z.string().trim().max(100).default(''),
		schedule: z.enum(FEED_SCHEDULES).default('daily'),
		enabled: z.boolean().default(true),
		/**
		 * The owner confirms the feed may replace its target series, which holds
		 * another product or version (or an unrecorded one): the routes record
		 * what it holds now, and the next fetch replaces it whole (issue #40c).
		 */
		replaceSeries: z.boolean().default(false),
		/**
		 * A station API feed's key, write-only (issue #784): sealed to the fetcher (feeds/credential.ts) and kept in
		 * data_feed_credential, never in the config and never returned. PATCH also takes null, which clears it (FeedPatch).
		 */
		credential: FeedCredential.optional()
	})
	.strict()
	.transform((v, ctx) => {
		const config = configSchema(v.source).safeParse(v.config);
		if (!config.success) {
			for (const issue of config.error.issues) ctx.addIssue({ ...issue, path: ['config', ...issue.path] } as never);
			return z.NEVER;
		}
		if (v.credential !== undefined) {
			const problem = credentialProblem(v.source, config.data);
			if (problem) {
				ctx.addIssue({ code: 'custom', path: ['credential'], message: problem });
				return z.NEVER;
			}
		}
		if (v.source !== 'dws' && v.source !== 'station_api') {
			const grid = config.data as GridConfig;
			if (grid.product !== undefined && v.source !== 'chirps') {
				ctx.addIssue({ code: 'custom', path: ['config', 'product'], message: 'only a CHIRPS feed has a daily product' });
				return z.NEVER;
			}
			const first = CHIRPS_PRODUCT_FIRST_DAY[grid.product ?? 'sat'];
			if (v.source === 'chirps' && grid.startDate !== undefined && grid.startDate < first) {
				ctx.addIssue({
					code: 'custom',
					path: ['config', 'startDate'],
					message: `CHIRPS v3’s ${grid.product ?? 'sat'} daily product begins on ${dayText(first)}; for earlier days use the rnl product for the whole record`
				});
				return z.NEVER;
			}
		}
		const kinds = SOURCES[v.source].kinds as readonly string[];
		const targetKind = v.targetKind ?? kinds[0]!;
		if (!kinds.includes(targetKind)) {
			ctx.addIssue({ code: 'custom', path: ['targetKind'], message: `a ${v.source} feed writes one of ${kinds.join(', ')}` });
			return z.NEVER;
		}
		return { ...v, config: config.data as FeedConfig, targetKind: targetKind as SeriesKind };
	});
export type FeedInput = z.output<typeof FeedInput>;

/**
 * Why a feed of `source` with `config` can't keep a credential, or null: only a station API feed sends a key, and only
 * when its auth sends one (not 'none'). The schema and the PATCH route (which may save a key alone) both ask.
 */
export function credentialProblem(source: FeedSource, config: FeedConfig): string | null {
	if (source !== 'station_api') return 'only a weather station API feed keeps a key';
	if ((config as StationApiConfig).auth.kind === 'none') return 'the feed sends no key (how the key is sent: none): choose how it is sent, or leave the key out';
	return null;
}

/** PATCH: any of the fields; the route merges them over the saved feed and parses the whole with FeedInput. */
export const FeedPatch = z
	.object({
		source: z.enum(FEED_SOURCES).optional(),
		config: z.unknown().optional(),
		targetKind: z.string().optional(),
		targetName: z.string().trim().max(100).optional(),
		schedule: z.enum(FEED_SCHEDULES).optional(),
		enabled: z.boolean().optional(),
		replaceSeries: z.boolean().optional(),
		/** A new key (replaces the saved one), null to clear it, absent to keep it (station API feeds only). */
		credential: FeedCredential.nullable().optional()
	})
	.strict();
