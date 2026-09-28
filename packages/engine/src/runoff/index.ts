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

/**
 * NATURAL_FLOW's generator for `id`, or a plain error for a model the engine
 * doesn't have. Settings arrive from stored JSON: an unchecked lookup would
 * call whatever `id` names on the object (`toString`, `constructor`).
 */
export function naturalFlowFor(id: RunoffModelId): NaturalFlowGenerator {
	if (!Object.hasOwn(NATURAL_FLOW, id)) throw new Error(`unknown runoff model "${String(id)}"`);
	return NATURAL_FLOW[id];
}
