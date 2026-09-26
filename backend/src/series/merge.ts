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

/**
 * Days as sorted, disjoint, non-adjacent half-open [start, end) epoch-day
 * runs: the days of a series its data feed wrote (time_series.feed_days,
 * 030_feed_days).
 */
export type DayRuns = [number, number][];

/** The runs of the days k in [0, n) that `pick` holds, as epoch days from `day0`. */
function runsOf(day0: number, n: number, pick: (k: number) => boolean): DayRuns {
	const out: DayRuns = [];
	for (let k = 0; k < n; k++) {
		if (!pick(k)) continue;
		const last = out.at(-1);
		if (last && last[1] === day0 + k) last[1]++;
		else out.push([day0 + k, day0 + k + 1]);
	}
	return out;
}

/** Both run lists' days, normalised (overlapping and adjacent runs joined). */
export function unionRuns(a: DayRuns, b: DayRuns): DayRuns {
	const out: DayRuns = [];
	for (const [s, e] of [...a, ...b].sort((x, y) => x[0] - y[0])) {
		const last = out.at(-1);
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else out.push([s, e]);
	}
	return out;
}

/** `a` without the days of `b`. */
export function subtractRuns(a: DayRuns, b: DayRuns): DayRuns {
	let out: DayRuns = a.map(([s, e]) => [s, e]);
	for (const [bs, be] of b) {
		out = out.flatMap(([s, e]): DayRuns => {
			if (be <= s || bs >= e) return [[s, e]];
			const keep: DayRuns = [];
			if (s < bs) keep.push([s, bs]);
			if (be < e) keep.push([be, e]);
			return keep;
		});
	}
	return out;
}

export interface FeedDays {
	/** The days to merge (with keepOnNull): a day the feed may not replace is null. */
	incoming: Daily;
	/** The feed's days afterwards: the ones it held, plus every day it writes now. */
	owned: DayRuns;
	/** Days holding a value the feed didn't write, which it keeps rather than replaces. */
	kept: number;
	/** Days the feed writes: empty ones, and ones it wrote before. */
	written: number;
}

/**
 * What a data feed may write (issue #30). On a day the source has a value,
 * the feed writes it only if the series' value there is empty or one the feed
 * wrote itself (`owned`), so final CHIRPS replaces preliminary and a re-read
 * revises; any other value (uploaded, imported, entered) is kept. A day the
 * source has no value for is left alone, and stays the feed's if it was.
 */
export function feedDays(existing: Daily | null, owned: DayRuns, incoming: Daily): FeedDays {
	const i0 = toEpochDay(incoming.startDate);
	const n = incoming.values.length;
	const mine = new Uint8Array(n);
	for (const [s, e] of owned) for (let d = Math.max(s, i0); d < Math.min(e, i0 + n); d++) mine[d - i0] = 1;
	const e0 = existing ? toEpochDay(existing.startDate) : 0;
	const current = (d: number) => (existing ? (existing.values[d - e0] ?? null) : null);
	const values = incoming.values.slice();
	const writes = new Uint8Array(n);
	let kept = 0;
	values.forEach((v, k) => {
		if (v === null) return;
		if (mine[k] || current(i0 + k) === null) writes[k] = 1;
		else {
			values[k] = null;
			kept++;
		}
	});
	const mineNow = runsOf(i0, n, (k) => writes[k] === 1);
	return {
		incoming: { startDate: incoming.startDate, values },
		owned: unionRuns(owned, mineNow),
		kept,
		written: mineNow.reduce((sum, [s, e]) => sum + e - s, 0)
	};
}

/**
 * A user's write releases the feed's claim on every day it overwrites: the
 * user wins, even with the same value, and the feed keeps that day from now on.
 */
export function releaseDays(owned: DayRuns, incoming: Daily, { keepOnNull = false }: MergeOptions = {}): DayRuns {
	const i0 = toEpochDay(incoming.startDate);
	return subtractRuns(owned, runsOf(i0, incoming.values.length, (k) => incoming.values[k] !== null || !keepOnNull));
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
 *
 * Which days a data feed wrote travels with the row (time_series.feed_id /
 * feed_days, 030_feed_days). With `feedId` (the ingest), the merge writes
 * only the days that feed may replace (feedDays) and records them as its own;
 * without (a user), it releases the feed's claim on every day it overwrites.
 * `kept` counts the days a feed left alone because their value wasn't its own.
 */
export async function mergeInto(
	db: Db,
	projectId: string,
	body: SeriesBody,
	{ keepOnNull = false, feedId }: MergeOptions & { feedId?: string } = {}
): Promise<{ series: SeriesMetaRow; kept: number; written: number }> {
	// Lock the row so two concurrent batches can't lose each other's days.
	const { rows: cur } = await db.query<{ start_date: string; unit: string; values: (number | null)[]; feed_id: string | null; feed_days: DayRuns }>(
		`SELECT start_date, unit, "values", feed_id,
			(SELECT coalesce(json_agg(json_build_array(lower(r) - DATE '1970-01-01', upper(r) - DATE '1970-01-01') ORDER BY r), '[]')
			 FROM unnest(feed_days) r) AS feed_days
		 FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, body.kind, body.name]
	);
	const row = cur[0];
	const existing = row ? { startDate: row.start_date, values: row.values } : null;
	let incoming: Daily = { startDate: body.startDate, values: body.values };
	let owner = row?.feed_id ?? null;
	let owned: DayRuns = row?.feed_days ?? [];
	let kept = 0;
	let written = incoming.values.filter((v) => v !== null || !keepOnNull).length;
	if (feedId) {
		// The days of a feed that no longer writes here (it was removed or re-targeted, which clears them anyway) aren't this one's.
		const plan = feedDays(existing, owner === feedId ? owned : [], incoming);
		({ incoming, kept, written } = plan);
		owner = feedId;
		owned = plan.owned;
	} else {
		owned = releaseDays(owned, incoming, { keepOnNull });
	}
	if (owned.length === 0) owner = null;
	const merged = mergeDaily(existing, incoming, { keepOnNull });
	if (merged.values.length > MAX_SERIES_VALUES) throw new ApiError(413, `series would exceed ${MAX_SERIES_VALUES} days`);
	const sameOwner = !!row && row.feed_id === owner && JSON.stringify(row.feed_days) === JSON.stringify(owned);
	// Nothing changed (a re-sent batch, a feed re-reading its revision window):
	// leave the values, so updated_at still says when the values last changed.
	if (row && row.unit === body.unit && sameDaily(existing!, merged)) {
		const { rows } = sameOwner
			? await db.query<SeriesMetaRow>(`SELECT ${SERIES_META} FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3`, [
					projectId,
					body.kind,
					body.name
				])
			: await db.query<SeriesMetaRow>(
					`UPDATE time_series SET feed_id = $4, feed_days = ${feedDaysSql(5, 6)}
					 WHERE project_id = $1 AND kind = $2 AND name = $3 RETURNING ${SERIES_META}`,
					[projectId, body.kind, body.name, owner, owned.map((r) => r[0]), owned.map((r) => r[1])]
				);
		return { series: rows[0]!, kept, written };
	}
	const { rows } = await db.query<SeriesMetaRow>(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", feed_id, feed_days)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, ${feedDaysSql(8, 9)})
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now(),
			feed_id = EXCLUDED.feed_id, feed_days = EXCLUDED.feed_days
		 RETURNING ${SERIES_META}`,
		[projectId, body.kind, body.name, body.unit, merged.startDate, merged.values, owner, owned.map((r) => r[0]), owned.map((r) => r[1])]
	);
	return { series: rows[0]!, kept, written };
}

/** A datemultirange from two int[] parameters: epoch-day run starts and ends, by parameter number. NULL for no runs. */
const feedDaysSql = (starts: number, ends: number) =>
	`(SELECT range_agg(daterange(DATE '1970-01-01' + s, DATE '1970-01-01' + e)) FROM unnest(\$${starts}::int[], \$${ends}::int[]) AS t(s, e))`;
