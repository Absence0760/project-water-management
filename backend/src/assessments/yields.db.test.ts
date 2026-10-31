// A cumulative assessment's firm yields as jobs of their own
// (297_assessment_yield_jobs, assessments/yields.ts): the assessment job
// fans out one `assessment_yield` job per dam and run and the last one back
// completes it, so more dams than the old one-job budget
// (floor(20 ÷ (applications + 2)): 5 with two) all get their rows; a yield
// job that dies fails the assessment, saying which, both as the API reads it
// at once and as the next sibling records it; the per-user cap counts an
// assessment while its yield jobs are out; the 30-day purge clears a yield's
// job and keeps it; RLS keeps the rows to editors. Synthetic catchment:
// invented names and values.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { damFirmYields, ENGINE_VERSION } from '@water-management/engine';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// A search that throws something of its own (a path, a value): switched on by one test, through the real handler.
const { boom } = vi.hoisted(() => ({ boom: { on: false } }));
vi.mock('./yields.js', async (orig) => {
	const m = await orig<typeof import('./yields.js')>();
	return {
		...m,
		computeAssessmentYield: async (...a: Parameters<typeof m.computeAssessmentYield>) => {
			if (boom.on) throw new Error('out of memory at /var/task/secret-detail.js');
			return m.computeAssessmentYield(...a);
		}
	};
});
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { loadBaseInput } from '../scenarios/execute.js';
import { ASSESSMENT_JOBS_PER_USER } from './schema.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User;
let viewer: User;
let projectId: string;
let baseRunId: string;
let raiseNorth: string;
let raiseSouth: string;

const outlet = node('Outlet', null);
/** Six farm dams: more than the five the single job took with two applications. */
const farms = ['Avondrust', 'Bloemhof', 'Cederhof', 'Doornbosch', 'Eikenhof', 'Fonteinkloof'].map((n) =>
	node(n, outlet.id, { damCapacityM3: 60_000, pctRunoffToDam: 1, damInitialPct: 0.5, damMinPct: 0 })
);
const lucerne = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const P = () => `/projects/${projectId}`;
const tick = (maxJobs = 100) => runTick({ feeds: false, reports: false, alerts: false, projectIds: [projectId], maxJobs });
const rowsAs = async (u: User, sql: string, params: unknown[] = []) => withUser(u.id, async (db) => (await db.query(sql, params)).rows);
const raise = (ids: string[]) => ids.map((nodeId) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value: 120_000 }));

async function assess(name: string) {
	const res = await assessor.call('POST', `${P()}/assessments`, { name, scenarioIds: [raiseNorth, raiseSouth] });
	expect(res.status, JSON.stringify(res.body)).toBe(202);
	return { id: res.body.assessment.id as string, jobId: res.body.jobId as string };
}
const get = async (id: string) => (await assessor.call('GET', `${P()}/assessments/${id}`)).body.assessment;
const yieldJobs = async (id: string) =>
	(await asOwner(`SELECT y.id, y.job_id, y.run, y.dam_name FROM assessment_yield y WHERE y.assessment_id = $1 ORDER BY y.run, y.member_position, y.dam_position`, [id])) as {
		id: string;
		job_id: string;
		run: string;
		dam_name: string;
	}[];

beforeAll(async () => {
	[owner, assessor, viewer] = (await Promise.all(['Yowner', 'Yassessor', 'Yviewer'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Yield jobs' })).body.project.id;
	const model = { nodes: [outlet, ...farms], crops: [lucerne], cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: lucerne.id, areaM2: 60_000 })), transfers: [] };
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 120 }, (_, i) => (i % 7 === 0 ? 25 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	baseRunId = run.body.run.id;
	for (const [u, role] of [
		[assessor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	const scenario = async (name: string, ids: string[]) => {
		const res = await assessor.call('POST', `${P()}/scenarios`, { name, baseRunId, ops: raise(ids) });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.scenario.id as string;
	};
	raiseNorth = await scenario('Raise the northern dams', farms.slice(0, 3).map((f) => f.id));
	raiseSouth = await scenario('Raise the southern dams', farms.slice(3).map((f) => f.id));
});

describe('the assessment fans its dams’ firm yields out to jobs and gathers them', () => {
	it('six dams with two applications, more than one job’s old five, all get their firm-yield rows', async () => {
		const { id, jobId } = await assess('Six dams');
		// The assessment job alone: its runs done, the yields queued, the assessment still pending.
		await tick(1);
		const waiting = await get(id);
		expect(waiting).toMatchObject({ status: 'pending', job: { id: jobId, status: 'done', progress: 100 }, yields: { done: 0, total: 24 } });
		expect(waiting.report).toBeNull();
		expect(JSON.stringify(waiting)).not.toContain('gathering');
		const jobs = await yieldJobs(id);
		expect(jobs).toHaveLength(6 * 4);
		expect(new Set(jobs.map((j) => j.run))).toEqual(new Set(['baseline', 'single', 'combined']));
		expect((await asOwner(`SELECT DISTINCT kind, acting_user_id FROM job WHERE id = ANY($1::uuid[])`, [jobs.map((j) => j.job_id)])) as unknown[]).toEqual([
			{ kind: 'assessment_yield', acting_user_id: assessor.id }
		]);

		await tick();
		const got = await get(id);
		expect(got).toMatchObject({ status: 'complete', problems: [], yields: { done: 24, total: 24 } });
		const report = got.report as { rows: { metric: string; site: string; siteNodeId: string; baseline: number | null; singles: (number | null)[]; combined: number | null }[]; warnings: string[]; dams: { nodeIds: string[] } };
		expect(report.dams.nodeIds).toEqual(farms.map((f) => f.id));
		expect(report.warnings.filter((w) => /no yield rows/.test(w))).toEqual([]);
		const yields = report.rows.filter((r) => r.metric === 'dam_firm_yield');
		expect(yields.map((r) => r.site)).toEqual(farms.map((f) => f.name));
		expect(report.rows.filter((r) => r.metric === 'dam_reliability')).toHaveLength(6);
		for (const r of yields) {
			expect(r.baseline, r.site).not.toBeNull();
			expect(r.combined, r.site).not.toBeNull();
			for (const s of r.singles) expect(s, r.site).not.toBeNull();
		}
		// The baseline column is the engine's firm yield on the stored base run, as the single job worked it out.
		const base = await withUser(assessor.id, (db) => loadBaseInput(db, projectId, baseRunId));
		const direct = damFirmYields(
			base,
			farms.map((f) => ({ nodeId: f.id, name: f.name })),
			'The baseline'
		);
		expect(yields.map((r) => r.baseline)).toEqual(direct.yields);
		// The raised dams yield at least as much alone as on the baseline.
		expect(yields[0]!.singles[0]!).toBeGreaterThanOrEqual(yields[0]!.baseline!);
	});

	it('a yield job that dies fails the assessment, naming the dam and run: at once as read, and recorded by the next sibling', async () => {
		const { id } = await assess('One dies');
		await tick(1);
		const jobs = await yieldJobs(id);
		const victim = jobs.find((j) => j.run === 'baseline' && j.dam_name === 'Cederhof')!;
		// Dead with no tick yet (as a claim leaves one whose lease ran out): nothing has recorded it.
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), last_error = 'boom' WHERE id = $1`, [victim.job_id]);
		const line = 'The baseline: the firm yield of "Cederhof" didn\'t finish (boom)';
		// As read now: failed, never pending, though the row still is.
		expect(await get(id)).toMatchObject({ status: 'failed', problems: [line] });
		expect((await asOwner('SELECT status FROM assessment WHERE id = $1', [id]))[0]).toEqual({ status: 'pending' });
		// The tick: the first sibling (or the sweep) records it; the rest find it finished and store nothing more.
		await tick();
		expect((await asOwner('SELECT status, problems, gathering, report FROM assessment WHERE id = $1', [id]))[0]).toEqual({ status: 'failed', problems: [line], gathering: null, report: null });
		const served = await get(id);
		expect(served).toMatchObject({ status: 'failed', problems: [line] });
		expect(JSON.stringify(served)).not.toContain('secret-detail');
	});

	it('a yield row removed before the gather fails the assessment instead of completing it without that dam (297)', async () => {
		const { id } = await assess('A row removed');
		await tick(1);
		// Past every grant (water_app has no DELETE since 297): the second line still holds.
		const [gone] = await yieldJobs(id);
		await asOwner('DELETE FROM assessment_yield WHERE id = $1', [gone!.id]);
		await asOwner(`UPDATE job SET status = 'done', finished_at = now() WHERE id = $1`, [gone!.job_id]);
		await tick();
		expect(await stored(id)).toEqual({
			status: 'failed',
			problems: ['The firm yields are incomplete: 1 of the 24 queued were removed before they were gathered; assess them together again.'],
			gathering: null,
			report: null
		});
	});

	it('no editor deletes a yield row, its author neither (positive control: deleting the assessment takes its rows by the cascade)', async () => {
		const { id } = await assess('Rows stay');
		await tick(1);
		const rows = await yieldJobs(id);
		expect(rows.length).toBe(24);
		// The owner, an editor of the project who didn't ask, and the assessor who did: no DELETE on the table.
		for (const u of [owner, assessor]) await expect(rowsAs(u, 'DELETE FROM assessment_yield WHERE id = $1', [rows[0]!.id])).rejects.toThrow(/permission denied/);
		expect((await asOwner('SELECT count(*)::int AS n FROM assessment_yield WHERE assessment_id = $1', [id]))[0]).toEqual({ n: 24 });
		expect(await rowsAs(assessor, 'DELETE FROM assessment WHERE id = $1 RETURNING id', [id])).toHaveLength(1);
		expect((await asOwner('SELECT count(*)::int AS n FROM assessment_yield WHERE assessment_id = $1', [id]))[0]).toEqual({ n: 0 });
		// Its yield jobs find nothing to do.
		await tick();
	});

	/** An assessment whose yield jobs are all back but `victim`'s (the combined run's Fonteinkloof), which waits. */
	async function allButOne(name: string) {
		const { id } = await assess(name);
		await tick(1);
		const victim = (await yieldJobs(id)).find((j) => j.run === 'combined' && j.dam_name === 'Fonteinkloof')!;
		await asOwner(`UPDATE job SET run_after = now() + interval '1 day' WHERE id = $1`, [victim.job_id]);
		await tick();
		expect((await asOwner(`SELECT count(*)::int AS n FROM assessment_yield WHERE assessment_id = $1 AND status = 'pending'`, [id]))[0]).toEqual({ n: 1 });
		expect((await asOwner('SELECT status FROM assessment WHERE id = $1', [id]))[0]).toEqual({ status: 'pending' });
		return { id, victim };
	}
	const stored = async (id: string) => (await asOwner('SELECT status, problems, gathering, report FROM assessment WHERE id = $1', [id]))[0];

	it('the tick fails it when the claim kills the last yield job, its lease run out with no attempts left (301)', async () => {
		const { id, victim } = await allButOne('Lease ran out');
		// The worker stopped mid-search on its last attempt: running, its lease long gone.
		await asOwner(`UPDATE job SET status = 'running', attempts = max_attempts, locked_until = now() - interval '1 minute', lease_token = gen_random_uuid(), run_after = now() WHERE id = $1`, [
			victim.job_id
		]);
		const r = await tick();
		expect((await asOwner('SELECT status FROM job WHERE id = $1', [victim.job_id]))[0]).toEqual({ status: 'dead' });
		expect(r.assessmentsFailed).toBe(1);
		const line = 'All together: the firm yield of "Fonteinkloof" didn\'t finish (the worker stopped before the job finished, and it has no attempts left)';
		expect(await stored(id)).toEqual({ status: 'failed', problems: [line], gathering: null, report: null });
	});

	it('the tick fails it when the last yield job dies because its user is no longer an editor (301)', async () => {
		const { id, victim } = await allButOne('Demoted');
		expect((await owner.call('PATCH', `${P()}/members/${assessor.id}`, { role: 'viewer' })).status).toBe(200);
		try {
			await asOwner(`UPDATE job SET run_after = now() WHERE id = $1`, [victim.job_id]);
			const r = await tick();
			expect((await asOwner('SELECT status FROM job WHERE id = $1', [victim.job_id]))[0]).toEqual({ status: 'dead' });
			expect(r.assessmentsFailed).toBe(1);
			const line = 'All together: the firm yield of "Fonteinkloof" didn\'t finish (the user who queued this job no longer has the editor role on the project)';
			expect(await stored(id)).toEqual({ status: 'failed', problems: [line], gathering: null, report: null });
		} finally {
			expect((await owner.call('PATCH', `${P()}/members/${assessor.id}`, { role: 'editor' })).status).toBe(200);
		}
	});

	it('the sweep leaves an assessment with live yield jobs alone, only the worker calls it, and the exception fails only on stopped yields (301)', async () => {
		const { id } = await assess('Still working');
		await tick(1);
		// That tick's sweep ran: its yield jobs are queued, so it stays pending; and again, directly, as the worker.
		expect(await stored(id)).toMatchObject({ status: 'pending', problems: [] });
		expect(await withoutUser(async (db) => (await db.query('SELECT app_fail_stopped_assessments() AS n')).rows[0].n)).toBe(0);
		expect(await stored(id)).toMatchObject({ status: 'pending' });
		// water_app as a signed-in user (the assessor, an editor) is refused.
		await expect(withUser(assessor.id, (db) => db.query('SELECT app_fail_stopped_assessments()'))).rejects.toThrow(/only the worker/);
		// Nor can it read the lines' helper.
		await expect(withUser(assessor.id, (db) => db.query('SELECT assessment_stopped_yields($1)', [id]))).rejects.toThrow(/permission denied/);
		// The exception holds only for a failure on stopped yields: with none, not even the schema owner fails it so.
		await expect(
			asOwner(`UPDATE assessment SET status = 'failed', problems = '["x"]', engine_version = gathering->>'engineVersion', gathering = NULL WHERE id = $1`, [id])
		).rejects.toThrow(/only whoever asked/);
		await tick();
		expect(await stored(id)).toMatchObject({ status: 'complete' });
	});

	it('the last yield job dying, with no sibling left to see it, stores the assessment as failed, naming the run and dam', async () => {
		const { id } = await assess('Last one dies');
		await tick(1);
		const jobs = await yieldJobs(id);
		const victim = jobs.find((j) => j.run === 'combined' && j.dam_name === 'Fonteinkloof')!;
		// Every other yield job runs first and stores its yield; the victim waits.
		await asOwner(`UPDATE job SET run_after = now() + interval '1 day' WHERE id = $1`, [victim.job_id]);
		await tick();
		expect((await asOwner(`SELECT count(*)::int AS n FROM assessment_yield WHERE assessment_id = $1 AND status = 'pending'`, [id]))[0]).toEqual({ n: 1 });
		expect((await asOwner('SELECT status FROM assessment WHERE id = $1', [id]))[0]).toEqual({ status: 'pending' });
		// Then its search throws an error of its own, past retrying: the real handler stores its fixed words, never the detail.
		await asOwner(`UPDATE job SET run_after = now() - interval '1 second' WHERE id = $1`, [victim.job_id]);
		boom.on = true;
		let r;
		try {
			r = await tick();
		} finally {
			boom.on = false;
		}
		expect((await asOwner('SELECT status, last_error FROM job WHERE id = $1', [victim.job_id]))[0]).toEqual({ status: 'dead', last_error: 'the firm yield failed' });
		// Its onDead recorded it, before the tick's sweep (301) had anything left to do.
		expect(r.assessmentsFailed).toBe(0);
		const line = 'All together: the firm yield of "Fonteinkloof" didn\'t finish (the firm yield failed)';
		// The row itself, not only as the API reads it.
		expect((await asOwner('SELECT status, problems, gathering, report FROM assessment WHERE id = $1', [id]))[0]).toEqual({ status: 'failed', problems: [line], gathering: null, report: null });
		expect(await get(id)).toMatchObject({ status: 'failed', problems: [line] });
	});

	it('a yield job on another engine than the runs’ fails the assessment rather than mix two', async () => {
		const { id } = await assess('Engine changed');
		await tick(1);
		// Past the write-once guard, as a deploy between the assessment job and its yields would leave it.
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			await client.query('SET LOCAL session_replication_role = replica');
			await client.query(`UPDATE assessment SET gathering = jsonb_set(gathering, '{engineVersion}', '"0.0.1"') WHERE id = $1`, [id]);
			await client.query('COMMIT');
		} finally {
			await client.end();
		}
		await tick();
		expect(await get(id)).toMatchObject({
			status: 'failed',
			problems: [`The engine changed (from 0.0.1 to ${ENGINE_VERSION}) while the dams' firm yields were worked out; assess them together again.`]
		});
		// No search was stored: every yield job found the engine changed (the first failed it; the rest found it finished).
		expect((await asOwner(`SELECT count(*)::int AS n FROM assessment_yield WHERE assessment_id = $1 AND status = 'done'`, [id]))[0]).toEqual({ n: 0 });
	});

	it(`the per-user cap counts an assessment while its yield jobs are out (positive control: once they are back, another is taken)`, async () => {
		expect(ASSESSMENT_JOBS_PER_USER).toBe(2);
		await assess('In flight 1');
		await tick(1);
		// Its own job is done; its yield jobs are queued: still in flight.
		await assess('In flight 2');
		const refused = await assessor.call('POST', `${P()}/assessments`, { name: 'Third', scenarioIds: [raiseNorth, raiseSouth] });
		expect(refused.status).toBe(429);
		await tick();
		const ok = await assessor.call('POST', `${P()}/assessments`, { name: 'Third', scenarioIds: [raiseNorth, raiseSouth] });
		expect(ok.status, JSON.stringify(ok.body)).toBe(202);
		await tick();
	});

	it('the 30-day job clean-up clears a yield’s job and keeps the yield and the complete assessment (148_job_purge_clears_links)', async () => {
		const { id } = await assess('Purged yield job');
		await tick();
		const [first] = await yieldJobs(id);
		const cols = 'id, status, yield_m3_year, warning, finished_at';
		const before = await asOwner(`SELECT ${cols} FROM assessment_yield WHERE id = $1`, [first!.id]);
		expect(before[0]).toMatchObject({ status: 'done' });
		await asOwner(`UPDATE job SET finished_at = now() - interval '31 days' WHERE id = $1`, [first!.job_id]);
		expect((await tick()).purged).toBeGreaterThanOrEqual(1);
		expect(await asOwner(`SELECT ${cols}, job_id FROM assessment_yield WHERE id = $1`, [first!.id])).toEqual(before.map((r) => ({ ...r, job_id: null })));
		// A done yield without its job is not a stopped one: the assessment stays complete.
		expect(await get(id)).toMatchObject({ status: 'complete' });
		// Positive control: the outcome guard still refuses a real change, even by the schema owner.
		await expect(asOwner(`UPDATE assessment_yield SET yield_m3_year = 1 WHERE id = $1`, [first!.id])).rejects.toThrow(/stored once/);
		await expect(asOwner(`UPDATE assessment SET gathering = '{}' WHERE id = $1`, [id])).rejects.toThrow(/never changed/);
	});
});

describe('who reads an assessment’s yields', () => {
	it('editors only (positive control: the assessor reads them); nobody but its author queues one', async () => {
		const [{ id }] = (await asOwner(`SELECT assessment_id AS id FROM assessment_yield WHERE project_id = $1 LIMIT 1`, [projectId])) as [{ id: string }];
		expect((await rowsAs(assessor, 'SELECT id FROM assessment_yield WHERE assessment_id = $1', [id])).length).toBeGreaterThan(0);
		expect(await rowsAs(viewer, 'SELECT id FROM assessment_yield')).toEqual([]);
		// Another editor can't add a yield to the assessor's assessment, even with a job of the right kind.
		const pending = await assess('Not yours');
		await expect(
			withUser(owner.id, async (db) => {
				const yieldId = randomUUID();
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO job (project_id, kind, payload, acting_user_id) VALUES ($1, 'assessment_yield', $2, app_current_user_id()) RETURNING id`,
					[projectId, JSON.stringify({ assessmentId: pending.id, yieldId })]
				);
				await db.query(
					`INSERT INTO assessment_yield (id, assessment_id, project_id, job_id, run, dam_position, node_id, dam_name, run_label) VALUES ($1, $2, $3, $4, 'baseline', 0, 'x', 'x', 'x')`,
					[yieldId, pending.id, projectId, rows[0]!.id]
				);
			})
		).rejects.toThrow(/only whoever asked/);
		await tick();
	});
});
