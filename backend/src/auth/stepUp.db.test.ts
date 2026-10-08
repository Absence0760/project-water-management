// The second-factor requirement for the roles that can do the most harm
// (issue #282, auth/stepUp.ts; docs/security.md § Two-step sign-in): a
// project owner, a team admin and an assessor need a session signed in with a
// code before the actions those roles exist for. The other DB tests run with
// the requirement off (MFA_REQUIRED=false, __tests__/setup.ts); this file
// turns it on after its fixtures are made. Each refusal has a positive
// control: the same person, signed in with a code, gets through.
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actForAuthority, anon, DECISION, lastMailTo, monthly, node, signUp } from '../__tests__/helpers.js';
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

let owner: User;
let enrolledOwner: User;
let enrolledOwnerTwoStep: string;
let editor: User;
let viewer: User;
let outsider: User;
let projectId: string;
let ownProjectId: string;
let teamId: string;
let linkId: string;
let ownRunId: string;
const uuid = () => crypto.randomUUID();

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
	[owner, enrolledOwner, editor, viewer, outsider] = (await Promise.all(['SuOwner', 'SuEnrolled', 'SuEditor', 'SuViewer', 'SuOutsider'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	projectId = (await owner.call('POST', '/projects', { name: 'Step-up' })).body.project.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
	ownProjectId = (await enrolledOwner.call('POST', '/projects', { name: 'Step-up enrolled' })).body.project.id;
	// Recording a decision and endorsing a baseline also need the authority mark (163): the positive control's owner has it.
	await actForAuthority(enrolledOwner, ownProjectId, enrolledOwner.id);
	teamId = (await owner.call('POST', '/teams', { name: 'Step-up team' })).body.team.id;
	linkId = (await owner.call('POST', `/projects/${projectId}/share-links`, { label: 'WUA', expiresInDays: 7 })).body.link.id;
	// A run to sign on the enrolled owner's project, with the unenrolled editor a member of it.
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await enrolledOwner.call('PUT', `/projects/${ownProjectId}/model`, model)).status).toBe(200);
	expect((await enrolledOwner.call('PATCH', `/projects/${ownProjectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await enrolledOwner.call('PUT', `/projects/${ownProjectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	ownRunId = (await enrolledOwner.call('POST', `/projects/${ownProjectId}/runs`, { label: 'to sign' })).body.run.id;
	expect((await enrolledOwner.call('POST', `/projects/${ownProjectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	enrolledOwnerTwoStep = await enrol(enrolledOwner);
	// From here on, as in production.
	vi.stubEnv('MFA_REQUIRED', 'true');
});
afterAll(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('an owner’s actions need two-step sign-in', () => {
	it('without an authenticator: 403 mfa_required, and nothing is made', async () => {
		const r = await owner.call('POST', `/projects/${projectId}/api-keys`, { name: 'logger' });
		expect(r).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect((await owner.call('GET', `/projects/${projectId}/api-keys`)).status).toBe(403);
	});

	it('the owner’s hand-checked actions too: removing a member, revoking a share link', async () => {
		expect(await owner.call('DELETE', `/projects/${projectId}/members/${viewer.id}`)).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect(await owner.call('DELETE', `/projects/${projectId}/share-links/${linkId}`)).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		// Leaving isn't stepped up: a viewer leaves on a password.
		const leaver = await signUp('SuLeaver');
		vi.stubEnv('MFA_REQUIRED', 'false');
		await owner.call('POST', `/projects/${projectId}/members`, { email: leaver.email, role: 'viewer' });
		vi.stubEnv('MFA_REQUIRED', 'true');
		expect((await leaver.call('DELETE', `/projects/${projectId}/members/${leaver.id}`)).status).toBeLessThan(300);
	});

	it('recording a signer’s registration check too, though the route is open to an acting editor (its minimum role is editor)', async () => {
		const check = { registrationBody: 'sacnasp', registrationCategory: 'pr_sci_nat', registrationNo: '400999/20', registerName: 'Step Signer', outcome: 'registered', checkedByOrg: 'Step WUA', checkedAt: '2026-01-01' };
		expect(await owner.call('POST', `/projects/${projectId}/members/${viewer.id}/registration-checks`, check)).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		// Positive control: an owner signed in with a code gets past the check (to the route's own answer about the member).
		const r = await anon('POST', `/projects/${ownProjectId}/members/${uuid()}/registration-checks`, check, enrolledOwnerTwoStep);
		expect(String(r.body?.code ?? '')).not.toMatch(/^mfa_/);
		expect(r.status).not.toBe(403);
	});

	it('with one, but a session signed in before it (password only): 403 mfa_step_up', async () => {
		expect(await enrolledOwner.call('POST', `/projects/${ownProjectId}/api-keys`, { name: 'logger' })).toMatchObject({ status: 403, body: { code: 'mfa_step_up' } });
	});

	it('positive control: the same owner, signed in with a code, gets through', async () => {
		const r = await anon('POST', `/projects/${ownProjectId}/api-keys`, { name: 'logger' }, enrolledOwnerTwoStep);
		expect(r.status).toBe(201);
	});

	it('the role check comes first: an outsider still gets 404 and a viewer 403 for the role, learning nothing about the requirement', async () => {
		expect((await outsider.call('POST', `/projects/${projectId}/api-keys`, { name: 'x' })).status).toBe(404);
		const v = await viewer.call('POST', `/projects/${projectId}/api-keys`, { name: 'x' });
		expect(v.status).toBe(403);
		expect(v.body.code).toBeUndefined();
	});

	it('everything below owner is untouched: members read and editors work without a code', async () => {
		expect((await viewer.call('GET', `/projects/${projectId}`)).status).toBe(200);
		expect((await owner.call('GET', `/projects/${projectId}`)).status).toBe(200);
		expect((await editor.call('PATCH', `/projects/${projectId}`, { description: 'edited without a code' })).status).toBe(200);
	});

	it('turning the requirement off lets a password-only owner through (the switch the tests use; Lambda refuses it)', async () => {
		vi.stubEnv('MFA_REQUIRED', 'false');
		try {
			expect((await owner.call('GET', `/projects/${projectId}/api-keys`)).status).toBe(200);
		} finally {
			vi.stubEnv('MFA_REQUIRED', 'true');
		}
	});
});

describe('a team admin’s actions need two-step sign-in', () => {
	it('adding a member to the team: 403 mfa_required', async () => {
		expect(await owner.call('POST', `/teams/${teamId}/members`, { email: outsider.email, role: 'viewer' })).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
	});
	it('positive control: an enrolled admin signed in with a code', async () => {
		const team = (await anon('POST', '/teams', { name: 'Step-up team 2' }, enrolledOwnerTwoStep)).body.team.id;
		expect((await anon('POST', `/teams/${team}/members`, { email: outsider.email, role: 'viewer' }, enrolledOwnerTwoStep)).status).toBe(201);
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

describe('the editor actions that publish, decide or sign need two-step sign-in', () => {
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
		// Signing a run or a pack: any editor may sign, so every signer needs it (operator decision, 2026-10-01).
		['POST', `/projects/${pid}/runs/${id}/signoffs`, SIGNOFF],
		['POST', `/projects/${pid}/packs/${id}/signoffs`, SIGNOFF]
	];

	it.each(actions(':id', ':target').map(([m, p], i) => [`${m} ${p}`, i] as const))('%s: an editor without an authenticator gets 403 mfa_required', async (_label, i) => {
		const [method, path, body] = actions(projectId, uuid())[i]!;
		expect(await editor.call(method, path, body)).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
	});

	it('positive control: signed in with a code, each gets past the check to its own answer (a 404 for the made-up target)', async () => {
		for (const [method, path, body] of actions(ownProjectId, uuid())) {
			const r = await anon(method, path, body, enrolledOwnerTwoStep);
			expect(String(r.body?.code ?? ''), `${method} ${path}`).not.toMatch(/^mfa_/);
			expect(r.status, `${method} ${path}`).not.toBe(403);
		}
	});
});

describe('signing a run: the sign-off reads say so before the form is filled in', () => {
	const at = () => `/projects/${ownProjectId}/runs/${ownRunId}/signoffs`;
	const signed = (statementSha256: string, confirmed: string[]) => ({ ...SIGNOFF, confirmed, statementSha256 });

	it('an editor without an authenticator: cannotSign says set one up, and the sign-off is refused 403 mfa_required', async () => {
		const read = await editor.call('GET', at());
		expect(read.status).toBe(200);
		expect(read.body.cannotSign).toMatch(/two-step sign-in: set it up on your Account page/);
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		expect(await editor.call('POST', at(), signed(read.body.statementSha256, confirmed))).toMatchObject({ status: 403, body: { code: 'mfa_required' } });
		expect((await editor.call('GET', at())).body.signoffs).toEqual([]);
	});

	it('codes by email count as the signer’s factor (206): cannotSign is null on the session the emailed code gave, and says sign in again on a password-only one', async () => {
		const signer = await signUp('SuEmailSigner');
		vi.stubEnv('MFA_REQUIRED', 'false');
		expect((await enrolledOwner.call('POST', `/projects/${ownProjectId}/members`, { email: signer.email, role: 'editor' })).status).toBe(201);
		vi.stubEnv('MFA_REQUIRED', 'true');
		// Without a factor yet (negative control): set one up.
		expect((await signer.call('GET', at())).body.cannotSign).toMatch(/set it up on your Account page/);
		expect((await signer.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).status).toBe(202);
		const code = lastMailTo(signer.email)!.text.match(/^(\d{6})$/m)![1]!;
		const confirmed = await anon('POST', '/auth/mfa/email/confirm', { code }, signer.cookie);
		expect(confirmed.status).toBe(200);
		expect((await anon('GET', at(), undefined, sessionOf(confirmed.headers))).body.cannotSign).toBeNull();
		expect((await signer.call('GET', at())).body.cannotSign).toMatch(/sign in again/);
	});

	it('an enrolled signer on a password-only session: cannotSign says sign in again', async () => {
		expect((await enrolledOwner.call('GET', at())).body.cannotSign).toMatch(/sign in again/);
	});

	it('positive control: the same signer, signed in with a code, may sign, and the sign-off is made', async () => {
		const read = await anon('GET', at(), undefined, enrolledOwnerTwoStep);
		expect(read.body.cannotSign).toBeNull();
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		const r = await anon('POST', at(), signed(read.body.statementSha256, confirmed), enrolledOwnerTwoStep);
		expect(r.status).toBe(201);
		expect(r.body.signoff.fullName).toBe('Step Signer');
	});
});

describe('a sign-off, issuing and withdrawing need a code from the last 10 minutes', () => {
	const at = () => `/projects/${ownProjectId}/runs/${ownRunId}/signoffs`;
	const signed = (statementSha256: string, confirmed: string[]) => ({ ...SIGNOFF, fullName: 'Fresh Signer', confirmed, statementSha256 });

	it('11 minutes after the code: 401 mfa_fresh_code for each, while an owner-only action still goes through', async () => {
		vi.setSystemTime(Date.now() + 11 * 60_000);
		const read = await anon('GET', at(), undefined, enrolledOwnerTwoStep);
		// The read doesn't say so: the client asks for a code when the action answers.
		expect(read.body.cannotSign).toBeNull();
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		expect(await anon('POST', at(), signed(read.body.statementSha256, confirmed), enrolledOwnerTwoStep)).toMatchObject({ status: 401, body: { code: 'mfa_fresh_code' } });
		for (const [method, path, body] of [
			['POST', `/projects/${ownProjectId}/packs/${uuid()}/issue`, {}],
			['POST', `/projects/${ownProjectId}/packs/${uuid()}/withdraw`, { reason: 'x' }],
			['POST', `/projects/${ownProjectId}/packs/${uuid()}/signoffs`, SIGNOFF]
		] as const) {
			expect(await anon(method, path, body, enrolledOwnerTwoStep), path).toMatchObject({ status: 401, body: { code: 'mfa_fresh_code' } });
		}
		// Control: owner actions need two-step sign-in, not a fresh code.
		expect((await anon('POST', `/projects/${ownProjectId}/share-links`, { label: 'Fresh', expiresInDays: 7 }, enrolledOwnerTwoStep)).status).toBe(201);
	});

	it('POST /auth/mfa/step-up: a wrong code is refused; a right one re-issues the session, and the sign-off is made', async () => {
		expect(await anon('POST', '/auth/mfa/step-up', { code: '000000' }, enrolledOwnerTwoStep)).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
		const r = await anon('POST', '/auth/mfa/step-up', { code: code(secrets.get(enrolledOwner.id)!) }, enrolledOwnerTwoStep);
		expect(r.status).toBe(200);
		const fresh = sessionOf(r.headers);
		expect(decodeJwt(fresh.split('=')[1]!)).toMatchObject({ amr: ['pwd', 'otp'], otp_at: Date.now() });
		const read = await anon('GET', at(), undefined, fresh);
		const confirmed = read.body.statement.confirmations.map((k: { id: string }) => k.id);
		const made = await anon('POST', at(), signed(read.body.statementSha256, confirmed), fresh);
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		// The old session still signs nothing.
		expect(await anon('POST', at(), signed(read.body.statementSha256, confirmed), enrolledOwnerTwoStep)).toMatchObject({ status: 401 });
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
	it('a project owner and a team admin: required; a viewer and an editor of others’ projects: not', async () => {
		expect((await owner.call('GET', '/auth/mfa')).body).toMatchObject({ required: true, enrolled: false });
		expect((await viewer.call('GET', '/auth/mfa')).body).toMatchObject({ required: false });
		expect((await editor.call('GET', '/auth/mfa')).body).toMatchObject({ required: false });
		expect((await anon('GET', '/auth/mfa', undefined, enrolledOwnerTwoStep)).body).toMatchObject({ required: true, enrolled: true, sessionVerified: true });
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
