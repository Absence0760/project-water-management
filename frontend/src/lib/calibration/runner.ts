// Starts a fit, an uncertainty ensemble or the sensitivity runs in a Web Worker. cancel()
// terminates it at once (the engine loop is synchronous, so the worker can't
// be asked to stop; nothing it found is kept, and the worker itself never
// saves anything).
import type { CalibrationProgress, CalibrationReport, EnsembleProgress, EnsembleResult, PairedResult, SensitivityResult } from '@water-management/engine';
import type { EnsembleJob, EnsembleWorkerMessage } from './ensemble';
import type { FitRequest, WorkerMessage } from './fit';
import type { SensitivityJob, SensitivityWorkerMessage } from './sensitivity';
// The worker is a chunk of the page build, so it shares the page's engine
// chunks instead of carrying its own copy (frontend/vite.config.ts, issue #9).
import autocalWorkerUrl from 'virtual:autocal-worker-url';

export interface FitHandle {
	result: Promise<CalibrationReport>;
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
