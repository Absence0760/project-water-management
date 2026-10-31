// Migration 286 (issue #658): engine 1.109.0 retires the Fragmentation flow
// generation method, so every project's settings.unitRain becomes Per unit,
// keeping its gauge MAP, MAP period and reference gauge, and each project that
// was not on Per unit gets one settings.flow_method_reset History event saying
// what it was. A project already on Per unit is left as it was, and so is
// every other setting. This builds a throwaway database at the schema before
// 286, stores settings the old way, applies 286 and checks.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const FILE = '286_retire_fragmentation.sql';
const dbName = `water_test_m286_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// UNSET: never chose (Fragmentation, the default). NULLED: unitRain null. CATCHMENT: Fragmentation chosen, with a
// gauge MAP, a MAP period and a reference kept. FITTED: Fragmentation with a fit record. PER_UNIT: already Per unit.
// NO_MODE: an object with no mode. SCALAR: not an object at all. NULL_FIT: fitRecord null. ZONE_FIT: only a zone's fit.
const [UNSET, NULLED, CATCHMENT, FITTED, PER_UNIT, NO_MODE, SCALAR, NULL_FIT, ZONE_FIT] = [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8), id(9)];
const OTHER = { lakeEvapFactor: 0.7, apanMm: new Array<number>(12).fill(150), rainStations: { units: { u1: { stationId: 's1' } } } };
const KEPT = { gaugeMapMm: 640, gaugeMapSource: 'Synthetic gauge record', mapPeriod: { start: '1991-01-01', end: '2020-12-31' }, reference: { gauge: 'rain_catchment_mm', unitId: 'u1' } };
const FIT = { model: 'gr4j', params: { x1: 300, x2: 0, x3: 80, x4: 1.5 }, engineVersion: '1.108.0', forcing: { panCoefficient: [] } };

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '286')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	const project = (pid: string, settings: unknown) =>
		db.query(`INSERT INTO project (id, name, created_by, settings) VALUES ($1, $2, $3, $4)`, [pid, `P ${pid.slice(-1)}`, user, JSON.stringify(settings)]);
	await project(UNSET, OTHER);
	await project(NULLED, { ...OTHER, unitRain: null });
	await project(CATCHMENT, { ...OTHER, unitRain: { mode: 'catchment', ...KEPT } });
	await project(FITTED, { unitRain: { mode: 'catchment' }, fitRecord: FIT });
	await project(PER_UNIT, { ...OTHER, unitRain: { mode: 'perUnit', ...KEPT }, fitRecord: FIT });
	await project(NO_MODE, { unitRain: { gaugeMapMm: 640, gaugeMapSource: 'Synthetic' } });
	await project(SCALAR, { unitRain: 'catchment' });
	await project(NULL_FIT, { unitRain: { mode: 'catchment' }, fitRecord: null });
	await project(ZONE_FIT, { calibrationZones: [{ nodeId: 'g1', enabled: true, fitRecord: FIT }, { nodeId: 'g2', enabled: false }] });
	await db.query(await readFile(join(DIR, FILE), 'utf8'));
});

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const settingsOf = async (pid: string) => (await db.query<{ settings: Record<string, unknown> }>('SELECT settings FROM project WHERE id = $1', [pid])).rows[0]!.settings;
const eventsOf = async (pid: string) =>
	(
		await db.query<{ subject: unknown; actor_user_id: string | null; actor_label: string }>(
			`SELECT subject, actor_user_id, actor_label FROM audit_event WHERE project_id = $1 AND kind = 'settings.flow_method_reset'`,
			[pid]
		)
	).rows;

describe('migration 286: Fragmentation is retired, every project runs Per unit', () => {
	it('moves a project that never chose, or chose null, to Per unit, every other setting untouched', async () => {
		expect(await settingsOf(UNSET)).toEqual({ ...OTHER, unitRain: { mode: 'perUnit' } });
		expect(await settingsOf(NULLED)).toEqual({ ...OTHER, unitRain: { mode: 'perUnit' } });
	});

	it('moves a project on catchment mode to Per unit, keeping its gauge MAP, MAP period and reference gauge', async () => {
		expect(await settingsOf(CATCHMENT)).toEqual({ ...OTHER, unitRain: { mode: 'perUnit', ...KEPT } });
	});

	it('keeps the fit record as it was (the engine reads it as not fitted for this method)', async () => {
		expect(await settingsOf(FITTED)).toEqual({ unitRain: { mode: 'perUnit' }, fitRecord: FIT });
	});

	it('records each moved project on its History, what it was and whether it had a fit, with no actor', async () => {
		expect(await eventsOf(UNSET)).toEqual([{ subject: { unitRain: null, fitted: false }, actor_user_id: null, actor_label: '' }]);
		expect((await eventsOf(NULLED)).map((e) => e.subject)).toEqual([{ unitRain: null, fitted: false }]);
		expect((await eventsOf(CATCHMENT)).map((e) => e.subject)).toEqual([{ unitRain: { mode: 'catchment', ...KEPT }, fitted: false }]);
		expect((await eventsOf(FITTED)).map((e) => e.subject)).toEqual([{ unitRain: { mode: 'catchment' }, fitted: true }]);
	});

	it('adds the mode to an object without one, replaces a value that is no object, and counts a zone’s fit as a fit', async () => {
		expect((await settingsOf(NO_MODE)).unitRain).toEqual({ gaugeMapMm: 640, gaugeMapSource: 'Synthetic', mode: 'perUnit' });
		expect((await settingsOf(SCALAR)).unitRain).toEqual({ mode: 'perUnit' });
		expect((await eventsOf(SCALAR)).map((e) => e.subject)).toEqual([{ unitRain: 'catchment', fitted: false }]);
		expect((await eventsOf(NULL_FIT)).map((e) => e.subject)).toEqual([{ unitRain: { mode: 'catchment' }, fitted: false }]);
		expect((await eventsOf(ZONE_FIT)).map((e) => e.subject)).toEqual([{ unitRain: null, fitted: true }]);
		expect((await settingsOf(ZONE_FIT)).calibrationZones).toEqual([{ nodeId: 'g1', enabled: true, fitRecord: FIT }, { nodeId: 'g2', enabled: false }]);
	});

	it('leaves a project already on Per unit as it was, and records nothing for it (positive control: the others)', async () => {
		expect(await settingsOf(PER_UNIT)).toEqual({ ...OTHER, unitRain: { mode: 'perUnit', ...KEPT }, fitRecord: FIT });
		expect(await eventsOf(PER_UNIT)).toEqual([]);
	});

	it('is idempotent: a second run changes nothing and records no second event', async () => {
		const state = async () => ({
			settings: (await db.query('SELECT id, settings FROM project ORDER BY id')).rows,
			events: (await db.query(`SELECT project_id, count(*)::int AS n FROM audit_event WHERE kind = 'settings.flow_method_reset' GROUP BY project_id ORDER BY project_id`)).rows
		});
		const before = await state();
		await db.query(await readFile(join(DIR, FILE), 'utf8'));
		expect(await state()).toEqual(before);
		expect(before.events).toEqual([
			{ project_id: UNSET, n: 1 },
			{ project_id: NULLED, n: 1 },
			{ project_id: CATCHMENT, n: 1 },
			{ project_id: FITTED, n: 1 },
			{ project_id: NO_MODE, n: 1 },
			{ project_id: SCALAR, n: 1 },
			{ project_id: NULL_FIT, n: 1 },
			{ project_id: ZONE_FIT, n: 1 }
		]);
	});
});
