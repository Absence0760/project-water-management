// Cumulative impact assessments end to end (roadmap WP-3.11,
// 145_assessment.sql): two submitted applications on the published baseline
// assessed alone and together by an assessor, the `assessment` job run as
// them (the memory transport: the test runs the tick itself), the report
// against each application's own run, a conflicting pair refused with a
// readable reason and nothing written, RLS (editors only, with a positive
// control), the member's ops copied from its scenario, and write-once
// outcomes. Synthetic catchment: invented names and values.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { ASSESSMENT_SCENARIOS_MAX } from './schema.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User;
let viewer: User;
let applicantA: User;
let applicantB: User;
let projectId: string;
let published: string;
let appA: string;
let appB: string;

const outlet = node('Outlet', null);
const rooikloof = node('Rooikloof', outlet.id, { damCapacityM3: 100_000, pctRunoffToDam: 1 });
const kalkoenkrans = node('Kalkoenkrans', outlet.id);
const bergvliet = node('Bergvliet', outlet.id);
const lucerne = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const P = () => `/projects/${projectId}`;
const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const job = async (id: string) => (await asOwner('SELECT status, last_error, progress FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null; progress: number | null };
const rowsAs = async (u: User, sql: string, params: unknown[] = []) => withUser(u.id, async (db) => (await db.query(sql, params)).rows);

async function application(u: User, name: string, ops: unknown[]) {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const sid = res.body.scenario.id as string;
	expect((await u.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
	return sid;
}

beforeAll(async () => {
	[owner, assessor, viewer, applicantA, applicantB] = (await Promise.all(['Cowner', 'Cassessor', 'Cviewer', 'Capplicanta', 'Capplicantb'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Cumulative' })).body.project.id;
	const model = {
		nodes: [outlet, rooikloof, kalkoenkrans, bergvliet],
		crops: [lucerne],
		cropAreas: [
			{ nodeId: rooikloof.id, cropId: lucerne.id, areaM2: 80_000 },
			{ nodeId: kalkoenkrans.id, cropId: lucerne.id, areaM2: 60_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(2000) } })).status).toBe(200);
	const rain = Array.from({ length: 120 }, (_, i) => (i % 9 === 0 ? 25 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[assessor, 'editor'],
		[viewer, 'viewer'],
		[applicantA, 'contributor'],
		[applicantB, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	}
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantB.id}`, { nodeIds: [kalkoenkrans.id] })).status).toBe(200);
	// A doubles Rooikloof's dam; B triples Kalkoenkrans's lucerne. Disjoint: they combine.
	appA = await application(applicantA, 'Raise Rooikloof', [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 200_000 }]);
	appB = await application(applicantB, 'More lucerne on Kalkoenkrans', [{ op: 'cropArea.set', nodeId: kalkoenkrans.id, cropId: lucerne.id, areaM2: 180_000 }]);
});

interface Row {
	metric: string;
	siteNodeId: string | null;
	isOutlet: boolean;
	baseline: number | null;
	singles: (number | null)[];
	combined: number | null;
	singleChanges: (number | null)[];
	sumOfSingles: number | null;
	combinedChange: number | null;
	interaction: number | null;
}

describe('POST /projects/:id/assessments', () => {
	it('an assessor assesses two applications alone and together; the job stores each alone and the cumulative report', async () => {
		const res = await assessor.call('POST', `${P()}/assessments`, { name: 'Two applications', scenarioIds: [appA, appB] });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const { assessment, jobId } = res.body;
		expect(assessment).toMatchObject({ name: 'Two applications', baseRunId: published, status: 'pending', engineVersion: null, createdBy: 'Cassessor', problems: [] });
		expect(assessment.members.map((m: { name: string; scenarioId: string; origin: string; status: string }) => [m.name, m.scenarioId, m.origin, m.status])).toEqual([
			['Raise Rooikloof', appA, 'applicant', 'pending'],
			['More lucerne on Kalkoenkrans', appB, 'applicant', 'pending']
		]);
		await tick();
		expect(await job(jobId)).toMatchObject({ status: 'done', progress: 100 });
		const got = (await assessor.call('GET', `${P()}/assessments/${assessment.id}`)).body.assessment;
		expect(got).toMatchObject({ status: 'complete', problems: [], job: { status: 'done' } });
		expect(got.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
		for (const m of got.members) expect(m).toMatchObject({ status: 'done', problems: [], startDate: '2020-01-01', endDate: '2020-04-29' });
		const report = got.report as { scenarios: { id: string; name: string }[]; rows: Row[]; warnings: string[] };
		expect(report.scenarios.map((s) => s.id)).toEqual([appA, appB]);
		expect(report.warnings).toEqual([]);
		for (const r of report.rows) {
			if (r.baseline === null || r.combined === null || r.sumOfSingles === null) continue;
			expect(r.interaction).toBeCloseTo(r.combinedChange! - r.sumOfSingles, 9);
		}
		const flow = report.rows.find((r) => r.metric === 'outlet_flow')!;
		// More lucerne takes water; together they leave no more at the outlet than B alone.
		expect(flow.singleChanges[1]).toBeLessThan(0);
		expect(flow.combined!).toBeLessThanOrEqual(flow.singles[1]! + 1e-9);
		expect(report.rows[0]).toMatchObject({ metric: 'ewr_days_not_met', isOutlet: true, siteNodeId: null });

		// Each single is that application's own run on the same baseline (same engine): run B as the assessor and compare.
		const runB = await assessor.call('POST', `${P()}/scenarios/${appB}/runs`, {});
		expect(runB.status, JSON.stringify(runB.body)).toBe(201);
		const [{ summary }] = (await asOwner('SELECT summary FROM model_run WHERE id = $1', [runB.body.run.id])) as [{ summary: { catchment: { meanSimulatedOutflowM3Day: number } } }];
		expect(flow.singles[1]).toBe(summary.catchment.meanSimulatedOutflowM3Day);
		// And the baseline column is the published run's.
		const [{ summary: base }] = (await asOwner('SELECT summary FROM model_run WHERE id = $1', [published])) as [{ summary: { catchment: { meanSimulatedOutflowM3Day: number } } }];
		expect(flow.baseline).toBe(base.catchment.meanSimulatedOutflowM3Day);

		// The list leaves the report out.
		const list = (await assessor.call('GET', `${P()}/assessments`)).body.assessments;
		expect(list.map((a: { id: string }) => a.id)).toContain(assessment.id);
		expect(list[0]).not.toHaveProperty('report');

		// Each member's ops are its scenario's, copied by the guard.
		const members = await asOwner('SELECT m.ops, m.ops_sha256, s.ops AS s_ops, s.ops_sha256 AS s_sha FROM assessment_member m JOIN scenario s ON s.id = m.scenario_id WHERE m.assessment_id = $1', [assessment.id]);
		for (const m of members as { ops: unknown; ops_sha256: string; s_ops: unknown; s_sha: string }[]) {
			expect(m.ops).toEqual(m.s_ops);
			expect(m.ops_sha256).toBe(m.s_sha);
		}

		// Write-once: a complete assessment and its members don't change.
		await expect(rowsAs(assessor, `UPDATE assessment SET status = 'failed', problems = '["x"]' WHERE id = $1 RETURNING id`, [assessment.id])).resolves.toEqual([]);
		await expect(rowsAs(assessor, `UPDATE assessment_member SET status = 'failed', problems = '["x"]' WHERE assessment_id = $1 RETURNING id`, [assessment.id])).resolves.toEqual([]);
		// Not even by the schema owner past RLS: the trigger.
		await expect(asOwner(`UPDATE assessment SET status = 'failed', problems = '["x"]' WHERE id = $1`, [assessment.id])).rejects.toThrow(/completed once/);
	});

	it('refuses a conflicting pair with a readable reason, and writes nothing', async () => {
		// The assessor's own team scenario sets the same dam as application A.
		const team = await assessor.call('POST', `${P()}/scenarios`, { name: 'Smaller Rooikloof', baseRunId: published, ops: [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 60_000 }] });
		expect(team.status).toBe(201);
		const before = await asOwner('SELECT count(*)::int AS n FROM assessment WHERE project_id = $1', [projectId]);
		const res = await assessor.call('POST', `${P()}/assessments`, { name: 'Clash', scenarioIds: [appA, team.body.scenario.id] });
		expect(res.status).toBe(422);
		expect(res.body.error).toBe("these scenarios conflict (one conflict); they can't be assessed together");
		expect(res.body.details.problems).toEqual([]);
		expect(res.body.details.conflicts).toHaveLength(1);
		expect(res.body.details.conflicts[0]).toMatchObject({
			reason: 'same_target',
			target: 'node "Rooikloof": damCapacityM3',
			message: '"Raise Rooikloof" op 1 (node.set) and "Smaller Rooikloof" op 1 (node.set) both change node "Rooikloof": damCapacityM3',
			a: { scenarioId: appA, opIndex: 0 },
			b: { scenarioId: team.body.scenario.id, opIndex: 0 }
		});
		// dryRun says the same; a pair that combines answers ok and writes nothing either.
		expect((await assessor.call('POST', `${P()}/assessments`, { name: 'Clash', scenarioIds: [appA, team.body.scenario.id], dryRun: true })).status).toBe(422);
		const ok = await assessor.call('POST', `${P()}/assessments`, { name: 'Check', scenarioIds: [appA, appB], dryRun: true });
		expect(ok.status).toBe(200);
		expect(ok.body).toEqual({ check: { ok: true, conflicts: [], problems: [] } });
		expect(await asOwner('SELECT count(*)::int AS n FROM assessment WHERE project_id = $1', [projectId])).toEqual(before);
	});

	it('takes only scenarios the assessor reads, on one base run, and at least two', async () => {
		// A draft application is the applicant's alone: 404, as if it didn't exist.
		const draft = await applicantA.call('POST', `${P()}/scenarios`, { name: 'Draft', baseRunId: published, ops: [] });
		expect((await assessor.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: [appA, draft.body.scenario.id] })).status).toBe(404);
		expect((await assessor.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: [appA, randomUUID()] })).status).toBe(404);
		// Another base run.
		const other = (await owner.call('POST', `${P()}/runs`, { label: 'Other' })).body.run.id as string;
		const elsewhere = await assessor.call('POST', `${P()}/scenarios`, { name: 'Elsewhere', baseRunId: other, ops: [] });
		const res = await assessor.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: [appA, elsewhere.body.scenario.id] });
		expect(res.status).toBe(422);
		expect(res.body.error).toMatch(/based on different runs/);
		expect((await assessor.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: [appA] })).status).toBe(400);
		expect((await assessor.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: [appA, appA] })).status).toBe(400);
		expect((await assessor.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: Array.from({ length: ASSESSMENT_SCENARIOS_MAX + 1 }, () => randomUUID()) })).status).toBe(400);
	});
});

describe('who reads an assessment', () => {
	it('editors only: a viewer or a contributor gets 403 and reads no row (positive control: the assessor reads it)', async () => {
		const [{ id }] = (await asOwner('SELECT id FROM assessment WHERE project_id = $1 LIMIT 1', [projectId])) as [{ id: string }];
		expect((await assessor.call('GET', `${P()}/assessments/${id}`)).status).toBe(200);
		expect(await rowsAs(assessor, 'SELECT id FROM assessment WHERE id = $1', [id])).toHaveLength(1);
		expect(await rowsAs(assessor, 'SELECT id FROM assessment_member WHERE assessment_id = $1', [id])).toHaveLength(2);
		for (const u of [viewer, applicantA, applicantB]) {
			expect((await u.call('GET', `${P()}/assessments`)).status, u.email).toBe(403);
			expect((await u.call('GET', `${P()}/assessments/${id}`)).status, u.email).toBe(403);
			expect((await u.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: [appA, appB] })).status, u.email).toBe(403);
			expect(await rowsAs(u, 'SELECT id FROM assessment')).toEqual([]);
			expect(await rowsAs(u, 'SELECT id FROM assessment_member')).toEqual([]);
		}
	});

	it('keeps an assessment when a team scenario in it is deleted, its copy intact', async () => {
		const t1 = (await assessor.call('POST', `${P()}/scenarios`, { name: 'Team pump', baseRunId: published, ops: [{ op: 'node.set', nodeId: bergvliet.id, field: 'divertCapacityM3Day', value: 9000 }] })).body.scenario.id;
		const res = await assessor.call('POST', `${P()}/assessments`, { name: 'With a team scenario', scenarioIds: [appB, t1] });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		expect((await assessor.call('DELETE', `${P()}/scenarios/${t1}`)).status).toBeLessThan(300);
		const got = (await assessor.call('GET', `${P()}/assessments/${res.body.assessment.id}`)).body.assessment;
		expect(got.members[1]).toMatchObject({ name: 'Team pump', scenarioId: null, origin: 'team', opCount: 1 });
		await tick();
		expect((await assessor.call('GET', `${P()}/assessments/${res.body.assessment.id}`)).body.assessment.status).toBe('complete');
	});
});
