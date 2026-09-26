// Holding the automatic re-run when an API key pushes days that look wrong
// (roadmap WP-2.16 abuse case "a leaked or mis-configured gateway key poisons
// a series"; docs/security.md § API keys).
//
// A key's ingest is a machine writing without a person looking. When the days
// it pushed hold a value the engine's data-quality rules call impossible or
// far out (a negative rain or flow, or a value above the engine's outlier
// limit, OUTLIER_FACTOR × the 99th percentile of the series' non-zero days,
// once it has OUTLIER_MIN_POSITIVE of them), the merge still commits (no
// data is lost, and the History names the key), but:
//   - it queues no automatic re-run, and records `series.held` with the
//     counts and a few examples (mergeInto, series/merge.ts);
//   - an automatic re-run already queued, or queued later by a clean push,
//     does nothing while a `series.held` event is newer than the project's
//     latest run (heldSinceLastRun, jobs/handlers/rerun.ts).
// The limit is taken from the series as it was *without* this push (its days
// before the merge, less the days the push overwrites) and without every day
// an earlier push of the same key wrote that nobody has written since
// (series_key_days, 053), so a key can't raise the bar it is judged by: a
// batch of huge values would otherwise lift the 99th percentile over itself,
// and a key poisoning slowly, batch by batch under the limit, would lift it
// for the next. When the days left are too few for the rule
// (OUTLIER_MIN_POSITIVE: a series only that key fills, like a logger's), the
// limit falls back to the series without this push alone, the bar before
// 053; followups.md tracks the better reference for that case.
// The hold ends when a person runs the model (the Run button or a queued
// manual re-run; not a scenario run): they have looked at the data, fixed it
// or accepted it.
// A person's own merge from the UI is never held, and a data feed's values
// are checked by its parser instead (feeds/ingest.ts).
import { OUTLIER_FACTOR, OUTLIER_MIN_POSITIVE, type SeriesKind } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';

/** How many flagged days a `series.held` event lists. */
export const HELD_EXAMPLES = 5;

export interface HeldDays {
	/** Pushed days below zero. */
	negative: number;
	/** Pushed days above the outlier limit of the series without them. */
	outlier: number;
	/** The first few flagged days, in date order. */
	examples: { date: string; value: number }[];
}

type Daily = { startDate: string; values: (number | null)[] };
/** Sorted, disjoint half-open [start, end) epoch-day runs (series/merge.ts DayRuns). */
type DayRuns = [number, number][];

/**
 * The engine's outlier limit (quality.ts seriesRowFlags: OUTLIER_FACTOR × the
 * linear-interpolated 99th percentile of the positive values) for the values
 * of `before` outside the pushed days and the pushing key's earlier days
 * (`keyDays`), or, when those leave fewer than OUTLIER_MIN_POSITIVE, outside
 * the pushed days alone; null when even that is too few.
 */
export function limitWithout(kind: SeriesKind, before: Daily | null, pushed: Daily, keyDays: DayRuns = []): number | null {
	if (!before) return null;
	const e0 = toEpochDay(before.startDate);
	const from = toEpochDay(pushed.startDate) - e0;
	const to = from + pushed.values.length;
	const keys = new Uint8Array(before.values.length);
	for (const [s, e] of keyDays) keys.fill(1, Math.max(0, s - e0), Math.max(0, Math.min(before.values.length, e - e0)));
	const positives = (skipKey: boolean) =>
		Float64Array.from(
			before.values.filter((v, i): v is number => (i < from || i >= to) && !(skipKey && keys[i]) && v !== null && Number.isFinite(v) && v > 0)
		).sort();
	let positive = positives(true);
	if (positive.length < OUTLIER_MIN_POSITIVE && keyDays.length) positive = positives(false);
	if (positive.length < OUTLIER_MIN_POSITIVE) return null;
	const pos = (positive.length - 1) * 0.99;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	const p99 = positive[lo]! + (positive[hi]! - positive[lo]!) * (pos - lo);
	return (kind.startsWith('rain_') ? OUTLIER_FACTOR.rain : OUTLIER_FACTOR.flow) * p99;
}

/**
 * The pushed days (`pushed`, as sent) that are negative, or above the outlier
 * limit of the series before the push without those days and the key's
 * earlier ones (`before`, null for a new series; `keyDays`, limitWithout), or
 * null when none is.
 */
export function anomalousPushedDays(kind: SeriesKind, before: Daily | null, pushed: Daily, keyDays: DayRuns = []): HeldDays | null {
	const limit = limitWithout(kind, before, pushed, keyDays);
	const d0 = toEpochDay(pushed.startDate);
	const held: HeldDays = { negative: 0, outlier: 0, examples: [] };
	pushed.values.forEach((v, i) => {
		if (v === null || !Number.isFinite(v)) return;
		const negative = v < 0;
		const outlier = limit !== null && v > limit;
		if (negative) held.negative++;
		if (outlier) held.outlier++;
		if ((negative || outlier) && held.examples.length < HELD_EXAMPLES) held.examples.push({ date: fromEpochDay(d0 + i), value: v });
	});
	return held.negative || held.outlier ? held : null;
}

/**
 * Whether the project's automatic runs are held: a `series.held` event newer
 * than its latest run a person made (manual, not a scenario's), or any before
 * the first. Read as the re-run's acting user, an editor, who can read both
 * under RLS.
 */
export async function heldSinceLastRun(db: Db, projectId: string): Promise<boolean> {
	const { rows } = await db.query<{ held: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM audit_event e
			WHERE e.project_id = $1 AND e.kind = 'series.held'
				AND e.created_at > coalesce((SELECT max(r.created_at) FROM model_run r WHERE r.project_id = $1 AND r.trigger = 'manual' AND r.scenario_id IS NULL), '-infinity')
		) AS held`,
		[projectId]
	);
	return rows[0]?.held === true;
}
