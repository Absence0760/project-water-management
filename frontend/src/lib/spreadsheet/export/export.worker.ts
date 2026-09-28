// Web Worker: fetches a run and builds its .xlsx workbook off the main
// thread (WP-1.28), with ./writer.ts (no spreadsheet library: issue #9), so
// none of it is in a page chunk. Loaded
// as a module worker from 'self' (new Worker(new URL(…), { type: 'module' })),
// which the CSP's `worker-src 'self'` allows; no blob: workers. Cancel = the
// page terminates the worker, in-flight fetches included.
import { collectWorkbookInput } from './collect';
import type { FromWorker, ToWorker } from './messages';
import { buildWorkbook } from './workbook';

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
	if (e.data.type !== 'start') return;
	try {
		const { input, filename } = await collectWorkbookInput(e.data.request, (...a) => fetch(...a), (progress) => post({ type: 'progress', progress }));
		const bytes = await buildWorkbook(input);
		post({ type: 'done', bytes, filename }, [bytes.buffer]);
	} catch (err) {
		post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
	}
};
