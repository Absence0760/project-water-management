// Migration 197 (engine 1.71.0): a farm's return flow becomes a share r of the
// water supplied, backfilled from 006's share of the losses β as r = β(1 − e).
// This builds a throwaway database at the schema before 197, stores nodes the
// old way, applies 197 and checks what each became (docs/data-model.md §
// Migrations, docs/engine-audit.md N1).
import { NEW_FARM_IRRIGATION } from '@water-management/engine';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m197_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
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
	for (const f of files.filter((x) => x < '197')) await apply(f);
	const owner = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('m@example.com', 'M', 'x') RETURNING id`)).rows[0]!.id;
	await db.query(`INSERT INTO project (id, name, created_by) VALUES ($1, 'Migration', $2)`, [PROJECT, owner]);
	// Half of drip's losses; all of a workbook farm's (006's e = 1 − r, β = 1); none; and a gauge at the old defaults.
	await db.query(
		`INSERT INTO node (id, project_id, name, kind, irrigation_efficiency, loss_return_fraction) VALUES
			($1, $5, 'Half of drip''s losses', 'farm', 0.9, 0.5),
			($2, $5, 'Workbook farm', 'farm', 0.8, 1),
			($3, $5, 'No return', 'farm', 1, 0),
			($4, $5, 'Gauge', 'gauge', 0.9, 0.5)`,
		[node(1), node(2), node(3), node(4), PROJECT]
	);
	await apply('197_return_flow_fraction.sql');
}, 120_000);

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const row = async (id: string) => (await db.query('SELECT * FROM node WHERE id = $1', [id])).rows[0] as Record<string, unknown>;

describe('migration 197: the return flow, a share of the water supplied', () => {
	it('backfills r = β(1 − e), so each saved model returns what it did, and drops β', async () => {
		expect((await row(node(1))).return_flow_fraction).toBeCloseTo(0.05, 12);
		expect((await row(node(2))).return_flow_fraction).toBeCloseTo(0.2, 12);
		expect((await row(node(3))).return_flow_fraction).toBe(0);
		expect((await row(node(4))).return_flow_fraction).toBeCloseTo(0.05, 12);
		expect(await row(node(1))).not.toHaveProperty('loss_return_fraction');
	});

	it('defaults a new farm to the engine’s 10 % at 90 % efficiency (all of drip’s losses)', async () => {
		await db.query(`INSERT INTO node (project_id, name, kind) VALUES ($1, 'New farm', 'farm')`, [PROJECT]);
		const r = (await db.query(`SELECT irrigation_efficiency, return_flow_fraction FROM node WHERE name = 'New farm'`)).rows[0];
		expect(r).toEqual({ irrigation_efficiency: NEW_FARM_IRRIGATION.irrigationEfficiency, return_flow_fraction: NEW_FARM_IRRIGATION.returnFlowFraction });
	});

	it('refuses a return flow above the losses 1 − e, and outside 0–1; all the losses at the cap is fine', async () => {
		await expect(db.query(`UPDATE node SET return_flow_fraction = 0.25 WHERE id = $1`, [node(2)])).rejects.toThrow(/node_return_flow_within_losses/);
		await expect(db.query(`UPDATE node SET return_flow_fraction = -0.1 WHERE id = $1`, [node(2)])).rejects.toThrow(/check constraint/);
		// Raising the efficiency past what the stored return flow allows is refused too.
		await expect(db.query(`UPDATE node SET irrigation_efficiency = 0.9 WHERE id = $1`, [node(2)])).rejects.toThrow(/node_return_flow_within_losses/);
		await db.query(`UPDATE node SET return_flow_fraction = 0.1, irrigation_efficiency = 0.9 WHERE id = $1`, [node(2)]);
		expect(await row(node(2))).toMatchObject({ irrigation_efficiency: 0.9, return_flow_fraction: 0.1 });
	});
});
