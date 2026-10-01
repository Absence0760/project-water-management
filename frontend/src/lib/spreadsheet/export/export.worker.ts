// Web Worker: fetches a run and builds its .xlsx workbook (or one farm's
// audit workbook, ../audit) off the main
// thread (WP-1.28), with ./writer.ts (no spreadsheet library: issue #9), so
// none of it is in a page chunk. Loaded
// as a module worker from 'self' (new Worker(new URL(…), { type: 'module' })),
// which the CSP's `worker-src 'self'` allows; no blob: workers. Cancel = the
// page terminates the worker, in-flight fetches included.
import { buildAuditWorkbook } from '../audit/auditWorkbook';
import { collectAudit } from '../audit/collect';
import { collectWorkbookInput } from './collect';
import type { ExportProgress } from './collect';
import { parseStartMessage, type FromWorker } from './messages';
import { buildWorkbook } from './workbook';

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<unknown>) => {
	// A dedicated worker only hears the page that made it (its messages carry
	// an empty origin); refuse anything that names another origin.
	if (e.origin && e.origin !== self.location.origin) return;
	// Checked before anything is fetched. A malformed request ends the export
	// with an error rather than leaving the page waiting.
	const msg = parseStartMessage(e.data);
	if (!msg) return post({ type: 'error', message: 'the workbook export request is malformed' });
	try {
		const request = msg.request;
		const onProgress = (progress: ExportProgress) => post({ type: 'progress', progress });
		// One farm's audit workbook (issue #68), or the whole run's.
		if (request.auditNodeId) {
			const { plan, run, filename } = await collectAudit({ ...request, auditNodeId: request.auditNodeId }, (...a) => fetch(...a), onProgress);
			const bytes = await buildAuditWorkbook({ plan, run, site: globalThis.location?.origin ?? '' });
			post({ type: 'done', bytes, filename }, [bytes.buffer]);
			return;
		}
		const { input, filename } = await collectWorkbookInput(request, (...a) => fetch(...a), onProgress);
		const bytes = await buildWorkbook(input);
		post({ type: 'done', bytes, filename }, [bytes.buffer]);
	} catch (err) {
		post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
	}
};
