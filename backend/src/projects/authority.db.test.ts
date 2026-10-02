// The responsible authority (163_licensing_authority; provisional position,
// pre-counsel research, 2026-10-01; docs/scenarios.md § Applications "Who
// decides", docs/api.md § Members and § Publication): who acts for it, what
// only they may do (record its decision, endorse a published baseline), and
// the conflict guard that keeps editors out of applying parties. Every "can't"
// has its positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, asOwner, DECISION, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let marked: User; // an editor acting for the authority
let unmarked: User; // an editor who isn't
let viewer: User;
let applicant: User;
let partyMate: User;
let farmer: User;
let projectId: string;
let published: string;
let pubId: string;

const P = () => `/projects/${projectId}`;
const outlet = node('Outlet', null);
const farm = node('Upper', outlet.id);
const AUTHORITY = { name: 'Breede-Olifants CMA', kind: 'cma', office: 'Worcester' };

const apply = async (u: User, name: string) => {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops: [] });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.scenario.id as string;
};

beforeAll(async () => {
	const users = await Promise.all(['AuOwner', 'AuMarked', 'AuUnmarked', 'AuViewer', 'AuApplicant', 'AuPartymate', 'AuFarmer'].map((n) => signUp(n)));
	[owner, marked, unmarked, viewer, applicant, partyMate, farmer] = users as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Authority' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	published = (await owner.call('POST', `${P()}/runs`, { label: 'Baseline' })).body.run.id;
	const pub = await owner.call('POST', `${P()}/publication`, { runId: published });
	expect(pub.status).toBe(201);
	pubId = pub.body.publication.id;
	for (const [u, role] of [
		[marked, 'editor'],
		[unmarked, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor'],
		[partyMate, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	}
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	for (const u of [applicant, partyMate]) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party: 'Upper Trust' })).status).toBe(200);
}, 60_000);

describe('who acts for the responsible authority', () => {
	it('is marked by the owner only, recorded in the change history, and shown on the member list', async () => {
		// An editor can't mark themselves, through the route or past it.
		expect((await marked.call('PATCH', `${P()}/members/${marked.id}`, { actsForAuthority: true })).status).toBe(403);
		const sql = await withUser(marked.id, (db) => db.query('UPDATE project_member SET acts_for_authority = true WHERE project_id = $1 AND user_id = $2', [projectId, marked.id]));
		expect(sql.rowCount).toBe(0);
		// Positive control: the owner marks them.
		const res = await owner.call('PATCH', `${P()}/members/${marked.id}`, { actsForAuthority: true });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.member).toMatchObject({ userId: marked.id, role: 'editor', actsForAuthority: true });
		const members = (await viewer.call('GET', `${P()}/members`)).body.members as { userId: string; actsForAuthority: boolean }[];
		expect(members.find((m) => m.userId === marked.id)?.actsForAuthority).toBe(true);
		expect(members.find((m) => m.userId === unmarked.id)?.actsForAuthority).toBe(false);
		const [event] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'member.authority' ORDER BY id DESC LIMIT 1`, [projectId]);
		expect(event.subject).toMatchObject({ userId: marked.id, actsForAuthority: true });
	});

	it('says on the project whether the caller acts for it', async () => {
		expect((await marked.call('GET', P())).body.project.actsForAuthority).toBe(true);
		expect((await unmarked.call('GET', P())).body.project.actsForAuthority).toBe(false);
		// A marked member below editor doesn't (the right needs editor too): mark the viewer, then read.
		expect((await owner.call('PATCH', `${P()}/members/${viewer.id}`, { actsForAuthority: true })).status).toBe(200);
		expect((await viewer.call('GET', P())).body.project.actsForAuthority).toBe(false);
		expect((await owner.call('PATCH', `${P()}/members/${viewer.id}`, { actsForAuthority: false })).status).toBe(200);
	});

	it('never comes with a new membership, whatever the insert says', async () => {
		const late = await signUp('AuLate');
		expect((await owner.call('POST', `${P()}/members`, { email: late.email, role: 'editor' })).status).toBe(201);
		const [row] = await asOwner('SELECT acts_for_authority FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, late.id]);
		expect(row.acts_for_authority).toBe(false);
	});

	it('names the project’s authority in its settings, which runs never record', async () => {
		expect((await owner.call('PATCH', P(), { settings: { responsibleAuthority: { name: '', kind: 'cma' } } })).status).toBe(400);
		expect((await owner.call('PATCH', P(), { settings: { responsibleAuthority: { name: 'X', kind: 'water board' } } })).status).toBe(400);
		const res = await owner.call('PATCH', P(), { settings: { responsibleAuthority: AUTHORITY } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.project.settings.responsibleAuthority).toEqual(AUTHORITY);
		const run = await owner.call('POST', `${P()}/runs`, { label: 'After naming' });
		expect(run.status).toBe(201);
		const [{ settings }] = await asOwner(`SELECT inputs->'settings' AS settings FROM model_run WHERE id = $1`, [run.body.run.id]);
		expect(settings).not.toHaveProperty('responsibleAuthority');
	});
});

describe('recording the authority’s decision', () => {
	let sid: string;

	beforeAll(async () => {
		sid = await apply(applicant, 'Raise the weir');
		expect((await applicant.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
	});

	it('is refused to an editor who doesn’t act for the authority, through the route and past it', async () => {
		expect((await unmarked.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(403);
		await expect(
			withUser(unmarked.id, (db) =>
				db.query(
					`UPDATE scenario SET status = 'decided', outcome = 'licence_issued', decision_authority = 'X', decision_date = '2026-09-30', reasons_received = true WHERE id = $1`,
					[sid]
				)
			)
		).rejects.toMatchObject({ code: '42501' });
		expect((await asOwner('SELECT status FROM scenario WHERE id = $1', [sid]))[0].status).toBe('submitted');
	});

	it('is recorded by a marked editor, with the project’s authority when the body names none (positive control)', async () => {
		const { authority: _a, ...body } = DECISION;
		const res = await marked.call('POST', `${P()}/scenarios/${sid}/decide`, { ...body, outcome: 'application_rejected', reasonsReceived: false });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.scenario).toMatchObject({
			status: 'decided',
			outcome: 'application_rejected',
			decisionAuthority: AUTHORITY.name,
			decisionDate: DECISION.decisionDate,
			decisionReference: DECISION.reference,
			reasonsReceived: false,
			decidedBy: 'AuMarked'
		});
		const [event] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'scenario.decided' ORDER BY id DESC LIMIT 1`, [projectId]);
		expect(event.subject).toMatchObject({ outcome: 'application_rejected', authority: AUTHORITY.name, decisionDate: DECISION.decisionDate });
	});

	it('leaves a team scenario an editor only marks decided alone, but an outcome on one is the authority’s', async () => {
		const made = await unmarked.call('POST', `${P()}/scenarios`, { name: 'Team what-if', baseRunId: published, ops: [] });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		const team = made.body.scenario.id as string;
		expect((await unmarked.call('PATCH', `${P()}/scenarios/${team}`, { status: 'submitted' })).status).toBe(200);
		// Recording an outcome on it needs the mark too.
		expect((await unmarked.call('POST', `${P()}/scenarios/${team}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(403);
		// Positive control: marking it decided, with no outcome, is the team's own move (as before 163).
		const marked = await unmarked.call('PATCH', `${P()}/scenarios/${team}`, { status: 'decided' });
		expect(marked.status, JSON.stringify(marked.body)).toBe(200);
		expect(marked.body.scenario).toMatchObject({ status: 'decided', outcome: null, decisionAuthority: null, decisionDate: null, reasonsReceived: null });
	});

	it('needs an authority: without one in the body or the settings it is refused', async () => {
		const other = await apply(applicant, 'Second weir');
		expect((await applicant.call('POST', `${P()}/scenarios/${other}/submit`)).status).toBe(200);
		expect((await owner.call('PATCH', P(), { settings: { responsibleAuthority: null } })).status).toBe(200);
		const { authority: _a, ...body } = DECISION;
		expect((await marked.call('POST', `${P()}/scenarios/${other}/decide`, { ...body, outcome: 'not_considered' })).status).toBe(400);
		// Control: naming it in the body.
		expect((await marked.call('POST', `${P()}/scenarios/${other}/decide`, { ...DECISION, outcome: 'not_considered' })).status).toBe(200);
		expect((await owner.call('PATCH', P(), { settings: { responsibleAuthority: AUTHORITY } })).status).toBe(200);
	});
});

describe('endorsing a published baseline', () => {
	it('is refused to an editor who doesn’t act for the authority, through the route and past it', async () => {
		expect((await unmarked.call('POST', `${P()}/publication/${pubId}/endorse`, {})).status).toBe(403);
		await expect(withUser(unmarked.id, (db) => db.query('UPDATE run_publication SET endorsed_at = now() WHERE id = $1', [pubId]))).rejects.toMatchObject({ code: '42501' });
	});

	it('flags the report while the baseline isn’t endorsed', async () => {
		const r = (await viewer.call('GET', `${P()}/runs/${published}/evidence-report`)).body.report;
		expect(r.identity.authority).toEqual(AUTHORITY);
		expect(r.identity.baseline.endorsement).toBeNull();
		expect(r.flags.map((f: { id: string }) => f.id)).toContain('notEndorsed');
	});

	it('is recorded once by a marked editor, stamped by the database, and shown to staff but not farmers (positive control)', async () => {
		const res = await marked.call('POST', `${P()}/publication/${pubId}/endorse`, { note: 'Accepted as the 2026 baseline.' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.publication.endorsement).toMatchObject({ endorsedBy: 'AuMarked', note: 'Accepted as the 2026 baseline.' });
		expect((await marked.call('POST', `${P()}/publication/${pubId}/endorse`, {})).status).toBe(409);
		// Never rewritten, even by someone who may endorse.
		for (const sql of [`UPDATE run_publication SET endorsement_note = 'changed' WHERE id = $1`, 'UPDATE run_publication SET endorsed_by = NULL WHERE id = $1']) {
			await expect(withUser(marked.id, (db) => db.query(sql, [pubId]))).rejects.toMatchObject({ code: '23514' });
		}
		const [event] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'publication.endorsed'`, [projectId]);
		expect(event.subject).toMatchObject({ publicationId: pubId, runId: published });
		expect((await viewer.call('GET', `${P()}/publication`)).body.current.endorsement).toMatchObject({ endorsedBy: 'AuMarked' });
		const forFarmer = (await farmer.call('GET', `${P()}/publication`)).body;
		expect(forFarmer.current).not.toHaveProperty('endorsement');
		expect(forFarmer.history[0]).not.toHaveProperty('endorsement');
	});

	it('prints the endorsement on the report and drops the flag', async () => {
		const r = (await viewer.call('GET', `${P()}/runs/${published}/evidence-report`)).body.report;
		expect(r.identity.baseline.endorsement).toMatchObject({ endorsedBy: 'AuMarked', note: 'Accepted as the 2026 baseline.' });
		expect(r.flags.map((f: { id: string }) => f.id)).not.toContain('notEndorsed');
	});

	it('may endorse a superseded publication, once', async () => {
		// Two more publications: the first of them, never endorsed, is then superseded.
		const next = (await owner.call('POST', `${P()}/runs`, { label: 'Next baseline' })).body.run.id;
		const old = (await owner.call('POST', `${P()}/publication`, { runId: next })).body.publication.id as string;
		expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
		expect((await asOwner('SELECT superseded_at IS NOT NULL AS gone, endorsed_at FROM run_publication WHERE id = $1', [old]))[0]).toEqual({ gone: true, endorsed_at: null });
		expect((await marked.call('POST', `${P()}/publication/${old}/endorse`, {})).status).toBe(200);
		expect((await marked.call('POST', `${P()}/publication/${old}/endorse`, {})).status).toBe(409);
		// …and the superseded row stays history otherwise.
		await expect(withUser(owner.id, (db) => db.query(`UPDATE run_publication SET note = 'x' WHERE id = $1`, [old]))).rejects.toMatchObject({ code: '23514' });
	});
});

describe('the conflict guard: nobody both edits the project and belongs to an applying party', () => {
	it('refuses putting an editor in a party (409 role_conflict); a contributor joins one (positive control)', async () => {
		const res = await owner.call('PATCH', `${P()}/members/${unmarked.id}`, { party: 'Upper Trust' });
		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({ code: 'role_conflict' });
		expect(res.body.error).not.toMatch(/project_member|constraint|violates/);
		expect((await asOwner('SELECT party FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, unmarked.id]))[0].party).toBeNull();
		const mates = (await owner.call('GET', `${P()}/members`)).body.members.filter((m: { party: string | null }) => m.party === 'Upper Trust');
		expect(mates.map((m: { userId: string }) => m.userId).sort()).toEqual([applicant.id, partyMate.id].sort());
	});

	it('refuses promoting a party member to editor; to viewer, or once out of the party, goes through (positive controls)', async () => {
		expect((await owner.call('PATCH', `${P()}/members/${partyMate.id}`, { role: 'editor' })).body).toMatchObject({ code: 'role_conflict' });
		expect((await owner.call('PATCH', `${P()}/members/${partyMate.id}`, { role: 'owner' })).status).toBe(409);
		expect((await owner.call('PATCH', `${P()}/members/${partyMate.id}`, { role: 'viewer' })).status).toBe(200);
		// Out of the party and up to editor in one change.
		const both = await owner.call('PATCH', `${P()}/members/${partyMate.id}`, { role: 'editor', party: null });
		expect(both.status, JSON.stringify(both.body)).toBe(200);
		expect(both.body.member).toMatchObject({ role: 'editor', party: null });
	});

	it('refuses promoting someone who owns an application to editor', async () => {
		const res = await owner.call('PATCH', `${P()}/members/${applicant.id}`, { role: 'editor', party: null });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe('role_conflict');
		expect((await asOwner('SELECT role, party FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, applicant.id]))[0]).toEqual({
			role: 'contributor',
			party: 'Upper Trust'
		});
	});

	it('refuses sharing an application with an editor (an owner promoted to viewer shares with any member); with a contributor it goes through', async () => {
		const owned = await apply(applicant, 'Shared weir');
		expect((await owner.call('PATCH', `${P()}/members/${applicant.id}`, { role: 'viewer' })).status).toBe(200);
		const res = await applicant.call('POST', `${P()}/scenarios/${owned}/members`, { userId: unmarked.id });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe('role_conflict');
		const late = await signUp('AuConsultant');
		expect((await owner.call('POST', `${P()}/members`, { email: late.email, role: 'contributor' })).status).toBe(201);
		expect((await applicant.call('POST', `${P()}/scenarios/${owned}/members`, { userId: late.id })).status).toBe(201);
		// The shared contributor can't then be made an editor either.
		expect((await owner.call('PATCH', `${P()}/members/${late.id}`, { role: 'editor' })).body.code).toBe('role_conflict');
		// Back where it was, for the next test.
		expect((await owner.call('PATCH', `${P()}/members/${applicant.id}`, { role: 'contributor' })).status).toBe(200);
	});

	it('refuses a team role that makes a party member an editor of the team’s project, and a project moving into such a team', async () => {
		const teamId = (await owner.call('POST', '/teams', { name: 'Authority team' })).body.team.id as string;
		expect((await owner.call('PATCH', P(), { teamId })).status).toBe(200);
		// The party member joining the team as a member (editor on its projects): refused past the route too.
		await expect(asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, applicant.id])).rejects.toMatchObject({
			code: '23514',
			constraint: 'role_conflict'
		});
		// Positive control: as a team viewer.
		await asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'viewer')`, [teamId, applicant.id]);
		await expect(asOwner(`UPDATE team_member SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [teamId, applicant.id])).rejects.toMatchObject({
			constraint: 'role_conflict'
		});
		// A project moving into a team where they are a member.
		const otherTeam = (await owner.call('POST', '/teams', { name: 'Other team' })).body.team.id as string;
		await asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'member')`, [otherTeam, applicant.id]);
		expect((await owner.call('PATCH', P(), { teamId: otherTeam })).body.code).toBe('role_conflict');
		expect((await owner.call('PATCH', P(), { teamId: null })).status).toBe(200);
	});
});
