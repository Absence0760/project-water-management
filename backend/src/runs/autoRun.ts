// Automatic re-runs after new data (roadmap WP-2.11; docs/architecture.md
// § Background work, 042_auto_rerun.sql): the project setting, the enqueue
// behind the new-data hook (series/newData.ts onSeriesDaysChanged, which
// every source of new days calls), and the auto run's label; and the
// scheduled forecast run a forecast feed's new days queue (WP-2.12,
// enqueueForecastRun), under the same setting.
//
// The setting's defaults live here (resolveAutoRun) and, for the enqueue,
// in app_enqueue_rerun, which reads settings.autoRun itself so that an API
// key's transaction (no user, no project visible under RLS) can queue too.
// autoRun.db.test.ts holds the two together.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { forecastSplit, type ModelInput } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { enqueueJob } from '../jobs/queue.js';
import { RECORDED_RAIN_KINDS, recordedRainUntilSql } from '../series/lastDay.js';

/** What a project's automatic runs do (settings.autoRun). */
export const AUTO_RUN_PUBLISH = ['never', 'if_no_new_warnings'] as const;
export type AutoRunPublish = (typeof AUTO_RUN_PUBLISH)[number];

export interface AutoRunSettings {
	/** Queue a re-run after new data. Off by default: opt in per project. */
	enabled: boolean;
	/** How long after the latest new data the re-run waits (0 in dev runs it at once). */
	debounceMinutes: number;
	/**
	 * `never` (the default): publication stays a person's act (roadmap D5).
	 * `if_no_new_warnings`: an auto run replaces the current publication when
	 * it raises no warning the published run didn't (publish/autoPublish.ts).
	 * Never "always".
	 */
	publish: AutoRunPublish;
}

export const AUTO_RUN_DEFAULTS: Readonly<AutoRunSettings> = Object.freeze({ enabled: false, debounceMinutes: 15, publish: 'never' });

/** The longest debounce a project can set, in minutes. */
export const AUTO_RUN_DEBOUNCE_MAX = 120;
/**
 * However often new data arrives, a queued re-run waits at most this long
 * after the first of it (roadmap: "a constantly-feeding logger still gets
 * runs").
 */
export const AUTO_RUN_MAX_WAIT_MINUTES = 120;

/** The settings patch's shape for `autoRun` (projects/settings.ts): any subset. */
export const AutoRunPatch = z
	.object({
		enabled: z.boolean(),
		debounceMinutes: z.number().int().min(0).max(AUTO_RUN_DEBOUNCE_MAX),
		publish: z.enum(AUTO_RUN_PUBLISH)
	})
	.partial()
	.strict();

/** settings.autoRun over the defaults; a stored field that isn't valid falls back to its default. */
export function resolveAutoRun(settings: unknown): AutoRunSettings {
	const raw = (settings as { autoRun?: unknown } | null)?.autoRun;
	const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
	const debounce = r.debounceMinutes;
	return {
		enabled: r.enabled === true,
		debounceMinutes:
			typeof debounce === 'number' && Number.isInteger(debounce) && debounce >= 0 && debounce <= AUTO_RUN_DEBOUNCE_MAX ? debounce : AUTO_RUN_DEFAULTS.debounceMinutes,
		publish: (AUTO_RUN_PUBLISH as readonly unknown[]).includes(r.publish) ? (r.publish as AutoRunPublish) : AUTO_RUN_DEFAULTS.publish
	};
}

/** What brought the new data (the job payload's `cause`). */
export const NEW_DATA_CAUSES = ['series', 'feed', 'ingest'] as const;
export type NewDataCause = (typeof NEW_DATA_CAUSES)[number];

export interface QueuedRerun {
	jobId: string;
	/** When the re-run is due (ISO). */
	runAfter: string;
	/** This call queued it (false: it pushed back, or joined, one already pending). */
	created: boolean;
}

/**
 * Queue or push back the project's automatic re-run (app_enqueue_rerun), or
 * nothing when the project hasn't turned automatic runs on (null). As the
 * transaction's user, who must be an editor, or as a live API key of the
 * project, whose re-run then runs as the key's creator
 * (app_rerun_acting_user). A key whose creator's account was deleted has
 * nobody to run as: nothing is queued (null), and the ingest still commits.
 * Anyone else: 42501, and the caller's transaction rolls back.
 */
export async function enqueueRerun(db: Db, projectId: string, cause: NewDataCause): Promise<QueuedRerun | null> {
	const { rows } = await db.query<{ job_id: string; due_at: Date; created: boolean }>('SELECT job_id, due_at, created FROM app_enqueue_rerun($1, $2)', [
		projectId,
		cause
	]);
	const r = rows[0];
	return r ? { jobId: r.job_id, runAfter: r.due_at.toISOString(), created: r.created } : null;
}

/**
 * The last day with a recorded rain value (catchment or CHIRPS), or null:
 * how far the data that drives a run reaches, the project list's "Rain to"
 * (series/lastDay.ts). Not the forecast, which runs ahead, nor observed flow,
 * which only scores a run and can run months past the rain. Calendar days
 * (UTC epoch arithmetic), never the machine's time zone.
 */
export function observedDataEnd(series: ModelInput['series']): string | null {
	let last: number | null = null;
	for (const kind of RECORDED_RAIN_KINDS) {
		const s = series[kind];
		if (!s) continue;
		let i = s.values.length - 1;
		while (i >= 0 && s.values[i] === null) i--;
		if (i < 0) continue;
		const day = toEpochDay(s.startDate) + i;
		if (last === null || day > last) last = day;
	}
	return last === null ? null : fromEpochDay(last);
}

/** An auto run's label: `Auto · data to 2026-09-22` (or `Auto` with no data). */
export function autoRunLabel(input: Pick<ModelInput, 'series'>): string {
	const end = observedDataEnd(input.series);
	return end ? `Auto · data to ${end}` : 'Auto';
}

/**
 * The scheduled forecast run's dedupe key: one pending per project, apart
 * from the re-run's ('rerun'), so a forecast run and an auto re-run can both
 * be queued.
 */
export const FORECAST_DEDUPE_KEY = 'forecast';

/**
 * Queue the project's forecast run after a forecast feed (CHIRPS-GEFS) wrote
 * new days (WP-2.12 → WP-2.11; series/newData.ts), or nothing when the
 * project hasn't turned automatic runs on (null): a scheduled forecast run is
 * an automatic run, under the same opt-in and debounce as the re-run. One
 * pending per project (FORECAST_DEDUPE_KEY): a second ingest before it runs
 * joins it, and the run reads the newest issue anyway. As the transaction's
 * user, an editor (the feed's acting user; RLS on job and project).
 */
export async function enqueueForecastRun(db: Db, projectId: string): Promise<QueuedRerun | null> {
	const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const auto = resolveAutoRun(rows[0]?.settings);
	if (!auto.enabled) return null;
	const { job, created } = await enqueueJob(db, {
		projectId,
		kind: 'rerun',
		payload: { label: '', trigger: 'forecast', cause: 'feed' },
		dedupeKey: FORECAST_DEDUPE_KEY,
		delaySeconds: auto.debounceMinutes * 60
	});
	return { jobId: job.id, runAfter: new Date(job.runAfter).toISOString(), created };
}

/** A scheduled forecast run's label: `Forecast · from 2026-09-23` (or `Forecast`). */
export function forecastRunLabel(input: ModelInput): string {
	const from = forecastSplit(input).forecastFrom;
	return from ? `Forecast · from ${from}` : 'Forecast';
}

/**
 * Whether the project's forecast run was made before its recorded rain last
 * changed (a logger's push, a CHIRPS or gauge update, an upload): its
 * history, and so its starting states, are then out of date, and after an
 * outage it can run on weeks of blank days treated as dry. The auto re-run
 * (jobs/handlers/rerun.ts) re-makes it then, whatever brought the rain: the
 * forecast feed only queues one when the forecast itself changes. False with
 * no forecast run (a person makes the first from the Runs tab, or the
 * forecast feed does) or no recorded rain.
 */
export async function forecastRunBehindRain(db: Db, projectId: string): Promise<boolean> {
	const { rows } = await db.query<{ behind: boolean | null }>(
		`SELECT (SELECT max(r.created_at) FROM model_run r WHERE r.project_id = $1 AND NOT r.from_scenario AND r.trigger = 'forecast')
			< (SELECT max(ts.updated_at) FROM time_series ts WHERE ts.project_id = $1 AND ts.kind = ANY($2::text[])) AS behind`,
		[projectId, RECORDED_RAIN_KINDS]
	);
	return rows[0]?.behind === true;
}

/**
 * The project's recorded rain end: the last day with a catchment or CHIRPS
 * rain value (series/lastDay.ts), or null. A forecast run whose
 * summary.forecast.lastObserved is before it ran days since recorded as dry
 * (or on forecast rain), so nothing may alert from it (alerts/evaluate.ts
 * ewr_forecast_fail).
 */
export async function recordedRainUntil(db: Db, projectId: string): Promise<string | null> {
	const { rows } = await db.query<{ until: string | null }>(`SELECT to_char(${recordedRainUntilSql('$1')}, 'YYYY-MM-DD') AS until`, [projectId]);
	return rows[0]?.until ?? null;
}
