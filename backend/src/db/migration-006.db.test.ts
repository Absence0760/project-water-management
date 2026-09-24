// Migration 006 (farm and dam operating rules, engine 0.14.0) rewrites stored
// model values. This builds a throwaway database at the schema before 006,
// stores a model the old way, applies 006 and checks what each value became
// (docs/data-model.md § Migrations, docs/engine-audit.md Q5).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m006_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

async function apply(file: string) {
	await db.query(await readFile(join(DIR, file), 'utf8'));
}

const PROJECT = '00000000-0000-4000-8000-000000000001';
const node = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '006')) await apply(f);
	const owner = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('m@example.com', 'M', 'x') RETURNING id`)).rows[0]!.id;
	await db.query(`INSERT INTO project (id, name, created_by) VALUES ($1, 'Migration', $2)`, [PROJECT, owner]);
	// A dam whose "min %" came from the workbook's transfer minimum, and one without.
	await db.query(
		`INSERT INTO node (id, project_id, name, kind, dam_capacity_m3, dam_min_pct) VALUES
			($1, $3, 'Dam with a min', 'farm', 1000, 0.3),
			($2, $3, 'Dam without', 'farm', 1000, 0)`,
		[node(1), node(2), PROJECT]
	);
	await apply('006_farm_dam_ops.sql');
}, 60_000);

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const row = async (id: string) => (await db.query('SELECT * FROM node WHERE id = $1', [id])).rows[0] as Record<string, unknown>;

describe('migration 006: farm and dam operating rules', () => {
	it('Q5: resets every dam minimum to 0 (it was the transfer minimum, which the rules already carry)', async () => {
		expect((await row(node(1))).dam_min_pct).toBe(0);
		expect((await row(node(2))).dam_min_pct).toBe(0);
	});
});
