// Migration 213 (issue #507): licence data never drives the baseline, so a
// project stored with settings.allocationMode 'cap' or 'fullAllocation' moves
// to 'none' (compare only), and the move is recorded on its History as a
// settings.allocation_mode_reset event with the mode it had. Every other key
// and project is left as it was. This builds a throwaway database at the
// schema before 213, stores settings the old way, applies 213 and checks.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m213_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAP = id(1);
const FULL = id(2);
const COMPARE = id(3);
const ABSENT = id(4);
const NULLED = id(5);

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '213')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	const settings: [string, unknown][] = [
		[CAP, { allocationMode: 'cap', allocationTolerance: 0.2, lakeEvapFactor: 0.75 }],
		[FULL, { allocationMode: 'fullAllocation' }],
		[COMPARE, { allocationMode: 'none', allocationTolerance: 0.3 }],
		[ABSENT, { lakeEvapFactor: 0.7 }],
		// Not a string: the engine already reads it as 'none', so it is left for mergeSettings.
		[NULLED, { allocationMode: null }]
	];
	for (const [pid, s] of settings) await db.query(`INSERT INTO project (id, name, created_by, settings) VALUES ($1, $2, $3, $4)`, [pid, `P ${pid.slice(-1)}`, user, JSON.stringify(s)]);
	await db.query(await readFile(join(DIR, '213_baseline_allocation_compare_only.sql'), 'utf8'));
});

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const settingsOf = async (pid: string) => (await db.query<{ settings: Record<string, unknown> }>('SELECT settings FROM project WHERE id = $1', [pid])).rows[0]!.settings;
const eventsOf = async (pid: string) =>
	(
		await db.query<{ kind: string; subject: unknown; actor_user_id: string | null; actor_label: string }>(
			`SELECT kind, subject, actor_user_id, actor_label FROM audit_event WHERE project_id = $1 AND kind = 'settings.allocation_mode_reset'`,
			[pid]
		)
	).rows;

describe('migration 213: the baseline compares registered volumes only', () => {
	it('moves a cap and a full allocation to compare only, keeping every other key', async () => {
		expect(await settingsOf(CAP)).toEqual({ allocationMode: 'none', allocationTolerance: 0.2, lakeEvapFactor: 0.75 });
		expect(await settingsOf(FULL)).toEqual({ allocationMode: 'none' });
	});

	it('records each move on the project’s History, with the mode it had and no actor', async () => {
		expect(await eventsOf(CAP)).toEqual([{ kind: 'settings.allocation_mode_reset', subject: { from: 'cap', to: 'none' }, actor_user_id: null, actor_label: '' }]);
		expect(await eventsOf(FULL)).toEqual([{ kind: 'settings.allocation_mode_reset', subject: { from: 'fullAllocation', to: 'none' }, actor_user_id: null, actor_label: '' }]);
	});

	it('leaves compare only, an absent key and a non-string one as they were, with no event (positive control)', async () => {
		expect(await settingsOf(COMPARE)).toEqual({ allocationMode: 'none', allocationTolerance: 0.3 });
		expect(await settingsOf(ABSENT)).toEqual({ lakeEvapFactor: 0.7 });
		expect(await settingsOf(NULLED)).toEqual({ allocationMode: null });
		for (const pid of [COMPARE, ABSENT, NULLED]) expect(await eventsOf(pid)).toEqual([]);
	});
});
