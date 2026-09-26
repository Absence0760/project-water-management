// Holding the automatic re-run when an API key pushes days that look wrong
// (roadmap WP-2.16 abuse case "a leaked or mis-configured gateway key poisons
// a series"; docs/security.md § API keys).
//
// A key's ingest is a machine writing without a person looking. When the days
// it pushed hold a value the engine's data-quality rules call impossible or
// far out (engine seriesRowFlags: a negative rain or flow, or a value above
// the outlier limit of the series it lands in), the merge still commits (no
// data is lost, and the History names the key), but:
//   - it queues no automatic re-run, and records `series.held` with the
//     counts and a few examples (mergeInto, series/merge.ts);
//   - an automatic re-run already queued, or queued later by a clean push,
//     does nothing while a `series.held` event is newer than the project's
//     latest run (heldSinceLastRun, jobs/handlers/rerun.ts).
// The hold ends when a person runs the model (the Run button or a queued
// manual re-run; not a scenario run): they have looked at the data, fixed it
// or accepted it.
// A person's own merge from the UI is never held, and a data feed's values
// are checked by its parser instead (feeds/ingest.ts).
import { seriesRowFlags, type SeriesKind } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';

/** How many flagged days a `series.held` event lists. */
export const HELD_EXAMPLES = 5;

export interface HeldDays {
	/** Pushed days below zero. */
	negative: number;
	/** Pushed days above the series' outlier limit. */
	outlier: number;
	/** The first few flagged days, in date order. */
	examples: { date: string; value: number }[];
}

/**
 * The pushed days (`pushed`, as sent) that the engine's rules flag in the
 * merged series (`merged`), or null when none is. Only days that carry a
 * value in the push count: the rest of the series is what it was.
 */
export function anomalousPushedDays(
	kind: SeriesKind,
	merged: { startDate: string; values: (number | null)[] },
	pushed: { startDate: string; values: (number | null)[] }
): HeldDays | null {
	const flags = seriesRowFlags(kind, merged);
	const offset = toEpochDay(pushed.startDate) - toEpochDay(merged.startDate);
	const held: HeldDays = { negative: 0, outlier: 0, examples: [] };
	pushed.values.forEach((v, i) => {
		const k = offset + i;
		if (v === null || k < 0 || k >= merged.values.length) return;
		const negative = flags.negative[k] === true;
		const outlier = flags.outlier[k] === true;
		if (negative) held.negative++;
		if (outlier) held.outlier++;
		if ((negative || outlier) && held.examples.length < HELD_EXAMPLES) held.examples.push({ date: fromEpochDay(toEpochDay(merged.startDate) + k), value: v });
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
