// Messages between the page (runner.ts) and the export worker.
import type { WorkbookRequest } from '$lib/export/urls';
import type { ExportProgress } from './collect';

export type ToWorker = { type: 'start'; request: WorkbookRequest };

export type FromWorker =
	| { type: 'progress'; progress: ExportProgress }
	| { type: 'done'; bytes: Uint8Array<ArrayBuffer>; filename: string }
	| { type: 'error'; message: string };

/**
 * The worker's one request, checked before anything is fetched: an object
 * `{ type: 'start', request }` whose ids are non-empty strings, and nothing
 * else. The only sender is the page that made the worker (runner.ts), so this
 * is a shape check, not a trust boundary: a malformed message gives null and
 * the worker answers it with an error instead of half-running it.
 */
export function parseStartMessage(data: unknown): ToWorker | null {
	if (!isObj(data) || data.type !== 'start' || !onlyKeys(data, ['type', 'request'])) return null;
	const r = data.request;
	if (!isObj(r) || !onlyKeys(r, ['apiBase', 'projectId', 'runId', 'auditNodeId'])) return null;
	if (typeof r.apiBase !== 'string' || !isId(r.projectId) || !isId(r.runId)) return null;
	if (r.auditNodeId !== undefined && !isId(r.auditNodeId)) return null;
	const request: WorkbookRequest = { apiBase: r.apiBase, projectId: r.projectId, runId: r.runId };
	if (r.auditNodeId !== undefined) request.auditNodeId = r.auditNodeId;
	return { type: 'start', request };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
