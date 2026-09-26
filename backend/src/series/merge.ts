import { fromEpochDay, SERIES_KINDS, toEpochDay } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

export const MAX_SERIES_VALUES = 60_000;

/**
 * A series' first day: a real calendar date. The regex alone lets 2021-02-30
 * through to Postgres, which fails it as a 500. Shared with the project
 * document (projects/document.ts).
 */
export const SeriesStartDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromEpochDay(toEpochDay(s)) === s, 'not a calendar date');

/** A whole series, or the days to merge into one (PUT and POST …/series/merge, and the data feeds). */
export const SeriesBody = z.object({
	kind: z.enum(SERIES_KINDS),
	name: z.string().trim().max(100).default(''),
	unit: z.string().trim().min(1).max(20),
	startDate: SeriesStartDate,
	values: z.array(z.number().finite().nullable()).min(1).max(MAX_SERIES_VALUES)
});
export type SeriesBody = z.output<typeof SeriesBody>;

// updatedAt: when the values last changed (upload, merge) — lets the UI tell
// "new data since the last run" even for corrections inside the run period.
export const SERIES_META = `id, kind, name, unit, start_date AS "startDate", cardinality("values") AS length, updated_at AS "updatedAt"`;

export interface MergeOptions {
	/** A null in the incoming days leaves the existing value (default: it overwrites). */
	keepOnNull?: boolean;
}

export interface Daily {
	startDate: string;
	values: (number | null)[];
}

/**
 * Merge `incoming` into `existing` by date: incoming values win on overlapping
 * days (a corrected or re-sent reading), the series extends in either
 * direction, and days in a gap between the two are null ("no reading").
 * `null` in `incoming` also overwrites — send only the days you have —
 * unless `keepOnNull`, when a null leaves the day as it was (a data feed's
 * "the source has no value for this day" must not erase a value a user or an
 * earlier fetch put there).
 */
export function mergeDaily(existing: Daily | null, incoming: Daily, { keepOnNull = false }: MergeOptions = {}): Daily {
	if (!existing || existing.values.length === 0) return { startDate: incoming.startDate, values: [...incoming.values] };
	const e0 = toEpochDay(existing.startDate);
	const i0 = toEpochDay(incoming.startDate);
	const start = Math.min(e0, i0);
	const end = Math.max(e0 + existing.values.length, i0 + incoming.values.length); // exclusive
	const out: (number | null)[] = new Array(end - start).fill(null);
	existing.values.forEach((v, k) => (out[e0 - start + k] = v));
	incoming.values.forEach((v, k) => {
		if (v !== null || !keepOnNull) out[i0 - start + k] = v;
	});
	return { startDate: fromEpochDay(start), values: out };
}

export interface SeriesMetaRow {
	id: string;
	kind: string;
	name: string;
	unit: string;
	startDate: string;
	length: number;
	updatedAt: string;
}

/** What a merge did: the series' meta after it, and its values before (null when the merge created it) and after. */
export interface MergeResult {
	meta: SeriesMetaRow;
	before: { id: string; unit: string; startDate: string; values: (number | null)[] } | null;
	after: Daily;
}

/**
 * Merge days into a project's series (creating it if needed), as the
 * transaction's user under RLS. POST /projects/:id/series/merge and the data
 * feeds' ingest (feeds/ingest.ts) both go through here, so the lock and merge
 * sequence stay one. The caller checks the role, and records the change in
 * the history (it knows whether a series revision is wanted: not for a feed).
 */
export async function mergeSeries(db: Db, projectId: string, body: SeriesBody, options: MergeOptions = {}): Promise<MergeResult> {
	// Lock the row so two concurrent batches can't lose each other's days.
	const { rows: cur } = await db.query<{ id: string; unit: string; start_date: string; values: (number | null)[] }>(
		`SELECT id, unit, start_date, "values" FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, body.kind, body.name]
	);
	const existing = cur[0] ? { startDate: cur[0].start_date, values: cur[0].values } : null;
	const merged = mergeDaily(existing, { startDate: body.startDate, values: body.values }, options);
	if (merged.values.length > MAX_SERIES_VALUES) throw new ApiError(413, `series would exceed ${MAX_SERIES_VALUES} days`);
	const { rows } = await db.query<SeriesMetaRow>(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now()
		 RETURNING ${SERIES_META}`,
		[projectId, body.kind, body.name, body.unit, merged.startDate, merged.values]
	);
	const c = cur[0];
	return { meta: rows[0]!, before: c ? { id: c.id, unit: c.unit, startDate: c.start_date, values: c.values } : null, after: merged };
}
