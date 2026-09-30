// Messages between the page (./runner.ts) and the preview worker
// (./engine.worker.ts). Types only, so importing them costs a page nothing.
//
// The preview worker runs the engine on inputs the page already has, for an
// instant answer that is never stored (roadmap WP-1.17). So far it answers
// one question: a dam's firm yield (WP-3.6, the Yield panel's preview). A
// request carries an id; the worker answers with the same id, so the runner
// can drop an answer to a request it has since replaced.
import type { ModelInput, ScenarioOp, YieldPattern, YieldPoint } from '@water-management/engine';

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

export type ToWorker = { type: 'yield'; id: number; request: YieldPreviewRequest };

export type FromWorker = { type: 'yield-done'; id: number; point: YieldPoint } | { type: 'error'; id: number; message: string };
