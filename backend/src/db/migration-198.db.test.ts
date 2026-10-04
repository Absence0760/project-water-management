// Migration 198 (engine 1.72.0): a project's irrigation systems, a crop's
// default and a unit's own system for a crop, backfilled so every saved model
// runs as before. This builds a throwaway database at the schema before 198,
// stores crops, plantings and units the old way, applies 198 and checks what
// each became (docs/data-model.md § Migrations, docs/model.md §2.3).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m198_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

async function apply(file: string) {
	await db.query(await readFile(join(DIR, file), 'utf8'));
}

const PROJECT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const [DRIP_FARM, ODD_FARM, CITRUS, PASTURE, ODD_CROP, WHEAT] = [id(1), id(2), id(11), id(12), id(13), id(14)];

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '198')) await apply(f);
	const owner = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('m@example.com', 'M', 'x') RETURNING id`)).rows[0]!.id;
	await db.query(`INSERT INTO project (id, name, created_by) VALUES ($1, 'Migration', $3), ($2, 'Untouched', $3)`, [PROJECT, OTHER, owner]);
	// A unit on drip's 90 % and one on a workbook's 77 %; citrus with its own 82 %, pasture with none, a crop with its own 66 %.
	await db.query(
		`INSERT INTO node (id, project_id, name, kind, irrigation_efficiency, return_flow_fraction) VALUES
			($1, $3, 'Drip farm', 'farm', 0.9, 0.05), ($2, $3, 'Workbook farm', 'farm', 0.77, 0.1)`,
		[DRIP_FARM, ODD_FARM, PROJECT]
	);
	await db.query(
		`INSERT INTO crop (id, project_id, name, crop_factor, irrigation_efficiency) VALUES
			($1, $4, 'Citrus', array_fill(0.6::float8, ARRAY[12]), 0.82),
			($2, $4, 'Pasture', array_fill(0.7::float8, ARRAY[12]), NULL),
			($3, $4, 'Odd', array_fill(0.5::float8, ARRAY[12]), 0.66),
			($5, $4, 'Wheat', array_fill(0.4::float8, ARRAY[12]), NULL)`,
		[CITRUS, PASTURE, ODD_CROP, PROJECT, WHEAT]
	);
	await db.query(
		`INSERT INTO crop_area (project_id, node_id, crop_id, area_m2) VALUES
			($1, $2, $4, 1000), ($1, $2, $5, 1000), ($1, $3, $5, 1000), ($1, $3, $6, 1000), ($1, $2, $7, 1000)`,
		[PROJECT, DRIP_FARM, ODD_FARM, CITRUS, PASTURE, ODD_CROP, WHEAT]
	);
	await apply('198_irrigation_systems.sql');
}, 120_000);

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const systems = async (project: string) =>
	(await db.query<{ id: string; name: string; efficiency: number; preset: string | null }>('SELECT id, name, efficiency, preset FROM irrigation_system WHERE project_id = $1 ORDER BY sort_order', [project])).rows;
const systemOf = async (sql: string, params: unknown[]) => {
	const sid = (await db.query<{ s: string | null }>(sql, params)).rows[0]!.s;
	return sid === null ? null : (await db.query<{ name: string }>('SELECT name FROM irrigation_system WHERE id = $1', [sid])).rows[0]!.name;
};

describe('migration 198: irrigation systems', () => {
	it('gives every project the SABI rows, and a row for each efficiency in use that none has', async () => {
		expect((await systems(OTHER)).map((s) => s.preset)).toEqual(['drip', 'micro', 'pivot', 'sprinkler', 'movable', 'surface']);
		const mine = await systems(PROJECT);
		expect(mine.slice(0, 6).map((s) => [s.name, s.efficiency])).toEqual([
			['Drip', 0.9],
			['Micro-sprinkler', 0.82],
			['Centre pivot / linear move', 0.85],
			['Sprinkler (permanent)', 0.8],
			['Sprinkler (movable)', 0.75],
			['Flood / furrow', 0.7]
		]);
		// 0.82 and 0.9 are SABI rows; 0.77 (a unit's) and 0.66 (a crop's) are not.
		expect(mine.slice(6).map((s) => [s.name, s.efficiency, s.preset])).toEqual([
			['Imported, 77 %', 0.77, null],
			['Imported, 66 %', 0.66, null]
		]);
	});

	it('runs each planting as before: a crop’s own efficiency is its default; without one, its farms’ (one) or each farm’s (several)', async () => {
		expect(await systemOf('SELECT irrigation_system_id AS s FROM crop WHERE id = $1', [CITRUS])).toBe('Micro-sprinkler');
		expect(await systemOf('SELECT irrigation_system_id AS s FROM crop WHERE id = $1', [PASTURE])).toBe(null);
		expect(await systemOf('SELECT irrigation_system_id AS s FROM crop WHERE id = $1', [ODD_CROP])).toBe('Imported, 66 %');
		const planting = (node: string, crop: string) => systemOf('SELECT irrigation_system_id AS s FROM crop_area WHERE node_id = $1 AND crop_id = $2', [node, crop]);
		// Citrus and Odd keep their own (the crop's default); Pasture takes each unit's.
		expect(await planting(DRIP_FARM, CITRUS)).toBe(null);
		expect(await planting(DRIP_FARM, PASTURE)).toBe('Drip');
		expect(await planting(ODD_FARM, PASTURE)).toBe('Imported, 77 %');
		expect(await planting(ODD_FARM, ODD_CROP)).toBe(null);
		// Wheat grows on the drip farm only: drip is its default, and its planting needs none of its own.
		expect(await systemOf('SELECT irrigation_system_id AS s FROM crop WHERE id = $1', [WHEAT])).toBe('Drip');
		expect(await planting(DRIP_FARM, WHEAT)).toBe(null);
		expect((await db.query(`SELECT * FROM crop WHERE id = $1`, [CITRUS])).rows[0]).not.toHaveProperty('irrigation_efficiency');
	});

	it('seeds a new project, holds a row to its project, and lets a unit’s return flow exceed its own efficiency’s losses', async () => {
		const owner = (await db.query<{ id: string }>('SELECT id FROM app_user LIMIT 1')).rows[0]!.id;
		const fresh = (await db.query<{ id: string }>(`INSERT INTO project (name, created_by) VALUES ('Fresh', $1) RETURNING id`, [owner])).rows[0]!.id;
		expect(await systems(fresh)).toHaveLength(6);
		const theirs = (await systems(OTHER))[0]!.id;
		await expect(db.query(`UPDATE crop SET irrigation_system_id = $1 WHERE id = $2`, [theirs, CITRUS])).rejects.toThrow(/different project/);
		// 197's per-node CHECK is gone: the API checks the return flow against the blended efficiency.
		await db.query(`UPDATE node SET return_flow_fraction = 0.3 WHERE id = $1`, [DRIP_FARM]);
		// A row deleted leaves its crops and plantings on none.
		const odd = (await systems(PROJECT)).find((s) => s.name === 'Imported, 66 %')!.id;
		await db.query('DELETE FROM irrigation_system WHERE id = $1', [odd]);
		expect(await systemOf('SELECT irrigation_system_id AS s FROM crop WHERE id = $1', [ODD_CROP])).toBe(null);
	});
});
