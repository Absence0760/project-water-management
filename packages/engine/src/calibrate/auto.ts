// Automated calibration (issue #153, docs/model.md §2.10j): the rules in
// ./rules.ts applied end to end, with no one choosing after the scores are
// seen. The project's settings.calibrationRules decide the exclusions, the
// forcing, the fits to try and the fit to keep; this fits every case with
// validation, runs the model with each fit for its MAR, and keeps the case
// with the best held-out score among those that pass the filters (or none,
// saying why). The same input, rules, seed and engine version give the same
// report.
//
// Pure engine, like calibrate(): it runs in the browser's calibration worker.
// Applying the kept fit is the page's job (its fit record carries the rules,
// ./provenance.ts AutoFitRecord); nothing here saves anything.
import { ENGINE_VERSION } from '../version';
import { CALIBRATION_FLOW_KINDS, resolvePe, type CalibrationFlowKind, type ModelInput, type ProjectSettings } from '../project';
import { mergeSettings } from '../prepare';
import { runModel } from '../run';
import { calibrate, prepareCalibration, type CalibrationProgress, type CalibrationReport } from './calibrate';
import type { ObjectiveId } from './objectives';
import { flaggedYearExclusions, type FlaggedYearShare } from './dayFlags';
import { exclusionRanges, type CalibrationExclusion } from './provenance';
import { selectCase, typicalParamsFilter, wr2012MarFilter, type FilterResult } from './rules';
import { resolveCalibrationRules, rulePanLabel, rulePanValues, SELECTION_TEST_LABEL, type CalibrationRules, type RulePan } from './rulesSettings';
import type { CalibrationBounds } from './params';

/** The seed, starts and model runs come from the rules (rules.run), never the caller: they can't be chosen after a result is seen. */
export interface AutoCalibrateOptions {
	/** Progress after every model run of every case; return true to cancel (no fit is kept). */
	onProgress?: (p: AutoCalibrationProgress) => boolean | void;
}

export interface AutoCalibrationProgress {
	/** 0-based case being fitted, of `cases`. */
	caseIndex: number;
	cases: number;
	progress: CalibrationProgress;
}

/** One fit the rules asked for. */
export interface AutoCase {
	pan: { id: RulePan; label: string; values: number[] | null };
	bounds: CalibrationBounds;
	objective: ObjectiveId;
	/** "Project’s pan coefficient · wide · KGE′". */
	label: string;
	/** The fit; null when it failed (`error`). */
	report: CalibrationReport | null;
	error: string | null;
	/** Mean annual simulated natural flow with the fitted parameters over the whole run (Mm³/a); null when not fitted. */
	naturalMarMm3: number | null;
	filters: FilterResult[];
	/** The held-out score the rules select by; null when the record doesn't allow the test. */
	score: number | null;
	eligible: boolean;
	/** Why the case may not be kept (empty when eligible). */
	reasons: string[];
}

export interface AutoCalibrationReport {
	/** The rules as they ran, revision and sign-off included. */
	rules: CalibrationRules;
	engineVersion: string;
	seed: number;
	starts: number;
	budget: number;
	/** The record fitted to, and the other one validated against (when the project has both). */
	flowKind: string;
	validationRecord: CalibrationFlowKind | null;
	/** Each water year's flagged share, and which the exclusion rule left out. */
	years: FlaggedYearShare[];
	/** The water years left out by rule, on top of settings.calibrationExclusions. */
	ruleExclusions: CalibrationExclusion[];
	cases: AutoCase[];
	/** Index of the kept case; null when none passed (or the run was cancelled). */
	chosen: number | null;
	/** Plain-language notes: draft rules, filters that couldn't apply, why nothing was kept. */
	notes: string[];
	cancelled: boolean;
}

/**
 * Why the rules can't run on this project, or null. A pan preset needs GR4J's
 * PE to be pan coefficient × A-pan (under a monthly PE row it wouldn't reach
 * GR4J, so every forcing case would be the same fit); selecting by the other
 * observed record needs the project to have both records.
 */
export function autoCalibrationRefusal(settings: Pick<ProjectSettings, 'pe'>, rules: CalibrationRules, otherRecord: CalibrationFlowKind | null): string | null {
	if (rules.forcing.pan.some((p) => p !== 'project') && resolvePe(settings.pe, []).kind === 'monthly')
		return 'the rules fit under a pan coefficient preset, but GR4J’s potential evaporation is a monthly PE row here, so the pan coefficient doesn’t reach it: list only the project’s pan coefficient, or switch the PE input to pan × A-pan';
	if (rules.selection.test === 'independent' && !otherRecord)
		return 'the rules keep the fit by its score on the other observed record, but the project has only one record: upload both a gauge and a logger record, or select by another test';
	return null;
}

const naturalMar = (out: ReturnType<typeof runModel>): number => {
	const v = out.series.find((s) => s.nodeId === null && s.key === 'natural_flow')?.values ?? [];
	let total = 0;
	for (const x of v) total += x ?? 0;
	return out.days ? total / (out.days / 365.25) / 1e6 : 0;
};

/** The held-out score of a report on the rules' test, or why there is none. */
function heldOutScore(r: CalibrationReport, rules: CalibrationRules): { score: number | null; missing?: string } {
	const test = rules.selection.test === 'dryWet' ? r.differential : rules.selection.test === 'split' ? r.splitSample : r.independentRecord;
	const v = test ? ((test.validation.scores as unknown as Record<string, number | null | undefined>)[rules.selection.score] ?? null) : null;
	if (v !== null && Number.isFinite(v)) return { score: v };
	return { score: null, missing: test ? `no ${rules.selection.score} score on the ${SELECTION_TEST_LABEL[rules.selection.test]}` : `the record doesn’t allow the ${SELECTION_TEST_LABEL[rules.selection.test]}` };
}

/** Run the project's calibration rules (settings.calibrationRules) end to end. Throws when there is nothing to calibrate, or the rules refuse. */
export function autoCalibrate(input: ModelInput, opts: AutoCalibrateOptions = {}): AutoCalibrationReport {
	// Read merged over the defaults; each case's input keeps the raw settings, as calibrate() takes them.
	const settings = mergeSettings(input.settings, []);
	const notes: string[] = [];
	const rules = resolveCalibrationRules(input.settings.calibrationRules, notes);
	const { seed, starts, budget } = rules.run;

	// The exclusions come from the flags of the record fitted to, over the window as the settings have it.
	const pb = prepareCalibration(input);
	const other = CALIBRATION_FLOW_KINDS.find((k) => k !== pb.flowKind && input.series?.[k]) ?? null;
	const refusal = autoCalibrationRefusal(settings, rules, other);
	if (refusal) throw new Error(refusal);
	const flagged = flaggedYearExclusions(pb.flowFlags!, pb.windowDays!, pb.startDate, rules.exclusions.maxFlaggedShare);
	const ruleRanges = exclusionRanges(flagged.exclusions).map(({ start, end }) => ({ start, end }));

	const combos: Pick<AutoCase, 'pan' | 'bounds' | 'objective'>[] = [];
	for (const id of rules.forcing.pan)
		for (const bounds of rules.cases.bounds)
			for (const objective of rules.cases.objectives) combos.push({ pan: { id, label: rulePanLabel(id), values: rulePanValues(id) }, bounds, objective });

	let cancelled = false;
	const cases: AutoCase[] = [];
	for (const [i, c] of combos.entries()) {
		const label = `${c.pan.label} · ${c.bounds} bounds · ${c.objective}`;
		const caseInput: ModelInput = c.pan.values ? { ...input, settings: { ...input.settings, panCoefficient: c.pan.values as unknown as ProjectSettings['panCoefficient'] } } : input;
		let report: CalibrationReport | null = null;
		let error: string | null = null;
		try {
			report = calibrate(caseInput, {
				model: 'gr4j',
				objective: c.objective,
				bounds: c.bounds,
				seed,
				starts,
				budget,
				validate: true,
				exclusions: ruleRanges,
				...(other ? { validationRecord: other } : {}),
				onProgress: opts.onProgress ? (progress) => opts.onProgress!({ caseIndex: i, cases: combos.length, progress }) : undefined
			});
		} catch (e) {
			error = `the fit failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		if (report?.cancelled) {
			cancelled = true;
			error = 'cancelled';
		}
		let naturalMarMm3: number | null = null;
		const filters: FilterResult[] = [];
		let held: { score: number | null; missing?: string } = { score: null };
		if (report && !error) {
			// A run that fails with the fitted parameters fails this case only, never the fits already made.
			try {
				const out = runModel({ ...caseInput, settings: { ...caseInput.settings, gr4j: { ...settings.gr4j, ...report.params } } });
				naturalMarMm3 = naturalMar(out);
				if (rules.filters.wr2012Mar) filters.push(wr2012MarFilter(out.summary.wr2012, settings.wr2012.calibrationPenalty));
				if (rules.filters.typicalParams) filters.push(typicalParamsFilter(report.params, report.free));
				held = heldOutScore(report, rules);
			} catch (e) {
				error = `the run with the fitted parameters failed: ${e instanceof Error ? e.message : String(e)}`;
			}
		}
		cases.push({ ...c, label, report, error, naturalMarMm3, filters, score: held.score, eligible: false, reasons: held.missing ? [held.missing] : [] });
		if (cancelled) break;
	}

	const verdict = selectCase(cases.map((c) => ({ error: c.error, score: c.score, scoreMissing: c.reasons[0], filters: c.filters })));
	cases.forEach((c, i) => {
		c.eligible = verdict.eligible[i]!;
		c.reasons = verdict.reasons[i]!;
	});
	const chosen = cancelled ? null : verdict.chosen;

	if (!rules.signedOff)
		notes.push('These are draft rules, not yet signed off by the hydrologist: the fit they keep is not evidence until they are (Settings → Calibration rules).');
	if (rules.filters.wr2012Mar && cases.some((c) => c.filters.some((f) => f.id === 'wr2012Mar' && f.status === 'notApplicable')))
		notes.push('The WR2012 MAR filter could not be applied: there is no WR2012 reference in Settings.');
	if (flagged.exclusions.length) notes.push(`The exclusion rule left out ${flagged.exclusions.length} water year${flagged.exclusions.length === 1 ? '' : 's'}.`);
	if (cancelled) notes.push('Cancelled: no fit is kept.');
	else if (chosen === null) notes.push('No fit passed the rules, so none is kept. The reasons are listed with each fit; the rules, not the result, are what to change.');

	return {
		rules,
		engineVersion: ENGINE_VERSION,
		seed,
		starts,
		budget,
		flowKind: pb.flowKind,
		validationRecord: other,
		years: flagged.years,
		ruleExclusions: flagged.exclusions,
		cases,
		chosen,
		notes,
		cancelled
	};
}
