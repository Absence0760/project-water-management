// The data_feed table's API (018_feeds.sql): list / create / update / delete
// as the signed-in user under RLS, the health update as the feed's acting
// user, and the scheduler's cross-project claim.
import { provenanceKey, sameProvenance, type SeriesKind, type SeriesProvenance } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { feedProvenance, type FeedConfig, type FeedInput, type FeedSchedule, type FeedSource } from './config.js';
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
	/** The product and version the feed writes (CHIRPS sat v3.0 …); null for a source whose series carry none. */
	writes: SeriesProvenance | null;
	/** The target series now: null when it doesn't exist. `filled`: it holds a value on some day. */
	series: { filled: boolean; provenance: SeriesProvenance | null } | null;
	/**
	 * The target holds values of another product or version (or an unrecorded
	 * one) than the feed writes: each fetch is refused until an owner confirms
	 * replacing it (replaceSeries) or the feed is pointed at another series.
	 */
	versionConflict: boolean;
	/** An owner confirmed the feed may replace the target while it holds this (`CHIRPS/2.0`, '' = unrecorded); the next fetch does it. */
	replaceFrom: string | null;
	/**
	 * A confirmed replacement being backfilled (feed_stage, 032): the new
	 * record's first and last day so far and when it last grew. The live
	 * series keeps its old values until the backfill is caught up. Null when
	 * none is staged.
	 */
	rebuilding: { startDate: string; through: string; updatedAt: string } | null;
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
	/**
	 * How many of a skipNoData box's cells had data in the latest successful
	 * fetch (last_meta.cellsUsed, carried forward by the ingest), or null. The
	 * ingest refuses an answer with another count; saving a new box resets it
	 * (data_feed_stamp clears last_meta when the config changes).
	 */
	cellsUsed?: number | null;
	/** CHIRPS: the last day through which the series holds final values (last_meta.finalThrough, ingest.ts): fetchWindow doesn't re-read them. */
	finalThrough: string | null;
	/** Changes whenever the feed is saved: a fetch result for an older version is dropped. */
	version: string;
	/** What an owner confirmed the feed may replace (data_feed.replace_series_from, 032): `CHIRPS/2.0`, '' = unrecorded; null = nothing. */
	replaceFrom: string | null;
}

const COLS = `f.id, f.source, f.config, f.target_kind AS "targetKind", f.target_name AS "targetName", f.enabled, f.schedule,
	f.created_at AS "createdAt", f.updated_at AS "updatedAt", u.display_name AS "actingUser",
	f.last_attempt_at AS "lastAttemptAt", f.last_success_at AS "lastSuccessAt", to_char(f.last_data_date, 'YYYY-MM-DD') AS "lastDataDate",
	f.last_value AS "lastValue", f.consecutive_failures AS "consecutiveFailures", f.last_error AS "lastError", f.last_meta AS "lastMeta",
	f.replace_series_from AS "replaceFrom", t.id IS NOT NULL AS "seriesExists", t.product AS "seriesProduct", t.product_version AS "seriesProductVersion",
	COALESCE(cardinality(array_remove(t."values", NULL)) > 0, false) AS "seriesFilled",
	CASE WHEN st.feed_id IS NULL THEN NULL ELSE jsonb_build_object(
		'startDate', to_char(st.start_date, 'YYYY-MM-DD'),
		'through', to_char(st.start_date + cardinality(st."values") - 1, 'YYYY-MM-DD'),
		'updatedAt', st.updated_at) END AS rebuilding,
	(SELECT p.time_zone FROM project p WHERE p.id = f.project_id) AS "timeZone"`;
const FROM = `data_feed f LEFT JOIN app_user u ON u.id = f.acting_user_id
	LEFT JOIN time_series t ON t.project_id = f.project_id AND t.kind = f.target_kind AND t.name = f.target_name
	LEFT JOIN feed_stage st ON st.feed_id = f.id`;

type FeedSelect = Omit<FeedMeta, 'health' | 'writes' | 'series' | 'versionConflict'> & {
	/** The project's (058): the zone the feed's health counts its days in. */
	timeZone: string | null;
	seriesExists: boolean;
	seriesProduct: string | null;
	seriesProductVersion: string | null;
	seriesFilled: boolean;
};

/** Whether a feed writing `writes` may merge into `series` without a confirmation: same version, or nothing there yet. */
export const seriesAccepts = (writes: SeriesProvenance | null, series: { filled: boolean; provenance: SeriesProvenance | null } | null): boolean =>
	!writes || !series || !series.filled || sameProvenance(series.provenance, writes);

function toMeta(r: FeedSelect, now: Date): FeedMeta {
	const { seriesExists, seriesProduct, seriesProductVersion, seriesFilled, timeZone: tz, ...row } = r;
	const timeZone = tz ?? DEFAULT_TIME_ZONE;
	const writes = feedProvenance(row.source, row.config);
	const provenance = seriesProduct !== null && seriesProductVersion !== null ? { product: seriesProduct, version: seriesProductVersion } : null;
	const series = seriesExists ? { filled: seriesFilled, provenance } : null;
	return { ...row, health: feedHealth(row, localDate(now, timeZone), timeZone), writes, series, versionConflict: !seriesAccepts(writes, series) };
}

/** The project's feeds, their health as of `now` in the project's time zone. */
export async function listFeeds(db: Db, projectId: string, now = new Date()): Promise<FeedMeta[]> {
	const { rows } = await db.query<FeedSelect>(`SELECT ${COLS} FROM ${FROM} WHERE f.project_id = $1 ORDER BY f.created_at, f.id`, [projectId]);
	return rows.map((r) => toMeta(r, now));
}

export async function getFeed(db: Db, projectId: string, feedId: string, now = new Date()): Promise<FeedMeta | null> {
	const { rows } = await db.query<FeedSelect>(`SELECT ${COLS} FROM ${FROM} WHERE f.project_id = $1 AND f.id = $2`, [projectId, feedId]);
	return rows[0] ? toMeta(rows[0], now) : null;
}

/**
 * A series' fill, provenance and first day with a value, for a feed's
 * version check (null when it doesn't exist; firstDay null when it holds no value).
 */
export async function targetSeries(
	db: Db,
	projectId: string,
	kind: string,
	name: string
): Promise<{ filled: boolean; provenance: SeriesProvenance | null; firstDay: string | null } | null> {
	const { rows } = await db.query<{ product: string | null; productVersion: string | null; firstDay: string | null }>(
		`SELECT product, product_version AS "productVersion",
			to_char(start_date + (SELECT min(i) FROM generate_subscripts("values", 1) i WHERE "values"[i] IS NOT NULL) - 1, 'YYYY-MM-DD') AS "firstDay"
		 FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3`,
		[projectId, kind, name]
	);
	const r = rows[0];
	if (!r) return null;
	return {
		filled: r.firstDay !== null,
		provenance: r.product !== null && r.productVersion !== null ? { product: r.product, version: r.productVersion } : null,
		firstDay: r.firstDay
	};
}

/** One pending fetch per feed (the jobs' dedupe key): Run now, the scheduler and a backfill's next window share it. */
export const feedFetchDedupeKey = (feedId: string) => `feed_fetch:${feedId}`;

/** The replace_series_from value that confirms replacing `series` (its key), for the routes. */
export const replaceKey = (series: { provenance: SeriesProvenance | null }): string => provenanceKey(series.provenance);

/**
 * Insert as the signed-in owner (RLS), who becomes the acting user.
 * `replaceFrom`: the owner confirmed replacing the target, which holds this (032).
 */
export async function createFeed(db: Db, projectId: string, input: FeedInput, replaceFrom: string | null = null): Promise<string> {
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO data_feed (project_id, source, config, target_kind, target_name, enabled, schedule, replace_series_from)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		[projectId, input.source, JSON.stringify(input.config), input.targetKind, input.targetName, input.enabled, input.schedule, replaceFrom]
	);
	return rows[0]!.id;
}

/**
 * Replace a feed's settings as the signed-in owner, who becomes the acting
 * user. False when not found. `replaceFrom`: a new confirmation (a string),
 * null to withdraw one, or undefined to keep the feed's own (the trigger
 * drops it on a re-target, and discards a staged replacement on any change).
 */
export async function updateFeed(db: Db, projectId: string, feedId: string, input: FeedInput, replaceFrom?: string | null): Promise<boolean> {
	const { rowCount } = await db.query(
		`UPDATE data_feed SET source = $3, config = $4, target_kind = $5, target_name = $6, enabled = $7, schedule = $8,
			replace_series_from = CASE WHEN $9::boolean THEN $10 ELSE replace_series_from END
		 WHERE project_id = $1 AND id = $2`,
		[projectId, feedId, input.source, JSON.stringify(input.config), input.targetKind, input.targetName, input.enabled, input.schedule, replaceFrom !== undefined, replaceFrom ?? null]
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
			CASE WHEN last_meta->>'cellsUsed' ~ '^[0-9]{1,4}$' THEN (last_meta->>'cellsUsed')::int END AS "cellsUsed",
			CASE WHEN last_meta->>'finalThrough' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN last_meta->>'finalThrough' END AS "finalThrough",
			to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS version, replace_series_from AS "replaceFrom"
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
 * (app_begin_feed_fetch, 029): the answer that comes back is checked against
 * this window, and any older fetch's answer is dropped from now on.
 */
export async function beginFeedFetch(db: Db, feedId: string, jobId: string, window: FetchWindow): Promise<void> {
	await db.query('SELECT app_begin_feed_fetch($1, $2, $3, $4)', [feedId, jobId, window.start, window.end]);
}

/**
 * Claim the window of the fetch an answer is for (app_take_feed_fetch, 029).
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

/** The confirmed replacement is made: clear it (app_feed_replace_done, 032), as the acting user. */
export async function feedReplaceDone(db: Db, feedId: string): Promise<void> {
	await db.query('SELECT app_feed_replace_done($1)', [feedId]);
}

export async function markScheduleFailed(db: Db, feedId: string): Promise<void> {
	await db.query('SELECT app_feed_schedule_failed($1)', [feedId]);
}
