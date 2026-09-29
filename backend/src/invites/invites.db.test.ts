// Inviting people who don't have an account yet (004_email.sql, invites.ts).
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { describe, expect, it } from 'vitest';
import { anon, asOwner, lastMailTo, mailCount, node, signUp, tokenIn } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { INVITE_CAP } from './invites.js';
import { SESSION_COOKIE, signSession } from '../auth/session.js';

const newEmail = (tag: string) => `${tag}-${crypto.randomUUID()}@example.com`;

/** Register through the API (optionally via an invite link); returns a signed-in caller. */
async function register(email: string, inviteToken?: string) {
	const res = await anon('POST', '/auth/register', {
		email,
		password: 'correct horse',
		displayName: 'Invitee', acceptTerms: LEGAL_VERSION,
		...(inviteToken ? { inviteToken } : {})
	});
	// A sign-up through a matching invite is signed in (201). Any other waits
	// for its confirmation link and signs nobody in (202, issue #57): these
	// tests go on as that account, with a session minted for it.
	let cookie: string;
	let user: { id: string; emailVerified?: boolean };
	if (res.status === 201) {
		cookie = res.headers.get('set-cookie')!.split(';')[0]!;
		user = res.body.user;
	} else {
		expect(res.status).toBe(202);
		const [row] = (await asOwner('SELECT id FROM app_user WHERE email = $1', [email])) as { id: string }[];
		user = { id: row!.id, emailVerified: false } as { id: string; emailVerified: boolean };
		cookie = `${SESSION_COOKIE}=${await signSession(user.id)}`;
	}
	return {
		user,
		call: (method: string, path: string, body?: unknown) => anon(method, path, body, cookie)
	};
}

async function projectOf(owner: Awaited<ReturnType<typeof signUp>>, name = 'Catchment') {
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}

describe('project invites', () => {
	it('invites an unknown address instead of 404, and lists it for owners only', async () => {
		const owner = await signUp('InvOwner');
		const editor = await signUp('InvEditor');
		const outsider = await signUp('InvOutsider');
		const pid = await projectOf(owner, 'Kloof <River>');
		await owner.call('POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' });

		const email = newEmail('guest');
		const res = await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		expect(res.status).toBe(201);
		expect(res.body.invited).toBe(true);
		expect(res.body.invite).toMatchObject({ email, role: 'viewer', invitedBy: 'InvOwner', expired: false });
		// ~7 days.
		const days = (Date.parse(res.body.invite.expiresAt) - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThanOrEqual(7);

		const mail = lastMailTo(email)!;
		expect(mail.subject).toBe('InvOwner invited you to Water Management');
		expect(mail.text).toContain('Kloof <River>');
		expect(mail.html).toContain('Kloof &lt;River&gt;');
		expect(mail.html).not.toContain('<River>');
		expect(mail.text).toMatch(/http:\/\/localhost:7777\/register\?invite=[A-Za-z0-9_-]{43}/);

		const list = await owner.call('GET', `/projects/${pid}/invites`);
		expect(list.status).toBe(200);
		expect(list.body.invites.map((i: { email: string }) => i.email)).toEqual([email]);
		expect((await editor.call('GET', `/projects/${pid}/invites`)).status).toBe(403);
		expect((await outsider.call('GET', `/projects/${pid}/invites`)).status).toBe(404);
		expect((await editor.call('POST', `/projects/${pid}/members`, { email: newEmail('x'), role: 'viewer' })).status).toBe(403);
	});

	it('RLS: only owners can read a project invite (with a positive control)', async () => {
		const owner = await signUp('RlsOwner');
		const viewer = await signUp('RlsViewer');
		const outsider = await signUp('RlsOutsider');
		const pid = await projectOf(owner);
		await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' });
		await owner.call('POST', `/projects/${pid}/members`, { email: newEmail('rls'), role: 'editor' });
		const count = (uid: string) =>
			withUser(uid, async (db) => (await db.query('SELECT id FROM invite WHERE project_id = $1', [pid])).rowCount);
		expect(await count(owner.id)).toBe(1);
		expect(await count(viewer.id)).toBe(0);
		expect(await count(outsider.id)).toBe(0);
		// A non-owner can't forge one either.
		await expect(
			withUser(viewer.id, (db) =>
				db.query(
					`INSERT INTO invite (email, project_id, project_role, invited_by, token_hash, expires_at)
					 VALUES ('x@example.com', $1, 'owner', $2, decode(repeat('ab', 32), 'hex'), now() + interval '1 day')`,
					[pid, viewer.id]
				)
			)
		).rejects.toMatchObject({ code: '42501' });
	});

	it('joins the project after the invitee signs up and verifies their address', async () => {
		const owner = await signUp('Joiner');
		const pid = await projectOf(owner);
		const email = newEmail('later');
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'editor' });

		// Plain sign-up (not via the link) proves nothing about the inbox yet.
		const invitee = await register(email);
		expect(invitee.user.emailVerified).toBe(false);
		expect((await invitee.call('GET', `/projects/${pid}`)).status).toBe(404);

		const verifyToken = tokenIn(lastMailTo(email));
		expect((await anon('POST', '/auth/verify-email', { token: verifyToken })).status).toBe(200);
		const p = await invitee.call('GET', `/projects/${pid}`);
		expect(p.status).toBe(200);
		expect(p.body.project.role).toBe('editor');
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites).toEqual([]);
	});

	it('signing up through the invite link verifies the address and joins at once', async () => {
		const owner = await signUp('LinkOwner');
		const pid = await projectOf(owner, 'Linked');
		const email = newEmail('linked');
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		const inviteToken = tokenIn(lastMailTo(email));

		const info = await anon('POST', '/auth/invite-info', { token: inviteToken });
		expect(info.status).toBe(200);
		expect(info.body.invite).toEqual({ email, projectName: 'Linked', teamName: null, invitedBy: 'LinkOwner' });

		const invitee = await register(email.toUpperCase(), inviteToken);
		expect(invitee.user.emailVerified).toBe(true);
		expect(mailCount(email)).toBe(1); // the invite only — no verification email needed
		expect((await invitee.call('GET', `/projects/${pid}`)).body.project.role).toBe('viewer');
		// The link is spent.
		expect((await anon('POST', '/auth/invite-info', { token: inviteToken })).status).toBe(404);
	});

	it("an invite link doesn't help someone signing up with a different address", async () => {
		const owner = await signUp('Hijack');
		const pid = await projectOf(owner);
		const email = newEmail('victim');
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'owner' });
		const inviteToken = tokenIn(lastMailTo(email));

		const attacker = await register(newEmail('attacker'), inviteToken);
		expect(attacker.user.emailVerified).toBe(false);
		expect((await attacker.call('GET', `/projects/${pid}`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites).toHaveLength(1);
	});

	it('expired invites are not accepted and show as expired', async () => {
		const owner = await signUp('Expirer');
		const pid = await projectOf(owner);
		const email = newEmail('slow');
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		const inviteToken = tokenIn(lastMailTo(email));
		await asOwner(`UPDATE invite SET expires_at = now() - interval '1 second' WHERE email = $1`, [email]);

		expect((await anon('POST', '/auth/invite-info', { token: inviteToken })).status).toBe(404);
		const invitee = await register(email, inviteToken);
		expect(invitee.user.emailVerified).toBe(false);
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
		expect((await invitee.call('GET', `/projects/${pid}`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites[0].expired).toBe(true);
	});

	it('re-inviting updates the role; the email is re-sent only outside the cooldown, with a fresh link', async () => {
		const owner = await signUp('Reinviter');
		const pid = await projectOf(owner);
		const email = newEmail('again');
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		const first = tokenIn(lastMailTo(email));

		const again = await owner.call('POST', `/projects/${pid}/members`, { email, role: 'editor' });
		expect(again.status).toBe(201);
		expect(again.body.invite.role).toBe('editor');
		expect(mailCount(email)).toBe(1);

		await asOwner(`UPDATE invite SET last_sent_at = now() - interval '2 minutes' WHERE email = $1`, [email]);
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'editor' });
		expect(mailCount(email)).toBe(2);
		const second = tokenIn(lastMailTo(email));
		expect(second).not.toBe(first);
		expect((await anon('POST', '/auth/invite-info', { token: first })).status).toBe(404);
		expect((await anon('POST', '/auth/invite-info', { token: second })).status).toBe(200);
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites).toHaveLength(1);
	});

	it('owners revoke invites; a revoked invite grants nothing', async () => {
		const owner = await signUp('Revoker');
		const editor = await signUp('RevEditor');
		const pid = await projectOf(owner);
		await owner.call('POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' });
		const email = newEmail('revoked');
		const inviteId = (await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' })).body.invite.id;
		const inviteToken = tokenIn(lastMailTo(email));

		expect((await editor.call('DELETE', `/projects/${pid}/invites/${inviteId}`)).status).toBe(403);
		expect((await owner.call('DELETE', `/projects/${pid}/invites/${inviteId}`)).status).toBe(204);
		expect((await owner.call('DELETE', `/projects/${pid}/invites/${inviteId}`)).status).toBe(404);

		const invitee = await register(email, inviteToken);
		expect(invitee.user.emailVerified).toBe(false);
		expect((await invitee.call('GET', `/projects/${pid}`)).status).toBe(404);
	});

	it('adding someone who has since registered and verified makes them a member and clears the invite', async () => {
		const owner = await signUp('Direct');
		const pid = await projectOf(owner);
		const email = newEmail('direct');
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		await register(email);
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
		// Verifying already accepted the invite…
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites).toEqual([]);
		// …and a direct add of a verified account is a plain membership.
		const other = await signUp('DirectOther');
		const res = await owner.call('POST', `/projects/${pid}/members`, { email: other.email, role: 'viewer' });
		expect(res.status).toBe(201);
		expect(res.body.member).toMatchObject({ email: other.email, role: 'viewer' });
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: other.email, role: 'viewer' })).status).toBe(409);
	});

	it('an existing but unverified account is invited, not added, until it confirms the address', async () => {
		const owner = await signUp('Squat');
		const pid = await projectOf(owner, 'Squatted');
		const email = newEmail('squatted');
		// Someone registers the colleague's address first and never verifies it.
		const squatter = await register(email);
		expect(squatter.user.emailVerified).toBe(false);
		const before = mailCount(email);
		// The sign-up verification email went out moments ago; let its cooldown pass.
		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [squatter.user.id]);

		const res = await owner.call('POST', `/projects/${pid}/members`, { email, role: 'owner' });
		expect(res.status).toBe(201);
		// Same answer as for an address with no account at all.
		expect(res.body).toMatchObject({ invited: true, invite: { email, role: 'owner' } });
		expect(res.body.member).toBeUndefined();
		expect((await squatter.call('GET', `/projects/${pid}`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${pid}/members`)).body.members).toHaveLength(1);

		// The email goes to the real inbox and asks to confirm (the account can't sign up again).
		expect(mailCount(email)).toBe(before + 1);
		const mail = lastMailTo(email)!;
		expect(mail.text).toContain('There is already a Water Management account');
		expect(mail.text).toMatch(/http:\/\/localhost:7777\/verify-email\?token=[A-Za-z0-9_-]{43}/);
		expect(mail.text).toMatch(/Forgot password/);

		// Positive control: confirming the address accepts the invite.
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(mail) })).status).toBe(200);
		expect((await squatter.call('GET', `/projects/${pid}`)).body.project.role).toBe('owner');
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites).toEqual([]);
	});

	it('taking a squatted address back with a password reset also accepts the invite', async () => {
		const owner = await signUp('Takeback');
		const pid = await projectOf(owner);
		const email = newEmail('takeback');
		const squatter = await register(email);
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'editor' });
		expect((await squatter.call('GET', `/projects/${pid}`)).status).toBe(404);

		await anon('POST', '/auth/forgot-password', { email });
		const reset = await anon('POST', '/auth/reset-password', { token: tokenIn(lastMailTo(email)), password: 'the real owner' });
		expect(reset.status).toBe(204);
		// The squatter's session is dead; the inbox owner signs in and has the seat.
		expect((await squatter.call('GET', '/auth/me')).status).toBe(401);
		const login = await anon('POST', '/auth/login', { email, password: 'the real owner' });
		const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
		expect((await anon('GET', `/projects/${pid}`, undefined, cookie)).body.project.role).toBe('editor');
	});

	it('invites an unverified account without mailing again while its verification link is fresh', async () => {
		const owner = await signUp('Fresh');
		const pid = await projectOf(owner);
		const email = newEmail('fresh');
		const invitee = await register(email);
		const signupLink = tokenIn(lastMailTo(email));
		const res = await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		expect(res.body.invited).toBe(true);
		expect(mailCount(email)).toBe(1); // just the sign-up verification
		// That link (sent moments ago) accepts the invite too.
		expect((await anon('POST', '/auth/verify-email', { token: signupLink })).status).toBe(200);
		expect((await invitee.call('GET', `/projects/${pid}`)).body.project.role).toBe('viewer');
	});

	it('deleting the project deletes its invites', async () => {
		const owner = await signUp('Cascade');
		const pid = await projectOf(owner);
		const email = newEmail('cascade');
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		expect((await owner.call('DELETE', `/projects/${pid}`)).status).toBe(204);
		expect(await asOwner('SELECT 1 FROM invite WHERE email = $1', [email])).toHaveLength(0);
	});
});

describe('team invites', () => {
	it('admins invite by email; the invitee joins the team and reaches its projects', async () => {
		const admin = await signUp('TAdmin');
		const member = await signUp('TMember');
		const teamId = (await admin.call('POST', '/teams', { name: 'Consultants' })).body.team.id;
		await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' });
		const pid = (await admin.call('POST', '/projects', { name: 'Team catchment', teamId })).body.project.id;

		const email = newEmail('teamguest');
		const res = await admin.call('POST', `/teams/${teamId}/members`, { email, role: 'member' });
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ invited: true, invite: { email, role: 'member' } });
		expect(lastMailTo(email)!.text).toContain('the team “Consultants”');

		expect((await admin.call('GET', `/teams/${teamId}/invites`)).body.invites).toHaveLength(1);
		expect((await member.call('GET', `/teams/${teamId}/invites`)).status).toBe(403);
		expect((await member.call('POST', `/teams/${teamId}/members`, { email: newEmail('y'), role: 'member' })).status).toBe(403);

		const info = await anon('POST', '/auth/invite-info', { token: tokenIn(lastMailTo(email)) });
		expect(info.body.invite).toMatchObject({ teamName: 'Consultants', projectName: null });

		const invitee = await register(email, tokenIn(lastMailTo(email)));
		expect((await invitee.call('GET', `/teams/${teamId}`)).status).toBe(200);
		expect((await invitee.call('GET', `/projects/${pid}`)).body.project.role).toBe('editor');
		expect((await admin.call('GET', `/teams/${teamId}/invites`)).body.invites).toEqual([]);
	});

	it('invites a team viewer, who joins read-only (008_team_viewer)', async () => {
		const admin = await signUp('TVAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Reviewers' })).body.team.id;
		const pid = (await admin.call('POST', '/projects', { name: 'Reviewed catchment', teamId })).body.project.id;

		const email = newEmail('teamviewer');
		const res = await admin.call('POST', `/teams/${teamId}/members`, { email, role: 'viewer' });
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ invited: true, invite: { email, role: 'viewer' } });
		expect(lastMailTo(email)!.text).toContain('as a viewer');
		expect((await admin.call('GET', `/teams/${teamId}/invites`)).body.invites).toEqual([expect.objectContaining({ email, role: 'viewer' })]);

		const invitee = await register(email, tokenIn(lastMailTo(email)));
		expect((await invitee.call('GET', `/teams/${teamId}`)).body.team.role).toBe('viewer');
		expect((await invitee.call('GET', `/projects/${pid}`)).body.project.role).toBe('viewer');
		expect((await invitee.call('PATCH', `/projects/${pid}`, { name: 'x' })).status).toBe(403);
	});

	it('an unverified account is invited to a team, and joins once it confirms', async () => {
		const admin = await signUp('TSquat');
		const teamId = (await admin.call('POST', '/teams', { name: 'Squatters' })).body.team.id;
		const email = newEmail('teamsquat');
		const invitee = await register(email);
		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [invitee.user.id]);
		const res = await admin.call('POST', `/teams/${teamId}/members`, { email, role: 'admin' });
		expect(res.body).toMatchObject({ invited: true, invite: { email, role: 'admin' } });
		expect((await invitee.call('GET', `/teams/${teamId}`)).status).toBe(404);
		expect(lastMailTo(email)!.text).toContain('the team “Squatters”');
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
		expect((await invitee.call('GET', `/teams/${teamId}`)).status).toBe(200);
	});

	it('admins revoke team invites', async () => {
		const admin = await signUp('TRevoker');
		const teamId = (await admin.call('POST', '/teams', { name: 'Revokers' })).body.team.id;
		const email = newEmail('teamrevoked');
		const inviteId = (await admin.call('POST', `/teams/${teamId}/members`, { email, role: 'admin' })).body.invite.id;
		expect((await admin.call('DELETE', `/teams/${teamId}/invites/${inviteId}`)).status).toBe(204);
		expect((await admin.call('GET', `/teams/${teamId}/invites`)).body.invites).toEqual([]);
	});
});

// Issue #51 (adversary finding 3): adding people by email is capped per
// inviting user and per project or team a day (101_invite_throttle.sql,
// INVITE_CAP), counted before the address is looked up, so a capped owner
// learns nothing more about which addresses have accounts, and can't keep
// mailing strangers the project's name. Refused adds count nothing.
describe('the daily cap on adding by email (101_invite_throttle)', () => {
	const bucket = (b: string) => asOwner('SELECT attempts FROM invite_throttle WHERE bucket = $1', [b]).then((r) => (r[0]?.attempts as number | undefined) ?? 0);
	const fill = (b: string, n: number) => asOwner('UPDATE invite_throttle SET attempts = $2 WHERE bucket = $1', [b, n]);

	it('counts every address added, whether it has an account or not (positive control: under the cap both go through)', async () => {
		const owner = await signUp('CapOwner');
		const known = await signUp('CapKnown');
		const pid = await projectOf(owner);
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'viewer' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: newEmail('capped-guest'), role: 'viewer' })).status).toBe(201);
		expect(await bucket(`user:${owner.id}`)).toBe(2);
		expect(await bucket(`project:${pid}`)).toBe(2);
	});

	it('answers 429 with Retry-After once a person’s day is used up, the same for a known and an unknown address, and counts nothing', async () => {
		const owner = await signUp('CapFull');
		const known = await signUp('CapKnown2');
		const pid = await projectOf(owner);
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: newEmail('first'), role: 'viewer' })).status).toBe(201);
		await fill(`user:${owner.id}`, INVITE_CAP.perUser);
		const unknown = newEmail('nobody');
		const a = await anon('POST', `/projects/${pid}/members`, { email: known.email, role: 'viewer' }, owner.cookie);
		const b = await anon('POST', `/projects/${pid}/members`, { email: unknown, role: 'viewer' }, owner.cookie);
		for (const r of [a, b]) {
			expect(r.status).toBe(429);
			expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
		}
		expect(a.body).toEqual(b.body);
		expect(await bucket(`user:${owner.id}`)).toBe(INVITE_CAP.perUser);
		// Nothing was added, invited or mailed.
		expect(await asOwner('SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2', [pid, known.id])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM invite WHERE email = $1', [unknown])).toEqual([]);
		expect(mailCount(unknown)).toBe(0);
		// The same person's other projects and teams, and the farmer routes, share the cap.
		const other = await projectOf(owner, 'Another');
		expect((await owner.call('POST', `/projects/${other}/members`, { email: newEmail('x'), role: 'viewer' })).status).toBe(429);
		const team = (await owner.call('POST', '/teams', { name: 'Capped team' })).body.team.id as string;
		expect((await owner.call('POST', `/teams/${team}/members`, { email: newEmail('t'), role: 'member' })).status).toBe(429);
		// A window that is over starts again.
		await asOwner(`UPDATE invite_throttle SET window_start = now() - interval '24 hours 1 second' WHERE bucket = $1`, [`user:${owner.id}`]);
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: newEmail('next-day'), role: 'viewer' })).status).toBe(201);
	});

	it('caps a project for all its owners together', async () => {
		const owner = await signUp('CapA');
		const coOwner = await signUp('CapB');
		const pid = await projectOf(owner);
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: coOwner.email, role: 'owner' })).status).toBe(201);
		await fill(`project:${pid}`, INVITE_CAP.perTarget);
		expect((await coOwner.call('POST', `/projects/${pid}/members`, { email: newEmail('co'), role: 'viewer' })).status).toBe(429);
		// Positive control: the co-owner's own day isn't used up, so another project of theirs still works.
		const theirs = await projectOf(coOwner, 'Theirs');
		expect((await coOwner.call('POST', `/projects/${theirs}/members`, { email: newEmail('co2'), role: 'viewer' })).status).toBe(201);
	});

	it('counts a bulk farmer add per address, a dry run too, and refuses one that would pass the cap', async () => {
		const owner = await signUp('CapBulk');
		const pid = await projectOf(owner);
		const out = node('Outlet', null);
		const farm = node('Hoek', out.id);
		expect((await owner.call('PUT', `/projects/${pid}/model`, { nodes: [out, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const rows = [newEmail('b1'), newEmail('b2'), newEmail('b3')].map((email) => ({ email, farm: 'Hoek' }));
		// The same address twice is one address.
		const preview = await owner.call('POST', `/projects/${pid}/farmers/bulk`, { rows: [...rows, rows[0]], dryRun: true });
		expect(preview.status, JSON.stringify(preview.body)).toBe(200);
		expect(await bucket(`user:${owner.id}`)).toBe(3);
		await fill(`user:${owner.id}`, INVITE_CAP.perUser - 2);
		expect((await owner.call('POST', `/projects/${pid}/farmers/bulk`, { rows })).status).toBe(429);
		expect(await bucket(`user:${owner.id}`)).toBe(INVITE_CAP.perUser - 2);
		expect((await owner.call('POST', `/projects/${pid}/farmers/bulk`, { rows: rows.slice(0, 2) })).status).toBe(200);
		expect((await owner.call('POST', `/projects/${pid}/farmers`, { email: newEmail('one-more'), nodeIds: [farm.id] })).status).toBe(429);
	});

	it('lets only a project’s owner or a team’s admin count against it', async () => {
		const owner = await signUp('CapGate');
		const editor = await signUp('CapGateEditor');
		const pid = await projectOf(owner);
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		const attempt = (userId: string, kind: string, target: string) =>
			withUser(userId, (db) => db.query(`SELECT app_invite_attempt($1, $2, 1, 300, 300, '24 hours') AS wait`, [kind, target]));
		await expect(attempt(editor.id, 'project', pid)).rejects.toMatchObject({ code: '42501' });
		await expect(attempt(editor.id, 'team', pid)).rejects.toMatchObject({ code: '42501' });
		expect((await attempt(owner.id, 'project', pid)).rows[0].wait).toBe(0);
		// Nobody reads or writes the table directly.
		expect((await withUser(owner.id, (db) => db.query('SELECT * FROM invite_throttle'))).rows).toEqual([]);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE invite_throttle SET attempts = 0`))).resolves.toMatchObject({ rowCount: 0 });
	});
});
