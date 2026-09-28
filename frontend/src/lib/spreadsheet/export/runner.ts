// Starts a workbook export in a Web Worker (./export.worker.ts). The Download
// menu imports this module dynamically, so neither it nor the worker (the
// workbook writer and its fetching, ~10 KB gzip) is in any page chunk. cancel() terminates the worker at
// once, fetches and all; nothing is saved.
import type { WorkbookRequest } from '$lib/export/urls';
import type { ExportProgress } from './collect';
import { XLSX_MIME, type FromWorker, type ToWorker } from './messages';

export class ExportCancelled extends Error {
	constructor() {
		super('cancelled');
		this.name = 'ExportCancelled';
	}
}

export interface WorkbookExport {
	result: Promise<{ blob: Blob; filename: string }>;
	cancel(): void;
}

export function startWorkbookExport(request: WorkbookRequest, onProgress: (p: ExportProgress) => void): WorkbookExport {
	const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
	let reject: (e: Error) => void = () => {};
	const result = new Promise<{ blob: Blob; filename: string }>((resolve, rej) => {
		reject = rej;
		worker.onmessage = (e: MessageEvent<FromWorker>) => {
			const m = e.data;
			if (m.type === 'progress') return onProgress(m.progress);
			worker.terminate();
			if (m.type === 'done') resolve({ blob: new Blob([m.bytes], { type: XLSX_MIME }), filename: m.filename });
			else rej(new Error(m.message));
		};
		worker.onerror = (e) => {
			worker.terminate();
			rej(new Error(e.message || 'the workbook export failed'));
		};
	});
	worker.postMessage({ type: 'start', request } satisfies ToWorker);
	return {
		result,
		cancel() {
			worker.terminate();
			reject(new ExportCancelled());
		}
	};
}
