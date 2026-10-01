// Messages between the page (./runner.ts) and the preview worker
// (./engine.worker.ts). Types only, so importing them costs a page nothing.
//
// The preview worker runs the engine on inputs the page already has, for an
// instant answer that is never stored (roadmap WP-1.17). It answers two
// questions: a dam's firm yield (WP-3.6, the Yield panel's preview), and what
// unsaved edits do to the last run (issue #284, ./overlay.ts). A request
// carries an id; the worker answers with the same id, so the runner
// can drop an answer to a request it has since replaced.
import type { MetricDelta, ModelInput, ScenarioOp, YieldPattern, YieldPoint } from '@water-management/engine';

/** One firm yield, as the `yield` job works it out (backend/src/jobs/handlers/yield.ts, kind 'firm'). */
export interface YieldPreviewRequest {
	/** A run's own input (`GET …/runs/:runId/model-input`): the saved run the job would use, or a scenario's base run. */
	input: ModelInput;
	/** A scenario's ops, applied to `input` first as the job does (a team scenario: no applicant mask). */
	ops?: readonly ScenarioOp[];
	nodeId: string;
	pattern: YieldPattern;
	assurance: number;
	tolerance: number;
}

/** The last run's input and the same input with the unsaved edits laid over it (./overlay.ts). */
export interface EffectPreviewRequest {
	/**
	 * Names the base input (`<project>/<run>`), so the worker runs it once for several previews of one run:
	 * the worker trusts the key and keeps the output it ran for it, which holds because a stored run's
	 * input never changes. A request whose `base` is another input must use another key.
	 */
	baseKey: string;
	/** The last run's own input (`GET …/runs/:runId/model-input`). */
	base: ModelInput;
	/** `base` with the unsaved edits on it. */
	edited: ModelInput;
}

/** One unit's supply in the last run (a) and with the edits (b): only the units whose figures moved. */
export interface UnitEffect {
	name: string;
	fractionSupplied: MetricDelta;
	deficitM3Day: MetricDelta;
}

/**
 * What the edits do, as compareRuns (engine ./compare.ts) reads two runs:
 * a = the last run's input on this build's engine, b = with the edits. Both
 * are run here, so a difference is the edits', never an engine change since
 * the stored run.
 */
export interface PreviewEffect {
	engineVersion: string;
	startDate: string;
	endDate: string;
	totals: { demandM3Day: MetricDelta; suppliedM3Day: MetricDelta; deficitM3Day: MetricDelta; fractionSupplied: MetricDelta; farmsBelowTarget: MetricDelta };
	catchment: { meanNaturalFlowM3Day: MetricDelta; meanSimulatedOutflowM3Day: MetricDelta; ewrDaysNotMet: MetricDelta };
	/** The fit to the observed record; null when neither side has one. */
	calibration: { nse: MetricDelta; kge: MetricDelta; pbias: MetricDelta } | null;
	/** The units whose supply moved, the largest change first. */
	units: UnitEffect[];
	/** Units only in the last run (the edits removed them) and only with the edits (added). */
	removedUnits: string[];
	addedUnits: string[];
}

export type ToWorker = { type: 'yield'; id: number; request: YieldPreviewRequest } | { type: 'effect'; id: number; request: EffectPreviewRequest };

export type FromWorker =
	| { type: 'yield-done'; id: number; point: YieldPoint }
	| { type: 'effect-done'; id: number; effect: PreviewEffect }
	| { type: 'error'; id: number; message: string };
