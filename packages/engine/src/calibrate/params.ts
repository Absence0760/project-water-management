// What a fit may search and how: the fittable parameters per runoff model,
// the bound choices and the number of starts. Constants only, apart from the
// fit itself (./calibrate.ts), so the fit panel and the settings forms don't
// load the calibration and model code with them (issue #9).
import { GR4J_PARAMS } from '../runoff/params';
import type { ParamSpec, RunoffModelId } from '../runoff/types';

/** Parameter values by key (GR4J's x1…x4). */
export type ParamSet = Record<string, number>;

/** The parameters automatic calibration can fit, per runoff model. */
export const CALIBRATION_PARAMS: Record<RunoffModelId, ParamSpec<Record<string, number>>[]> = {
	gr4j: GR4J_PARAMS as unknown as ParamSpec<Record<string, number>>[]
};

/** 'wide': each parameter's min/max. 'typical': Perrin et al.'s (2003) 80 % range. */
export const CALIBRATION_BOUNDS = ['wide', 'typical'] as const;
export type CalibrationBounds = (typeof CALIBRATION_BOUNDS)[number];

/** Most starts a fit may ask for, and how many the app asks for. */
export const MAX_STARTS = 10;
export const DEFAULT_STARTS = 5;
