// An applicant's yields (095_contributor_yield, WP-3.6 × WP-3.3, issue #73):
// a contributor queues a firm yield or curve of a dam of their own
// application (their farm, or a dam its node.add ops add), reads their own
// jobs and results, and nothing else: not a hidden neighbour's dam (the same
// answer as an unknown id), not a saved run, not someone else's application,
// not an assessor's yield on theirs. The job fails closed once they lose the
// role or the dam. Every refusal has its positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';

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
		expect(await job(a.body.jobId)).toEqual({ status: 'dead', last_error: 'that node is not in this run or scenario' });

		expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
		const b = await ask(applicant, { scenarioId: sid, nodeId: rooikloof.id, params: { assurance: 0.8 } });
		expect(b.status, JSON.stringify(b.body)).toBe(202);
		expect((await owner.call('DELETE', `${P()}/members/${applicant.id}`)).status).toBe(204);
		await tick();
		expect(await job(b.body.jobId)).toEqual({ status: 'dead', last_error: 'the user who queued this job no longer has the editor role on the project' });
	});
});
