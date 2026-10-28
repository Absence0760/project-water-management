// Migration 264 (issue #616): engine 1.105.0 retires the flow-share methods,
// so settings.flowShareMethod and settings.hiLoSplit are stripped from every
// project's settings, and each project whose method was Hi/Lo MAP or specific,
// or whose nodes held a High-MAP area, a Low-MAP area or a manual share, gets
// one settings.flow_share_reset History event listing what it was. Every
// other setting, and every other project, stays as it was; the node columns
// stay (the contract migration drops them). This builds a throwaway database
// at the schema before 264, stores settings and nodes the old way, applies
// 264 and checks.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const FILE = '264_retire_flow_share_method.sql';
const dbName = `water_test_m264_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// HILO: Hi/Lo MAP with a split and hi/lo areas. MANUAL: specific shares. AREA_VALUES: on area, with a leftover
// High-MAP area. AREA: on area with nothing else (the default). UNSET: never chose a method, no values.
const [HILO, MANUAL, AREA_VALUES, AREA, UNSET] = [id(1), id(2), id(3), id(4), id(5)];
const [H_OUT, H_UP, H_LOW, M_OUT, M_A, M_B, AV_UP, A_UP] = [id(11), id(12), id(13), id(21), id(22), id(23), id(31), id(41)];
const OTHER = { lakeEvapFactor: 0.7, apanMm: new Array<number>(12).fill(150), droughtRestriction: { reviewDates: ['10-01'], levels: [] } };

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '264')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	const project = (pid: string, settings: unknown) =>
		db.query(`INSERT INTO project (id, name, created_by, settings) VALUES ($1, $2, $3, $4)`, [pid, `P ${pid.slice(-1)}`, user, JSON.stringify(settings)]);
	await project(HILO, { ...OTHER, flowShareMethod: 'hiLo', hiLoSplit: { hi: 0.65, lo: 0.35 } });
	await project(MANUAL, { flowShareMethod: 'manual' });
	await project(AREA_VALUES, { ...OTHER, flowShareMethod: 'area', hiLoSplit: { hi: 0.5, lo: 0.5 } });
	await project(AREA, { ...OTHER, flowShareMethod: 'area' });
	await project(UNSET, OTHER);
	const node = (nid: string, pid: string, name: string, kind: string, down: string | null, sortOrder: number, extra: Record<string, unknown> = {}) => {
		const cols = Object.keys(extra);
		return db.query(
			`INSERT INTO node (id, project_id, name, kind, downstream_node_id, sort_order${cols.map((c) => `, ${c}`).join('')}) VALUES ($1, $2, $3, $4, $5, $6${cols.map((_, i) => `, $${i + 7}`).join('')})`,
			[nid, pid, name, kind, down, sortOrder, ...Object.values(extra)]
		);
	};
	await node(H_OUT, HILO, 'Outlet', 'gauge', null, 0);
	await node(H_LOW, HILO, 'Lower', 'farm', H_OUT, 2, { area_km2: 8, area_hi_km2: 1.25, area_lo_km2: 6.75 });
	await node(H_UP, HILO, 'Upper', 'farm', H_LOW, 1, { area_km2: 5, area_hi_km2: 5, area_lo_km2: 0 });
	await node(M_OUT, MANUAL, 'Outlet', 'gauge', null, 0);
	await node(M_A, MANUAL, 'A', 'farm', M_OUT, 1, { flow_share_manual: 0.4 });
	// A farm with no manual share took 0 (the engine warned): it held nothing other than the defaults, so it isn't listed.
	await node(M_B, MANUAL, 'B', 'farm', M_OUT, 1);
	await node(AV_UP, AREA_VALUES, 'Upper', 'farm', null, 0, { area_km2: 3, area_hi_km2: 3 });
	await node(A_UP, AREA, 'Upper', 'farm', null, 0, { area_km2: 3 });
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
			`SELECT subject, actor_user_id, actor_label FROM audit_event WHERE project_id = $1 AND kind = 'settings.flow_share_reset'`,
			[pid]
		)
	).rows;

describe('migration 264: the flow-share methods are retired', () => {
	it('strips flowShareMethod and hiLoSplit from every project, every other setting untouched', async () => {
		expect(await settingsOf(HILO)).toEqual(OTHER);
		expect(await settingsOf(MANUAL)).toEqual({});
		expect(await settingsOf(AREA_VALUES)).toEqual(OTHER);
		expect(await settingsOf(AREA)).toEqual(OTHER);
		expect(await settingsOf(UNSET)).toEqual(OTHER);
	});

	it('records a Hi/Lo MAP project on its History with the split and each unit’s areas, and no actor', async () => {
		expect(await eventsOf(HILO)).toEqual([
			{
				subject: {
					method: 'hiLo',
					hiLoSplit: { hi: 0.65, lo: 0.35 },
					units: [
						{ id: H_UP, name: 'Upper', areaHiKm2: 5, areaLoKm2: 0, flowShareManual: null },
						{ id: H_LOW, name: 'Lower', areaHiKm2: 1.25, areaLoKm2: 6.75, flowShareManual: null }
					]
				},
				actor_user_id: null,
				actor_label: ''
			}
		]);
	});

	it('records a specific-shares project with each unit’s share (a split never set reads null), and an area project whose nodes held a value', async () => {
		expect((await eventsOf(MANUAL)).map((e) => e.subject)).toEqual([
			{ method: 'manual', hiLoSplit: null, units: [{ id: M_A, name: 'A', areaHiKm2: 0, areaLoKm2: 0, flowShareManual: 0.4 }] }
		]);
		expect((await eventsOf(AREA_VALUES)).map((e) => e.subject)).toEqual([
			{ method: 'area', hiLoSplit: { hi: 0.5, lo: 0.5 }, units: [{ id: AV_UP, name: 'Upper', areaHiKm2: 3, areaLoKm2: 0, flowShareManual: null }] }
		]);
	});

	it('records nothing for a project on area with nothing else, set or never set (positive control: the three above)', async () => {
		for (const pid of [AREA, UNSET]) expect(await eventsOf(pid)).toEqual([]);
	});

	it('leaves the node columns as they were (the contract migration drops them)', async () => {
		const { rows } = await db.query('SELECT id, area_km2, area_hi_km2, area_lo_km2, flow_share_manual FROM node WHERE id = ANY($1) ORDER BY id', [[H_LOW, M_A]]);
		expect(rows).toEqual([
			{ id: H_LOW, area_km2: 8, area_hi_km2: 1.25, area_lo_km2: 6.75, flow_share_manual: null },
			{ id: M_A, area_km2: 0, area_hi_km2: 0, area_lo_km2: 0, flow_share_manual: 0.4 }
		]);
	});

	it('is idempotent: a second run changes nothing and records no second event', async () => {
		const state = async () => ({
			settings: (await db.query('SELECT id, settings FROM project ORDER BY id')).rows,
			events: (await db.query(`SELECT project_id, count(*)::int AS n FROM audit_event WHERE kind = 'settings.flow_share_reset' GROUP BY project_id ORDER BY project_id`)).rows
		});
		const before = await state();
		await db.query(await readFile(join(DIR, FILE), 'utf8'));
		expect(await state()).toEqual(before);
		expect(before.events).toEqual([
			{ project_id: HILO, n: 1 },
			{ project_id: MANUAL, n: 1 },
			{ project_id: AREA_VALUES, n: 1 }
		]);
	});
});
