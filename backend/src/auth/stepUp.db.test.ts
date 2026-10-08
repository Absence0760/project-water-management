// Two-step sign-in, opt-in per project and team (operator decision,
// 2026-10-08; auth/stepUp.ts, 204_mfa_opt_in; docs/security.md § Two-step
// sign-in). With a project's and its team's setting off (the default), an
// owner's and a team admin's actions, and a run's sign-off, need no second
// factor; with either on, they do. The actions that reach people outside the
// team (publishing to farmers, deciding an application, endorsing a
// baseline, recording a registration check, signing, issuing and withdrawing
// an evidence pack) need one whatever the settings. The other DB tests run
// with the requirement off (MFA_REQUIRED=false, __tests__/setup.ts); this
// file turns it on after its fixtures are made. Each refusal has a positive
// control: the same action, signed in with a code (or with the setting off),
// gets through.
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actForAuthority, anon, asOwner, DECISION, lastMailTo, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { SESSION_COOKIE } from './session.js';
import { base32Decode, totp } from './totp.js';

type User = Awaited<ReturnType<typeof signUp>>;

function code(secret: string): string {
	vi.setSystemTime(Date.now() + 30_000);
	return totp(base32Decode(secret)!, Date.now());
}
const sessionOf = (h: Headers) => `${SESSION_COOKIE}=${h.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!.split('=')[1]}`;

/** Each enrolled account's authenticator secret, for later codes. */
const secrets = new Map<string, string>();

/** Add an authenticator: the two-step session the confirm gave. */
async function enrol(u: User): Promise<string> {
	const { secret } = (await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).body;
	secrets.set(u.id, secret);
	const r = await anon('POST', '/auth/mfa/totp/confirm', { code: code(secret) }, u.cookie);
	expect(r.status).toBe(200);
	const cookie = sessionOf(r.headers);
	expect(decodeJwt(cookie.split('=')[1]!).amr).toEqual(['pwd', 'otp']);
	// When the code was given (licensing positions item 9): a sign-off needs one from the last 10 minutes.
	expect(decodeJwt(cookie.split('=')[1]!).otp_at).toBe(Date.now());
	return cookie;
}

/** A project of `u`'s with a stored run to sign, and `editor` an editor on it. */
async function projectWithRun(u: User, name: string, editor: User): Promise<{ projectId: string; runId: string }> {
	const projectId = (await u.call('POST', '/projects', { name })).body.project.id;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const runId = (await u.call('POST', `/projects/${projectId}/runs`, { label: 'to sign' })).body.run.id;
	expect((await u.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	return { projectId, runId };
}

let owner: User;
let enrolledOwner: User;
let enrolledOwnerTwoStep: string;
let editor: User;
let viewer: User;
let outsider: User;
let direct: User;
let authority: User;
/** owner's, setting off. */
let projectId: string;
/** owner's, setting on. */
let requiredId: string;
/** owner's team with the setting on, its project (the project's own setting off), and a team with it off. */
let requiredTeamId: string;
let teamProjectId: string;
let openTeamId: string;
let linkId: string;
let requiredLinkId: string;
/** enrolledOwner's: setting on (turned on in beforeAll with a two-step session), and off. Each has a run, editor an editor. */
let ownProjectId: string;
let ownRunId: string;
let offProjectId: string;
let offRunId: string;
const uuid = () => crypto.randomUUID();

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
	[owner, enrolledOwner, editor, viewer, outsider, direct, authority] = (await Promise.all(
		['SuOwner', 'SuEnrolled', 'SuEditor', 'SuViewer', 'SuOutsider', 'SuDirect', 'SuAuthority'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Step-up off' })).body.project.id;
	requiredId = (await owner.call('POST', '/projects', { name: 'Step-up on' })).body.project.id;
	for (const pid of [projectId, requiredId]) {
		for (const [u, role] of [
			[editor, 'editor'],
			[viewer, 'viewer']
		] as const) {
			expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
		}
	}
	linkId = (await owner.call('POST', `/projects/${projectId}/share-links`, { label: 'WUA', expiresInDays: 7 })).body.link.id;
	requiredLinkId = (await owner.call('POST', `/projects/${requiredId}/share-links`, { label: 'WUA', expiresInDays: 7 })).body.link.id;
	// An owner turns it on (the requirement is off here, as on the e2e server, so no factor is asked for).
	expect((await owner.call('PATCH', `/projects/${requiredId}`, { requireMfa: true })).body.project).toMatchObject({ requireMfa: true, mfaRequired: true });

	requiredTeamId = (await owner.call('POST', '/teams', { name: 'Step-up team' })).body.team.id;
	openTeamId = (await owner.call('POST', '/teams', { name: 'Open team' })).body.team.id;
	teamProjectId = (await owner.call('POST', '/projects', { name: 'Step-up team project', teamId: requiredTeamId })).body.project.id;
	// Someone shared the team project directly, as an owner, without being in the team: the team's setting holds them too.
	expect((await owner.call('POST', `/projects/${teamProjectId}/members`, { email: direct.email, role: 'owner' })).status).toBe(201);
	expect((await owner.call('PATCH', `/teams/${requiredTeamId}`, { requireMfa: true })).body.team).toMatchObject({ requireMfa: true });

	({ projectId: ownProjectId, runId: ownRunId } = await projectWithRun(enrolledOwner, 'Step-up enrolled', editor));
	({ projectId: offProjectId, runId: offRunId } = await projectWithRun(enrolledOwner, 'Step-up enrolled, off', editor));
	// Recording a decision and endorsing a baseline also need the authority mark (163): the positive control's owner has it.
	await actForAuthority(enrolledOwner, offProjectId, enrolledOwner.id);
	// A member acting for the authority on a project that doesn't require two-step sign-in (GET /auth/mfa).
	expect((await enrolledOwner.call('POST', `/projects/${offProjectId}/members`, { email: authority.email, role: 'editor' })).status).toBe(201);
	await actForAuthority(enrolledOwner, offProjectId, authority.id);
	enrolledOwnerTwoStep = await enrol(enrolledOwner);
	// From here on, as in production.
	vi.stubEnv('MFA_REQUIRED', 'true');
	// Positive control for turning it on: an owner signed in with a code.
	const on = await anon('PATCH', `/projects/${ownProjectId}`, { requireMfa: true }, enrolledOwnerTwoStep);
	expect(on.status, JSON.stringify(on.body)).toBe(200);
});
afterAll(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('the setting off (the default): an owner’s and a team admin’s actions need no second factor', () => {
	it('an owner without an authenticator makes an API key, revokes a share link and removes a member on a password', async () => {
		expect((await owner.call('POST', `/projects/${projectId}/api-keys`, { name: 'logger' })).status).toBe(201);
		expect((await owner.call('DELETE', `/projects/${projectId}/share-links/${linkId}`)).status).toBeLessThan(300);
		const leaver = await signUp('SuRemoved');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: leaver.email, role: 'viewer' })).status).toBe(201);
		expect((await owner.call('DELETE', `/projects/${projectId}/members/${leaver.id}`)).status).toBeLessThan(300);
	});

	it('a team admin without one adds a member to a team that doesn’t require it', async () => {
		expect((await owner.call('POST', `/teams/${openTeamId}/members`, { email: outsider.email, role: 'viewer' })).status).toBe(201);
	});

	it('the project says so: requireMfa and mfaRequired false', async () => {
		expect((await owner.call('GET', `/projects/${projectId}`)).body.project).toMatchObject({ requireMfa: false, mfaRequired: false });
	});
});

describe('the project’s setting on: an owner’s actions need two-step sign-in', () => {
	it('without an authenticator: 403 mfa_required, and nothing is made', async () => {
		const r = await owner.call('POST', `/projects/${requiredId}/api-keys`, { name: 'logger' });
		expect(r).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect(r.body.error).toMatch(/this project requires two-step sign-in/);
		expect((await owner.call('GET', `/projects/${requiredId}/api-keys`)).status).toBe(403);
	});

	it('the owner’s hand-checked actions too: removing a member, revoking a share link', async () => {
		expect(await owner.call('DELETE', `/projects/${requiredId}/members/${viewer.id}`)).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect(await owner.call('DELETE', `/projects/${requiredId}/share-links/${requiredLinkId}`)).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		// Leaving isn't stepped up: a viewer leaves on a password.
		const leaver = await signUp('SuLeaver');
		vi.stubEnv('MFA_REQUIRED', 'false');
		await owner.call('POST', `/projects/${requiredId}/members`, { email: leaver.email, role: 'viewer' });
		vi.stubEnv('MFA_REQUIRED', 'true');
		expect((await leaver.call('DELETE', `/projects/${requiredId}/members/${leaver.id}`)).status).toBeLessThan(300);
	});

	it('with one, but a session signed in before it (password only): 403 mfa_step_up', async () => {
		expect(await enrolledOwner.call('POST', `/projects/${ownProjectId}/api-keys`, { name: 'logger' })).toMatchObject({ status: 403, body: { code: 'mfa_step_up' } });
	});

	it('positive control: the same owner, signed in with a code, gets through', async () => {
		expect((await anon('POST', `/projects/${ownProjectId}/api-keys`, { name: 'logger' }, enrolledOwnerTwoStep)).status).toBe(201);
	});

	it('the role check comes first: an outsider still gets 404 and a viewer 403 for the role, learning nothing about the requirement', async () => {
		expect((await outsider.call('POST', `/projects/${requiredId}/api-keys`, { name: 'x' })).status).toBe(404);
		expect((await outsider.call('PATCH', `/projects/${requiredId}`, { requireMfa: false })).status).toBe(404);
		const v = await viewer.call('POST', `/projects/${requiredId}/api-keys`, { name: 'x' });
		expect(v.status).toBe(403);
		expect(v.body.code).toBeUndefined();
	});

	it('everything below owner is untouched: members read and editors work without a code', async () => {
		expect((await viewer.call('GET', `/projects/${requiredId}`)).body.project).toMatchObject({ requireMfa: true, mfaRequired: true });
		expect((await owner.call('GET', `/projects/${requiredId}`)).status).toBe(200);
		expect((await editor.call('PATCH', `/projects/${requiredId}`, { description: 'edited without a code' })).status).toBe(200);
	});

	it('the requirement off (MFA_REQUIRED=false, the switch the tests use; Lambda refuses it) lets a password-only owner through', async () => {
		vi.stubEnv('MFA_REQUIRED', 'false');
		try {
			expect((await owner.call('GET', `/projects/${requiredId}/api-keys`)).status).toBe(200);
		} finally {
			vi.stubEnv('MFA_REQUIRED', 'true');
		}
	});
});

describe('the team’s setting on: its admin’s actions, and an owner’s on its projects, need two-step sign-in', () => {
	it('adding a member to the team: 403 mfa_required', async () => {
		expect(await owner.call('POST', `/teams/${requiredTeamId}/members`, { email: outsider.email, role: 'viewer' })).toMatchObject({
			status: 403,
			body: { code: 'mfa_required' }
		});
	});

	it('an owner action on a team project whose own setting is off: 403, for a team admin and for an owner shared it directly', async () => {
		const project = (await owner.call('GET', `/projects/${teamProjectId}`)).body.project;
		expect(project).toMatchObject({ requireMfa: false, mfaRequired: true });
		expect(await owner.call('POST', `/projects/${teamProjectId}/api-keys`, { name: 'x' })).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		// Not in the team, so they can't read its row; the definer holds them to it anyway.
		expect((await direct.call('GET', `/projects/${teamProjectId}`)).body.project).toMatchObject({ mfaRequired: true });
		expect(await direct.call('POST', `/projects/${teamProjectId}/api-keys`, { name: 'x' })).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
	});

	it('positive control: an enrolled admin signed in with a code turns it on, then adds a member and makes a key on a team project', async () => {
		const team = (await anon('POST', '/teams', { name: 'Step-up team 2' }, enrolledOwnerTwoStep)).body.team.id;
		expect((await anon('PATCH', `/teams/${team}`, { requireMfa: true }, enrolledOwnerTwoStep)).body.team).toMatchObject({ requireMfa: true });
		expect((await anon('POST', `/teams/${team}/members`, { email: outsider.email, role: 'viewer' }, enrolledOwnerTwoStep)).status).toBe(201);
		const pid = (await anon('POST', '/projects', { name: 'In team 2', teamId: team }, enrolledOwnerTwoStep)).body.project.id;
		expect((await anon('POST', `/projects/${pid}/api-keys`, { name: 'x' }, enrolledOwnerTwoStep)).status).toBe(201);
		// The same admin on a password-only session: sign in again.
		expect(await enrolledOwner.call('POST', `/projects/${pid}/api-keys`, { name: 'y' })).toMatchObject({ status: 403, body: { code: 'mfa_step_up' } });
		// The change is in each team project's history.
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'team.mfa_requirement'`, [pid]);
		expect(events).toEqual([]); // the project joined after the change: nothing it held changed
		expect((await anon('PATCH', `/teams/${team}`, { requireMfa: false }, enrolledOwnerTwoStep)).status).toBe(200);
		const after = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'team.mfa_requirement'`, [pid]);
		expect(after.map((e) => e.subject)).toEqual([{ teamId: team, team: 'Step-up team 2', on: false }]);
	});
});

describe('the setting itself', () => {
	it('turning it on without a second factor is refused (403 mfa_required), so a project can’t lock everyone out', async () => {
		const r = await owner.call('PATCH', `/projects/${projectId}`, { requireMfa: true });
		expect(r).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect(r.body.error).toMatch(/to require two-step sign-in here, you need it yourself: set up an authenticator app/);
		expect((await owner.call('PATCH', `/teams/${openTeamId}`, { requireMfa: true })).body.code).toBe('mfa_required');
		expect((await owner.call('GET', `/projects/${projectId}`)).body.project.requireMfa).toBe(false);
	});

	it('with an authenticator on a password-only session: 403 mfa_step_up', async () => {
		expect((await enrolledOwner.call('PATCH', `/projects/${offProjectId}`, { requireMfa: true })).body.code).toBe('mfa_step_up');
	});

	it('turning it off is an owner action under the setting: refused without a factor, and the setting stays', async () => {
		expect(await owner.call('PATCH', `/projects/${requiredId}`, { requireMfa: false })).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect(await owner.call('PATCH', `/teams/${requiredTeamId}`, { requireMfa: false })).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect((await viewer.call('GET', `/projects/${requiredId}`)).body.project.requireMfa).toBe(true);
	});

	it('an editor may not change it: 403 for the role, and the column guard refuses it underneath', async () => {
		const r = await editor.call('PATCH', `/projects/${projectId}`, { requireMfa: true });
		expect(r.status).toBe(403);
		expect(r.body.code).toBeUndefined();
		await expect(withUser(editor.id, (db) => db.query('UPDATE project SET require_mfa = true WHERE id = $1', [projectId]))).rejects.toMatchObject({ code: '42501' });
	});

	it('a team member below admin may not change the team’s: 403 for the role; an outsider 404', async () => {
		const member = await signUp('SuTeamMember');
		vi.stubEnv('MFA_REQUIRED', 'false');
		expect((await owner.call('POST', `/teams/${openTeamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
		vi.stubEnv('MFA_REQUIRED', 'true');
		const r = await member.call('PATCH', `/teams/${openTeamId}`, { requireMfa: true });
		expect(r.status, JSON.stringify(r.body)).toBe(403);
		expect(r.body.code).toBeUndefined();
		expect((await direct.call('PATCH', `/teams/${openTeamId}`, { requireMfa: true })).status).toBe(404);
	});

	it('both changes are in the project’s history, and a save that changes nothing records nothing', async () => {
		// Turned on in beforeAll; now off again, then off once more.
		expect((await anon('PATCH', `/projects/${ownProjectId}`, { requireMfa: false }, enrolledOwnerTwoStep)).status).toBe(200);
		expect((await anon('PATCH', `/projects/${ownProjectId}`, { requireMfa: false }, enrolledOwnerTwoStep)).status).toBe(200);
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'project.mfa_requirement' ORDER BY id`, [ownProjectId]);
		expect(events.map((e) => e.subject)).toEqual([{ on: true }, { on: false }]);
		expect((await anon('PATCH', `/projects/${ownProjectId}`, { requireMfa: true }, enrolledOwnerTwoStep)).status).toBe(200);
	});

	it('changing it leaves updated_at alone (no input changed)', async () => {
		const before = (await anon('GET', `/projects/${ownProjectId}`, undefined, enrolledOwnerTwoStep)).body.project.updatedAt;
		expect((await anon('PATCH', `/projects/${ownProjectId}`, { requireMfa: false }, enrolledOwnerTwoStep)).status).toBe(200);
		expect((await anon('PATCH', `/projects/${ownProjectId}`, { requireMfa: true }, enrolledOwnerTwoStep)).status).toBe(200);
		expect((await anon('GET', `/projects/${ownProjectId}`, undefined, enrolledOwnerTwoStep)).body.project.updatedAt).toBe(before);
	});
});

// A well-formed sign-off body: the body is parsed before the role check, so a malformed one would answer 400.
const SIGNOFF = {
	fullName: 'Step Signer',
	registrationBody: 'sacnasp',
	registrationCategory: 'pr_sci_nat',
	registrationField: 'water_resources',
	registrationNo: '1',
	scope: 'step-up',
	confirmed: [],
	statementSha256: '0'.repeat(64)
};

describe('the actions that reach people outside the team need two-step sign-in whatever the setting', () => {
	// Each checked right after the role, before the request's own target is looked up, so a made-up id is enough.
	const actions = (pid: string, id: string): [string, string, unknown][] => [
		['POST', `/projects/${pid}/publication`, { runId: id }],
		['PATCH', `/projects/${pid}/publication/${id}`, { note: 'x' }],
		['POST', `/projects/${pid}/outlooks/${id}/publish`, { levelId: '0' }],
		['DELETE', `/projects/${pid}/outlook-publication`, undefined],
		['POST', `/projects/${pid}/scenarios/${id}/decide`, { ...DECISION, outcome: 'licence_refused' }],
		['POST', `/projects/${pid}/publication/${id}/endorse`, {}],
		['POST', `/projects/${pid}/packs/${id}/issue`, {}],
		['POST', `/projects/${pid}/packs/${id}/withdraw`, { reason: 'x' }],
		['POST', `/projects/${pid}/packs/${id}/signoffs`, SIGNOFF]
	];

	it.each(actions(':id', ':target').map(([m, p], i) => [`${m} ${p}`, i] as const))('%s: with the setting off, an editor without an authenticator gets 403 mfa_required', async (_label, i) => {
		const [method, path, body] = actions(projectId, uuid())[i]!;
		expect(await editor.call(method, path, body)).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
	});

	it('recording a signer’s registration check, with the setting off: an owner without an authenticator gets 403 mfa_required', async () => {
		const check = { registrationBody: 'sacnasp', registrationCategory: 'pr_sci_nat', registrationNo: '400999/20', registerName: 'Step Signer', outcome: 'registered', checkedByOrg: 'Step WUA', checkedAt: '2026-01-01' };
		expect(await owner.call('POST', `/projects/${projectId}/members/${viewer.id}/registration-checks`, check)).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		// Positive control: an owner signed in with a code gets past the check (to the route's own answer about the member).
		const r = await anon('POST', `/projects/${offProjectId}/members/${uuid()}/registration-checks`, check, enrolledOwnerTwoStep);
		expect(String(r.body?.code ?? '')).not.toMatch(/^mfa_/);
		expect(r.status).not.toBe(403);
	});

	it('positive control: signed in with a code, on a project with the setting off, each gets past the check to its own answer (a 404 for the made-up target)', async () => {
		for (const [method, path, body] of actions(offProjectId, uuid())) {
			const r = await anon(method, path, body, enrolledOwnerTwoStep);
			expect(String(r.body?.code ?? ''), `${method} ${path}`).not.toMatch(/^mfa_/);
			expect(r.status, `${method} ${path}`).not.toBe(403);
		}
	});
});

describe('signing a run follows the project’s setting', () => {
	const at = (pid: string, rid: string) => `/projects/${pid}/runs/${rid}/signoffs`;
	const signed = (statementSha256: string, confirmed: string[], fullName = 'Step Signer') => ({ ...SIGNOFF, fullName, confirmed, statementSha256 });

	it('the setting off: an editor without an authenticator may sign, and the sign-off is made', async () => {
		const read = await editor.call('GET', at(offProjectId, offRunId));
		expect(read.body.cannotSign).toBeNull();
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		const r = await editor.call('POST', at(offProjectId, offRunId), signed(read.body.statementSha256, confirmed, 'Editor Signer'));
		expect(r.status, JSON.stringify(r.body)).toBe(201);
	});

	it('the setting on, an editor without an authenticator: cannotSign says set one up, and the sign-off is refused 403 mfa_required', async () => {
		const read = await editor.call('GET', at(ownProjectId, ownRunId));
		expect(read.status).toBe(200);
		expect(read.body.cannotSign).toMatch(/two-step sign-in: set it up on your Account page/);
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		expect(await editor.call('POST', at(ownProjectId, ownRunId), signed(read.body.statementSha256, confirmed))).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect((await editor.call('GET', at(ownProjectId, ownRunId))).body.signoffs).toEqual([]);
	});

	it('the setting on, an enrolled signer on a password-only session: cannotSign says sign in again', async () => {
		expect((await enrolledOwner.call('GET', at(ownProjectId, ownRunId))).body.cannotSign).toMatch(/sign in again/);
	});

	it('codes by email count as the signer’s factor (206): cannotSign is null on the session the emailed code gave, and says sign in again on a password-only one', async () => {
		const signer = await signUp('SuEmailSigner');
		vi.stubEnv('MFA_REQUIRED', 'false');
		expect((await enrolledOwner.call('POST', `/projects/${ownProjectId}/members`, { email: signer.email, role: 'editor' })).status).toBe(201);
		vi.stubEnv('MFA_REQUIRED', 'true');
		// Without a factor yet (negative control): set one up.
		expect((await signer.call('GET', at(ownProjectId, ownRunId))).body.cannotSign).toMatch(/set it up on your Account page/);
		expect((await signer.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).status).toBe(202);
		const code = lastMailTo(signer.email)!.text.match(/^(\d{6})$/m)![1]!;
		const confirmed = await anon('POST', '/auth/mfa/email/confirm', { code }, signer.cookie);
		expect(confirmed.status).toBe(200);
		expect((await anon('GET', at(ownProjectId, ownRunId), undefined, sessionOf(confirmed.headers))).body.cannotSign).toBeNull();
		expect((await signer.call('GET', at(ownProjectId, ownRunId))).body.cannotSign).toMatch(/sign in again/);
	});

	it('positive control: the same signer, signed in with a code, may sign, and the sign-off is made', async () => {
		const read = await anon('GET', at(ownProjectId, ownRunId), undefined, enrolledOwnerTwoStep);
		expect(read.body.cannotSign).toBeNull();
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		const r = await anon('POST', at(ownProjectId, ownRunId), signed(read.body.statementSha256, confirmed), enrolledOwnerTwoStep);
		expect(r.status).toBe(201);
		expect(r.body.signoff.fullName).toBe('Step Signer');
	});
});

describe('a sign-off, issuing and withdrawing need a code from the last 10 minutes', () => {
	const at = (pid: string, rid: string) => `/projects/${pid}/runs/${rid}/signoffs`;
	const signed = (statementSha256: string, confirmed: string[], fullName = 'Fresh Signer') => ({ ...SIGNOFF, fullName, confirmed, statementSha256 });

	it('11 minutes after the code: 401 mfa_fresh_code for each, while an owner-only action still goes through', async () => {
		vi.setSystemTime(Date.now() + 11 * 60_000);
		const read = await anon('GET', at(ownProjectId, ownRunId), undefined, enrolledOwnerTwoStep);
		// The read doesn't say so: the client asks for a code when the action answers.
		expect(read.body.cannotSign).toBeNull();
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		expect(await anon('POST', at(ownProjectId, ownRunId), signed(read.body.statementSha256, confirmed), enrolledOwnerTwoStep)).toMatchObject({
			status: 401,
			body: { code: 'mfa_fresh_code' }
		});
		// The pack's need it on a project with the setting off too.
		for (const [method, path, body] of [
			['POST', `/projects/${offProjectId}/packs/${uuid()}/issue`, {}],
			['POST', `/projects/${offProjectId}/packs/${uuid()}/withdraw`, { reason: 'x' }],
			['POST', `/projects/${offProjectId}/packs/${uuid()}/signoffs`, SIGNOFF]
		] as const) {
			expect(await anon(method, path, body, enrolledOwnerTwoStep), path).toMatchObject({ status: 401, body: { code: 'mfa_fresh_code' } });
		}
		// Control: owner actions need two-step sign-in, not a fresh code.
		expect((await anon('POST', `/projects/${ownProjectId}/share-links`, { label: 'Fresh', expiresInDays: 7 }, enrolledOwnerTwoStep)).status).toBe(201);
	});

	it('the setting off: a run’s sign-off needs no fresh code', async () => {
		vi.setSystemTime(Date.now() + 11 * 60_000);
		const read = await anon('GET', at(offProjectId, offRunId), undefined, enrolledOwnerTwoStep);
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		const r = await anon('POST', at(offProjectId, offRunId), signed(read.body.statementSha256, confirmed, 'Stale Signer'), enrolledOwnerTwoStep);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
	});

	it('POST /auth/mfa/step-up: a wrong code is refused; a right one re-issues the session, and the sign-off is made', async () => {
		expect(await anon('POST', '/auth/mfa/step-up', { code: '000000' }, enrolledOwnerTwoStep)).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
		const r = await anon('POST', '/auth/mfa/step-up', { code: code(secrets.get(enrolledOwner.id)!) }, enrolledOwnerTwoStep);
		expect(r.status).toBe(200);
		const fresh = sessionOf(r.headers);
		expect(decodeJwt(fresh.split('=')[1]!)).toMatchObject({ amr: ['pwd', 'otp'], otp_at: Date.now() });
		const read = await anon('GET', at(ownProjectId, ownRunId), undefined, fresh);
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		const made = await anon('POST', at(ownProjectId, ownRunId), signed(read.body.statementSha256, confirmed), fresh);
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		// The old session still signs nothing.
		expect(await anon('POST', at(ownProjectId, ownRunId), signed(read.body.statementSha256, confirmed), enrolledOwnerTwoStep)).toMatchObject({ status: 401 });
	});

	it('steps up a password-only session too, and refuses an account without an authenticator (403 mfa_required)', async () => {
		const r = await anon('POST', '/auth/mfa/step-up', { code: code(secrets.get(enrolledOwner.id)!) }, enrolledOwner.cookie);
		expect(r.status).toBe(200);
		expect(decodeJwt(sessionOf(r.headers).split('=')[1]!).amr).toEqual(['pwd', 'otp']);
		expect(await editor.call('POST', '/auth/mfa/step-up', { code: '123456' })).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect(await anon('POST', '/auth/mfa/step-up', { code: '123456' })).toMatchObject({ status: 401 });
	});

	it('not while the requirement is off (MFA_REQUIRED=false)', async () => {
		vi.setSystemTime(Date.now() + 11 * 60_000);
		vi.stubEnv('MFA_REQUIRED', 'false');
		try {
			const r = await anon('POST', `/projects/${ownProjectId}/packs/${uuid()}/issue`, {}, enrolledOwnerTwoStep);
			expect(r.status).toBe(404);
		} finally {
			vi.stubEnv('MFA_REQUIRED', 'true');
		}
	});
});

describe('GET /auth/mfa says whether the person’s roles need it', () => {
	it('an owner of a project that requires it, an admin of a team that does, and a member acting for an authority: required', async () => {
		expect((await owner.call('GET', '/auth/mfa')).body).toMatchObject({ required: true, enrolled: false });
		expect((await direct.call('GET', '/auth/mfa')).body).toMatchObject({ required: true });
		expect((await authority.call('GET', '/auth/mfa')).body).toMatchObject({ required: true });
		expect((await anon('GET', '/auth/mfa', undefined, enrolledOwnerTwoStep)).body).toMatchObject({ required: true, enrolled: true, sessionVerified: true });
	});

	it('an owner whose projects and teams don’t require it, a viewer and an editor: not', async () => {
		const plain = await signUp('SuPlain');
		const pid = (await plain.call('POST', '/projects', { name: 'Plain' })).body.project.id;
		await plain.call('POST', '/teams', { name: 'Plain team' });
		expect((await plain.call('GET', '/auth/mfa')).body).toMatchObject({ required: false });
		expect((await viewer.call('GET', '/auth/mfa')).body).toMatchObject({ required: false });
		expect((await editor.call('GET', '/auth/mfa')).body).toMatchObject({ required: false });
		// Positive control: turning the project's setting on (with the kill switch off, so no factor is asked for) makes it required.
		vi.stubEnv('MFA_REQUIRED', 'false');
		expect((await plain.call('PATCH', `/projects/${pid}`, { requireMfa: true })).status).toBe(200);
		vi.stubEnv('MFA_REQUIRED', 'true');
		expect((await plain.call('GET', '/auth/mfa')).body).toMatchObject({ required: true });
	});

	it('not while the requirement is off (MFA_REQUIRED=false): the workspace’s banner and the Account page say what the routes do', async () => {
		vi.stubEnv('MFA_REQUIRED', 'false');
		try {
			expect((await owner.call('GET', '/auth/mfa')).body).toMatchObject({ required: false, enrolled: false });
		} finally {
			vi.stubEnv('MFA_REQUIRED', 'true');
		}
		expect((await owner.call('GET', '/auth/mfa')).body).toMatchObject({ required: true });
	});
});
