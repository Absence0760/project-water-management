// Sign-up by invitation (auth/signupOpen.ts, docs/security.md § Sign-up by
// invitation). With SIGNUP_OPEN=false, POST /auth/register makes an account
// only through a live invite for exactly the address it signs up with:
//   - no invite, a malformed or unknown token, or a live invite for another
//     address: 403 signup_closed, and no account, no email;
//   - the same answer for a taken and a free address, so it can't be used to
//     find accounts;
//   - a live invite for this address: the account is made and joins (201),
//     as with sign-up open;
//   - SIGNUP_OPEN=true (and unset, locally) is the open sign-up of issue #57:
//     the positive control.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anon, asOwner, lastMailTo, signUp, tokenIn } from '../__tests__/helpers.js';

const fresh = (tag: string) => `${tag}-${crypto.randomUUID()}@example.com`;
const register = (email: string, inviteToken?: string) =>
	anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'New', acceptTerms: LEGAL_VERSION, ...(inviteToken ? { inviteToken } : {}) });
const accounts = async (email: string) => ((await asOwner('SELECT count(*)::int AS n FROM app_user WHERE email = $1', [email])) as { n: number }[])[0]!.n;

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let projectId: string;

/** A live project invite to `email`, as its token. */
async function invite(email: string): Promise<string> {
	const res = await owner.call('POST', `/projects/${projectId}/members`, { email, role: 'viewer' });
	expect(res.status).toBe(201);
	return tokenIn(lastMailTo(email));
}

beforeAll(async () => {
	owner = await signUp('Inviter');
	projectId = (await owner.call('POST', '/projects', { name: 'Invite-only catchment' })).body.project.id;
});
beforeEach(() => vi.stubEnv('SIGNUP_OPEN', 'false'));
afterEach(() => vi.unstubAllEnvs());

describe('POST /auth/register while sign-up is closed', () => {
	it('refuses a sign-up without an invite, making no account and sending no email', async () => {
		const email = fresh('stranger');
		const res = await register(email);
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('signup_closed');
		expect(await accounts(email)).toBe(0);
		expect(lastMailTo(email)).toBeUndefined();
	});

	it('answers a taken address exactly as a free one, and mails its owner nothing', async () => {
		vi.stubEnv('SIGNUP_OPEN', 'true');
		const taken = await signUp('Taken');
		vi.stubEnv('SIGNUP_OPEN', 'false');
		const before = lastMailTo(taken.email);
		const res = await register(taken.email);
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('signup_closed');
		expect(lastMailTo(taken.email)).toBe(before);
	});

	it('refuses a malformed token, an unknown one, and a live invite for another address', async () => {
		const invited = fresh('invited');
		const token = await invite(invited);
		const other = fresh('other');
		for (const t of ['not-a-token', token.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')), token]) {
			const res = await register(other, t);
			expect(res.status).toBe(403);
			expect(res.body.code).toBe('signup_closed');
		}
		expect(await accounts(other)).toBe(0);
		// Positive control: the invite itself is still good for its own address.
		expect((await register(invited, token)).status).toBe(201);
	});

	it('makes the account through a live invite for that address, signed in and joined', async () => {
		const email = fresh('member');
		const res = await register(email.toUpperCase(), await invite(email));
		expect(res.status).toBe(201);
		expect(res.body.user.email).toBe(email);
		const [m] = (await asOwner('SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, res.body.user.id])) as { role: string }[];
		expect(m?.role).toBe('viewer');
	});
});

describe('POST /auth/register while sign-up is open (the positive control)', () => {
	it.each([['true'], ['']])('SIGNUP_OPEN=%j: anyone may sign up and gets a confirmation email', async (value) => {
		vi.stubEnv('SIGNUP_OPEN', value);
		const email = fresh('open');
		expect((await register(email)).status).toBe(202);
		expect(await accounts(email)).toBe(1);
		expect(lastMailTo(email)).toBeDefined();
	});
});
