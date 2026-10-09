// A team's portfolio (roadmap WP-2.14, docs/api.md § Portfolio): one row per
// catchment of the team the user can see, read in ONE query (no N+1 across
// projects), run as the user so RLS limits the rows.
//
// Where the figures come from, per project:
//   published  the current publication (022_publication): the outlet EWR over
//              the 30 days to its dataUntil and the farm counts stored at
//              publish time (catchment_view.recent), the lowest dam from the
//              farm projections (publication_farm.view.dam.pct). Never the
//              daily arrays.
//   run        nothing published yet: the newest baseline run (not a scenario
//              run). Only the outlet EWR, counted in SQL from that run's one
//              outlet series over the same 30-day window; farm figures stay
//              unknown until a run is published.
//   null       no run at all: every figure is unknown.
//
// Ages and feed health count to each project's own today: the calendar day in
// that project's time zone (project.time_zone, 058), so a team with
// catchments in several zones gets each row right, and a South African one
// isn't a day behind from 22:00 to 24:00 UTC.
import type { Db } from '../db/tx.js';
import { appliedThresholds } from '../teams/settings.js';
import { localDate } from '../projects/timeZone.js';
import { feedHealth, type HealthInput } from '../feeds/health.js';
import type { FeedConfig, FeedSource } from '../feeds/config.js';
import type { RecentShortfall } from '../publish/recent.js';
import { ageDays, EWR_THRESHOLDS, ewrFigure, isStale, type EwrFigure, type EwrThresholds } from './status.js';
import { recordedRainUntilSql } from '../series/lastDay.js';

export type RestrictionLevel = 'none' | 'advisory' | 'restricted';

export interface PortfolioProject {
	id: string;
	name: string;
	/** The user's role on the project (never farmer: a farmer's projects are left out). */
	role: 'viewer' | 'editor' | 'owner';
	/** The project's time zone (058) and the calendar day there now: the day figuresAgeDays, stale and the feeds count to. */
	timeZone: string;
	today: string;
	/** The newest day of recorded rain in the project's inputs (the project list's rule), or null. */
	dataUntil: string | null;
	/** The newest baseline run, or null. */
	lastRunAt: string | null;
	/** The current publication, or null ("Not published"). */
	publishedAt: string | null;
	/** Where the figures below come from, and the run they were read from (null with no source). */
	source: 'published' | 'run' | null;
	sourceRunId: string | null;
	/** The last day the figures cover (the source run's dataUntil), and its age in days; null without a source. */
	figuresUntil: string | null;
	figuresAgeDays: number | null;
	/** figuresUntil more than 7 days old. */
	stale: boolean;
	/** The project has recorded rain after figuresUntil: the figures don't include the newest data yet. */
	behindData: boolean;
	/** A baseline run newer than the published one exists (not published yet). */
	newerRun: boolean;
	ewr: EwrFigure;
	/** Farms short at least one day in the 7 / 30 days to figuresUntil; null when unknown (not published, or published before the counts existed). */
	farmsShort7: number | null;
	farmsShort30: number | null;
	/** Farms in the source run's network (the live network without a publication). */
	farmCount: number;
	/** The farm dam lowest on figuresUntil (0–1); null when there are no dams or it's unknown (see damsKnown). */
	lowestDamPct: { nodeName: string; pct: number } | null;
	/** Whether dam levels are known at all (a publication exists). */
	damsKnown: boolean;
	/** Data feeds: how many, how many healthy, how many failing or stale (feeds/health.ts). */
	feeds: { total: number; ok: number; failing: number };
	/** Alerts firing now (alert_event state 'firing', WP-2.13): 0 when none, or when the project has no alert switched on. */
	alertsFiring: number;
	/** The current publication's restriction; null when nothing is published. */
	restriction: { level: RestrictionLevel; pct: number | null } | null;
}

export interface PortfolioRow {
	id: string;
	name: string;
	role: PortfolioProject['role'];
	time_zone: string;
	/** The project's team's settings (055), when the user is in that team; null for a personal project or someone else's team. */
	team_settings: unknown;
	data_until: string | null;
	last_run_at: Date | null;
	last_run_id: string | null;
	pub_run_id: string | null;
	newer_run: boolean;
	published_at: Date | null;
	restriction_level: RestrictionLevel | null;
	restriction_pct: string | null;
	pub_until: string | null;
	pub_days30: number | null;
	pub_not_met30: number | null;
	pub_ewr_set: boolean | null;
	pub_farm_count: number | null;
	pub_recent: RecentShortfall | null;
	dam_name: string | null;
	dam_pct: number | null;
	run_until: string | null;
	run_ewr_set: boolean | null;
	run_days30: number | null;
	run_not_met30: number | null;
	live_farm_count: number;
	alerts_firing: number;
	feeds: (Omit<HealthInput, 'config'> & { config: FeedConfig; source: FeedSource })[];
}

// Pieces of the query, named so it reads top to bottom.
//
// The last day with observed rain in a run's input snapshot: the day a run
// that goes on over forecast rain is counted to (publish.ts loadProjectionRun
// has the same rule), clamped to the run.
const RUN_UNTIL = `LEAST(r.end_date, GREATEST(r.start_date, COALESCE(
	(SELECT max((s.value->>'startDate')::date + (s.value->>'length')::int - 1)
	 FROM jsonb_each(r.inputs->'series') s
	 WHERE s.key IN ('rain_catchment_mm', 'rain_chirps_mm') AND (s.value->>'length')::int > 0),
	r.end_date)))`;
// The run had an outlet EWR: some month of the pragmatic EWR above 0, or (engine ≥ 1.77.0, issue #455) a daily EWR
// from the DRM tables (settings.ewrDailySource), which the run checked was usable or else ran the pragmatic EWR.
const EWR_SET = `(r.inputs->'settings'->'ewrDailySource'->>'method' IN ('tab', 'percentile') OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(r.inputs->'settings'->'ewrPragmaticM3PerDay', '[]'::jsonb)) v WHERE v::float8 > 0))`;

// Which projects: one team's (the portfolio), or every project the user can
// see (the project list, GET /projects/outcomes), each with its team's
// settings when the user may read the team (a member), for its thresholds.
const TEAM_PROJECTS = `SELECT p.id, p.name, p.time_zone, app_project_role(p.id) AS role, NULL::jsonb AS team_settings FROM project p WHERE p.team_id = $1`;
const MY_PROJECTS = `SELECT p.id, p.name, p.time_zone, app_project_role(p.id) AS role, t.settings AS team_settings
	FROM project p LEFT JOIN team t ON t.id = p.team_id`;

const portfolioSql = (projects: string) => `
	WITH proj AS (${projects})
	SELECT pr.id, pr.name, pr.role, pr.time_zone, pr.team_settings,
		to_char(${recordedRainUntilSql('pr.id')}, 'YYYY-MM-DD') AS data_until,
		lr.created_at AS last_run_at, lr.id AS last_run_id, pub.run_id AS pub_run_id,
		COALESCE(lr.created_at > pubrun.created_at, false) AS newer_run,
		pub.published_at, pub.restriction_level, pub.restriction_pct,
		pub.catchment_view->>'dataUntil' AS pub_until,
		(pub.catchment_view->'last30'->>'days')::int AS pub_days30,
		-- The outlet, or the first site (the farm view's rule, farms/view.ts).
		(SELECT (s->'daysNotMet'->>'last30')::int FROM jsonb_array_elements(pub.catchment_view->'sites') WITH ORDINALITY e(s, o)
			ORDER BY (s->>'isOutlet')::boolean DESC, o LIMIT 1) AS pub_not_met30,
		pubrun.ewr_set AS pub_ewr_set,
		(pub.catchment_view->>'farmCount')::int AS pub_farm_count,
		pub.catchment_view->'recent' AS pub_recent,
		dam.name AS dam_name, dam.pct AS dam_pct,
		to_char(lr.until, 'YYYY-MM-DD') AS run_until, lr.ewr_set AS run_ewr_set,
		rew.days AS run_days30, rew.not_met AS run_not_met30,
		(SELECT count(*)::int FROM node n WHERE n.project_id = pr.id AND n.kind = 'farm') AS live_farm_count,
		-- Firing alerts (051_alerts; alert_event_project_idx covers it).
		(SELECT count(*)::int FROM alert_event e WHERE e.project_id = pr.id AND e.state = 'firing') AS alerts_firing,
		fd.feeds
	FROM proj pr
	LEFT JOIN run_publication pub ON pub.project_id = pr.id AND pub.superseded_at IS NULL
	LEFT JOIN LATERAL (
		SELECT r.created_at, ${EWR_SET} AS ewr_set FROM model_run r WHERE r.id = pub.run_id
	) pubrun ON true
	LEFT JOIN LATERAL (
		SELECT r.id, r.created_at, r.start_date, ${RUN_UNTIL} AS until, ${EWR_SET} AS ewr_set
		-- A forecast run is guidance made beside the runs (daily with a GEFS
		-- feed), never "a newer run" than the published one, nor the figures.
		FROM model_run r WHERE r.project_id = pr.id AND NOT r.from_scenario AND r.trigger <> 'forecast'
		ORDER BY r.created_at DESC LIMIT 1
	) lr ON true
	LEFT JOIN LATERAL (
		SELECT f.view->>'name' AS name, (f.view->'dam'->>'pct')::float8 AS pct
		FROM publication_farm f WHERE f.publication_id = pub.id AND jsonb_typeof(f.view->'dam') = 'object'
		ORDER BY 2, 1 LIMIT 1
	) dam ON true
	-- Only without a publication: the outlet series of the newest run over the
	-- 30 days to its observed end (a slice clamps to the array, 1-based).
	LEFT JOIN LATERAL (
		SELECT count(*)::int AS days, count(*) FILTER (WHERE v < 0)::int AS not_met
		FROM run_series rs, unnest(rs."values"[(lr.until - lr.start_date) - 28 : (lr.until - lr.start_date) + 1]) v
		WHERE pub.id IS NULL AND rs.run_id = lr.id AND rs.node_id IS NULL AND rs.key = 'ewr_shortfall'
	) rew ON true
	LEFT JOIN LATERAL (
		SELECT COALESCE(jsonb_agg(jsonb_build_object(
			'source', f.source, 'config', f.config, 'enabled', f.enabled,
			-- Instants with their offset: feedHealth dates them in the project's zone.
			'createdAt', f.created_at, 'updatedAt', f.updated_at,
			'lastAttemptAt', f.last_attempt_at, 'lastSuccessAt', f.last_success_at,
			'lastDataDate', to_char(f.last_data_date, 'YYYY-MM-DD'), 'consecutiveFailures', f.consecutive_failures, 'lastError', NULL,
			'rebuilding', CASE WHEN st.feed_id IS NULL THEN NULL ELSE jsonb_build_object(
				'startDate', to_char(st.start_date, 'YYYY-MM-DD'),
				'through', to_char(st.start_date + cardinality(st."values") - 1, 'YYYY-MM-DD'),
				'updatedAt', st.updated_at) END
		)), '[]'::jsonb) AS feeds
		FROM data_feed f LEFT JOIN feed_stage st ON st.feed_id = f.id WHERE f.project_id = pr.id
	) fd ON true
	-- A farmer sees their own farms, never a catchment roll-up of their neighbours;
	-- nor does an applicant (contributor, 044), who ranks below viewer too.
	WHERE pr.role >= 'viewer'::project_role
	ORDER BY pr.name, pr.id`;
const PORTFOLIO_SQL = portfolioSql(TEAM_PROJECTS);
const MY_OUTCOMES_SQL = portfolioSql(MY_PROJECTS);

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** One row, its ages counted to `now` in the project's own time zone. */
export function toPortfolioProject(r: PortfolioRow, now: Date, thresholds: EwrThresholds = EWR_THRESHOLDS): PortfolioProject {
	const timeZone = r.time_zone;
	const today = localDate(now, timeZone);
	const published = r.published_at !== null;
	const source = published ? 'published' : r.last_run_at ? 'run' : null;
	const figuresUntil = source === 'published' ? r.pub_until : source === 'run' ? r.run_until : null;
	const ewr =
		source === 'published'
			? ewrFigure({ hasFigures: true, ewrSet: r.pub_ewr_set ?? false, daysNotMet: r.pub_not_met30, days: r.pub_days30 }, thresholds)
			: source === 'run'
				? ewrFigure({ hasFigures: true, ewrSet: r.run_ewr_set ?? false, daysNotMet: r.run_days30 ? r.run_not_met30 : null, days: r.run_days30 || null }, thresholds)
				: ewrFigure({ hasFigures: false, ewrSet: false, daysNotMet: null, days: null }, thresholds);
	let ok = 0;
	let failing = 0;
	for (const f of r.feeds) {
		const h = feedHealth(f, today, timeZone);
		if (h.state === 'ok') ok++;
		else if (h.state === 'failing' || h.state === 'stale') failing++;
	}
	return {
		id: r.id,
		name: r.name,
		role: r.role,
		timeZone,
		today,
		dataUntil: r.data_until,
		lastRunAt: iso(r.last_run_at),
		publishedAt: iso(r.published_at),
		source,
		sourceRunId: source === 'published' ? r.pub_run_id : source === 'run' ? r.last_run_id : null,
		figuresUntil,
		figuresAgeDays: figuresUntil ? ageDays(figuresUntil, today) : null,
		stale: isStale(figuresUntil, today),
		behindData: figuresUntil !== null && r.data_until !== null && r.data_until > figuresUntil,
		newerRun: published && r.newer_run,
		ewr,
		farmsShort7: published ? (r.pub_recent?.farmsShort7 ?? null) : null,
		farmsShort30: published ? (r.pub_recent?.farmsShort30 ?? null) : null,
		farmCount: published ? (r.pub_farm_count ?? 0) : r.live_farm_count,
		lowestDamPct: published && r.dam_name !== null && r.dam_pct !== null ? { nodeName: r.dam_name, pct: r.dam_pct } : null,
		damsKnown: published,
		feeds: { total: r.feeds.length, ok, failing },
		alertsFiring: r.alerts_firing,
		restriction: published && r.restriction_level ? { level: r.restriction_level, pct: r.restriction_pct === null ? null : Number(r.restriction_pct) } : null
	};
}

/**
 * Every catchment of the team the user may see (RLS), in one query, each EWR
 * status judged by `thresholds` (the team's, teams/settings.ts). The caller
 * checks team membership first.
 */
export async function loadPortfolio(db: Db, teamId: string, now: Date, thresholds: EwrThresholds = EWR_THRESHOLDS): Promise<PortfolioProject[]> {
	const { rows } = await db.query<PortfolioRow>(PORTFOLIO_SQL, [teamId]);
	return rows.map((r) => toPortfolioProject(r, now, thresholds));
}

/**
 * The same figures for every project the user can see (RLS), in one query:
 * the project list's outcome columns (GET /projects/outcomes, issue #17).
 * Each status is judged by its own team's thresholds, or the defaults for a
 * personal project and for a project shared from a team the user isn't in
 * (they can't read that team's settings; its portfolio isn't theirs to see).
 * Farmers' and applicants' projects are left out, as on the portfolio.
 */
export async function loadMyOutcomes(db: Db, now: Date): Promise<PortfolioProject[]> {
	const { rows } = await db.query<PortfolioRow>(MY_OUTCOMES_SQL);
	return rows.map((r) => {
		const { source: _source, ...cutoffs } = appliedThresholds(r.team_settings);
		return toPortfolioProject(r, now, cutoffs);
	});
}
