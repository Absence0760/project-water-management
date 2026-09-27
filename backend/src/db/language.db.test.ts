// The `language` table (080_language.sql; docs/data-model.md § Languages):
// the migration runner keeps it equal to the engine's language table, and the
// foreign keys on app_user.locale and invite.locale refuse anything else.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCALES } from '@water-management/engine/languages';
import { syncLanguages } from '../../scripts/migrate.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from './tx.js';

let owner: pg.Client;
beforeAll(async () => {
	owner = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await owner.connect();
});
afterAll(async () => {
	await owner.query(`UPDATE app_user SET locale = NULL WHERE locale = 'zz'`);
	await owner.query(`DELETE FROM language WHERE code = 'zz'`);
	await owner.end();
});

const codes = async () => (await asOwner('SELECT code FROM language ORDER BY code')).map((r: { code: string }) => r.code);

describe('the language table', () => {
	it('holds exactly the engine’s languages after migrating', async () => {
		expect(await codes()).toEqual([...LOCALES].sort());
	});

	it('is readable by every signed-in person, and water_app cannot write it', async () => {
		const u = await signUp('Langreader');
		await withUser(u.id, async (db) => {
			expect((await db.query('SELECT code FROM language ORDER BY code')).rows.map((r) => r.code)).toEqual([...LOCALES].sort());
			await expect(db.query(`INSERT INTO language (code) VALUES ('zz')`)).rejects.toThrow(/permission denied/);
		});
	});

	it('refuses a locale it does not list (app_user and invite both reference it)', async () => {
		const u = await signUp('Langbad');
		await expect(asOwner(`UPDATE app_user SET locale = 'zz' WHERE id = $1`, [u.id])).rejects.toThrow(/app_user_locale_fkey/);
		const { rows } = await owner.query(
			`SELECT conrelid::regclass::text AS tbl FROM pg_constraint WHERE contype = 'f' AND confrelid = 'language'::regclass ORDER BY 1`
		);
		expect(rows.map((r) => r.tbl)).toEqual(['app_user', 'invite']);
	});

	it('gains a language added to the list on the next sync, once, and never loses one', async () => {
		expect(await syncLanguages(owner, [...LOCALES, 'zz'])).toEqual(['zz']);
		expect(await syncLanguages(owner, [...LOCALES, 'zz'])).toEqual([]);
		const u = await signUp('Langnew');
		await asOwner(`UPDATE app_user SET locale = 'zz' WHERE id = $1`, [u.id]);
		expect((await asOwner('SELECT locale FROM app_user WHERE id = $1', [u.id]))[0].locale).toBe('zz');
		// A sync from a list without it leaves it (stored locales may name it).
		expect(await syncLanguages(owner)).toEqual([]);
		expect(await codes()).toContain('zz');
	});
});
