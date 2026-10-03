// `applicant_pack_render`: print an application's party's own page of an
// issued evidence pack (/projects/:id/scenarios/:sid/packs/:packId, the D2
// projection: their own units by name, every other water user withheld) to
// a PDF, as that party, store it beside the pack's own PDF and record its
// SHA-256 once (165_applicant_copy; licensing build item 12, provisional
// position, pre-counsel research, 2026-10-01; docs/evidence-pack.md
// § Applicants). The copy is derived, not the pack: it says so on its face,
// with the pack's code and manifest hash, and has its own hash.
//
// Queued by a party of the application (POST …/scenarios/:sid/packs/:packId/pdf),
// as themselves, one pending per pack. The same machinery as pack_render
// (jobs/handlers/pack-render.ts): REPORT_RENDERER=inline renders here;
// REPORT_RENDERER=sqs hands the render to the renderer Lambda with the
// application's id (PackRenderRequestMessage.scenarioId), which stores the
// PDF under applicantPackPdfKey and answers `copy: 'applicant'`, becoming a
// second job of this kind carrying `result`, recorded once the packs bucket
// is seen to hold it.
//
// The render token (purpose 'applicant_pack') is the party's, for this pack
// only: the session reads the party's pack page and nothing else
// (reports/scope.ts). app_record_applicant_pack_pdf writes the record, only
// from the caller's own running job of this pack.
import { z } from 'zod';
import type { Db } from '../../db/tx.js';
import { withUser } from '../../db/tx.js';
import { logEvent } from '../../logging/logEvent.js';
import { renderOptionsFromEnv, RenderError, renderReportPdf } from '../../reports/render.js';
import { applicantPackPdfKey, headPackPdf, putPackPdf } from '../../reports/storage.js';
import { REPORT_MAX_ATTEMPTS } from '../../reports/store.js';
import { issueApplicantPackRenderToken } from '../../reports/tokens.js';
import { JobError } from '../errors.js';
import { enqueueJob } from '../queue.js';
import { defineHandler } from '../registry.js';
import { type PackRenderRequestMessage, PackRenderResult, reportRenderer, sendToQueue } from '../transport.js';
import { sha256Hex } from './pack-render.js';
import { applicantCopyDedupeKey, applicantCopyRetryDedupeKey } from '../../evidence/applicantCopy.js';


export const ApplicantPackRenderPayload = z
	.object({
		packId: z.string().uuid(),
		/** Production only: the renderer Lambda's answer (render-results). */
		result: PackRenderResult.optional()
	})
	.strict();

/** As requestPackRenderAgain: another request job, delayed 2^n minutes, until REPORT_MAX_ATTEMPTS since the party last asked. */
export async function requestApplicantCopyAgain(db: Db, projectId: string, packId: string, userId: string): Promise<boolean> {
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM job
		 WHERE project_id = $1 AND kind = 'applicant_pack_render' AND payload->>'packId' = $2 AND NOT (payload ? 'result')
			AND created_at >= coalesce((SELECT max(created_at) FROM job WHERE project_id = $1 AND kind = 'applicant_pack_render' AND dedupe_key = $3), '-infinity')`,
		[projectId, packId, applicantCopyDedupeKey(packId, userId)]
	);
	const made = rows[0]?.n ?? 0;
	if (made >= REPORT_MAX_ATTEMPTS) return false;
	await enqueueJob(db, {
		projectId,
		kind: 'applicant_pack_render',
		payload: { packId },
		dedupeKey: applicantCopyRetryDedupeKey(packId, userId, made),
		delaySeconds: 60 * 2 ** made,
		maxAttempts: REPORT_MAX_ATTEMPTS
	});
	return true;
}

/** Record the copy (app_record_applicant_pack_pdf). False: one was recorded already, and it stands. */
async function recordCopy(db: Db, packId: string, sha256: string, pages: number): Promise<boolean> {
	const { rows } = await db.query<{ recorded: boolean }>('SELECT app_record_applicant_pack_pdf($1, $2, $3) AS recorded', [packId, sha256, pages]);
	return rows[0]?.recorded ?? false;
}

export const applicantPackRenderHandler = defineHandler({
	// A party of the application: a contributor (the applicant, or someone they shared it with), as yield's
	// alsoRole, or an editor who is one. The handler checks the party (app_applicant_pack_meta) whatever the role.
	role: 'editor',
	alsoRole: 'contributor',
	payload: ApplicantPackRenderPayload,
	async run({ db, job, payload }) {
		const { rows } = await db.query<{ m: { scenarioId?: unknown } | null }>('SELECT app_applicant_pack_meta($1, $2) AS m', [job.projectId, payload.packId]);
		const scenarioId = rows[0]?.m?.scenarioId;
		if (typeof scenarioId !== 'string') throw new JobError('the evidence pack was never issued, or it isn’t one of your applications’ any more', { retry: false });
		const { rows: done } = await db.query('SELECT 1 FROM evidence_pack_applicant_copy WHERE pack_id = $1', [payload.packId]);
		// Recorded already (a redelivered answer, a second request): the first copy stands.
		if (done.length) return;

		if (payload.result) {
			if (!payload.result.ok) {
				if (payload.result.retry && (await requestApplicantCopyAgain(db, job.projectId, payload.packId, job.actingUserId))) return;
				throw new JobError(`the renderer failed: ${payload.result.error}`, { retry: false });
			}
			// As the pack's own PDF: recorded only when the packs bucket holds it under that hash, with that checksum.
			const key = applicantPackPdfKey(job.projectId, payload.packId, payload.result.sha256);
			const held = await headPackPdf(key, payload.result.sha256);
			if (!held.ok) {
				logEvent('warn', { event: 'applicant_copy_answer_refused', packId: payload.packId, projectId: job.projectId, reason: held.reason });
				throw new JobError(
					held.reason === 'missing'
						? 'the renderer’s answer names a PDF the packs bucket does not hold; nothing was recorded'
						: 'the stored PDF’s checksum is not the hash the renderer answered with; nothing was recorded',
					{ retry: false }
				);
			}
			const recorded = await recordCopy(db, payload.packId, payload.result.sha256, payload.result.pages);
			logEvent('info', { event: 'applicant_copy_recorded', packId: payload.packId, projectId: job.projectId, pages: payload.result.pages, recorded });
			return;
		}

		// Committed now, on its own connection: the renderer uses it before this job commits.
		const token = await withUser(job.actingUserId, (tx) => issueApplicantPackRenderToken(tx, job.projectId, payload.packId));

		if (reportRenderer() === 'sqs') {
			const message: PackRenderRequestMessage = { v: 1, type: 'render_pack', packId: payload.packId, projectId: job.projectId, scenarioId, token };
			await sendToQueue(process.env.RENDER_REQUESTS_QUEUE_URL, 'RENDER_REQUESTS_QUEUE_URL', message);
			return;
		}

		let rendered;
		try {
			rendered = await renderReportPdf({ projectId: job.projectId, packId: payload.packId, scenarioId, token }, renderOptionsFromEnv());
		} catch (err) {
			if (err instanceof RenderError) throw new JobError(err.message, { retry: err.retry });
			throw err;
		}
		if (rendered.pages < 1) throw new JobError('the PDF has no pages');
		const sha256 = sha256Hex(rendered.pdf);
		try {
			await putPackPdf(applicantPackPdfKey(job.projectId, payload.packId, sha256), rendered.pdf, sha256);
		} catch (err) {
			console.error(`pack ${payload.packId}: storing the applicant's copy failed:`, (err as Error).message);
			throw new JobError('the PDF could not be stored (is object storage running? `pnpm dev:s3:up`)');
		}
		const recorded = await recordCopy(db, payload.packId, sha256, rendered.pages);
		logEvent('info', { event: 'applicant_copy_rendered', packId: payload.packId, projectId: job.projectId, pages: rendered.pages, bytes: rendered.pdf.length, ms: rendered.ms, recorded });
	}
});
