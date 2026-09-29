// "Propose from the double-mass breaks" for the CHIRPS fit period
// (settings.chirpsFitPeriod, engine ≥ 0.29.0, issue #40): loads the project's
// catchment rain and CHIRPS (the first of each by name, as a run and the Data
// tab read them) and proposes ranges from their double-mass breaks
// (./fitRangeProposal.ts). The hydrologist then checks and saves them.
import type { DailySeries, SeriesMeta } from '@water-management/engine';
import { api } from '$lib/api';
import { cachedValues, cacheValues } from '$lib/components/series/valuesCache';
import { proposalFrom, type FitRangeProposal } from './fitRangeProposal';

const firstOf = (list: SeriesMeta[], kind: string) => list.filter((s) => s.kind === kind).sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;

async function valuesOf(projectId: string, s: SeriesMeta | null): Promise<DailySeries | null> {
	if (!s) return null;
	return cachedValues(projectId, s) ?? cacheValues(projectId, await api.series.get(projectId, s.id));
}

/** Load the project's catchment rain and CHIRPS and propose ranges from their double-mass breaks. */
export async function proposeFitRanges(projectId: string, zeroRainRuns: unknown, dataQuality?: unknown): Promise<FitRangeProposal> {
	const list = await api.series.list(projectId);
	const [c, h] = await Promise.all([valuesOf(projectId, firstOf(list, 'rain_catchment_mm')), valuesOf(projectId, firstOf(list, 'rain_chirps_mm'))]);
	return proposalFrom(c, h, zeroRainRuns, dataQuality);
}
