// Migration 136 (issue #281): allocation.authorisation gains 'schedule_1' and
// 'existing_lawful_use_claimed', and an imported row stored as verified
// existing lawful use becomes a claim, since the importer before 136 read an
// unqualified "existing" / "ELU" / "s32" as verified and the cell isn't kept.
// A row typed in by hand keeps its value. This builds a throwaway database at
// the schema before 136, stores rows the old way, applies 136 and checks them
// (docs/allocations.md § Importing).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m136_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

async function apply(file: string) {
	await db.query(await readFile(join(DIR, file), 'utf8'));
}

const PROJECT = '00000000-0000-4000-8000-000000000001';
const SOURCE = '00000000-0000-4000-8000-000000000002';
const IMPORTED_ELU = '00000000-0000-4000-8000-000000000101';
const HAND_ELU = '00000000-0000-4000-8000-000000000102';
const IMPORTED_LICENCE = '00000000-0000-4000-8000-000000000103';

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '136')) await apply(f);
	const owner = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('m@example.com', 'M', 'x') RETURNING id`)).rows[0]!.id;
	await db.query(`INSERT INTO project (id, name, created_by) VALUES ($1, 'Migration', $2)`, [PROJECT, owner]);
	await db.query(`INSERT INTO allocation_source (id, project_id, kind, file_name, sha256) VALUES ($1, $2, 'warms_extract', 'x.csv', $3)`, [SOURCE, PROJECT, 'a'.repeat(64)]);
	await db.query(
		`INSERT INTO allocation (id, project_id, source_id, authorisation, water_source, volume_m3_year) VALUES
			($1, $4, $5, 'existing_lawful_use', 'surface', 1),
			($2, $4, NULL, 'existing_lawful_use', 'surface', 1),
			($3, $4, $5, 'licence', 'surface', 1)`,
		[IMPORTED_ELU, HAND_ELU, IMPORTED_LICENCE, PROJECT, SOURCE]
	);
	// Before 136 the new values are refused.
	await expect(db.query(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year) VALUES ($1, 'schedule_1', 'surface', 1)`, [PROJECT])).rejects.toThrow(
		/allocation_authorisation_check/
	);
	await apply('136_allocation_authorisation.sql');
}, 120_000);

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const authorisation = async (id: string) => ((await db.query('SELECT authorisation FROM allocation WHERE id = $1', [id])).rows[0] as { authorisation: string }).authorisation;

describe('migration 136: claimed existing lawful use and Schedule 1', () => {
	it('reads an imported "verified" existing lawful use as a claim, and leaves a hand-entered one and other values alone', async () => {
		expect(await authorisation(IMPORTED_ELU)).toBe('existing_lawful_use_claimed');
		expect(await authorisation(HAND_ELU)).toBe('existing_lawful_use');
		expect(await authorisation(IMPORTED_LICENCE)).toBe('licence');
	});

	it('accepts the two new values and still refuses an unknown one', async () => {
		for (const v of ['schedule_1', 'existing_lawful_use_claimed'])
			await db.query(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year) VALUES ($1, $2, 'surface', 1)`, [PROJECT, v]);
		await expect(db.query(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year) VALUES ($1, 'entitlement', 'surface', 1)`, [PROJECT])).rejects.toThrow(
			/allocation_authorisation_check/
		);
	});
});
