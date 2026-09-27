import { gr4jNaturalFlow } from './simulate';
import type { NaturalFlowGenerator, RunoffModelId } from './types';

export * from './types';
export { resolveCatchmentAreaKm2 } from './area';
export * from './gr4j';
export { defaultGr4jParams, GR4J_PARAMS, type Gr4jParams } from './params';
export { GR4J_NO_PET, hasPotentialEvaporation } from './pet';
export { resolveParams, resolveWarmupDays, runoffForcing, simulateRunoff, type RunoffForcing, type RunoffTrace } from './simulate';

/** The natural-flow generator for settings.runoffModel. */
export const NATURAL_FLOW: Record<RunoffModelId, NaturalFlowGenerator> = {
	gr4j: gr4jNaturalFlow
};
