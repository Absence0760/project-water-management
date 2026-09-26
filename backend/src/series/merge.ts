import { SERIES_KINDS } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { MAX_SERIES_VALUES, SeriesStartDate } from './limits.js';

export { MAX_SERIES_VALUES, SeriesStartDate };

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

/** The same days and values (a stored double round-trips exactly, so === is equality). */
export function sameDaily(a: Daily, b: Daily): boolean {
	return a.startDate === b.startDate && a.values.length === b.values.length && a.values.every((v, i) => v === b.values[i]);
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

/**
 * Merge days into a project's series (creating it if needed), as the
 * transaction's user under RLS. POST /projects/:id/series/merge and the data
 * feeds' ingest (feeds/ingest.ts) both go through here, so the lock and merge
 * sequence stay one. The caller checks the role.
 */
export async function mergeInto(db: Db, projectId: string, body: SeriesBody, options: MergeOptions = {}): Promise<SeriesMetaRow> {
	// Lock the row so two concurrent batches can't lose each other's days.
	const { rows: cur } = await db.query<{ start_date: string; unit: string; values: (number | null)[] }>(
		`SELECT start_date, unit, "values" FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, body.kind, body.name]
	);
	const existing = cur[0] ? { startDate: cur[0].start_date, values: cur[0].values } : null;
	const merged = mergeDaily(existing, { startDate: body.startDate, values: body.values }, options);
	if (merged.values.length > MAX_SERIES_VALUES) throw new ApiError(413, `series would exceed ${MAX_SERIES_VALUES} days`);
	// Nothing changed (a re-sent batch, a feed re-reading its revision window):
	// leave the row, so updated_at still says when the values last changed.
	if (cur[0] && cur[0].unit === body.unit && sameDaily(existing!, merged)) {
		const { rows } = await db.query<SeriesMetaRow>(`SELECT ${SERIES_META} FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3`, [
			projectId,
			body.kind,
			body.name
		]);
		return rows[0]!;
	}
	const { rows } = await db.query<SeriesMetaRow>(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now()
		 RETURNING ${SERIES_META}`,
		[projectId, body.kind, body.name, body.unit, merged.startDate, merged.values]
	);
	return rows[0]!;
}
