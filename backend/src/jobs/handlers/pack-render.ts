// `pack_render`: print an issued evidence pack's own page to a PDF, store it
// for good, and record its SHA-256 and page count on the pack once (roadmap
// WP-3.14 "Rendering: reuse WP-2.15", issue #71; docs/evidence-pack.md § The
// PDF, 116_pack_render.sql). Queued by POST …/packs/:packId/issue (and
// POST …/packs/:packId/pdf, an editor's retry while none is recorded), as the
// editor who asked, deduplicated per pack.
//
// The same machinery as report_render (jobs/handlers/report-render.ts):
//   REPORT_RENDERER=inline (default): render here, in the local Playwright
//     Chromium, the pack's page /projects/:id/packs/:packId, store the PDF in
//     the packs bucket (MinIO locally) under packPdfKey, and record it.
//   REPORT_RENDERER=sqs (production): hand the render to the renderer Lambda
//     on `render-requests` (PackRenderRequestMessage). It stores the PDF and
//     answers on `render-results` with the PDF's SHA-256; the worker makes that
//     a second pack_render job carrying `result`, which records it, or asks
//     again after a retryable failure (requestPackRenderAgain).
//
// The render token is issued in its own committed transaction as the acting
// user, for this pack only (render_token.pack_id): the render session reads
// the pack and its sign-offs and nothing else (reports/scope.ts).
//
// The PDF columns are written only through app_record_pack_pdf, which checks
// that this job is running as the caller and derives the key from the ids and
// the hash; the first PDF recorded stands (a redelivered answer, a second
// render: false, nothing changes).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../../db/tx.js';
import { withUser } from '../../db/tx.js';
import { logEvent } from '../../logging/logEvent.js';
import { renderOptionsFromEnv, RenderError, renderReportPdf } from '../../reports/render.js';
import { packPdfKey, putPackPdf } from '../../reports/storage.js';
import { REPORT_MAX_ATTEMPTS } from '../../reports/store.js';
import { issuePackRenderToken } from '../../reports/tokens.js';
import { packRenderDedupeKey } from '../../evidence/packPdf.js';
import { JobError } from '../errors.js';
import { enqueueJob } from '../queue.js';
import { defineHandler } from '../registry.js';
import { type PackRenderRequestMessage, PackRenderResult, reportRenderer, sendToQueue } from '../transport.js';

/**
 * Production's retry after the renderer answered with a retryable failure,
 * as report_render's requestRenderAgain: another request job, delayed
 * 2^n minutes, until REPORT_MAX_ATTEMPTS requests have been made since the
 * last one an editor asked for (the issue, or POST …/pdf). False when they
 * are used up.
 */
export async function requestPackRenderAgain(db: Db, projectId: string, packId: string): Promise<boolean> {
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM job
		 WHERE project_id = $1 AND kind = 'pack_render' AND payload->>'packId' = $2 AND NOT (payload ? 'result')
			AND created_at >= coalesce((SELECT max(created_at) FROM job WHERE project_id = $1 AND kind = 'pack_render' AND dedupe_key = $3), '-infinity')`,
		[projectId, packId, packRenderDedupeKey(packId)]
	);
	const made = rows[0]?.n ?? 0;
	if (made >= REPORT_MAX_ATTEMPTS) return false;
	await enqueueJob(db, {
		projectId,
		kind: 'pack_render',
		payload: { packId },
		dedupeKey: `pack_retry:${packId}:${made}`,
		delaySeconds: 60 * 2 ** made,
		maxAttempts: REPORT_MAX_ATTEMPTS
	});
	return true;
}

export const PackRenderPayload = z
	.object({
		packId: z.string().uuid(),
		/** Production only: the renderer Lambda's answer (render-results). */
		result: PackRenderResult.optional()
	})
	.strict();

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Record the PDF on the pack (app_record_pack_pdf). False: one was recorded already, and it stands. */
async function recordPdf(db: Db, packId: string, sha256: string, pages: number): Promise<boolean> {
	const { rows } = await db.query<{ recorded: boolean }>('SELECT app_record_pack_pdf($1, $2, $3) AS recorded', [packId, sha256, pages]);
	return rows[0]?.recorded ?? false;
}

export const packRenderHandler = defineHandler({
	// Queued by the editor who issued the pack (or asked again); only editors enqueue jobs of this kind (job_insert).
	role: 'editor',
	payload: PackRenderPayload,
	async run({ db, job, payload }) {
		const { rows } = await db.query<{ issued: boolean; hasPdf: boolean }>(
			'SELECT issued_at IS NOT NULL AS issued, pdf_key IS NOT NULL AS "hasPdf" FROM evidence_pack WHERE project_id = $1 AND id = $2',
			[job.projectId, payload.packId]
		);
		const pack = rows[0];
		if (!pack) throw new JobError('the evidence pack is gone, or you can no longer see it', { retry: false });
		// Recorded already (a redelivered answer, a second request): the first PDF stands.
		if (pack.hasPdf) return;
		// Only a pack that was issued is printed (a draft, or a draft withdrawn unissued, never is).
		if (!pack.issued) throw new JobError('an evidence pack that was never issued is not printed', { retry: false });

		if (payload.result) {
			if (!payload.result.ok) {
				if (payload.result.retry && (await requestPackRenderAgain(db, job.projectId, payload.packId))) return;
				throw new JobError(`the renderer failed: ${payload.result.error}`, { retry: false });
			}
			const recorded = await recordPdf(db, payload.packId, payload.result.sha256, payload.result.pages);
			logEvent('info', { event: 'pack_pdf_recorded', packId: payload.packId, projectId: job.projectId, pages: payload.result.pages, recorded });
			return;
		}

		// Committed now, on its own connection: the renderer uses it before this job commits.
		const token = await withUser(job.actingUserId, (tx) => issuePackRenderToken(tx, job.projectId, payload.packId));

		if (reportRenderer() === 'sqs') {
			const message: PackRenderRequestMessage = { v: 1, type: 'render_pack', packId: payload.packId, projectId: job.projectId, token };
			await sendToQueue(process.env.RENDER_REQUESTS_QUEUE_URL, 'RENDER_REQUESTS_QUEUE_URL', message);
			return;
		}

		let rendered;
		try {
			rendered = await renderReportPdf({ projectId: job.projectId, packId: payload.packId, token }, renderOptionsFromEnv());
		} catch (err) {
			if (err instanceof RenderError) throw new JobError(err.message, { retry: err.retry });
			throw err;
		}
		if (rendered.pages < 1) throw new JobError('the PDF has no pages');
		const sha256 = sha256Hex(rendered.pdf);
		try {
			await putPackPdf(packPdfKey(job.projectId, payload.packId, sha256), rendered.pdf, sha256);
		} catch (err) {
			console.error(`pack ${payload.packId}: storing the PDF failed:`, (err as Error).message);
			throw new JobError('the PDF could not be stored (is object storage running? `pnpm dev:s3:up`)');
		}
		const recorded = await recordPdf(db, payload.packId, sha256, rendered.pages);
		logEvent('info', { event: 'pack_rendered', packId: payload.packId, projectId: job.projectId, pages: rendered.pages, bytes: rendered.pdf.length, ms: rendered.ms, recorded });
	}
});
