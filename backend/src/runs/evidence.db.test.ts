// The nominated evidence run (010_run_nomination.sql, GET/POST
// /projects/:id/evidence). Checked at three levels: the route (roles,
// validation, 409s), RLS (who can read and add rows, each with a positive
// control) and the grants (the history is append-only for water_app, and a
// nominated run can't be deleted or trimmed).
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, makeStoredLegacyRun, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { NOMINATIONS_PER_PROJECT_MAX } from './evidence.js';
import { trimRuns } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;

/** A runnable project owned by `u`: two farms, 30 days of rain, GR4J by default. */
async function runnableProject(u: User, name: string) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return id;
}

async function newRun(u: User, pid: string, label: string, settings?: Record<string, unknown>) {
	if (settings) expect((await u.call('PATCH', `/projects/${pid}`, { settings })).status).toBe(200);
	const res = await u.call('POST', `/projects/${pid}/runs`, { label });
	expect(res.status).toBe(201);
	return res.body.run.id as string;
}

const nominate = (u: User, runId: string, reason: unknown = 'the calibrated GR4J run', pid = projectId) =>
	u.call('POST', `/projects/${pid}/evidence`, { runId, reason });
const history = async (u: User, pid = projectId) => (await u.call('GET', `/projects/${pid}/evidence`)).body.nominations as { runId: string; reason: string }[];
const sql = (u: User, text: string, params: unknown[] = []) => withUser(u.id, (db) => db.query(text, params));

let gr4jA: string;
let gr4jB: string;
let legacyRun: string;

beforeAll(async () => {
	[owner, editor, viewer, stranger] = await Promise.all([signUp('EvOwner'), signUp('EvEditor'), signUp('EvViewer'), signUp('EvStranger')]);
	projectId = await runnableProject(owner, 'Evidence');
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
	gr4jA = await newRun(owner, projectId, 'GR4J A');
	// A run saved on the legacy model before engine 1.0.0 removed it (the API can't make one now).
	legacyRun = await newRun(owner, projectId, 'Legacy');
	await makeStoredLegacyRun(legacyRun);
	gr4jB = await newRun(owner, projectId, 'GR4J B');
});

describe('POST /projects/:id/evidence', () => {
	it('refuses a viewer (403) and hides the project from a stranger (404); nothing is recorded', async () => {
		const v = await nominate(viewer, gr4jA);
		expect(v.status).toBe(403);
		expect(v.body).toEqual({ error: 'requires editor role' });
		expect((await nominate(stranger, gr4jA)).status).toBe(404);
		expect((await stranger.call('GET', `/projects/${projectId}/evidence`)).status).toBe(404);
		expect(await history(owner)).toEqual([]);
	});

	it('lets an editor nominate a run (positive control), stamped from the run and the session', async () => {
		const res = await nominate(editor, gr4jA, '  Calibrated GR4J, KGE 0.71 over 2020.\n');
		expect(res.status).toBe(201);
		expect(res.body.nomination).toMatchObject({
			runId: gr4jA,
			runLabel: 'GR4J A',
			runoffModel: 'gr4j',
			reason: 'Calibrated GR4J, KGE 0.71 over 2020.',
			nominatedBy: 'EvEditor'
		});
		expect(res.body.nomination.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(Number.isNaN(Date.parse(res.body.nomination.nominatedAt))).toBe(false);
		expect(res.body.nominations).toHaveLength(1);
		// A viewer reads the history, and the runs list badges the run.
		expect((await history(viewer)).map((n) => n.runId)).toEqual([gr4jA]);
		const runs = (await viewer.call('GET', `/projects/${projectId}/runs`)).body.runs as { id: string; evidence: string | null; runoffModel: string }[];
		expect(runs.find((r) => r.id === gr4jA)).toMatchObject({ evidence: 'current', runoffModel: 'gr4j' });
		expect(runs.find((r) => r.id === gr4jB)).toMatchObject({ evidence: null, runoffModel: 'gr4j' });
		expect(runs.find((r) => r.id === legacyRun)).toMatchObject({ evidence: null, runoffModel: 'legacy' });
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${gr4jA}`)).body.run.evidence).toBe('current');
	});

	it('refuses the current run again, a legacy run, and runs it can’t see, without database error text', async () => {
		const again = await nominate(owner, gr4jA);
		expect(again.status).toBe(409);
		expect(again.body.error).toBe('this run is already the nominated evidence run');
		const legacy = await nominate(owner, legacyRun);
		expect(legacy.status).toBe(409);
		expect(legacy.body.error).toMatch(/legacy runoff model/);
		expect((await nominate(owner, crypto.randomUUID())).status).toBe(404);
		// A run from before engine 0.27.1 that ran with flow shares over 100 % (water from nowhere).
		const overRun = await newRun(owner, projectId, 'Over-allocated', { runoffModel: 'gr4j' });
		const { inputs } = (await asOwner('SELECT inputs FROM model_run WHERE id = $1', [overRun]))[0] as { inputs: { settings: Record<string, unknown>; model: { nodes: { kind: string; flowShareManual: number | null }[] } } };
		inputs.settings.flowShareMethod = 'manual';
		for (const n of inputs.model.nodes) if (n.kind === 'farm') n.flowShareManual = 2;
		await asOwner('UPDATE model_run SET inputs = $2 WHERE id = $1', [overRun, inputs]);
		const over = await nominate(owner, overRun);
		expect(over.status).toBe(409);
		expect(over.body.error).toMatch(/^this run cannot be nominated as evidence: its unit flow shares sum to \d+\.00%, more than 100%/);
		// Another project's run, by an editor of both, is not found through this one.
		const other = await runnableProject(editor, 'Elsewhere');
		const otherRun = await newRun(editor, other, 'Theirs');
		expect((await nominate(editor, otherRun)).status).toBe(404);
		for (const body of [{}, { runId: gr4jB }, { runId: gr4jB, reason: '   ' }, { runId: gr4jB, reason: 'x'.repeat(2001) }, { runId: 'nope', reason: 'r' }, { runId: gr4jB, reason: 'nul \u0000' }, { runId: gr4jB, reason: 'r', nominatedBy: owner.id }]) {
			const res = await owner.call('POST', `/projects/${projectId}/evidence`, body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(JSON.stringify(res.body)).not.toMatch(/run_nomination|violates|relation|column/);
		}
		const raw = await app.request(`/projects/${projectId}/evidence`, {
			method: 'POST',
			headers: { cookie: owner.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: '{not json'
		});
		expect(raw.status).toBe(400);
		expect((await history(owner)).map((n) => n.runId)).toEqual([gr4jA]);
	});

	it('replacing the nomination adds a row and keeps the old one: A, then B, then A again', async () => {
		const b = await nominate(owner, gr4jB, 'Refitted after the 2020 logger check');
		expect(b.status).toBe(201);
		expect(b.body.nominations.map((n: { runId: string }) => n.runId)).toEqual([gr4jA, gr4jB]);
		const runs = (await viewer.call('GET', `/projects/${projectId}/runs`)).body.runs as { id: string; evidence: string | null }[];
		expect(runs.find((r) => r.id === gr4jA)?.evidence).toBe('past');
		expect(runs.find((r) => r.id === gr4jB)?.evidence).toBe('current');
		const back = await nominate(editor, gr4jA, 'Back to A: B used a wrong pan coefficient');
		expect(back.status).toBe(201);
		const h = await history(viewer);
		expect(h.map((n) => n.runId)).toEqual([gr4jA, gr4jB, gr4jA]);
		expect(h.map((n) => n.reason)).toEqual(['Calibrated GR4J, KGE 0.71 over 2020.', 'Refitted after the 2020 logger check', 'Back to A: B used a wrong pan coefficient']);
	});
});

describe('surfaces', () => {
	it('compare carries each side’s evidence status, and what replaced a past one', async () => {
		const cmp = await viewer.call('GET', `/compare/runs?a=${projectId}:${gr4jB}&b=${projectId}:${gr4jA}`);
		expect(cmp.status).toBe(200);
		expect(cmp.body.a.run.evidence).toMatchObject({
			status: 'past',
			reason: 'Refitted after the 2020 logger check',
			nominatedBy: 'EvOwner',
			replacedBy: { runId: gr4jA, runLabel: 'GR4J A', nominatedBy: 'EvEditor', reason: 'Back to A: B used a wrong pan coefficient' }
		});
		expect(cmp.body.b.run.evidence).toMatchObject({ status: 'current', replacedBy: null });
		const plain = await viewer.call('GET', `/compare/runs?a=${projectId}:${legacyRun}&b=${projectId}:${gr4jA}`);
		expect(plain.body.a.run.evidence).toBeNull();
	});

	it('the summary CSV says whether the run is the evidence and, for a replaced one, what replaced it', async () => {
		const csv = async (runId: string) => {
			const res = await app.request(`/projects/${projectId}/runs/${runId}/export/summary.csv`, { headers: { cookie: viewer.cookie, origin: 'http://localhost:7777' } });
			expect(res.status).toBe(200);
			return (await res.text()).split('\r\n');
		};
		const a = await csv(gr4jA);
		expect(a).toContain('Evidence nomination,the nominated evidence run');
		expect(a.some((r) => /^Nominated,\d{4}-\d{2}-\d{2}T[^,]+,EvEditor,Back to A: B used a wrong pan coefficient$/.test(r))).toBe(true);
		const b = await csv(gr4jB);
		expect(b).toContain('Evidence nomination,"nominated before, since replaced"');
		expect(b.some((r) => /^Replaced by,GR4J A,\d{4}-\d{2}-\d{2}T[^,]+,EvEditor,Back to A: B used a wrong pan coefficient$/.test(r))).toBe(true);
		expect(await csv(legacyRun)).toContain('Evidence nomination,not nominated');
	});
});

describe('run_nomination in the database', () => {
	it('lets RLS refuse a viewer’s INSERT and hide the rows from a stranger; an editor’s INSERT lands (positive control)', async () => {
		await expect(sql(viewer, 'INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, $3)', [projectId, gr4jB, 'viewer via SQL'])).rejects.toMatchObject({
			code: '42501'
		});
		expect((await sql(stranger, 'SELECT * FROM run_nomination WHERE project_id = $1', [projectId])).rowCount).toBe(0);
		expect((await sql(viewer, 'SELECT * FROM run_nomination WHERE project_id = $1', [projectId])).rowCount).toBe(3);
		const e = await sql(editor, 'INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, $3)', [projectId, gr4jB, 'editor via SQL']);
		expect(e.rowCount).toBe(1);
		expect((await history(viewer)).at(-1)).toMatchObject({ runId: gr4jB, reason: 'editor via SQL' });
	});

	it('stamps who, when, the model and the engine from the run, whatever the INSERT says', async () => {
		await sql(
			owner,
			`INSERT INTO run_nomination (project_id, run_id, reason, runoff_model, engine_version, nominated_by, nominated_at)
			 VALUES ($1, $2, 'forged', 'legacy', '0.0.1', $3, '2000-01-01')`,
			[projectId, gr4jA, editor.id]
		);
		const { rows } = await sql(owner, `SELECT runoff_model, engine_version, nominated_by, nominated_at FROM run_nomination WHERE reason = 'forged'`);
		expect(rows[0]).toMatchObject({ runoff_model: 'gr4j', nominated_by: owner.id });
		expect(rows[0].engine_version).not.toBe('0.0.1');
		expect(new Date(rows[0].nominated_at).getFullYear()).toBeGreaterThan(2020);
	});

	it('refuses a run from another project and a legacy run in the table as well as the API', async () => {
		const other = await runnableProject(owner, 'Other');
		const otherRun = await newRun(owner, other, 'Other run');
		await expect(sql(owner, `INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'x')`, [projectId, otherRun])).rejects.toMatchObject({ code: '23503' });
		await expect(sql(owner, `INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'x')`, [projectId, legacyRun])).rejects.toMatchObject({ code: '23514' });
		await expect(sql(owner, `INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'x')`, [projectId, gr4jA])).rejects.toMatchObject({ code: '23514' });
	});

	it('is append-only for water_app: UPDATE, DELETE and TRUNCATE are denied even to the owner', async () => {
		for (const text of [
			`UPDATE run_nomination SET reason = 'rewritten' WHERE project_id = $1`,
			`UPDATE run_nomination SET run_id = run_id WHERE project_id = $1`,
			`DELETE FROM run_nomination WHERE project_id = $1`
		]) {
			await expect(sql(owner, text, [projectId]), text).rejects.toMatchObject({ code: '42501' });
		}
		await expect(sql(owner, 'TRUNCATE run_nomination')).rejects.toMatchObject({ code: '42501' });
		// Positive control: the same owner can read every row, and they are all still there.
		expect((await sql(owner, 'SELECT reason FROM run_nomination WHERE project_id = $1', [projectId])).rows.map((r) => r.reason)).toContain(
			'Calibrated GR4J, KGE 0.71 over 2020.'
		);
	});
});

describe('a nominated run is kept', () => {
	it('can’t be deleted, current or past: 409 from the route, a foreign-key refusal in SQL', async () => {
		const h = await history(owner);
		const current = h.at(-1)!.runId;
		const past = current === gr4jA ? gr4jB : gr4jA;
		for (const runId of [current, past]) {
			const res = await editor.call('DELETE', `/projects/${projectId}/runs/${runId}`);
			expect(res.status).toBe(409);
			expect(res.body.error).toBe('this run is or was nominated as evidence, so it is kept');
			await expect(sql(owner, 'DELETE FROM model_run WHERE id = $1', [runId])).rejects.toMatchObject({ code: '23503' });
		}
		// Positive control: a never-nominated run deletes.
		expect((await editor.call('DELETE', `/projects/${projectId}/runs/${legacyRun}`)).status).toBe(204);
	});

	it('survives the run cap, and doesn’t count against it', async () => {
		const pid = await runnableProject(owner, 'Cap');
		const kept = await newRun(owner, pid, 'Nominated');
		expect((await nominate(owner, kept, 'the evidence', pid)).status).toBe(201);
		const older = await newRun(owner, pid, 'Older');
		const newer = await newRun(owner, pid, 'Newer');
		const removed = await withUser(owner.id, (db) => trimRuns(db, pid, 1));
		// The cap keeps the newest un-nominated run; the nominated one stays as well.
		expect(removed).toEqual([older]);
		const left = (await owner.call('GET', `/projects/${pid}/runs`)).body.runs.map((r: { id: string }) => r.id);
		expect(left.sort()).toEqual([kept, newer].sort());
		// Through the route too: a new run with the cap at 1 trims `newer`, never `kept`.
		const prev = process.env.RUNS_KEPT_PER_PROJECT;
		process.env.RUNS_KEPT_PER_PROJECT = '1';
		try {
			const res = await owner.call('POST', `/projects/${pid}/runs`, { label: 'Newest' });
			expect(res.status).toBe(201);
			expect(res.body.removedRunIds).toEqual([newer]);
		} finally {
			if (prev === undefined) delete process.env.RUNS_KEPT_PER_PROJECT;
			else process.env.RUNS_KEPT_PER_PROJECT = prev;
		}
	});

	it('keeps the whole project too: deleting it is refused, history and all (issue #43; projects.db.test.ts)', async () => {
		const pid = await runnableProject(owner, 'Kept');
		const r = await newRun(owner, pid, 'Only');
		expect((await nominate(owner, r, 'why not', pid)).status).toBe(201);
		expect((await owner.call('DELETE', `/projects/${pid}`)).status).toBe(409);
		expect((await sql(owner, 'SELECT 1 FROM run_nomination WHERE project_id = $1', [pid])).rowCount).toBe(1);
	});
});

// 098_nomination_withdrawal: a withdrawal is its own history row, with no run.
describe('withdrawing the nomination', () => {
	const withdraw = (u: User, pid: string, reason: unknown = 'the licence application was withdrawn') => u.call('POST', `/projects/${pid}/evidence/withdraw`, { reason });

	it('adds a row with no run and a reason; the run is past, compare and the CSV say withdrawn; nominating again starts over', async () => {
		const pid = await runnableProject(owner, 'Withdrawn');
		await asOwner('INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)', [pid, editor.id, 'editor', viewer.id, 'viewer']);
		const r = await newRun(owner, pid, 'Evidence run');
		// Nothing to withdraw yet.
		const early = await withdraw(editor, pid);
		expect(early.status).toBe(409);
		expect(early.body.error).toBe('no run is nominated as evidence, so there is nothing to withdraw');
		expect((await nominate(owner, r, 'the calibrated run', pid)).status).toBe(201);
		// A viewer may not; a reason is required.
		expect((await withdraw(viewer, pid)).status).toBe(403);
		expect((await withdraw(editor, pid, '  ')).status).toBe(400);
		const w = await withdraw(editor, pid);
		expect(w.status, JSON.stringify(w.body)).toBe(201);
		expect(w.body.nomination).toMatchObject({
			withdrawn: true,
			runId: null,
			runLabel: null,
			runoffModel: null,
			engineVersion: null,
			reason: 'the licence application was withdrawn',
			nominatedBy: 'EvEditor'
		});
		expect((await history(viewer, pid)).map((n) => n.runId)).toEqual([r, null]);
		const runs = (await viewer.call('GET', `/projects/${pid}/runs`)).body.runs as { id: string; evidence: string | null }[];
		expect(runs.find((x) => x.id === r)?.evidence).toBe('past');
		const cmp = await viewer.call('GET', `/compare/runs?a=${pid}:${r}&b=${pid}:${r}`);
		expect(cmp.body.a.run.evidence).toMatchObject({
			status: 'past',
			replacedBy: { withdrawn: true, runId: null, nominatedBy: 'EvEditor', reason: 'the licence application was withdrawn' }
		});
		const res = await app.request(`/projects/${pid}/runs/${r}/export/summary.csv`, { headers: { cookie: viewer.cookie, origin: 'http://localhost:7777' } });
		const csv = (await res.text()).split('\r\n');
		expect(csv).toContain('Evidence nomination,"nominated before, since withdrawn"');
		expect(csv.some((l) => /^Withdrawn,\d{4}-\d{2}-\d{2}T[^,]+,EvEditor,the licence application was withdrawn$/.test(l))).toBe(true);
		// Twice in a row: nothing is nominated now.
		expect((await withdraw(editor, pid)).status).toBe(409);
		// The project stays undeletable (035): the history is kept, withdrawn or not.
		const del = await owner.call('DELETE', `/projects/${pid}`);
		expect(del.status).toBe(409);
		expect(del.body.details).toEqual({ evidenceRun: null, nominations: 2 });
		// Nominating the same run again makes it current again.
		expect((await nominate(owner, r, 'reinstated', pid)).status).toBe(201);
		const again = (await viewer.call('GET', `/projects/${pid}/runs`)).body.runs as { id: string; evidence: string | null }[];
		expect(again.find((x) => x.id === r)?.evidence).toBe('current');
	});

	it('the table refuses a withdrawal with nothing nominated, and model columns without a run; stamps who and when', async () => {
		const pid = await runnableProject(owner, 'Withdrawn SQL');
		await expect(sql(owner, `INSERT INTO run_nomination (project_id, reason) VALUES ($1, 'nothing')`, [pid])).rejects.toMatchObject({ code: '23514' });
		const r = await newRun(owner, pid, 'R');
		await sql(owner, `INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'n')`, [pid, r]);
		// The trigger clears model columns a withdrawal names, and stamps the author whatever the INSERT says.
		await sql(owner, `INSERT INTO run_nomination (project_id, reason, runoff_model, engine_version, nominated_by) VALUES ($1, 'w', 'gr4j', '9.9.9', $2)`, [pid, editor.id]);
		const rows = (await sql(owner, 'SELECT run_id, runoff_model, engine_version, nominated_by FROM run_nomination WHERE project_id = $1 ORDER BY nominated_at', [pid])).rows;
		expect(rows[1]).toEqual({ run_id: null, runoff_model: null, engine_version: null, nominated_by: owner.id });
		// A viewer's withdrawal is refused by RLS.
		await expect(sql(viewer, `INSERT INTO run_nomination (project_id, reason) VALUES ($1, 'v')`, [projectId])).rejects.toThrow(/row-level security/);
	});
});

describe('the history limit', () => {
	it(`refuses nomination ${NOMINATIONS_PER_PROJECT_MAX + 1} in the API (409) and in the table`, async () => {
		const pid = await runnableProject(owner, 'Limit');
		const x = await newRun(owner, pid, 'X');
		const y = await newRun(owner, pid, 'Y');
		await withUser(owner.id, async (db) => {
			for (let i = 0; i < NOMINATIONS_PER_PROJECT_MAX; i++)
				await db.query('INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, $3)', [pid, i % 2 ? y : x, `n${i}`]);
		});
		// The 50th named y, so x is the one that would be a change.
		const res = await nominate(owner, x, 'one more', pid);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/limit of 50 nominations/);
		await expect(sql(owner, `INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'sql')`, [pid, x])).rejects.toMatchObject({ code: '23514' });
	});
});

describe('forecast runs (WP-2.12)', () => {
	it('refuses to nominate a forecast run (409); an ordinary run of the same data is nominated', async () => {
		const pid = await runnableProject(owner, 'Evidence forecast');
		const forecast = Array.from({ length: 14 }, (_, i) => (i % 4 === 0 ? 8 : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2020-01-31', values: forecast })).status).toBe(200);
		const f = await owner.call('POST', `/projects/${pid}/runs`, { label: 'forecast', forecast: true });
		expect(f.status).toBe(201);
		const refused = await nominate(owner, f.body.run.id, 'the forecast', pid);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/^a forecast run cannot be nominated as evidence/);
		// The stamp trigger refuses it too, past the route (188).
		await expect(sql(owner, `INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'sql')`, [pid, f.body.run.id])).rejects.toMatchObject({
			code: '23514',
			message: 'a forecast run cannot be nominated as evidence'
		});
		expect(await history(owner, pid)).toEqual([]);
		// Positive control: the ordinary run is nominated.
		const ordinary = await newRun(owner, pid, 'ordinary');
		expect((await nominate(owner, ordinary, 'the record', pid)).status).toBe(201);
		expect((await history(owner, pid)).map((n) => n.runId)).toEqual([ordinary]);
	});
});

describe('scenario runs', () => {
	it('refuses to nominate a scenario run (409), and still once its scenario is deleted; its base run is nominated', async () => {
		const pid = await runnableProject(owner, 'Evidence scenario');
		const base = await newRun(owner, pid, 'base');
		const sc = await owner.call('POST', `/projects/${pid}/scenarios`, { name: 'Half demand', baseRunId: base, ops: [{ op: 'demand.scale', factor: 0.5 }] });
		expect(sc.status).toBe(201);
		const sid = sc.body.scenario.id as string;
		const made = await owner.call('POST', `/projects/${pid}/scenarios/${sid}/runs`, {});
		expect(made.status).toBe(201);
		const scenarioRun = made.body.run.id as string;
		const refused = await nominate(owner, scenarioRun, 'the what-if', pid);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/^a scenario run cannot be nominated as evidence/);
		const bySql = () => sql(owner, `INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'sql')`, [pid, scenarioRun]);
		// The stamp trigger refuses it too, past the route (188, issue #380).
		await expect(bySql()).rejects.toMatchObject({ code: '23514', message: 'a scenario run cannot be nominated as evidence' });
		// The scenario deleted: its run keeps the scenario in its inputs (scenario_id goes null), and is refused alike.
		expect((await owner.call('DELETE', `/projects/${pid}/scenarios/${sid}`)).status).toBe(204);
		expect((await asOwner('SELECT scenario_id, from_scenario FROM model_run WHERE id = $1', [scenarioRun]))[0]).toEqual({ scenario_id: null, from_scenario: true });
		const orphan = await nominate(owner, scenarioRun, 'the what-if', pid);
		expect(orphan.status).toBe(409);
		expect(orphan.body.error).toMatch(/^a scenario run cannot be nominated as evidence/);
		await expect(bySql()).rejects.toMatchObject({ code: '23514', message: 'a scenario run cannot be nominated as evidence' });
		expect(await history(owner, pid)).toEqual([]);
		// Positive control: the base run is nominated, by the route and by SQL.
		expect((await nominate(owner, base, 'the record', pid)).status).toBe(201);
		const other = await newRun(owner, pid, 'other');
		expect((await sql(owner, `INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'sql')`, [pid, other])).rowCount).toBe(1);
		expect((await history(owner, pid)).map((n) => n.runId)).toEqual([base, other]);
	});
});
