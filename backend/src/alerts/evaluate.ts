// Alert evaluation (roadmap WP-2.13; the `alert_eval` job,
// jobs/handlers/alert-eval.ts). Runs as the job's acting editor under RLS:
// reads the project's current figures, opens and clears alert events
// (rules.ts decides, with hysteresis), and fans each newly opened event out
// to its recipients as pending deliveries (app_alert_fan_out). Nothing is
// mailed here: the worker sends after this transaction commits (send.ts).
//
// Where each value comes from:
//   dam_below              the current publication's projection of that farm
//                          (publication_farm): the lower of its dam level on
//                          the last day of data and, when the published run
//                          is a forecast run, its lowest forecast level. The
//                          published figures, never an unpublished run: a
//                          farmer is told only what the WUA stands behind,
//                          and the WUA sees the same number.
//   ewr_forecast_fail      the newest forecast run's summary.forecast, while
//                          its forecast days haven't all passed. Not while an
//                          API key's anomalous push is held (series/hold.ts):
//                          that forecast may rest on the held days; nor while
//                          that run is behind the recorded rain (its
//                          lastObserved before the rain's last day: it ran
//                          days since recorded as dry), until the re-made one.
//   data_stale             one rule per data feed (057 feed_id): days that
//                          feed is past its usual delay (feeds/health.ts
//                          staleAfterDays); a disabled feed, or one with no
//                          data yet, has no value (a firing rule clears).
//                          And one per series an API key wrote (141
//                          series_id, ensureSeriesRules): days since its last
//                          non-blank day (series/lastDay.ts), past one day
//                          (SERIES_USUAL_DELAY_DAYS); a series with no value
//                          has none. A hand-uploaded series gets no rule.
//   farms_short            the current publication's farms short in its last
//                          7 days of data (catchment_view.recent), only while
//                          that publication was made by an auto run (141
//                          run_publication.auto): a person's publication is
//                          the WUA's own act. Otherwise no value (clears).
//   feed_failing           the enabled data feeds' failures in a row.
//   job_dead               the project's jobs that died in the last 24 hours.
//   restriction_published  the current publication's restriction and notice:
//                          any change is one event (a lift too).
//
// "Today" (a forecast still current, a feed's days overdue) and a forecast's
// madeOn are the calendar day in the project's time zone (project.time_zone,
// 058; projects/timeZone.ts localDate), the day its readers are living, as
// the feeds page and the digest clock (059) count it. Never UTC's, which is a
// day behind a South African reader from 22:00 to 24:00 UTC.
import { createHash } from 'node:crypto';
import { seriesDisplayName, type FarmProjection } from '@water-management/engine';
import { toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';
import { SOURCES, feedStaleAfterDays, type FeedConfig, type FeedSource } from '../feeds/config.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { heldSinceLastRun } from '../series/hold.js';
import { lastValueDaySql } from '../series/lastDay.js';
import type { RecentShortfall } from '../publish/recent.js';
import { recordedRainUntil } from '../runs/autoRun.js';
import { SERIES_STALE_ALERT_DAYS, SERIES_USUAL_DELAY_DAYS, step, type AlertKind } from './rules.js';

/** ALERTS_ENABLED=false is the kill switch (docs/deployment.md § Runbooks): events still open and clear, nothing is sent. */
export const alertsEnabled = () => process.env.ALERTS_ENABLED !== 'false';

interface RuleRow {
	id: string;
	kind: AlertKind;
	node_id: string | null;
	feed_id: string | null;
	series_id: string | null;
	threshold: number;
	enabled: boolean;
	event_id: string | null;
	event_value: number | null;
}

interface Observation {
	value: number | null;
	detail: Record<string, unknown>;
	runId: string | null;
}

export interface EvalOutcome {
	rules: number;
	opened: number;
	cleared: number;
	/** Deliveries queued (0 while the kill switch is on). */
	queued: number;
}

/**
 * Alerts are opt-in per project (an editor switches kinds on, routes.ts PUT
 * /alert-rules). Once dam alerts are on for any farm, a farm added to the
 * network later gets a dam rule too, at the threshold last set; a farm whose
 * rule an editor switched off keeps it off (the rule exists).
 */
export async function ensureFarmRules(db: Db, projectId: string): Promise<void> {
	await db.query(
		`INSERT INTO alert_rule (project_id, kind, node_id, threshold, enabled)
		 SELECT $1, 'dam_below', n.id, d.threshold, true
		 FROM node n, LATERAL (
			SELECT r.threshold FROM alert_rule r WHERE r.project_id = $1 AND r.kind = 'dam_below' AND r.enabled
			ORDER BY r.updated_at DESC LIMIT 1
		 ) d
		 WHERE n.project_id = $1 AND n.kind = 'farm'
		 ON CONFLICT (project_id, kind, node_id, feed_id, series_id) DO NOTHING`,
		[projectId]
	);
}

/**
 * Once data_stale is on for any feed, a feed added later gets its own rule,
 * on, at its source's default level (SOURCES[source].staleAlertDays); a feed
 * whose rule an editor switched off keeps it off (the rule exists).
 *
 * A catchment that had 051's catchment-wide rule but no feed when 057 ran
 * keeps it as a feed-less rule: its pending choice. The first feed added
 * adopts it (its level and switch, and any history), and the rest follow the
 * rule above, so an "on" made before there were feeds is honoured.
 */
export async function ensureFeedRules(db: Db, projectId: string): Promise<void> {
	await db.query(
		`UPDATE alert_rule r SET feed_id = (
			SELECT f.id FROM data_feed f
			WHERE f.project_id = $1 AND NOT EXISTS (SELECT 1 FROM alert_rule x WHERE x.feed_id = f.id)
			ORDER BY f.source, f.target_kind, f.target_name, f.id LIMIT 1
		 )
		 WHERE r.project_id = $1 AND r.kind = 'data_stale' AND r.feed_id IS NULL AND r.series_id IS NULL
		   AND EXISTS (SELECT 1 FROM data_feed f WHERE f.project_id = $1 AND NOT EXISTS (SELECT 1 FROM alert_rule x WHERE x.feed_id = f.id))`,
		[projectId]
	);
	const { rows } = await db.query<{ id: string; source: FeedSource }>(
		`SELECT f.id, f.source FROM data_feed f
		 WHERE f.project_id = $1
		   AND EXISTS (SELECT 1 FROM alert_rule r WHERE r.project_id = $1 AND r.kind = 'data_stale' AND r.enabled)
		   AND NOT EXISTS (SELECT 1 FROM alert_rule r WHERE r.feed_id = f.id)`,
		[projectId]
	);
	for (const f of rows) {
		await db.query(
			`INSERT INTO alert_rule (project_id, kind, feed_id, threshold, enabled) VALUES ($1, 'data_stale', $2, $3, true)
			 ON CONFLICT (project_id, kind, node_id, feed_id, series_id) DO NOTHING`,
			[projectId, f.id, SOURCES[f.source].staleAlertDays]
		);
	}
}

/**
 * SQL: the project's (`projectExpr`) series an API key has written and
 * nobody has written over since (series_key_days, 053): a logger's, so a
 * series that should keep coming. A hand-uploaded series is stale by nature
 * and never gets a rule (issue #120).
 */
export const keyFedSeriesSql = (projectExpr: string) => `SELECT DISTINCT k.series_id FROM series_key_days k WHERE k.project_id = ${projectExpr}`;

/**
 * Once data_stale is on for anything, a series an API key writes gets its
 * own rule, on, at SERIES_STALE_ALERT_DAYS; a series whose rule an editor
 * switched off keeps it off (the rule exists). The rule then stays with the
 * series even if a person later writes over the key's days.
 */
export async function ensureSeriesRules(db: Db, projectId: string): Promise<void> {
	await db.query(
		`INSERT INTO alert_rule (project_id, kind, series_id, threshold, enabled)
		 SELECT $1, 'data_stale', s.series_id, $2, true FROM (${keyFedSeriesSql('$1')}) s
		 WHERE EXISTS (SELECT 1 FROM alert_rule r WHERE r.project_id = $1 AND r.kind = 'data_stale' AND r.enabled)
		   AND NOT EXISTS (SELECT 1 FROM alert_rule r WHERE r.project_id = $1 AND r.series_id = s.series_id)
		 ON CONFLICT (project_id, kind, node_id, feed_id, series_id) DO NOTHING`,
		[projectId, SERIES_STALE_ALERT_DAYS]
	);
}

/** A series as the rule editor and the alert mails name it: as the Data page does (its name, else its kind's label). */
export const seriesLabel = (kind: string, name: string) => seriesDisplayName(kind, name);

/** Whether any alert is switched on for the project (as the caller, RLS). */
export async function alertsOn(db: Db, projectId: string): Promise<boolean> {
	const { rows } = await db.query<{ on: boolean }>('SELECT EXISTS (SELECT 1 FROM alert_rule WHERE project_id = $1 AND enabled) AS on', [projectId]);
	return rows[0]?.on === true;
}

const md5 = (s: string | null) => createHash('md5').update(s ?? '').digest('hex');
/** A feed as the feeds page, the rule editor and the alert mails name it. */
export const feedLabel = (source: FeedSource, targetName: string) => (targetName ? `${SOURCES[source].label} (${targetName})` : SOURCES[source].label);

/**
 * A forecast run behind the recorded rain: it used rain to `observedTo`, but
 * rain has since been recorded to `rainUntil` (and `madeOn` is the day it was
 * made). Shown on a firing ewr_forecast_fail event (routes.ts, the digest
 * mail) while no newer forecast has been made, typically because the
 * forecast feed is failing (feed_failing fires for that).
 */
export interface ForecastOutOfDate {
	madeOn: string;
	observedTo: string;
	rainUntil: string;
}

/**
 * The project's newest forecast run (scenario-free), as RLS lets the caller
 * read it, with whether it is out of date. One made before rain was recorded
 * for days it ran as dry (or on forecast rain) describes a past that didn't
 * happen: it can say "the river fails" where a fresh one says it doesn't. It
 * neither opens nor clears an event (evaluateAlerts); the re-made forecast
 * run (the auto re-run queues it, jobs/handlers/rerun.ts) decides. Until it
 * comes, the pages that show the firing event say it is out of date. A
 * forecast with no lastObserved (no recorded rain at all when it ran) is
 * never out of date.
 */
export async function newestForecast(db: Db, projectId: string, timeZone: string) {
	const { rows } = await db.query<{
		id: string;
		created_at: Date;
		f: { from: string; to: string; days: number; outletEwrDaysAtRisk: number; lastObserved?: string | null } | null;
	}>(
		`SELECT id, created_at, summary->'forecast' AS f
		 FROM model_run WHERE project_id = $1 AND NOT from_scenario AND trigger = 'forecast'
		 ORDER BY created_at DESC LIMIT 1`,
		[projectId]
	);
	const r = rows[0];
	if (!r?.f) return null;
	const madeOn = localDate(r.created_at, timeZone);
	const rainUntil = r.f.lastObserved ? await recordedRainUntil(db, projectId) : null;
	const outOfDate: ForecastOutOfDate | null =
		rainUntil && r.f.lastObserved && r.f.lastObserved < rainUntil ? { madeOn, observedTo: r.f.lastObserved, rainUntil } : null;
	return { runId: r.id, madeOn, stale: outOfDate !== null, outOfDate, ...r.f };
}

/** Evaluate every rule of the project once. As an editor (RLS), inside the job's transaction. */
export async function evaluateAlerts(db: Db, projectId: string, { now = new Date() }: { now?: Date } = {}): Promise<EvalOutcome> {
	const { rows: proj } = await db.query<{ time_zone: string }>('SELECT time_zone FROM project WHERE id = $1', [projectId]);
	const timeZone = proj[0]?.time_zone ?? DEFAULT_TIME_ZONE;
	const today = localDate(now, timeZone);
	await ensureFarmRules(db, projectId);
	await ensureFeedRules(db, projectId);
	await ensureSeriesRules(db, projectId);
	const { rows: rules } = await db.query<RuleRow>(
		`SELECT r.id, r.kind, r.node_id, r.feed_id, r.series_id, r.threshold, r.enabled, e.id AS event_id, e.value AS event_value
		 FROM alert_rule r LEFT JOIN alert_event e ON e.rule_id = r.id AND e.state = 'firing'
		 WHERE r.project_id = $1 ORDER BY r.kind, r.node_id, r.feed_id, r.series_id`,
		[projectId]
	);
	const out: EvalOutcome = { rules: rules.length, opened: 0, cleared: 0, queued: 0 };

	// The current publication and its farms.
	const { rows: pubRows } = await db.query<{
		id: string;
		run_id: string;
		published_at: Date;
		restriction_level: 'none' | 'advisory' | 'restricted';
		restriction_pct: string | null;
		notice: Record<string, string>;
		auto: boolean;
		recent: RecentShortfall | null;
	}>(
		`SELECT id, run_id, published_at, restriction_level, restriction_pct, notice, auto, catchment_view->'recent' AS recent
		 FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL`,
		[projectId]
	);
	const pub = pubRows[0] ?? null;
	const farms = new Map<string, FarmProjection>();
	if (pub) {
		const { rows } = await db.query<{ node_id: string; view: FarmProjection }>('SELECT node_id, view FROM publication_farm WHERE publication_id = $1', [pub.id]);
		for (const r of rows) farms.set(r.node_id, r.view);
	}

	const lazy = <T>(f: () => Promise<T>) => {
		let p: Promise<T> | undefined;
		return () => (p ??= f());
	};
	const forecast = lazy(async () => {
		const f = await newestForecast(db, projectId, timeZone);
		// A forecast whose days have all passed says nothing about what's coming.
		return f && f.to >= today ? f : null;
	});
	const held = lazy(() => heldSinceLastRun(db, projectId));
	const feeds = lazy(async () => {
		const { rows } = await db.query<{ id: string; source: FeedSource; config: FeedConfig; target_name: string; last_data_date: string | null; consecutive_failures: number }>(
			`SELECT id, source, config, target_name, to_char(last_data_date, 'YYYY-MM-DD') AS last_data_date, consecutive_failures
			 FROM data_feed WHERE project_id = $1 AND enabled ORDER BY source, target_kind, target_name`,
			[projectId]
		);
		return rows;
	});
	const series = lazy(async () => {
		const { rows } = await db.query<{ id: string; kind: string; name: string; last: string | null }>(
			`SELECT t.id, t.kind, t.name, to_char(${lastValueDaySql('t')}, 'YYYY-MM-DD') AS last
			 FROM time_series t
			 WHERE t.project_id = $1 AND t.id IN (SELECT r.series_id FROM alert_rule r WHERE r.project_id = $1 AND r.series_id IS NOT NULL AND r.enabled)`,
			[projectId]
		);
		return rows;
	});

	const observe = async (r: RuleRow): Promise<Observation | 'skip'> => {
		switch (r.kind) {
			case 'dam_below': {
				const view = r.node_id ? farms.get(r.node_id) : undefined;
				if (!view?.dam || !pub) return { value: null, detail: {}, runId: null };
				const latest = view.dam.pct;
				const fc = view.forecast?.minDamPct ?? null;
				const forecastLower = fc !== null && fc < latest;
				return {
					value: forecastLower ? fc : latest,
					detail: forecastLower
						? { source: 'forecast', pct: fc, date: view.forecast!.minDamDate ?? view.forecast!.from, madeOn: view.forecast!.madeOn, publishedAt: pub.published_at.toISOString() }
						: { source: 'latest', pct: latest, date: view.dataUntil, publishedAt: pub.published_at.toISOString() },
					runId: pub.run_id
				};
			}
			case 'ewr_forecast_fail': {
				if (await held()) return 'skip';
				const f = await forecast();
				if (!f) return { value: null, detail: {}, runId: null };
				if (f.stale) return 'skip';
				return { value: f.outletEwrDaysAtRisk, detail: { days: f.outletEwrDaysAtRisk, of: f.days, from: f.from, to: f.to, madeOn: f.madeOn }, runId: f.runId };
			}
			case 'data_stale': {
				if (r.series_id) {
					// An ingest-key series: days since its last value, past today's (not whole yet).
					const t = (await series()).find((x) => x.id === r.series_id);
					if (!t?.last) return { value: null, detail: {}, runId: null };
					const overdue = toEpochDay(today) - toEpochDay(t.last) - SERIES_USUAL_DELAY_DAYS;
					const late = { label: seriesLabel(t.kind, t.name), newest: t.last, overdue };
					return { value: overdue, detail: { seriesId: t.id, series: true, feeds: overdue > 0 ? [late] : [] }, runId: null };
				}
				// This rule's feed only, past its own usual delay (the feed's config, else its source's).
				const f = (await feeds()).find((x) => x.id === r.feed_id);
				if (!f?.last_data_date) return { value: null, detail: {}, runId: null };
				const allow = feedStaleAfterDays(f.source, f.config);
				const overdue = toEpochDay(today) - toEpochDay(f.last_data_date) - allow;
				const late = { label: feedLabel(f.source, f.target_name), newest: f.last_data_date, overdue };
				return { value: overdue, detail: { feedId: f.id, feeds: overdue > 0 ? [late] : [] }, runId: null };
			}
			case 'feed_failing': {
				const all = await feeds();
				if (!all.length) return { value: null, detail: {}, runId: null };
				const failing = all.filter((f) => f.consecutive_failures > 0).map((f) => ({ label: feedLabel(f.source, f.target_name), failures: f.consecutive_failures }));
				return { value: Math.max(0, ...failing.map((f) => f.failures)), detail: { feeds: failing.sort((a, b) => b.failures - a.failures).slice(0, 5) }, runId: null };
			}
			case 'farms_short': {
				// An automatic publication's figures only (see the header); counts, never a farm's name.
				const recent = pub?.auto ? pub.recent : null;
				if (!pub || !recent || !Number.isFinite(recent.farmsShort7)) return { value: null, detail: {}, runId: null };
				return {
					value: recent.farmsShort7,
					detail: {
						publicationId: pub.id,
						farmsShort7: recent.farmsShort7,
						of: farms.size,
						farmsShort30: recent.farmsShort30,
						from: recent.from7,
						to: recent.to,
						publishedAt: pub.published_at.toISOString()
					},
					runId: pub.run_id
				};
			}
			case 'job_dead': {
				const { rows } = await db.query<{ n: number }>(
					`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND status = 'dead' AND finished_at > now() - interval '24 hours'`,
					[projectId]
				);
				return { value: rows[0]?.n ?? 0, detail: { count: rows[0]?.n ?? 0 }, runId: null };
			}
			case 'restriction_published':
				return 'skip'; // handled on its own below
		}
	};

	const open = async (r: RuleRow, o: Observation, state: 'firing' | 'cleared' = 'firing') => {
		const { rows } = await db.query<{ id: string }>(
			`INSERT INTO alert_event (rule_id, project_id, state, value, detail, run_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			[r.id, projectId, state, o.value, JSON.stringify(o.detail), o.runId]
		);
		out.opened++;
		if (alertsEnabled()) {
			const { rows: n } = await db.query<{ n: number }>('SELECT app_alert_fan_out($1) AS n', [rows[0]!.id]);
			out.queued += n[0]?.n ?? 0;
		}
	};
	const clear = async (eventId: string) => {
		await db.query(`UPDATE alert_event SET state = 'cleared' WHERE id = $1 AND state = 'firing'`, [eventId]);
		out.cleared++;
	};

	for (const r of rules) {
		// A rule switched off stops firing.
		if (!r.enabled) {
			if (r.event_id) await clear(r.event_id);
			continue;
		}
		if (r.kind === 'restriction_published') {
			if (!pub) continue;
			const pct = pub.restriction_pct === null ? null : Number(pub.restriction_pct);
			// The notice's languages in a fixed order, so the same words always make the same signature.
			const words = Object.keys(pub.notice)
				.sort()
				.map((code) => `${code}:${md5(pub.notice[code]!)}`)
				.join(',');
			const signature = `${pub.restriction_level}|${pct ?? ''}|${words}`;
			const { rows: last } = await db.query<{ signature: string | null }>(
				`SELECT detail->>'signature' AS signature FROM alert_event WHERE rule_id = $1 ORDER BY opened_at DESC, id DESC LIMIT 1`,
				[r.id]
			);
			if (last[0]?.signature === signature) continue;
			// Nothing to announce on a project that never had a restriction.
			if (!last[0] && pub.restriction_level === 'none') continue;
			if (r.event_id) await clear(r.event_id);
			const lifted = pub.restriction_level === 'none';
			await open(
				r,
				{ value: pct, detail: { publicationId: pub.id, level: pub.restriction_level, pct, lifted, signature, publishedAt: pub.published_at.toISOString() }, runId: pub.run_id },
				lifted ? 'cleared' : 'firing'
			);
			continue;
		}
		const o = await observe(r);
		if (o === 'skip') continue;
		const s = step(r.event_id !== null, r.kind, r.threshold, o.value);
		if (s === 'open') await open(r, o);
		else if (s === 'clear') await clear(r.event_id!);
		else if (r.event_id && o.value !== null && o.value !== r.event_value) {
			// Still firing: the event follows the figure, for the pages that show it (no new mail).
			await db.query('UPDATE alert_event SET value = $2, detail = $3 WHERE id = $1', [r.event_id, o.value, JSON.stringify(o.detail)]);
		}
	}
	return out;
}
