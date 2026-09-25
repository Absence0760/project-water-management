// Pinned runs (015_run_pinned.sql, PATCH /projects/:id/runs/:runId { pinned }):
// a pinned run survives the storage cap (trimRuns), can't be deleted until it
// is unpinned, and a project holds at most PINNED_RUNS_PER_PROJECT_MAX of them.
// Checked at the route (roles, 409s), in RLS (a viewer's UPDATE touches no row)
// and in the pin-limit trigger (the ceiling holds without the API).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { PINNED_RUNS_PER_PROJECT_MAX } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

async function runnable(u: User, name = 'Pinned') {
	const projectId = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return projectId;
}

const newRun = async (u: User, projectId: string, label: string) => {
	const res = await u.call('POST', `/projects/${projectId}/runs`, { label });
	expect(res.status).toBe(201);
	return res.body as { run: { id: string; pinned: boolean }; removedRunIds: string[] };
};
const pin = (u: User, projectId: string, runId: string, pinned: boolean) => u.call('PATCH', `/projects/${projectId}/runs/${runId}`, { pinned });

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;

beforeAll(async () => {
	[owner, editor, viewer, stranger] = await Promise.all([signUp('PinOwner'), signUp('PinEditor'), signUp('PinViewer'), signUp('PinStranger')]);
	projectId = await runnable(owner);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
});

afterEach(() => vi.unstubAllEnvs());

describe('run storage cap with pinned runs', () => {
	it('keeps a pinned run past the cap and trims an unpinned one of the same age', async () => {
		vi.stubEnv('RUNS_KEPT_PER_PROJECT', '20');
		const u = await signUp('PinCapper');
		const p = await runnable(u, 'Pinned cap');
		const baseline = (await newRun(u, p, 'baseline')).run;
		const other = (await newRun(u, p, 'other')).run;
		// A new run is unpinned.
		expect(baseline.pinned).toBe(false);
		const pinned = await pin(u, p, baseline.id, true);
		expect(pinned.status).toBe(200);
		expect(pinned.body.run).toMatchObject({ id: baseline.id, pinned: true, label: 'baseline' });

		const removed: string[] = [];
		for (let i = 1; i <= 20; i++) removed.push(...(await newRun(u, p, `newer ${i}`)).removedRunIds);
		// The unpinned run of the same age went (the positive control); the pinned one didn't count against the cap.
		expect(removed).toEqual([other.id]);
		const list = (await u.call('GET', `/projects/${p}/runs`)).body.runs as { id: string; pinned: boolean }[];
		expect(list).toHaveLength(21);
		expect(list.find((r) => r.id === baseline.id)?.pinned).toBe(true);
		expect(list.filter((r) => r.pinned)).toHaveLength(1);
		expect((await u.call('GET', `/projects/${p}/runs/${other.id}`)).status).toBe(404);
		expect((await u.call('GET', `/projects/${p}/runs/${baseline.id}`)).body.run.pinned).toBe(true);

		// Unpinned, it is the oldest again: the next run trims it.
		expect((await pin(u, p, baseline.id, false)).body.run.pinned).toBe(false);
		expect((await newRun(u, p, 'one more')).removedRunIds).toEqual(expect.arrayContaining([baseline.id]));
	});
});

describe('PATCH /projects/:id/runs/:runId { pinned }', () => {
	it('lets an editor pin and unpin; the note and its stamp are untouched', async () => {
		const run = (await newRun(owner, projectId, 'editor pins')).run;
		expect((await owner.call('PATCH', `/projects/${projectId}/runs/${run.id}`, { notes: 'the baseline' })).status).toBe(200);
		const res = await pin(editor, projectId, run.id, true);
		expect(res.status).toBe(200);
		expect(res.body.run).toMatchObject({ pinned: true, notes: 'the baseline', notesUpdatedBy: 'PinOwner' });
		// Both at once.
		const both = await editor.call('PATCH', `/projects/${projectId}/runs/${run.id}`, { notes: 'rewritten', pinned: false });
		expect(both.body.run).toMatchObject({ pinned: false, notes: 'rewritten', notesUpdatedBy: 'PinEditor' });
		// Pinning twice, or unpinning an unpinned run, is a no-op.
		expect((await pin(editor, projectId, run.id, false)).body.run.pinned).toBe(false);
		expect((await pin(editor, projectId, run.id, true)).body.run.pinned).toBe(true);
		expect((await pin(editor, projectId, run.id, true)).body.run.pinned).toBe(true);
		expect((await pin(editor, projectId, run.id, false)).status).toBe(200);
	});

	it('refuses a viewer (403) and hides the run from a stranger (404); an editor (the positive control) can pin', async () => {
		const run = (await newRun(owner, projectId, 'viewer tries')).run;
		const v = await pin(viewer, projectId, run.id, true);
		expect(v.status).toBe(403);
		expect(v.body).toEqual({ error: 'requires editor role' });
		expect((await pin(stranger, projectId, run.id, true)).status).toBe(404);
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${run.id}`)).body.run.pinned).toBe(false);
		expect((await pin(editor, projectId, run.id, true)).status).toBe(200);
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${run.id}`)).body.run.pinned).toBe(true);
		expect((await pin(editor, projectId, run.id, false)).status).toBe(200);
	});

	it('validates the body', async () => {
		const run = (await newRun(owner, projectId, 'validation')).run;
		for (const body of [{}, { pinned: 'yes' }, { pinned: null }, { pinned: 1 }, { pinned: true, label: 'x' }]) {
			const res = await owner.call('PATCH', `/projects/${projectId}/runs/${run.id}`, body);
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
		expect((await pin(owner, projectId, crypto.randomUUID(), true)).status).toBe(404);
	});

	it(`refuses a pin past ${PINNED_RUNS_PER_PROJECT_MAX} with a 409 that says so; unpinning one makes room`, async () => {
		const u = await signUp('PinCeiling');
		const p = await runnable(u, 'Pin ceiling');
		const ids: string[] = [];
		for (let i = 0; i <= PINNED_RUNS_PER_PROJECT_MAX; i++) ids.push((await newRun(u, p, `run ${i}`)).run.id);
		for (const id of ids.slice(0, PINNED_RUNS_PER_PROJECT_MAX)) expect((await pin(u, p, id, true)).status).toBe(200);
		const last = ids.at(-1)!;
		const over = await pin(u, p, last, true);
		expect(over.status).toBe(409);
		expect(over.body.error).toBe(`this project already has ${PINNED_RUNS_PER_PROJECT_MAX} pinned runs, the most it can keep; unpin one first`);
		// Re-pinning an already-pinned run at the ceiling is fine.
		expect((await pin(u, p, ids[0]!, true)).status).toBe(200);
		expect((await pin(u, p, ids[0]!, false)).status).toBe(200);
		expect((await pin(u, p, last, true)).status).toBe(200);
	});
});

describe('DELETE a pinned run', () => {
	it('refuses (409) until it is unpinned', async () => {
		const run = (await newRun(owner, projectId, 'delete me')).run;
		expect((await pin(owner, projectId, run.id, true)).status).toBe(200);
		const del = await owner.call('DELETE', `/projects/${projectId}/runs/${run.id}`);
		expect(del.status).toBe(409);
		expect(del.body.error).toBe('this run is pinned; unpin it before deleting it');
		expect((await pin(owner, projectId, run.id, false)).status).toBe(200);
		expect((await owner.call('DELETE', `/projects/${projectId}/runs/${run.id}`)).status).toBe(204);
	});
});

describe('pinned in the database', () => {
	const update = (u: User, sql: string, params: unknown[] = []) => withUser(u.id, (db) => db.query(sql, params));

	it("lets RLS skip a viewer's pin; an editor's (the positive control) lands", async () => {
		const run = (await newRun(owner, projectId, 'sql pin')).run;
		expect((await update(viewer, 'UPDATE model_run SET pinned = true WHERE id = $1', [run.id])).rowCount).toBe(0);
		expect((await update(stranger, 'UPDATE model_run SET pinned = true WHERE id = $1', [run.id])).rowCount).toBe(0);
		expect(await asOwner('SELECT pinned FROM model_run WHERE id = $1', [run.id])).toEqual([{ pinned: false }]);
		expect((await update(editor, 'UPDATE model_run SET pinned = true WHERE id = $1', [run.id])).rowCount).toBe(1);
		expect(await asOwner('SELECT pinned FROM model_run WHERE id = $1', [run.id])).toEqual([{ pinned: true }]);
		expect((await update(editor, 'UPDATE model_run SET pinned = false WHERE id = $1', [run.id])).rowCount).toBe(1);
	});

	it('enforces the ceiling in the trigger as well as the API', async () => {
		const u = await signUp('PinTrigger');
		const p = await runnable(u, 'Pin trigger');
		const ids: string[] = [];
		for (let i = 0; i <= PINNED_RUNS_PER_PROJECT_MAX; i++) ids.push((await newRun(u, p, `t ${i}`)).run.id);
		// Straight past the API, one statement pinning every run: the trigger stops it at the ceiling.
		await expect(update(u, 'UPDATE model_run SET pinned = true WHERE project_id = $1', [p])).rejects.toMatchObject({ code: '23514' });
		expect(await asOwner('SELECT count(*)::int AS n FROM model_run WHERE project_id = $1 AND pinned', [p])).toEqual([{ n: 0 }]);
		// Positive control: up to the ceiling it lands.
		const first = ids.slice(0, PINNED_RUNS_PER_PROJECT_MAX);
		expect((await update(u, 'UPDATE model_run SET pinned = true WHERE id = ANY($1::uuid[])', [first])).rowCount).toBe(PINNED_RUNS_PER_PROJECT_MAX);
		await expect(update(u, 'UPDATE model_run SET pinned = true WHERE id = $1', [ids.at(-1)])).rejects.toMatchObject({ code: '23514' });
	});
});
