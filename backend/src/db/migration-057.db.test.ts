// Migration 057 turns 051's catchment-wide data_stale rules into one rule per
// data feed. This builds a throwaway database at the schema before 057,
// stores rules, events and deliveries the old way, applies 057 and checks
// what each became: one rule per feed at the same level, switch and creator,
// the history kept on the converted rule, and a catchment with no feed
// keeping its choice until its first feed adopts it (docs/data-model.md
// § Alerts).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFeedRules } from '../alerts/evaluate.js';
import type { Db } from './tx.js';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m057_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TWO_FEEDS = id(1); // a project with two feeds, its rule on
const NO_FEEDS = id(2); // a project with no feed, its rule on
const OFF = id(3); // a project with one feed, its rule off
const RULE_TWO = id(11);
const RULE_NONE = id(12);
const RULE_OFF = id(13);
const RULE_JOBS = id(14);
const CHIRPS = id(21); // first in the feeds page's order (source chirps < dws)
const DWS = id(22);
const OFF_FEED = id(23);
let creator: string;
let member: string;

const feed = (fid: string, pid: string, source: 'chirps' | 'dws', name: string) =>
	db.query(`INSERT INTO data_feed (id, project_id, source, config, target_kind, target_name) VALUES ($1, $2, $3, $4, $5, $6)`, [
		fid,
		pid,
		source,
		source === 'dws' ? { station: 'X0H000' } : { cells: [{ lat: -33, lon: 19 }] },
		source === 'dws' ? 'flow_observed_m3s' : 'rain_chirps_mm',
		name
	]);

/** An event on `rule`, with a delivery to `member` (as the schema owner). */
async function event(rule: string, pid: string, state: 'firing' | 'cleared') {
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, $3, 9, '{"feeds":[]}') RETURNING id`,
		[rule, pid, state]
	);
	await db.query(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status, via) VALUES ($1, $2, $3, 'immediate', 'sent', 'immediate')`, [rows[0]!.id, member, pid]);
	return rows[0]!.id;
}

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '057')) await db.query(await readFile(join(DIR, f), 'utf8'));

	creator = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('c@example.com', 'C', 'x') RETURNING id`)).rows[0]!.id;
	member = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('m@example.com', 'M', 'x') RETURNING id`)).rows[0]!.id;
	for (const [pid, name] of [
		[TWO_FEEDS, 'Two feeds'],
		[NO_FEEDS, 'No feeds'],
		[OFF, 'Off']
	] as const)
		await db.query(`INSERT INTO project (id, name, created_by) VALUES ($1, $2, $3)`, [pid, name, creator]);
	await feed(DWS, TWO_FEEDS, 'dws', 'gauge');
	await feed(CHIRPS, TWO_FEEDS, 'chirps', 'Upper');
	await feed(OFF_FEED, OFF, 'chirps', 'Only');

	// The old shape: one data_stale rule per catchment, no feed. The trigger
	// would stamp the (absent) signed-in user as creator, so it is off here.
	await db.query('ALTER TABLE alert_rule DISABLE TRIGGER alert_rule_check');
	await db.query(
		`INSERT INTO alert_rule (id, project_id, kind, threshold, enabled, created_by, created_at) VALUES
			($1, $4, 'data_stale', 7, true, $7, '2026-01-02T00:00:00Z'),
			($2, $5, 'data_stale', 5, true, $7, '2026-01-03T00:00:00Z'),
			($3, $6, 'data_stale', 4, false, $7, '2026-01-04T00:00:00Z'),
			($8, $4, 'job_dead', 1, true, $7, '2026-01-05T00:00:00Z')`,
		[RULE_TWO, RULE_NONE, RULE_OFF, TWO_FEEDS, NO_FEEDS, OFF, creator, RULE_JOBS]
	);
	await db.query('ALTER TABLE alert_rule ENABLE TRIGGER alert_rule_check');
	await event(RULE_TWO, TWO_FEEDS, 'cleared');
	await event(RULE_TWO, TWO_FEEDS, 'firing');
	await event(RULE_NONE, NO_FEEDS, 'cleared');

	await db.query(await readFile(join(DIR, files.find((f) => f.startsWith('057_'))!), 'utf8'));
}, 120_000);

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const rulesOf = async (pid: string) =>
	(
		await db.query<{ id: string; kind: string; feed_id: string | null; threshold: number; enabled: boolean; created_by: string | null; created_at: Date }>(
			`SELECT id, kind, feed_id, threshold, enabled, created_by, created_at FROM alert_rule WHERE project_id = $1 AND kind = 'data_stale' ORDER BY feed_id NULLS FIRST`,
			[pid]
		)
	).rows;
const historyOf = async (rule: string) =>
	(
		await db.query<{ state: string; deliveries: number }>(
			`SELECT e.state, (SELECT count(*)::int FROM alert_delivery d WHERE d.event_id = e.id) AS deliveries FROM alert_event e WHERE e.rule_id = $1 ORDER BY e.state`,
			[rule]
		)
	).rows;

describe('migration 057: data_stale rules become one per feed', () => {
	it('gives each feed of a catchment a rule at the old level, switch and creator; the old rule becomes the first feed’s', async () => {
		const rules = await rulesOf(TWO_FEEDS);
		expect(rules.map((r) => r.feed_id).sort()).toEqual([CHIRPS, DWS].sort());
		for (const r of rules) expect(r).toMatchObject({ threshold: 7, enabled: true, created_by: creator });
		// Converted in place: the old row is the first feed's (chirps before dws), with its date.
		const kept = rules.find((r) => r.id === RULE_TWO)!;
		expect(kept.feed_id).toBe(CHIRPS);
		expect(kept.created_at.toISOString()).toBe('2026-01-02T00:00:00.000Z');
	});

	it('keeps every event and delivery of the old rules, cleared and firing', async () => {
		expect(await historyOf(RULE_TWO)).toEqual([
			{ state: 'cleared', deliveries: 1 },
			{ state: 'firing', deliveries: 1 }
		]);
		expect(await historyOf(RULE_NONE)).toEqual([{ state: 'cleared', deliveries: 1 }]);
		expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM alert_delivery')).rows[0]!.n).toBe(3);
	});

	it('converts a switched-off rule as off, and leaves the other kinds alone', async () => {
		expect(await rulesOf(OFF)).toEqual([expect.objectContaining({ id: RULE_OFF, feed_id: OFF_FEED, threshold: 4, enabled: false, created_by: creator })]);
		const jobs = (await db.query('SELECT feed_id, threshold, enabled FROM alert_rule WHERE id = $1', [RULE_JOBS])).rows;
		expect(jobs).toEqual([{ feed_id: null, threshold: 1, enabled: true }]);
	});

	it('keeps a feed-less catchment’s choice, which its first feed adopts (and the next gets its source’s default)', async () => {
		expect(await rulesOf(NO_FEEDS)).toEqual([expect.objectContaining({ id: RULE_NONE, feed_id: null, threshold: 5, enabled: true, created_by: creator })]);
		// Nothing to adopt yet: ensureFeedRules leaves it as it is.
		await ensureFeedRules(db as unknown as Db, NO_FEEDS);
		expect((await rulesOf(NO_FEEDS)).map((r) => r.feed_id)).toEqual([null]);
		const first = id(24);
		await feed(first, NO_FEEDS, 'dws', 'gauge');
		await ensureFeedRules(db as unknown as Db, NO_FEEDS);
		expect(await rulesOf(NO_FEEDS)).toEqual([expect.objectContaining({ id: RULE_NONE, feed_id: first, threshold: 5, enabled: true, created_by: creator })]);
		expect(await historyOf(RULE_NONE)).toEqual([{ state: 'cleared', deliveries: 1 }]);
		const second = id(25);
		await feed(second, NO_FEEDS, 'chirps', 'Later');
		await ensureFeedRules(db as unknown as Db, NO_FEEDS);
		expect((await rulesOf(NO_FEEDS)).find((r) => r.feed_id === second)).toMatchObject({ threshold: 3, enabled: true });
		// Adopted once: a rule's feed never changes after that.
		await expect(db.query('UPDATE alert_rule SET feed_id = $2 WHERE id = $1', [RULE_NONE, second])).rejects.toMatchObject({ code: '23514' });
	});

	it('provisions no rule for a new feed where staleness alerts are off', async () => {
		await feed(id(26), OFF, 'dws', 'Later');
		await ensureFeedRules(db as unknown as Db, OFF);
		expect((await rulesOf(OFF)).map((r) => r.feed_id)).toEqual([OFF_FEED]);
	});

	it('allows a feed only on a data_stale rule', async () => {
		await expect(db.query('UPDATE alert_rule SET feed_id = $2 WHERE id = $1', [RULE_JOBS, CHIRPS])).rejects.toThrow();
	});
});
