// The import worker's message handling, apart from the worker global so the
// unit tests can drive it: one message in, progress then exactly one result
// or error out. The reader and extractor are injected (the worker passes
// readWorkbook and extractProject).
import type { ExtractOptions, ImportResult } from './extract';
import { type FromWorker, type ToWorker, toFailure } from './messages';

export interface WorkerState<W> {
	/** The workbook the last 'parse' read, kept for 'extract'. */
	workbook: W | null;
	fileName: string;
}

export interface WorkerDeps<W> {
	read(file: Blob, onProgress: (sheet: string, i: number, n: number) => void): Promise<W>;
	extract(workbook: W, opts: ExtractOptions): ImportResult;
}

export async function handle<W>(m: ToWorker, state: WorkerState<W>, post: (m: FromWorker) => void, deps: WorkerDeps<W>): Promise<void> {
	try {
		if (m.type === 'parse') {
			state.workbook = null;
			state.fileName = m.fileName;
			state.workbook = await deps.read(m.file, (sheet, step, steps) => post({ type: 'progress', progress: { stage: 'read', sheet, step, steps } }));
		}
		if (state.workbook === null) throw new Error('No workbook has been read yet.');
		const result = deps.extract(state.workbook, {
			fileName: state.fileName,
			gaugeAsReference: m.options.gaugeAsReference ?? false,
			onProgress: (sheet, step, steps) => post({ type: 'progress', progress: { stage: 'extract', sheet, step, steps } })
		});
		post({ type: 'result', result });
	} catch (e) {
		post({ type: 'error', error: toFailure(e) });
	}
}
