// An issued evidence pack's PDF from the API's side (116_pack_render;
// docs/evidence-pack.md § The PDF): queue its render, say how far it is, and
// the download. The render itself is jobs/handlers/pack-render.ts.
import type { Db } from '../db/tx.js';
import { enqueueJob } from '../jobs/queue.js';
import { REPORT_MAX_ATTEMPTS } from '../reports/store.js';

/** The dedupe key of an editor's request for a pack's render: one pending per pack. */
export const packRenderDedupeKey = (packId: string) => `pack_render:${packId}`;

/**
 * Queue a pack's render as the transaction's user (an editor: job_insert's
 * RLS). `created` is false when one is pending already. Wake the worker after
 * the commit (jobs/wake.ts).
 */
export async function queuePackRender(db: Db, projectId: string, packId: string): Promise<{ jobId: string; created: boolean }> {
	const { job, created } = await enqueueJob(db, {
		projectId,
		kind: 'pack_render',
		payload: { packId },
		dedupeKey: packRenderDedupeKey(packId),
		maxAttempts: REPORT_MAX_ATTEMPTS
	});
	return { jobId: job.id, created };
}

/**
 * Where a pack's PDF is: `ready` (recorded: pdfSha256 is set), `rendering`
 * (a render job is queued, running, or waiting to retry), `failed` (the last
 * render gave up: `error` says why; an editor asks again with POST …/pdf), or
 * `none` (a draft, or never asked for).
 */
export interface PackPdfState {
	status: 'ready' | 'rendering' | 'failed' | 'none';
	error: string | null;
}

/** A pack's PDF state (RLS: the caller reads the pack's jobs as a viewer). */
export async function packPdfState(db: Db, projectId: string, packId: string, recorded: boolean): Promise<PackPdfState> {
	if (recorded) return { status: 'ready', error: null };
	const { rows } = await db.query<{ status: string; error: string | null }>(
		`SELECT status, last_error AS error FROM job WHERE project_id = $1 AND kind = 'pack_render' AND payload->>'packId' = $2
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		[projectId, packId]
	);
	const job = rows[0];
	if (!job) return { status: 'none', error: null };
	// A done job without a PDF was a request handed to the renderer (production): its answer is still to come.
	if (job.status === 'dead') return { status: 'failed', error: job.error };
	return { status: 'rendering', error: null };
}
