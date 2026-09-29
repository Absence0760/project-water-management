// The change history (WP-2.4, 030_history.sql): revisions of the project's
// inputs, series revisions, audit events, restore, and who may read them.
// Every "cannot see" has its positive control. Synthetic data only.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, lastMailTo, monthly, node, signUp, tokenIn } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { SERIES_REVISIONS_KEPT } from './record.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;

const outlet = node('Weir', null);
const farm = node('Hilltop', outlet.id, { damCapacityM3: 100_000 });
const other = node('Riverside', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const baseModel = () => ({
	nodes: [outlet, farm, other],
	crops: [crop],
	cropAreas: [
		{ nodeId: farm.id, cropId: crop.id, areaM2: 100_000 },
		{ nodeId: other.id, cropId: crop.id, areaM2: 50_000 }
	],
	transfers: []
});
const withDam = (m: ReturnType<typeof baseModel>, cap: number) => ({ ...m, nodes: m.nodes.map((n) => (n.id === farm.id ? { ...n, damCapacityM3: cap } : n)) });

const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);
const revisions = (pid = projectId) => asOwner('SELECT id, source, reason, changes, node_ids, restored_from, change_set FROM model_revision WHERE project_id = $1 ORDER BY id', [pid]);
const events = (pid = projectId, kind?: string) =>
	asOwner(`SELECT kind, subject, actor_user_id, actor_label, change_set FROM audit_event WHERE project_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY id`, kind ? [pid, kind] : [pid]);
const texts = (changes: { text: string }[]) => changes.map((c) => c.text);

beforeAll(async () => {
	[owner, editor, viewer, farmer, stranger] = (await Promise.all(['Hownerx', 'Heditor', 'Hviewer', 'Hfarmer', 'Hstranger'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'History' })).body.project.id;
	for (const [u, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
	expect((await editor.call('PUT', `/projects/${projectId}/model`, baseModel())).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
}, 60_000);

describe('model revisions', () => {
	it('records the state before the first change as the baseline, then the change', async () => {
		const revs = await revisions();
		expect(revs.map((r) => r.source)).toEqual(['baseline', 'model_put']);
		expect(revs[0].changes).toEqual([]);
		expect(texts(revs[1].changes)).toContain('Farm "Hilltop" added (10 km², dam 100\u202f000 m³, drains into Weir)');
		expect([...revs[1].node_ids].sort()).toEqual([outlet.id, farm.id, other.id].sort());
	});

	it('writes exactly one revision for a PUT /model, with the change, its reason and the node it touched', async () => {
		const before = (await revisions()).length;
		const res = await editor.call('PUT', `/projects/${projectId}/model`, { ...withDam(baseModel(), 250_000), reason: 'Surveyed in August' });
		expect(res.status).toBe(200);
		const revs = await revisions();
		expect(revs).toHaveLength(before + 1);
		const r = revs.at(-1)!;
		expect(r.source).toBe('model_put');
		expect(r.reason).toBe('Surveyed in August');
		expect(texts(r.changes)).toEqual(['Hilltop: dam capacity 100\u202f000 m³ → 250\u202f000 m³']);
		expect(r.node_ids).toEqual([farm.id]);
	});

	it('writes nothing for a save that changes nothing', async () => {
		const before = (await revisions()).length;
		const current = (await editor.call('GET', `/projects/${projectId}/model`)).body;
		expect((await editor.call('PUT', `/projects/${projectId}/model`, { ...current, reason: 'no change' })).status).toBe(200);
		expect(await revisions()).toHaveLength(before);
	});

	it('refuses a reason over 500 characters, and writes nothing', async () => {
		const before = (await revisions()).length;
		const res = await editor.call('PUT', `/projects/${projectId}/model`, { ...withDam(baseModel(), 1), reason: 'x'.repeat(501) });
		expect(res.status).toBe(400);
		expect(await revisions()).toHaveLength(before);
	});

	it('records a settings change with its reason, and not a PATCH that leaves the settings as they are', async () => {
		const before = (await revisions()).length;
		expect((await editor.call('PATCH', `/projects/${projectId}`, { settings: { lakeEvapFactor: 0.8 }, reason: 'Open-water factor' })).status).toBe(200);
		const revs = await revisions();
		expect(revs).toHaveLength(before + 1);
		expect(revs.at(-1)).toMatchObject({ source: 'settings_patch', reason: 'Open-water factor', node_ids: [] });
		expect(revs.at(-1)!.changes.length).toBeGreaterThan(0);
		expect((await editor.call('PATCH', `/projects/${projectId}`, { settings: { lakeEvapFactor: 0.8 } })).status).toBe(200);
		expect(await revisions()).toHaveLength(before + 1);
	});

	it('restores a revision: GET /model equals its snapshot, as a new revision pointing back at it', async () => {
		const target = (await revisions()).find((r) => r.source === 'model_put' && r.reason === null)!; // the first save: dam 100 000
		const detail = await viewer.call('GET', `/projects/${projectId}/history/revisions/${target.id}`);
		expect(detail.status).toBe(200);
		expect(texts(detail.body.preview)).toContain('Hilltop: dam capacity 250\u202f000 m³ → 100\u202f000 m³');
		const res = await editor.call('POST', `/projects/${projectId}/history/revisions/${target.id}/restore`, { reason: 'Back to the licence figure' });
		expect(res.status).toBe(201);
		expect(res.body.revision).toMatchObject({ source: 'restore', reason: 'Back to the licence figure' });
		const model = (await editor.call('GET', `/projects/${projectId}/model`)).body;
		expect(model).toEqual(detail.body.revision.snapshot.model);
		const last = (await revisions()).at(-1)!;
		expect(last).toMatchObject({ source: 'restore', restored_from: target.id });
		// Restoring the same version again changes nothing: 409, and nothing is written.
		const count = (await revisions()).length;
		expect((await editor.call('POST', `/projects/${projectId}/history/revisions/${target.id}/restore`, {})).status).toBe(409);
		expect(await revisions()).toHaveLength(count);
	});

	it('lets only editors restore; viewers read', async () => {
		const target = (await revisions())[1]!;
		expect((await viewer.call('POST', `/projects/${projectId}/history/revisions/${target.id}/restore`, {})).status).toBe(403);
		expect((await viewer.call('GET', `/projects/${projectId}/history/revisions/${target.id}`)).status).toBe(200);
	});

	it('restores a deleted farm without its farmer links, recording the unlink and listing whom to re-link', async () => {
		const withFarm = (await revisions()).at(-1)!;
		const noFarm = { ...baseModel(), nodes: [outlet, other], cropAreas: [{ nodeId: other.id, cropId: crop.id, areaM2: 50_000 }] };
		expect((await editor.call('PUT', `/projects/${projectId}/model`, noFarm)).status).toBe(200);
		const unlinked = await events(projectId, 'farmer.unlinked');
		expect(unlinked.at(-1)).toMatchObject({ subject: { userId: farmer.id, nodeId: farm.id, nodeName: 'Hilltop', cause: 'model_saved' }, actor_user_id: editor.id });
		// The save and the unlink it caused are one change set.
		expect(unlinked.at(-1)!.change_set).toBe((await revisions()).at(-1)!.change_set);
		const res = await editor.call('POST', `/projects/${projectId}/history/revisions/${withFarm.id}/restore`, {});
		expect(res.status).toBe(201);
		expect(res.body.relink).toEqual([{ userId: farmer.id, displayName: 'Hfarmer', nodeId: farm.id, nodeName: 'Hilltop' }]);
		expect((await owner.call('GET', `/projects/${projectId}/farmers`)).body.farmers).toEqual([expect.objectContaining({ userId: farmer.id, nodeIds: [] })]);
		// Re-linked: no one left to list.
		expect((await owner.call('PUT', `/projects/${projectId}/farmers/${farmer.id}`, { nodeIds: [farm.id] })).status).toBe(200);
		expect((await events(projectId, 'farmer.linked')).at(-1)).toMatchObject({ subject: { userId: farmer.id, nodeId: farm.id, cause: 'farmers_set' } });
	});

	it('restores the inputs a run used, as a revision', async () => {
		expect((await editor.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200) } })).status).toBe(200);
		const rain = Array.from({ length: 120 }, (_, i) => (i % 7 === 0 ? 20 : 0));
		expect((await editor.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-01-01', values: rain })).status).toBe(200);
		const run = await editor.call('POST', `/projects/${projectId}/runs`, { label: 'Baseline run' });
		expect(run.status).toBe(201);
		const runId = run.body.run.id as string;
		expect((await editor.call('PUT', `/projects/${projectId}/model`, withDam((await editor.call('GET', `/projects/${projectId}/model`)).body, 400_000))).status).toBe(200);
		const since = await viewer.call('GET', `/projects/${projectId}/runs/${runId}/changes-since`);
		expect(since.status).toBe(200);
		expect(texts(since.body.changes)).toEqual(['Hilltop: dam capacity 100\u202f000 m³ → 400\u202f000 m³']);
		expect(since.body.revisions).toHaveLength(1);
		// Made at 22:30 UTC: the next day in South Africa, the day the reason names (the project's zone, 058).
		await asOwner(`UPDATE model_run SET created_at = '2026-09-25T22:30:00Z' WHERE id = $1`, [runId]);
		const res = await editor.call('POST', `/projects/${projectId}/runs/${runId}/restore-inputs`, {});
		expect(res.status).toBe(201);
		expect(res.body.revision.source).toBe('restore');
		expect(res.body.revision.reason).toBe('Inputs of the run "Baseline run" of 2026-09-26');
		const model = (await editor.call('GET', `/projects/${projectId}/model`)).body;
		expect(model.nodes.find((n: { id: string }) => n.id === farm.id).damCapacityM3).toBe(100_000);
		expect((await revisions()).at(-1)).toMatchObject({ source: 'restore', restored_from: null });
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${runId}/changes-since`)).body.changes).toEqual([]);
	});

	it('starts an imported project with its imported state', async () => {
		const doc = { format: 'water-management.project', version: 1, name: 'Imported', description: '', settings: {}, model: baseModel(), series: [] };
		const res = await editor.call('POST', '/projects/import', doc);
		expect(res.status).toBe(201);
		expect((await revisions(res.body.project.id)).map((r) => r.source)).toEqual(['import']);
	});
});

describe('the timeline', () => {
	it('lists revisions and events newest first, pages without gaps or repeats, and filters by node and kind', async () => {
		const all = (await viewer.call('GET', `/projects/${projectId}/history?limit=100`)).body;
		expect(all.historySince).toMatch(/^\d{4}-/);
		expect(all.items.length).toBeGreaterThan(8);
		const times = all.items.map((i: { createdAt: string }) => i.createdAt);
		expect([...times].sort().reverse()).toEqual(times);
		// A revision carries its change lines, not its snapshot.
		const rev = all.items.find((i: { type: string }) => i.type === 'revision');
		expect(rev.snapshot).toBeUndefined();
		expect(Array.isArray(rev.changes)).toBe(true);
		// Pages of 3 add up to the whole list.
		const paged: string[] = [];
		let next: string | null = null;
		do {
			const q: string = next ? `&before=${encodeURIComponent(next)}` : '';
			const page = (await viewer.call('GET', `/projects/${projectId}/history?limit=3${q}`)).body;
			expect(page.items.length).toBeLessThanOrEqual(3);
			paged.push(...page.items.map((i: { type: string; id: string }) => `${i.type}${i.id}`));
			next = page.next;
		} while (next);
		expect(paged).toEqual(all.items.map((i: { type: string; id: string }) => `${i.type}${i.id}`));
		// Only what touched the farm: its revisions and its farmer links.
		const hill = (await viewer.call('GET', `/projects/${projectId}/history?limit=100&nodeId=${farm.id}`)).body.items;
		expect(hill.length).toBeGreaterThan(0);
		expect(hill.length).toBeLessThan(all.items.length);
		for (const i of hill) {
			if (i.type === 'event') expect(i.subject.nodeId).toBe(farm.id);
		}
		const farmerEvents = (await viewer.call('GET', `/projects/${projectId}/history?kind=farmer`)).body.items;
		expect(farmerEvents.length).toBeGreaterThan(0);
		expect(farmerEvents.every((i: { kind: string }) => i.kind.startsWith('farmer.'))).toBe(true);
		const revs = (await viewer.call('GET', `/projects/${projectId}/history?kind=revision`)).body.items;
		expect(revs.every((i: { type: string }) => i.type === 'revision')).toBe(true);
		expect((await viewer.call('GET', `/projects/${projectId}/history?before=nope`)).status).toBe(400);
	});

	it('shows viewers the history, and farmers and strangers nothing (API and RLS)', async () => {
		// Positive control: a viewer reads all three tables.
		for (const t of ['model_revision', 'audit_event']) {
			expect((await rowsAs(viewer, `SELECT 1 FROM ${t} WHERE project_id = $1`, [projectId])).length, t).toBeGreaterThan(0);
		}
		expect((await viewer.call('GET', `/projects/${projectId}/history`)).status).toBe(200);
		for (const u of [farmer, stranger]) {
			for (const t of ['model_revision', 'series_revision', 'audit_event']) {
				expect(await rowsAs(u, `SELECT 1 FROM ${t} WHERE project_id = $1`, [projectId]), t).toEqual([]);
			}
		}
		expect((await farmer.call('GET', `/projects/${projectId}/history`)).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${projectId}/history`)).status).toBe(404);
	});

	it('keeps the log append-only: water_app can neither change nor remove a row', async () => {
		for (const [t, set] of [
			['audit_event', "kind = 'x.y'"],
			['model_revision', "reason = 'rewritten'"],
			['series_revision', "reason = 'delete'"]
		] as const) {
			await expect(rowsAs(owner, `UPDATE ${t} SET ${set} WHERE project_id = $1`, [projectId]), t).rejects.toMatchObject({ code: '42501' });
			await expect(rowsAs(owner, `DELETE FROM ${t} WHERE project_id = $1`, [projectId]), t).rejects.toMatchObject({ code: '42501' });
		}
		// Nor can a member write an event as someone else.
		await expect(
			rowsAs(editor, `INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind) VALUES ($1, $2, 'x', 'member.added')`, [projectId, owner.id])
		).rejects.toMatchObject({ code: '42501' });
		// Positive control: as themselves, they can.
		expect(await rowsAs(editor, `INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind) VALUES ($1, $2, 'x', 'member.added') RETURNING 1`, [projectId, editor.id])).toHaveLength(1);
	});
});

describe('members in the log', () => {
	it('records an accepted invite as the member joining, and the invite with a masked address', async () => {
		const email = `joiner-${crypto.randomUUID()}@example.com`;
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email, role: 'viewer' })).body.invited).toBe(true);
		expect((await events(projectId, 'invite.sent')).at(-1)).toMatchObject({ subject: { email: `j•••@example.com`, role: 'viewer' }, actor_user_id: owner.id });
		const reg = await anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'Joiner', acceptTerms: LEGAL_VERSION, inviteToken: tokenIn(lastMailTo(email)) });
		expect(reg.status).toBe(201);
		expect((await events(projectId, 'member.added')).at(-1)).toMatchObject({
			subject: { userId: reg.body.user.id, displayName: 'Joiner', role: 'viewer', via: 'invite' },
			actor_user_id: reg.body.user.id,
			actor_label: 'Joiner'
		});
	});

	it('records a farmer leaving, and the farm links that went with them, as the farmer', async () => {
		const leaver = await signUp('Hleaver');
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: leaver.email, nodeIds: [other.id] })).status).toBe(201);
		expect((await leaver.call('DELETE', `/projects/${projectId}/members/${leaver.id}`)).status).toBe(204);
		// Joining is theirs too: a verified account joins by accepting the invite (issue #136).
		const mine = (await events(projectId)).filter((e) => e.actor_user_id === leaver.id);
		expect(mine.map((e) => e.kind)).toEqual(['member.added', 'farmer.linked', 'farmer.unlinked', 'member.removed']);
		expect(mine[2]).toMatchObject({ subject: { nodeId: other.id, cause: 'member_removed' } });
		expect(mine[3]).toMatchObject({ subject: { role: 'farmer', self: true } });
		expect(mine[0].change_set).toBe(mine[1].change_set);
	});
});

describe('series revisions', () => {
	const put = (values: number[], startDate = '2020-01-01') => editor.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', name: 'gauge', unit: 'm3/s', startDate, values });

	it('keeps the values before a replace, and restores them', async () => {
		const created = await put([1, 2, 3]);
		expect(created.status).toBe(200);
		expect((await events(projectId, 'series.created')).at(-1)).toMatchObject({ subject: { seriesId: created.body.id, from: '2020-01-01', to: '2020-01-03', daysChanged: 3 } });
		expect((await put([1, 5, 3, 4])).status).toBe(200);
		expect((await events(projectId, 'series.replaced')).at(-1)).toMatchObject({ subject: { daysChanged: 2, length: 4, to: '2020-01-04' } });
		const list = await viewer.call('GET', `/projects/${projectId}/series/${created.body.id}/revisions`);
		expect(list.status).toBe(200);
		expect(list.body.revisions).toEqual([expect.objectContaining({ reason: 'replace', startDate: '2020-01-01', length: 3, createdBy: 'Heditor' })]);
		const res = await editor.call('POST', `/projects/${projectId}/series/${created.body.id}/revisions/${list.body.revisions[0].id}/restore`, {});
		expect(res.status).toBe(200);
		expect((await editor.call('GET', `/projects/${projectId}/series/${created.body.id}`)).body.values).toEqual([1, 2, 3]);
		expect((await events(projectId, 'restore')).at(-1)).toMatchObject({ subject: { target: 'series', restoredFrom: list.body.revisions[0].id } });
		// The values the restore replaced are kept in turn.
		expect((await viewer.call('GET', `/projects/${projectId}/series/${created.body.id}/revisions`)).body.revisions[0]).toMatchObject({ length: 4 });
		// A replace with the same values records nothing.
		const n = (await events(projectId)).length;
		expect((await put([1, 2, 3])).status).toBe(200);
		expect(await events(projectId)).toHaveLength(n);
	});

	it('keeps a deleted series restorable by its old id', async () => {
		const s = await editor.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', name: 'old', unit: 'm3/s', startDate: '2021-01-01', values: [7, 8] });
		expect((await editor.call('DELETE', `/projects/${projectId}/series/${s.body.id}`)).status).toBe(204);
		expect((await events(projectId, 'series.deleted')).at(-1)).toMatchObject({ subject: { seriesId: s.body.id, from: '2021-01-01', to: '2021-01-02' } });
		const list = (await viewer.call('GET', `/projects/${projectId}/series/${s.body.id}/revisions`)).body.revisions;
		expect(list).toEqual([expect.objectContaining({ reason: 'delete', length: 2 })]);
		expect((await viewer.call('POST', `/projects/${projectId}/series/${s.body.id}/revisions/${list[0].id}/restore`, {})).status).toBe(403);
		const res = await editor.call('POST', `/projects/${projectId}/series/${s.body.id}/revisions/${list[0].id}/restore`, {});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ kind: 'flow_observed_m3s', name: 'old', length: 2 });
	});

	it(`keeps the newest ${SERIES_REVISIONS_KEPT} per series and none older than 180 days`, async () => {
		const mk = (v: number) => editor.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', name: 'churn', unit: 'm3/s', startDate: '2020-01-01', values: [v] });
		const first = await mk(0);
		for (let i = 1; i <= SERIES_REVISIONS_KEPT + 2; i++) expect((await mk(i)).status).toBe(200);
		const kept = await asOwner(`SELECT "values" FROM series_revision WHERE project_id = $1 AND name = 'churn' ORDER BY created_at, id`, [projectId]);
		expect(kept.map((r) => r.values[0])).toEqual([2, 3, 4, 5, 6]);
		// Age out: backdate one revision of another series past 180 days; the next insert trims it.
		await asOwner(`UPDATE series_revision SET created_at = now() - interval '181 days' WHERE project_id = $1 AND name = 'gauge'`, [projectId]);
		expect((await mk(99)).status).toBe(200);
		expect(await asOwner(`SELECT 1 FROM series_revision WHERE project_id = $1 AND name = 'gauge'`, [projectId])).toEqual([]);
		// Positive control: the recent ones are still there.
		expect((await viewer.call('GET', `/projects/${projectId}/series/${first.body.id}/revisions`)).body.revisions).toHaveLength(SERIES_REVISIONS_KEPT);
	});
});

describe('what the log leaves out, and what a restore refuses', () => {
	it('records a run edit only when something changed, not a PATCH that re-sends what the run has', async () => {
		const [run] = await asOwner('SELECT id FROM model_run WHERE project_id = $1 ORDER BY created_at LIMIT 1', [projectId]);
		expect(run, 'a run from the restore-inputs test above').toBeTruthy();
		const patch = (body: Record<string, unknown>) => editor.call('PATCH', `/projects/${projectId}/runs/${run.id}`, body);
		const count = async () => (await events(projectId, 'run.changed')).length;
		const n0 = await count();
		expect((await patch({ notes: 'Checked against the gauge' })).status).toBe(200);
		expect((await patch({ pinned: true })).status).toBe(200);
		// Positive control: both real changes are logged.
		expect(await count()).toBe(n0 + 2);
		expect((await patch({ notes: 'Checked against the gauge' })).status).toBe(200);
		expect((await patch({ pinned: true, notes: 'Checked against the gauge' })).status).toBe(200);
		expect(await count()).toBe(n0 + 2);
		// A mixed PATCH logs only the field that moved.
		expect((await patch({ pinned: false, notes: 'Checked against the gauge' })).status).toBe(200);
		expect((await events(projectId, 'run.changed')).at(-1)!.subject).toMatchObject({ fields: ['pinned'], pinned: false });
	});

	it('records a scenario edit only when a field changed', async () => {
		const [run] = await asOwner('SELECT id FROM model_run WHERE project_id = $1 ORDER BY created_at LIMIT 1', [projectId]);
		const made = await editor.call('POST', `/projects/${projectId}/scenarios`, {
			name: 'Bigger dam',
			baseRunId: run.id,
			ops: [{ op: 'node.set', nodeId: farm.id, field: 'damCapacityM3', value: 150_000 }]
		});
		expect(made.status).toBe(201);
		const sid = made.body.scenario.id as string;
		const count = async () => (await events(projectId, 'scenario.changed')).length;
		const n0 = await count();
		expect((await editor.call('PATCH', `/projects/${projectId}/scenarios/${sid}`, { description: 'Raise the wall 2 m' })).status).toBe(200);
		expect(await count()).toBe(n0 + 1);
		expect((await editor.call('PATCH', `/projects/${projectId}/scenarios/${sid}`, { description: 'Raise the wall 2 m', name: 'Bigger dam' })).status).toBe(200);
		expect(await count()).toBe(n0 + 1);
	});

	it("refuses to restore a version whose model doesn't pass today's checks, and changes nothing", async () => {
		const before = (await editor.call('GET', `/projects/${projectId}/model`)).body;
		const revs = await revisions();
		const target = revs.find((r) => r.source === 'model_put')!;
		// A stored snapshot that today's validation rejects: a farm draining into a node that doesn't exist.
		await asOwner(
			`UPDATE model_revision SET snapshot = jsonb_set(snapshot, '{model,nodes,1,downstreamNodeId}', to_jsonb($2::text)) WHERE id = $1`,
			[target.id, crypto.randomUUID()]
		);
		const res = await editor.call('POST', `/projects/${projectId}/history/revisions/${target.id}/restore`, {});
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/can't be restored/);
		expect((await revisions()).length).toBe(revs.length);
		expect((await editor.call('GET', `/projects/${projectId}/model`)).body).toEqual(before);
	});
});
