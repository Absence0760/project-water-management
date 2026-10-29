// The nearest DWS evaporation stations to the catchment boundary, proposed
// as the A-pan (issue #646 item 6; docs/maps.md § Evaporation stations,
// docs/model.md §2.3a). Like the nearest gauging station for flow
// (stations.ts): this module only reads and ranks; the route
// (evaporationRoutes.ts) writes, on the modeller's acceptance.
//
// The stations and their daily records come from
// evaporation_station_reference (274), which the operator loads
// (`pnpm import:evaporation-stations`). The repo ships an invented dataset
// (region Z, `dataset: 'synthetic'`); a proposal from it says so.
//
// What a station proposes:
//  * 12 monthly means (water-year order, Oct–Sep) of its record. A calendar
//    month of the record counts when at least MONTH_MIN_SHARE of its days
//    have a value; its total is then the mean of those days × the month's
//    days. Each mean is over the counted years, and needs MIN_YEARS of them:
//    with fewer the station proposes nothing (a mean of one or two years is
//    a year's weather, not the month's).
//  * A Class-A pan's means are the A-pan as they stand, and its daily record
//    the daily A-pan series (evap_apan_mm).
//  * A Symons pan's means are S-pan: they become A-pan only through the
//    inverted equation the user picks (engine spanToApan.ts), and its daily
//    record is never written as the A-pan series. The equations are fitted on
//    monthly totals; scaling each day by its month's A ÷ S would invent a
//    daily relation nobody fitted, so the Symons record reaches the model as
//    its 12 converted means only, which the engine spreads over each month's
//    days as it does any monthly A-pan.
import { apanMonthlyFromSpan, SPAN_CONVERSIONS, type SpanConversionId } from '@water-management/engine';
import { toEpochDay, fromEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';
import type { Geometry, Position } from './geojson.js';
import { pointInGeometry } from './geojson.js';
import { boxAround } from './stations.js';

export type PanType = 'class_a' | 'symons';
export const PAN_LABEL: Record<PanType, string> = { class_a: 'Class-A pan', symons: 'Symons pan' };

/** The label the committed fixture loads under; a proposal from it is marked synthetic. */
export const SYNTHETIC_EVAPORATION_STATIONS = 'synthetic';
/** The default and largest search radius from the boundary, km: evaporation stations are far sparser than gauges. */
export const EVAP_STATIONS_WITHIN_KM = 100;
export const EVAP_STATIONS_WITHIN_MAX_KM = 300;
/** The most stations one proposal lists. */
export const EVAP_STATIONS_LIMIT = 8;
/** A calendar month counts toward the means when at least this share of its days has a value. */
export const MONTH_MIN_SHARE = 0.8;
/** Each of the 12 means needs at least this many counted years. */
export const MIN_YEARS = 3;

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const r1 = (x: number) => Math.round(x * 10) / 10;
/** Calendar month (1–12) → water-year index (Oct = 0). */
const wyIndex = (month: number) => (month + 2) % 12;

export interface MonthlyMeans {
	/** Water-year order; null where the month has fewer than MIN_YEARS counted years. */
	meansMm: (number | null)[];
	/** Counted years per month. */
	years: number[];
	/** The first and last counted month (YYYY-MM), or null with none. */
	first: string | null;
	last: string | null;
	/** Why there are no 12 means, or null. */
	problem: string | null;
}

/** The record's 12 monthly means by the rule in the header. */
export function monthlyMeans(startDate: string, values: readonly (number | null)[]): MonthlyMeans {
	const start = toEpochDay(startDate);
	// year-month → [days with a value, sum, days in month]
	const months = new Map<string, { n: number; sum: number; days: number }>();
	for (let i = 0; i < values.length; i++) {
		const iso = fromEpochDay(start + i);
		const ym = iso.slice(0, 7);
		let m = months.get(ym);
		if (!m) {
			const y = Number(iso.slice(0, 4));
			const mo = Number(iso.slice(5, 7));
			m = { n: 0, sum: 0, days: new Date(Date.UTC(y, mo, 0)).getUTCDate() };
			months.set(ym, m);
		}
		const v = values[i];
		if (v !== null && v !== undefined) {
			m.n++;
			m.sum += v;
		}
	}
	const sums = new Array<number>(12).fill(0);
	const years = new Array<number>(12).fill(0);
	const counted: string[] = [];
	for (const [ym, m] of months) {
		if (m.n < MONTH_MIN_SHARE * m.days) continue;
		const w = wyIndex(Number(ym.slice(5, 7)));
		sums[w]! += (m.sum / m.n) * m.days;
		years[w]!++;
		counted.push(ym);
	}
	counted.sort();
	const meansMm = sums.map((s, w) => (years[w]! >= MIN_YEARS ? r1(s / years[w]!) : null));
	const short = MONTHS.filter((_, w) => years[w]! < MIN_YEARS);
	return {
		meansMm,
		years,
		first: counted[0] ?? null,
		last: counted.at(-1) ?? null,
		problem: short.length
			? `the record has fewer than ${MIN_YEARS} complete years of ${short.length === 12 ? 'any month' : short.join(', ')} (a month counts with ${Math.round(MONTH_MIN_SHARE * 100)} % of its days read)`
			: null
	};
}

/** How far a point is from a polygon boundary, km: 0 inside it, else to its nearest edge (a local flat frame, plenty within a few hundred km). */
export function distanceToBoundaryKm(p: Position, g: Geometry): number {
	if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return Number.POSITIVE_INFINITY;
	if (pointInGeometry(p, g)) return 0;
	const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180);
	const ky = 110.574;
	const xy = (q: Position) => [(q[0] - p[0]) * kx, (q[1] - p[1]) * ky] as const;
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
	let best = Number.POSITIVE_INFINITY;
	for (const poly of polys) {
		for (const ring of poly) {
			for (let i = 0; i + 1 < ring.length; i++) {
				const [ax, ay] = xy(ring[i] as Position);
				const [bx, by] = xy(ring[i + 1] as Position);
				const dx = bx - ax;
				const dy = by - ay;
				const len2 = dx * dx + dy * dy;
				const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
				best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
			}
		}
	}
	return best;
}

/** The lon/lat box of a polygon geometry. */
function bboxOf(g: Geometry): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
	const pts: Position[] = [];
	const walk = (c: unknown): void => {
		if (Array.isArray(c) && typeof c[0] === 'number') pts.push(c as Position);
		else if (Array.isArray(c)) c.forEach(walk);
	};
	walk(g.coordinates);
	return {
		minLon: Math.min(...pts.map((q) => q[0])),
		maxLon: Math.max(...pts.map((q) => q[0])),
		minLat: Math.min(...pts.map((q) => q[1])),
		maxLat: Math.max(...pts.map((q) => q[1]))
	};
}

export interface EvaporationStationRow {
	code: string;
	name: string;
	pan: PanType;
	lon: number;
	lat: number;
	startDate: string;
	length: number;
	daysWithValue: number;
	dataset: string;
	source: string;
}

export interface EvaporationStationCandidate extends EvaporationStationRow {
	distanceKm: number;
	recordStart: string;
	recordEnd: string;
	recordYears: number;
	/** Share of the record's days with a value, 0–1, two decimals. */
	completeness: number;
	synthetic: boolean;
}

/** The stations within `withinKm` of the boundary, nearest first (ties by code), at most `limit`. */
export function rankEvaporationStations(boundary: Geometry, rows: readonly EvaporationStationRow[], withinKm: number, limit = EVAP_STATIONS_LIMIT): EvaporationStationCandidate[] {
	return rows
		.map((s) => ({
			...s,
			distanceKm: Math.round(distanceToBoundaryKm([s.lon, s.lat], boundary) * 100) / 100,
			recordStart: s.startDate,
			recordEnd: fromEpochDay(toEpochDay(s.startDate) + s.length - 1),
			recordYears: r1(s.length / 365.25),
			completeness: Math.round((s.daysWithValue / s.length) * 100) / 100,
			synthetic: s.dataset === SYNTHETIC_EVAPORATION_STATIONS
		}))
		.filter((s) => s.distanceKm <= withinKm)
		.sort((a, b) => a.distanceKm - b.distanceKm || a.code.localeCompare(b.code))
		.slice(0, limit);
}

const ROW_COLUMNS = `code, name, pan, lon, lat, start_date::text AS "startDate", cardinality("values") AS length, days_with_value AS "daysWithValue", dataset, source`;

/** The stations near the boundary, ranked (the values arrays are not read). */
export async function nearestEvaporationStations(db: Db, boundary: Geometry, withinKm: number): Promise<EvaporationStationCandidate[]> {
	const b = bboxOf(boundary);
	const lo = boxAround([b.minLon, b.minLat], withinKm);
	const hi = boxAround([b.maxLon, b.maxLat], withinKm);
	const { rows } = await db.query<EvaporationStationRow>(
		`SELECT ${ROW_COLUMNS} FROM evaporation_station_reference WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4`,
		[lo.minLat, hi.maxLat, lo.minLon, hi.maxLon]
	);
	return rankEvaporationStations(boundary, rows, withinKm);
}

/** One station with its daily record, or null. */
export async function evaporationStation(db: Db, code: string): Promise<(EvaporationStationRow & { values: (number | null)[] }) | null> {
	const { rows } = await db.query<EvaporationStationRow & { values: (number | null)[] }>(
		`SELECT ${ROW_COLUMNS}, "values" FROM evaporation_station_reference WHERE code = $1`,
		[code]
	);
	return rows[0] ?? null;
}

/** The daily records of some stations, by code (one query). */
export async function stationValues(db: Db, codes: readonly string[]): Promise<Map<string, (number | null)[]>> {
	if (!codes.length) return new Map();
	const { rows } = await db.query<{ code: string; values: (number | null)[] }>(`SELECT code, "values" FROM evaporation_station_reference WHERE code = ANY($1::text[])`, [codes]);
	return new Map(rows.map((r) => [r.code, r.values]));
}

/** Which station datasets are loaded, and how many stations each. */
export async function evaporationStationDatasets(db: Db): Promise<{ dataset: string; count: number }[]> {
	const { rows } = await db.query<{ dataset: string; count: number }>(
		'SELECT dataset, count(*)::integer AS count FROM evaporation_station_reference GROUP BY dataset ORDER BY dataset'
	);
	return rows;
}

export type StationApan =
	| { ok: true; apanMm: number[]; spanMm: number[] | null; conversion: SpanConversionId | null; note: string | null }
	| { ok: false; reason: string };

/**
 * The 12 A-pan means a station gives: a Class-A pan's means as they stand
 * (no conversion may be named), a Symons pan's through the named inverted
 * equation (one must be).
 */
export function stationApan(pan: PanType, means: MonthlyMeans, conversion: SpanConversionId | null): StationApan {
	if (means.problem) return { ok: false, reason: means.problem };
	const row = means.meansMm as number[];
	if (pan === 'class_a') {
		if (conversion) return { ok: false, reason: 'a Class-A pan’s record is the A-pan already: no conversion applies' };
		return { ok: true, apanMm: row, spanMm: null, conversion: null, note: null };
	}
	if (!conversion) return { ok: false, reason: 'a Symons pan reads S-pan, not A-pan: pick the equation that converts it' };
	const fill = apanMonthlyFromSpan(row, conversion);
	if (!fill.ok) return { ok: false, reason: fill.reason };
	return { ok: true, apanMm: fill.values, spanMm: row, conversion, note: fill.note };
}

/** Each S → A choice for a Symons station's means: its values, or why it refuses. */
export function conversionsFor(means: MonthlyMeans): { id: SpanConversionId; label: string; result: StationApan }[] {
	return SPAN_CONVERSIONS.map((c) => ({ id: c.id, label: c.label, result: stationApan('symons', means, c.id) }));
}

/** The daily record trimmed to its first and last day with a value (the stored record already is). */
export function trimmedRecord(startDate: string, values: readonly (number | null)[]): { startDate: string; values: (number | null)[] } {
	let a = 0;
	let b = values.length - 1;
	while (a <= b && values[a] == null) a++;
	while (b >= a && values[b] == null) b--;
	return { startDate: fromEpochDay(toEpochDay(startDate) + a), values: values.slice(a, b + 1).map((v) => v ?? null) };
}
