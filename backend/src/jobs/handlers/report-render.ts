// `report_render`: print a run's catchment report (or its impact report
// against a baseline run, 082) to a PDF, store it, and
// email its link (WP-2.15 Phase B; docs/architecture.md § Server-side
// reports). Queued by POST /projects/:id/reports (any viewer, as themselves)
// and by the tick for a report schedule that is due (as its acting editor).
//
//   REPORT_RENDERER=inline (default): render here, in the local Playwright
//     Chromium (reports/render.ts), store the PDF (STORAGE: MinIO locally),
//     record it and send the mail, all in this job.
//   REPORT_RENDERER=sqs (production): the worker has no Chromium and no
//     internet, so it hands the render to the renderer Lambda through the
//     `render-requests` queue and marks the report `rendering`. The Lambda's
//     answer comes back on `render-results` and becomes a second
//     `report_render` job carrying `result`, which records it and mails.
//
// The render token is issued in its own committed transaction as the acting
// user, because the headless browser presents it on another connection
// (POST /auth/render-session) while this job's transaction is still open.
// A retry issues a fresh one; an unused token dies after 5 minutes.
//
// Inline, the render holds this job's transaction open for its duration
// (seconds; capped by REPORT_RENDER_TIMEOUT_MS), the same trade the inline
// feed fetch makes locally. Production never does this.
import { z } from 'zod';
import { withUser } from '../../db/tx.js';
import { renderOptionsFromEnv, RenderError, renderReportPdf } from '../../reports/render.js';
import { putPdf, reportKey } from '../../reports/storage.js';
import { failReport, finishReport, loadReport } from '../../reports/store.js';
import { issueRenderToken } from '../../reports/tokens.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';
import { type RenderRequestMessage, RenderResult, reportRenderer, sendToQueue } from '../transport.js';

export const ReportRenderPayload = z
	.object({
		reportId: z.string().uuid(),
		/** Production only: the renderer Lambda's answer (render-results). */
		result: RenderResult.optional()
	})
	.strict();

export const reportRenderHandler = defineHandler({
	// The report route shows a viewer everything the PDF holds.
	role: 'viewer',
	payload: ReportRenderPayload,
	async run({ db, job, payload }) {
		const report = await loadReport(db, job.projectId, payload.reportId);
		// Deleted since, or already finished (a redelivered answer): nothing to do.
		if (!report || report.status === 'done' || report.status === 'failed') return;

		if (payload.result) {
			if (!payload.result.ok) return failReport(db, report, `the renderer failed: ${payload.result.error}`);
			return finishReport(db, report, payload.result);
		}

		if (!report.runId) throw new JobError('the run was deleted before its report was made', { retry: false });
		const runId = report.runId;
		// An impact report prints against its baseline, which the acting user must still be able to read (RLS).
		let against: { projectId: string; runId: string } | undefined;
		if (report.impact) {
			const { rows } = report.againstRunId
				? await db.query<{ projectId: string }>('SELECT project_id AS "projectId" FROM model_run WHERE id = $1', [report.againstRunId])
				: { rows: [] };
			if (!rows[0]) throw new JobError("the baseline run was deleted, or its project isn't shared with you any more, before the impact report was made", { retry: false });
			against = { projectId: rows[0].projectId, runId: report.againstRunId! };
		}
		// Committed now, on its own connection: the renderer uses it before this job commits.
		const token = await withUser(job.actingUserId, (tx) => issueRenderToken(tx, job.projectId, runId, against?.runId));

		if (reportRenderer() === 'sqs') {
			const message: RenderRequestMessage = { v: 1, type: 'render', reportId: report.id, projectId: job.projectId, runId, ...(against ? { against } : {}), token };
			await sendToQueue(process.env.RENDER_REQUESTS_QUEUE_URL, 'RENDER_REQUESTS_QUEUE_URL', message);
			await db.query(`UPDATE report SET status = 'rendering' WHERE id = $1`, [report.id]);
			return;
		}

		let rendered;
		try {
			rendered = await renderReportPdf({ projectId: job.projectId, runId, against, token }, renderOptionsFromEnv());
		} catch (err) {
			if (err instanceof RenderError) throw new JobError(err.message, { retry: err.retry });
			throw err;
		}
		try {
			await putPdf(reportKey(job.projectId, report.id), rendered.pdf);
		} catch (err) {
			console.error(`report ${report.id}: storing the PDF failed:`, (err as Error).message);
			throw new JobError('the PDF could not be stored (is object storage running? `pnpm dev:s3:up`)');
		}
		console.log(
			JSON.stringify({ event: 'report_rendered', reportId: report.id, projectId: job.projectId, pages: rendered.pages, bytes: rendered.pdf.length, ms: rendered.ms })
		);
		await finishReport(db, report, { pages: rendered.pages, bytes: rendered.pdf.length });
	}
});
