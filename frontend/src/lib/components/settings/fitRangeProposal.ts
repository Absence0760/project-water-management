// The double-mass proposal for the CHIRPS fit period (settings.chirpsFitPeriod,
// engine ≥ 0.29.0, issue #40), pure so it is unit-tested; ./proposeFitRanges.ts
// loads the series for it. The breaks only propose: an automatic break can
// land a year or two off the real network change, so nothing is applied until
// the hydrologist checks the ranges and saves.
import { doubleMass, proposeChirpsFitRanges, resolveDataQuality, resolveZeroRain, type ChirpsFitRange, type DailySeries } from '@water-management/engine';

export type FitRangeProposal = { ranges: ChirpsFitRange[] } | { reason: string };

/**
 * Ranges proposed from the double-mass check of `catchment` against `chirps`,
 * or why there are none. `dataQuality` is the form's settings.dataQuality: its
 * zero-run limits decide which days the check leaves out, as in a run.
 */
export function proposalFrom(catchment: DailySeries | null, chirps: DailySeries | null, zeroRainRuns: unknown, dataQuality?: unknown): FitRangeProposal {
	if (!catchment || !chirps) return { reason: 'Nothing to propose from: the double-mass check needs a catchment rain series and a CHIRPS series.' };
	const dm = doubleMass({ rain_catchment_mm: catchment, rain_chirps_mm: chirps }, resolveZeroRain(zeroRainRuns, []), resolveDataQuality(dataQuality));
	if (!dm) return { reason: 'Nothing to propose: the record is too short for the double-mass check (it needs 10 water years with 300+ shared days).' };
	const ranges = proposeChirpsFitRanges(dm);
	return ranges.length ? { ranges } : { reason: 'Nothing to propose: the double-mass check finds no break, so the whole record is one era.' };
}
