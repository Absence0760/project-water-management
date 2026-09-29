// The daily series the impact report's licence-impact board reads
// (./licenceImpact.ts): the baseline's natural flow and both runs' EWR
// shortfall at the outlet. Its own small module: the report route fetches
// them before "ready", while the board and the engine code it needs stay in
// the impact section's chunk.
import type { DailySeries } from '@water-management/engine';

/** The daily series the board reads; null when a run hasn't one (or it couldn't be fetched). */
export interface ImpactSeries {
	background: { natural: DailySeries | null; ewrShortfall: DailySeries | null };
	application: { ewrShortfall: DailySeries | null };
}

type FetchSeries = (projectId: string, runId: string, key: string) => Promise<DailySeries>;

/** The three series, fetched at once; a failed one is null (the board then says what is missing). */
export async function loadImpactSeries(fetchSeries: FetchSeries, background: { projectId: string; runId: string }, application: { projectId: string; runId: string }): Promise<ImpactSeries> {
	const get = (r: { projectId: string; runId: string }, key: string) => fetchSeries(r.projectId, r.runId, key).catch(() => null);
	const [natural, bgShort, appShort] = await Promise.all([get(background, 'natural_flow'), get(background, 'ewr_shortfall'), get(application, 'ewr_shortfall')]);
	return { background: { natural, ewrShortfall: bgShort }, application: { ewrShortfall: appShort } };
}
