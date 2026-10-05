// An applicant's yields (096_contributor_yield, WP-3.6 × WP-3.3, issue #73):
// a contributor queues a firm yield or curve of a dam of their own
// application (their farm, or a dam its node.add or node.insert ops add), reads their own
// jobs and results, and nothing else: not a hidden neighbour's dam (the same
// answer as an unknown id), not a saved run, not someone else's application,
// not an assessor's yield on theirs. The job fails closed once they lose the
// role or the dam. Every refusal has its positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { enqueueJob, JobCollisionError } from '../jobs/queue.js';
import { runTick } from '../jobs/runner.js';
import { YieldRequest, yieldDedupeKey } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let applicant: User; // contributor, linked to Rooikloof
let other: User; // another contributor, linked to Kalkoenkrans
let projectId: string;
let published: string;
let sid: string;
const outlet = node('Gauge', null);
const rooikloof = node('Rooikloof', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 50_000, damInitialPct: 1, damMinPct: 0 });
const kalkoenkrans = node('Kalkoenkrans', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 40_000, damInitialPct: 1, damMinPct: 0 });
const newDam = node('New dam', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 30_000, damInitialPct: 1, damMinPct: 0 });
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
const P = () => `/projects/${projectId}`;

const tick = () => runTick({ feeds: false, reports: false });
const job = async (id: string) => (await asOwner('SELECT status, last_error FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null };
const ask = (u: User, body: Record<string, unknown>) => u.call('POST', `${P()}/yield`, { kind: 'firm', ...body });

beforeAll(async () => {
	[owner, applicant, other] = (await Promise.all(['CyOwner', 'CyApplicant', 'CyOther'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Applicant yields' })).body.project.id;
	const model = {
		nodes: [outlet, rooikloof, kalkoenkrans],
		crops: [crop],
		cropAreas: [rooikloof, kalkoenkrans].map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 10_000 })),
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 90 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, farm] of [
		[applicant, rooikloof],
		[other, kalkoenkrans]
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role: 'contributor' })).status).toBe(201);
		expect((await owner.call('PUT', `${P()}/farmers/${u.id}`, { nodeIds: [farm.id] })).status).toBe(200);
	}
	const s = await applicant.call('POST', `${P()}/scenarios`, {
		name: 'Raise Rooikloof, add a dam',
		baseRunId: published,
		ops: [
			{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 60_000 },
			{ op: 'node.add', node: newDam }
		]
	});
	expect(s.status, JSON.stringify(s.body)).toBe(201);
	sid = s.body.scenario.id;
}, 60_000);

describe('an applicant’s yield on their own application', () => {
	it('queues one on their own dam and one on the dam the application adds; reads both results and their jobs', async () => {
		const mine = await ask(applicant, { scenarioId: sid, nodeId: rooikloof.id });
		expect(mine.status, JSON.stringify(mine.body)).toBe(202);
		const added = await ask(applicant, { scenarioId: sid, nodeId: newDam.id });
		expect(added.status, JSON.stringify(added.body)).toBe(202);
		const pending = await applicant.call('GET', `${P()}/yield/jobs?nodeId=${rooikloof.id}&scenarioId=${sid}`);
		expect(pending.status).toBe(200);
		expect(pending.body.jobs.map((j: { id: string }) => j.id)).toEqual([mine.body.jobId]);
		await tick();
		expect(await job(mine.body.jobId)).toEqual({ status: 'done', last_error: null });
		expect(await job(added.body.jobId)).toEqual({ status: 'done', last_error: null });
		const got = await applicant.call('GET', `${P()}/yield?scenarioId=${sid}`);
		expect(got.status).toBe(200);
		const byNode = Object.fromEntries(got.body.results.map((r: { nodeId: string; points: { point: { capacityM3: number } } }) => [r.nodeId, r.points.point.capacityM3]));
		// On the application: the raised dam, and the added one.
		expect(byNode).toEqual({ [rooikloof.id]: 60_000, [newDam.id]: 30_000 });
	});

	it('queues one on a dam the application inserts on a reach (node.insert, engine 1.35.0, migration 121), through the API and RLS alike', async () => {
		const weir = node('Weir dam', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 25_000, damInitialPct: 1, damMinPct: 0, areaKm2: 0 });
		const s = await applicant.call('POST', `${P()}/scenarios`, {
			name: 'A weir dam below Rooikloof',
			baseRunId: published,
			ops: [{ op: 'node.insert', node: weir, upstreamNodeIds: [rooikloof.id] }]
		});
		expect(s.status, JSON.stringify(s.body)).toBe(201);
		expect(s.body.check.problems).toEqual([]);
		const res = await ask(applicant, { scenarioId: s.body.scenario.id, nodeId: weir.id });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		expect(await job(res.body.jobId)).toEqual({ status: 'done', last_error: null });
		const got = await applicant.call('GET', `${P()}/yield?scenarioId=${s.body.scenario.id}`);
		expect(got.body.results.map((r: { nodeId: string }) => r.nodeId)).toEqual([weir.id]);
		// Another application's inserted dam is not theirs: the policy refuses a direct job on it.
		const direct = withUser(other.id, (db) =>
			db.query(`INSERT INTO job (project_id, kind, payload, acting_user_id) VALUES ($1, 'yield', $2, $3)`, [projectId, { kind: 'firm', scenarioId: s.body.scenario.id, nodeId: weir.id, params: {} }, other.id])
		);
		await expect(direct).rejects.toThrow(/row-level security/);
	});

	it('a hidden neighbour’s dam gets the words an unknown id gets; a saved run and a team scenario are refused', async () => {
		const hidden = await ask(applicant, { scenarioId: sid, nodeId: kalkoenkrans.id });
		const unknown = await ask(applicant, { scenarioId: sid, nodeId: crypto.randomUUID() });
		expect(hidden.status).toBe(400);
		expect({ status: hidden.status, body: hidden.body }).toEqual({ status: unknown.status, body: unknown.body });
		expect((await ask(applicant, { runId: published, nodeId: rooikloof.id })).status).toBe(403);
		const team = await owner.call('POST', `${P()}/scenarios`, { name: 'Team', baseRunId: published });
		expect(team.status).toBe(201);
		expect((await ask(applicant, { scenarioId: team.body.scenario.id, nodeId: rooikloof.id })).status).toBe(404);
		// Positive control: the owner (an editor) calculates the neighbour's dam on the published run.
		expect((await ask(owner, { runId: published, nodeId: kalkoenkrans.id })).status).toBe(202);
		await tick();
	});

	it('another applicant can neither calculate on nor read this application; RLS refuses a direct job or result', async () => {
		expect((await ask(other, { scenarioId: sid, nodeId: rooikloof.id })).status).toBe(404);
		expect((await other.call('GET', `${P()}/yield?scenarioId=${sid}`)).body.results).toEqual([]);
		const direct = (u: User, payload: Record<string, unknown>) =>
			withUser(u.id, (db) => db.query(`INSERT INTO job (project_id, kind, payload, acting_user_id) VALUES ($1, 'yield', $2, $3)`, [projectId, payload, u.id]));
		const body = { kind: 'firm', scenarioId: sid, nodeId: rooikloof.id, params: {} };
		await expect(direct(other, body)).rejects.toThrow(/row-level security/);
		await expect(direct(applicant, { ...body, nodeId: kalkoenkrans.id })).rejects.toThrow(/row-level security/);
		await expect(direct(applicant, { ...body, scenarioId: undefined, runId: published })).rejects.toThrow(/row-level security/);
		await expect(direct(applicant, { ...body, kind: undefined })).resolves.toBeTruthy();
		await expect(
			withUser(applicant.id, (db) =>
				db.query(`INSERT INTO yield_result (project_id, scenario_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', '0')`, [
					projectId,
					sid,
					kalkoenkrans.id
				])
			)
		).rejects.toThrow(/row-level security/);
		// A contributor reads no job but their own yield jobs: the owner's is there, unseen.
		const seen = await withUser(applicant.id, async (db) => (await db.query<{ acting_user_id: string }>('SELECT acting_user_id FROM job WHERE project_id = $1', [projectId])).rows);
		expect(seen.length).toBeGreaterThan(0);
		expect(new Set(seen.map((j) => j.acting_user_id))).toEqual(new Set([applicant.id]));
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now() WHERE project_id = $1 AND status = 'queued'`, [projectId]);
	});

	it('follows and cancels their own yield job on the job list (GET …/jobs), which shows them no one else’s', async () => {
		const mine = await ask(applicant, { scenarioId: sid, nodeId: rooikloof.id, kind: 'curve' });
		expect(mine.status, JSON.stringify(mine.body)).toBe(202);
		const listed = await applicant.call('GET', `${P()}/jobs`);
		expect(listed.status).toBe(200);
		expect(listed.body.jobs.map((j: { id: string }) => j.id)).toContain(mine.body.jobId);
		expect(new Set(listed.body.jobs.map((j: { kind: string }) => j.kind))).toEqual(new Set(['yield']));
		// The owner's yield (the test above) is there, unlisted to the applicant; the other applicant lists none of theirs.
		const all = (await owner.call('GET', `${P()}/jobs`)).body.jobs.map((j: { id: string }) => j.id);
		expect(all.length).toBeGreaterThan(listed.body.jobs.length);
		expect((await other.call('GET', `${P()}/jobs`)).body.jobs).toEqual([]);
		const cancel = await applicant.call('POST', `${P()}/yield/${mine.body.jobId}/cancel`, {});
		expect(cancel.status).toBe(200);
		const after = (await applicant.call('GET', `${P()}/jobs`)).body.jobs.find((j: { id: string }) => j.id === mine.body.jobId);
		expect(after.status).toBe('dead');
	});

	it('queues their own job for the same request an assessor has waiting, and never learns of the assessor’s', async () => {
		// A submitted application: the assessors (editors) may now read it and calculate on it too.
		const s = await applicant.call('POST', `${P()}/scenarios`, {
			name: 'Raise Rooikloof again',
			baseRunId: published,
			ops: [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 70_000 }]
		});
		expect(s.status, JSON.stringify(s.body)).toBe(201);
		const submit = await applicant.call('POST', `${P()}/scenarios/${s.body.scenario.id}/submit`, {});
		expect(submit.status, JSON.stringify(submit.body)).toBe(200);
		const same = { scenarioId: s.body.scenario.id, nodeId: rooikloof.id };
		const theirs = await ask(owner, same);
		expect(theirs.status, JSON.stringify(theirs.body)).toBe(202);
		// The assessor's pending job is hidden from the applicant (RLS), so it can't stand for their request:
		// they get a job of their own, which they can follow, and asking again finds that one.
		const mine = await ask(applicant, same);
		expect(mine.status, JSON.stringify(mine.body)).toBe(202);
		expect(mine.body).toMatchObject({ created: true });
		expect(mine.body.jobId).not.toBe(theirs.body.jobId);
		const again = await ask(applicant, same);
		expect(again.status).toBe(200);
		expect(again.body).toMatchObject({ created: false, jobId: mine.body.jobId });
		// And an editor asking again finds the assessor's (positive control: editors share one pending job).
		expect((await ask(owner, same)).body).toMatchObject({ created: false, jobId: theirs.body.jobId });
		await tick();
		expect(await job(mine.body.jobId)).toEqual({ status: 'done', last_error: null });
		expect(await job(theirs.body.jobId)).toEqual({ status: 'done', last_error: null });
	});

	it('a collision with a pending job they can’t see is a 409 job_collision, not a 500 (issue #386)', async () => {
		// The route keys an applicant's request per user, so it never collides with an assessor's. Enqueue
		// directly with the assessor's key to stand for a future kind that forgets to: the insert meets the
		// assessor's pending job, which RLS hides from the applicant, so there is nothing to return.
		const s = await applicant.call('POST', `${P()}/scenarios`, {
			name: 'Raise Rooikloof once more',
			baseRunId: published,
			ops: [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 80_000 }]
		});
		expect(s.status, JSON.stringify(s.body)).toBe(201);
		expect((await applicant.call('POST', `${P()}/scenarios/${s.body.scenario.id}/submit`, {})).status).toBe(200);
		const same = YieldRequest.parse({ kind: 'firm', scenarioId: s.body.scenario.id, nodeId: rooikloof.id });
		const theirs = await ask(owner, same);
		expect(theirs.status, JSON.stringify(theirs.body)).toBe(202);
		const shared = yieldDedupeKey(same);
		const err = await withUser(applicant.id, (db) => enqueueJob(db, { projectId, kind: 'yield', payload: same, dedupeKey: shared })).catch((e: unknown) => e);
		expect(err, String(err)).toBeInstanceOf(JobCollisionError);
		expect(err).toMatchObject({ status: 409, code: 'job_collision' });
		// Positive control: the owner (an editor) sees the pending job and gets it back.
		const again = await withUser(owner.id, (db) => enqueueJob(db, { projectId, kind: 'yield', payload: same, dedupeKey: shared }));
		expect(again).toMatchObject({ created: false, job: { id: theirs.body.jobId } });
		await tick();
	});

	it('doesn’t see a yield someone else stored on their application, even of their own dam', async () => {
		const y = (await asOwner(
			`INSERT INTO yield_result (project_id, scenario_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', '0') RETURNING id`,
			[projectId, sid, rooikloof.id]
		))[0]!.id as string;
		const ids = (await applicant.call('GET', `${P()}/yield?scenarioId=${sid}`)).body.results.map((r: { id: string }) => r.id);
		expect(ids).not.toContain(y);
		expect(ids.length).toBeGreaterThan(0); // their own, from the first test
	});
});

describe('the job fails closed', () => {
	it('dies when the applicant loses the dam (their farm link moves), and when they leave the project', async () => {
		const a = await ask(applicant, { scenarioId: sid, nodeId: rooikloof.id, params: { assurance: 0.9 } });
		expect(a.status, JSON.stringify(a.body)).toBe(202);
		// Their link moves to another farm (a farm link list is never empty).
		expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [kalkoenkrans.id] })).status).toBe(200);
		await tick();
		expect(await job(a.body.jobId)).toEqual({ status: 'dead', last_error: 'that hydrological unit is not in this run or scenario' });

		expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
		const b = await ask(applicant, { scenarioId: sid, nodeId: rooikloof.id, params: { assurance: 0.8 } });
		expect(b.status, JSON.stringify(b.body)).toBe(202);
		expect((await owner.call('DELETE', `${P()}/members/${applicant.id}`)).status).toBe(204);
		await tick();
		expect(await job(b.body.jobId)).toEqual({ status: 'dead', last_error: 'the user who queued this job no longer has the editor role on the project' });
	});
});
