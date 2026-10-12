// The authority controls its own delegates (229_authority_delegates, issue
// #523 G5; docs/security.md § Authorization, docs/api.md § Acts for the
// authority). A team project, so a team editor can be one: the owner (the
// host) proposes; a proposal grants nothing; only a member already acting for
// the authority confirms (or the operator, the bootstrap); the owner
// withdraws a proposal but can't remove a confirmed delegate; the authority
// removes or declines anyone; losing editor lapses it; every change is in the
// History. Every "can't" has its positive control.
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, confirmAsOperator, DECISION, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let admin: User; // the team's admin: an owner of the project through the team
let lead: User; // a direct editor, the authority's first delegate (confirmed by the operator)
let teamEditor: User; // an editor only through the team (team role member)
let proposedEd: User; // a direct editor the owner proposes, never confirmed
let viewer: User;
let applicant: User;
let outsider: User;
let teamId: string;
let projectId: string;
let published: string;
let sid: string;

const P = () => `/projects/${projectId}`;
const D = () => `${P()}/authority-delegates`;
const outlet = node('Outlet', null);
const farm = node('Upper', outlet.id);
const kinds = async () =>
	(await asOwner(`SELECT kind, subject FROM audit_event WHERE project_id = $1 AND kind LIKE 'authority.%' ORDER BY id`, [projectId])) as { kind: string; subject: Record<string, unknown> }[];
const decide = (u: User, id: string) => u.call('POST', `${P()}/scenarios/${id}/decide`, { ...DECISION, outcome: 'licence_issued' });
const rowsAs = (u: User) => withUser(u.id, async (db) => (await db.query('SELECT user_id FROM authority_delegate WHERE project_id = $1', [projectId])).rows);

beforeAll(async () => {
	[admin, lead, teamEditor, proposedEd, viewer, applicant, outsider] = (await Promise.all(
		['AdAdmin', 'AdLead', 'AdTeamEd', 'AdProposed', 'AdViewer', 'AdApplicant', 'AdOutsider'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	teamId = (await admin.call('POST', '/teams', { name: 'Delegates WUA' })).body.team.id;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: teamEditor.email, role: 'member' })).status).toBe(201);
	projectId = (await admin.call('POST', '/projects', { name: 'Delegates', teamId })).body.project.id;
	expect((await admin.call('PUT', `${P()}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await admin.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await admin.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	published = (await admin.call('POST', `${P()}/runs`, { label: 'Baseline' })).body.run.id;
	expect((await admin.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[lead, 'editor'],
		[proposedEd, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor']
	] as const) {
		expect((await admin.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	}
	const made = await applicant.call('POST', `${P()}/scenarios`, { name: 'Raise the weir', baseRunId: published, ops: [] });
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	sid = made.body.scenario.id;
	expect((await applicant.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
}, 60_000);

describe('the bootstrap: nobody acts for the authority yet', () => {
	it('lets the owner propose, but a proposal grants nothing: the decision is refused, in the route and past it', async () => {
		const res = await admin.call('POST', D(), { userId: lead.id });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.delegate).toMatchObject({ status: 'proposed', active: false, confirmedAt: null });
		expect((await decide(lead, sid)).status).toBe(403);
		await expect(
			withUser(lead.id, (db) =>
				db.query(`UPDATE scenario SET status = 'decided', outcome = 'licence_issued', decision_authority = 'X', decision_date = '2026-09-30', reasons_received = true WHERE id = $1`, [sid])
			)
		).rejects.toMatchObject({ code: '42501' });
		expect((await lead.call('GET', P())).body.project.actsForAuthority).toBe(false);
	});

	it('refuses the owner confirming it, in the route and past it: only the operator confirms the first', async () => {
		expect((await admin.call('POST', `${D()}/${lead.id}/confirm`, {})).status).toBe(403);
		const sql = await withUser(admin.id, (db) => db.query('UPDATE authority_delegate SET confirmed_at = now() WHERE project_id = $1 AND user_id = $2', [projectId, lead.id]));
		expect(sql.rowCount).toBe(0);
		// Nor can the owner insert a confirmed row: the guard rewrites it as a proposal.
		await withUser(admin.id, (db) => db.query('INSERT INTO authority_delegate (project_id, user_id) VALUES ($1, $2)', [projectId, proposedEd.id]));
		const [row] = await asOwner('SELECT confirmed_at FROM authority_delegate WHERE project_id = $1 AND user_id = $2', [projectId, proposedEd.id]);
		expect(row.confirmed_at).toBeNull();
		// The operator path refuses a confirmation with no reference.
		await expect(asOwner('SELECT authority_confirm_by_operator($1, $2, $3)', [projectId, lead.id, ' '])).rejects.toMatchObject({ code: '23514' });
	});

	it('positive control: the operator confirms the first on the authority’s letter, and then the decision is theirs to record', async () => {
		await confirmAsOperator(projectId, lead.id, 'DWS letter 14/2026');
		expect((await lead.call('GET', P())).body.project.actsForAuthority).toBe(true);
		const got = (await viewer.call('GET', D())).body;
		expect(got.delegates.find((d: { userId: string }) => d.userId === lead.id)).toMatchObject({ status: 'confirmed', active: true, confirmedVia: 'operator', reference: 'DWS letter 14/2026' });
		expect(got).toMatchObject({ canPropose: false, canConfirm: false, candidates: [] });
	});
});

describe('the authority confirms, declines and removes; the owner proposes and withdraws', () => {
	it('lists a team editor among the candidates, and the authority’s own proposal is confirmed at once', async () => {
		const got = (await lead.call('GET', D())).body;
		expect(got).toMatchObject({ canPropose: true, canConfirm: true });
		expect(got.candidates).toContainEqual({ userId: teamEditor.id, displayName: 'AdTeamEd', role: 'editor', via: 'team' });
		expect(got.candidates.map((c: { userId: string }) => c.userId)).not.toContain(viewer.id);
		const res = await lead.call('POST', D(), { userId: teamEditor.id });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.delegate).toMatchObject({ status: 'confirmed', active: true, confirmedVia: 'member', confirmedBy: { userId: lead.id } });
		// A team editor, with no membership row, now acts for the authority.
		expect((await teamEditor.call('GET', P())).body.project.actsForAuthority).toBe(true);
	});

	it('lets the authority confirm an owner’s proposal (positive control for the owner’s 403 above)', async () => {
		expect((await admin.call('DELETE', `${D()}/${proposedEd.id}`)).status).toBe(204); // the planted proposal from above, withdrawn by the owner
		expect((await admin.call('POST', D(), { userId: proposedEd.id })).status).toBe(201);
		const res = await teamEditor.call('POST', `${D()}/${proposedEd.id}/confirm`, {});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.delegate).toMatchObject({ status: 'confirmed', confirmedBy: { userId: teamEditor.id } });
		expect((await teamEditor.call('POST', `${D()}/${proposedEd.id}/confirm`, {})).status).toBe(409);
	});

	it('refuses the owner removing a confirmed delegate, in the route and past it', async () => {
		expect((await admin.call('DELETE', `${D()}/${proposedEd.id}`)).status).toBe(403);
		const sql = await withUser(admin.id, (db) => db.query('DELETE FROM authority_delegate WHERE project_id = $1 AND user_id = $2', [projectId, proposedEd.id]));
		expect(sql.rowCount).toBe(0);
		expect((await proposedEd.call('GET', P())).body.project.actsForAuthority).toBe(true);
	});

	it('lets any member acting for the authority remove one (positive control), and the person step down', async () => {
		expect((await lead.call('DELETE', `${D()}/${proposedEd.id}`)).status).toBe(204);
		expect((await proposedEd.call('GET', P())).body.project.actsForAuthority).toBe(false);
		expect((await decide(proposedEd, sid)).status).toBe(403);
	});

	it('lets the owner withdraw a proposal, and the authority decline one', async () => {
		expect((await admin.call('POST', D(), { userId: proposedEd.id })).status).toBe(201);
		expect((await admin.call('DELETE', `${D()}/${proposedEd.id}`)).status).toBe(204);
		expect((await admin.call('POST', D(), { userId: proposedEd.id })).status).toBe(201);
		expect((await lead.call('DELETE', `${D()}/${proposedEd.id}`)).status).toBe(204);
	});

	it('records a confirmed team editor’s decision (positive control: a confirmed delegate decides)', async () => {
		const res = await decide(teamEditor, sid);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.scenario).toMatchObject({ status: 'decided', decidedBy: 'AdTeamEd' });
	});

	it('never answers water_app whether a person is a delegate (230): not an outsider, not even a member; the decision above still went through it', async () => {
		// 229 left app_authority_member SECURITY DEFINER and EXECUTE-able, with no caller check.
		for (const u of [outsider, viewer, lead]) {
			await expect(withUser(u.id, (db) => db.query('SELECT app_authority_member($1, $2) AS yes', [projectId, lead.id])), u.email).rejects.toMatchObject({ code: '42501' });
		}
		// Positive controls: the one caller (app_acts_for_authority, SECURITY DEFINER) still reaches it,
		// so a confirmed delegate acts for the authority, and a viewer still reads the list.
		expect((await lead.call('GET', P())).body.project.actsForAuthority).toBe(true);
		expect((await teamEditor.call('GET', P())).body.project.actsForAuthority).toBe(true);
		const listed = await withUser(viewer.id, async (db) => (await db.query<{ user_id: string }>('SELECT user_id FROM app_authority_members($1)', [projectId])).rows);
		expect(listed.map((r) => r.user_id)).toEqual(expect.arrayContaining([lead.id, teamEditor.id]));
		const fn = await asOwner(`SELECT prosecdef, has_function_privilege('water_app', oid, 'EXECUTE') AS app, has_function_privilege('public', oid, 'EXECUTE') AS pub
			FROM pg_proc WHERE oid = 'app_authority_member(uuid,uuid)'::regprocedure`);
		expect(fn[0]).toEqual({ prosecdef: false, app: false, pub: false });
	});
});

describe('lapse', () => {
	it('ends the delegation when the person no longer holds editor (a team member demoted to viewer)', async () => {
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${teamEditor.id}`, { role: 'viewer' })).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM authority_delegate WHERE project_id = $1 AND user_id = $2', [projectId, teamEditor.id])).toHaveLength(0);
		// Promoted again, they don't act for it until the authority confirms them again.
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${teamEditor.id}`, { role: 'member' })).status).toBe(200);
		expect((await teamEditor.call('GET', P())).body.project.actsForAuthority).toBe(false);
	});
});

describe('who reads it', () => {
	it('is read by anyone who reads the project; never by an outsider or an applicant (positive control: a viewer)', async () => {
		expect((await rowsAs(viewer)).map((r) => r.user_id)).toContain(lead.id);
		expect(await rowsAs(outsider)).toEqual([]);
		expect(await rowsAs(applicant)).toEqual([]);
		expect((await outsider.call('GET', D())).status).toBe(404);
		expect((await applicant.call('GET', D())).status).toBe(403);
		expect((await viewer.call('GET', D())).status).toBe(200);
	});

	it('refuses a viewer proposing or removing anyone (they hold no editor role)', async () => {
		expect((await viewer.call('POST', D(), { userId: proposedEd.id })).status).toBe(403);
		expect((await viewer.call('DELETE', `${D()}/${lead.id}`)).status).toBe(403);
	});
});

describe('the History', () => {
	it('has every change, the operator’s included, with who it was about', async () => {
		const events = await kinds();
		expect(events.map((e) => e.kind)).toEqual([
			'authority.proposed', // the owner proposes lead
			'authority.proposed', // the planted proposal of proposedEd
			'authority.confirmed', // the operator confirms lead
			'authority.confirmed', // lead adds the team editor, confirmed at once
			'authority.withdrawn', // the owner withdraws the planted proposal
			'authority.proposed', // the owner proposes proposedEd
			'authority.confirmed', // the team editor confirms them
			'authority.removed', // lead removes them
			'authority.proposed',
			'authority.withdrawn', // the owner withdraws
			'authority.proposed',
			'authority.declined', // lead declines
			'authority.lapsed' // the team editor demoted
		]);
		expect(events[2]!.subject).toMatchObject({ userId: lead.id, displayName: 'AdLead', via: 'operator', reference: 'DWS letter 14/2026' });
		expect(events[12]!.subject).toMatchObject({ userId: teamEditor.id, wasConfirmed: true });
	});
});

describe('a project going', () => {
	it('takes its delegations with it, the confirmed ones too (no History is left to write to)', async () => {
		const id = (await admin.call('POST', '/projects', { name: 'Delegates, short-lived' })).body.project.id as string;
		expect((await admin.call('POST', `/projects/${id}/authority-delegates`, { userId: admin.id })).status).toBe(201);
		await confirmAsOperator(id, admin.id);
		expect((await admin.call('DELETE', `/projects/${id}`)).status).toBe(204);
		expect(await asOwner('SELECT 1 FROM authority_delegate WHERE project_id = $1', [id])).toHaveLength(0);
	});
});

// The migration's carry-over of 163's flags (its last statement), replayed in a transaction that is rolled back. Found
// by name, not number, so a renumbered migration still runs here.
const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const MIGRATION = readFileSync(new URL(readdirSync(MIGRATIONS).find((f) => f.endsWith('_authority_delegates.sql'))!, MIGRATIONS), 'utf8');
const CARRY_OVER = MIGRATION.slice(MIGRATION.indexOf('-- 5. Carry the 163 flags over'));

describe('grandfathering the flags an owner set before 229', () => {
	it('carries an editor’s flag over as confirmed, with a History event whose actor is the owner who ticked it; a viewer’s granted nothing and stays behind', async () => {
		const [owner, editor, viewerU] = (await Promise.all(['GfOwner', 'GfEditor', 'GfViewer'].map((n) => signUp(n)))) as [User, User, User];
		const id = (await owner.call('POST', '/projects', { name: 'Grandfathered' })).body.project.id as string;
		expect((await owner.call('POST', `/projects/${id}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${id}/members`, { email: viewerU.email, role: 'viewer' })).status).toBe(201);
		expect(CARRY_OVER).toMatch(/^-- 5\. Carry/);
		const db = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await db.connect();
		try {
			await db.query('BEGIN');
			// As the owner ticked it before 229 (163's project_member_authority still asks for an owner).
			await db.query(`SELECT set_config('app.current_user_id', $1, true)`, [owner.id]);
			await db.query('UPDATE project_member SET acts_for_authority = true WHERE project_id = $1 AND user_id = ANY($2)', [id, [editor.id, viewerU.id]]);
			await db.query(
				`INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject) VALUES ($1, $2, 'GfOwner', 'member.authority', $3)`,
				[id, owner.id, JSON.stringify({ userId: editor.id, displayName: 'GfEditor', actsForAuthority: true })]
			);
			await db.query(CARRY_OVER);
			const { rows } = await db.query('SELECT user_id, proposed_by, confirmed_via, confirmed_at FROM authority_delegate WHERE project_id = $1', [id]);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ user_id: editor.id, proposed_by: owner.id, confirmed_via: 'grandfathered' });
			expect(rows[0].confirmed_at).not.toBeNull();
			const { rows: events } = await db.query(`SELECT actor_user_id, actor_label, subject FROM audit_event WHERE project_id = $1 AND kind = 'authority.grandfathered'`, [id]);
			expect(events).toEqual([{ actor_user_id: owner.id, actor_label: 'GfOwner', subject: { userId: editor.id, displayName: 'GfEditor', via: 'grandfathered', reference: 'Marked by an owner before 229' } }]);
			// And it counts: the editor acts for the authority.
			await db.query(`SELECT set_config('app.current_user_id', $1, true)`, [editor.id]);
			expect((await db.query('SELECT app_acts_for_authority($1) AS ok', [id])).rows[0].ok).toBe(true);
		} finally {
			await db.query('ROLLBACK');
			await db.end();
		}
	});
});
