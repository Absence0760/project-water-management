// Migration 141 (issue #120): run_publication.auto is backfilled from the
// audit log's publication.published events (`auto: true` since WP-2.11),
// superseded publications included, and alert_rule's threshold CHECK is
// replaced (alert_rule_check1 → alert_rule_threshold) without losing a rule.
// This builds a throwaway database at the schema before 141, stores
// publications, audit events and rules the old way, applies 141 and checks
// what each became (docs/data-model.md § Publication, § Alerts).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m141_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(1);
const OTHER = id(2);
const AUTO_OLD = id(11); // auto-published, since superseded
const BY_HAND = id(12); // a person's, superseded
const AUTO_NOW = id(13); // auto-published, current
const ELSEWHERE = id(14); // a person's, in another project, named by a stray event of PROJECT's
const RULE_DAM = id(21);
const RULE_JOBS = id(22);

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '141')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	for (const [pid, name] of [
		[PROJECT, 'Auto'],
		[OTHER, 'Other']
	] as const)
		await db.query(`INSERT INTO project (id, name, created_by) VALUES ($1, $2, $3)`, [pid, name, user]);
	const run = async (pid: string) =>
		(
			await db.query<{ id: string }>(
				`INSERT INTO model_run (project_id, created_by, start_date, end_date, inputs, engine_version) VALUES ($1, $2, '2024-01-01', '2024-12-31', '{}', 'x') RETURNING id`,
				[pid, user]
			)
		).rows[0]!.id;
	// Oldest first: each publishes over the one before (superseded_at set as publishRun does).
	const publish = async (pubId: string, pid: string, superseded: boolean) =>
		db.query(`INSERT INTO run_publication (id, project_id, run_id, published_by, superseded_at) VALUES ($1, $2, $3, $4, $5)`, [
			pubId,
			pid,
			await run(pid),
			user,
			superseded ? '2025-01-01T00:00:00Z' : null
		]);
	await publish(AUTO_OLD, PROJECT, true);
	await publish(BY_HAND, PROJECT, true);
	await publish(AUTO_NOW, PROJECT, false);
	await publish(ELSEWHERE, OTHER, false);
	const audit = (pid: string, subject: Record<string, unknown>) =>
		db.query(`INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject) VALUES ($1, $2, 'O', 'publication.published', $3)`, [pid, user, subject]);
	await audit(PROJECT, { publicationId: AUTO_OLD, auto: true });
	await audit(PROJECT, { publicationId: BY_HAND });
	await audit(PROJECT, { publicationId: AUTO_NOW, auto: true });
	// An event of one project naming another's publication is no evidence about it.
	await audit(PROJECT, { publicationId: ELSEWHERE, auto: true });
	await audit(OTHER, { publicationId: ELSEWHERE });

	// Rules under 051's threshold CHECK, which 141 replaces.
	const farm = id(31);
	await db.query(`INSERT INTO node (id, project_id, name, kind) VALUES ($1, $2, 'Farm', 'farm')`, [farm, PROJECT]);
	await db.query('ALTER TABLE alert_rule DISABLE TRIGGER alert_rule_check');
	await db.query(
		`INSERT INTO alert_rule (id, project_id, kind, node_id, threshold, enabled, created_by) VALUES
			($1, $3, 'dam_below', $4, 0.3, true, $5), ($2, $3, 'job_dead', NULL, 2, false, $5)`,
		[RULE_DAM, RULE_JOBS, PROJECT, farm, user]
	);
	await db.query('ALTER TABLE alert_rule ENABLE TRIGGER alert_rule_check');

	await db.query(await readFile(join(DIR, files.find((f) => f.startsWith('141_'))!), 'utf8'));
}, 180_000);

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

describe('migration 141: run_publication.auto and the farms_short kind', () => {
	it('marks the publications its own project’s audit log says an auto run made, superseded ones too, and no other', async () => {
		const { rows } = await db.query<{ id: string; auto: boolean }>('SELECT id, auto FROM run_publication ORDER BY id');
		expect(rows).toEqual([
			{ id: AUTO_OLD, auto: true },
			{ id: BY_HAND, auto: false },
			{ id: AUTO_NOW, auto: true },
			{ id: ELSEWHERE, auto: false }
		]);
		// The history guard is back on after the backfill: a superseded publication still never changes.
		await expect(db.query('UPDATE run_publication SET auto = false WHERE id = $1', [AUTO_OLD])).rejects.toMatchObject({ code: '23514' });
	});

	it('keeps every existing rule through the replaced threshold CHECK, and holds farms_short to whole farms 1–1000', async () => {
		const { rows } = await db.query<{ id: string; kind: string; threshold: number; enabled: boolean }>('SELECT id, kind, threshold, enabled FROM alert_rule ORDER BY id');
		expect(rows).toEqual([
			{ id: RULE_DAM, kind: 'dam_below', threshold: 0.3, enabled: true },
			{ id: RULE_JOBS, kind: 'job_dead', threshold: 2, enabled: false }
		]);
		const insert = (threshold: number) => db.query(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'farms_short', $2)`, [OTHER, threshold]);
		for (const bad of [0, 1.5, 1001]) await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
		await insert(1); // positive control
		// The old bounds still hold for the other kinds.
		await expect(db.query(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'job_dead', 0)`, [OTHER])).rejects.toMatchObject({ code: '23514' });
	});

	it('refuses a feed and a series on one rule, and a series on any kind but data_stale', async () => {
		const series = (
			await db.query<{ id: string }>(`INSERT INTO time_series (project_id, kind, unit, start_date, "values") VALUES ($1, 'flow_logger_m3s', 'm³/s', '2024-01-01', '{1}') RETURNING id`, [
				PROJECT
			])
		).rows[0]!.id;
		const feed = (
			await db.query<{ id: string }>(`INSERT INTO data_feed (project_id, source, config, target_kind, target_name) VALUES ($1, 'dws', '{"station":"X0H000"}', 'flow_observed_m3s', 'g') RETURNING id`, [
				PROJECT
			])
		).rows[0]!.id;
		await expect(
			db.query(`INSERT INTO alert_rule (project_id, kind, feed_id, series_id, threshold) VALUES ($1, 'data_stale', $2, $3, 2)`, [PROJECT, feed, series])
		).rejects.toMatchObject({ code: '23514' });
		await expect(db.query(`INSERT INTO alert_rule (project_id, kind, series_id, threshold) VALUES ($1, 'job_dead', $2, 1)`, [PROJECT, series])).rejects.toMatchObject({
			code: '23514'
		});
		// Positive control: a series on its own data_stale rule.
		await db.query(`INSERT INTO alert_rule (project_id, kind, series_id, threshold) VALUES ($1, 'data_stale', $2, 2)`, [PROJECT, series]);
	});
});
