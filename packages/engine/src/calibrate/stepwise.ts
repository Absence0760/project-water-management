// The stepwise fit of calibration zones (engine 1.106.0, issue #555,
// docs/model.md §2.10n): upstream first, each zone fitted on its own gauge's
// record with every zone above it fixed at the parameters its own step found,
// then the calibration site's own zone (the rest) last. Each step is a whole
// calibrate() (its own scores, split-sample and dry → wet tests, notes and fit
// record); the steps are applied together (applyStepwise).
import { mergeSettings } from '../prepare';
import type { ModelInput, ProjectSettings } from '../project';
import { GR4J_PARAMS, type Gr4jParams } from '../runoff/params';
import { resolveParams } from '../runoff/simulate';
import { calibrate, type CalibrateOptions, type CalibrationProgress, type CalibrationReport } from './calibrate';
import type { ParamSet } from './params';
import { resolveZones, zoneFitError, zoneSiteName, type CalibrationZone, type ZoneAssignment } from './zones';

/** One step of the plan: a zone (its gauge, or null for the site's own zone), with its land units. */
export interface ZoneFitPlanStep {
	zoneNodeId: string | null;
	name: string;
	units: string[];
}

/** One fitted step. */
export interface ZoneFitStep extends ZoneFitPlanStep {
	report: CalibrationReport;
}

export interface StepwiseCalibrationReport {
	/** Upstream first; the site's own zone last. */
	steps: ZoneFitStep[];
	/** Model runs over every step. */
	evaluations: number;
	/** A step was cancelled: the steps after it never ran, and nothing should be applied. */
	cancelled: boolean;
}

export interface StepwiseProgress extends CalibrationProgress {
	/** 1-based step, of how many. */
	step: number;
	steps: number;
	zoneNodeId: string | null;
}

/**
 * The stepwise fit's steps, upstream first, or null when no calibration zone
 * applies (the fit is one calibrate() at the site, as before). Throws when a
 * zone, or the site's own zone, has no land unit (zoneFitError).
 */
export function zoneFitPlan(input: ModelInput): ZoneFitPlanStep[] | null {
	const settings = mergeSettings(input.settings, []);
	const a = assignment(input, settings);
	if (!a) return null;
	const err = zoneFitError(a);
	if (err) throw new Error(err);
	return [
		...a.zones.map((z) => ({ zoneNodeId: z.nodeId, name: z.name, units: [...z.units] })),
		{ zoneNodeId: null, name: zoneSiteName(input.model.nodes, settings.calibrationSiteNodeId ?? null), units: [...a.primaryUnits] }
	];
}

function assignment(input: ModelInput, settings: ProjectSettings): ZoneAssignment | null {
	return resolveZones(input.model.nodes, settings, resolveParams<Gr4jParams>(GR4J_PARAMS, settings.gr4j, 'GR4J', []), []);
}

/** A fit's parameter set as GR4J X1–X4. */
export const gr4jOfParamSet = (p: ParamSet): Gr4jParams => Object.fromEntries(GR4J_PARAMS.map((s) => [s.key, p[s.key]!])) as unknown as Gr4jParams;

/** The input with one zone's parameters replaced (a step's result, fixed for the steps below it). */
export function withZoneParams(input: ModelInput, zoneNodeId: string, params: Gr4jParams): ModelInput {
	const zones = ((input.settings?.calibrationZones as CalibrationZone[] | null | undefined) ?? []).map((z) => (z.nodeId === zoneNodeId ? { ...z, gr4j: { ...params } } : z));
	return { ...input, settings: { ...input.settings, calibrationZones: zones } };
}

/**
 * Fit every calibration zone, upstream first, then the site's own zone
 * (docs/model.md §2.10n). Each step runs calibrate() with `opts` (the seed,
 * starts, budget, bounds, objective and validation are the same for every
 * step) on the input with the zones fitted so far at their new parameters.
 * Without a zone, one step: calibrate(input, opts) itself, to the bit.
 */
export function calibrateStepwise(input: ModelInput, opts: Omit<CalibrateOptions, 'zone' | 'onProgress'> & { onProgress?: (p: StepwiseProgress) => boolean | void } = {}): StepwiseCalibrationReport {
	const plan = zoneFitPlan(input) ?? [{ zoneNodeId: null, name: '', units: [] }];
	const steps: ZoneFitStep[] = [];
	let evaluations = 0;
	let cancelled = false;
	let cur = input;
	for (const [i, step] of plan.entries()) {
		const { onProgress: _p, ...rest } = opts;
		const report = calibrate(cur, {
			...rest,
			...(step.zoneNodeId !== null ? { zone: step.zoneNodeId } : {}),
			...(opts.onProgress ? { onProgress: (p: CalibrationProgress) => opts.onProgress!({ ...p, step: i + 1, steps: plan.length, zoneNodeId: step.zoneNodeId }) } : {})
		});
		steps.push({ ...step, report });
		evaluations += report.evaluations;
		if (report.cancelled) {
			cancelled = true;
			break;
		}
		if (step.zoneNodeId !== null) cur = withZoneParams(cur, step.zoneNodeId, gr4jOfParamSet(report.params));
	}
	return { steps, evaluations, cancelled };
}

/**
 * Settings with every step's parameters written in (one result applied as a
 * whole): the site's own zone into `gr4j`, each zone's into its row's `gr4j`,
 * and each step's fit record (made by the caller, `recordOf`) beside them.
 * Every other setting is left as it was.
 */
export function applyStepwise<S extends Pick<ProjectSettings, 'gr4j' | 'fitRecord' | 'calibrationZones'>>(
	settings: S,
	r: StepwiseCalibrationReport,
	recordOf: (step: ZoneFitStep) => NonNullable<ProjectSettings['fitRecord']>
): S {
	if (r.cancelled) throw new Error('a cancelled stepwise fit is not applied');
	let out: S = { ...settings };
	for (const step of r.steps) {
		const p = gr4jOfParamSet(step.report.params);
		if (step.zoneNodeId === null) out = { ...out, gr4j: { ...out.gr4j, ...p }, fitRecord: recordOf(step) };
		else out = { ...out, calibrationZones: (out.calibrationZones ?? []).map((z) => (z.nodeId === step.zoneNodeId ? { ...z, gr4j: p, fitRecord: recordOf(step) } : z)) };
	}
	return out;
}
