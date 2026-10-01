// Web Worker: reads a b023 workbook and extracts its project off the main
// thread (WP-1.31). It is the only code that imports the parser and the
// streaming workbook reader, so they ship in this worker's bundle and never
// in a page chunk (no SheetJS: the reader is this project's own). Loaded as a
// module worker from 'self' (new Worker(new URL(…), { type: 'module' })),
// which the CSP's `worker-src 'self'` allows; no blob: workers. Cancel = the
// page terminates the worker.
//
// The parsed workbook stays here between messages, so changing an option on
// the review screen (the gauge as a reference) re-extracts in milliseconds
// instead of reading the file again. The protocol lives in ./protocol.ts.
//
// It also reads a node-based workbook's crop sheets for the Load crop
// factors dialog ('nodeCrops', ./nodeCrops.ts): only those two sheets are
// parsed, and nothing is kept for a later 'extract'.
import { WorkbookTooLargeError } from './errors';
import { extractProject } from './extract';
import type { FromWorker, ToWorker } from './messages';
import { readNodeCropWorkbook } from './nodeCrops';
import { handle, type WorkerState } from './protocol';
import type { WorkbookSource } from './source';
import { MAX_WORKBOOK_BYTES, readWorkbook } from './workbook';

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

const state: WorkerState<WorkbookSource> = { workbook: null, fileName: '' };

self.onmessage = (e: MessageEvent<ToWorker>) =>
	handle(e.data, state, post, {
		async read(file, onProgress) {
			// Refused before any of it is read. The File itself goes to the
			// reader, which reads only the parts it needs, a slice at a time,
			// never the whole file into memory (issue #23).
			if (file.size > MAX_WORKBOOK_BYTES) throw new WorkbookTooLargeError('bytes', file.size, MAX_WORKBOOK_BYTES);
			return readWorkbook(file, { onProgress });
		},
		extract: extractProject,
		// readWorkbook refuses a file over MAX_WORKBOOK_BYTES before reading any of it.
		readNodeCrops: (file, fileName, onProgress) => readNodeCropWorkbook(file, fileName, { onProgress })
	});
