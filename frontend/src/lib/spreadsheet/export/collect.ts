// What the workbook needs from the API, fetched in the export worker: the run
// (summary, settings and model snapshot, the series list), its summary CSV,
// then one bulk request per node (more for a record too long for one page,
// docs/api.md § Bulk run series), reporting progress per node. `fetchFn` is
// injected so collect.test.ts runs without a server.
import type { RunSummary } from '@water-management/engine';
import { DownloadError } from '$lib/export/download';
import { exportUrls, filenameFromDisposition, type WorkbookRequest } from '$lib/export/urls';
import type { DailyTable, WorkbookInput } from './workbook';

export interface ExportProgress {
	/** 'fetch' while nodes are downloaded (done / total nodes, the catchment counted as one), then 'build'. */
	phase: 'fetch' | 'build';
	done: number;
	total: number;
	/** What is being fetched now ("Upper farm"), or '' while building. */
	label: string;
}

interface RunResponse {
	run: { summary: RunSummary; settings?: Record<string, unknown>; model?: { nodes?: { id: string; name: string }[] } & Record<string, unknown> };
	series: { nodeId: string | null }[];
}

interface BulkResponse {
	name: string;
	startDate: string;
	days: number;
	offset: number;
	count: number;
	next: number | null;
	series: { header: string; unit: string | null; values: (number | null)[] }[];
}

/** GET with the session cookie; throw a DownloadError carrying the server's message, as the CSV downloads do. */
async function get(fetchFn: typeof fetch, url: string): Promise<Response> {
	let res: Response;
	try {
		res = await fetchFn(url, { credentials: 'include' });
	} catch {
		throw new DownloadError(0, 'Could not reach the server');
	}
	if (res.ok) return res;
	let msg = '';
	try {
		const body = (await res.json()) as { error?: unknown };
		if (typeof body.error === 'string') msg = body.error;
	} catch {
		/* not JSON */
	}
	throw new DownloadError(
		res.status,
		msg ||
			(res.status === 401 ? 'You are not signed in' : res.status === 404 ? 'Not found — the run may have been deleted' : `Download failed (${res.status})`)
	);
}

/** One node's (or the catchment's) every series, following `next` until the last page. */
async function fetchTable(fetchFn: typeof fetch, urls: ReturnType<typeof exportUrls>, req: WorkbookRequest, nodeId: string | null): Promise<DailyTable> {
	let offset: number | null = 0;
	let first: BulkResponse | null = null;
	let columns: (number | null)[][] = [];
	while (offset !== null) {
		const page = (await (await get(fetchFn, urls.runBulk(req.projectId, req.runId, nodeId, offset))).json()) as BulkResponse;
		if (!first) {
			first = page;
			columns = page.series.map(() => new Array<number | null>(page.days));
		}
		if (page.offset !== offset || page.series.length !== columns.length) throw new DownloadError(0, 'The run changed while it was downloading; try again');
		page.series.forEach((s, c) => {
			const col = columns[c]!;
			for (let i = 0; i < s.values.length; i++) col[page.offset + i] = s.values[i]!;
		});
		offset = page.next;
	}
	return {
		name: nodeId ? first!.name : 'Catchment',
		startDate: first!.startDate,
		columns: first!.series.map((s, c) => ({ header: s.header, unit: s.unit, values: columns[c]! }))
	};
}

/**
 * Everything buildWorkbook needs, and the file name: the summary CSV's
 * (`<project>_<run>_summary_<date>.csv`) with `workbook` for `summary`.
 */
export async function collectWorkbookInput(
	req: WorkbookRequest,
	fetchFn: typeof fetch,
	onProgress: (p: ExportProgress) => void
): Promise<{ input: WorkbookInput; filename: string }> {
	const urls = exportUrls(req.apiBase);
	const { run, series } = (await (await get(fetchFn, urls.run(req.projectId, req.runId))).json()) as RunResponse;
	const csvRes = await get(fetchFn, urls.runSummary(req.projectId, req.runId));
	const summaryCsv = await csvRes.text();
	const csvName = filenameFromDisposition(csvRes.headers.get('content-disposition'), 'run_summary.csv');
	const filename = /_summary_(\d{4}-\d{2}-\d{2})\.csv$/.test(csvName) ? csvName.replace(/_summary_(\d{4}-\d{2}-\d{2})\.csv$/, '_workbook_$1.xlsx') : 'run_workbook.xlsx';

	// Nodes with series, in the run's network order (its model snapshot); any the snapshot lacks go last.
	const withSeries = new Set(series.map((s) => s.nodeId).filter((id): id is string => id !== null));
	const order = (run.model?.nodes ?? []).map((n) => n.id).filter((id) => withSeries.has(id));
	const nodeIds = [...order, ...[...withSeries].filter((id) => !order.includes(id))];
	const names = new Map((run.model?.nodes ?? []).map((n) => [n.id, n.name]));
	const hasCatchment = series.some((s) => s.nodeId === null);
	const total = nodeIds.length + (hasCatchment ? 1 : 0);

	let done = 0;
	let catchment: DailyTable | null = null;
	if (hasCatchment) {
		onProgress({ phase: 'fetch', done, total, label: 'Catchment' });
		catchment = await fetchTable(fetchFn, urls, req, null);
		done++;
	}
	const nodes: DailyTable[] = [];
	for (const id of nodeIds) {
		onProgress({ phase: 'fetch', done, total, label: names.get(id) ?? 'node' });
		nodes.push(await fetchTable(fetchFn, urls, req, id));
		done++;
	}
	onProgress({ phase: 'build', done, total, label: '' });
	// A forecast run (WP-2.12): every daily sheet leads with the forecast flag, as the daily CSVs do.
	const flagged = (t: DailyTable | null) => (t && run.summary.forecast ? withForecastFlag(t, run.summary.forecast.from) : t);
	return {
		input: {
			summaryCsv,
			summary: run.summary,
			settings: run.settings,
			model: run.model,
			catchment: flagged(catchment),
			nodes: nodes.map((t) => flagged(t)!),
			// The worker runs on the site's own origin: the disclaimer's Terms URL.
			site: globalThis.location?.origin ?? ''
		},
		filename
	};
}

/** The header of the forecast flag column (1 on a forecast day, 0 before), first after the date. */
export const FORECAST_FLAG_HEADER = 'forecast (1 = modelled on forecast rain)';

/** `table` with the forecast flag column in front: 1 from `from` (a forecast run's first forecast day), 0 before. */
export function withForecastFlag(table: DailyTable, from: string): DailyTable {
	const length = Math.max(0, ...table.columns.map((c) => c.values.length));
	const cut = Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${table.startDate}T00:00:00Z`)) / 86_400_000);
	const values = Array.from({ length }, (_, i) => (i >= cut ? 1 : 0));
	return { ...table, columns: [{ header: FORECAST_FLAG_HEADER, unit: null, values }, ...table.columns] };
}
