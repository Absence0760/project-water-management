// Migration 267 (issue #555): engine 1.106.0's calibration zones. Every
// project without settings.calibrationZones gets the empty list (only the
// outlet, or the calibration site, ticked: today's one parameter set), and
// every other setting, today's single site and parameters included, stays as
// it was; a project that already has zones keeps them, and a re-run changes
// nothing. This builds a throwaway database at the schema before 267, stores
// settings the old way, applies 267 and checks.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const FILE = '267_calibration_sites.sql';
const dbName = `water_test_m267_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// SITE: calibrated at an inner gauge with a fit. OUTLET: the defaults. ZONED: already has a zone row. EMPTY: no settings at all.
// ODD: settings that aren't an object (never written by the API), left alone.
const [SITE, OUTLET, ZONED, EMPTY, ODD] = [id(1), id(2), id(3), id(4), id(5)];
const GAUGE = id(11);
const FIT = { fittedAt: '2026-10-01T00:00:00.000Z', siteNodeId: GAUGE, params: { x1: 512, x2: 0, x3: 80, x4: 2.1 } };
const SITE_SETTINGS = {
	calibrationSiteNodeId: GAUGE,
	calibrationStart: '2001-10-01',
	calibrationEnd: '2010-09-30',
	calibrationFlowKind: 'flow_logger_m3s',
	calibrationExclusions: [{ waterYear: 2004, reason: 'weir rebuilt' }],
	gr4j: { x1: 512, x2: 0, x3: 80, x4: 2.1, warmupDays: 365 },
	fitRecord: FIT,
	lakeEvapFactor: 0.7
};
const ZONE = { nodeId: GAUGE, enabled: true, calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null, calibrationExclusions: [], qualityFlags: null, gr4j: { x1: 900, x2: 0, x3: 220, x4: 3.1 }, fitRecord: null };

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '267')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	const project = (pid: string, settings: unknown) =>
		db.query(`INSERT INTO project (id, name, created_by, settings) VALUES ($1, $2, $3, $4)`, [pid, `P ${pid.slice(-1)}`, user, JSON.stringify(settings)]);
	await project(SITE, SITE_SETTINGS);
	await project(OUTLET, { lakeEvapFactor: 0.7 });
	await project(ZONED, { calibrationZones: [ZONE] });
	await project(EMPTY, {});
	await project(ODD, []);
	await db.query(await readFile(join(DIR, FILE), 'utf8'));
});

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const settingsOf = async (pid: string) => (await db.query<{ settings: Record<string, unknown> }>('SELECT settings FROM project WHERE id = $1', [pid])).rows[0]!.settings;

describe('migration 267: calibration zones', () => {
	it('writes the empty list into every project without one, and keeps every other setting', async () => {
		expect(await settingsOf(SITE)).toEqual({ ...SITE_SETTINGS, calibrationZones: [] });
		expect(await settingsOf(OUTLET)).toEqual({ lakeEvapFactor: 0.7, calibrationZones: [] });
		expect(await settingsOf(EMPTY)).toEqual({ calibrationZones: [] });
	});

	it('leaves settings that aren’t an object alone', async () => {
		expect(await settingsOf(ODD)).toEqual([]);
	});

	it('keeps a project’s zones as they are', async () => {
		expect(await settingsOf(ZONED)).toEqual({ calibrationZones: [ZONE] });
	});

	it('is a no-op when run again', async () => {
		const before = (await db.query('SELECT id, settings FROM project ORDER BY id')).rows;
		await db.query(await readFile(join(DIR, FILE), 'utf8'));
		expect((await db.query('SELECT id, settings FROM project ORDER BY id')).rows).toEqual(before);
	});
});
