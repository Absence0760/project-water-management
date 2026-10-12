// Migration 220 (issue #523 B4): in the baseline the EWR is assessed and
// reported, never applied, so the stored rules that keep water for it (a
// pass-inflow release without amounts, a unit's or an off-take's
// hands_off_ewr, the drought restriction's ewrTrigger) are switched off, and
// each project's History gets one model.ewr_rules_reset event listing what
// was switched off. Set flows (a hands-off flow by month, a pass-inflow
// release with amounts) and every other project stay as they were. This
// builds a throwaway database at the schema before 220, stores rules the old
// way, applies 220 and checks.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m220_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Project KEEPS has all four rules (and set flows beside them); SET_FLOWS only set flows; PLAIN none.
const KEEPS = id(1);
const SET_FLOWS = id(2);
const PLAIN = id(3);
const [UP, DOWN, OUT, SF_UP, SF_DOWN, PL_UP] = [id(11), id(12), id(13), id(21), id(22), id(31)];
const [T_EWR, T_SET] = [id(41), id(42)];
const RESTRICTION = { reviewDates: ['10-01'], levels: [{ belowPct: 0.4, cuts: { crops: 0.2 } }] };

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '220')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	const project = (pid: string, settings: unknown) =>
		db.query(`INSERT INTO project (id, name, created_by, settings) VALUES ($1, $2, $3, $4)`, [pid, `P ${pid.slice(-1)}`, user, JSON.stringify(settings)]);
	await project(KEEPS, { lakeEvapFactor: 0.7, droughtRestriction: { ...RESTRICTION, ewrTrigger: { siteNodeId: null, level: 1 } } });
	await project(SET_FLOWS, { droughtRestriction: RESTRICTION });
	await project(PLAIN, {});
	const node = (nid: string, pid: string, name: string, kind: string, down: string | null, extra: Record<string, unknown> = {}) => {
		const cols = Object.keys(extra);
		return db.query(
			`INSERT INTO node (id, project_id, name, kind, downstream_node_id${cols.map((c) => `, ${c}`).join('')}) VALUES ($1, $2, $3, $4, $5${cols.map((_, i) => `, $${i + 6}`).join('')})`,
			[nid, pid, name, kind, down, ...Object.values(extra)]
		);
	};
	const flat = (v: number) => new Array<number>(12).fill(v);
	await node(OUT, KEEPS, 'Outlet', 'gauge', null);
	await node(DOWN, KEEPS, 'Lower', 'farm', OUT, { dam_capacity_m3: 5000, hands_off_ewr: true, hands_off_m3_day: flat(15) });
	await node(UP, KEEPS, 'Upper', 'farm', DOWN, { dam_capacity_m3: 9000, dam_release_rule: 'passInflow' });
	await node(SF_DOWN, SET_FLOWS, 'Lower', 'farm', null, { hands_off_m3_day: flat(10) });
	await node(SF_UP, SET_FLOWS, 'Upper', 'farm', SF_DOWN, { dam_capacity_m3: 9000, dam_release_rule: 'passInflow', dam_release_m3_day: flat(30) });
	await node(PL_UP, PLAIN, 'Only', 'farm', null, { dam_release_rule: 'fixed', dam_release_m3_day: flat(5) });
	await db.query(`INSERT INTO transfer (id, project_id, from_node_id, to_node_id, source, hands_off_ewr) VALUES ($1, $2, $3, $4, 'river', true)`, [T_EWR, KEEPS, UP, DOWN]);
	await db.query(`INSERT INTO transfer (id, project_id, from_node_id, to_node_id, source, hands_off_m3_day) VALUES ($1, $2, $3, $4, 'river', 40)`, [T_SET, SET_FLOWS, SF_UP, SF_DOWN]);
	await db.query(await readFile(join(DIR, '220_baseline_ewr_rules_scenario_only.sql'), 'utf8'));
});

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const settingsOf = async (pid: string) => (await db.query<{ settings: Record<string, unknown> }>('SELECT settings FROM project WHERE id = $1', [pid])).rows[0]!.settings;
const nodeOf = async (nid: string) =>
	(
		await db.query<{ rule: string; release: number[] | null; ewr: boolean; handsOff: number[] | null }>(
			`SELECT dam_release_rule AS rule, dam_release_m3_day AS release, hands_off_ewr AS ewr, hands_off_m3_day AS "handsOff" FROM node WHERE id = $1`,
			[nid]
		)
	).rows[0]!;
const transferOf = async (tid: string) =>
	(await db.query<{ ewr: boolean; handsOff: number | null }>(`SELECT hands_off_ewr AS ewr, hands_off_m3_day AS "handsOff" FROM transfer WHERE id = $1`, [tid])).rows[0]!;
const eventsOf = async (pid: string) =>
	(
		await db.query<{ subject: unknown; actor_user_id: string | null; actor_label: string }>(
			`SELECT subject, actor_user_id, actor_label FROM audit_event WHERE project_id = $1 AND kind = 'model.ewr_rules_reset'`,
			[pid]
		)
	).rows;

describe('migration 220: the baseline keeps no water for the EWR', () => {
	it('switches off the four rules, keeping the set flow beside a hands-off EWR and every other setting', async () => {
		expect(await nodeOf(UP)).toMatchObject({ rule: 'none', release: null, ewr: false });
		expect(await nodeOf(DOWN)).toMatchObject({ ewr: false, handsOff: new Array(12).fill(15) });
		expect(await transferOf(T_EWR)).toEqual({ ewr: false, handsOff: null });
		expect(await settingsOf(KEEPS)).toEqual({ lakeEvapFactor: 0.7, droughtRestriction: RESTRICTION });
	});

	it('records them on the History, with what each was and no actor', async () => {
		expect(await eventsOf(KEEPS)).toEqual([
			{
				subject: {
					rules: [
						{ kind: 'damPassInflow', id: UP, name: 'Upper' },
						{ kind: 'unitHandsOff', id: DOWN, name: 'Lower' },
						{ kind: 'offtakeHandsOff', id: T_EWR, from: 'Upper', to: 'Lower' },
						{ kind: 'restrictionEwrTrigger', siteNodeId: null, level: 1 }
					]
				},
				actor_user_id: null,
				actor_label: ''
			}
		]);
	});

	it('leaves set flows (a pass-inflow release with amounts, hands-off flows by month) and a fixed release alone, with no event (positive control)', async () => {
		expect(await nodeOf(SF_UP)).toMatchObject({ rule: 'passInflow', release: new Array(12).fill(30), ewr: false });
		expect(await nodeOf(SF_DOWN)).toMatchObject({ ewr: false, handsOff: new Array(12).fill(10) });
		expect(await transferOf(T_SET)).toEqual({ ewr: false, handsOff: 40 });
		expect(await settingsOf(SET_FLOWS)).toEqual({ droughtRestriction: RESTRICTION });
		expect(await nodeOf(PL_UP)).toMatchObject({ rule: 'fixed', release: new Array(12).fill(5) });
		for (const pid of [SET_FLOWS, PLAIN]) expect(await eventsOf(pid)).toEqual([]);
	});

	it('is idempotent: a second run changes nothing and records no second event', async () => {
		const state = async () => ({
			nodes: (await db.query('SELECT id, dam_release_rule, dam_release_m3_day, hands_off_ewr, hands_off_m3_day FROM node ORDER BY id')).rows,
			transfers: (await db.query('SELECT id, hands_off_ewr, hands_off_m3_day FROM transfer ORDER BY id')).rows,
			settings: (await db.query('SELECT id, settings FROM project ORDER BY id')).rows,
			events: (await db.query(`SELECT project_id, count(*)::int AS n FROM audit_event WHERE kind = 'model.ewr_rules_reset' GROUP BY project_id ORDER BY project_id`)).rows
		});
		const before = await state();
		await db.query(await readFile(join(DIR, '220_baseline_ewr_rules_scenario_only.sql'), 'utf8'));
		expect(await state()).toEqual(before);
		expect(before.events).toEqual([{ project_id: KEEPS, n: 1 }]);
	});
});
