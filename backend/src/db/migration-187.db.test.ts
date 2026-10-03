// Migration 187 (engine 1.69.0, erratum ER-17): a stored negative month in
// settings.apanMm or settings.ewrPragmaticM3PerDay becomes 0, so the Settings
// tab's whole-object save passes the tightened schema; every other value,
// key and project is left as it was. This builds a throwaway database at the
// schema before 187, stores settings the old way, applies 187 and checks
// what each became.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m187_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NEGATIVE = id(1);
const CLEAN = id(2);
const ODD = id(3);
const NONE = id(4);

const apan = [150, -20, 200, 210, 180, 150, 100, 60, 40, 40, 60, -0.5];
const ewr = [-1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const clean = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '187')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	const settings: [string, unknown][] = [
		[NEGATIVE, { apanMm: apan, ewrPragmaticM3PerDay: ewr, lakeEvapFactor: 0.75 }],
		[CLEAN, { apanMm: clean, ewrPragmaticM3PerDay: clean }],
		// Not a number in one month, and a row of the wrong shape: left for mergeSettings.
		[ODD, { apanMm: ['x', -3, null], ewrPragmaticM3PerDay: 'none' }],
		[NONE, {}]
	];
	for (const [pid, s] of settings) await db.query(`INSERT INTO project (id, name, created_by, settings) VALUES ($1, $2, $3, $4)`, [pid, `P ${pid.slice(-1)}`, user, JSON.stringify(s)]);
	await db.query(await readFile(join(DIR, '187_settings_nonneg_monthly.sql'), 'utf8'));
});

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const settingsOf = async (pid: string) => (await db.query<{ settings: Record<string, unknown> }>('SELECT settings FROM project WHERE id = $1', [pid])).rows[0]!.settings;

describe('migration 187: no negative month in stored A-pan or pragmatic EWR', () => {
	it('turns each negative month into 0 and keeps the others and the other keys', async () => {
		const s = await settingsOf(NEGATIVE);
		expect(s.apanMm).toEqual(apan.map((v) => Math.max(v, 0)));
		expect(s.ewrPragmaticM3PerDay).toEqual(ewr.map((v) => Math.max(v, 0)));
		expect(s.lakeEvapFactor).toBe(0.75);
	});

	it('leaves rows with nothing negative, odd rows and absent keys as they were (positive control)', async () => {
		expect(await settingsOf(CLEAN)).toEqual({ apanMm: clean, ewrPragmaticM3PerDay: clean });
		// Only the number −3 is clamped in a row of the wrong shape; the rest is mergeSettings' to fall back on.
		expect(await settingsOf(ODD)).toEqual({ apanMm: ['x', 0, null], ewrPragmaticM3PerDay: 'none' });
		expect(await settingsOf(NONE)).toEqual({});
	});
});
