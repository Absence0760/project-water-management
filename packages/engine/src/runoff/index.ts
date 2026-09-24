import { legacyNaturalFlow } from './legacy';
import type { NaturalFlowGenerator, RunoffModelId } from './types';

export * from './types';
export { resolveCatchmentAreaKm2 } from './area';

/** The natural-flow generator for settings.runoffModel. */
export const NATURAL_FLOW: Record<RunoffModelId, NaturalFlowGenerator> = {
	legacy: legacyNaturalFlow
};
