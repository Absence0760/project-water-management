// Renderer Lambda — prints catchment reports to PDF in production
// (REPORT_RENDERER=sqs; docs/architecture.md § Server-side reports,
// infra/reports.tf). A container image (backend/renderer.Dockerfile) with
// Playwright's Chromium, because the worker Lambda (a zip, in the private VPC
// with no internet) can host neither Chromium nor a route to the site.
//
// It runs OUTSIDE the VPC and has no database access and no credentials to
// one: its role may receive from `render-requests`, send to `render-results`,
// and put objects under reports/ in the reports bucket. Nothing else. For
// each request it opens the site like a browser (CloudFront, WAF, the API's
// render-session exchange), prints the report (reports/render.ts), stores the
// PDF under the key derived from the ids, and answers with the outcome only.
// The request's render token is single use and dies in 5 minutes; it is never
// logged.
//
// A request it can't parse is dropped (logged): a retry can't fix it. A
// failed answer throws the record back to SQS (retried, then dead-lettered
// and alarmed); a failed render is an answer (ok: false), not an SQS retry,
// because its token may be spent. The answer's `retry` says whether another
// attempt could succeed (reports/render.ts: only the API's coded refusal of
// the token, the page's own "can't show this", or a page that tried to leave
// are final), and the worker then asks again with a fresh token, after a
// backoff (jobs/handlers/report-render.ts requestRenderAgain).
//
// Like lambda.ts, this must never import a module that loads dotenv.
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { assertLambdaEnv } from './config/production.js';
import { type RenderResult, type RenderResultMessage, parseRenderRequest, sendToQueue } from './jobs/transport.js';
import { renderOptionsFromEnv, RenderError, renderReportPdf } from './reports/render.js';
import { putPdf, reportKey } from './reports/storage.js';
import { logEvent } from './logging/logEvent.js';

// Refuse to start with a local default (config/production.ts).
assertLambdaEnv('renderer');

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const failures: SQSBatchResponse['batchItemFailures'] = [];
	for (const record of event.Records) {
		const req = parseRenderRequest(record.body);
		if (!req) {
			logEvent('warn', { event: 'render_request_ignored', messageId: record.messageId });
			continue;
		}
		let result: RenderResult;
		try {
			const rendered = await renderReportPdf({ projectId: req.projectId, runId: req.runId, against: req.against, token: req.token }, renderOptionsFromEnv());
			await putPdf(reportKey(req.projectId, req.reportId), rendered.pdf);
			result = { ok: true, pages: rendered.pages, bytes: rendered.pdf.length, ms: rendered.ms };
		} catch (err) {
			const e = err instanceof RenderError ? err : new RenderError('the PDF could not be stored');
			if (!(err instanceof RenderError)) logEvent('error', { event: 'report_store_failed', reportId: req.reportId, error: (err as Error).message });
			result = { ok: false, error: e.message.slice(0, 300), retry: e.retry };
		}
		const message: RenderResultMessage = { v: 1, type: 'rendered', reportId: req.reportId, result };
		try {
			await sendToQueue(process.env.RENDER_RESULTS_QUEUE_URL, 'RENDER_RESULTS_QUEUE_URL', message);
		} catch (err) {
			logEvent('error', { event: 'render_result_send_failed', messageId: record.messageId, error: (err as Error).message });
			failures.push({ itemIdentifier: record.messageId });
			continue;
		}
		// Ids and the outcome only: never the token, a URL or page text.
		logEvent('info', {
			event: 'report_rendered',
			reportId: req.reportId,
			projectId: req.projectId,
			ok: result.ok,
			pages: result.ok ? result.pages : 0,
			ms: result.ok ? result.ms : null
		});
	}
	return { batchItemFailures: failures };
};
