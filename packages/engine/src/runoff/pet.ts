// Whether GR4J can run on a project's evaporation settings. Apart from the
// runoff code (./simulate.ts), so the settings forms that warn about it don't
// load the model with it (issue #9).
import { gr4jPeMonthlyMm, type PeInput } from '../project';

/**
 * Some month has potential evaporation (`gr4jPeMonthlyMm` > 0): what GR4J
 * needs to run. `dailyApan` (engine ≥ 0.38.0, issue #45): the project's daily
 * A-pan series has a value above 0 in the run, which under `pe.kind: 'pan'`
 * gives GR4J evaporation (× a pan coefficient above 0) even when the monthly
 * means are all 0.
 */
export const hasPotentialEvaporation = (
	s: { apanMm: readonly number[]; panCoefficient: readonly number[]; pe?: PeInput | null },
	dailyApan = false
): boolean => gr4jPeMonthlyMm(s).some((v) => v > 0) || (dailyApan && s.pe?.kind !== 'monthly' && s.panCoefficient.some((v) => v > 0));

/** Why a GR4J run is refused when potential evaporation is 0 in every month. */
export const GR4J_NO_PET =
	'GR4J needs potential evaporation: it is 0 in every month (A-pan × pan coefficient, or the monthly PE row), so the catchment would never dry out. Enter A-pan evaporation (Settings → Demand, or a daily A-pan series on the Data tab) or a monthly PE row (Settings → Flow calibration).';
