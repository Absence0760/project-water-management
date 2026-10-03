// What a viewer reads of the allocation events (190_history_viewer_share_forecast.sql,
// app_audit_subject; docs/allocations.md § Who sees what). allocation.created /
// changed / deleted carry the registration number, a unique identifier
// (POPIA s1), and allocation.created the volume. A viewer reads neither from
// the allocation rows until an owner switches allocations_viewer_units on, so:
//  - the History leaves both out of those events for a viewer while it's off,
//    and an editor (positive control), an owner, and the viewer once it's on
//    read them;
//  - "Changes since this run" lists no registered-volume line to that viewer
//    (the run's copy of the volumes against none they can read), and does to
//    an editor;
//  - the data-subject export carries neither: they're the holder's, not the
//    exporting person's.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { ALLOCATION_EVENT_IDENTIFIERS, withoutAllocationIdentifiers } from './viewerUnits.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Event = { type: string; kind: string; subject: Record<string, unknown> };

const REG = 'HVR-0042';
const VOLUME = 87_654;

let owner: User;
let editor: User;
let viewer: User;
let projectId: string;
let runId: string;
const outlet = node('Weir', null);
const farm = node('Farm A', outlet.id);

const allocationEvents = async (u: User): Promise<Event[]> => {
	const res = await u.call('GET', `/projects/${projectId}/history?kind=allocation&limit=100`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return (res.body.items as Event[]).filter((i) => i.type === 'event' && ['allocation.created', 'allocation.changed', 'allocation.deleted'].includes(i.kind));
};

beforeAll(async () => {
	[owner, editor, viewer] = (await Promise.all(['HVowner', 'HVeditor', 'HVviewer'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'History viewers' })).body.project.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 60_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 200 }, (_, i) => (i % 9 === 0 ? 25 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	// One allocation made, changed and deleted, then made again: one of each event.
	const body = { nodeId: farm.id, registrationNo: REG, authorisation: 'registration', waterSource: 'surface', volumeM3PerYear: VOLUME };
	const made = await editor.call('POST', `/projects/${projectId}/allocations`, body);
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	expect((await editor.call('PATCH', `/projects/${projectId}/allocations/${made.body.allocation.id}`, { volumeM3PerYear: VOLUME + 1 })).status).toBe(200);
	expect((await editor.call('DELETE', `/projects/${projectId}/allocations/${made.body.allocation.id}`)).status).toBe(204);
	expect((await editor.call('POST', `/projects/${projectId}/allocations`, body)).status).toBe(201);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'with a volume' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	runId = run.body.run.id;
}, 60_000);

describe('the allocation events in the History', () => {
	it('carry the registration number and volume as written (the stored row is untouched)', async () => {
		const rows = await asOwner(`SELECT kind, subject FROM audit_event WHERE project_id = $1 AND kind = 'allocation.created'`, [projectId]);
		expect(rows.length).toBe(2);
		for (const r of rows) expect(r.subject).toMatchObject({ registrationNo: REG, volumeM3PerYear: VOLUME });
	});

	it('leave the registration number and volume out for a viewer while viewers see totals only', async () => {
		const events = await allocationEvents(viewer);
		expect(events.map((e) => e.kind).sort()).toEqual(['allocation.changed', 'allocation.created', 'allocation.created', 'allocation.deleted']);
		for (const e of events) {
			expect(e.subject).not.toHaveProperty('registrationNo');
			expect(e.subject).not.toHaveProperty('volumeM3PerYear');
			// The rest of the event is still there: what happened, and to which unit.
			expect(e.subject).toHaveProperty('allocationId');
		}
		expect(JSON.stringify(events)).not.toContain(REG);
		// The same function under the viewer's own RLS, as the route calls it.
		const [direct] = await withUser(viewer.id, async (db) =>
			(
				await db.query(`SELECT app_audit_subject(project_id, kind, subject) AS s FROM audit_event WHERE project_id = $1 AND kind = 'allocation.created' LIMIT 1`, [
					projectId
				])
			).rows
		);
		expect(direct.s).not.toHaveProperty('registrationNo');
	});

	it('carry both for an editor and an owner (positive controls)', async () => {
		for (const u of [editor, owner]) {
			const created = (await allocationEvents(u)).filter((e) => e.kind === 'allocation.created');
			expect(created.length).toBe(2);
			for (const e of created) expect(e.subject).toMatchObject({ registrationNo: REG, volumeM3PerYear: VOLUME });
			expect((await allocationEvents(u)).find((e) => e.kind === 'allocation.deleted')!.subject).toMatchObject({ registrationNo: REG });
		}
	});
});

describe('"Changes since this run" for a viewer', () => {
	it('lists no registered-volume line to a viewer while viewers see totals only, and does to an editor', async () => {
		// The allocation's volume changes after the run, so the run's copy and today's differ.
		const [{ id }] = await asOwner('SELECT id FROM allocation WHERE project_id = $1', [projectId]);
		expect((await editor.call('PATCH', `/projects/${projectId}/allocations/${id}`, { volumeM3PerYear: 12_345 })).status).toBe(200);
		const lines = async (u: User) => {
			const res = await u.call('GET', `/projects/${projectId}/runs/${runId}/changes-since`);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			return (res.body.changes as { text: string }[]).map((c) => c.text).filter((t) => /registered volume/i.test(t));
		};
		const forEditor = await lines(editor);
		expect(forEditor.length).toBe(1);
		expect(forEditor[0]).toContain('87');
		expect(await lines(viewer)).toEqual([]);
	});
});

describe('the data-subject export', () => {
	it('carries the editor’s allocation events without the holder’s registration number or volume', async () => {
		await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [editor.id]);
		const res = await app.request('/auth/me/export', { headers: { cookie: editor.cookie, origin: 'http://localhost:7777' } });
		expect(res.status).toBe(200);
		const doc = (await res.json()) as { auditEvents: { kind: string; subject: Record<string, unknown> }[] };
		const mine = doc.auditEvents.filter((e) => e.kind.startsWith('allocation.'));
		expect(mine.length).toBeGreaterThanOrEqual(4);
		for (const e of mine) {
			expect(e.subject).not.toHaveProperty('registrationNo');
			expect(e.subject).not.toHaveProperty('volumeM3PerYear');
		}
		// What the person did is still there.
		expect(mine.map((e) => e.kind)).toContain('allocation.created');
	});

	it('drops exactly the export’s identifier list in SQL too, so the two lists can’t drift apart', async () => {
		// app_audit_subject (190) and ALLOCATION_EVENT_IDENTIFIERS (viewerUnits.ts) each name the keys; one
		// added to only one of them would leak through the other channel.
		const subject = Object.fromEntries([...ALLOCATION_EVENT_IDENTIFIERS.map((k) => [k, 'x']), ['allocationId', 'kept']]);
		const [row] = await withUser(viewer.id, async (db) =>
			(await db.query(`SELECT app_audit_subject($1, 'allocation.changed', $2::jsonb) AS s`, [projectId, JSON.stringify(subject)])).rows
		);
		expect(row.s).toEqual({ allocationId: 'kept' });
		expect(withoutAllocationIdentifiers({ kind: 'allocation.changed', subject } as never).subject).toEqual(row.s);
	});
});

describe('once an owner lets viewers read each volume', () => {
	it('the History gives the viewer the registration number and volume too', async () => {
		expect((await owner.call('PUT', `/projects/${projectId}/allocations/viewer-units`, { on: true })).status).toBe(200);
		const created = (await allocationEvents(viewer)).filter((e) => e.kind === 'allocation.created');
		expect(created.length).toBe(2);
		for (const e of created) expect(e.subject).toMatchObject({ registrationNo: REG, volumeM3PerYear: VOLUME });
		// The switch's own event, which carries nothing to leave out, reads as written.
		const res = await viewer.call('GET', `/projects/${projectId}/history?kind=allocation.viewer_units`);
		expect(res.body.items.map((i: Event) => i.subject)).toEqual([{ on: true }]);
	});
});
