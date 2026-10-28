// A Start or Divide plan routed on the worker (#646 item 3, 272_plan_request,
// docs/design/delineation.md § Where it runs): the `delineate` job's other
// half, for a request with a plan kind (delineation/planRequests.ts queuePlan,
// from POST …/map/start or …/map/divide when the routing stopped at the
// request's last window).
//
// The same code as the route (start.ts startPlanFrom, divide.ts
// dividePlanFrom over subcatchments.ts delineateUnits), with the worker's
// larger windows from the one after where the request stopped, the first
// placed over where it cut the catchment, and the worker's budget. The map is
// read again here, as the editor who asked: a feature deleted since is a
// refusal (`map_changed`), never routed from the stored body alone.
//
// The outcome goes on the request in this job's transaction: the routed
// proposal (stored as the route would, superseding the open one) or the
// refusal. It is `superseded` instead, storing nothing, when the editor has
// moved on: a newer proposal in the project, a Start's quick proposal (the
// fallback) no longer open (applied or discarded), or a model that is no
// longer empty (a Start) or empty (a Divide). As for a click, a refusal is an
// outcome; only a DEM that couldn't be read fails the job, with a retry.
import { DivideBody, dividePlanFrom, divideRouting, readDivideInputs, storeDivideProposal } from '../../delineation/divide.js';
import { configuredDem } from '../../delineation/dem.js';
import { DelineationRefused } from '../../delineation/delineate.js';
import { panReferenceLoader } from '../../delineation/panReference.js';
import { cutShort, jobBudget, jobWindowsFrom, MIN_JOB_TIME_MS, RELEASE_DELAY_SECONDS, type RequestRow } from '../../delineation/requests.js';
import { nodeCount, ProposeBody, readMapInputs, readPlacement, startPlanFrom, startRouting, storeStartProposal } from '../../delineation/start.js';
import { delineateUnits, type Subcatchments } from '../../delineation/subcatchments.js';
import type { Db } from '../../db/tx.js';
import { ApiError } from '../../http/errors.js';
import { logEvent } from '../../logging/logEvent.js';
import { safeError } from '../../logging/safeError.js';
import { JobError, JobRelease } from '../errors.js';
import type { ClaimedJob, JobContext } from '../registry.js';
import { parseAim } from './delineate.js';

/** Why a plan request is superseded rather than routed, or null when it still stands (in the job's transaction). */
export async function movedOn(db: Db, projectId: string, req: Pick<RequestRow, 'id' | 'plan_kind' | 'fallback_proposal_id'>): Promise<string | null> {
	const nodes = await nodeCount(db, projectId);
	if (req.plan_kind === 'start' && nodes > 0) return 'the model has hydrological units now';
	if (req.plan_kind === 'divide' && nodes === 0) return 'the model has no hydrological units now';
	// A proposal made after this request: the editor proposed again, and that one stands (the fallback was made with it).
	// Compared in SQL: the row's timestamp has microseconds, which a JavaScript Date would round away.
	const { rows: newer } = await db.query<{ n: number }>(
		'SELECT count(*)::integer AS n FROM start_proposal WHERE project_id = $1 AND created_at > (SELECT created_at FROM delineation_request WHERE id = $2 AND project_id = $1)',
		[projectId, req.id]
	);
	if (newer[0]!.n > 0) return 'a newer proposal was made';
	if (req.fallback_proposal_id) {
		const { rows } = await db.query<{ status: string }>('SELECT status FROM start_proposal WHERE id = $1 AND project_id = $2', [req.fallback_proposal_id, projectId]);
		if (rows[0]?.status !== 'proposed') return 'the proposal without the order was applied or discarded';
	}
	return null;
}

/** No worker window is larger than where the request stopped. */
export const PAST_THE_WORKER =
	'The catchment reaches beyond the largest area the app routes, even in the background, so the elevation model can’t order or check the units here. Each unit’s area is its own boundary’s: set the order on the Network.';

const CANCELLED = () => new JobError('cancelled', { retry: false });

export async function runPlanJob(ctx: Pick<JobContext<unknown>, 'db' | 'progress' | 'deadline'> & { job: Readonly<ClaimedJob> }, req: RequestRow): Promise<void> {
	const { db, job } = ctx;
	const finish = async (sql: string, params: unknown[]) => {
		await db.query(`UPDATE delineation_request SET ${sql}, finished_at = now() WHERE id = $1 AND project_id = $2 AND status = 'queued'`, [req.id, job.projectId, ...params]);
	};
	const refuse = (code: string, message: string) => finish(`status = 'refused', refusal_code = $3, refusal = $4`, [code, message.slice(0, 1000)]);
	const supersede = async (why: string) => {
		logEvent('info', { event: 'plan_request_superseded', jobId: job.id, why });
		await finish(`status = 'superseded'`, []);
	};

	const kind = req.plan_kind!;
	const body = kind === 'start' ? ProposeBody.safeParse(req.plan_body) : DivideBody.safeParse(req.plan_body);
	// The body was checked by the route that stored it; one that no longer parses (a schema change since) can't be routed.
	if (!body.success) return refuse('map_changed', 'The plan was asked for in a form this server no longer reads: propose again.');
	const dem = configuredDem();
	if (!dem) return refuse('off', 'The plan can’t be routed: the server has no elevation model.');
	const why = await movedOn(db, job.projectId, req);
	if (why) return supersede(why);
	const windows = jobWindowsFrom(req.from_window);
	if (windows.length === 0) return refuse('too_large', PAST_THE_WORKER);
	const budgetMs = jobBudget(ctx.deadline, Date.now());
	// Handed back without spending an attempt: a late claim says nothing about the catchment.
	const later = () => new JobRelease('too little time left in this tick', RELEASE_DELAY_SECONDS);
	if (budgetMs < MIN_JOB_TIME_MS) throw later();

	// The map as it is now, as the editor who asked: a feature deleted or changed since is refused, saying so.
	const read = async <T>(f: () => Promise<T>): Promise<T | null> => {
		try {
			return await f();
		} catch (err) {
			if (err instanceof ApiError && err.status < 500) {
				await refuse('map_changed', err.message);
				return null;
			}
			throw err;
		}
	};
	const start = kind === 'start' ? await read(() => readMapInputs(db, job.projectId, body.data as never)) : null;
	const divide = kind === 'divide' ? await read(() => readDivideInputs(db, job.projectId, body.data as never)) : null;
	if (!start && !divide) return;
	const outlet = start ? start.outlet : divide!.outlet;
	const placing = await readPlacement(db, { point: outlet.point, foundIn: outlet.foundIn }, body.data);
	let r: Subcatchments;
	try {
		r = await delineateUnits(dem, start ? startRouting(start, placing) : divideRouting(divide!, placing), {
			windows,
			budgetMs,
			aim: parseAim(req.aim),
			// Read in this job's own transaction, as the editor who asked (the handler's role).
			panReference: panReferenceLoader((fn) => fn(db), job.projectId),
			// One step a window; a cancel (or a lost lease) stops it before the next.
			onWindow: async (i, of) => {
				if (!(await ctx.progress((i / of) * 100))) throw CANCELLED();
			}
		});
	} catch (err) {
		if (err instanceof DelineationRefused) {
			if (err.code === 'too_large' && cutShort(err.windowCells, windows, budgetMs)) throw later();
			return refuse(err.code, err.message);
		}
		if (err instanceof JobError) throw err;
		logEvent('error', { event: 'plan_routing_failed', jobId: job.id, ...safeError(err) });
		throw new JobError('The elevation model could not be read just now.', { retry: true });
	}

	// Locked, then re-read: a newer proposal or request may have come while the DEM was read; then nothing is stored.
	const { rows: now } = await db.query<{ status: string }>('SELECT status FROM delineation_request WHERE id = $1 AND project_id = $2 FOR UPDATE', [req.id, job.projectId]);
	if (now[0]?.status !== 'queued') return;
	// The proposals are locked too, so an apply or a new proposal can't slip in between the check and the store.
	await db.query('SELECT id FROM start_proposal WHERE project_id = $1 FOR UPDATE', [job.projectId]);
	const after = await movedOn(db, job.projectId, req);
	if (after) return supersede(after);
	let proposalId: string;
	try {
		if (start) {
			const { plan, meta } = startPlanFrom(start, r);
			proposalId = (await storeStartProposal(db, job.projectId, plan, meta, true)).id;
		} else proposalId = (await storeDivideProposal(db, job.projectId, dividePlanFrom(divide!, r), r, true)).id;
	} catch (err) {
		// Another proposal stored at the same moment (the unique open index): the retry looks again, and gives way to it.
		if (err instanceof ApiError && err.status === 409) throw new JobError(err.message, { retry: true });
		throw err;
	}
	await db.query(`UPDATE delineation_request SET status = 'proposed', plan_proposal_id = $3, finished_at = now() WHERE id = $1 AND project_id = $2`, [req.id, job.projectId, proposalId]);
}
