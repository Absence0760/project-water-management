// The page's side of the import worker (./import.worker.ts). The import
// dialog imports this module dynamically when a workbook is picked, so
// neither it nor the worker (which carries the parser) is in any page chunk.
// One session per picked file: parse(), then any number of extract() calls
// as the user changes options, then close(). cancel() terminates the worker
// at once and rejects the pending call with WorkbookImportCancelled.
import type { ImportResult } from './extract';
import type { FromWorker, ToWorker, WorkbookImportFailure, WorkbookImportOptions, WorkbookImportProgress } from './messages';

export class WorkbookImportCancelled extends Error {
	constructor() {
		super('cancelled');
		this.name = 'WorkbookImportCancelled';
	}
}

/** A failure reported by the worker (or the worker failing to start). */
export class WorkbookImportFailed extends Error {
	constructor(readonly failure: WorkbookImportFailure) {
		super(failure.message);
		this.name = 'WorkbookImportFailed';
	}
}

export interface WorkbookImportSession {
	parse(file: File, options: WorkbookImportOptions, onProgress?: (p: WorkbookImportProgress) => void): Promise<ImportResult>;
	extract(options: WorkbookImportOptions, onProgress?: (p: WorkbookImportProgress) => void): Promise<ImportResult>;
	cancel(): void;
	close(): void;
}

/** A worker-like object: the real Worker, or a fake in the unit tests. */
export interface WorkerLike {
	postMessage(m: ToWorker): void;
	terminate(): void;
	onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
	onerror: ((e: ErrorEvent) => void) | null;
}

export function createWorkbookImport(
	spawn: () => WorkerLike = () => new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
): WorkbookImportSession {
	let worker: WorkerLike | null = null;
	let pending: { resolve: (r: ImportResult) => void; reject: (e: Error) => void; onProgress?: (p: WorkbookImportProgress) => void } | null = null;

	const settle = (fn: (p: NonNullable<typeof pending>) => void) => {
		const p = pending;
		pending = null;
		if (p) fn(p);
	};
	const stop = () => {
		worker?.terminate();
		worker = null;
	};
	const ensure = (): WorkerLike => {
		if (worker) return worker;
		const w = spawn();
		w.onmessage = (e) => {
			const m = e.data;
			if (m.type === 'progress') return pending?.onProgress?.(m.progress);
			if (m.type === 'result') settle((p) => p.resolve(m.result));
			else settle((p) => p.reject(new WorkbookImportFailed(m.error)));
		};
		w.onerror = (e) => {
			stop();
			settle((p) => p.reject(new WorkbookImportFailed({ code: 'internal', message: e.message || 'The workbook reader stopped unexpectedly.' })));
		};
		worker = w;
		return w;
	};
	const send = (m: ToWorker, onProgress?: (p: WorkbookImportProgress) => void) => {
		if (pending) return Promise.reject(new Error('The workbook reader is busy.'));
		return new Promise<ImportResult>((resolve, reject) => {
			pending = { resolve, reject, onProgress };
			ensure().postMessage(m);
		});
	};

	return {
		parse: (file, options, onProgress) => send({ type: 'parse', file, fileName: file.name, options }, onProgress),
		extract: (options, onProgress) =>
			worker ? send({ type: 'extract', options }, onProgress) : Promise.reject(new Error('No workbook has been read yet.')),
		cancel() {
			stop();
			settle((p) => p.reject(new WorkbookImportCancelled()));
		},
		close() {
			stop();
			settle((p) => p.reject(new WorkbookImportCancelled()));
		}
	};
}
