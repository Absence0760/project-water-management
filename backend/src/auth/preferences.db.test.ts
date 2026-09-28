// A person's own display preferences (083_user_preferences.sql,
// auth/preferences.ts): the workspace sections they hid from their sidebar.
// PATCH /auth/me { preferences } and GET /auth/me, the shape the backend
// accepts, and RLS: your own row only, for every command. Every "cannot"
// has a positive control beside it.
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, signUp } from '../__tests__/helpers.js';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { MAX_HIDDEN_TABS } from './preferences.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** Run one statement in a savepoint and roll it back: rows it touched, or the refusal's code. */
async function attempt(db: Db, sql: string, params: unknown[] = []): Promise<number | string> {
	await db.query('SAVEPOINT attempt');
	try {
		return (await db.query(sql, params)).rowCount ?? 0;
	} catch (e) {
		return (e as { code?: string }).code ?? 'error';
	} finally {
		await db.query('ROLLBACK TO SAVEPOINT attempt');
	}
}

const hiddenOf = async (u: User) => (await u.call('GET', '/auth/me')).body.user.preferences;

describe('PATCH /auth/me { preferences }', () => {
	it('starts with nothing hidden', async () => {
		const u = await signUp('PrefFresh');
		expect(await hiddenOf(u)).toEqual({ hiddenTabs: [] });
	});

	it('saves the hidden sections (once each), keeps them, and "Reset to default" clears them', async () => {
		const u = await signUp('PrefSave');
		const a = await u.call('PATCH', '/auth/me', { preferences: { hiddenTabs: ['crops', 'transfers', 'crops'] } });
		expect(a.status).toBe(200);
		expect(a.body.user.preferences).toEqual({ hiddenTabs: ['crops', 'transfers'] });
		expect(await hiddenOf(u)).toEqual({ hiddenTabs: ['crops', 'transfers'] });
		// Another field alone leaves them as they are.
		const b = await u.call('PATCH', '/auth/me', { displayName: 'PrefRenamed' });
		expect(b.body.user).toMatchObject({ displayName: 'PrefRenamed', preferences: { hiddenTabs: ['crops', 'transfers'] } });
		const c = await u.call('PATCH', '/auth/me', { preferences: { hiddenTabs: [] } });
		expect(c.body.user.preferences).toEqual({ hiddenTabs: [] });
		expect(await hiddenOf(u)).toEqual({ hiddenTabs: [] });
	});

	it('refuses a malformed document and leaves the saved one alone', async () => {
		const u = await signUp('PrefBad');
		await u.call('PATCH', '/auth/me', { preferences: { hiddenTabs: ['dams'] } });
		// Distinct, well-formed ids, one too many.
		const tooMany = Array.from({ length: MAX_HIDDEN_TABS + 1 }, (_, i) => `tab-${String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26))}`);
		for (const preferences of [
			{ hiddenTabs: 'crops' },
			{ hiddenTabs: [1] },
			{ hiddenTabs: ['Crops'] },
			{ hiddenTabs: ['<script>'] },
			{ hiddenTabs: ['x'.repeat(40)] },
			{ hiddenTabs: tooMany },
			{ hiddenTabs: null },
			{ other: true },
			[],
			'crops',
			null
		]) {
			expect((await u.call('PATCH', '/auth/me', { preferences })).status, JSON.stringify(preferences)).toBe(400);
		}
		expect(await hiddenOf(u)).toEqual({ hiddenTabs: ['dams'] });
	});

	it('needs a session', async () => {
		expect((await anon('PATCH', '/auth/me', { preferences: { hiddenTabs: [] } })).status).toBe(401);
	});
});

describe('user_preferences under RLS: your own row only', () => {
	let me: User;
	let other: User;
	beforeAll(async () => {
		me = await signUp('PrefMe');
		other = await signUp('PrefOther');
		await me.call('PATCH', '/auth/me', { preferences: { hiddenTabs: ['crops'] } });
		await other.call('PATCH', '/auth/me', { preferences: { hiddenTabs: ['history'] } });
		// A co-member: app_user's own policy lets each read the other's account, so this table must not follow it.
		const projectId = (await me.call('POST', '/projects', { name: 'Prefs shared' })).body.project.id;
		expect((await me.call('POST', `/projects/${projectId}/members`, { email: other.email, role: 'viewer' })).status).toBe(201);
	});

	it('reads your own row (positive control), never another person’s, even a co-member’s', async () => {
		await withUser(me.id, async (db) => {
			const { rows } = await db.query<{ user_id: string }>('SELECT user_id FROM user_preferences WHERE user_id = ANY ($1)', [[me.id, other.id]]);
			expect(rows.map((r) => r.user_id)).toEqual([me.id]);
			// The co-member's account itself is visible (068), so the refusal above is this table's policy.
			expect((await db.query('SELECT 1 FROM app_user WHERE id = $1', [other.id])).rowCount).toBe(1);
		});
	});

	it('changes your own row (positive control), never another person’s', async () => {
		await withUser(me.id, async (db) => {
			expect(await attempt(db, `UPDATE user_preferences SET preferences = '{}' WHERE user_id = $1`, [me.id])).toBe(1);
			expect(await attempt(db, `UPDATE user_preferences SET preferences = '{}' WHERE user_id = $1`, [other.id])).toBe(0);
			expect(await attempt(db, 'DELETE FROM user_preferences WHERE user_id = $1', [other.id])).toBe(0);
			expect(await attempt(db, 'DELETE FROM user_preferences WHERE user_id = $1', [me.id])).toBe(1);
			// Writing a row for someone else fails the policy's WITH CHECK.
			expect(await attempt(db, `UPDATE user_preferences SET user_id = $2 WHERE user_id = $1`, [me.id, other.id])).toBe('42501');
		});
		const stranger = await signUp('PrefStranger');
		await withUser(me.id, async (db) => {
			expect(await attempt(db, 'INSERT INTO user_preferences (user_id) VALUES ($1)', [stranger.id])).toBe('42501');
		});
		await withUser(stranger.id, async (db) => {
			expect(await attempt(db, 'INSERT INTO user_preferences (user_id) VALUES ($1)', [stranger.id])).toBe(1);
		});
		expect(await asOwner('SELECT preferences FROM user_preferences WHERE user_id = $1', [other.id])).toEqual([{ preferences: { hiddenTabs: ['history'] } }]);
	});

	it('shows no row to a transaction with no user (pre-sign-in, the job tick)', async () => {
		await withoutUser(async (db) => {
			expect((await db.query('SELECT 1 FROM user_preferences WHERE user_id = ANY ($1)', [[me.id, other.id]])).rowCount).toBe(0);
			expect(await attempt(db, `UPDATE user_preferences SET preferences = '{}' WHERE user_id = $1`, [other.id])).toBe(0);
		});
	});

	it('keeps the document an object of bounded size, whatever writes it', async () => {
		await withUser(me.id, async (db) => {
			expect(await attempt(db, `INSERT INTO user_preferences (user_id, preferences) VALUES ($1, '[]') ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences`, [me.id])).toBe('23514');
			expect(await attempt(db, `INSERT INTO user_preferences (user_id, preferences) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences`, [me.id, JSON.stringify({ junk: 'x'.repeat(10_000) })])).toBe('23514');
		});
	});

	it('goes with the account', async () => {
		const leaver = await signUp('PrefLeaver');
		await leaver.call('PATCH', '/auth/me', { preferences: { hiddenTabs: ['crops'] } });
		await asOwner('DELETE FROM app_user WHERE id = $1', [leaver.id]);
		expect(await asOwner('SELECT 1 FROM user_preferences WHERE user_id = $1', [leaver.id])).toEqual([]);
	});
});
