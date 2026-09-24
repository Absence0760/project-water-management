// Migration 006 (farm and dam operating rules, engine 0.16.0) rewrites stored
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
	// A dam whose "min %" came from the workbook's transfer minimum, and one without;
	// return flows of 0, 20 % and 100 %.
	await db.query(
		`INSERT INTO node (id, project_id, name, kind, dam_capacity_m3, dam_min_pct, return_flow_pct) VALUES
			($1, $4, 'Dam with a min', 'farm', 1000, 0.3, 0.2),
			($2, $4, 'Dam without', 'farm', 1000, 0, 0),
			($3, $4, 'All returns', 'farm', 0, 0, 1)`,
		[node(1), node(2), node(3), PROJECT]
	);
	// Three transfer rules from one dam; the engine served them in id order.
	await db.query(
		`INSERT INTO transfer (id, project_id, from_node_id, to_node_id, months, max_rate_m3s) VALUES
			($1, $4, $5, $6, '{1}', 1), ($2, $4, $5, $6, '{1}', 1), ($3, $4, $5, $6, '{1}', 1)`,
		['00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202', PROJECT, node(1), node(2)]
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

	it('N1: maps return flow r to efficiency e = 1 − r with every loss returning, and r = 0 to e = 1, β = 0', async () => {
		expect(await row(node(1))).toMatchObject({ irrigation_efficiency: 0.8, loss_return_fraction: 1 });
		expect(await row(node(2))).toMatchObject({ irrigation_efficiency: 1, loss_return_fraction: 0 });
		// r = 1 would divide by 0: the smallest efficiency the model accepts.
		expect(await row(node(3))).toMatchObject({ irrigation_efficiency: 0.01, loss_return_fraction: 1 });
		expect(await row(node(1))).not.toHaveProperty('return_flow_pct');
	});

	it('N2: existing dams get an unknown area (estimated by the run), the exponent 0.7 and no seepage', async () => {
		expect(await row(node(1))).toMatchObject({ dam_area_full_m2: null, dam_area_exponent: 0.7, dam_seepage_per_day: 0 });
		await expect(db.query(`UPDATE node SET dam_area_exponent = 0 WHERE id = $1`, [node(1)])).rejects.toThrow(/check constraint/);
		await expect(db.query(`UPDATE node SET dam_seepage_per_day = 1.5 WHERE id = $1`, [node(1)])).rejects.toThrow(/check constraint/);
		await expect(db.query(`UPDATE node SET dam_area_full_m2 = -1 WHERE id = $1`, [node(1)])).rejects.toThrow(/check constraint/);
	});

	it('Q18: gives each transfer rule its old position (id order) as its priority', async () => {
		const { rows } = await db.query<{ id: string; priority: number }>('SELECT id, priority FROM transfer ORDER BY id');
		expect(rows.map((r) => r.priority)).toEqual([0, 1, 2]);
		await db.query(`INSERT INTO transfer (project_id, from_node_id, to_node_id) VALUES ($1, $2, $3)`, [PROJECT, node(2), node(1)]);
		const fresh = (await db.query(`SELECT priority FROM transfer WHERE from_node_id = $1`, [node(2)])).rows[0];
		expect(fresh).toEqual({ priority: 0 });
	});

	it('N1: a new farm defaults to 80 % efficiency with half its losses returning, and e must be above 0', async () => {
		await db.query(`INSERT INTO node (project_id, name, kind) VALUES ($1, 'New farm', 'farm')`, [PROJECT]);
		const r = (await db.query(`SELECT irrigation_efficiency, loss_return_fraction FROM node WHERE name = 'New farm'`)).rows[0];
		expect(r).toEqual({ irrigation_efficiency: 0.8, loss_return_fraction: 0.5 });
		await expect(db.query(`UPDATE node SET irrigation_efficiency = 0 WHERE name = 'New farm'`)).rejects.toThrow(/check constraint/);
	});
});
