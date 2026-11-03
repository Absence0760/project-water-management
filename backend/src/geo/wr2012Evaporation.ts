// WR2012's monthly evaporation for a catchment, from the quaternaries its
// boundary overlaps (310_quaternary_evaporation.sql; docs/maps.md § WR2012
// evaporation by quaternary, docs/model.md §2.3a).
//
// The values are WR2012's own WRSM2000 (Pitman) network configurations': per
// quaternary, the runoff module's 12 monthly Symons-pan (S-pan) depths and the
// irrigation module's 12 monthly Class-A pan (A-pan) depths, mm, October
// first (quaternary_evaporation; loadQuaternaryEvaporation.ts). The A-pan is
// what the model reads (settings.apanMm), so it is proposed as it stands: no
// S → A conversion. The S-pan is shown beside it for the hydrologist, with
// WR2012's MAE and evaporation zone (quaternary_reference) as context.
//
// A catchment over several quaternaries takes each row's mean weighted by the
// share of its area in each, over the quaternaries that have that row (then
// rounded to 0.1 mm); the part with none is reported, not filled. A
// quaternary with S-pan but no irrigation module proposes no A-pan: its S-pan
// can be converted, with the equation the user picks, through Demand's
// "Typed or pasted S-pan, converted" (the route says so), never silently.
//
// The shares come from a grid laid over the boundary (SHARE_GRID cells along
// its longer side): each cell's part inside the boundary (geo/gridShares.ts,
// exact) goes to the quaternary its centre lies in, found by crossing each
// quaternary's rings along the cell row's centre line, so the work grows with
// rows × the quaternaries' vertices, never cells × vertices. A share is good
// to about one cell's width along each quaternary divide inside the
// catchment; a catchment inside one quaternary gets 100 % exactly.
import type { Db } from '../db/tx.js';
import { openRing } from './clip.js';
import type { Geometry, Position } from './geojson.js';
import { gridShares } from './gridShares.js';
import { bboxOf } from './loadQuaternaries.js';
import { SYNTHETIC_DATASET } from './quaternary.js';

/** Cells along the boundary's longer side for the area shares. */
export const SHARE_GRID = 128;
/** The most quaternaries one boundary is read against (a catchment, never a drainage region). */
export const EVAPORATION_QUATERNARIES_MAX = 200;

const r1 = (x: number) => Math.round(x * 10) / 10;

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

/** The area-weighted mean of the rows given (mm, Oct … Sep, 0.1 mm), over the rows that have one; null with none. */
export function areaWeighted(rows: readonly { share: number; row: readonly number[] | null }[]): number[] | null {
	const used = rows.filter((r) => r.row !== null && r.share > 0);
	const total = used.reduce((a, r) => a + r.share, 0);
	if (!(total > 0)) return null;
	return Array.from({ length: 12 }, (_, m) => r1(used.reduce((a, r) => a + r.share * r.row![m]!, 0) / total));
}

/** One WRSM2000 module row's provenance: how many modules named the quaternary, how many agree with it, the others' totals. */
export interface ModuleAgreement {
	modules: number;
	agree: number;
	othersMm: number[];
}

/** One quaternary the boundary overlaps, with its WR2012 evaporation when loaded. */
export interface EvaporationQuaternary {
	code: string;
	/** The outline's dataset, and the evaporation's (null when none is loaded for the code). */
	dataset: string;
	evaporationDataset: string | null;
	synthetic: boolean;
	/** Share of the catchment's area inside it (0–1), and that area in km². */
	share: number;
	areaKm2: number;
	/** WR2012's evaporation zone and MAE (mm a year, S-pan), context from the quaternary spreadsheets; null if not loaded. */
	zone: string | null;
	maeMm: number | null;
	/** Monthly S-pan (runoff module) and A-pan (irrigation module), mm, Oct … Sep; null where the configurations have none. */
	spanMm: number[] | null;
	apanMm: number[] | null;
	span: ModuleAgreement | null;
	apan: ModuleAgreement | null;
	/** How many module files the rows kept came from. */
	files: number;
	/** Some module named the quaternary with another row than the one kept. */
	disagree: boolean;
	/** Why it proposes no A-pan, or null. */
	why: string | null;
	source: string | null;
}

export interface Wr2012Evaporation {
	quaternaries: EvaporationQuaternary[];
	/** The catchment's monthly rows, area-weighted over the quaternaries that have each; null with none. */
	spanMm: number[] | null;
	apanMm: number[] | null;
	/** Share of the catchment in quaternaries with each row (0–1): each mean is over that part. */
	spanCoverage: number;
	apanCoverage: number;
	/** Why no A-pan can be proposed, or null. */
	problem: string | null;
}

interface Row {
	code: string;
	dataset: string;
	geometry: Geometry;
	mae_mm: number | null;
	evap_zone: string | null;
	ev_dataset: string | null;
	span_mm: number[] | null;
	apan_mm: number[] | null;
	span_modules: number | null;
	span_agree: number | null;
	span_others_mm: number[] | null;
	span_files: string[] | null;
	apan_modules: number | null;
	apan_agree: number | null;
	apan_others_mm: number[] | null;
	apan_files: string[] | null;
	ev_source: string | null;
}

/** The proposal for a boundary from the loaded quaternaries and their evaporation (one query; the polygons are clipped here). */
export async function wr2012EvaporationFor(db: Db, boundary: Geometry): Promise<Wr2012Evaporation> {
	const [w, s, e, n] = bboxOf(boundary);
	// The bounding-box index narrows the outlines; each code's evaporation is the most recently loaded dataset's.
	const { rows } = await db.query<Row>(
		`SELECT q.code, q.dataset, q.geometry, q.mae_mm, q.evap_zone,
			ev.dataset AS ev_dataset, ev.span_mm, ev.apan_mm, ev.span_modules, ev.span_agree, ev.span_others_mm, ev.span_files,
			ev.apan_modules, ev.apan_agree, ev.apan_others_mm, ev.apan_files, ev.source AS ev_source
		 FROM quaternary_reference q
		 LEFT JOIN LATERAL (
			SELECT * FROM quaternary_evaporation e WHERE e.code = q.code ORDER BY e.loaded_at DESC, e.dataset LIMIT 1
		 ) ev ON true
		 WHERE q.max_lon >= $1 AND q.min_lon <= $3 AND q.max_lat >= $2 AND q.min_lat <= $4
		 ORDER BY q.code
		 LIMIT $5`,
		[w, s, e, n, EVAPORATION_QUATERNARIES_MAX + 1]
	);
	const empty = (problem: string): Wr2012Evaporation => ({ quaternaries: [], spanMm: null, apanMm: null, spanCoverage: 0, apanCoverage: 0, problem });
	if (rows.length > EVAPORATION_QUATERNARIES_MAX) return empty(`the catchment boundary meets more than ${EVAPORATION_QUATERNARIES_MAX} quaternaries; draw the catchment, not the region`);
	const got = quaternaryShares(boundary, rows);
	if ('problem' in got) return empty(got.problem);
	const byCode = new Map(rows.map((r) => [r.code, r]));
	const agreement = (modules: number | null, agree: number | null, others: number[] | null): ModuleAgreement | null =>
		modules ? { modules, agree: agree ?? modules, othersMm: others ?? [] } : null;
	const quaternaries: EvaporationQuaternary[] = got.shares.map((sh) => {
		const r = byCode.get(sh.code)!;
		const span = r.span_mm ? agreement(r.span_modules, r.span_agree, r.span_others_mm) : null;
		const apan = r.apan_mm ? agreement(r.apan_modules, r.apan_agree, r.apan_others_mm) : null;
		return {
			code: r.code,
			dataset: r.dataset,
			evaporationDataset: r.ev_dataset,
			synthetic: r.dataset === SYNTHETIC_DATASET || r.ev_dataset === SYNTHETIC_DATASET,
			share: sh.share,
			areaKm2: sh.areaKm2,
			zone: r.evap_zone,
			maeMm: r.mae_mm,
			spanMm: r.span_mm,
			apanMm: r.apan_mm,
			span,
			apan,
			files: (r.span_mm ? (r.span_files?.length ?? 0) : 0) + (r.apan_mm ? (r.apan_files?.length ?? 0) : 0),
			disagree: !!(span && span.agree < span.modules) || !!(apan && apan.agree < apan.modules),
			why: r.apan_mm ? null : r.span_mm ? 'no irrigation module gives its A-pan, only S-pan' : 'no WR2012 evaporation loaded',
			source: r.ev_source
		};
	});
	const spanMm = areaWeighted(quaternaries.map((q) => ({ share: q.share, row: q.spanMm })));
	const apanMm = areaWeighted(quaternaries.map((q) => ({ share: q.share, row: q.apanMm })));
	const cover = (pick: (q: EvaporationQuaternary) => unknown) => quaternaries.filter(pick).reduce((a, q) => a + q.share, 0);
	const spanOnly = quaternaries.filter((q) => q.spanMm && !q.apanMm).map((q) => q.code);
	const problem = !quaternaries.length
		? 'no loaded quaternary lies under the catchment boundary'
		: apanMm
			? null
			: spanOnly.length
				? `no irrigation module gives the A-pan of ${spanOnly.join(', ')}, only its S-pan: convert that with the equation you pick under “Typed or pasted S-pan, converted”`
				: `the quaternar${quaternaries.length === 1 ? 'y' : 'ies'} under the catchment boundary (${quaternaries.map((q) => q.code).join(', ')}) ha${quaternaries.length === 1 ? 's' : 've'} no WR2012 evaporation loaded`;
	return { quaternaries, spanMm, apanMm, spanCoverage: cover((q) => q.spanMm), apanCoverage: cover((q) => q.apanMm), problem };
}

const pctText = (x: number) => `${Math.round(x * 100)} %`;

/** The quaternaries with A-pan, in words, for a revision: "Z01A 75 %, Z01B 25 % (modules disagree)", at most `max` named. */
export function quaternariesText(qs: readonly EvaporationQuaternary[], max = 8): string {
	const used = qs.filter((q) => q.apanMm).sort((a, b) => b.share - a.share || a.code.localeCompare(b.code));
	const named = used.slice(0, max).map((q) => `${q.code} ${pctText(q.share)}${q.apan && q.apan.agree < q.apan.modules ? ` (${q.apan.agree} of ${q.apan.modules} irrigation modules agree)` : ''}`);
	const rest = used.length - named.length;
	return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}
