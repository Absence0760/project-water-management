// The runoff models' parameter tables: what each parameter means, its
// default and the bounds calibration searches. Kept apart from the model code
// (./gr4j.ts), so the settings and fit screens that list the
// parameters don't load the models with them (issue #9).
import type { ParamSpec } from './types';

export interface Gr4jParams {
	/** Production store capacity (mm). */
	x1: number;
	/** Groundwater exchange coefficient (mm/day); 0 = closed catchment. */
	x2: number;
	/** Routing store reference capacity (mm). */
	x3: number;
	/** Unit hydrograph time base (days). */
	x4: number;
}

/**
 * Parameter bounds. `typical` is the 80 % confidence range Perrin et al.
 * (2003) report over 429 catchments; min/max are the wider bounds calibration
 * may search (issue #4 §2).
 */
export const GR4J_PARAMS: ParamSpec<Gr4jParams>[] = [
	{ key: 'x1', label: 'Production store capacity X1', unit: 'mm', default: 350, min: 10, max: 3000, typical: [100, 1200] },
	{ key: 'x2', label: 'Groundwater exchange X2', unit: 'mm/day', default: 0, min: -5, max: 3, typical: [-5, 3], fixedByDefault: true },
	{ key: 'x3', label: 'Routing store capacity X3', unit: 'mm', default: 90, min: 1, max: 1000, typical: [20, 300] },
	{ key: 'x4', label: 'Unit hydrograph time base X4', unit: 'days', default: 1.7, min: 0.5, max: 10, typical: [1.1, 2.9] }
];

export function defaultGr4jParams(): Gr4jParams {
	return { x1: 350, x2: 0, x3: 90, x4: 1.7 };
}
