// Notes and comments (037_notes.sql, roadmap WP-2.7): the API and the RLS
// underneath it. A farmer reads and writes only `farm` notes on their own
// farm and never a `team` note; a soft-deleted note is hidden from everyone
// but editors; only the author edits. Every "cannot see" check has a positive
// control (the same farmer sees their own farm's note; a viewer sees all).
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User; // linked to farm A
let farmer2: User; // linked to farm B
let stranger: User;
let projectId: string;
let otherProjectId: string;
let runId: string;
const outlet = node('Outlet', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);

const notesUrl = (q = '') => `/projects/${projectId}/notes${q}`;
const add = (u: User, body: Record<string, unknown>) => u.call('POST', notesUrl(), body);
/** Rows of `sql` as the user, straight through RLS (water_app with app.current_user_id). */
const rowsAs = async (u: User, sql: string, params: unknown[] = []) => withUser(u.id, async (db) => (await db.query(sql, params)).rows);

beforeAll(async () => {
	[owner, editor, viewer, farmer, farmer2, stranger] = (await Promise.all(['Nowner', 'Neditor', 'Nviewer', 'Nfarmer', 'Nfarmertwo', 'Nstranger'].map((n) => signUp(n)))) as User[] as [
		User,
		User,
		User,
		User,
		User,
		User
	];
	projectId = (await owner.call('POST', '/projects', { name: 'Notes' })).body.project.id;
	otherProjectId = (await owner.call('POST', '/projects', { name: 'Notes elsewhere' })).body.project.id;
	const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
	const model = { nodes: [outlet, farmA, farmB], crops: [crop], cropAreas: [{ nodeId: farmA.id, cropId: crop.id, areaM2: 20_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 40 }, (_, i) => (i % 6 === 0 ? 18 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'notes' })).body.run.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer2.email, nodeIds: [farmB.id] })).status).toBe(201);
}, 60_000);

describe('adding and listing notes', () => {
	it('keeps a note on each kind of target, newest first, with its author', async () => {
		const project = await add(viewer, { body: 'Catchment boundary\nredrawn in 2021' });
		expect(project.status).toBe(201);
		expect(project.body.note).toMatchObject({ body: 'Catchment boundary\nredrawn in 2021', author: 'Nviewer', target: 'project', visibility: 'team', mine: true, canDelete: true, editedAt: null });
		expect((await add(editor, { body: 'Dam raised in 2019 per owner', nodeId: farmA.id })).body.note).toMatchObject({ target: 'node', nodeId: farmA.id, nodeName: 'Farm A' });
		expect((await add(editor, { body: 'Calibrated against the weir', runId })).body.note).toMatchObject({ target: 'run', runId });
		expect((await add(editor, { body: 'a from the 2015 study', settingKey: 'calibration.a' })).body.note).toMatchObject({ target: 'setting', settingKey: 'calibration.a' });

		const all = (await viewer.call('GET', notesUrl())).body.notes;
		expect(all.map((n: { body: string }) => n.body).slice(0, 4)).toEqual(['a from the 2015 study', 'Calibrated against the weir', 'Dam raised in 2019 per owner', 'Catchment boundary\nredrawn in 2021']);
		// The viewer didn't write the editor's notes: can't edit or delete them.
		expect(all.find((n: { runId: string | null }) => n.runId === runId)).toMatchObject({ mine: false, canDelete: false });
	});

	it('filters by target, and a settings group matches its keys', async () => {
		expect((await viewer.call('GET', notesUrl(`?nodeId=${farmA.id}`))).body.notes.map((n: { body: string }) => n.body)).toEqual(['Dam raised in 2019 per owner']);
		expect((await viewer.call('GET', notesUrl(`?runId=${runId}`))).body.notes).toHaveLength(1);
		expect((await viewer.call('GET', notesUrl('?settingKey=calibration'))).body.notes.map((n: { settingKey: string }) => n.settingKey)).toEqual(['calibration.a']);
		// A group is a whole path segment: `calib` isn't a prefix of `calibration.a`.
		expect((await viewer.call('GET', notesUrl('?settingKey=calib'))).body.notes).toEqual([]);
		expect((await viewer.call('GET', notesUrl('?target=project'))).body.notes.map((n: { target: string }) => n.target)).toEqual(['project']);
		expect((await viewer.call('GET', notesUrl('?limit=1'))).body.notes).toHaveLength(1);
		expect((await viewer.call('GET', notesUrl('?nodeId=not-a-uuid'))).status).toBe(400);
	});

	it('counts notes per target for the badges', async () => {
		const counts = (await viewer.call('GET', notesUrl('/counts'))).body;
		expect(counts.project).toBe(1);
		expect(counts.nodes[farmA.id]).toBe(1);
		expect(counts.runs[runId]).toBe(1);
		expect(counts.settings['calibration.a']).toBe(1);
	});

	it('refuses more than one target, an empty body, a farm note off a farm, and a target from another project', async () => {
		expect((await add(editor, { body: 'x', nodeId: farmA.id, runId })).status).toBe(400);
		expect((await add(editor, { body: '   ' })).status).toBe(400);
		expect((await add(editor, { body: 'x'.repeat(4001) })).status).toBe(400);
		expect((await add(editor, { body: 'x', visibility: 'farm' })).status).toBe(400);
		expect((await add(editor, { body: 'x', nodeId: outlet.id, visibility: 'farm' })).status).toBe(400);
		expect((await add(editor, { body: 'x', settingKey: 'bad key' })).status).toBe(400);
		const other = node('Elsewhere', null);
		expect((await owner.call('PUT', `/projects/${otherProjectId}/model`, { nodes: [other], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect((await add(editor, { body: 'x', nodeId: other.id })).status).toBe(404);
		// Straight past the API, the same-project trigger refuses it too.
		await expect(
			rowsAs(editor, `INSERT INTO note (project_id, author_id, body, node_id) VALUES ($1, $2, 'x', $3)`, [projectId, editor.id, other.id])
		).rejects.toMatchObject({ code: '23503' });
	});

	it('answers a non-member 404 and never lists another project', async () => {
		expect((await stranger.call('GET', notesUrl())).status).toBe(404);
		expect((await add(stranger, { body: 'x' })).status).toBe(404);
		expect(await rowsAs(stranger, 'SELECT 1 FROM note WHERE project_id = $1', [projectId])).toEqual([]);
		// Positive control: the viewer sees the project's notes through the same query.
		expect((await rowsAs(viewer, 'SELECT 1 FROM note WHERE project_id = $1', [projectId])).length).toBeGreaterThan(0);
	});
});

describe('farmers', () => {
	let farmNoteId: string;

	it('lets a farmer read and write farm-visible notes on their own farm only (positive control)', async () => {
		const wua = await add(editor, { body: 'Borehole test booked for May', nodeId: farmA.id, visibility: 'farm' });
		expect(wua.status).toBe(201);
		farmNoteId = wua.body.note.id;
		const own = await add(farmer, { body: 'Logger moved in March', nodeId: farmA.id });
		expect(own.status).toBe(201);
		// A farmer's note is farm-visible by default.
		expect(own.body.note).toMatchObject({ visibility: 'farm', mine: true, canDelete: true, nodeName: 'Farm A' });

		const seen = (await farmer.call('GET', notesUrl(`?nodeId=${farmA.id}`))).body.notes.map((n: { body: string }) => n.body);
		expect(seen).toEqual(['Logger moved in March', 'Borehole test booked for May']);
		// The WUA sees the farmer's note.
		expect((await viewer.call('GET', notesUrl(`?nodeId=${farmA.id}`))).body.notes.map((n: { body: string }) => n.body)).toContain('Logger moved in March');
	});

	it("never shows a farmer a team note, another farm's note, a run or settings note, or a project note", async () => {
		expect((await add(editor, { body: 'Farm B farm note', nodeId: farmB.id, visibility: 'farm' })).status).toBe(201);
		const all = (await farmer.call('GET', notesUrl())).body.notes;
		expect(all.every((n: { visibility: string; nodeId: string }) => n.visibility === 'farm' && n.nodeId === farmA.id)).toBe(true);
		expect(all.map((n: { body: string }) => n.body)).not.toContain('Dam raised in 2019 per owner');
		expect(all.map((n: { body: string }) => n.body)).not.toContain('Farm B farm note');
		// Straight through RLS as well.
		const raw = await rowsAs(farmer, 'SELECT visibility, node_id FROM note WHERE project_id = $1', [projectId]);
		expect(raw.length).toBe(2);
		expect(raw.every((r) => r.visibility === 'farm' && r.node_id === farmA.id)).toBe(true);
		// Positive control: the other farmer sees their own farm's note.
		expect((await farmer2.call('GET', notesUrl())).body.notes.map((n: { body: string }) => n.body)).toEqual(['Farm B farm note']);
		// And the counts only count what the farmer can see.
		const counts = (await farmer.call('GET', notesUrl('/counts'))).body;
		expect(counts).toEqual({ project: 0, nodes: { [farmA.id]: 2 }, runs: {}, settings: {}, scenarios: {}, packs: {} });
	});

	it("refuses a farmer's team note, project note and note on another farm", async () => {
		const team = await add(farmer, { body: 'x', nodeId: farmA.id, visibility: 'team' });
		expect(team.status).toBe(403);
		// A stable code the farm page words in the reader's language (docs/api.md § Errors).
		expect(team.body.code).toBe('note_farmer_own_farm');
		expect((await add(farmer, { body: 'x' })).status).toBe(403);
		expect((await add(farmer, { body: 'x', settingKey: 'calibration.a' })).status).toBe(403);
		expect((await add(farmer, { body: 'x', runId })).status).toBe(403);
		// Farm B is invisible to them: not found, as if it didn't exist.
		expect((await add(farmer, { body: 'x', nodeId: farmB.id })).status).toBe(404);
		// Straight past the API, RLS refuses the same rows.
		for (const [nodeId, visibility] of [
			[farmA.id, 'team'],
			[farmB.id, 'farm']
		]) {
			await expect(
				rowsAs(farmer, `INSERT INTO note (project_id, author_id, body, node_id, visibility) VALUES ($1, $2, 'x', $3, $4)`, [projectId, farmer.id, nodeId, visibility])
			).rejects.toMatchObject({ code: '42501' });
		}
		// Nor as someone else.
		await expect(
			rowsAs(farmer, `INSERT INTO note (project_id, author_id, body, node_id, visibility) VALUES ($1, $2, 'x', $3, 'farm')`, [projectId, editor.id, farmA.id])
		).rejects.toMatchObject({ code: '42501' });
	});

	it("lets a farmer edit and delete their own note but not the WUA's", async () => {
		expect((await farmer.call('PATCH', notesUrl(`/${farmNoteId}`), { body: 'changed' })).status).toBe(403);
		expect((await farmer.call('DELETE', notesUrl(`/${farmNoteId}`))).status).toBe(403);
		const mine = (await add(farmer, { body: 'Pump replaced', nodeId: farmA.id })).body.note.id;
		const edited = await farmer.call('PATCH', notesUrl(`/${mine}`), { body: 'Pump replaced in June' });
		expect(edited.status).toBe(200);
		expect(edited.body.note.editedAt).not.toBeNull();
		expect((await farmer.call('DELETE', notesUrl(`/${mine}`))).status).toBe(204);
		expect((await farmer.call('GET', notesUrl())).body.notes.map((n: { id: string }) => n.id)).not.toContain(mine);
	});
});

describe('editing and deleting', () => {
	let noteId: string;

	beforeAll(async () => {
		noteId = (await add(viewer, { body: 'Gauge rated in 2018', nodeId: outlet.id })).body.note.id;
	});

	it('lets only the author edit the body, and stamps edited_at', async () => {
		expect((await editor.call('PATCH', notesUrl(`/${noteId}`), { body: 'moderated' })).status).toBe(403);
		expect((await owner.call('PATCH', notesUrl(`/${noteId}`), { body: 'moderated' })).status).toBe(403);
		// Straight through RLS, the guard trigger refuses an editor's body change too.
		await expect(rowsAs(editor, `UPDATE note SET body = 'moderated' WHERE id = $1`, [noteId])).rejects.toMatchObject({ code: '42501' });
		const res = await viewer.call('PATCH', notesUrl(`/${noteId}`), { body: 'Gauge re-rated in 2018' });
		expect(res.status).toBe(200);
		expect(res.body.note).toMatchObject({ body: 'Gauge re-rated in 2018', target: 'node', nodeId: outlet.id });
		expect(res.body.note.editedAt).not.toBeNull();
		// The target and visibility are fixed: water_app has no UPDATE on them.
		await expect(rowsAs(viewer, `UPDATE note SET visibility = 'farm' WHERE id = $1`, [noteId])).rejects.toMatchObject({ code: '42501' });
		await expect(rowsAs(viewer, `UPDATE note SET node_id = NULL WHERE id = $1`, [noteId])).rejects.toMatchObject({ code: '42501' });
	});

	it('lets an editor soft-delete any note, keeps the body for the audit trail, hides it from non-editors and records note.deleted', async () => {
		expect((await viewer.call('DELETE', notesUrl(`/${(await add(editor, { body: 'not yours' })).body.note.id}`))).status).toBe(403);
		expect((await editor.call('DELETE', notesUrl(`/${noteId}`))).status).toBe(204);
		expect((await viewer.call('GET', notesUrl())).body.notes.map((n: { id: string }) => n.id)).not.toContain(noteId);
		// RLS: kept (with its body) for editors, and for its author, who wrote it.
		expect((await rowsAs(viewer, 'SELECT 1 FROM note WHERE id = $1', [noteId])).length).toBe(1);
		const [kept] = await rowsAs(editor, 'SELECT body, deleted_by FROM note WHERE id = $1', [noteId]);
		expect(kept).toEqual({ body: 'Gauge re-rated in 2018', deleted_by: editor.id });
		const [event] = await asOwner(`SELECT actor_user_id, subject FROM audit_event WHERE project_id = $1 AND kind = 'note.deleted' AND subject->>'noteId' = $2`, [projectId, noteId]);
		expect(event).toMatchObject({ actor_user_id: editor.id, subject: { target: 'node', nodeName: 'Outlet', author: 'Nviewer', authorId: viewer.id, own: false } });
		expect(JSON.stringify(event.subject)).not.toContain('Gauge re-rated');
		// A deleted note stays deleted: not found for another delete or an edit.
		expect((await editor.call('DELETE', notesUrl(`/${noteId}`))).status).toBe(404);
		expect((await viewer.call('PATCH', notesUrl(`/${noteId}`), { body: 'back' })).status).toBe(404);
	});

	it('hides a deleted note from a non-editor who did not write it, and from its farmers', async () => {
		const team = (await add(editor, { body: 'Moderated team note' })).body.note.id;
		const farm = (await add(editor, { body: 'Moderated farm note', nodeId: farmA.id, visibility: 'farm' })).body.note.id;
		// Positive control: both see them before the delete.
		expect((await rowsAs(viewer, 'SELECT 1 FROM note WHERE id = $1', [team])).length).toBe(1);
		expect((await rowsAs(farmer, 'SELECT 1 FROM note WHERE id = $1', [farm])).length).toBe(1);
		for (const id of [team, farm]) expect((await editor.call('DELETE', notesUrl(`/${id}`))).status).toBe(204);
		expect(await rowsAs(viewer, 'SELECT 1 FROM note WHERE id = $1', [team])).toEqual([]);
		expect(await rowsAs(farmer, 'SELECT 1 FROM note WHERE id = $1', [farm])).toEqual([]);
		// The owner is an editor too: kept for moderators.
		expect((await rowsAs(owner, 'SELECT 1 FROM note WHERE id = ANY($1::uuid[])', [[team, farm]])).length).toBe(2);
	});

	it("lets a viewer delete their own note", async () => {
		const id = (await add(viewer, { body: 'mine to remove' })).body.note.id;
		expect((await viewer.call('DELETE', notesUrl(`/${id}`))).status).toBe(204);
		expect((await viewer.call('GET', notesUrl())).body.notes.map((n: { id: string }) => n.id)).not.toContain(id);
	});

	it('removes nothing: water_app has no DELETE on notes', async () => {
		await expect(rowsAs(owner, 'DELETE FROM note WHERE project_id = $1', [projectId])).rejects.toMatchObject({ code: '42501' });
	});

	it('answers 404 for an unknown or malformed note id', async () => {
		expect((await viewer.call('PATCH', notesUrl(`/${crypto.randomUUID()}`), { body: 'x' })).status).toBe(404);
		expect((await viewer.call('DELETE', notesUrl('/nope'))).status).toBe(404);
	});

	it('drops a run note with its run', async () => {
		const run = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'to go' })).body.run.id;
		expect((await add(editor, { body: 'short-lived', runId: run })).status).toBe(201);
		expect((await owner.call('DELETE', `/projects/${projectId}/runs/${run}`)).status).toBe(204);
		expect((await viewer.call('GET', notesUrl(`?runId=${run}`))).body.notes).toEqual([]);
	});
});

// Decisions in docs/data-model.md § Notes: the export carries the notes as a
// record (never a deleted one), the importer ignores them, and a copy starts
// with none.
describe('notes in the project export and copy', () => {
	interface ExportedNote {
		body: string;
		author: string | null;
		target: string;
		nodeId: string | null;
		nodeName: string | null;
		runId: string | null;
		runLabel: string | null;
		settingKey: string | null;
		visibility: string;
	}
	const exportAs = async (u: User) => u.call('GET', `/projects/${projectId}/export.json`);
	let deletedBodies: string[];

	beforeAll(async () => {
		expect((await farmer.call('POST', notesUrl(), { body: 'Borehole pump replaced', nodeId: farmA.id })).status).toBe(201);
		// Set up by the tests above: soft-deleted notes whose bodies RLS still shows to editors and their authors.
		deletedBodies = (await asOwner('SELECT body FROM note WHERE project_id = $1 AND deleted_at IS NOT NULL', [projectId])).map((r) => r.body as string);
		expect(deletedBodies.length).toBeGreaterThan(0);
	});

	it('exports every undeleted note the viewer can read, with its target, author and visibility', async () => {
		const res = await exportAs(viewer);
		expect(res.status).toBe(200);
		const notes = res.body.notes as ExportedNote[];
		const listed = (await viewer.call('GET', notesUrl('?limit=500'))).body.notes as { body: string }[];
		expect(notes.map((n) => n.body).sort()).toEqual(listed.map((n) => n.body).sort());
		expect(notes.find((n) => n.body === 'Dam raised in 2019 per owner')).toMatchObject({ author: 'Neditor', target: 'node', nodeId: farmA.id, nodeName: 'Farm A', visibility: 'team' });
		expect(notes.find((n) => n.body === 'Borehole pump replaced')).toMatchObject({ author: 'Nfarmer', target: 'node', nodeId: farmA.id, visibility: 'farm' });
		expect(notes.find((n) => n.body === 'Calibrated against the weir')).toMatchObject({ target: 'run', runId, runLabel: 'notes' });
		expect(notes.find((n) => n.body === 'a from the 2015 study')).toMatchObject({ target: 'setting', settingKey: 'calibration.a', nodeId: null, runId: null });
		// A node note points at a node in the document's own model.
		const ids = new Set((res.body.model.nodes as { id: string }[]).map((n) => n.id));
		for (const n of notes.filter((x) => x.nodeId)) expect(ids.has(n.nodeId!)).toBe(true);
	});

	it('never exports a deleted note, not even to an editor or its author, whom RLS shows the body', async () => {
		// Positive control: RLS does show the editor the deleted bodies.
		expect((await rowsAs(editor, 'SELECT body FROM note WHERE project_id = $1 AND deleted_at IS NOT NULL', [projectId])).length).toBe(deletedBodies.length);
		for (const u of [editor, viewer, owner]) {
			const text = JSON.stringify((await exportAs(u)).body.notes);
			for (const body of deletedBodies) expect(text).not.toContain(body);
		}
	});

	it('gives a farmer no export, so no team note leaves through it', async () => {
		expect((await exportAs(farmer)).status).toBe(403);
	});

	it('imports the rest of the document but none of its notes', async () => {
		const doc = (await exportAs(viewer)).body;
		expect(doc.notes.length).toBeGreaterThan(0);
		const res = await viewer.call('POST', '/projects/import', { ...doc, name: 'Notes imported' });
		expect(res.status).toBe(201);
		const imported = res.body.project.id as string;
		expect((await viewer.call('GET', `/projects/${imported}/model`)).body.nodes).toHaveLength(3);
		expect((await viewer.call('GET', `/projects/${imported}/notes`)).body.notes).toEqual([]);
		expect(await asOwner('SELECT 1 FROM note WHERE project_id = $1', [imported])).toEqual([]);
	});

	it('copies a project without its notes, and the original keeps them', async () => {
		const before = (await viewer.call('GET', notesUrl('?limit=500'))).body.notes.length;
		const res = await editor.call('POST', `/projects/${projectId}/copy`, { name: 'Notes copy' });
		expect(res.status).toBe(201);
		const copy = res.body.project.id as string;
		expect((await editor.call('GET', `/projects/${copy}/notes`)).body.notes).toEqual([]);
		expect((await editor.call('GET', `/projects/${copy}/notes/counts`)).body).toEqual({ project: 0, nodes: {}, runs: {}, settings: {}, scenarios: {}, packs: {} });
		expect(await asOwner('SELECT 1 FROM note WHERE project_id = $1', [copy])).toEqual([]);
		expect((await viewer.call('GET', notesUrl('?limit=500'))).body.notes).toHaveLength(before);
	});
});
