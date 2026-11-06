// The delineated catchment's sheet: whether one catchment above a point was most likely meant as a hydrological unit
// (its outlet inside the catchment boundary). Its own module, imported only by the lazy DelineateSheet, so the Map
// tab's own chunk doesn't carry it (the per-tab bundle budget).
import type { DelineationProposal, MapFeature, MapPosition } from '#lib/api/types.js';
/** The point is inside a polygon's rings (even-odd, holes included), or inside any part of a multipolygon. */
function insidePolygon([x, y]: MapPosition, rings: readonly (readonly MapPosition[])[]): boolean {
	let n = false;
	for (const r of rings)
		for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
			const [xi, yi] = r[i]!;
			const [xj, yj] = r[j]!;
			if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) n = !n;
		}
	return n;
}

/**
 * One catchment above a point whose outlet lies inside the project's catchment boundary: most likely a hydrological
 * unit meant (the operator drew a unit this way and the next one replaced it, 2026-11-06), so the sheet says that
 * this is the whole catchment above the point, what accepting it as the boundary replaces, and offers Sub-catchments,
 * one per click. Null when there's no boundary or the outlet is outside it.
 */
export function unitInsideBoundary(p: Pick<DelineationProposal, 'outlet'>, boundary: Pick<MapFeature, 'name' | 'areaM2' | 'geometry'> | null): { name: string; areaKm2: number | null } | null {
	const g = boundary?.geometry;
	if (!boundary || !g) return null;
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
	if (!polys.some((rings) => insidePolygon(p.outlet, rings))) return null;
	return { name: boundary.name || 'the catchment boundary', areaKm2: boundary.areaM2 === null ? null : boundary.areaM2 / 1e6 };
}
