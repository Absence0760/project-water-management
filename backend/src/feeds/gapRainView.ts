// The gap-filling products beside CHIRPS for the Data tab (issue #604 R4-E,
// docs/api.md § Data feeds, docs/ui.md § Data): ERA5-Land and IMERG Late over
// one CHIRPS feed's cells, read from the shared cell cache as a run reads
// them (runs/gapRainInput.ts: each 0.05° cell takes the 0.1° cell holding
// it, with its own weight), with each IMERG day's version. Read only: the
// cache fills on the fetch of the CHIRPS feed whose cells the runs read
// (feeds/gapRainFill.ts), and only while settings.gapRain asks for a
// product, so another feed's cells may hold none, and say so (`held`).
//
// Bounded like the API's other series reads: at most GAP_VIEW_MAX_DAYS (ten
// years) a request, by default the last ten years of the record (`from` /
// `to` reach further back), over the feed's cells, which its config already
// caps at BBOX_MAX_CELLS (feeds/config.ts; checked again here). Without it a
// record back to 1950 sent some 27,000 days a product in one response.
// `fill` is what the runs' feed's latest fetch made of each product
// (last_meta, 254_feed_gap_fill_outcome), so a failed fill says so instead of
// reading as "nothing held yet".
//
// The double mass of catchment rain against each product (`doubleMass`) is
// not bound by that window: a break shows only over the whole overlapping
// record, so the server computes it there, with the engine's own doubleMass
// (the product in CHIRPS' place, as a run's summary.gapRain.products[]
// .doubleMass is made, engine gapRain.ts) and the project's zero-rain and
// data-quality settings as a run resolves them. What reaches the client is
// its water-year (Oct–Sep) totals, segments and breaks: about one row a year,
// never the days. Each product is read once, over the window and the
// catchment record's span together, as a run reads it (gapRainInputs reads
// the whole record too).
import { fromEpochDay, isIsoDate, toEpochDay } from '@water-management/engine/calendar';
import { doubleMass, resolveDataQuality, resolveGapRain, resolveZeroRain, type DoubleMass, type GapRainSettings } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { gapRainFeed, gapRainRecordStart, GAP_PRODUCT_FIRST_DAY } from '../runs/gapRainInput.js';
import { BBOX_MAX_CELLS, gridCells, type GridConfig } from './config.js';
import { productVersions, readProductSeries } from './fromMirror.js';

/** One CHIRPS feed the view can read the products over: the outlet's, or a land unit's. */
export interface GapRainFeedOption {
	id: string;
	/** The series it writes: its name, and its id (the Data tab draws its CHIRPS from it). */
	seriesId: string;
	seriesName: string;
	/** The land unit whose rain it is (a unit's own CHIRPS, issue #482); null for the outlet's. */
	nodeId: string | null;
	nodeName: string | null;
	/** The feed whose cells the runs read the products over (runs/gapRainInput.ts gapRainFeed). */
	runsRead: boolean;
}

/** The widest window one request reads: ten years (FARM_SERIES_MAX_DAYS's span), about 3,650 values a product. */
export const GAP_VIEW_MAX_DAYS = 3653;

/** What the runs' feed's latest fetch made of a product (last_meta.gapEra5l / gapImergLate, feeds/gapRainFill.ts). */
export interface GapFillState {
	status: 'ok' | 'not_ready' | 'failed';
	/** For 'failed': the copy's files not in the form we read, the copy not answering usefully, or the cell cache refusing the values. */
	error: 'format' | 'unavailable' | 'refused' | null;
	/** When that fetch ran (data_feed.last_attempt_at). */
	at: string | null;
}

const FILL_STATE = /^(ok|not_ready|failed:(format|unavailable|refused))$/;
function fillState(v: unknown, at: string | null): GapFillState | null {
	if (typeof v !== 'string' || !FILL_STATE.test(v)) return null;
	const [status, error] = v.split(':') as [GapFillState['status'], GapFillState['error'] | undefined];
	return { status, error: error ?? null, at };
}

export interface GapRainProducts {
	/** settings.gapRain as a run takes it; null for CHIRPS alone. */
	gapRain: GapRainSettings | null;
	feeds: GapRainFeedOption[];
	/** The feed read (the one asked for, else the one the runs read, else the first); null without a CHIRPS feed. */
	feed: string | null;
	/** The days read: `from`–`to`, by default the last ten years of the record to today; never more than GAP_VIEW_MAX_DAYS. */
	window: { start: string; end: string } | null;
	/** The record's whole span: from the first outlet catchment rain or CHIRPS day to today; null with no feed or record. */
	record: { start: string; end: string } | null;
	/** What the runs' feed's latest fetch made of each product; null where it never filled it (or there is no such feed). */
	fill: { era5l: GapFillState | null; imergLate: GapFillState | null };
	/** Each product's days over the window, null on a day the cache holds none; `held` = days with a value. */
	era5l: { startDate: string; values: (number | null)[]; held: number } | null;
	imergLate: { startDate: string; values: (number | null)[]; versions: (string | null)[]; held: number } | null;
	/**
	 * The double mass of the outlet catchment rain (the one a run reads) against
	 * each product over the whole record both hold, not only `window`; a product
	 * with too few judged water years for the check is null. Null without a
	 * catchment rain record.
	 */
	doubleMass: { era5l: DoubleMass | null; imergLate: DoubleMass | null } | null;
}

/** The days of `s` from `start` to `end` (both inside it, or clamped to it). */
function slice(s: { startDate: string; values: (number | null)[] }, start: string, end: string): { startDate: string; values: (number | null)[] } {
	const s0 = toEpochDay(s.startDate);
	const a = Math.max(0, toEpochDay(start) - s0);
	const b = Math.min(s.values.length, toEpochDay(end) - s0 + 1);
	return { startDate: fromEpochDay(s0 + a), values: b > a ? s.values.slice(a, b) : [] };
}

/** Leading and trailing blank days dropped (a product whose cache holds nothing is null). */
function trim<T extends { startDate: string; values: (number | null)[] }>(s: T, extra?: (from: number, to: number) => Partial<T>): (T & { held: number }) | null {
	const first = s.values.findIndex((v) => v !== null);
	if (first < 0) return null;
	let last = s.values.length - 1;
	while (s.values[last] === null) last--;
	const values = s.values.slice(first, last + 1);
	return { ...s, ...extra?.(first, last + 1), startDate: fromEpochDay(toEpochDay(s.startDate) + first), values, held: values.filter((v) => v !== null).length };
}

/** The window asked for: valid dates, `from` ≤ `to`, at most GAP_VIEW_MAX_DAYS; a 400 otherwise. */
export function viewWindowQuery(from: string | null, to: string | null): { from: string | null; to: string | null } {
	for (const [k, v] of [['from', from], ['to', to]] as const) if (v !== null && !isIsoDate(v)) throw new ApiError(400, `${k} must be a date, YYYY-MM-DD`);
	if (from && to) {
		if (from > to) throw new ApiError(400, '`from` must not be after `to`');
		if (toEpochDay(to) - toEpochDay(from) + 1 > GAP_VIEW_MAX_DAYS) throw new ApiError(400, `at most ${GAP_VIEW_MAX_DAYS} days at a time; narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD`);
	}
	return { from, to };
}

export async function gapRainProducts(
	db: Db,
	projectId: string,
	feedId: string | null,
	today = new Date().toISOString().slice(0, 10),
	ask: { from?: string | null; to?: string | null } = {}
): Promise<GapRainProducts> {
	const { rows: settings } = await db.query<{ gapRain: unknown; zeroRain: unknown; dq: unknown }>(
		`SELECT settings->'gapRain' AS "gapRain", settings->'zeroRainRuns' AS "zeroRain", settings->'dataQuality' AS dq FROM project WHERE id = $1`,
		[projectId]
	);
	const gapRain = resolveGapRain(settings[0]?.gapRain ?? null, []);
	const { rows } = await db.query<{ id: string; config: GridConfig; seriesId: string; seriesName: string; nodeId: string | null; nodeName: string | null }>(
		`SELECT f.id, f.config, t.id AS "seriesId", t.name AS "seriesName", t.site_node_id AS "nodeId", n.name AS "nodeName"
		 FROM data_feed f JOIN time_series t ON t.project_id = f.project_id AND t.feed_id = f.id
		 LEFT JOIN node n ON n.project_id = t.project_id AND n.id = t.site_node_id
		 WHERE f.project_id = $1 AND f.source = 'chirps' AND t.kind = 'rain_chirps_mm'
		 ORDER BY (t.site_node_id IS NULL) DESC, n.name COLLATE "C", t.name COLLATE "C"`,
		[projectId]
	);
	const { rows: read } = await db.query<{ id: string }>(
		`SELECT id FROM time_series WHERE project_id = $1 AND site_node_id IS NULL AND kind = 'rain_chirps_mm' ORDER BY name COLLATE "C" LIMIT 1`,
		[projectId]
	);
	const runs = await gapRainFeed(db, projectId, read[0]?.id ?? null);
	const { rows: meta } = runs
		? await db.query<{ era5l: unknown; imerg: unknown; at: string | null }>(
				`SELECT last_meta->'gapEra5l' AS era5l, last_meta->'gapImergLate' AS imerg, to_char(last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
				 FROM data_feed WHERE project_id = $1 AND id = $2`,
				[projectId, runs.feedId]
			)
		: { rows: [] };
	const fill = { era5l: fillState(meta[0]?.era5l, meta[0]?.at ?? null), imergLate: fillState(meta[0]?.imerg, meta[0]?.at ?? null) };
	const feeds: GapRainFeedOption[] = rows.map((r) => ({ id: r.id, seriesId: r.seriesId, seriesName: r.seriesName, nodeId: r.nodeId, nodeName: r.nodeName, runsRead: r.id === runs?.feedId }));
	const pick = rows.find((r) => r.id === feedId) ?? rows.find((r) => r.id === runs?.feedId) ?? rows[0] ?? null;
	const empty = { gapRain, feeds, feed: pick?.id ?? null, window: null, record: null, fill, era5l: null, imergLate: null, doubleMass: null };
	const recordStart = pick ? await gapRainRecordStart(db, projectId) : null;
	if (!pick || !recordStart || recordStart > today) return empty;
	const cells = gridCells(pick.config);
	// The config's own limit (FeedInput): a row that somehow holds more is refused, never read whole.
	if (cells.length > BBOX_MAX_CELLS) throw new ApiError(409, `the feed has more than ${BBOX_MAX_CELLS} cells; save it again`);
	const record = { start: recordStart, end: today };
	const end = ask.to && ask.to < today ? ask.to : today;
	const start = ask.from ?? fromEpochDay(Math.max(toEpochDay(recordStart), toEpochDay(end) - GAP_VIEW_MAX_DAYS + 1));
	if (toEpochDay(end) - toEpochDay(start) + 1 > GAP_VIEW_MAX_DAYS) throw new ApiError(400, `at most ${GAP_VIEW_MAX_DAYS} days at a time; narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD`);
	if (start > end) return { ...empty, record };
	// The outlet catchment rain a run reads (runs/execute.ts: the first by name), for the double mass over the whole record.
	const { rows: rain } = await db.query<{ startDate: string; values: (number | null)[] }>(
		`SELECT to_char(start_date, 'YYYY-MM-DD') AS "startDate", "values" FROM time_series
		 WHERE project_id = $1 AND site_node_id IS NULL AND kind = 'rain_catchment_mm' ORDER BY name COLLATE "C" LIMIT 1`,
		[projectId]
	);
	const catchment = rain[0] && rain[0].values.length ? rain[0] : null;
	const catchmentEnd = catchment ? fromEpochDay(toEpochDay(catchment.startDate) + catchment.values.length - 1) : null;
	const zeroRain = resolveZeroRain(settings[0]?.zeroRain ?? null, []);
	const dq = resolveDataQuality(settings[0]?.dq ?? null);
	const later = (a: string, b: string) => (a > b ? a : b);
	const earlier = (a: string, b: string) => (a < b ? a : b);
	// One read a product: the daily window, widened to the catchment record's span (the double mass's days); the
	// response carries only the window's days, and the double mass's water-year totals.
	const readProduct = async (product: 'era5l' | 'imerg_late') => {
		const first = GAP_PRODUCT_FIRST_DAY[product];
		const day = { start: later(start, first), end };
		const dm = catchment && catchmentEnd ? { start: later(catchment.startDate, first), end: earlier(catchmentEnd, today) } : null;
		const span = dm && dm.start <= dm.end ? (day.start <= day.end ? { start: earlier(day.start, dm.start), end: later(day.end, dm.end) } : dm) : day;
		if (span.start > span.end) return { day, daily: { startDate: start, values: [] as (number | null)[] }, mass: null };
		const s = await readProductSeries(db, product, cells, span);
		const daily = day.start <= day.end ? slice(s, day.start, day.end) : { startDate: start, values: [] };
		const mass = catchment && dm && dm.start <= dm.end ? doubleMass({ rain_catchment_mm: catchment, rain_chirps_mm: slice(s, dm.start, dm.end) }, zeroRain, dq) : null;
		return { day, daily, mass };
	};
	const era = await readProduct('era5l');
	const imerg = await readProduct('imerg_late');
	const versions = imerg.day.start <= imerg.day.end ? await productVersions(db, 'imerg_late', imerg.day) : [];
	return {
		...empty,
		window: { start, end },
		record,
		era5l: trim({ startDate: era.daily.startDate, values: era.daily.values }),
		imergLate: trim({ startDate: imerg.daily.startDate, values: imerg.daily.values, versions }, (a, b) => ({ versions: versions.slice(a, b) })),
		doubleMass: catchment ? { era5l: era.mass, imergLate: imerg.mass } : null
	};
}
