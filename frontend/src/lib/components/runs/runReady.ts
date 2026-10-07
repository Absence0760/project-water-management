// What a run still needs before it can start, shared by Runs & results' run form
// (RunsTab.svelte) and the section header's Run model on every other section
// (workspace/RunButton.svelte), so both refuse for the same reasons and say them the same way.
import { inputFlowShares, overAllocationError, type ProjectModel, type SeriesMeta } from '@water-management/engine';

export interface RunBlockers {
	/** What the engine refuses to run without: 'a network', 'a rainfall series'. */
	missing: string[];
	/** Flow shares over 100 % make water from nowhere, so the engine refuses the run: why, or null. */
	overAllocated: string | null;
}

/**
 * Why a run can't start. `series` null means the list hasn't loaded yet, so rain
 * isn't counted missing. The editor's model, like the Network tab's total
 * (unsaved edits are saved before a run, or the run waits for their problems).
 */
export function runBlockers(model: Pick<ProjectModel, 'nodes'>, settings: object, series: Pick<SeriesMeta, 'kind'>[] | null | undefined): RunBlockers {
	const missing: string[] = [];
	if (!model.nodes.length) missing.push('a network');
	if (series && !series.some((x) => x.kind.startsWith('rain_'))) missing.push('a rainfall series');
	return { missing, overAllocated: overAllocationError(inputFlowShares({ model, settings }).sum) };
}

/** A forecast run needs forecast rain (uploaded, or fed by CHIRPS-GEFS); the server says if none is past the record. */
export const hasForecastRain = (series: Pick<SeriesMeta, 'kind'>[] | null | undefined) => !!series?.some((x) => x.kind === 'rain_forecast_mm');
