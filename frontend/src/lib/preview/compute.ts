// What the preview worker (./engine.worker.ts) computes, apart from the
// worker plumbing so the unit tests call it directly. Imports the engine's
// run code: only the worker may import this module (a page importing it would
// ship the model in a page chunk; the bundle guard's worker checks and
// src/lib/preview/compute.test.ts's import scan say so).
import { applyScenario, firmYield, prepareYield, type YieldPoint } from '@water-management/engine';
import type { FromWorker, ToWorker, YieldPreviewRequest } from './messages';

/**
 * A dam's yield worked out as the `yield` job does for kind 'firm'
 * (backend/src/jobs/handlers/yield.ts): a scenario's ops applied to its base
 * run's input (refused if any op doesn't apply, as the job is), then
 * prepareYield and one firmYield search. The same engine calls on the same
 * input give the same point.
 */
export function previewYield(req: YieldPreviewRequest): YieldPoint {
	let input = req.input;
	if (req.ops?.length) {
		const check = applyScenario(input, req.ops);
		if (check.problems.length) throw new Error(`an op of this scenario doesn't apply to its base run: ${check.problems.join('; ')}`);
		input = check.input;
	}
	let problem;
	try {
		problem = prepareYield(input);
	} catch (err) {
		throw new Error(`the model can't run this input: ${(err as Error).message}`);
	}
	return firmYield(problem, req.nodeId, { pattern: req.pattern, assurance: req.assurance, tolerance: req.tolerance });
}

/** The worker's answer to one message: the point, or the engine's words (never a stack). */
export function handle(msg: ToWorker): FromWorker {
	try {
		return { type: 'yield-done', id: msg.id, point: previewYield(msg.request) };
	} catch (err) {
		return { type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) };
	}
}
