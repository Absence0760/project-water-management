// A person's language and volume unit (roadmap WP-2.5; 050_user_locale.sql):
// PATCH /auth/me, sign-up with a language, the language an accepted invite
// gives a new account, and the emails that follow it.
//
// The Afrikaans email catalogue is replaced by a made-up one that marks each
// word it supplies ("[af] …"), so the tests can see which language an email
// came out in: test data only, never wording that ships.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { anon, asOwner, lastMailTo, node, signUp, tokenIn } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

vi.mock('../mail/i18n/af.js', async () => {
	const { en } = await vi.importActual<typeof import('../mail/i18n/en.js')>('../mail/i18n/en.js');
	return { af: Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `[af] ${v}`])) };
});

const newEmail = (tag: string) => `${tag}-${crypto.randomUUID()}@example.com`;

/**
 * Sign up and read the account back. A sign-up through a matching invite is
 * signed in (201, the user); an ordinary one waits for its confirmation link
 * (202, issue #57), so the account is read as the schema owner.
 */
async function register(body: Record<string, unknown>) {
	const res = await anon('POST', '/auth/register', { password: 'correct horse', displayName: 'Lang', acceptTerms: LEGAL_VERSION, ...body });
	if (body.inviteToken && res.status === 201) return res.body.user as { id: string; locale: string | null; volumeUnit: string };
	expect(res.status).toBe(202);
	const [row] = (await asOwner('SELECT id, locale, volume_unit FROM app_user WHERE email = $1', [body.email])) as { id: string; locale: string | null; volume_unit: string }[];
	return { id: row!.id, locale: row!.locale, volumeUnit: row!.volume_unit };
}

describe('PATCH /auth/me { locale, volumeUnit }', () => {
	it('starts unset (follow the browser) and in m³', async () => {
		const u = await signUp('Fresh');
		expect((await u.call('GET', '/auth/me')).body.user).toMatchObject({ locale: null, volumeUnit: 'm3' });
	});

	it('changes only what is sent, and can go back to "not chosen"', async () => {
		const u = await signUp('Prefs');
		const a = await u.call('PATCH', '/auth/me', { locale: 'af' });
		expect(a.status).toBe(200);
		expect(a.body.user).toEqual({ id: u.id, email: u.email, displayName: 'Prefs', emailVerified: true, locale: 'af', volumeUnit: 'm3', mailSuppressed: null, preferences: { hiddenTabs: [] }, termsCurrent: true, farmNoticeCurrent: false });
		const b = await u.call('PATCH', '/auth/me', { volumeUnit: 'ML' });
		expect(b.body.user).toMatchObject({ displayName: 'Prefs', locale: 'af', volumeUnit: 'ML' });
		const c = await u.call('PATCH', '/auth/me', { displayName: 'Renamed' });
		expect(c.body.user).toMatchObject({ displayName: 'Renamed', locale: 'af', volumeUnit: 'ML' });
		const d = await u.call('PATCH', '/auth/me', { locale: null });
		expect(d.body.user).toMatchObject({ locale: null, volumeUnit: 'ML' });
		expect((await u.call('GET', '/auth/me')).body.user).toMatchObject({ displayName: 'Renamed', locale: null, volumeUnit: 'ML' });
	});

	it('refuses an unknown language or unit, and a body with nothing to change', async () => {
		const u = await signUp('Bad');
		for (const body of [{ locale: 'fr' }, { locale: 'AF' }, { volumeUnit: 'l' }, { volumeUnit: null }, {}, { email: 'x@example.com' }]) {
			expect((await u.call('PATCH', '/auth/me', body)).status, JSON.stringify(body)).toBe(400);
		}
		expect((await u.call('GET', '/auth/me')).body.user).toMatchObject({ locale: null, volumeUnit: 'm3' });
	});

	it('needs a session', async () => {
		expect((await anon('PATCH', '/auth/me', { locale: 'af' })).status).toBe(401);
	});
});

describe('emails follow the account’s language', () => {
	it('signing up in Afrikaans stores it, and the confirmation email is in it', async () => {
		const email = newEmail('signup-af');
		const user = await register({ email, locale: 'af' });
		expect(user.locale).toBe('af');
		const mail = lastMailTo(email)!;
		expect(mail.subject).toBe('[af] Confirm your email address — Water Management');
		expect(mail.html).toMatch(/<html lang="af">/);
	});

	it('an account with no language gets English, and a reset follows a later choice', async () => {
		const email = newEmail('signup-en');
		const user = await register({ email });
		expect(user.locale).toBeNull();
		expect(lastMailTo(email)!.subject).toBe('Confirm your email address — Water Management');
		await asOwner(`UPDATE app_user SET locale = 'af' WHERE id = $1`, [user.id]);
		expect((await anon('POST', '/auth/forgot-password', { email })).status).toBe(202);
		expect(lastMailTo(email)!.subject).toBe('[af] Reset your password — Water Management');
	});

	it('refuses a language it does not know at sign-up', async () => {
		expect((await anon('POST', '/auth/register', { email: newEmail('fr'), password: 'correct horse', displayName: 'F', acceptTerms: LEGAL_VERSION, locale: 'fr' })).status).toBe(400);
	});
});

describe('a new account takes its language from the invite it accepts (050, app_accept_invites)', () => {
	type User = Awaited<ReturnType<typeof signUp>>;
	let owner: User;
	let projectId: string;
	const outlet = node('Outlet', null);
	const farm = node('Farm L', outlet.id);

	beforeAll(async () => {
		owner = await signUp('Lowner');
		projectId = (await owner.call('POST', '/projects', { name: 'Locale catchment' })).body.project.id;
		const model = { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [], landCover: [] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	});

	const invite = async (email: string, locale: 'en' | 'af') => {
		const res = await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farm.id], locale });
		expect(res.status).toBe(201);
		return tokenIn(lastMailTo(email));
	};

	it('an Afrikaans farmer invite: the invite email and the new account are Afrikaans', async () => {
		const email = newEmail('farmer-af');
		const token = await invite(email, 'af');
		expect(lastMailTo(email)!.subject).toBe('[af] Lowner has given you access to Farm L in Locale catchment');
		const user = await register({ email, inviteToken: token });
		expect(user.locale).toBe('af');
		// Positive control: the invite really was accepted (the farmer is linked).
		const links = await withUser(user.id, async (db) => (await db.query('SELECT node_id FROM farm_link WHERE user_id = $1', [user.id])).rows);
		expect(links).toEqual([{ node_id: farm.id }]);
	});

	it('an English invite gives English', async () => {
		const email = newEmail('farmer-en');
		const user = await register({ email, inviteToken: await invite(email, 'en') });
		expect(user.locale).toBe('en');
	});

	it('never overwrites a language the person chose', async () => {
		const email = newEmail('farmer-chose');
		const token = await invite(email, 'af');
		const user = await register({ email, inviteToken: token, locale: 'en' });
		expect(user.locale).toBe('en');
	});

	it('an account confirmed later (an unverified sign-up, then the link) takes the invite’s language too', async () => {
		const email = newEmail('farmer-late');
		const user = await register({ email });
		expect(user.locale).toBeNull();
		await invite(email, 'af'); // confirm mode: the invite rides on a verify link
		const token = tokenIn(lastMailTo(email));
		expect((await anon('POST', '/auth/verify-email', { token })).status).toBe(200);
		// As the account itself: app_user is under RLS (068).
		const locale = await withUser(user.id, async (db) => (await db.query<{ locale: string | null }>('SELECT locale FROM app_user WHERE id = $1', [user.id])).rows[0]?.locale);
		expect(locale).toBe('af');
	});
});
