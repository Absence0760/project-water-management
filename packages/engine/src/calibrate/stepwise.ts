// The stepwise fit of calibration locations (engine 1.106.0, issue #555;
// engine 1.110.0, issue #659; docs/model.md §2.10n): each ticked location in
// dependency order (locationFitPlan: every location whose group a unit above
// it runs on first, the headline last among the ready ones), each fitted on
// its own record with every location before it fixed at the parameters its
// own step found. Each step is a whole calibrate() (its own scores,
// split-sample and dry → wet tests, notes and fit record); the steps are
// applied together (applyStepwise).
import type { ModelInput, ProjectSettings } from '../project';
import { GR4J_PARAMS, type Gr4jParams } from '../runoff/params';
import { calibrate, type CalibrateOptions, type CalibrationProgress, type CalibrationReport } from './calibrate';
import type { CalibrationPrior } from './prior';
import type { ParamSet } from './params';
import { locationFitPlan, normalizedInput, normalizeCalibrationLocations, resolveLocations, withLocationParams, type LocationKey, type ZoneFitPlanStep } from './locations';
import type { CalibrationZone } from './zones';
import { mergeSettings } from '../prepare';

/** One fitted step. */
export interface ZoneFitStep extends ZoneFitPlanStep {
	report: CalibrationReport;
}

export interface StepwiseCalibrationReport {
	/** In fit order (dependency order, the headline last among the ready ones). */
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
	zoneNodeId: LocationKey;
}

/**
 * The stepwise fit's steps, or null when no gauge location applies (every
 * unit runs on settings.gr4j: the fit is one calibrate() at the headline, as
 * before #555). Throws as locationFitPlan does (a cycle, a group with no unit
 * draining through its location) but never for "no location ticked", which
 * a lone calibrate() scores at the outlet as every engine before.
 */
export function zoneFitPlan(input: ModelInput): ZoneFitPlanStep[] | null {
	const settings = mergeSettings(input.settings, [], input.model.nodes);
	const base = Object.fromEntries(GR4J_PARAMS.map((s) => [s.key, s.default])) as unknown as Gr4jParams;
	if (!resolveLocations(input.model.nodes, settings, base, [])) return null;
	return locationFitPlan(input);
}

/** A fit's parameter set as GR4J X1–X4. */
export const gr4jOfParamSet = (p: ParamSet): Gr4jParams => Object.fromEntries(GR4J_PARAMS.map((s) => [s.key, p[s.key]!])) as unknown as Gr4jParams;

/**
 * The input with one location's parameters replaced (a step's result, fixed
 * for the steps after it): a gauge's row, or for the outlet's location (null)
 * settings.gr4j. Settings from before engine 1.110.0 are normalised first
 * (normalizeCalibrationLocations), so a legacy inner site's row exists.
 */
export function withZoneParams(input: ModelInput, zoneNodeId: LocationKey, params: Gr4jParams): ModelInput {
	return withLocationParams(normalizedInput(input), zoneNodeId, params);
}

/**
 * Fit every ticked calibration location in dependency order
 * (locationFitPlan, docs/model.md §2.10n). Each step runs calibrate() with
 * `opts` (the seed, starts, budget, bounds, objective and validation are the
 * same for every step) on the input with the locations fitted so far at
 * their new parameters; the step's whole group (its own, borrowed and rest
 * units) takes the candidate. With only the outlet ticked and no gauge, one
 * step: calibrate(input, opts) at the outlet, to the bit. Throws, before any
 * step runs, when no location is ticked, a group has no unit draining
 * through its location, or the borrowing makes a cycle.
 *
 * The regional prior (issue #622, docs/model.md §2.10m): each step takes the
 * prior built for its own location (`prior(step)`: its gauge and group),
 * never the catchment's, since a location's parameters describe its group only.
 */
export function calibrateStepwise(
	input: ModelInput,
	opts: Omit<CalibrateOptions, 'zone' | 'onProgress' | 'prior'> & {
		onProgress?: (p: StepwiseProgress) => boolean | void;
		/** The prior for one step, built for that step's location; undefined = none for it. */
		prior?: (step: ZoneFitPlanStep) => CalibrationPrior | undefined;
	} = {}
): StepwiseCalibrationReport {
	input = normalizedInput(input);
	const plan = locationFitPlan(input);
	// The prior bounds need a prior for every step: refused before the first fit, not after the earlier ones ran.
	if (opts.bounds === 'prior' && plan.some((step) => !opts.prior?.(step))) throw new Error('the prior bounds need a regional prior for every calibration location');
	const steps: ZoneFitStep[] = [];
	let evaluations = 0;
	let cancelled = false;
	let cur = input;
	for (const [i, step] of plan.entries()) {
		const { onProgress: _p, prior: priorFor, ...rest } = opts;
		const prior = priorFor?.(step);
		const report = calibrate(cur, {
			...rest,
			zone: step.zoneNodeId,
			...(prior ? { prior } : {}),
			...(opts.onProgress ? { onProgress: (p: CalibrationProgress) => opts.onProgress!({ ...p, step: i + 1, steps: plan.length, zoneNodeId: step.zoneNodeId }) } : {})
		});
		steps.push({ ...step, report });
		evaluations += report.evaluations;
		if (report.cancelled) {
			cancelled = true;
			break;
		}
		cur = withLocationParams(cur, step.zoneNodeId, gr4jOfParamSet(report.params));
	}
	return { steps, evaluations, cancelled };
}

/**
 * Settings with every step's parameters written in (one result applied as a
 * whole): the outlet's location into `gr4j`, each gauge's into its row's
 * `gr4j`, and each step's fit record (made by the caller, `recordOf`) beside
 * them. Every other setting is left as it was. Settings from before engine
 * 1.110.0 are normalised first when `nodes` are given; a step whose row the
 * settings don't have throws rather than drop its parameters.
 */
export function applyStepwise<S extends Pick<ProjectSettings, 'gr4j' | 'fitRecord' | 'calibrationZones'>>(
	settings: S,
	r: StepwiseCalibrationReport,
	recordOf: (step: ZoneFitStep) => NonNullable<ProjectSettings['fitRecord']>,
	nodes?: ModelInput['model']['nodes']
): S {
	if (r.cancelled) throw new Error('a cancelled stepwise fit is not applied');
	let out: S = nodes ? (normalizeCalibrationLocations(settings as unknown as ModelInput['settings'], nodes) as unknown as S) : { ...settings };
	for (const step of r.steps) {
		const p = gr4jOfParamSet(step.report.params);
		if (step.zoneNodeId === null) out = { ...out, gr4j: { ...out.gr4j, ...p }, fitRecord: recordOf(step) };
		else {
			const rows = (out.calibrationZones ?? []) as CalibrationZone[];
			if (!rows.some((z) => z.nodeId === step.zoneNodeId)) throw new Error(`the settings have no calibration location at gauge node ${step.zoneNodeId}: normalise them first (normalizeCalibrationLocations)`);
			out = { ...out, calibrationZones: rows.map((z) => (z.nodeId === step.zoneNodeId ? { ...z, gr4j: p, fitRecord: recordOf(step) } : z)) };
		}
	}
	return out;
}
