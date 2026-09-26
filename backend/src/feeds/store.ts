// The data_feed table's API (018_feeds.sql): list / create / update / delete
// as the signed-in user under RLS, the health update as the feed's acting
// user, and the scheduler's cross-project claim.
import type { SeriesKind } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import type { FeedConfig, FeedInput, FeedSchedule, FeedSource } from './config.js';
import type { FetchWindow } from './fetch.js';
import { type FeedHealth, feedHealth } from './health.js';

/** A feed as the API returns it. */
export interface FeedMeta {
	id: string;
	source: FeedSource;
	config: FeedConfig;
	targetKind: SeriesKind;
	targetName: string;
	enabled: boolean;
	schedule: FeedSchedule;
	createdAt: string;
	updatedAt: string;
	/** The display name of the owner fetches run as; null when that account is gone. */
	actingUser: string | null;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	lastDataDate: string | null;
	lastValue: number | null;
	consecutiveFailures: number;
	/** Sanitised (feeds/errors.ts). */
	lastError: string | null;
	lastMeta: Record<string, string | number> | null;
	health: FeedHealth;
}

/** The row the handlers work from. */
export interface FeedRow {
	id: string;
	projectId: string;
	source: FeedSource;
	config: FeedConfig;
	targetKind: SeriesKind;
	targetName: string;
	enabled: boolean;
	lastDataDate: string | null;
	/** The last day the latest successful fetch asked for (last_meta.through): fetchWindow's progress through empty days. */
	readThrough: string | null;
	/** Changes whenever the feed is saved: a fetch result for an older version is dropped. */
	version: string;
}

const COLS = `f.id, f.source, f.config, f.target_kind AS "targetKind", f.target_name AS "targetName", f.enabled, f.schedule,
	f.created_at AS "createdAt", f.updated_at AS "updatedAt", u.display_name AS "actingUser",
	f.last_attempt_at AS "lastAttemptAt", f.last_success_at AS "lastSuccessAt", to_char(f.last_data_date, 'YYYY-MM-DD') AS "lastDataDate",
	f.last_value AS "lastValue", f.consecutive_failures AS "consecutiveFailures", f.last_error AS "lastError", f.last_meta AS "lastMeta"`;
const FROM = 'data_feed f LEFT JOIN app_user u ON u.id = f.acting_user_id';

const withHealth = (row: Omit<FeedMeta, 'health'>, today: string): FeedMeta => ({ ...row, health: feedHealth(row, today) });

export async function listFeeds(db: Db, projectId: string, today: string): Promise<FeedMeta[]> {
	const { rows } = await db.query<Omit<FeedMeta, 'health'>>(`SELECT ${COLS} FROM ${FROM} WHERE f.project_id = $1 ORDER BY f.created_at, f.id`, [projectId]);
	return rows.map((r) => withHealth(r, today));
}

export async function getFeed(db: Db, projectId: string, feedId: string, today: string): Promise<FeedMeta | null> {
	const { rows } = await db.query<Omit<FeedMeta, 'health'>>(`SELECT ${COLS} FROM ${FROM} WHERE f.project_id = $1 AND f.id = $2`, [projectId, feedId]);
	return rows[0] ? withHealth(rows[0], today) : null;
}

/** Insert as the signed-in owner (RLS), who becomes the acting user. */
export async function createFeed(db: Db, projectId: string, input: FeedInput): Promise<string> {
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO data_feed (project_id, source, config, target_kind, target_name, enabled, schedule)
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		[projectId, input.source, JSON.stringify(input.config), input.targetKind, input.targetName, input.enabled, input.schedule]
	);
	return rows[0]!.id;
}

/** Replace a feed's settings as the signed-in owner, who becomes the acting user. False when not found. */
export async function updateFeed(db: Db, projectId: string, feedId: string, input: FeedInput): Promise<boolean> {
	const { rowCount } = await db.query(
		`UPDATE data_feed SET source = $3, config = $4, target_kind = $5, target_name = $6, enabled = $7, schedule = $8
		 WHERE project_id = $1 AND id = $2`,
		[projectId, feedId, input.source, JSON.stringify(input.config), input.targetKind, input.targetName, input.enabled, input.schedule]
	);
	return (rowCount ?? 0) > 0;
}

export async function deleteFeed(db: Db, projectId: string, feedId: string): Promise<boolean> {
	const { rowCount } = await db.query('DELETE FROM data_feed WHERE project_id = $1 AND id = $2', [projectId, feedId]);
	return (rowCount ?? 0) > 0;
}

/** The feed a job works on, read as the job's acting user (RLS). */
export async function feedForJob(db: Db, projectId: string, feedId: string): Promise<FeedRow | null> {
	const { rows } = await db.query<FeedRow>(
		`SELECT id, project_id AS "projectId", source, config, target_kind AS "targetKind", target_name AS "targetName", enabled,
			to_char(last_data_date, 'YYYY-MM-DD') AS "lastDataDate",
			CASE WHEN last_meta->>'through' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN last_meta->>'through' END AS "readThrough",
			to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS version
		 FROM data_feed WHERE project_id = $1 AND id = $2`,
		[projectId, feedId]
	);
	return rows[0] ?? null;
}

/**
 * The issue date of the forecast a CHIRPS-GEFS feed last merged
 * (last_meta.issued), read after taking the feed's ingest lock so two
 * ingests of one feed see each other: the second waits for the first to
 * commit, then reads what it recorded.
 */
export async function lockFeedIssued(db: Db, feedId: string): Promise<string | null> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('feed_ingest:' || $1::text, 0))`, [feedId]);
	const { rows } = await db.query<{ issued: string | null }>(`SELECT last_meta->>'issued' AS issued FROM data_feed WHERE id = $1`, [feedId]);
	return rows[0]?.issued ?? null;
}

/**
 * Record the fetch a feed_fetch job is about to send and the days it asks for
 * (app_begin_feed_fetch, 028): the answer that comes back is checked against
 * this window, and any older fetch's answer is dropped from now on.
 */
export async function beginFeedFetch(db: Db, feedId: string, jobId: string, window: FetchWindow): Promise<void> {
	await db.query('SELECT app_begin_feed_fetch($1, $2, $3, $4)', [feedId, jobId, window.start, window.end]);
}

/**
 * Claim the window of the fetch an answer is for (app_take_feed_fetch, 028).
 * Null when that fetch isn't the feed's newest or its answer was already
 * applied: the answer must be dropped.
 */
export async function takeFeedFetch(db: Db, feedId: string, jobId: string): Promise<FetchWindow | null> {
	const { rows } = await db.query<FetchWindow>(
		`SELECT to_char(window_start, 'YYYY-MM-DD') AS start, to_char(window_end, 'YYYY-MM-DD') AS "end" FROM app_take_feed_fetch($1, $2)`,
		[feedId, jobId]
	);
	return rows[0] ?? null;
}

export type FeedOutcome =
	| { ok: true; lastDate: string | null; lastValue: number | null; meta: Record<string, string | number> }
	| { ok: false; error: string };

/** A fetch that worked but whose forecast issue was older than the merged one: stamp only the check time (app_record_feed_checked), as the acting user. */
export async function recordFeedChecked(db: Db, feedId: string): Promise<void> {
	await db.query('SELECT app_record_feed_checked($1)', [feedId]);
}

/** Record a fetch's outcome (app_record_feed_result), as the acting user. */
export async function recordFeedResult(db: Db, feedId: string, o: FeedOutcome): Promise<void> {
	await db.query('SELECT app_record_feed_result($1, $2, $3, $4, $5, $6)', [
		feedId,
		o.ok,
		o.ok ? o.lastDate : null,
		o.ok ? o.lastValue : null,
		o.ok ? null : o.error,
		o.ok ? JSON.stringify(o.meta) : null
	]);
}

export interface DueFeed {
	id: string;
	projectId: string;
	actingUserId: string;
}

/** Due feeds for the scheduler, longest-waiting first (app_due_feeds; no user context, stamps nothing). `all`: every enabled feed, due or not. */
export async function listDueFeeds(db: Db, limit: number, all = false): Promise<DueFeed[]> {
	const { rows } = await db.query<DueFeed>(
		'SELECT id, project_id AS "projectId", acting_user_id AS "actingUserId" FROM app_due_feeds($1, $2)',
		[limit, all]
	);
	return rows;
}

/**
 * Claim one feed (app_claim_feed), inside a transaction as its acting user:
 * false when it is no longer due, no longer that user's, or another tick is
 * claiming it. Queue its fetch in the same transaction, so a rollback undoes
 * the claim too.
 */
export async function claimFeed(db: Db, feedId: string, all = false): Promise<boolean> {
	const { rows } = await db.query<{ claimed: boolean }>('SELECT app_claim_feed($1, $2) AS claimed', [feedId, all]);
	return rows[0]?.claimed === true;
}

export async function markScheduleFailed(db: Db, feedId: string): Promise<void> {
	await db.query('SELECT app_feed_schedule_failed($1)', [feedId]);
}
