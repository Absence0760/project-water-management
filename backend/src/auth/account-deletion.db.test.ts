// What deleting an account does to the Step 2 records that name the person
// (roadmap WP-2.16, decision D12; 048_account_deletion.sql; docs/security.md
// § Personal information (POPIA)). There is no self-service account deletion
// yet: on a POPIA request the operator deletes the app_user row as the schema
// owner, which is what these tests do. Every foreign key to app_user decides
// what happens to its rows (catalogue.db.test.ts classifies each one); this
// checks the outcome end to end for a farmer and for a co-owner, with the
// project's other members as the positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { FARMER_NOTICE_VERSION } from '@water-management/engine/legal';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let coOwner: User;
let farmer: User;
let other: User; // a farmer who stays: the positive control
let projectId: string;
const outlet = node('Outlet', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);

type Item = { type: string; actor: string | null; kind: string; subject: Record<string, unknown> | null };
/** The project's audit events, as its owner reads the History (one page is plenty here). */
const events = async () => {
	const res = await owner.call('GET', `/projects/${projectId}/history?limit=100`);
	expect(res.status).toBe(200);
	expect(res.body.next).toBeNull();
	return (res.body.items as Item[]).filter((i) => i.type === 'event').map((i) => ({ ...i, subject: i.subject ?? {} }));
};
let runId: string;

beforeAll(async () => {
	[owner, coOwner, farmer, other] = (await Promise.all(['Downer', 'Dcoowner', 'Dfarmer', 'Dother'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Deletion' })).body.project.id;
	const model = { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [], landCover: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 12 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: coOwner.email, role: 'owner' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: other.email, nodeIds: [farmB.id] })).status).toBe(201);
	// The run is the owner's (model_run.created_by keeps its creator: a run is evidence), the publication the co-owner's.
	runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'r' })).body.run.id;
	expect((await coOwner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);
	expect((await coOwner.call('PATCH', `/projects/${projectId}/runs/${runId}`, { notes: 'checked against the gauge' })).status).toBe(200);
	expect((await coOwner.call('POST', `/projects/${projectId}/api-keys`, { name: 'logger' })).status).toBe(201);
	expect((await coOwner.call('POST', `/projects/${projectId}/share-links`, { label: 'WUA', expiresInDays: 30 })).status).toBe(201);
	for (const u of [farmer, other]) {
		const nodeId = u === farmer ? farmA.id : farmB.id;
		expect((await u.call('POST', `/projects/${projectId}/notes`, { body: u === farmer ? 'first note' : 'other note', nodeId, visibility: 'farm' })).status).toBe(201);
	}
}, 60_000);

describe('deleting a farmer’s account', () => {
	beforeAll(async () => {
		// The farmer acts in the log too: deleting their own note records note.deleted as them.
		const mine = (await farmer.call('GET', `/projects/${projectId}/notes`)).body.notes[0];
		expect((await farmer.call('DELETE', `/projects/${projectId}/notes/${mine.id}`)).status).toBe(204);
		expect((await farmer.call('POST', `/projects/${projectId}/notes`, { body: 'kept note', nodeId: farmA.id, visibility: 'farm' })).status).toBe(201);
		// Both farmers acknowledged the farm view's notice (093): the record is on the account row.
		for (const u of [farmer, other]) expect((await u.call('POST', '/auth/me/farm-notice', { version: FARMER_NOTICE_VERSION })).status).toBe(200);
		await asOwner('DELETE FROM app_user WHERE id = $1', [farmer.id]);
	});

	it('removes the membership and the farm links with the account', async () => {
		expect(await asOwner('SELECT 1 FROM project_member WHERE user_id = $1', [farmer.id])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM farm_link WHERE user_id = $1', [farmer.id])).toEqual([]);
		// Positive control: the other farmer keeps theirs.
		expect(await asOwner('SELECT node_id FROM farm_link WHERE user_id = $1', [other.id])).toEqual([{ node_id: farmB.id }]);
	});

	it('takes their farm notice acknowledgement with the account row, like the terms record', async () => {
		expect(await asOwner('SELECT 1 FROM app_user WHERE id = $1', [farmer.id])).toEqual([]);
		// Positive control: the farmer who stays keeps theirs.
		expect(await asOwner('SELECT farm_notice_version FROM app_user WHERE id = $1', [other.id])).toEqual([{ farm_notice_version: FARMER_NOTICE_VERSION }]);
	});

	it('pseudonymises the audit log: "Deleted user" as actor and as subject, the events kept', async () => {
		const log = await events();
		const about = log.filter((e) => e.subject.userId === farmer.id);
		expect(about.map((e) => e.kind).sort()).toEqual(['farmer.linked', 'member.added']);
		for (const e of about) expect(e.subject.displayName).toBe('Deleted user');
		const acted = log.filter((e) => e.kind === 'note.deleted');
		expect(acted).toHaveLength(1);
		expect(acted[0]!.actor).toBe('Deleted user');
		expect(JSON.stringify(log)).not.toContain('Dfarmer');
		// Positive control: the farmer who stays is still named.
		expect(log.filter((e) => e.subject.userId === other.id).map((e) => e.subject.displayName)).toEqual(['Dother', 'Dother']);
		expect(await asOwner('SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id = $1', [farmer.id])).toEqual([{ n: 0 }]);
	});

	it('keeps their notes as the project’s, with no author (shown as a former member)', async () => {
		const notes = (await owner.call('GET', `/projects/${projectId}/notes`)).body.notes as { body: string; author: string | null }[];
		expect(notes.find((n) => n.body === 'kept note')).toMatchObject({ author: null });
		expect(notes.find((n) => n.body === 'other note')).toMatchObject({ author: 'Dother' });
	});
});

describe('deleting a co-owner’s account', () => {
	beforeAll(async () => {
		// A pending invite they sent goes with them (invite.invited_by ON DELETE CASCADE).
		expect((await coOwner.call('POST', `/projects/${projectId}/members`, { email: `pending-${crypto.randomUUID()}@example.com`, role: 'viewer' })).status).toBe(201);
		await asOwner('DELETE FROM app_user WHERE id = $1', [coOwner.id]);
	});

	it('keeps the publication, the key and the share link, with no creator; the farm view names no one (the page words it)', async () => {
		expect(await asOwner('SELECT published_by FROM run_publication WHERE project_id = $1', [projectId])).toEqual([{ published_by: null }]);
		expect(await asOwner('SELECT created_by, revoked_at FROM api_key WHERE project_id = $1', [projectId])).toEqual([{ created_by: null, revoked_at: null }]);
		expect(await asOwner('SELECT created_by FROM share_link WHERE project_id = $1', [projectId])).toEqual([{ created_by: null }]);
		// The run note they last edited keeps its text, with no editor (model_run_stamp_notes must not put the id back).
		expect(await asOwner('SELECT notes, notes_updated_by FROM model_run WHERE id = $1', [runId])).toEqual([{ notes: 'checked against the gauge', notes_updated_by: null }]);
		const view = await other.call('GET', `/projects/${projectId}/farm/${farmB.id}`);
		expect(view.status).toBe(200);
		// null, not English words: the farm page says “A former member” in the reader's language (issue #51).
		expect(view.body.publication.publishedBy).toBeNull();
	});

	it('pseudonymises every event they made, and drops their pending invites', async () => {
		const log = await events();
		const theirs = log.filter((e) => ['publication.published', 'api_key.created', 'share_link.created', 'invite.sent'].includes(e.kind) && e.actor !== 'Downer');
		expect(theirs.map((e) => e.kind).sort()).toEqual(['api_key.created', 'invite.sent', 'publication.published', 'share_link.created']);
		for (const e of theirs) expect(e.actor).toBe('Deleted user');
		expect(JSON.stringify(log)).not.toContain('Dcoowner');
		// Positive control: the owner's own events keep the owner's name.
		expect(log.some((e) => e.actor === 'Downer')).toBe(true);
		expect(await asOwner('SELECT 1 FROM invite WHERE invited_by = $1', [coOwner.id])).toEqual([]);
	});
});

// An assessor who decided an application (045, WP-3.3): scenario.decided_by is
// ON DELETE SET NULL, and the foreign key's update has to get through
// scenario_guard, which refuses every other change to a decision (052).
describe('deleting an assessor’s account', () => {
	let assessor: User;
	let applicant: User;
	let sid: string;
	const decision = async () =>
		(await asOwner('SELECT status, outcome, decision_note, decided_at IS NOT NULL AS dated, decided_by, updated_at FROM scenario WHERE id = $1', [sid]))[0];

	beforeAll(async () => {
		[assessor, applicant] = (await Promise.all(['Dassessor', 'Dapplicant'].map((n) => signUp(n)))) as [User, User];
		for (const [u, role] of [
			[assessor, 'editor'],
			[applicant, 'contributor']
		] as const) {
			expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
		}
		const made = await applicant.call('POST', `/projects/${projectId}/scenarios`, { name: 'Raise the weir', baseRunId: runId, ops: [] });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		sid = made.body.scenario.id;
		expect((await applicant.call('POST', `/projects/${projectId}/scenarios/${sid}/submit`)).status).toBe(200);
		const decided = await assessor.call('POST', `/projects/${projectId}/scenarios/${sid}/decide`, { outcome: 'refused', note: 'Too little left in dry years.' });
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
	});

	it('is refused to water_app while the account exists: a decision’s assessor never changes (positive control)', async () => {
		const before = await decision();
		expect(before).toMatchObject({ status: 'decided', decided_by: assessor.id });
		// Clearing who decided, or naming someone else, is still refused: the applicant is the app user the
		// update policy lets write a decided application (the guard, not RLS, stops them).
		for (const to of [null, owner.id]) {
			await expect(withUser(applicant.id, (db) => db.query('UPDATE scenario SET decided_by = $2 WHERE id = $1', [sid, to]))).rejects.toMatchObject({ code: '23514' });
		}
		// …and so is clearing it together with anything else.
		await expect(
			withUser(applicant.id, (db) => db.query(`UPDATE scenario SET decided_by = NULL, outcome = 'approved', decision_note = '' WHERE id = $1`, [sid]))
		).rejects.toMatchObject({ code: '23514' });
		expect(await decision()).toEqual(before);
	});

	it('goes through, keeping the decision with no assessor, and the scenario otherwise untouched', async () => {
		const before = await decision();
		await asOwner('DELETE FROM app_user WHERE id = $1', [assessor.id]);
		expect(await decision()).toEqual({ ...before, decided_by: null });
		const read = await owner.call('GET', `/projects/${projectId}/scenarios/${sid}`);
		expect(read.status).toBe(200);
		expect(read.body.scenario).toMatchObject({ status: 'decided', outcome: 'refused', decisionNote: 'Too little left in dry years.' });
		expect(JSON.stringify(await events())).not.toContain('Dassessor');
	});
});
