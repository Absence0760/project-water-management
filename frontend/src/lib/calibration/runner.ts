// Starts a fit, an uncertainty ensemble or the sensitivity runs in a Web Worker. cancel()
// terminates it at once (the engine loop is synchronous, so the worker can't
// be asked to stop; nothing it found is kept, and the worker itself never
// saves anything).
import {
	gr4jOfParamSet,
	withLocationParams,
	normalizedInput,
	type CalibrationPrior,
	type CalibrationProgress,
	type CalibrationReport,
	type EnsembleProgress,
	type EnsembleResult,
	type PairedResult,
	type SensitivityResult,
	type StepwiseProgress,
	type ZoneFitPlanStep,
	type ZoneFitStep
} from '@water-management/engine';
import type { EnsembleJob, EnsembleWorkerMessage } from './ensemble';
import type { FitRequest, WorkerMessage } from './fit';
import type { SensitivityJob, SensitivityWorkerMessage } from './sensitivity';
// The worker is a chunk of the page build, so it shares the page's engine
// chunks instead of carrying its own copy (frontend/vite.config.ts, issue #9).
import autocalWorkerUrl from 'virtual:autocal-worker-url';

export interface FitHandle {
	/** The fit's report: the headline location's step's (issue #659), else the last step's. */
	result: Promise<CalibrationReport>;
	/** A stepwise fit's every step, in dependency order (issue #659); absent for one fit. Settles with `result`. */
	steps?: Promise<ZoneFitStep[]>;
	cancel(): void;
}

export class FitCancelled extends Error {
	constructor() {
		super('cancelled');
	}
}

/** One job in a fresh worker: its messages go to `onMessage`, which settles the result through `done`. */
function startWorker<T, M extends { type: string }>(req: unknown, onMessage: (m: M, done: (v: T) => void) => void): { result: Promise<T>; cancel(): void } {
	const worker = new Worker(autocalWorkerUrl, { type: 'module' });
	let settle: { reject(e: Error): void } | null = null;
	const result = new Promise<T>((resolve, reject) => {
		settle = { reject };
		worker.onmessage = (e: MessageEvent<M>) => {
			const m = e.data;
			if (m.type === 'error') {
				worker.terminate();
				reject(new Error((m as unknown as { message: string }).message));
				return;
			}
			onMessage(m, (v) => {
				worker.terminate();
				resolve(v);
			});
		};
		worker.onerror = (e) => {
			worker.terminate();
			reject(new Error(e.message || 'the calibration worker failed'));
		};
	});
	worker.postMessage(req);
	return {
		result,
		cancel() {
			worker.terminate();
			settle?.reject(new FitCancelled());
		}
	};
}

export function startFit(req: FitRequest, onProgress: (p: CalibrationProgress) => void): FitHandle {
	return startWorker<CalibrationReport, WorkerMessage>(req, (m, done) => {
		if (m.type === 'progress') onProgress(m.progress);
		else if (m.type === 'done') done(m.report);
	});
}

/**
 * The stepwise fit of the calibration locations (issue #659, engine calibrateStepwise, docs/model.md §2.10n), one
 * worker per step of the engine's plan (locationFitPlan: dependency order, the headline last among the ready ones):
 * each step fits its location's group on the input with the locations before it at their fitted parameters, as the
 * engine's calibrateStepwise does. cancel() stops the step running and every one after it.
 */
export function startStepwiseFit(
	req: FitRequest,
	plan: readonly ZoneFitPlanStep[],
	onProgress: (p: StepwiseProgress) => void,
	/** The regional prior per step, built for that step's zone (issue #622), by priorKey: each zone takes its own, never the catchment's. */
	priors?: Readonly<Record<string, CalibrationPrior>>
): FitHandle {
	let current: FitHandle | null = null;
	let cancelled = false;
	const run = async (): Promise<ZoneFitStep[]> => {
		const done: ZoneFitStep[] = [];
		// In the locations shape once, so every step's parameters land where the engine reads them (normalizeCalibrationLocations).
		let input = normalizedInput(req.input);
		for (const [i, step] of plan.entries()) {
			if (cancelled) throw new FitCancelled();
			const { prior: _one, ...rest } = req;
			const prior = priors?.[step.zoneNodeId ?? ''];
			current = startFit({ ...rest, input, zone: step.zoneNodeId, ...(prior ? { prior } : {}) }, (p) =>
				onProgress({ ...p, step: i + 1, steps: plan.length, zoneNodeId: step.zoneNodeId })
			);
			const report = await current.result;
			done.push({ ...step, report });
			// Every step's parameters, the outlet location's (null) included (engine 1.110.0: steps run in dependency order).
			input = withLocationParams(input, step.zoneNodeId, gr4jOfParamSet(report.params));
		}
		return done;
	};
	const steps = run();
	return {
		steps,
		// The headline's step: its report is the fit's, whichever step it was (a location below it can depend on it).
		result: steps.then((s) => (s.find((x) => x.headline) ?? s[s.length - 1]!).report),
		cancel() {
			cancelled = true;
			current?.cancel();
		}
	};
}

export interface EnsembleHandle<R> {
	result: Promise<R>;
	cancel(): void;
}

/** Run an uncertainty ensemble, or a paired one, in the calibration worker. */
export function startEnsemble(job: Extract<EnsembleJob, { kind: 'ensemble' }>, onProgress: (p: EnsembleProgress) => void): EnsembleHandle<EnsembleResult>;
export function startEnsemble(job: Extract<EnsembleJob, { kind: 'paired' }>, onProgress: (p: EnsembleProgress) => void): EnsembleHandle<PairedResult>;
export function startEnsemble(job: EnsembleJob, onProgress: (p: EnsembleProgress) => void): EnsembleHandle<EnsembleResult | PairedResult> {
	return startWorker<EnsembleResult | PairedResult, EnsembleWorkerMessage>(job, (m, done) => {
		if (m.type === 'ensemble-progress') onProgress(m.progress);
		else if (m.type === 'ensemble-done') done(m.result);
	});
}

/** Run the sensitivity runs (CR-21, at most 11 model runs) in the calibration worker. */
export function startSensitivity(job: SensitivityJob, onProgress: (p: { done: number; total: number }) => void): EnsembleHandle<SensitivityResult> {
	return startWorker<SensitivityResult, SensitivityWorkerMessage>(job, (m, done) => {
		if (m.type === 'sensitivity-progress') onProgress(m.progress);
		else if (m.type === 'sensitivity-done') done(m.result);
	});
}
