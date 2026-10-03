// `delineate`: the catchment above a click too large for the request,
// delineated on the worker (191_delineation_request, docs/design/delineation.md
// § Where it runs). Queued by POST …/map/delineation (delineation/requests.ts
// queueDelineation), as the editor who clicked, when the request stopped at its
// window cap or when they asked for the background.
//
// The same code as the request (delineation/delineate.ts), with the worker's
// larger windows from the one after where the request stopped, and its longer
// budget. The outcome goes on the request in this job's transaction: the
// proposal (stored as the request would store it, superseding the open one)
// or the refusal in the request's own words. A refusal is an outcome, so the
// job is done; only a DEM that couldn't be read fails it, with one retry.
//
// The DEM's tiles are read (ranged S3 reads in production) while this job's
// transaction is open, as pack_reproduce reads its bundle: bounded by the
// budget (delineate.ts JOB_TIME_BUDGET_MS), one job per account at a time.
// The budget also fits the worker Lambda's remaining time (JobContext
// deadline): a job claimed late in a tick, or one cut short by it, goes back
// to the queue for the next tick instead of being killed or wrongly refused.
import { z } from 'zod';
import { configuredDem } from '../../delineation/dem.js';
import { delineate, DelineationRefused, type LargerChannel } from '../../delineation/delineate.js';
import { checkNote, storeProposal } from '../../delineation/proposals.js';
import { ConfluenceAmbiguity, reachFor, ReachNotNear } from '../../delineation/reach.js';
import { cutShort, jobBudget, jobWindowsFrom, MIN_JOB_TIME_MS, REQUEST_COLS, type RequestRow } from '../../delineation/requests.js';
import { ApiError } from '../../http/errors.js';
import { logEvent } from '../../logging/logEvent.js';
import { safeError } from '../../logging/safeError.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const DelineatePayload = z.object({ requestId: z.string().uuid() }).strict();

const CANCELLED = () => new JobError('cancelled', { retry: false });

export const delineateHandler = defineHandler({
	// Only editors delineate (POST …/map/delineation) and write proposals (175's policies).
	role: 'editor',
	payload: DelineatePayload,
	async run({ db, job, payload, progress, deadline }) {
		// Scoped to the job's project: a payload naming another project's request finds nothing.
		const { rows } = await db.query<RequestRow>(`SELECT ${REQUEST_COLS} FROM delineation_request r WHERE r.id = $1 AND r.project_id = $2`, [
			payload.requestId,
			job.projectId
		]);
		const req = rows[0];
		if (!req) throw new JobError('the delineation request is gone, or belongs to another catchment', { retry: false });
		// Superseded by a newer click, or finished by an earlier attempt that committed.
		if (req.status !== 'queued') return;

		const refuse = async (code: string, message: string, larger?: LargerChannel) => {
			await db.query(
				`UPDATE delineation_request SET status = 'refused', refusal_code = $3, refusal = $4, larger = $5, finished_at = now()
				 WHERE id = $1 AND project_id = $2 AND status = 'queued'`,
				[req.id, job.projectId, code, message.slice(0, 1000), larger ? JSON.stringify(larger) : null]
			);
		};

		const dem = configuredDem();
		if (!dem) return refuse('off', 'Delineation is off: the server has no elevation model.');
		const click: [number, number] = [req.click_lon, req.click_lat];
		let near;
		try {
			near = await reachFor(db, click, req.reach);
		} catch (err) {
			// The river network changed since the click was checked: say so, as the request would have.
			if (err instanceof ConfluenceAmbiguity || err instanceof ReachNotNear) return refuse('confluence', err.message);
			throw err;
		}
		const windows = jobWindowsFrom(req.from_window);
		if (windows.length === 0) {
			return refuse('too_large', 'The catchment above that point is larger than the app delineates. Pick an outlet further upstream, or draw or import the boundary.');
		}
		// Within the worker Lambda's time: a job claimed late in a tick goes back to the queue rather than be cut off.
		const budgetMs = jobBudget(deadline, Date.now());
		const later = () => new JobError('The worker had too little time left for it in this run; it runs again shortly.', { retry: true });
		if (budgetMs < MIN_JOB_TIME_MS) throw later();
		let result;
		try {
			result = await delineate(dem, click, {
				windows,
				budgetMs,
				expected: near.reach ? { km2: near.reach.upstreamKm2, reach: `reach ${near.reach.reachId} of ${near.reach.dataset}`, chosen: !!req.reach } : null,
				junction: near.junction,
				keepPoint: req.keep_point,
				// One step a window; a cancel (or a lost lease) stops it before the next.
				onWindow: async (i, of) => {
					if (!(await progress((i / of) * 100))) throw CANCELLED();
				}
			});
		} catch (err) {
			if (err instanceof DelineationRefused) {
				if (err.code === 'too_large' && cutShort(err.windowCells, windows, budgetMs)) throw later();
				return refuse(err.code, err.message, err.larger);
			}
			if (err instanceof JobError) throw err;
			logEvent('error', { event: 'delineation_failed', jobId: job.id, ...safeError(err) });
			throw new JobError('The elevation model could not be read just now.', { retry: true });
		}

		// Locked, then re-read: a newer click may have superseded it while the DEM was read; then nothing is stored.
		const { rows: now } = await db.query<{ status: string }>('SELECT status FROM delineation_request WHERE id = $1 AND project_id = $2 FOR UPDATE', [req.id, job.projectId]);
		if (now[0]?.status !== 'queued') return;
		let proposalId: string;
		try {
			proposalId = (await storeProposal(db, job.projectId, req.click_kind, result, { background: true })).id;
		} catch (err) {
			// Another delineation finished at the same moment (the unique open index): the retry stores this one after it.
			if (err instanceof ApiError && err.status === 409) throw new JobError(err.message, { retry: true });
			throw err;
		}
		await db.query(
			`UPDATE delineation_request SET status = 'proposed', proposal_id = $3, check_note = $4, finished_at = now() WHERE id = $1 AND project_id = $2`,
			[req.id, job.projectId, proposalId, checkNote(result)]
		);
	}
});
