// Inviting people by email (004_email.sql, invites.ts), and an existing
// account accepting or declining (109_invite_accept.sql, issue #136).
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

	it('verifying the address accepts the invite and clears it; adding the member again is a 409', async () => {
		const owner = await signUp('Direct');
		const pid = await projectOf(owner);
		const email = newEmail('direct');
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		const invitee = await register(email);
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
		// Verifying already accepted the invite…
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites).toEqual([]);
		expect((await invitee.call('GET', `/projects/${pid}`)).body.project.role).toBe('viewer');
		// …and someone on the members list the owner reads is a 409, not another invite.
		expect((await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' })).status).toBe(409);
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
describe('an existing account is invited and must accept (109_invite_accept, issue #136)', () => {
	type Caller = Awaited<ReturnType<typeof signUp>>;
	/** A verified account that doesn't accept on its own (helpers.ts signUp). */
	const holder = (name: string) => signUp(name, { acceptInvites: false });
	const events = (pid: string, kind: string) =>
		asOwner('SELECT actor_user_id, actor_label, subject FROM audit_event WHERE project_id = $1 AND kind = $2 ORDER BY created_at', [pid, kind]) as Promise<
			{ actor_user_id: string | null; actor_label: string; subject: Record<string, unknown> }[]
		>;
	const mine = async (u: Caller) => (await u.call('GET', '/me/invites')).body.invites as { id: string; kind: string; targetId: string; name: string; role: string; invitedBy: string; farms: string[] }[];

	it('answers the same for a verified account as for an address with none, and shows the owner no name', async () => {
		const owner = await signUp('SameOwner');
		const known = await holder('Knownperson');
		const pid = await projectOf(owner);
		const unknown = newEmail('unknown');
		const a = await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'editor' });
		const b = await owner.call('POST', `/projects/${pid}/members`, { email: unknown, role: 'editor' });
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);
		const shape = (r: { body: { invite: Record<string, unknown> } & Record<string, unknown> }) => ({ keys: Object.keys(r.body).sort(), invite: Object.keys(r.body.invite).sort() });
		expect(shape(a)).toEqual(shape(b));
		expect(a.body).toMatchObject({ invited: true, invite: { email: known.email, role: 'editor', invitedBy: 'SameOwner', expired: false } });
		expect(JSON.stringify(a.body)).not.toContain('Knownperson');
		// Not a member yet: the members list is the owner alone, both addresses are pending invites.
		expect((await owner.call('GET', `/projects/${pid}/members`)).body.members.map((m: { userId: string }) => m.userId)).toEqual([owner.id]);
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites.map((i: { email: string }) => i.email).sort()).toEqual([known.email, unknown].sort());
		expect((await known.call('GET', `/projects/${pid}`)).status).toBe(404);
		// Their email points at the invitations page, with no token in it.
		const mail = lastMailTo(known.email)!;
		expect(mail.text).toContain('/account/invitations');
		expect(mail.text).not.toMatch(/[?&](token|invite)=/);
		expect(mail.text).toContain('accept or decline');
		// The history says only that an invite went out, as for the unknown address.
		expect((await events(pid, 'invite.sent')).map((e) => Object.keys(e.subject).sort())).toEqual([
			['email', 'inviteId', 'role'],
			['email', 'inviteId', 'role']
		]);
		expect(await events(pid, 'member.added')).toEqual([]);
	});

	it('lists the invite for its holder, who joins on accepting, recorded as joining by invite', async () => {
		const owner = await signUp('AccOwner');
		const known = await holder('Accepter');
		const pid = await projectOf(owner, 'Kloof');
		const invite = (await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'editor' })).body.invite;
		expect(await mine(known)).toEqual([
			expect.objectContaining({ id: invite.id, kind: 'project', targetId: pid, name: 'Kloof', role: 'editor', invitedBy: 'AccOwner', farms: [] })
		]);
		const ok = await known.call('POST', `/me/invites/${invite.id}/accept`);
		expect(ok.status).toBe(200);
		expect(ok.body).toEqual({ joined: { kind: 'project', id: pid } });
		expect((await known.call('GET', `/projects/${pid}`)).body.project.role).toBe('editor');
		expect(await mine(known)).toEqual([]);
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites).toEqual([]);
		expect(await events(pid, 'member.added')).toEqual([
			{ actor_user_id: known.id, actor_label: 'Accepter', subject: { userId: known.id, displayName: 'Accepter', role: 'editor', via: 'invite' } }
		]);
		// A second accept finds nothing.
		expect((await known.call('POST', `/me/invites/${invite.id}/accept`)).status).toBe(404);
	});

	it('declining deletes the invite, records it without the holder’s name, and joins nothing', async () => {
		const owner = await signUp('DecOwner');
		const known = await holder('Decliner');
		const pid = await projectOf(owner);
		const invite = (await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'viewer' })).body.invite;
		expect((await known.call('DELETE', `/me/invites/${invite.id}`)).status).toBe(204);
		expect(await mine(known)).toEqual([]);
		expect((await owner.call('GET', `/projects/${pid}/invites`)).body.invites).toEqual([]);
		expect((await known.call('GET', `/projects/${pid}`)).status).toBe(404);
		const at = known.email.lastIndexOf('@');
		expect(await events(pid, 'invite.declined')).toEqual([
			{ actor_user_id: null, actor_label: '', subject: { inviteId: invite.id, email: `${known.email[0]}•••${known.email.slice(at)}`, role: 'viewer' } }
		]);
		expect((await known.call('DELETE', `/me/invites/${invite.id}`)).status).toBe(404);
		// The owner may invite them again.
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'viewer' })).status).toBe(201);
	});

	// app_accept_invite locks the invite (FOR UPDATE) before joining, and a decline's DELETE waits on that
	// lock, so the holder's parallel requests settle to exactly one outcome.
	it('accepting the same invite several times at once joins once, and the rest find nothing', async () => {
		const owner = await signUp('RaceOwner');
		const known = await holder('Racer');
		const pid = await projectOf(owner);
		const invite = (await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'editor' })).body.invite;
		const statuses = (await Promise.all(Array.from({ length: 4 }, () => known.call('POST', `/me/invites/${invite.id}/accept`)))).map((r) => r.status);
		expect(statuses.sort()).toEqual([200, 404, 404, 404]);
		expect(await events(pid, 'member.added')).toHaveLength(1);
		expect((await known.call('GET', `/projects/${pid}`)).body.project.role).toBe('editor');
	});

	it('an accept racing a decline of the same invite: exactly one wins, and the log says which', async () => {
		for (let i = 0; i < 3; i++) {
			const owner = await signUp('DuelOwner');
			const known = await holder('Dueller');
			const pid = await projectOf(owner);
			const invite = (await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'viewer' })).body.invite;
			const [acc, dec] = await Promise.all([known.call('POST', `/me/invites/${invite.id}/accept`), known.call('DELETE', `/me/invites/${invite.id}`)]);
			const joined = acc.status === 200;
			// One wins, the other finds nothing: never both, never neither.
			expect([acc.status, dec.status].sort()).toEqual(joined ? [200, 404] : [204, 404]);
			expect(await events(pid, 'member.added')).toHaveLength(joined ? 1 : 0);
			expect(await events(pid, 'invite.declined')).toHaveLength(joined ? 0 : 1);
			expect((await known.call('GET', `/projects/${pid}`)).status).toBe(joined ? 200 : 404);
			expect(await mine(known)).toEqual([]);
		}
	});

	it('only the invited address sees, accepts or declines an invite (positive control: its holder sees it)', async () => {
		const owner = await signUp('OnlyOwner');
		const known = await holder('Onlyknown');
		const stranger = await holder('Onlystranger');
		const pid = await projectOf(owner);
		const invite = (await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'owner' })).body.invite;
		expect((await mine(known)).map((i) => i.id)).toEqual([invite.id]);
		expect(await mine(stranger)).toEqual([]);
		// The owner who sent it doesn't accept it either (they're not the address).
		for (const u of [stranger, owner]) {
			expect((await u.call('POST', `/me/invites/${invite.id}/accept`)).status).toBe(404);
			expect((await u.call('DELETE', `/me/invites/${invite.id}`)).status).toBe(404);
		}
		expect((await stranger.call('GET', `/projects/${pid}`)).status).toBe(404);
		expect((await stranger.call('POST', '/me/invites/not-a-uuid/accept')).status).toBe(404);
		expect((await stranger.call('DELETE', '/me/invites/not-a-uuid')).status).toBe(404);
		// Still there for its holder.
		expect((await mine(known)).map((i) => i.id)).toEqual([invite.id]);
		// RLS: as water_app, the invite table stays owner-only for the invitee too.
		const seen = await withUser(known.id, async (db) => (await db.query('SELECT id FROM invite WHERE id = $1', [invite.id])).rows);
		expect(seen).toEqual([]);
	});

	it('an expired invite is neither listed nor accepted', async () => {
		const owner = await signUp('ExpOwner');
		const known = await holder('Expired');
		const pid = await projectOf(owner);
		const invite = (await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'viewer' })).body.invite;
		expect((await mine(known)).map((i) => i.id)).toEqual([invite.id]);
		await asOwner(`UPDATE invite SET expires_at = now() - interval '1 minute' WHERE id = $1`, [invite.id]);
		expect(await mine(known)).toEqual([]);
		expect((await known.call('POST', `/me/invites/${invite.id}/accept`)).status).toBe(404);
		expect((await known.call('DELETE', `/me/invites/${invite.id}`)).status).toBe(404);
		expect((await known.call('GET', `/projects/${pid}`)).status).toBe(404);
	});

	it('a password reset on a verified account accepts nothing: its invites wait for the holder', async () => {
		const owner = await signUp('ResetOwner');
		const known = await holder('Resetter');
		const pid = await projectOf(owner);
		await owner.call('POST', `/projects/${pid}/members`, { email: known.email, role: 'viewer' });
		await anon('POST', '/auth/forgot-password', { email: known.email });
		expect((await anon('POST', '/auth/reset-password', { token: tokenIn(lastMailTo(known.email)), password: 'another password' })).status).toBe(204);
		const login = await anon('POST', '/auth/login', { email: known.email, password: 'another password' });
		const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
		expect((await anon('GET', `/projects/${pid}`, undefined, cookie)).status).toBe(404);
		expect((await anon('GET', '/me/invites', undefined, cookie)).body.invites).toHaveLength(1);
	});

	it('an unconfirmed account sees no invitations to accept: confirming its address accepts them', async () => {
		const owner = await signUp('UnconfOwner');
		const pid = await projectOf(owner);
		const email = newEmail('unconf');
		const invitee = await register(email);
		await owner.call('POST', `/projects/${pid}/members`, { email, role: 'viewer' });
		const list = await invitee.call('GET', '/me/invites');
		expect(list.status).toBe(200);
		expect(list.body.invites).toEqual([]);
	});

	it('a team admin’s add is an invite too; accepting joins the team and its projects', async () => {
		const admin = await signUp('TeamAccAdmin');
		const known = await holder('Teamjoiner');
		const teamId = (await admin.call('POST', '/teams', { name: 'Joiners' })).body.team.id as string;
		const pid = (await admin.call('POST', '/projects', { name: 'Team catchment', teamId })).body.project.id as string;
		const a = await admin.call('POST', `/teams/${teamId}/members`, { email: known.email, role: 'member' });
		const b = await admin.call('POST', `/teams/${teamId}/members`, { email: newEmail('teamnobody'), role: 'member' });
		expect(a.status).toBe(201);
		expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
		expect(a.body.invited).toBe(true);
		expect(JSON.stringify(a.body)).not.toContain('Teamjoiner');
		expect((await admin.call('GET', `/teams/${teamId}`)).body.members).toHaveLength(1);
		expect((await known.call('GET', `/projects/${pid}`)).status).toBe(404);
		const [inv] = await mine(known);
		expect(inv).toMatchObject({ kind: 'team', targetId: teamId, name: 'Joiners', role: 'member' });
		expect((await known.call('POST', `/me/invites/${inv!.id}/accept`)).body).toEqual({ joined: { kind: 'team', id: teamId } });
		expect((await known.call('GET', `/projects/${pid}`)).body.project.role).toBe('editor');
		// Already on the list now: a 409.
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: known.email, role: 'member' })).status).toBe(409);
	});

	it('a farmer with an account is invited with their farms, linked when they accept', async () => {
		const owner = await signUp('FarmAccOwner');
		const farmer = await holder('Farmholder');
		const pid = await projectOf(owner);
		const gauge = node('Gauge', null);
		const farm = node('Rooikloof', gauge.id);
		expect((await owner.call('PUT', `/projects/${pid}/model`, { nodes: [gauge, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const a = await owner.call('POST', `/projects/${pid}/farmers`, { email: farmer.email, nodeIds: [farm.id] });
		const b = await owner.call('POST', `/projects/${pid}/farmers`, { email: newEmail('farmnobody'), nodeIds: [farm.id] });
		expect(a.status).toBe(201);
		expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
		expect(Object.keys(a.body.invite).sort()).toEqual(Object.keys(b.body.invite).sort());
		expect(a.body.invite).toMatchObject({ status: 'invited', email: farmer.email, nodeIds: [farm.id] });
		// The farmers list shows an invite, not a farmer with a name.
		const listed = (await owner.call('GET', `/projects/${pid}/farmers`)).body.farmers as { status: string; email: string }[];
		expect(listed.filter((f) => f.email === farmer.email).map((f) => f.status)).toEqual(['invited']);
		expect(JSON.stringify(listed)).not.toContain('Farmholder');
		// Bulk: a verified account is 'invited' like any other address.
		const bulk = await owner.call('POST', `/projects/${pid}/farmers/bulk`, { rows: [{ email: farmer.email, farm: 'Rooikloof' }], dryRun: true });
		expect(bulk.body.results.map((r: { status: string }) => r.status)).toEqual(['invited']);
		const [inv] = await mine(farmer);
		expect(inv).toMatchObject({ kind: 'project', role: 'farmer', farms: ['Rooikloof'] });
		expect((await farmer.call('POST', `/me/invites/${inv!.id}/accept`)).status).toBe(200);
		const now = (await owner.call('GET', `/projects/${pid}/farmers`)).body.farmers as { status: string; userId?: string; nodeIds: string[] }[];
		expect(now.find((f) => f.userId === farmer.id)).toMatchObject({ status: 'active', nodeIds: [farm.id] });
	});
});

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

// docs/followups.md "An invite outlives its sender's right to send it":
// invite RLS checks the sender only when the invite is written, so an owner
// removed or demoted afterwards used to leave invites that still joined
// people, as owner even. Now every path that lists, describes or accepts an
// invite takes it only while its sender still owns the project (directly or
// as the team's admin) or administers the team (155_invite_sender_role.sql).
// Each case has its positive control: a still-entitled sender's invite works.
describe('an invite is good only while its sender may still send it (155_invite_sender_role)', () => {
	type Caller = Awaited<ReturnType<typeof signUp>>;
	const holder = (name: string) => signUp(name, { acceptInvites: false });
	const mine = async (u: Caller) => ((await u.call('GET', '/me/invites')).body.invites as { id: string; targetId: string }[]).map((i) => i.id);
	const roleIn = async (u: { call: Caller['call'] }, pid: string) => {
		const r = await u.call('GET', `/projects/${pid}`);
		return r.status === 200 ? (r.body.project.role as string) : r.status;
	};
	const ownersList = async (owner: Caller, pid: string) =>
		(await owner.call('GET', `/projects/${pid}/invites`)).body.invites as { id: string; email: string; senderLapsed: boolean }[];

	/** A project owned by `a`, with `b` as a second owner. */
	async function twoOwners(tag: string) {
		const a = await signUp(`${tag}A`);
		const b = await signUp(`${tag}B`);
		const pid = await projectOf(a);
		await a.call('POST', `/projects/${pid}/members`, { email: b.email, role: 'owner' });
		expect(await roleIn(b, pid)).toBe('owner');
		return { a, b, pid };
	}
	const demote = (a: Caller, pid: string, who: Caller) => a.call('PATCH', `/projects/${pid}/members/${who.id}`, { role: 'editor' });

	it('invitations page: a demoted sender’s invite is neither listed nor accepted; a still-owning sender’s is (positive control)', async () => {
		const { a, b, pid } = await twoOwners('PageDem');
		const k1 = await holder('PageDemK1');
		const k2 = await holder('PageDemK2');
		const fromB = (await b.call('POST', `/projects/${pid}/members`, { email: k1.email, role: 'owner' })).body.invite;
		const fromA = (await a.call('POST', `/projects/${pid}/members`, { email: k2.email, role: 'owner' })).body.invite;
		expect(await mine(k1)).toEqual([fromB.id]);
		expect((await demote(a, pid, b)).status).toBe(200);

		expect(await mine(k1)).toEqual([]);
		expect((await k1.call('POST', `/me/invites/${fromB.id}/accept`)).status).toBe(404);
		expect(await roleIn(k1, pid)).toBe(404);
		// The remaining owner still sees it, flagged, to re-send or revoke.
		expect((await ownersList(a, pid)).map((i) => [i.id, i.senderLapsed]).sort()).toEqual(
			[
				[fromB.id, true],
				[fromA.id, false]
			].sort()
		);
		// Positive control: the invite from the owner who still owns the project joins.
		expect(await mine(k2)).toEqual([fromA.id]);
		expect((await k2.call('POST', `/me/invites/${fromA.id}/accept`)).status).toBe(200);
		expect(await roleIn(k2, pid)).toBe('owner');

		// Re-sent by a current owner, it is theirs and good again.
		await asOwner(`UPDATE invite SET last_sent_at = now() - interval '1 hour' WHERE id = $1`, [fromB.id]);
		const resent = await a.call('POST', `/projects/${pid}/members`, { email: k1.email, role: 'editor' });
		expect(resent.body.invite).toMatchObject({ id: fromB.id, invitedBy: 'PageDemA', senderLapsed: false });
		expect(await mine(k1)).toEqual([fromB.id]);
		expect((await k1.call('POST', `/me/invites/${fromB.id}/accept`)).status).toBe(200);
		expect(await roleIn(k1, pid)).toBe('editor');
	});

	it('invitations page: a sender who left the project leaves invites nobody can accept', async () => {
		const { a, b, pid } = await twoOwners('PageLeft');
		const k = await holder('PageLeftK');
		const inv = (await b.call('POST', `/projects/${pid}/members`, { email: k.email, role: 'owner' })).body.invite;
		expect((await b.call('DELETE', `/projects/${pid}/members/${b.id}`)).status).toBe(204);
		expect(await mine(k)).toEqual([]);
		expect((await k.call('POST', `/me/invites/${inv.id}/accept`)).status).toBe(404);
		expect(await roleIn(k, pid)).toBe(404);
		expect((await ownersList(a, pid)).map((i) => i.senderLapsed)).toEqual([true]);
		// The invitee may still decline it.
		expect((await k.call('DELETE', `/me/invites/${inv.id}`)).status).toBe(204);
		expect(await ownersList(a, pid)).toEqual([]);
	});

	it('sign-up through the link: a lapsed invite’s link is invalid and joins nothing; a live one joins (positive control)', async () => {
		const { a, b, pid } = await twoOwners('LinkDem');
		const lapsedEmail = newEmail('linkdem');
		const liveEmail = newEmail('linklive');
		await b.call('POST', `/projects/${pid}/members`, { email: lapsedEmail, role: 'owner' });
		const lapsedToken = tokenIn(lastMailTo(lapsedEmail));
		await a.call('POST', `/projects/${pid}/members`, { email: liveEmail, role: 'viewer' });
		const liveToken = tokenIn(lastMailTo(liveEmail));
		expect((await anon('POST', '/auth/invite-info', { token: lapsedToken })).status).toBe(200);
		expect((await demote(a, pid, b)).status).toBe(200);

		expect((await anon('POST', '/auth/invite-info', { token: lapsedToken })).status).toBe(404);
		// The link proves nothing now: the account waits for its confirmation link, and joins nothing.
		const late = await register(lapsedEmail, lapsedToken);
		expect(late.user.emailVerified).toBe(false);
		expect(await roleIn(late, pid)).toBe(404);
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(lapsedEmail)) })).status).toBe(200);
		expect(await roleIn(late, pid)).toBe(404);

		expect((await anon('POST', '/auth/invite-info', { token: liveToken })).status).toBe(200);
		const ok = await register(liveEmail, liveToken);
		expect(ok.user.emailVerified).toBe(true);
		expect(await roleIn(ok, pid)).toBe('viewer');
		// The lapsed one is still on the owner's list; the accepted one is gone.
		expect((await ownersList(a, pid)).map((i) => [i.email, i.senderLapsed])).toEqual([[lapsedEmail, true]]);
	});

	it('confirmation link: confirming the address accepts only the invites whose sender may still send them', async () => {
		const { a, b, pid } = await twoOwners('ConfDem');
		const other = await projectOf(a, 'Other');
		const email = newEmail('confdem');
		const invitee = await register(email);
		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [invitee.user.id]);
		await b.call('POST', `/projects/${pid}/members`, { email, role: 'owner' });
		await a.call('POST', `/projects/${other}/members`, { email, role: 'editor' });
		expect((await demote(a, pid, b)).status).toBe(200);

		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
		expect(await roleIn(invitee, pid)).toBe(404);
		// Positive control: the other project's owner's invite joined.
		expect(await roleIn(invitee, other)).toBe('editor');
		expect((await ownersList(a, pid)).map((i) => i.senderLapsed)).toEqual([true]);
	});

	it('a team admin’s project invite lapses when they stop administering the team (positive control: still admin, it joins)', async () => {
		const x = await signUp('TeamPathX');
		const y = await signUp('TeamPathY');
		const teamId = (await x.call('POST', '/teams', { name: 'Path' })).body.team.id as string;
		await x.call('POST', `/teams/${teamId}/members`, { email: y.email, role: 'admin' });
		const pid = (await x.call('POST', '/projects', { name: 'Team-owned', teamId })).body.project.id as string;
		const k1 = await holder('TeamPathK1');
		const k2 = await holder('TeamPathK2');
		const fromY = (await y.call('POST', `/projects/${pid}/members`, { email: k1.email, role: 'owner' })).body.invite;
		const fromX = (await x.call('POST', `/projects/${pid}/members`, { email: k2.email, role: 'owner' })).body.invite;
		expect((await x.call('PATCH', `/teams/${teamId}/members/${y.id}`, { role: 'member' })).status).toBe(200);

		expect(await mine(k1)).toEqual([]);
		expect((await k1.call('POST', `/me/invites/${fromY.id}/accept`)).status).toBe(404);
		expect(await roleIn(k1, pid)).toBe(404);
		expect(await mine(k2)).toEqual([fromX.id]);
		expect((await k2.call('POST', `/me/invites/${fromX.id}/accept`)).status).toBe(200);
		expect(await roleIn(k2, pid)).toBe('owner');
	});

	it('a team invite lapses with its sender’s admin role (positive control: a still-admin’s joins)', async () => {
		const x = await signUp('TeamInvX');
		const y = await signUp('TeamInvY');
		const teamId = (await x.call('POST', '/teams', { name: 'Admins' })).body.team.id as string;
		await x.call('POST', `/teams/${teamId}/members`, { email: y.email, role: 'admin' });
		const k1 = await holder('TeamInvK1');
		const k2 = await holder('TeamInvK2');
		const fromY = (await y.call('POST', `/teams/${teamId}/members`, { email: k1.email, role: 'admin' })).body.invite;
		const fromX = (await x.call('POST', `/teams/${teamId}/members`, { email: k2.email, role: 'admin' })).body.invite;
		expect((await x.call('PATCH', `/teams/${teamId}/members/${y.id}`, { role: 'viewer' })).status).toBe(200);

		expect(await mine(k1)).toEqual([]);
		expect((await k1.call('POST', `/me/invites/${fromY.id}/accept`)).status).toBe(404);
		expect((await k1.call('GET', `/teams/${teamId}`)).status).toBe(404);
		const listed = (await x.call('GET', `/teams/${teamId}/invites`)).body.invites as { id: string; senderLapsed: boolean }[];
		expect(listed.map((i) => [i.id, i.senderLapsed]).sort()).toEqual(
			[
				[fromY.id, true],
				[fromX.id, false]
			].sort()
		);
		expect((await k2.call('POST', `/me/invites/${fromX.id}/accept`)).status).toBe(200);
		expect((await k2.call('GET', `/teams/${teamId}`)).body.team.role).toBe('admin');
	});

	it('a deleted sender’s invites go with their account', async () => {
		const { a, b, pid } = await twoOwners('DelSender');
		const k = await holder('DelSenderK');
		await b.call('POST', `/projects/${pid}/members`, { email: k.email, role: 'owner' });
		expect(await mine(k)).toHaveLength(1);
		await asOwner('DELETE FROM app_user WHERE id = $1', [b.id]);
		expect(await mine(k)).toEqual([]);
		expect(await ownersList(a, pid)).toEqual([]);
	});

	it('app_invite_sender_lapsed answers only an owner of the invite’s project (positive control: the owner gets an answer)', async () => {
		const { a, b, pid } = await twoOwners('LapsedFn');
		const editor = await signUp('LapsedFnEd');
		await a.call('POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' });
		const inv = (await b.call('POST', `/projects/${pid}/members`, { email: newEmail('lapsedfn'), role: 'viewer' })).body.invite;
		await demote(a, pid, b);
		const ask = (uid: string) =>
			withUser(uid, async (db) => (await db.query<{ v: boolean | null }>('SELECT app_invite_sender_lapsed($1) AS v', [inv.id])).rows[0]!.v);
		expect(await ask(a.id)).toBe(true);
		expect(await ask(editor.id)).toBeNull();
		expect(await ask(b.id)).toBeNull();
		// The predicate itself is not water_app's to call.
		await expect(
			withUser(editor.id, (db) => db.query('SELECT app_invite_sender_holds($1, $2, NULL)', [a.id, pid]))
		).rejects.toMatchObject({ code: '42501' });
	});
});
