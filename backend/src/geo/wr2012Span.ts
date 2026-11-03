// WR2012's S-pan evaporation for a catchment, from its quaternaries
// (310_quaternary_evaporation.sql; docs/maps.md § WR2012 S-pan, docs/model.md
// §2.3a). WR2012 publishes, per quaternary catchment, its mean annual Symons
// pan evaporation (MAE, mm) and its evaporation zone, and for each zone the
// monthly distribution as a percentage of MAE. A quaternary's S-pan in month m
// is then
//
//   S[m] = MAE × pct[zone][m] ÷ 100      (mm, rounded to 0.1 mm)
//
// and a catchment's is the mean of its quaternaries' S-pan weighted by the
// share of the catchment's area that lies in each (unrounded, then rounded to
// 0.1 mm). Because each month is rounded, a row's 12 months can differ from
// MAE × (the zone's total ÷ 100) by up to 0.6 mm.
//
// The shares come from a grid laid over the boundary (SHARE_GRID cells along
// its longer side): each cell's part inside the boundary (geo/gridShares.ts,
// exact) goes to the quaternary its centre lies in, found by crossing each
// quaternary's rings along the cell row's centre line, so the work grows with
// rows × the quaternaries' vertices, never cells × vertices. A share is good
// to about one cell's width along each quaternary divide inside the
// catchment; a catchment inside one quaternary gets 100 % exactly.
//
// This module reads and computes; the route (evaporationRoutes.ts) writes the
// A-pan row, converted by the inverted equation the user picks (engine
// spanToApan.ts), only on the modeller's acceptance.
import { apanMonthlyFromSpan, SPAN_CONVERSIONS, type SpanConversionId, type SpanToApanFill } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { openRing } from './clip.js';
import type { Geometry, Position } from './geojson.js';
import { gridShares } from './gridShares.js';
import { bboxOf } from './loadQuaternaries.js';
import { SYNTHETIC_DATASET } from './quaternary.js';

/** Cells along the boundary's longer side for the area shares. */
export const SHARE_GRID = 128;
/** The most quaternaries one boundary is read against (a catchment, never a drainage region). */
export const SPAN_QUATERNARIES_MAX = 200;

const r1 = (x: number) => Math.round(x * 10) / 10;

/** A quaternary's 12 monthly S-pan (mm, Oct … Sep, 0.1 mm): MAE × pct ÷ 100. */
export function spanFromMae(maeMm: number, pct: readonly number[]): number[] {
	return pct.map((p) => r1((maeMm * p) / 100));
}

/** The part of the boundary that lies in each quaternary: area (km²) and share of the boundary's area (0–1). */
export interface QuaternaryShare {
	code: string;
	areaKm2: number;
	share: number;
}

export type SharesResult = { shares: QuaternaryShare[]; boundaryKm2: number } | { problem: string };

/** The x where each edge of the rings crosses the line y = lat, sorted (an even-odd count left of x says inside). */
function crossings(rings: readonly (readonly Position[])[], lat: number): number[] {
	const xs: number[] = [];
	for (const ring of rings) {
		const n = ring.length;
		for (let i = 0; i < n; i++) {
			const a = ring[i]!;
			const b = ring[(i + 1) % n]!;
			if (a[1] > lat !== b[1] > lat) xs.push(a[0] + ((lat - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
		}
	}
	return xs.sort((p, q) => p - q);
}

/** Whether x is inside by the even-odd rule over sorted crossings. */
function insideAt(xs: readonly number[], x: number): boolean {
	let lo = 0;
	let hi = xs.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (xs[mid]! < x) lo = mid + 1;
		else hi = mid;
	}
	return lo % 2 === 1;
}

/**
 * The share of `boundary`'s area in each of `quaternaries` (the first by code
 * wins a cell whose centre two claim), by the grid in the header. A quaternary
 * the boundary doesn't reach is left out; the shares add up to less than 1
 * where part of the boundary lies in none.
 */
export function quaternaryShares(boundary: Geometry, quaternaries: readonly { code: string; geometry: Geometry }[]): SharesResult {
	if (boundary.type !== 'Polygon' && boundary.type !== 'MultiPolygon') return { problem: 'the catchment boundary is not a polygon' };
	const [w, s, e, n] = bboxOf(boundary);
	const cellDeg = Math.max(e - w, n - s) / SHARE_GRID;
	if (!(cellDeg > 0)) return { problem: 'the catchment boundary has no area' };
	const grid = gridShares(boundary, cellDeg, (SHARE_GRID + 2) ** 2, undefined, 'share-grid');
	if ('problem' in grid) return { problem: grid.problem };
	const sorted = [...quaternaries].sort((a, b) => a.code.localeCompare(b.code));
	const parts = sorted.map((q) => ({
		code: q.code,
		box: bboxOf(q.geometry),
		polygons: (q.geometry.type === 'Polygon' ? [q.geometry.coordinates] : q.geometry.type === 'MultiPolygon' ? q.geometry.coordinates : []).map((rings) => rings.map(openRing))
	}));
	const areaM2 = new Map<string, number>();
	let boundaryM2 = 0;
	// Cells by row, so each quaternary's rings are crossed once per row.
	const byRow = new Map<number, typeof grid.cells>();
	for (const c of grid.cells) {
		const list = byRow.get(c.row);
		if (list) list.push(c);
		else byRow.set(c.row, [c]);
	}
	for (const [row, cells] of byRow) {
		const lat = (row + 0.5) * cellDeg;
		const lines = parts.filter((p) => p.box[1] <= lat && p.box[3] >= lat).map((p) => ({ code: p.code, box: p.box, xs: p.polygons.map((rings) => crossings(rings, lat)) }));
		for (const c of cells) {
			const m2 = c.share * c.cellM2;
			boundaryM2 += m2;
			const lon = (c.col + 0.5) * cellDeg;
			const hit = lines.find((l) => l.box[0] <= lon && l.box[2] >= lon && l.xs.some((xs) => insideAt(xs, lon)));
			if (hit) areaM2.set(hit.code, (areaM2.get(hit.code) ?? 0) + m2);
		}
	}
	if (!(boundaryM2 > 0)) return { problem: 'the catchment boundary has no area' };
	const shares = sorted
		.filter((q) => areaM2.has(q.code))
		.map((q) => ({ code: q.code, areaKm2: areaM2.get(q.code)! / 1e6, share: areaM2.get(q.code)! / boundaryM2 }));
	return { shares, boundaryKm2: boundaryM2 / 1e6 };
}

/**
 * The area-weighted mean S-pan of the rows that have one (mm, Oct … Sep,
 * 0.1 mm), from each row's unrounded MAE × pct ÷ 100; null with none.
 */
export function areaWeightedSpan(rows: readonly { share: number; maeMm: number | null; pct: readonly number[] | null }[]): number[] | null {
	const used = rows.filter((r) => r.maeMm !== null && r.pct !== null && r.share > 0);
	const total = used.reduce((a, r) => a + r.share, 0);
	if (!(total > 0)) return null;
	return Array.from({ length: 12 }, (_, m) => r1(used.reduce((a, r) => a + (r.share * r.maeMm! * r.pct![m]!) / 100, 0) / total));
}

/** One quaternary the boundary overlaps, with its evaporation when the dataset has it. */
export interface SpanQuaternary {
	code: string;
	dataset: string;
	synthetic: boolean;
	/** Share of the catchment's area inside it (0–1), and that area in km². */
	share: number;
	areaKm2: number;
	zone: string | null;
	maeMm: number | null;
	/** The zone's monthly distribution, % of MAE, Oct … Sep. */
	pct: number[] | null;
	/** MAE × pct ÷ 100, mm, Oct … Sep; null without the MAE and zone. */
	spanMm: number[] | null;
	source: string;
}

export interface Wr2012Span {
	quaternaries: SpanQuaternary[];
	/** Share of the catchment in quaternaries with WR2012 evaporation (0–1): the weighted mean is over that part. */
	coverage: number;
	/** The catchment's monthly S-pan, area-weighted; null when no quaternary it overlaps has evaporation. */
	spanMm: number[] | null;
	/** Why there is no S-pan, or null. */
	problem: string | null;
	/** Each S → A choice (engine SPAN_CONVERSIONS): its 12 A-pan months, or why it refuses. */
	conversions: { id: SpanConversionId; label: string; result: SpanToApanFill }[];
}

interface Row {
	code: string;
	dataset: string;
	geometry: Geometry;
	mae_mm: number | null;
	evap_zone: string | null;
	pct: number[] | null;
	source: string;
}

/** The S-pan proposal for a boundary from the loaded quaternaries (one query; the polygons are clipped here). */
export async function wr2012SpanFor(db: Db, boundary: Geometry): Promise<Wr2012Span> {
	const [w, s, e, n] = bboxOf(boundary);
	// The bounding-box index (quaternary_reference_bbox_idx) narrows it; the zone joins on the quaternary's own dataset.
	const { rows } = await db.query<Row>(
		`SELECT q.code, q.dataset, q.geometry, q.mae_mm, q.evap_zone, z.pct, q.source
		 FROM quaternary_reference q
		 LEFT JOIN quaternary_evap_zone z ON z.dataset = q.dataset AND z.zone = q.evap_zone
		 WHERE q.max_lon >= $1 AND q.min_lon <= $3 AND q.max_lat >= $2 AND q.min_lat <= $4
		 ORDER BY q.code
		 LIMIT $5`,
		[w, s, e, n, SPAN_QUATERNARIES_MAX + 1]
	);
	const empty = (problem: string): Wr2012Span => ({ quaternaries: [], coverage: 0, spanMm: null, problem, conversions: [] });
	if (rows.length > SPAN_QUATERNARIES_MAX) return empty(`the catchment boundary meets more than ${SPAN_QUATERNARIES_MAX} quaternaries; draw the catchment, not the region`);
	const got = quaternaryShares(boundary, rows);
	if ('problem' in got) return empty(got.problem);
	const byCode = new Map(rows.map((r) => [r.code, r]));
	const quaternaries: SpanQuaternary[] = got.shares.map((sh) => {
		const r = byCode.get(sh.code)!;
		const has = r.mae_mm !== null && r.pct !== null;
		return {
			code: r.code,
			dataset: r.dataset,
			synthetic: r.dataset === SYNTHETIC_DATASET,
			share: sh.share,
			areaKm2: sh.areaKm2,
			zone: has ? r.evap_zone : null,
			maeMm: has ? r.mae_mm : null,
			pct: has ? r.pct : null,
			spanMm: has ? spanFromMae(r.mae_mm!, r.pct!) : null,
			source: r.source
		};
	});
	const spanMm = areaWeightedSpan(quaternaries);
	const coverage = quaternaries.filter((q) => q.spanMm).reduce((a, q) => a + q.share, 0);
	const problem = !quaternaries.length
		? 'no loaded quaternary lies under the catchment boundary'
		: !spanMm
			? `the quaternar${quaternaries.length === 1 ? 'y' : 'ies'} under the catchment boundary (${quaternaries.map((q) => q.code).join(', ')}) ha${quaternaries.length === 1 ? 's' : 've'} no WR2012 evaporation loaded`
			: null;
	return {
		quaternaries,
		coverage,
		spanMm,
		problem,
		conversions: spanMm ? SPAN_CONVERSIONS.map((c) => ({ id: c.id, label: c.label, result: apanMonthlyFromSpan(spanMm, c.id) })) : []
	};
}

const pctText = (x: number) => `${Math.round(x * 100)} %`;

/** The quaternaries with evaporation, in words, for a revision: "Z01A 52 % (zone Z1, MAE 1500 mm), …", at most `max` named. */
export function quaternariesText(qs: readonly SpanQuaternary[], max = 8): string {
	const used = qs.filter((q) => q.spanMm).sort((a, b) => b.share - a.share || a.code.localeCompare(b.code));
	const named = used.slice(0, max).map((q) => `${q.code} ${pctText(q.share)} (zone ${q.zone}, MAE ${Math.round(q.maeMm!)} mm)`);
	const rest = used.length - named.length;
	return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}
