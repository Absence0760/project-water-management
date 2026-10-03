// A run of a deleted scenario is still a scenario run (issues #380, #381).
// Deleting a scenario clears its runs' scenario_id (024: ON DELETE SET NULL)
// while each run's inputs.scenario stays; model_run.from_scenario
// (188_scenario_run_flag) keeps it a scenario run. Each check below takes the
// orphaned run where a run of the model is wanted and refuses it, in the API
// and past it in the database, with the base run it was made from as the
// positive control. Nominating it: runs/evidence.db.test.ts; publishing it:
// publish/publication.db.test.ts; the portfolio's newest run:
// portfolio/portfolio.db.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { heldSinceLastRun } from '../series/hold.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let pid: string;
/** A run of the model, the scenario's base. */
let base: string;
/** The scenario's run, its scenario since deleted. */
let orphan: string;

async function runnableProject(u: User, name: string) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id, { damCapacityM3: 20_000 });
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return id;
}

async function scenarioRun(u: User, projectId: string, baseRunId: string, name: string) {
	const sc = await u.call('POST', `/projects/${projectId}/scenarios`, { name, baseRunId, ops: [{ op: 'demand.scale', factor: 2 }] });
	expect(sc.status).toBe(201);
	const sid = sc.body.scenario.id as string;
	const made = await u.call('POST', `/projects/${projectId}/scenarios/${sid}/runs`, {});
	expect(made.status).toBe(201);
	return { sid, runId: made.body.run.id as string };
}

/** `text` as `u` in a savepoint that is rolled back: 'ok', or the error's message. Nothing is kept. */
async function attempt(u: User, text: string, params: unknown[]): Promise<string> {
	return withUser(u.id, async (db) => {
		await db.query('SAVEPOINT attempt');
		try {
			await db.query(text, params);
			return 'ok';
		} catch (err) {
			return (err as Error).message;
		} finally {
			await db.query('ROLLBACK TO SAVEPOINT attempt');
		}
	});
}

beforeAll(async () => {
	owner = await signUp('OrphanOwner');
	pid = await runnableProject(owner, 'Orphaned scenario runs');
	const res = await owner.call('POST', `/projects/${pid}/runs`, { label: 'base' });
	expect(res.status).toBe(201);
	base = res.body.run.id as string;
	const { sid, runId } = await scenarioRun(owner, pid, base, 'Twice the demand');
	orphan = runId;
	expect((await owner.call('DELETE', `/projects/${pid}/scenarios/${sid}`)).status).toBe(204);
	expect(await asOwner('SELECT scenario_id, from_scenario FROM model_run WHERE id = $1', [orphan])).toEqual([{ scenario_id: null, from_scenario: true }]);
}, 60_000);

describe('a run whose scenario was deleted', () => {
	it('is listed as a scenario run (fromScenario), with the name it recorded; its base is a run of the model', async () => {
		const runs = (await owner.call('GET', `/projects/${pid}/runs`)).body.runs as { id: string; scenarioId: string | null; scenarioName: string | null; fromScenario: boolean }[];
		expect(runs.find((r) => r.id === orphan)).toMatchObject({ scenarioId: null, scenarioName: 'Twice the demand', fromScenario: true });
		expect(runs.find((r) => r.id === base)).toMatchObject({ scenarioId: null, scenarioName: null, fromScenario: false });
		expect((await owner.call('GET', `/projects/${pid}/runs/${orphan}`)).body.run).toMatchObject({ fromScenario: true });
	});

	it('is no base for a scenario or a sweep (409); the base run is', async () => {
		const sc = await owner.call('POST', `/projects/${pid}/scenarios`, { name: 'On the orphan', baseRunId: orphan, ops: [] });
		expect(sc.status).toBe(409);
		expect(sc.body.error).toBe('that run is a scenario run; base a scenario on a run of the model itself');
		const sweep = (baseRunId: string) => owner.call('POST', `/projects/${pid}/sweeps`, { name: 'Demand', baseRunId, members: [{ name: 'Less', ops: [{ op: 'demand.scale', factor: 0.8 }] }] });
		const refused = await sweep(orphan);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe('that run is a scenario run; base a scenario on a run of the model itself');
		// Positive controls.
		expect((await owner.call('POST', `/projects/${pid}/scenarios`, { name: 'On the base', baseRunId: base, ops: [] })).status).toBe(201);
		expect((await sweep(base)).status).toBe(202);
		await retirePendingJobs(pid);
	});

	it('is no base for a scenario, a sweep, an outlook or an assessment, nor an evidence pack’s baseline, nor published, in the database', async () => {
		const guarded = [
			{
				sql: `INSERT INTO scenario (project_id, name, base_run_id, ops_sha256) VALUES ($1, 'sql', $2, repeat('0', 64))`,
				refused: 'is a scenario run; base a scenario on a run of the model'
			},
			{
				sql: `INSERT INTO scenario_sweep (project_id, base_run_id, name) VALUES ($1, $2, 'sql')`,
				refused: 'a sweep is based on an ordinary run of the model'
			},
			{
				sql: `INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels) VALUES ($1, $2, 'sql', '2020-01-15', '2020-01-30', '[]')`,
				refused: 'an outlook is based on an ordinary run of the model'
			},
			{
				sql: `INSERT INTO assessment (project_id, base_run_id, name) VALUES ($1, $2, 'sql')`,
				refused: 'an assessment is based on an ordinary run of the model'
			},
			{
				sql: `INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, manifest, manifest_sha256, report_version, engine_version)
				      VALUES (gen_random_uuid(), $1, $2, 1, '{}', repeat('0', 64), '1', '1')`,
				refused: 'an evidence pack\'s baseline is not a scenario run'
			},
			{
				sql: `INSERT INTO run_publication (project_id, run_id, published_by) VALUES ($1, $2, app_current_user_id())`,
				refused: 'a scenario run cannot be published'
			}
		];
		for (const g of guarded) {
			expect(await attempt(owner, g.sql, [pid, orphan]), g.sql).toContain(g.refused);
			// Positive control: the base run gets past this guard (the row may still fail a later check).
			expect(await attempt(owner, g.sql, [pid, base]), g.sql).not.toContain(g.refused);
		}
	});

	it('is signed off with the scenario statement (the proposed works), the base run with the baseline one', async () => {
		const statement = async (runId: string) => (await owner.call('GET', `/projects/${pid}/runs/${runId}/signoffs`)).body.statement as { scenario: boolean; confirmations: { id: string; text: string }[] };
		const s = await statement(orphan);
		expect(s.scenario).toBe(true);
		expect(s.confirmations.find((c) => c.id === 'works')?.text).toMatch(/^The scenario represents the proposed works/);
		expect((await statement(base)).scenario).toBe(false);
	});

	it('doesn’t release a hold on the automatic runs; a run of the model does', async () => {
		const p = await runnableProject(owner, 'Orphan hold');
		const first = await owner.call('POST', `/projects/${p}/runs`, { label: 'first' });
		expect(first.status).toBe(201);
		await asOwner(`INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject) VALUES ($1, $2, 'OrphanOwner', 'series.held', '{}')`, [p, owner.id]);
		const held = () => withUser(owner.id, (db) => heldSinceLastRun(db, p));
		expect(await held()).toBe(true);
		// A scenario run made after the hold, its scenario then deleted.
		const { sid } = await scenarioRun(owner, p, first.body.run.id as string, 'Later what-if');
		expect((await owner.call('DELETE', `/projects/${p}/scenarios/${sid}`)).status).toBe(204);
		expect(await held()).toBe(true);
		// Positive control: a run of the model releases it.
		expect((await owner.call('POST', `/projects/${p}/runs`, { label: 'second' })).status).toBe(201);
		expect(await held()).toBe(false);
	});
});
