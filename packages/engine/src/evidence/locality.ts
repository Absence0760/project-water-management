// § 1's locality map (report format evidence-12, issue #326 A5): which of the
// project's map features the figure draws, as what, and under which label,
// frozen into the report so an evidence pack's manifest carries what the
// figure is drawn from and the SHA-256 of the SVG (docs/evidence-pack.md §
// The locality map). The drawing itself is geo/localityMap.ts.
//
// Privacy: another unit's parcel or dam is drawn neutrally, with no name and
// no node: the figure shows where the applicant's unit is, not whose land is
// beside it. Only the applicant's own units, gauges and EWR sites are named.
import { boxOf, LOCALITY_LAYER_ORDER, LOCALITY_MAP_VERSION, localityMapSvg, localProjection, type LocalityFeature, type LocalityGeometry, type LocalityLayer, type LocalityMapData, type LocalityPosition, type LocalitySource } from '../geo/localityMap';
import type { RunInputsSnapshot } from '../compare';
import type { EvidenceMapFeatureInput, EvidenceReport } from './types';

/** Coordinates kept in the report: 6 decimals of a degree, about 0.1 m. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Douglas–Peucker tolerance as a share of the extent's larger side: about a third of a pixel at the figure's 640 px. */
export const LOCALITY_SIMPLIFY_SHARE = 1 / 2000;

const isSome = <T>(v: T | null): v is T => v !== null;

const finitePair = (p: unknown): p is LocalityPosition => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Douglas–Peucker over projected points: the indices kept (first and last always). */
function simplifyIndices(xy: readonly [number, number][], tol: number): number[] {
	const n = xy.length;
	if (n <= 2 || tol <= 0) return xy.map((_, i) => i);
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const [ax, ay] = xy[a]!;
		const [bx, by] = xy[b]!;
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let worst = -1;
		let dmax = 0;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = xy[i]!;
			let d: number;
			if (len2 === 0) d = Math.hypot(px - ax, py - ay);
			else {
				const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
				d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
			}
			if (d > dmax) {
				dmax = d;
				worst = i;
			}
		}
		if (worst >= 0 && dmax > tol) {
			keep[worst] = 1;
			stack.push([a, worst], [worst, b]);
		}
	}
	const out: number[] = [];
	keep.forEach((k, i) => k && out.push(i));
	return out;
}

/** Rounded, with repeats dropped. */
function tidy(ps: readonly LocalityPosition[]): LocalityPosition[] {
	const out: LocalityPosition[] = [];
	for (const p of ps) {
		const q: LocalityPosition = [round6(p[0]), round6(p[1])];
		const last = out.at(-1);
		if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
	}
	return out;
}

/**
 * A feature's geometry as the report keeps it: rounded to 6 decimals and
 * simplified to the figure's resolution; null when nothing drawable is left.
 */
export function figureGeometry(g: LocalityGeometry, project: (p: LocalityPosition) => [number, number], tol: number): LocalityGeometry | null {
	const path = (ps: readonly LocalityPosition[]): LocalityPosition[] => {
		const clean = tidy(ps.filter(finitePair));
		const idx = simplifyIndices(clean.map(project), tol);
		return idx.map((i) => clean[i]!);
	};
	const lineOf = (ps: unknown): LocalityPosition[] | null => {
		if (!Array.isArray(ps)) return null;
		const out = path(ps as LocalityPosition[]);
		return out.length >= 2 ? out : null;
	};
	const ringOf = (ps: unknown): LocalityPosition[] | null => {
		if (!Array.isArray(ps)) return null;
		const clean = tidy((ps as unknown[]).filter(finitePair));
		if (clean.length < 4) return null;
		const simple = path(clean);
		// A small ring the simplification would collapse is kept as it was.
		return simple.length >= 4 ? simple : clean;
	};
	const polygonOf = (rings: unknown): LocalityPosition[][] | null => {
		if (!Array.isArray(rings) || !rings.length) return null;
		const outer = ringOf(rings[0]);
		if (!outer) return null;
		return [outer, ...rings.slice(1).map(ringOf).filter(isSome)];
	};
	switch (g?.type) {
		case 'Point':
			return finitePair(g.coordinates) ? { type: 'Point', coordinates: [round6(g.coordinates[0]), round6(g.coordinates[1])] } : null;
		case 'LineString': {
			const l = lineOf(g.coordinates);
			return l ? { type: 'LineString', coordinates: l } : null;
		}
		case 'MultiLineString': {
			const ls = Array.isArray(g.coordinates) ? (g.coordinates as unknown[]).map(lineOf).filter(isSome) : [];
			return ls.length ? { type: 'MultiLineString', coordinates: ls } : null;
		}
		case 'Polygon': {
			const p = polygonOf(g.coordinates);
			return p ? { type: 'Polygon', coordinates: p } : null;
		}
		case 'MultiPolygon': {
			const ps = Array.isArray(g.coordinates) ? (g.coordinates as unknown[]).map(polygonOf).filter(isSome) : [];
			return ps.length ? { type: 'MultiPolygon', coordinates: ps } : null;
		}
		default:
			return null;
	}
}

/** The kinds the figure draws; `other` features are left out (they could be anything). */
const DRAWN_KINDS = new Set(['catchment_boundary', 'farm_parcel', 'dam', 'gauge', 'river']);

const nodeNames = (model: RunInputsSnapshot['model'] | undefined): Map<string, string> =>
	new Map(((model as { nodes?: { id: string; name: string }[] } | undefined)?.nodes ?? []).map((n) => [n.id, n.name]));

/**
 * The report's `localityMap`: null when the project has no map feature the
 * figure draws ("No locality map"). `ewrSiteNodeIds` are the report's Reserve
 * sites (§ 1), `ownedNodeIds` the application's own units ([] for baseline
 * evidence). Labels come from the runs' stored models (the application's,
 * then the baseline's), so they name a unit as the report does.
 */
export function localitySection(
	features: readonly EvidenceMapFeatureInput[] | null | undefined,
	ctx: { applicant: boolean; ownedNodeIds: readonly string[]; ewrSiteNodeIds: readonly string[]; models: (RunInputsSnapshot['model'] | undefined)[] }
): EvidenceReport['localityMap'] {
	const drawn = (features ?? []).filter((f) => DRAWN_KINDS.has(f.kind));
	// Rounded and checked first (tolerance 0 keeps every vertex), so the extent is the drawable one.
	const cleaned = drawn.flatMap((f) => {
		const g = figureGeometry(f.geometry, ([x, y]) => [x, y], 0);
		return g ? [{ f, g }] : [];
	});
	const box = boxOf(cleaned.map((c) => ({ geometry: c.g })));
	if (!box) return null;
	const proj = localProjection((box.minLon + box.maxLon) / 2, (box.minLat + box.maxLat) / 2);
	const [x0, y0] = proj.project([box.minLon, box.minLat]);
	const [x1, y1] = proj.project([box.maxLon, box.maxLat]);
	const tol = Math.max(x1 - x0, y1 - y0) * LOCALITY_SIMPLIFY_SHARE;

	const names = ctx.models.map(nodeNames);
	const nameOf = (id: string | null) => (id ? (names.map((m) => m.get(id)).find((n) => n !== undefined) ?? null) : null);
	const owned = new Set(ctx.applicant ? ctx.ownedNodeIds : []);
	const sites = new Set(ctx.ewrSiteNodeIds);

	const out: LocalityFeature[] = [];
	const used: EvidenceMapFeatureInput[] = [];
	for (const { f, g: clean } of cleaned) {
		const g = figureGeometry(clean, proj.project, tol);
		if (!g) continue;
		let layer: LocalityLayer;
		let label: string | null = null;
		const mine = !!f.nodeId && owned.has(f.nodeId);
		switch (f.kind) {
			case 'catchment_boundary':
				layer = 'boundary';
				break;
			case 'farm_parcel':
				layer = mine ? 'applicantParcel' : 'parcel';
				if (mine) label = nameOf(f.nodeId) ?? (f.name || null);
				break;
			case 'dam':
				layer = mine ? 'applicantDam' : 'dam';
				// The applicant's dam beside its parcel: the unit is already named once by its parcel.
				if (mine && !drawn.some((o) => o.kind === 'farm_parcel' && o.nodeId === f.nodeId)) label = nameOf(f.nodeId) ?? (f.name || null);
				break;
			case 'river':
				layer = 'river';
				break;
			default:
				layer = f.nodeId && sites.has(f.nodeId) ? 'ewrSite' : 'gauge';
				label = nameOf(f.nodeId) ?? (f.name || null);
		}
		out.push({ layer, label, geometry: g });
		used.push(f);
	}
	if (!out.length) return null;
	// In drawing order (a stable sort keeps the backend's order within a layer).
	const sorted = out
		.map((x, i) => ({ x, i }))
		.sort((a, b) => LOCALITY_LAYER_ORDER.indexOf(a.x.layer) - LOCALITY_LAYER_ORDER.indexOf(b.x.layer) || a.i - b.i)
		.map((o) => o.x);

	const sources = new Map<string, LocalitySource>();
	for (const f of used) if (f.source) sources.set(f.source.sha256, { fileName: f.source.fileName, sha256: f.source.sha256, importedAt: f.source.importedAt.slice(0, 10) });
	const data: LocalityMapData = {
		version: LOCALITY_MAP_VERSION,
		applicant: ctx.applicant,
		features: sorted,
		asOf: used.map((f) => f.updatedAt.slice(0, 10)).sort().at(-1)!,
		sources: [...sources.values()].sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.sha256.localeCompare(b.sha256)),
		drawnInApp: used.filter((f) => !f.source).length,
		svgSha256: null
	};
	return data;
}

/**
 * Set the report's `localityMap.svgSha256`: the SHA-256 of the SVG the figure
 * is, so the pack's manifest names the exact bytes printed and `reproduce:pack`
 * can draw it again and compare. The engine has no hash of its own; the
 * backend passes node:crypto's (a browser could pass WebCrypto's).
 */
export async function withLocalitySvgHash(report: EvidenceReport, hash: (text: string) => string | Promise<string>): Promise<EvidenceReport> {
	if (!report.localityMap) return report;
	const { svg } = localityMapSvg(report.localityMap);
	return { ...report, localityMap: { ...report.localityMap, svgSha256: await hash(svg) } };
}
