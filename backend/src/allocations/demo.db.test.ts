// Demo registered users (315, docs/allocations.md § Demo registered users):
// POST /projects/:id/allocations/demo loads invented users on every farm and
// water user as one `demo` source, DELETE removes exactly them.
//  - editors only: a viewer gets 403, a non-member 404 and sees none of the
//    rows (RLS), with the editor's load as the positive control;
//  - loading twice replaces the demo, never duplicates it;
//  - the delete leaves every row a person typed in or imported;
//  - an import never matches by a demo row's farm or registration number;
//  - the history records both, by counts.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
const outlet = node('Demo weir', null);
const farmA = { ...node('Demo farm A', outlet.id), sortOrder: 1 };
const farmB = { ...node('Demo farm B', outlet.id, { damCapacityM3: 0 }), sortOrder: 2 };
const town = { ...node('Demo town', outlet.id), kind: 'user', sortOrder: 3, userDemandM3Day: monthly(300) };

const demoRows = (projectId: string) =>
	asOwner(
		`SELECT a.id, a.node_id AS "nodeId", a.property_ref AS "propertyRef", a.registration_no AS "registrationNo", a.volume_m3_year AS volume, h.user_display AS holder
		 FROM allocation a JOIN allocation_source s ON s.id = a.source_id LEFT JOIN allocation_holder h ON h.allocation_id = a.id
		 WHERE a.project_id = $1 AND s.kind = 'demo' ORDER BY a.registration_no`,
		[projectId]
	);

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['Downer', 'Deditor', 'Dviewer', 'Dstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Demo registered users' })).body.project.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [outlet, farmA, farmB, town], crops: [crop], cropAreas: [farmA, farmB].map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 120_000 })), transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}, 60_000);

describe('demo registered users', () => {
	let real: string;

	it('loads two or three invented users on every farm and water user for an editor, as one demo source', async () => {
		// A real row typed in by hand first: the demo must leave it.
		const typed = await editor.call('POST', `/projects/${projectId}/allocations`, {
			nodeId: farmA.id,
			registrationNo: 'REAL-1',
			propertyRef: 'Portion 2 of Example 7',
			holder: 'Invented Real Holder',
			authorisation: 'licence',
			waterSource: 'surface',
			volumeM3PerYear: 42_000
		});
		expect(typed.status, JSON.stringify(typed.body)).toBe(201);
		real = typed.body.allocation.id;

		const res = await editor.call('POST', `/projects/${projectId}/allocations/demo`, {});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.source).toMatchObject({ kind: 'demo', fileName: 'Demo registered users (invented)' });
		expect(res.body.units).toBe(3);
		expect(res.body.users).toBeGreaterThanOrEqual(6);
		const rows = await demoRows(projectId);
		expect(rows).toHaveLength(res.body.loaded);
		expect(new Set(rows.map((r) => r.nodeId))).toEqual(new Set([farmA.id, farmB.id, town.id]));
		for (const r of rows) {
			expect(r.holder).toMatch(/\(invented\)$/);
			expect(r.propertyRef).toMatch(/^\d{3}\/\d{1,3}$/);
		}
		// The page reads them like any other row, the source among the imports.
		const list = (await editor.call('GET', `/projects/${projectId}/allocations`)).body;
		expect(list.allocations).toHaveLength(rows.length + 1);
		expect(list.sources.map((s: { kind: string }) => s.kind)).toEqual(['demo']);
		const [{ kind, subject }] = await asOwner('SELECT kind, subject FROM audit_event WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]);
		expect(kind).toBe('allocation.demo_loaded');
		expect(subject).toMatchObject({ rows: rows.length, units: 3, replaced: 0 });
		expect(JSON.stringify(subject)).not.toMatch(/invented/);
	});

	it('replaces the demo when loaded again: the same rows, never twice', async () => {
		const before = await demoRows(projectId);
		const res = await editor.call('POST', `/projects/${projectId}/allocations/demo`, {});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const after = await demoRows(projectId);
		expect(after).toHaveLength(before.length);
		const shape = (rs: Record<string, unknown>[]) => rs.map(({ id: _, ...r }) => r);
		expect(shape(after)).toEqual(shape(before));
		const [{ n }] = await asOwner(`SELECT count(*)::int AS n FROM allocation_source WHERE project_id = $1 AND kind = 'demo'`, [projectId]);
		expect(n).toBe(1);
		const [{ subject }] = await asOwner('SELECT subject FROM audit_event WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]);
		expect(subject).toMatchObject({ replaced: before.length });
	});

	it('is refused to a viewer (403) and to a non-member (404), who reads none of the rows; the editor reads them', async () => {
		for (const method of ['POST', 'DELETE'] as const) {
			expect((await viewer.call(method, `/projects/${projectId}/allocations/demo`, method === 'POST' ? {} : undefined)).status).toBe(403);
			expect((await stranger.call(method, `/projects/${projectId}/allocations/demo`, method === 'POST' ? {} : undefined)).status).toBe(404);
		}
		const sql = `SELECT count(*)::int AS n FROM allocation a JOIN allocation_source s ON s.id = a.source_id WHERE a.project_id = $1 AND s.kind = 'demo'`;
		const seen = async (u: User) => withUser(u.id, async (db) => (await db.query<{ n: number }>(sql, [projectId])).rows[0]!.n);
		// Positive control: a member reads them; the non-member, under the same query, nothing.
		expect(await seen(editor)).toBe((await demoRows(projectId)).length);
		expect(await seen(stranger)).toBe(0);
		// Nothing changed.
		expect((await demoRows(projectId)).length).toBeGreaterThan(0);
	});

	it('never matches an import by a demo row’s farm number or registration number', async () => {
		const [demo] = await demoRows(projectId);
		const text = `registration_no,property_ref,authorisation,water_source,volume_m3_year\n${demo!.registrationNo},${demo!.propertyRef},licence,surface,1000\n`;
		const res = await editor.call('POST', `/projects/${projectId}/allocations/import`, { kind: 'csv', fileName: 'probe.csv', text });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.rows[0]).toMatchObject({ nodeId: null, matchedBy: null, alreadyInProject: false });
	});

	it('removes exactly the demo rows: the row typed in by hand and an imported one stay', async () => {
		const text = 'registration_no,farm,authorisation,water_source,volume_m3_year\nREAL-2,Demo farm B,licence,surface,30000\n';
		const imp = await editor.call('POST', `/projects/${projectId}/allocations/import/commit`, { kind: 'csv', fileName: 'real.csv', text, matches: {} });
		expect(imp.status, JSON.stringify(imp.body)).toBe(201);
		const demo = (await demoRows(projectId)).length;

		const res = await editor.call('DELETE', `/projects/${projectId}/allocations/demo`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ removed: demo });
		expect(await demoRows(projectId)).toEqual([]);
		const left = await asOwner('SELECT registration_no AS r FROM allocation WHERE project_id = $1 ORDER BY registration_no', [projectId]);
		expect(left).toEqual([{ r: 'REAL-1' }, { r: 'REAL-2' }]);
		// The typed row keeps its holder; the demo's names went with their rows.
		const holders = await asOwner('SELECT allocation_id AS id, user_display AS holder FROM allocation_holder WHERE project_id = $1', [projectId]);
		expect(holders).toEqual([{ id: real, holder: 'Invented Real Holder' }]);
		const [{ kind, subject }] = await asOwner('SELECT kind, subject FROM audit_event WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]);
		expect(kind).toBe('allocation.demo_removed');
		expect(subject).toEqual({ rows: demo });
		// Again: nothing to remove, nothing recorded.
		expect((await editor.call('DELETE', `/projects/${projectId}/allocations/demo`)).body).toEqual({ removed: 0 });
		const [{ kind: last }] = await asOwner('SELECT kind FROM audit_event WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]);
		expect(last).toBe('allocation.demo_removed');
	});

	it('refuses a model with no farm or water user', async () => {
		const empty = (await editor.call('POST', '/projects', { name: 'Demo nothing to load' })).body.project.id;
		const res = await editor.call('POST', `/projects/${empty}/allocations/demo`, {});
		expect(res.status).toBe(422);
		expect(res.body.error).toMatch(/no farm or water user/);
	});
});
