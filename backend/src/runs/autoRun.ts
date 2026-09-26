// Automatic re-runs after new data (roadmap WP-2.11; docs/architecture.md
// § Background work, 037_auto_rerun.sql).
//
// THE NEW-DATA HOOK: `onNewData(db, projectId, cause)`.
//
//   Every source of new series days calls it once, inside the transaction that
//   wrote the days, after the write and only when days actually changed (an
//   idempotent re-send that changes nothing must not queue a run):
//     - POST /projects/:id/series/merge and PUT /projects/:id/series (a
//       person's upload), cause 'series';
//     - a data feed's merge or confirmed replacement (feeds/ingest.ts), cause
//       'feed';
//     - the API-key ingest (WP-2.9, /ingest/v1/series/merge), cause 'ingest'.
//   Contract:
//     - `db` is a transaction whose app.current_user_id is an editor of the
//       project (withUser; a job runs as its acting user). That user becomes
//       the re-run's acting user. A request with no user (WP-2.9's key context
//       sets app.current_api_key_id only) must resolve one first, e.g. the
//       key's creator re-checked as editor, or app_enqueue_rerun refuses it
//       (42501) and the caller's whole transaction rolls back.
//     - It does nothing (and returns null) unless the project has turned
//       automatic runs on (settings.autoRun.enabled, off by default).
//     - Otherwise it queues or pushes back the project's one pending `rerun`
//       job (app_enqueue_rerun: due `debounceMinutes` from now, never later
//       than AUTO_RUN_MAX_WAIT_MINUTES after the first new data) and returns
//       when it is due, as an ISO timestamp: the `rerunQueuedFor` the merge
//       routes answer with.
//     - It never wakes the worker (that must happen after commit). A caller
//       on the API path wakes it after its transaction commits when the
//       re-run is due at once (series/routes.ts `wakeForRerun`); a caller
//       inside a job needs nothing (the job table's insert trigger NOTIFYs
//       the local worker, and the production tick finds due jobs every 5
//       minutes). Kept out of this module: jobs/wake.ts pulls the memory
//       transport's runner into any bundle that imports it.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { ModelInput } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';

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
 * Queue or push back the project's automatic re-run, whatever the project's
 * setting says (onNewData checks it). As the transaction's user, who must be
 * an editor (app_enqueue_rerun re-checks).
 */
export async function enqueueRerun(
	db: Db,
	projectId: string,
	cause: NewDataCause,
	{ debounceMinutes = AUTO_RUN_DEFAULTS.debounceMinutes, maxWaitMinutes = AUTO_RUN_MAX_WAIT_MINUTES }: { debounceMinutes?: number; maxWaitMinutes?: number } = {}
): Promise<QueuedRerun> {
	const { rows } = await db.query<{ job_id: string; due_at: Date; created: boolean }>(
		'SELECT job_id, due_at, created FROM app_enqueue_rerun($1, make_interval(mins => $2), make_interval(mins => $3), $4)',
		[projectId, debounceMinutes, Math.max(maxWaitMinutes, debounceMinutes), cause]
	);
	const r = rows[0];
	if (!r) throw new Error('app_enqueue_rerun returned no job');
	return { jobId: r.job_id, runAfter: r.due_at.toISOString(), created: r.created };
}

/** The new-data hook (see the header for the contract). */
export async function onNewData(db: Db, projectId: string, cause: NewDataCause): Promise<QueuedRerun | null> {
	const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const auto = resolveAutoRun(rows[0]?.settings);
	if (!auto.enabled) return null;
	return enqueueRerun(db, projectId, cause, { debounceMinutes: auto.debounceMinutes });
}

/**
 * The last day with a value in any input series but the forecast, or null:
 * how far the observed data reaches. Calendar days (UTC epoch arithmetic),
 * never the machine's time zone.
 */
export function observedDataEnd(series: ModelInput['series']): string | null {
	let last: number | null = null;
	for (const [kind, s] of Object.entries(series)) {
		if (kind === 'rain_forecast_mm' || !s) continue;
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
