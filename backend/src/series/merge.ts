import { provenanceError, provenanceLabel, sameProvenance, scaleValues, SERIES_KINDS, seriesUnit, type SeriesProvenance } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { MAX_SERIES_VALUES, SeriesStartDate } from './limits.js';

export { MAX_SERIES_VALUES, SeriesStartDate };

/**
 * A series' product and version as a body carries them (032_series_provenance.sql):
 * both strings, both null (not recorded), or both absent (not said: a merge
 * keeps what the series has). Checked with the engine's rules, the same as
 * the database CHECKs.
 */
export const ProvenanceFields = {
	product: z.string().nullable().optional(),
	productVersion: z.string().nullable().optional()
};

export function checkProvenance(b: { product?: string | null; productVersion?: string | null }, ctx: z.RefinementCtx): void {
	if ((b.product === undefined) !== (b.productVersion === undefined) || (b.product === null) !== (b.productVersion === null)) {
		ctx.addIssue({ code: 'custom', path: ['productVersion'], message: 'give product and productVersion together' });
		return;
	}
	if (typeof b.product === 'string') {
		const err = provenanceError({ product: b.product, version: b.productVersion });
		if (err) ctx.addIssue({ code: 'custom', path: [err.startsWith('version') ? 'productVersion' : 'product'], message: err });
	}
}

/** What a checked body says about provenance: undefined = not said, null = not recorded. */
export const bodyProvenance = (b: { product?: string | null; productVersion?: string | null }): SeriesProvenance | null | undefined =>
	b.product === undefined ? undefined : b.product === null || b.productVersion == null ? null : { product: b.product, version: b.productVersion };

/** A series row's provenance columns as the engine's type. */
export const rowProvenance = (r: { product: string | null; productVersion: string | null }): SeriesProvenance | null =>
	r.product !== null && r.productVersion !== null ? { product: r.product, version: r.productVersion } : null;

/** A whole series, or the days to merge into one (PUT and POST …/series/merge, and the data feeds). */
export const SeriesBody = z
	.object({
		kind: z.enum(SERIES_KINDS),
		name: z.string().trim().max(100).default(''),
		unit: z.string().trim().min(1).max(20),
		startDate: SeriesStartDate,
		values: z.array(z.number().finite().nullable()).min(1).max(MAX_SERIES_VALUES),
		...ProvenanceFields
	})
	.superRefine(checkProvenance)
	.transform(toCanonicalUnit);

/**
 * The model reads flow in m³/s and rain in mm whatever a series' label says,
 * so a series is stored in its kind's canonical unit: the values given in
 * l/s, m³/day, ML/day, cm, in… are scaled, and a unit the engine's table
 * doesn't know is refused (engine units.ts). Shared by every route that
 * writes a series: upload, merge, the data feeds and the project import.
 */
export function toCanonicalUnit<T extends { kind: string; unit: string; values: (number | null)[] }>(b: T, ctx: z.RefinementCtx): T {
	const u = seriesUnit(b.kind, b.unit);
	if (!u.ok) {
		ctx.addIssue({ code: 'custom', path: ['unit'], message: u.error });
		return z.NEVER;
	}
	return { ...b, unit: u.unit, values: scaleValues(b.values, u.factor) };
}
export type SeriesBody = z.output<typeof SeriesBody>;

// updatedAt: when the values last changed (upload, merge) — lets the UI tell
// "new data since the last run" even for corrections inside the run period.
// product / productVersion: what the values are (032_series_provenance.sql), null = not recorded.
// rebuilding: a data feed is backfilling a confirmed replacement of this
// series (feed_stage); the values here stay as they are until it swaps in.
export const SERIES_META = `id, kind, name, unit, start_date AS "startDate", cardinality("values") AS length, updated_at AS "updatedAt",
	product, product_version AS "productVersion",
	EXISTS (SELECT 1 FROM feed_stage st JOIN data_feed sf ON sf.id = st.feed_id
		WHERE sf.project_id = time_series.project_id AND sf.target_kind = time_series.kind AND sf.target_name = time_series.name) AS rebuilding`;

export interface MergeOptions {
	/** A null in the incoming days leaves the existing value (default: it overwrites). */
	keepOnNull?: boolean;
	/**
	 * The product and version of the incoming days (undefined = not said:
	 * the series keeps what it has). Merging days of one version into a series
	 * holding values of another is refused (409): the splice would put a break
	 * in the record. Into an empty or new series, it labels the series.
	 */
	provenance?: SeriesProvenance | null;
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
 * 031_feed_days).
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
	product: string | null;
	productVersion: string | null;
	rebuilding: boolean;
}

/** Any day with a value. */
export const hasValues = (values: readonly (number | null)[]): boolean => values.some((v) => v !== null);

/** The 409 for days of one version merged into a series of another. */
export const versionMismatch = (holds: SeriesProvenance | null, incoming: SeriesProvenance | null) =>
	new ApiError(
		409,
		`the series holds ${provenanceLabel(holds)} and these days are ${provenanceLabel(incoming)}: merging them would splice two versions into one record. Replace the series whole, or use a series of another name`
	);

/**
 * What a merge did: the series' meta after it, and its values (and label)
 * before (null when the merge created it) and after; for a feed's merge, the
 * days it wrote and the days it kept because their value wasn't its own.
 */
export interface MergeResult {
	meta: SeriesMetaRow;
	before: { id: string; unit: string; startDate: string; values: (number | null)[]; product: string | null; productVersion: string | null } | null;
	after: Daily;
	written: number;
	kept: number;
}

/**
 * Merge days into a project's series (creating it if needed), as the
 * transaction's user under RLS. POST /projects/:id/series/merge and the data
 * feeds' ingest (feeds/ingest.ts) both go through here, so the lock and merge
 * sequence stay one. The caller checks the role, and records the change in
 * the history (it knows whether a series revision is wanted: not for a feed).
 *
 * Which days a data feed wrote travels with the row (time_series.feed_id /
 * feed_days, 031_feed_days). With `feedId` (the ingest), the merge writes
 * only the days that feed may replace (feedDays) and records them as its own;
 * without (a user), it releases the feed's claim on every day it overwrites.
 * `kept` counts the days a feed left alone because their value wasn't its own.
 */
export async function mergeSeries(
	db: Db,
	projectId: string,
	body: SeriesBody,
	{ keepOnNull = false, feedId, provenance }: MergeOptions & { feedId?: string } = {}
): Promise<MergeResult> {
	// Lock the row so two concurrent batches can't lose each other's days.
	const { rows: cur } = await db.query<{
		id: string;
		start_date: string;
		unit: string;
		values: (number | null)[];
		feed_id: string | null;
		feed_days: DayRuns;
		product: string | null;
		productVersion: string | null;
	}>(
		`SELECT id, start_date, unit, "values", feed_id, product, product_version AS "productVersion",
			(SELECT coalesce(json_agg(json_build_array(lower(r) - DATE '1970-01-01', upper(r) - DATE '1970-01-01') ORDER BY r), '[]')
			 FROM unnest(feed_days) r) AS feed_days
		 FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, body.kind, body.name]
	);
	const row = cur[0];
	const existing = row ? { startDate: row.start_date, values: row.values } : null;
	// The version guard (032_series_provenance): days of another product or
	// version never go into a series holding values; an empty or new series
	// takes the incoming days' label, a filled one keeps its own.
	const held = row ? rowProvenance(row) : null;
	const filled = !!existing && hasValues(existing.values);
	if (provenance !== undefined && filled && !sameProvenance(held, provenance)) throw versionMismatch(held, provenance);
	const label = provenance !== undefined && !filled ? provenance : held;
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
	const before = row
		? { id: row.id, unit: row.unit, startDate: row.start_date, values: row.values, product: row.product, productVersion: row.productVersion }
		: null;
	const sameOwner = !!row && row.feed_id === owner && JSON.stringify(row.feed_days) === JSON.stringify(owned);
	// Nothing changed (a re-sent batch, a feed re-reading its revision window):
	// leave the values, so updated_at still says when the values last changed.
	if (row && row.unit === body.unit && sameDaily(existing!, merged) && sameProvenance(held, label)) {
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
		return { meta: rows[0]!, before, after: merged, kept, written };
	}
	const { rows } = await db.query<SeriesMetaRow>(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", feed_id, feed_days, product, product_version)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, ${feedDaysSql(8, 9)}, $10, $11)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now(),
			feed_id = EXCLUDED.feed_id, feed_days = EXCLUDED.feed_days,
			product = EXCLUDED.product, product_version = EXCLUDED.product_version
		 RETURNING ${SERIES_META}`,
		[
			projectId,
			body.kind,
			body.name,
			body.unit,
			merged.startDate,
			merged.values,
			owner,
			owned.map((r) => r[0]),
			owned.map((r) => r[1]),
			label?.product ?? null,
			label?.version ?? null
		]
	);
	return { meta: rows[0]!, before, after: merged, kept, written };
}

/** A datemultirange from two int[] parameters: epoch-day run starts and ends, by parameter number. NULL for no runs. */
const feedDaysSql = (starts: number, ends: number) =>
	`(SELECT range_agg(daterange(DATE '1970-01-01' + s, DATE '1970-01-01' + e)) FROM unnest(\$${starts}::int[], \$${ends}::int[]) AS t(s, e))`;
