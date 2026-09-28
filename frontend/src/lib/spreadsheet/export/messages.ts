// Messages between the page (runner.ts) and the export worker.
import type { WorkbookRequest } from '$lib/export/urls';
import type { ExportProgress } from './collect';

export type ToWorker = { type: 'start'; request: WorkbookRequest };

export type FromWorker =
	| { type: 'progress'; progress: ExportProgress }
	| { type: 'done'; bytes: Uint8Array<ArrayBuffer>; filename: string }
	| { type: 'error'; message: string };

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
