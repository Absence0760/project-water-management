// Starts a fit in a Web Worker. cancel() terminates it at once (the engine
// loop is synchronous, so the worker can't be asked to stop; nothing it found
// is kept, and nothing is ever saved by a fit).
import type { CalibrationProgress, CalibrationReport } from '@water-management/engine';
import type { FitRequest, WorkerMessage } from './fit';

export interface FitHandle {
	result: Promise<CalibrationReport>;
	cancel(): void;
}

export class FitCancelled extends Error {
	constructor() {
		super('cancelled');
	}
}

export function startFit(req: FitRequest, onProgress: (p: CalibrationProgress) => void): FitHandle {
	const worker = new Worker(new URL('./autocal.worker.ts', import.meta.url), { type: 'module' });
	let settle: { reject(e: Error): void } | null = null;
	const result = new Promise<CalibrationReport>((resolve, reject) => {
		settle = { reject };
		worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
			const m = e.data;
			if (m.type === 'progress') onProgress(m.progress);
			else {
				worker.terminate();
				if (m.type === 'done') resolve(m.report);
				else reject(new Error(m.message));
			}
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
