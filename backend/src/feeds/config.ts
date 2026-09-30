// What a data feed is (018_feeds.sql, roadmap WP-2.10): a source, where in
// that source to read (grid cells, a box of them, or a gauge station), and which of the
// project's series the values merge into. Pure: the routes, the handlers and
// the fetcher Lambda all validate with these schemas.
import type { SeriesKind } from '@water-management/engine';
// The subpath, not the package root: the fetcher Lambda reaches this module (lambda-fetcher.test.ts).
import { CHIRPS_V3_RNL, CHIRPS_V3_SAT, type SeriesProvenance } from '@water-management/engine/provenance';
import { z } from 'zod';
import { SeriesStartDate } from '../series/limits.js';

export const FEED_SOURCES = ['chirps', 'chirps_gefs', 'dws'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];

export const FEED_SCHEDULES = ['daily', 'hourly'] as const;
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
	// Verified DWS flow lags by months (docs/architecture.md § Data feeds).
	dws: { label: 'DWS gauge flow', kinds: ['flow_observed_m3s', 'flow_reference_m3s', 'flow_logger_m3s'], unit: 'm³/s', staleAfterDays: 240, staleAlertDays: 30 }
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
 * (ERA5 disaggregation, from 1981, final only, 5–6 days behind). They share
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
/** The most cells a bounding box may cover, and the most grid rows (a fetch reads one strip per row per day, sources/tiff.ts). */
export const BBOX_MAX_CELLS = 100;
export const BBOX_MAX_ROWS = 25;
export const BBOX_LIMIT_MESSAGE = `a bounding box covers at most ${BBOX_MAX_CELLS} of the 0.05° grid cells in at most ${BBOX_MAX_ROWS} rows (about 0.5° × 0.5°, and at most 1.25° from south to north)`;

const Cell = z.object({ lat: Lat, lon: Lon, weight: z.number().finite().positive().max(1000).default(1) }).strict();
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
 * cells (`cells`, 1–25 points, each naming the cell that holds it), or of
 * the cells a bounding box overlaps (`bbox`, gridCells). Exactly one of the two.
 */
export const GridConfig = z
	.object({
		cells: z.array(Cell).min(1).max(25).optional(),
		bbox: Bbox.optional(),
		/** First day to fetch when the feed has no data yet (default: 60 days back), and never fetched before. */
		startDate: SeriesStartDate.refine((d) => d >= CHIRPS_FIRST_DAY, `CHIRPS begins on ${CHIRPS_FIRST_DAY}`).optional(),
		staleAfterDays: z.number().int().min(-15).max(3650).optional(),
		/** CHIRPS only: which v3 daily product (absent = `sat`). FeedInput checks it against the source and the start date. */
		product: z.enum(CHIRPS_DAILY_PRODUCTS).optional()
	})
	.strict()
	.superRefine((g, ctx) => {
		if ((g.cells === undefined) === (g.bbox === undefined)) {
			ctx.addIssue({ code: 'custom', path: ['cells'], message: 'give either grid cells or a bounding box (bbox), not both' });
			return;
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
export type DwsConfig = z.output<typeof DwsConfig>;
export type FeedConfig = GridConfig | DwsConfig;

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
	const station = 'station' in config ? `, station ${config.station}` : '';
	return `${SOURCES[source].label} data feed${station}`;
}

/** The config schema for a source. */
export const configSchema = (source: FeedSource) => (source === 'dws' ? DwsConfig : GridConfig);

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
		replaceSeries: z.boolean().default(false)
	})
	.strict()
	.transform((v, ctx) => {
		const config = configSchema(v.source).safeParse(v.config);
		if (!config.success) {
			for (const issue of config.error.issues) ctx.addIssue({ ...issue, path: ['config', ...issue.path] } as never);
			return z.NEVER;
		}
		if (v.source !== 'dws') {
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
					message: `CHIRPS v3’s ${grid.product ?? 'sat'} daily product begins on ${first}; for earlier days use the rnl product for the whole record`
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

/** PATCH: any of the fields; the route merges them over the saved feed and parses the whole with FeedInput. */
export const FeedPatch = z
	.object({
		source: z.enum(FEED_SOURCES).optional(),
		config: z.unknown().optional(),
		targetKind: z.string().optional(),
		targetName: z.string().trim().max(100).optional(),
		schedule: z.enum(FEED_SCHEDULES).optional(),
		enabled: z.boolean().optional(),
		replaceSeries: z.boolean().optional()
	})
	.strict();
