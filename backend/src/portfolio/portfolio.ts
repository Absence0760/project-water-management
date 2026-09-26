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
import type { Db } from '../db/tx.js';
import { feedHealth, type HealthInput } from '../feeds/health.js';
import type { FeedConfig, FeedSource } from '../feeds/config.js';
import type { RecentShortfall } from '../publish/recent.js';
import { ageDays, ewrFigure, isStale, type EwrFigure } from './status.js';

export type RestrictionLevel = 'none' | 'advisory' | 'restricted';

export interface PortfolioProject {
	id: string;
	name: string;
	/** The user's role on the project (never farmer: a farmer's projects are left out). */
	role: 'viewer' | 'editor' | 'owner';
	/** The newest day of recorded rain in the project's inputs (the project list's rule), or null. */
	dataUntil: string | null;
	/** The newest baseline run, or null. */
	lastRunAt: string | null;
	/** The current publication, or null ("Not published"). */
	publishedAt: string | null;
	/** Where the figures below come from. */
	source: 'published' | 'run' | null;
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
	/**
	 * Firing alerts. Always null until WP-2.13 (alerts) is built: the hook for
	 * its alert_event count, deliberately not faked.
	 */
	alertsFiring: null;
	/** The current publication's restriction; null when nothing is published. */
	restriction: { level: RestrictionLevel; pct: number | null } | null;
}

export interface PortfolioRow {
	id: string;
	name: string;
	role: PortfolioProject['role'];
	data_until: string | null;
	last_run_at: Date | null;
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
// The run had an outlet EWR: some month of the pragmatic EWR above 0.
const EWR_SET = `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(r.inputs->'settings'->'ewrPragmaticM3PerDay', '[]'::jsonb)) v WHERE v::float8 > 0)`;

const PORTFOLIO_SQL = `
	WITH proj AS (
		SELECT p.id, p.name, app_project_role(p.id) AS role FROM project p WHERE p.team_id = $1
	)
	SELECT pr.id, pr.name, pr.role,
		to_char((SELECT max(ts.start_date + cardinality(ts."values") - 1) FROM time_series ts
			WHERE ts.project_id = pr.id AND ts.kind IN ('rain_catchment_mm', 'rain_chirps_mm') AND cardinality(ts."values") > 0), 'YYYY-MM-DD') AS data_until,
		lr.created_at AS last_run_at,
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
		fd.feeds
	FROM proj pr
	LEFT JOIN run_publication pub ON pub.project_id = pr.id AND pub.superseded_at IS NULL
	LEFT JOIN LATERAL (
		SELECT r.created_at, ${EWR_SET} AS ewr_set FROM model_run r WHERE r.id = pub.run_id
	) pubrun ON true
	LEFT JOIN LATERAL (
		SELECT r.id, r.created_at, r.start_date, ${RUN_UNTIL} AS until, ${EWR_SET} AS ewr_set
		FROM model_run r WHERE r.project_id = pr.id AND r.scenario_id IS NULL
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
			'createdAt', f.created_at AT TIME ZONE 'UTC', 'updatedAt', f.updated_at AT TIME ZONE 'UTC',
			'lastAttemptAt', f.last_attempt_at AT TIME ZONE 'UTC', 'lastSuccessAt', f.last_success_at AT TIME ZONE 'UTC',
			'lastDataDate', to_char(f.last_data_date, 'YYYY-MM-DD'), 'consecutiveFailures', f.consecutive_failures, 'lastError', NULL,
			'rebuilding', CASE WHEN st.feed_id IS NULL THEN NULL ELSE jsonb_build_object(
				'startDate', to_char(st.start_date, 'YYYY-MM-DD'),
				'through', to_char(st.start_date + cardinality(st."values") - 1, 'YYYY-MM-DD'),
				'updatedAt', st.updated_at AT TIME ZONE 'UTC') END
		)), '[]'::jsonb) AS feeds
		FROM data_feed f LEFT JOIN feed_stage st ON st.feed_id = f.id WHERE f.project_id = pr.id
	) fd ON true
	-- A farmer sees their own farms, never a catchment roll-up of their neighbours.
	WHERE pr.role IS NOT NULL AND pr.role <> 'farmer'
	ORDER BY pr.name, pr.id`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toPortfolioProject(r: PortfolioRow, today: string): PortfolioProject {
	const published = r.published_at !== null;
	const source = published ? 'published' : r.last_run_at ? 'run' : null;
	const figuresUntil = source === 'published' ? r.pub_until : source === 'run' ? r.run_until : null;
	const ewr =
		source === 'published'
			? ewrFigure({ hasFigures: true, ewrSet: r.pub_ewr_set ?? false, daysNotMet: r.pub_not_met30, days: r.pub_days30 })
			: source === 'run'
				? ewrFigure({ hasFigures: true, ewrSet: r.run_ewr_set ?? false, daysNotMet: r.run_days30 ? r.run_not_met30 : null, days: r.run_days30 || null })
				: ewrFigure({ hasFigures: false, ewrSet: false, daysNotMet: null, days: null });
	let ok = 0;
	let failing = 0;
	for (const f of r.feeds) {
		const h = feedHealth(f, today);
		if (h.state === 'ok') ok++;
		else if (h.state === 'failing' || h.state === 'stale') failing++;
	}
	return {
		id: r.id,
		name: r.name,
		role: r.role,
		dataUntil: r.data_until,
		lastRunAt: iso(r.last_run_at),
		publishedAt: iso(r.published_at),
		source,
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
		alertsFiring: null,
		restriction: published && r.restriction_level ? { level: r.restriction_level, pct: r.restriction_pct === null ? null : Number(r.restriction_pct) } : null
	};
}

/** Every catchment of the team the user may see (RLS), in one query. The caller checks team membership first. */
export async function loadPortfolio(db: Db, teamId: string, today: string): Promise<PortfolioProject[]> {
	const { rows } = await db.query<PortfolioRow>(PORTFOLIO_SQL, [teamId]);
	return rows.map((r) => toPortfolioProject(r, today));
}
