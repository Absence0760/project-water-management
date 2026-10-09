// Which node a series may belong to (time_series.site_node_id): a flow
// record's gauge (084_gauge_records, engine ≥ 1.4.0) or a land unit's own
// rain (209_unit_rain_series, issue #482, docs/model.md §2.4h). One rule for
// every path that sets a site: PATCH …/series/:id (series/routes.ts), a
// series restore (history/routes.ts) and a project document's import
// (projects/import.ts). The database holds the kinds and, for rain, the
// node's kind (209); the API adds the rest (not the outlet, an area above 0).
import { CALIBRATION_FLOW_KINDS, UNIT_RAIN_KINDS } from '@water-management/engine';

/** The node a site names, as far as the rule needs it; undefined = not in the model. */
export interface SiteNode {
	kind: string;
	downstreamNodeId: string | null;
	areaKm2: number;
}

export const isFlowSiteKind = (kind: string): boolean => (CALIBRATION_FLOW_KINDS as readonly string[]).includes(kind);
export const isUnitRainKind = (kind: string): boolean => (UNIT_RAIN_KINDS as readonly string[]).includes(kind);

/**
 * Why a series of `kind` can't have `node` as its site, or null when it can:
 * a flow record at a gauge above the outlet; a rain series at a land unit (a
 * farm with an area above 0: gauges and water users have no land). Nothing
 * else has a site; evaporation and forecast rain are the catchment's.
 * `anyArea`: a restore puts a series back at its unit even if the unit's area
 * has since been typed to 0 (the run then leaves it out, and says so).
 */
export function siteProblem(kind: string, node: SiteNode | undefined, { anyArea = false }: { anyArea?: boolean } = {}): string | null {
	if (isFlowSiteKind(kind)) {
		if (!node) return 'no such hydrological unit in this project (save the model first)';
		if (node.kind !== 'gauge') return 'a flow record’s site is a gauge';
		if (node.downstreamNodeId === null) return 'that gauge is the outlet, whose records have no site (null)';
		return null;
	}
	if (isUnitRainKind(kind)) {
		if (!node) return 'no such hydrological unit in this project (save the model first)';
		if (node.kind !== 'farm') return 'a unit’s own rain belongs to a land unit (a farm), not a gauge or a water user';
		if (!anyArea && !(node.areaKm2 > 0)) return 'that unit has no area, so no land for its own rain to fall on';
		return null;
	}
	return 'only a flow record or a land unit’s rain has a site: evaporation and forecast rain are the catchment’s';
}
