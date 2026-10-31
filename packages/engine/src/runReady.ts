// Run readiness: what a run still needs before it can start, and what only
// warns. One module for every caller, so they refuse for the same reasons and
// say them the same way: Runs & results' run form (frontend RunsTab.svelte),
// the section header's Run model on every other section
// (workspace/RunButton.svelte, routes/projects/[id]/+page.svelte), Model
// settings' Flow generation panel, and the assistant's get_run_readiness tool
// (backend/src/assistant/tools/readiness.ts, issue #610). Pure, no I/O.
import type { NetworkNode, ProjectModel, RainStationSettings, SeriesMeta } from './project';

export interface RunBlockers {
	/** What the engine refuses to run without: 'a network', 'a rainfall series'. */
	missing: string[];
}

/**
 * Why a run can't start. `series` null means the list hasn't loaded yet, so rain
 * isn't counted missing. The editor's model (unsaved edits are saved before a run,
 * or the run waits for their problems). Flow shares can't stop a run any more:
 * each unit's is its natural MAR share, and they add up to 100 % (issue #616).
 */
export function runBlockers(model: Pick<ProjectModel, 'nodes'>, series: readonly Pick<SeriesMeta, 'kind'>[] | null | undefined): RunBlockers {
	const missing: string[] = [];
	if (!model.nodes.length) missing.push('a network');
	if (series && !series.some((x) => x.kind.startsWith('rain_'))) missing.push('a rainfall series');
	return { missing };
}

/** A forecast run needs forecast rain (uploaded, or fed by CHIRPS-GEFS); the server says if none is past the record. */
export const hasForecastRain = (series: readonly Pick<SeriesMeta, 'kind'>[] | null | undefined) => !!series?.some((x) => x.kind === 'rain_forecast_mm');

/** A land unit as run readiness and the Flow generation table need it. */
export type LandUnitNode = Pick<NetworkNode, 'id' | 'name' | 'kind' | 'areaKm2' | 'mapMm' | 'mapSource'>;

/** The land units (a farm with an area), in the model's order. */
export const landUnits = <N extends LandUnitNode>(nodes: readonly N[]): N[] => nodes.filter((n) => n.kind === 'farm' && n.areaKm2 > 0);

/**
 * The land units that run on the catchment rain (rule 4 of docs/model.md §2.4h), in the model's order: no rainfall
 * station, no rain gauge or CHIRPS series of their own, and no MAP to scale the catchment gauge by (or no gauge MAP).
 * Their share of the EWR follows their area (issue #615, §2.5b), so Run readiness and the Flow generation
 * panel name them. A note, never a blocker. Read from the setup, as the editor sees it: the run decides from the records themselves, so a
 * series with no reading, or a CHIRPS that totals 0 mm, still falls to the catchment rain there and the run says so.
 */
export function unitsOnCatchmentRain<N extends LandUnitNode & { mapMm?: number | null }>(
	nodes: readonly N[],
	settings: { unitRain?: { gaugeMapMm?: number | null } | null; rainStations?: Pick<RainStationSettings, 'units'> | null } | null | undefined,
	series: readonly (Pick<SeriesMeta, 'kind'> & { siteNodeId?: string | null; station?: { mapMm?: number | null } | null })[]
): N[] {
	const own = new Set(series.filter((s) => s.siteNodeId && (s.kind === 'rain_catchment_mm' || s.kind === 'rain_chirps_mm')).map((s) => s.siteNodeId!));
	const gauge = series.find((s) => s.kind === 'rain_catchment_mm' && !s.siteNodeId);
	const gaugeMap = !!gauge && ((settings?.unitRain?.gaugeMapMm ?? null) !== null || (gauge.station?.mapMm ?? null) !== null);
	const stations = settings?.rainStations?.units ?? {};
	return landUnits(nodes).filter((n) => !stations[n.id] && !own.has(n.id) && !(gaugeMap && (n.mapMm ?? 0) > 0));
}
