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
// The limit is the engine's rule applied to values the key can't have
// shaped, the first of these with OUTLIER_MIN_POSITIVE non-zero days
// (outlierLimit; `limitFrom` in the held event says which):
//   1. `others`: the series without this push's days and without every day
//      an earlier push of the same key wrote that nobody has written since
//      (series_key_days, 053). Otherwise a batch of huge values would lift
//      the 99th percentile over itself, and a key poisoning slowly, batch by
//      batch under the limit, would lift it for the next.
//   2. `accepted`: for a series the key fills (a logger's, where 1 leaves
//      too few days), what a person last accepted: the values the project's
//      latest manual run read from this series (run_input_series.series_id,
//      056), on the days 1 leaves out, beside the days 1 keeps. A key can't
//      make a run; running the model is also what ends a hold.
//   3. `own`, deliberately, only while no person has accepted enough of the
//      series (no manual run has read it yet, or what it read is too short):
//      the series without this push alone, which the key's earlier pushes
//      shape. The alternative, no outlier limit at all until a person runs
//      the model, would let a single absurd value through where this still
//      catches it; a key poisoning slowly can lift this bar, but only until
//      the first manual run, and the held event says `own` so the reviewer
//      knows how weak it was.
// The hold ends when a person runs the model (the Run button or a queued
// manual re-run; not a scenario run): they have looked at the data, fixed it
// or accepted it.
// A person's own merge from the UI is never held, and a data feed's values
// are checked by its parser instead (feeds/ingest.ts).
import { OUTLIER_MIN_POSITIVE, outlierFactorOf, type SeriesKind } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';

/** How many flagged days a `series.held` event lists. */
export const HELD_EXAMPLES = 5;

/** Which values an outlier limit was taken from (outlierLimit). */
export type LimitFrom = 'others' | 'accepted' | 'own';

export interface HeldDays {
	/** Pushed days below zero. */
	negative: number;
	/** Pushed days above the outlier limit. */
	outlier: number;
	/** The first few flagged days, in date order. */
	examples: { date: string; value: number }[];
	/** Which values the outlier limit came from; null: there was none (too few non-zero days anywhere). */
	limitFrom: LimitFrom | null;
}

type Daily = { startDate: string; values: (number | null)[] };
/** Sorted, disjoint half-open [start, end) epoch-day runs (series/merge.ts DayRuns). */
type DayRuns = [number, number][];

const usable = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

/** OUTLIER_FACTOR × the linear-interpolated 99th percentile (quality.ts seriesRowFlags), or null below OUTLIER_MIN_POSITIVE. */
function engineLimit(kind: SeriesKind, values: number[]): number | null {
	if (values.length < OUTLIER_MIN_POSITIVE) return null;
	const positive = Float64Array.from(values).sort();
	const pos = (positive.length - 1) * 0.99;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	const p99 = positive[lo]! + (positive[hi]! - positive[lo]!) * (pos - lo);
	return outlierFactorOf(kind) * p99;
}

/**
 * The non-zero values of `before` outside the pushed days, and (with
 * `keyDays`) outside the key's own; `skipped` gets every epoch day left out.
 */
function positivesOf(before: Daily, pushed: Daily, keyDays: DayRuns, skipped?: Set<number>): number[] {
	const e0 = toEpochDay(before.startDate);
	const p0 = toEpochDay(pushed.startDate);
	const keys = new Uint8Array(before.values.length);
	for (const [s, e] of keyDays) keys.fill(1, Math.max(0, s - e0), Math.max(0, Math.min(before.values.length, e - e0)));
	const out: number[] = [];
	before.values.forEach((v, i) => {
		const d = e0 + i;
		if ((d >= p0 && d < p0 + pushed.values.length) || keys[i]) skipped?.add(d);
		else if (usable(v)) out.push(v);
	});
	return out;
}

/**
 * Whether the series without the pushed days and the key's own has enough
 * non-zero days for the outlier rule (step 1), so the accepted reference
 * isn't needed.
 */
export function othersSuffice(before: Daily | null, pushed: Daily, keyDays: DayRuns): boolean {
	return !!before && positivesOf(before, pushed, keyDays).length >= OUTLIER_MIN_POSITIVE;
}

/**
 * The engine's outlier limit for a key's push and the values it came from
 * (the steps in the header): `before` the series before the merge (null for a
 * new series), `keyDays` the key's earlier days, `accepted` the values the
 * latest manual run read from this series (null: none). Null when no step has
 * enough non-zero days.
 */
export function outlierLimit(
	kind: SeriesKind,
	before: Daily | null,
	pushed: Daily,
	keyDays: DayRuns = [],
	accepted: Daily | null = null
): { value: number; from: LimitFrom } | null {
	if (!before) return null;
	const skipped = new Set<number>();
	const others = positivesOf(before, pushed, keyDays, skipped);
	const fromOthers = engineLimit(kind, others);
	if (fromOthers !== null) return { value: fromOthers, from: 'others' };
	if (accepted) {
		// The accepted values on the days step 1 left out, and on days the series no longer holds.
		const b0 = toEpochDay(before.startDate);
		const a0 = toEpochDay(accepted.startDate);
		const held = (d: number) => d >= b0 && d < b0 + before.values.length && !skipped.has(d);
		const trusted = [...others, ...accepted.values.filter((v, j): v is number => !held(a0 + j) && usable(v))];
		const fromAccepted = engineLimit(kind, trusted);
		if (fromAccepted !== null) return { value: fromAccepted, from: 'accepted' };
	}
	const fromOwn = engineLimit(kind, positivesOf(before, pushed, []));
	return fromOwn === null ? null : { value: fromOwn, from: 'own' };
}

/** outlierLimit's value alone. */
export const limitWithout = (kind: SeriesKind, before: Daily | null, pushed: Daily, keyDays: DayRuns = [], accepted: Daily | null = null): number | null =>
	outlierLimit(kind, before, pushed, keyDays, accepted)?.value ?? null;

/**
 * The pushed days (`pushed`, as sent) that are negative, or above the outlier
 * limit (outlierLimit, with the same arguments), or null when none is.
 */
export function anomalousPushedDays(
	kind: SeriesKind,
	before: Daily | null,
	pushed: Daily,
	keyDays: DayRuns = [],
	accepted: Daily | null = null
): HeldDays | null {
	const limit = outlierLimit(kind, before, pushed, keyDays, accepted);
	const d0 = toEpochDay(pushed.startDate);
	const held: HeldDays = { negative: 0, outlier: 0, examples: [], limitFrom: limit?.from ?? null };
	pushed.values.forEach((v, i) => {
		if (v === null || !Number.isFinite(v)) return;
		const negative = v < 0;
		const outlier = limit !== null && v > limit.value;
		if (negative) held.negative++;
		if (outlier) held.outlier++;
		if ((negative || outlier) && held.examples.length < HELD_EXAMPLES) held.examples.push({ date: fromEpochDay(d0 + i), value: v });
	});
	return held.negative || held.outlier ? held : null;
}

/**
 * The values the project's latest manual run read from this series, as a
 * person accepted them (056_accepted_series: app_api_key_accepted_series,
 * in the key's transaction), or null when no manual run has read it.
 */
export async function acceptedInput(db: Db, seriesId: string): Promise<Daily | null> {
	const { rows } = await db.query<{ startDate: string; values: (number | null)[] }>(
		`SELECT start_date::text AS "startDate", "values" FROM app_api_key_accepted_series($1)`,
		[seriesId]
	);
	return rows[0] ?? null;
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
