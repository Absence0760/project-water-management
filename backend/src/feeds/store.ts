// The data_feed table's API (018_feeds.sql): list / create / update / delete
// as the signed-in user under RLS, the health update as the feed's acting
// user, and the scheduler's cross-project claim.
import type { SeriesKind } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import type { FeedConfig, FeedInput, FeedSchedule, FeedSource } from './config.js';
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
			to_char(last_data_date, 'YYYY-MM-DD') AS "lastDataDate", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS version
		 FROM data_feed WHERE project_id = $1 AND id = $2`,
		[projectId, feedId]
	);
	return rows[0] ?? null;
}

export type FeedOutcome =
	| { ok: true; lastDate: string | null; lastValue: number | null; meta: Record<string, string | number> }
	| { ok: false; error: string };

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

/** Claim due feeds for the scheduler (app_claim_due_feeds; no user context). `all`: every enabled feed, due or not. */
export async function claimDueFeeds(db: Db, limit: number, all = false): Promise<DueFeed[]> {
	const { rows } = await db.query<DueFeed>(
		'SELECT id, project_id AS "projectId", acting_user_id AS "actingUserId" FROM app_claim_due_feeds($1, $2)',
		[limit, all]
	);
	return rows;
}

export async function markScheduleFailed(db: Db, feedId: string): Promise<void> {
	await db.query('SELECT app_feed_schedule_failed($1)', [feedId]);
}
