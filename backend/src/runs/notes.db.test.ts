// Run notes (007_run_notes.sql, PATCH /projects/:id/runs/:runId): the one
// part of a run that may change after it is made. Checked at three levels:
// the route (roles, validation), RLS (a viewer's UPDATE touches no row) and
// the column grant (water_app can update `notes` and nothing else).
import { beforeAll, describe, expect, it } from 'vitest';
import { app, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
let runId: string;

beforeAll(async () => {
	[owner, editor, viewer, stranger] = await Promise.all([signUp('NotesOwner'), signUp('NotesEditor'), signUp('NotesViewer'), signUp('NotesStranger')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Notes' })).body.project.id;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'baseline' });
	expect(run.status).toBe(201);
	runId = run.body.run.id;
	// A new run has no note yet.
	expect(run.body.run).toMatchObject({ notes: '', notesUpdatedAt: null, notesUpdatedBy: null });
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
});

const patch = (u: User, body: unknown, rid = runId, pid = projectId) => u.call('PATCH', `/projects/${pid}/runs/${rid}`, body);
const note = (u: User) => withUser(u.id, async (db) => (await db.query<{ notes: string }>('SELECT notes FROM model_run WHERE id = $1', [runId])).rows[0]?.notes);

describe('PATCH /projects/:id/runs/:runId', () => {
	it('lets an editor write the note, stamps who and when, and shows it on the run, the list and the compare view', async () => {
		const res = await patch(editor, { notes: '  The quaternary includes an irrigated tributary outside the model.\n' });
		expect(res.status).toBe(200);
		expect(res.body.run).toMatchObject({
			id: runId,
			label: 'baseline',
			notes: 'The quaternary includes an irrigated tributary outside the model.',
			notesUpdatedBy: 'NotesEditor'
		});
		expect(Number.isNaN(Date.parse(res.body.run.notesUpdatedAt))).toBe(false);

		// Every reader sees it: the run, the list, and a comparison.
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${runId}`)).body.run.notes).toMatch(/irrigated tributary/);
		const listed = (await viewer.call('GET', `/projects/${projectId}/runs`)).body.runs.find((r: { id: string }) => r.id === runId);
		expect(listed).toMatchObject({ notes: res.body.run.notes, notesUpdatedBy: 'NotesEditor' });
		const cmp = await viewer.call('GET', `/compare/runs?a=${projectId}:${runId}&b=${projectId}:${runId}`);
		expect(cmp.status).toBe(200);
		expect(cmp.body.a.run).toMatchObject({ notes: res.body.run.notes, notesUpdatedBy: 'NotesEditor' });
	});

	it('lets the owner rewrite and clear it; the stamp follows the last writer', async () => {
		expect((await patch(owner, { notes: 'Owner rewrote this.' })).body.run).toMatchObject({ notes: 'Owner rewrote this.', notesUpdatedBy: 'NotesOwner' });
		const cleared = await patch(owner, { notes: '' });
		expect(cleared.status).toBe(200);
		expect(cleared.body.run.notes).toBe('');
		expect(await note(owner)).toBe('');
	});

	it('refuses a viewer (403) and hides the run from a stranger (404); the note is unchanged', async () => {
		expect((await patch(editor, { notes: 'kept' })).status).toBe(200);
		const v = await patch(viewer, { notes: 'viewer was here' });
		expect(v.status).toBe(403);
		expect(v.body).toEqual({ error: 'requires editor role' });
		expect((await patch(stranger, { notes: 'stranger' })).status).toBe(404);
		expect(await note(owner)).toBe('kept');
	});

	it('validates the body and the ids, without database error text', async () => {
		const tooLong = await patch(editor, { notes: 'x'.repeat(4001) });
		expect(tooLong.status).toBe(400);
		expect(tooLong.body.error).toBe('invalid request');
		// The limit is inclusive.
		expect((await patch(editor, { notes: 'x'.repeat(4000) })).status).toBe(200);
		for (const body of [{}, { notes: 42 }, { notes: null }, { notes: 'ok', label: 'renamed' }, { notes: 'nul \u0000 byte' }]) {
			const res = await patch(editor, body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(JSON.stringify(res.body)).not.toMatch(/model_run|violates|column|relation/);
		}
		// Not JSON at all.
		const raw = await app.request(`/projects/${projectId}/runs/${runId}`, {
			method: 'PATCH',
			headers: { cookie: editor.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: '{not json'
		});
		expect(raw.status).toBe(400);
		expect((await patch(editor, { notes: 'x' }, 'not-a-uuid')).status).toBe(404);
		expect((await patch(editor, { notes: 'x' }, crypto.randomUUID())).status).toBe(404);
		// A run id from another project is not found through this one.
		const other = (await editor.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id as string;
		expect((await patch(editor, { notes: 'x' }, runId, other)).status).toBe(404);
		// The label is still what the run was made with.
		expect((await owner.call('GET', `/projects/${projectId}/runs/${runId}`)).body.run.label).toBe('baseline');
	});
});

describe('the summary CSV', () => {
	it('carries the note, who last changed it, and the WR2012 block', async () => {
		expect((await patch(editor, { notes: 'Flag queried: tributary, see report §3' })).status).toBe(200);
		const res = await app.request(`/projects/${projectId}/runs/${runId}/export/summary.csv`, {
			headers: { cookie: viewer.cookie, origin: 'http://localhost:7777' }
		});
		expect(res.status).toBe(200);
		const rows = (await res.text()).split('\r\n');
		expect(rows).toContain('Run notes,"Flag queried: tributary, see report §3"');
		expect(rows.some((r) => /^Notes last changed,\d{4}-\d{2}-\d{2}T[^,]+,NotesEditor$/.test(r))).toBe(true);
		// This project has no WR2012 reference: the block says so.
		expect(rows).toContain('Not checked: no WR2012 reference in the settings the run used');
	});
});

describe('model_run update rules in the database', () => {
	const update = (u: User, sql: string, params: unknown[] = []) => withUser(u.id, (db) => db.query(sql, params));

	it('lets RLS skip a viewer’s UPDATE of the note; an editor’s (the positive control) lands', async () => {
		const v = await update(viewer, 'UPDATE model_run SET notes = $2 WHERE id = $1', [runId, 'viewer via SQL']);
		expect(v.rowCount).toBe(0);
		// …and the viewer can still read the run, so it was the policy, not visibility.
		expect(await note(viewer)).not.toBe('viewer via SQL');
		const s = await update(stranger, 'UPDATE model_run SET notes = $2 WHERE id = $1', [runId, 'stranger via SQL']);
		expect(s.rowCount).toBe(0);
		const e = await update(editor, 'UPDATE model_run SET notes = $2 WHERE id = $1', [runId, 'editor via SQL']);
		expect(e.rowCount).toBe(1);
		expect(await note(viewer)).toBe('editor via SQL');
	});

	it('grants water_app UPDATE on no other column, even to the owner', async () => {
		for (const set of [
			"label = 'renamed'",
			"summary = '{}'::jsonb",
			"inputs = '{}'::jsonb",
			"engine_version = '9.9.9'",
			"start_date = '1900-01-01'",
			'created_by = created_by',
			'project_id = project_id',
			'notes_updated_at = now()',
			'notes_updated_by = NULL',
			// Naming a forbidden column alongside notes fails the whole statement.
			"notes = 'both', label = 'both'"
		]) {
			await expect(update(owner, `UPDATE model_run SET ${set} WHERE id = $1`, [runId]), set).rejects.toMatchObject({ code: '42501' });
		}
		// Positive control: the same owner, the same row, the note column.
		expect((await update(owner, 'UPDATE model_run SET notes = $2 WHERE id = $1', [runId, 'owner via SQL'])).rowCount).toBe(1);
	});

	it('enforces the 4000-character limit in the table as well as the API', async () => {
		await expect(update(editor, 'UPDATE model_run SET notes = repeat($2, 4001) WHERE id = $1', [runId, 'y'])).rejects.toMatchObject({ code: '23514' });
	});
});
