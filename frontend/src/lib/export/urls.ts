// URL builders for the backend's download endpoints (docs/api.md § Export),
// plus the menu entries the workspace mounts <DownloadMenu> with. Pure: the
// API base URL is a parameter so tests don't need SvelteKit's $env modules
// (./index.ts binds PUBLIC_API_URL).

export interface DailyWindow {
	/** Inclusive ISO dates; omitted = the whole run / series. */
	from?: string;
	to?: string;
}

export interface DownloadItem {
	/** Menu text, e.g. "Daily series — Farm 1 (CSV)". */
	label: string;
	/** What to fetch; for a workbook, a unique key (it is built in the browser, not downloaded). */
	url: string;
	/** Optional second line under the label. */
	hint?: string;
	/** Build this run's .xlsx workbook in a Web Worker instead of fetching `url` ($lib/spreadsheet/export). */
	workbook?: WorkbookRequest;
	/** When set, the menu offers a Preview beside the entry, which calls this (the in-page table). */
	preview?: () => void;
}

/** What the workbook export worker needs to fetch a run. */
export interface WorkbookRequest {
	apiBase: string;
	projectId: string;
	runId: string;
	/** Build this farm's audit workbook instead of the run's ($lib/spreadsheet/audit, issue #68). */
	auditNodeId?: string;
}

/** The all-farms tables the run menu offers (farms.csv?key=…), and what a preview of one needs. */
export interface FarmTableItem {
	key: 'runoff' | 'ewr';
	label: string;
	url: string;
	hint: string;
}

export function exportUrls(baseUrl: string) {
	const base = baseUrl.replace(/\/+$/, '');
	const enc = encodeURIComponent;
	const p = (id: string) => `${base}/projects/${enc(id)}`;
	const query = (params: Record<string, string | null | undefined>) => {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
		const s = q.toString();
		return s ? `?${s}` : '';
	};
	return {
		/** The API base these URLs are built on (the workbook worker builds its own from it). */
		apiBase: base,
		/** A run with its summary, settings and model snapshot, and its series list. */
		run: (projectId: string, runId: string) => `${p(projectId)}/runs/${enc(runId)}`,
		/** Every series of one node (the catchment's when `nodeId` is null), from day `offset` (docs/api.md § Bulk run series). */
		runBulk: (projectId: string, runId: string, nodeId: string | null = null, offset = 0) =>
			`${p(projectId)}/runs/${enc(runId)}/series/bulk${query({ nodeId, offset: offset ? String(offset) : null })}`,
		/** Every daily series of one node, or of the catchment when `nodeId` is null. */
		runDaily: (projectId: string, runId: string, nodeId: string | null = null, w: DailyWindow = {}) =>
			`${p(projectId)}/runs/${enc(runId)}/export/daily.csv${query({ nodeId, from: w.from, to: w.to })}`,
		/** One farm series (`key`, e.g. runoff = I, ewr = Y) for every farm of the run, a column per farm. */
		runFarms: (projectId: string, runId: string, key: string, w: DailyWindow = {}) =>
			`${p(projectId)}/runs/${enc(runId)}/export/farms.csv${query({ key, from: w.from, to: w.to })}`,
		runSummary: (projectId: string, runId: string) => `${p(projectId)}/runs/${enc(runId)}/export/summary.csv`,
		series: (projectId: string, seriesId: string, w: DailyWindow = {}) =>
			`${p(projectId)}/series/${enc(seriesId)}/export.csv${query({ from: w.from, to: w.to })}`,
		/** The whole project as the JSON document `pnpm import:project` accepts. */
		project: (projectId: string) => `${p(projectId)}/export.json`
	};
}

export type ExportUrls = ReturnType<typeof exportUrls>;

/**
 * The workbook's two fragmentation sheets for one run: every farm side by
 * side, [Fragmented flow] (runoff I) and [Fragmented EWR] (EWR share Y).
 */
export function farmTableItems(urls: ExportUrls, projectId: string, runId: string): FarmTableItem[] {
	return [
		{
			key: 'runoff',
			label: 'Fragmented flow — all hydrological units (CSV)',
			url: urls.runFarms(projectId, runId, 'runoff'),
			hint: 'Each hydrological unit’s runoff [I], a column per hydrological unit, like the workbook sheet'
		},
		{
			key: 'ewr',
			label: 'Fragmented EWR — all hydrological units (CSV)',
			url: urls.runFarms(projectId, runId, 'ewr'),
			hint: 'Each hydrological unit’s EWR share [Y], a column per hydrological unit, like the workbook sheet'
		}
	];
}

/**
 * Menu entries for one run: the whole-run workbook, the summary sheet, the
 * catchment table, the workbook's two fragmentation sheets (only when the run has farms; with
 * `onPreview`, each also offers an in-page preview), then one daily table per
 * node (in the order given — pass them in network order), each farm's
 * followed by its audit workbook (the formulas that recompute it, issue #68).
 */
export function runDownloadItems(
	urls: ExportUrls,
	projectId: string,
	runId: string,
	nodes: readonly { id: string; name: string; kind?: string }[] = [],
	farms: { onPreview?: (item: FarmTableItem) => void } | null = null
): DownloadItem[] {
	return [
		{
			label: 'Workbook (.xlsx)',
			url: `workbook:${urls.run(projectId, runId)}`,
			hint: 'Every table in one file: summary, daily sheets per node, curtailment, EWR grid, inputs',
			workbook: { apiBase: urls.apiBase, projectId, runId }
		},
		{ label: 'Run summary (CSV)', url: urls.runSummary(projectId, runId), hint: 'Per-unit table, catchment and calibration' },
		{ label: 'Daily series — catchment (CSV)', url: urls.runDaily(projectId, runId), hint: 'Natural flow, outflow, EWR, rain…' },
		...(farms
			? farmTableItems(urls, projectId, runId).map((f) => {
					const onPreview = farms.onPreview;
					return { label: f.label, url: f.url, hint: f.hint, ...(onPreview ? { preview: () => onPreview(f) } : {}) };
				})
			: []),
		...nodes.flatMap((n): DownloadItem[] => [
			{ label: `Daily series — ${n.name} (CSV)`, url: urls.runDaily(projectId, runId, n.id) },
			...(n.kind === 'farm'
				? [
						{
							label: `Audit workbook — ${n.name} (.xlsx)`,
							url: `audit:${urls.runDaily(projectId, runId, n.id)}`,
							hint: 'Its daily water balance as live Excel formulas beside the model’s numbers, to recompute it independently',
							workbook: { apiBase: urls.apiBase, projectId, runId, auditNodeId: n.id }
						}
					]
				: [])
		])
	];
}

/** File name from a `Content-Disposition` header, or `fallback` when absent. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
	if (!header) return fallback;
	const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
	if (star) {
		try {
			return decodeURIComponent(star[1]!.trim());
		} catch {
			/* fall through to the plain parameter */
		}
	}
	const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
	const name = (plain?.[1] ?? plain?.[2] ?? '').trim();
	return name || fallback;
}

/** Last path segment of a download URL, used when the server sent no file name. */
export function fallbackFilename(url: string): string {
	const path = url.split('?')[0] ?? '';
	return path.slice(path.lastIndexOf('/') + 1) || 'download';
}
