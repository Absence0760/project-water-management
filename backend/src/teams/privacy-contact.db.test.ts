// A team's privacy contact (168_team_privacy_contact; POPIA s18(1)(b)): only a
// team admin sets it (API and RLS), every member of a team project reads it
// through GET /projects/:id/privacy-contact, farmers included, a stranger gets
// 404, and invitation emails name it. Each "cannot" has a positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, lastMailTo, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let admin: User;
let member: User;
let farmer: User;
let stranger: User;
let teamId: string;
let projectId: string;
let personal: string;
const outlet = node('Outlet', null);
const farmA = node('Contact farm', outlet.id);
const CONTACT = { name: 'Information Officer', email: 'io@contact-wua.example', postal: 'PO Box 7\nKloof 1234' };
const newEmail = (tag: string) => `${tag}-${crypto.randomUUID()}@example.com`;

beforeAll(async () => {
	[admin, member, farmer, stranger] = (await Promise.all(['PcAdmin', 'PcMember', 'PcFarmer', 'PcStranger'].map((n) => signUp(n)))) as [User, User, User, User];
	teamId = (await admin.call('POST', '/teams', { name: 'Contact WUA' })).body.team.id;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
	projectId = (await admin.call('POST', '/projects', { name: 'Contact catchment', teamId })).body.project.id;
	expect((await admin.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA], crops: [], cropAreas: [], transfers: [], landCover: [] })).status).toBe(200);
	await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'farmer')`, [projectId, farmer.id]);
	personal = (await admin.call('POST', '/projects', { name: 'Contact personal' })).body.project.id;
});

describe('PATCH /teams/:id privacyContact', () => {
	it('starts unset, for the team and for the project', async () => {
		expect((await member.call('GET', `/teams/${teamId}`)).body.team.privacyContact).toBeNull();
		expect((await farmer.call('GET', `/projects/${projectId}/privacy-contact`)).body).toEqual({ wuaName: null, contact: null });
	});

	it('only a team admin sets it: a member gets 403, a stranger 404, and RLS refuses a member’s UPDATE', async () => {
		expect((await member.call('PATCH', `/teams/${teamId}`, { privacyContact: CONTACT })).status).toBe(403);
		expect((await stranger.call('PATCH', `/teams/${teamId}`, { privacyContact: CONTACT })).status).toBe(404);
		const updated = await withUser(member.id, (db) => db.query(`UPDATE team SET privacy_contact_name = 'x', privacy_contact_email = 'x@y.z' WHERE id = $1`, [teamId]));
		expect(updated.rowCount).toBe(0);
		expect((await member.call('GET', `/teams/${teamId}`)).body.team.privacyContact).toBeNull();
		// Positive control: the admin can, and every member reads it.
		const r = await admin.call('PATCH', `/teams/${teamId}`, { privacyContact: { ...CONTACT, name: `  ${CONTACT.name} ` } });
		expect(r.status).toBe(200);
		expect(r.body.team.privacyContact).toEqual(CONTACT);
		expect((await member.call('GET', `/teams/${teamId}`)).body.team.privacyContact).toEqual(CONTACT);
	});

	it('refuses a contact without an email address, and the database refuses half a contact', async () => {
		expect((await admin.call('PATCH', `/teams/${teamId}`, { privacyContact: { name: 'No address' } })).status).toBe(400);
		expect((await admin.call('PATCH', `/teams/${teamId}`, { privacyContact: { name: 'Bad', email: 'nope' } })).status).toBe(400);
		await expect(asOwner(`UPDATE team SET privacy_contact_email = NULL WHERE id = $1`, [teamId])).rejects.toMatchObject({ code: '23514' });
	});
});

describe('GET /projects/:id/privacy-contact', () => {
	it('gives every member of a team project the team’s name and contact, a farmer included', async () => {
		for (const u of [admin, member, farmer]) {
			const r = await u.call('GET', `/projects/${projectId}/privacy-contact`);
			expect(r.status).toBe(200);
			expect(r.body).toEqual({ wuaName: null, contact: { organisation: 'Contact WUA', ...CONTACT } });
		}
	});

	it('answers a stranger 404 and nothing from the function (positive control above)', async () => {
		expect((await stranger.call('GET', `/projects/${projectId}/privacy-contact`)).status).toBe(404);
		const rows = await withUser(stranger.id, async (db) => (await db.query('SELECT * FROM app_project_privacy_contact($1)', [projectId])).rows);
		expect(rows).toEqual([]);
		// A farmer still can't read the team row itself: only the function's four fields.
		const teamRows = await withUser(farmer.id, async (db) => (await db.query('SELECT id FROM team WHERE id = $1', [teamId])).rows);
		expect(teamRows).toEqual([]);
	});

	it('is null for a project without a team', async () => {
		expect((await admin.call('GET', `/projects/${personal}/privacy-contact`)).body.contact).toBeNull();
	});
});

describe('invitation emails name the contact', () => {
	it('in a farmer invite and a project invite of a team project', async () => {
		const f = newEmail('pc-farmer');
		expect((await admin.call('POST', `/projects/${projectId}/farmers`, { email: f, nodeIds: [farmA.id] })).status).toBe(201);
		expect(lastMailTo(f)!.text).toContain('Contact WUA decides about your information in this catchment. Questions about it: Information Officer, io@contact-wua.example.');
		expect(lastMailTo(f)!.text).toContain('Or write to Information Officer at: PO Box 7');
		const v = newEmail('pc-viewer');
		expect((await admin.call('POST', `/projects/${projectId}/members`, { email: v, role: 'viewer' })).status).toBe(201);
		expect(lastMailTo(v)!.text).toContain('Contact WUA decides about your information in its projects.');
	});

	it('in a team invite; and not once it is removed', async () => {
		const m = newEmail('pc-team');
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: m, role: 'viewer' })).status).toBe(201);
		expect(lastMailTo(m)!.text).toContain('Questions about it: Information Officer');
		const r = await admin.call('PATCH', `/teams/${teamId}`, { privacyContact: null });
		expect(r.status).toBe(200);
		expect(r.body.team.privacyContact).toBeNull();
		const n = newEmail('pc-team2');
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: n, role: 'viewer' })).status).toBe(201);
		expect(lastMailTo(n)!.text).not.toContain('decides about your information');
		expect((await farmer.call('GET', `/projects/${projectId}/privacy-contact`)).body.contact).toBeNull();
	});
});
