// The WUA's notice by language (issue #58, 081_notice_languages.sql): the
// column's shape check and the backfill from the two old columns. The API's
// side (a language the table doesn't list is refused) is in
// publication.db.test.ts § changing the notice.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { asOwner } from '../__tests__/helpers.js';

const MIGRATION = readFileSync(new URL('../../migrations/081_notice_languages.sql', import.meta.url), 'utf8');

describe('run_publication.notice', () => {
	it('holds an object of language code → non-blank words, at most 2000 characters each (app_notice_valid)', async () => {
		const valid = async (v: unknown) => (await asOwner('SELECT app_notice_valid($1::jsonb) AS ok', [JSON.stringify(v)]))[0]!.ok;
		// Positive controls: none, one language, several, and a code the API may add later.
		expect(await valid({})).toBe(true);
		expect(await valid({ en: 'Irrigate at night' })).toBe(true);
		expect(await valid({ en: 'Irrigate at night', af: 'x', xx: 'y'.repeat(2000) })).toBe(true);
		for (const bad of [null, [], 'text', { en: '' }, { en: ' \n\t ' }, { en: 1 }, { en: null }, { en: { t: 'x' } }, { EN: 'x' }, { 'en-ZA': 'x' }, { en: 'x'.repeat(2001) }]) {
			expect(await valid(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('the migration’s backfill copies each written notice under its code and leaves blank ones out', async () => {
		// The backfill statement, run against a stand-in table with the two old
		// columns (a temporary table shadows run_publication), then rolled back.
		const update = MIGRATION.match(/UPDATE run_publication SET notice = [\s\S]*?;/)?.[0];
		expect(update).toBeDefined();
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			await client.query(`CREATE TEMP TABLE run_publication (
				id integer PRIMARY KEY, notice_en text, notice_af text,
				notice jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (app_notice_valid(notice))
			) ON COMMIT DROP`);
			await client.query(`INSERT INTO run_publication (id, notice_en, notice_af) VALUES
				(1, 'Irrigate at night.', 'Besproei snags.'),
				(2, 'English only', NULL),
				(3, NULL, 'Afrikaans only'),
				(4, '  ', 'Blank English'),
				(5, NULL, NULL),
				(6, '', E' \\n ')`);
			await client.query(update!);
			const { rows } = await client.query('SELECT id, notice FROM run_publication ORDER BY id');
			expect(rows).toEqual([
				{ id: 1, notice: { en: 'Irrigate at night.', af: 'Besproei snags.' } },
				{ id: 2, notice: { en: 'English only' } },
				{ id: 3, notice: { af: 'Afrikaans only' } },
				{ id: 4, notice: { af: 'Blank English' } },
				{ id: 5, notice: {} },
				{ id: 6, notice: {} }
			]);
		} finally {
			await client.query('ROLLBACK');
			await client.end();
		}
	});

	it('the old columns are gone and water_app may update the new one', async () => {
		const cols = await asOwner(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'run_publication' AND column_name LIKE 'notice%' ORDER BY 1`
		);
		expect(cols).toEqual([{ column_name: 'notice' }]);
		const [grant] = await asOwner(`SELECT has_column_privilege('water_app', 'run_publication', 'notice', 'UPDATE') AS ok`);
		expect(grant!.ok).toBe(true);
	});
});

