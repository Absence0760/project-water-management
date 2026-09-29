// What the audit workbook needs from the API, fetched in the export worker:
// the run (settings, model snapshot, label, engine), the catchment's series
// (its rain) and the farm's, through the bulk route the run workbook pages
// with (docs/api.md § Bulk run series). Then the engine's plan; a farm it
// can't recompute is an error naming why. `fetchFn` is injected so the test
// runs without a server.
import { farmAuditPlan, type FarmAuditPlan, type ModelInput, type RunSummary } from '@water-management/engine';
import { DownloadError } from '$lib/export/download';
import { exportUrls, type WorkbookRequest } from '$lib/export/urls';
import { fetchTable, get, type ExportProgress } from '../export/collect';
import type { DailyTable } from '../export/workbook';
import { auditFilename } from './auditWorkbook';

interface RunResponse {
	run: {
		label: string;
		engineVersion: string;
		summary: RunSummary;
		settings: ModelInput['settings'];
		model: ModelInput['model'];
	};
}

const byKey = (t: DailyTable) => new Map(t.columns.filter((c) => c.key).map((c) => [c.key!, c.values]));

/** The plan, the run's name and engine, and the file name; a DownloadError when the unit can't be recomputed. */
export async function collectAudit(
	req: WorkbookRequest & { auditNodeId: string },
	fetchFn: typeof fetch,
	onProgress: (p: ExportProgress) => void
): Promise<{ plan: FarmAuditPlan; run: { label: string; engineVersion: string }; filename: string }> {
	const urls = exportUrls(req.apiBase);
	onProgress({ phase: 'fetch', done: 0, total: 2, label: 'Catchment' });
	const { run } = (await (await get(fetchFn, urls.run(req.projectId, req.runId))).json()) as RunResponse;
	const catchment = await fetchTable(fetchFn, urls, req, null);
	const name = run.model.nodes.find((n) => n.id === req.auditNodeId)?.name ?? 'unit';
	onProgress({ phase: 'fetch', done: 1, total: 2, label: name });
	const farm = await fetchTable(fetchFn, urls, req, req.auditNodeId);
	onProgress({ phase: 'build', done: 2, total: 2, label: '' });
	const days = Math.max(0, ...farm.columns.map((c) => c.values.length));
	const result = farmAuditPlan(
		{
			settings: run.settings,
			model: run.model,
			startDate: farm.startDate,
			days,
			apanDailyDays: run.summary.apanDaily?.dailyDays ?? 0,
			farm: byKey(farm),
			catchment: byKey(catchment)
		},
		req.auditNodeId
	);
	if (!('plan' in result)) throw new DownloadError(0, `The audit workbook can't recompute ${name} yet: ${result.unsupported.join('; ')}`);
	return { plan: result.plan, run: { label: run.label, engineVersion: run.engineVersion }, filename: auditFilename(run.label, name) };
}
