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
//                          that forecast may rest on the held days.
//   data_stale             the enabled data feeds: days past each one's usual
//                          delay (feeds/health.ts staleAfterDays).
//   feed_failing           the enabled data feeds' failures in a row.
//   job_dead               the project's jobs that died in the last 24 hours.
//   restriction_published  the current publication's restriction and notice:
//                          any change is one event (a lift too).
import { createHash } from 'node:crypto';
import type { FarmProjection } from '@water-management/engine';
import { toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';
import { SOURCES, type FeedConfig, type FeedSource } from '../feeds/config.js';
import { heldSinceLastRun } from '../series/hold.js';
import { step, type AlertKind } from './rules.js';

/** ALERTS_ENABLED=false is the kill switch (docs/deployment.md § Runbooks): events still open and clear, nothing is sent. */
export const alertsEnabled = () => process.env.ALERTS_ENABLED !== 'false';

interface RuleRow {
	id: string;
	kind: AlertKind;
	node_id: string | null;
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
		 ON CONFLICT (project_id, kind, node_id) DO NOTHING`,
		[projectId]
	);
}

/** Whether any alert is switched on for the project (as the caller, RLS). */
export async function alertsOn(db: Db, projectId: string): Promise<boolean> {
	const { rows } = await db.query<{ on: boolean }>('SELECT EXISTS (SELECT 1 FROM alert_rule WHERE project_id = $1 AND enabled) AS on', [projectId]);
	return rows[0]?.on === true;
}

const md5 = (s: string | null) => createHash('md5').update(s ?? '').digest('hex');
const feedLabel = (source: FeedSource, targetName: string) => (targetName ? `${SOURCES[source].label} (${targetName})` : SOURCES[source].label);

/** Evaluate every rule of the project once. As an editor (RLS), inside the job's transaction. */
export async function evaluateAlerts(db: Db, projectId: string, { now = new Date() }: { now?: Date } = {}): Promise<EvalOutcome> {
	const today = now.toISOString().slice(0, 10);
	await ensureFarmRules(db, projectId);
	const { rows: rules } = await db.query<RuleRow>(
		`SELECT r.id, r.kind, r.node_id, r.threshold, r.enabled, e.id AS event_id, e.value AS event_value
		 FROM alert_rule r LEFT JOIN alert_event e ON e.rule_id = r.id AND e.state = 'firing'
		 WHERE r.project_id = $1 ORDER BY r.kind, r.node_id`,
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
		notice_en: string | null;
		notice_af: string | null;
	}>(
		`SELECT id, run_id, published_at, restriction_level, restriction_pct, notice_en, notice_af
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
		const { rows } = await db.query<{ id: string; made_on: string; f: { from: string; to: string; days: number; outletEwrDaysAtRisk: number } | null }>(
			`SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS made_on, summary->'forecast' AS f
			 FROM model_run WHERE project_id = $1 AND scenario_id IS NULL AND trigger = 'forecast'
			 ORDER BY created_at DESC LIMIT 1`,
			[projectId]
		);
		const r = rows[0];
		// A forecast whose days have all passed says nothing about what's coming.
		return r?.f && r.f.to >= today ? { runId: r.id, madeOn: r.made_on, ...r.f } : null;
	});
	const held = lazy(() => heldSinceLastRun(db, projectId));
	const feeds = lazy(async () => {
		const { rows } = await db.query<{ source: FeedSource; config: FeedConfig; target_name: string; last_data_date: string | null; consecutive_failures: number }>(
			`SELECT source, config, target_name, to_char(last_data_date, 'YYYY-MM-DD') AS last_data_date, consecutive_failures
			 FROM data_feed WHERE project_id = $1 AND enabled ORDER BY source, target_kind, target_name`,
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
				return { value: f.outletEwrDaysAtRisk, detail: { days: f.outletEwrDaysAtRisk, of: f.days, from: f.from, to: f.to, madeOn: f.madeOn }, runId: f.runId };
			}
			case 'data_stale': {
				const t = toEpochDay(today);
				const late = (await feeds())
					.filter((f) => f.last_data_date)
					.map((f) => {
						const allow = f.config.staleAfterDays ?? SOURCES[f.source].staleAfterDays;
						return { label: feedLabel(f.source, f.target_name), newest: f.last_data_date!, overdue: t - toEpochDay(f.last_data_date!) - allow };
					});
				if (!late.length) return { value: null, detail: {}, runId: null };
				const worst = Math.max(...late.map((x) => x.overdue));
				return { value: worst, detail: { feeds: late.filter((x) => x.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 5) }, runId: null };
			}
			case 'feed_failing': {
				const all = await feeds();
				if (!all.length) return { value: null, detail: {}, runId: null };
				const failing = all.filter((f) => f.consecutive_failures > 0).map((f) => ({ label: feedLabel(f.source, f.target_name), failures: f.consecutive_failures }));
				return { value: Math.max(0, ...failing.map((f) => f.failures)), detail: { feeds: failing.sort((a, b) => b.failures - a.failures).slice(0, 5) }, runId: null };
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
			const signature = `${pub.restriction_level}|${pct ?? ''}|${md5(pub.notice_en)}|${md5(pub.notice_af)}`;
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
