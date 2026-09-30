import { DAY_BOUNDARIES, provenanceError, provenanceLabel, sameOrigin, sameProvenance, scaleValues, seriesOrigin, SERIES_KINDS, seriesUnit, sourceError, type SeriesOrigin, type SeriesProvenance } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { recordAudit, recordSeriesRevision, seriesSubject } from '../history/record.js';
import { MAX_SERIES_ABS_VALUE, MAX_SERIES_VALUES, SERIES_PER_PROJECT_MAX, SeriesStartDate } from './limits.js';
import type { QueuedRerun } from '../runs/autoRun.js';
import { acceptedInput, anomalousPushedDays, type HeldDays, heldFor, othersSuffice } from './hold.js';
import { queueAutoCalibrationFor, queueRerunFor, type SeriesDaysChanged } from './newData.js';
import { lastValueDaySql } from './lastDay.js';

export { MAX_SERIES_VALUES, SERIES_PER_PROJECT_MAX, SeriesStartDate };

/**
 * Before a write creates a series: 409 when the project already holds
 * SERIES_PER_PROJECT_MAX. A hard cap (075_series_cap.sql):
 * app_project_series_count counts every series of the project, not just the
 * ones an API key limited to some series can see, and holds a per-project
 * advisory lock to the end of the transaction, so concurrent creates count
 * one after another. NULL: the caller may not write the project's series.
 */
export async function assertRoomForSeries(db: Db, projectId: string): Promise<void> {
	const { rows } = await db.query<{ n: number | null }>('SELECT app_project_series_count($1) AS n', [projectId]);
	const n = rows[0]!.n;
	if (n === null) throw new ApiError(404, 'not found');
	if (n >= SERIES_PER_PROJECT_MAX) throw new ApiError(409, `a project holds at most ${SERIES_PER_PROJECT_MAX} series; delete one it no longer needs first`);
}

/**
 * Before an API key's merge creates a series: 409 when the project already
 * has an outlet series of that kind (100_key_series_kind.sql). A run reads
 * the first outlet series of each kind by name (runs/execute.ts
 * loadLiveInput), so a key free to add a second one could name it to sort
 * first and swap the model's input for its own days. A person adds the
 * series (an upload, even of one day) and the key may then merge into it.
 * Called after assertRoomForSeries, whose advisory lock serialises creates.
 */
export async function assertKeyMayCreate(db: Db, projectId: string, kind: string): Promise<void> {
	const { rows } = await db.query<{ taken: boolean | null }>('SELECT app_project_has_outlet_series($1, $2) AS taken', [projectId, kind]);
	const taken = rows[0]!.taken;
	if (taken === null) throw new ApiError(404, 'not found');
	if (taken) {
		throw new ApiError(
			409,
			`the project already has a ${kind} series: an API key can only add days to a series that exists. Ask an editor to add this one first, with the record so far (the key's days are checked against at least 100 non-zero days of it)`
		);
	}
}

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

/**
 * Where the values came from (107_series_source.sql): a station id, agency,
 * file or feed; null = not recorded, absent = not said. Checked with the
 * engine's rules (the same as the database CHECK), trimmed.
 */
export const SourceField = z
	.string()
	.nullable()
	.optional()
	.superRefine((v, ctx) => {
		if (typeof v !== 'string') return;
		const err = sourceError(v);
		if (err) ctx.addIssue({ code: 'custom', message: err });
	})
	.transform((v) => (typeof v === 'string' ? v.trim() : v));

/** A whole series, or the days to merge into one (PUT and POST …/series/merge, and the data feeds). */
export const SeriesBody = z
	.object({
		kind: z.enum(SERIES_KINDS),
		name: z.string().trim().max(100).default(''),
		unit: z.string().trim().min(1).max(20),
		startDate: SeriesStartDate,
		values: z.array(z.number().finite().nullable()).min(1).max(MAX_SERIES_VALUES),
		...ProvenanceFields,
		source: SourceField,
		// How sub-daily readings were added up into these days (033_series_day_boundary.sql); null = daily values, absent = not said.
		dayBoundary: z.enum(DAY_BOUNDARIES).nullable().optional()
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
export function toCanonicalUnit<T extends { kind: string; unit: string; values: (number | null)[] }>(
	b: T,
	ctx: z.RefinementCtx
): T & { givenUnit: string; unitFactor: number } {
	const u = seriesUnit(b.kind, b.unit);
	if (!u.ok) {
		ctx.addIssue({ code: 'custom', path: ['unit'], message: u.error });
		return z.NEVER;
	}
	const values = scaleValues(b.values, u.factor);
	// Checked after scaling: 1e308 in inches is finite as sent but Infinity in
	// mm, which Postgres would store and every run would then read.
	const bad = values.findIndex((v) => v !== null && !(Math.abs(v) < MAX_SERIES_ABS_VALUE));
	if (bad >= 0) {
		ctx.addIssue({ code: 'custom', path: ['values', bad], message: `a value must be smaller than ${MAX_SERIES_ABS_VALUE.toExponential()} ${u.unit} (after converting to ${u.unit})` });
		return z.NEVER;
	}
	// The unit as given and the factor applied (107_series_source.sql): what a new series records of its conversion.
	return { ...b, unit: u.unit, values, givenUnit: b.unit, unitFactor: u.factor };
}

/**
 * What a checked body says about its origin (107_series_source.sql): its
 * source (null when it doesn't say one) and the unit it was given in. For a
 * replace, which records exactly what the upload was.
 */
export const bodyOrigin = (b: { source?: string | null; givenUnit?: string; unitFactor?: number }): SeriesOrigin | null =>
	seriesOrigin({ source: b.source ?? null, sourceUnit: b.givenUnit ?? null, sourceUnitFactor: b.unitFactor ?? null });

/** A series row's origin columns as the engine's type (null: none recorded). */
export const rowOrigin = (r: { source?: string | null; sourceUnit?: string | null; sourceUnitFactor?: number | null }): SeriesOrigin | null => seriesOrigin(r);
export type SeriesBody = z.output<typeof SeriesBody>;

// updatedAt: when the values last changed (upload, merge) — lets the UI tell
// "new data since the last run" even for corrections inside the run period.
// product / productVersion: what the values are (032_series_provenance.sql), null = not recorded.
// lastValueDate: the last day with a value (series/lastDay.ts), null when
// every day is blank: "data up to", where startDate + length counts blanks.
// rebuilding: a data feed is backfilling a confirmed replacement of this
// series (feed_stage); the values here stay as they are until it swaps in.
/**
 * Which data feed wrote days of a series, and how many (the Data tab's "from
 * the CHIRPS feed" mark): the feed's source and the days in feed_days
 * (031_feed_days.sql; a datemultirange of [) runs, so upper − lower counts
 * each). Null when no feed wrote a day that is still its own (a user's writes
 * release them), and for a reader below viewer, who can't see data_feed
 * (018_feeds.sql data_feed_select): RLS hides the row, so the subquery is null.
 */
const feedMarkSql = (t: string) => `(SELECT json_build_object('source', f.source, 'days', d.n)
		FROM data_feed f, LATERAL (SELECT sum(upper(r) - lower(r))::int AS n FROM unnest(${t}.feed_days) r) d
		WHERE f.project_id = ${t}.project_id AND f.id = ${t}.feed_id AND d.n > 0)`;

export const SERIES_META = `id, kind, name, unit, start_date AS "startDate", cardinality("values") AS length, updated_at AS "updatedAt",
	to_char(${lastValueDaySql('time_series')}, 'YYYY-MM-DD') AS "lastValueDate",
	product, product_version AS "productVersion", day_boundary AS "dayBoundary", site_node_id AS "siteNodeId",
	source, source_unit AS "sourceUnit", source_unit_factor AS "sourceUnitFactor",
	EXISTS (SELECT 1 FROM feed_stage st JOIN data_feed sf ON sf.id = st.feed_id
		WHERE sf.project_id = time_series.project_id AND sf.target_kind = time_series.kind AND sf.target_name = time_series.name) AS rebuilding,
	${feedMarkSql('time_series')} AS feed`;

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
	/**
	 * Where the incoming days came from and the unit they were given in
	 * (107_series_source.sql; undefined = not said). Only a new or empty
	 * series takes it: a series holding values keeps its own, since its
	 * earlier days didn't come from here.
	 */
	origin?: SeriesOrigin | null;
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
	/** The last day with a value; null when every day is blank. */
	lastValueDate: string | null;
	product: string | null;
	productVersion: string | null;
	dayBoundary: string | null;
	/** The gauge node a flow record was measured at (084_gauge_records); null = the outlet. */
	siteNodeId: string | null;
	/** Where the values came from, and the unit they were given in (107_series_source.sql); null = not recorded. */
	source: string | null;
	sourceUnit: string | null;
	sourceUnitFactor: number | null;
	rebuilding: boolean;
	/** The data feed that wrote days of this series and how many are still its own (031_feed_days.sql); null: none, or not visible to the reader. */
	feed: SeriesFeedMark | null;
}

export interface SeriesFeedMark {
	source: string;
	days: number;
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
	before: {
		id: string;
		unit: string;
		startDate: string;
		values: (number | null)[];
		product: string | null;
		productVersion: string | null;
		source: string | null;
		sourceUnit: string | null;
		sourceUnitFactor: number | null;
	} | null;
	after: Daily;
	written: number;
	kept: number;
	/** For a key's merge (`byKey`): the days that key wrote before this merge and nobody has written since (series_key_days, 053). */
	keyDays: DayRuns;
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
 *
 * Which days each API key wrote travels in series_key_days (053): with
 * `byKey` (an ingest, in withApiKey), the merge records the days whose value
 * it changed as the key's, and returns the key's days from before; any other
 * merge releases the days it writes from every key (trackKeyDays).
 */
export async function mergeSeries(
	db: Db,
	projectId: string,
	body: SeriesBody,
	{ keepOnNull = false, feedId, provenance, origin, byKey = false }: MergeOptions & { feedId?: string; byKey?: boolean } = {}
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
		source: string | null;
		sourceUnit: string | null;
		sourceUnitFactor: number | null;
	}>(
		`SELECT id, start_date, unit, "values", feed_id, product, product_version AS "productVersion",
			source, source_unit AS "sourceUnit", source_unit_factor AS "sourceUnitFactor",
			(SELECT coalesce(json_agg(json_build_array(lower(r) - DATE '1970-01-01', upper(r) - DATE '1970-01-01') ORDER BY r), '[]')
			 FROM unnest(feed_days) r) AS feed_days
		 FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, body.kind, body.name]
	);
	const row = cur[0];
	const existing = row ? { startDate: row.start_date, values: row.values } : null;
	const keyDays: DayRuns =
		byKey && row
			? (
					await db.query<{ days: DayRuns }>(
						`SELECT (SELECT coalesce(json_agg(json_build_array(lower(r) - DATE '1970-01-01', upper(r) - DATE '1970-01-01') ORDER BY r), '[]')
							FROM unnest(days) r) AS days
						 FROM series_key_days WHERE project_id = $1 AND series_id = $2 AND api_key_id = app_current_api_key_id()`,
						[projectId, row.id]
					)
				).rows[0]?.days ?? []
			: [];
	// The version guard (032_series_provenance): days of another product or
	// version never go into a series holding values; an empty or new series
	// takes the incoming days' label, a filled one keeps its own.
	const held = row ? rowProvenance(row) : null;
	const filled = !!existing && hasValues(existing.values);
	if (provenance !== undefined && filled && !sameProvenance(held, provenance)) throw versionMismatch(held, provenance);
	const label = provenance !== undefined && !filled ? provenance : held;
	// The origin (107): a new or empty series takes the incoming days'; one holding values keeps its own.
	const heldOrigin = row ? rowOrigin(row) : null;
	const whence = origin !== undefined && !filled ? origin : heldOrigin;
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
	if (!row) {
		await assertRoomForSeries(db, projectId);
		if (byKey) await assertKeyMayCreate(db, projectId, body.kind);
	}
	const before = row
		? {
				id: row.id,
				unit: row.unit,
				startDate: row.start_date,
				values: row.values,
				product: row.product,
				productVersion: row.productVersion,
				source: row.source,
				sourceUnit: row.sourceUnit,
				sourceUnitFactor: row.sourceUnitFactor
			}
		: null;
	const sameOwner = !!row && row.feed_id === owner && JSON.stringify(row.feed_days) === JSON.stringify(owned);
	// Nothing changed (a re-sent batch, a feed re-reading its revision window):
	// leave the values, so updated_at still says when the values last changed.
	if (row && row.unit === body.unit && sameDaily(existing!, merged) && sameProvenance(held, label) && sameOrigin(heldOrigin, whence)) {
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
		// A person re-sending a key's values makes them theirs all the same (a key's re-send changes nothing, so records nothing).
		await trackKeyDays(db, projectId, rows[0]!.id, existing, incoming, { keepOnNull, byKey });
		return { meta: rows[0]!, before, after: merged, kept, written, keyDays };
	}
	const { rows } = await db.query<SeriesMetaRow>(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", feed_id, feed_days, product, product_version,
			source, source_unit, source_unit_factor)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, ${feedDaysSql(8, 9)}, $10, $11, $12, $13, $14)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now(),
			feed_id = EXCLUDED.feed_id, feed_days = EXCLUDED.feed_days,
			product = EXCLUDED.product, product_version = EXCLUDED.product_version,
			source = EXCLUDED.source, source_unit = EXCLUDED.source_unit, source_unit_factor = EXCLUDED.source_unit_factor
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
			label?.version ?? null,
			whence?.source ?? null,
			whence?.unit ?? null,
			whence?.factor ?? null
		]
	);
	await trackKeyDays(db, projectId, rows[0]!.id, existing, incoming, { keepOnNull, byKey });
	return { meta: rows[0]!, before, after: merged, kept, written, keyDays };
}

/**
 * Keep series_key_days (053) in step with a merge that changed the series'
 * values. A key's merge adds the days whose value it changed to that key's
 * row (a value re-sent unchanged stays whoever's it was). Anyone else's
 * releases every day it writes from every key's row: the value there is
 * theirs now, even when it is the same.
 */
async function trackKeyDays(
	db: Db,
	projectId: string,
	seriesId: string,
	existing: Daily | null,
	incoming: Daily,
	{ keepOnNull, byKey }: { keepOnNull: boolean; byKey: boolean }
): Promise<void> {
	const i0 = toEpochDay(incoming.startDate);
	const e0 = existing ? toEpochDay(existing.startDate) : 0;
	const current = (d: number) => (existing ? (existing.values[d - e0] ?? null) : null);
	const writes = (k: number) => incoming.values[k] !== null || !keepOnNull;
	const days = runsOf(i0, incoming.values.length, byKey ? (k) => writes(k) && incoming.values[k] !== current(i0 + k) : writes);
	if (days.length === 0) return;
	const params = [projectId, seriesId, days.map((r) => r[0]), days.map((r) => r[1])];
	if (byKey) {
		await db.query(
			`INSERT INTO series_key_days (project_id, series_id, api_key_id, days) VALUES ($1, $2, app_current_api_key_id(), ${feedDaysSql(3, 4)})
			 ON CONFLICT (project_id, series_id, api_key_id) DO UPDATE SET days = series_key_days.days + EXCLUDED.days`,
			params
		);
		return;
	}
	// A row whose days are all overwritten goes; the others lose those days.
	await db.query(
		`WITH w AS (SELECT ${feedDaysSql(3, 4)} AS days),
		 gone AS (DELETE FROM series_key_days k USING w WHERE k.project_id = $1 AND k.series_id = $2 AND k.days <@ w.days)
		 UPDATE series_key_days k SET days = k.days - w.days FROM w
		 WHERE k.project_id = $1 AND k.series_id = $2 AND k.days && w.days AND NOT k.days <@ w.days`,
		params
	);
}

/** A datemultirange from two int[] parameters: epoch-day run starts and ends, by parameter number. NULL for no runs. */
const feedDaysSql = (starts: number, ends: number) =>
	`(SELECT range_agg(daterange(DATE '1970-01-01' + s, DATE '1970-01-01' + e)) FROM unnest(\$${starts}::int[], \$${ends}::int[]) AS t(s, e))`;

/**
 * Record how a written series' days were built from sub-daily readings
 * (033_series_day_boundary.sql): `boundary` null = daily values. Returns the
 * meta as it now stands.
 */
export async function setDayBoundary(db: Db, projectId: string, meta: SeriesMetaRow, boundary: string | null): Promise<SeriesMetaRow> {
	if ((meta.dayBoundary ?? null) === boundary) return meta;
	const { rows } = await db.query<SeriesMetaRow>(`UPDATE time_series SET day_boundary = $3 WHERE project_id = $1 AND id = $2 RETURNING ${SERIES_META}`, [
		projectId,
		meta.id,
		boundary
	]);
	return rows[0]!;
}

const boundaryText = (b: string | null) => (b ? `${b}–${b} days` : 'daily values');

export interface MergeIntoOptions {
	/**
	 * Keep the previous values as a series revision (a person's merge, from
	 * the UI). An API key's ingest doesn't: like a data feed's merges, a
	 * logger's are append-mostly and would push a person's restore points out.
	 */
	keepRevision: boolean;
	/** Who wrote the days, for the new-data hook (series/newData.ts): a person, or an API key's ingest. */
	via: Extract<SeriesDaysChanged['via'], 'user' | 'api_key'>;
	/**
	 * A null leaves the day as stored (a person's upload: a blank day in the
	 * file never erases). Without it a null clears the day (the ingest API).
	 */
	keepOnNull?: boolean;
	/** Extra fields for the audit subject (the ingest's `source` label). */
	audit?: Record<string, unknown>;
}

export interface MergeIntoResult {
	meta: SeriesMetaRow;
	/** Days whose value changed (a new series: its days with a value). */
	daysChanged: number;
	/** When a re-run is queued for (series/newData.ts), or null. */
	rerunQueuedFor: string | null;
	/** The re-run the merge queued or pushed back (null: none), for the route to wake the worker after commit. */
	rerun: QueuedRerun | null;
	/** An API key's pushed days the data-quality rules flag: no re-run was queued, and `series.held` records why (series/hold.ts). */
	held: HeldDays | null;
}

/**
 * Merge a body's days into a project's series and record it: the day-boundary
 * guard, the merge itself (mergeSeries), the history (series.created, or
 * series.merged when days or the unit changed) and the new-data hook. The one
 * sequence POST /projects/:id/series/merge and POST /ingest/v1/series/merge
 * share, so the lock and merge order can't drift between them (WP-2.9). The
 * caller has checked access: a role for a person, the key and its allowed
 * series for the ingest (RLS enforces both again).
 */
export async function mergeInto(db: Db, projectId: string, body: SeriesBody, opts: MergeIntoOptions): Promise<MergeIntoResult> {
	// The day-boundary guard (033): days added up in one window never go into a series of the other, like 032's version guard.
	const { rows: held } = await db.query<{ dayBoundary: string | null; filled: boolean }>(
		`SELECT day_boundary AS "dayBoundary", EXISTS (SELECT 1 FROM unnest("values") v WHERE v IS NOT NULL) AS filled
		 FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, body.kind, body.name]
	);
	const was = held[0];
	if (body.dayBoundary !== undefined && was?.filled && (was.dayBoundary ?? null) !== body.dayBoundary) {
		throw new ApiError(
			409,
			`the series holds ${boundaryText(was.dayBoundary ?? null)} and these days are ${boundaryText(body.dayBoundary)}: merging them would put two day boundaries in one record. Replace the series whole, or use a series of another name`
		);
	}
	const r0 = await mergeSeries(db, projectId, body, {
		provenance: bodyProvenance(body),
		origin: bodyOrigin(body),
		byKey: opts.via === 'api_key',
		keepOnNull: opts.keepOnNull
	});
	const r = body.dayBoundary !== undefined && !was?.filled ? { ...r0, meta: await setDayBoundary(db, projectId, r0.meta, body.dayBoundary) } : r0;
	const subject = seriesSubject(r.meta, r.before, r.after, opts.audit);
	const daysChanged = subject.daysChanged as number;
	if (!r.before) await recordAudit(db, projectId, 'series.created', subject);
	else if (daysChanged || r.before.unit !== r.meta.unit) {
		const revisionId = opts.keepRevision
			? await recordSeriesRevision(db, projectId, { ...r.before, kind: r.meta.kind, name: r.meta.name, dayBoundary: was?.dayBoundary ?? null }, 'manual_merge')
			: undefined;
		await recordAudit(db, projectId, 'series.merged', revisionId ? { ...subject, revisionId } : subject);
	}
	// A key's push whose days look wrong holds the automatic re-run for a person to review (series/hold.ts).
	// The accepted reference (the latest manual run's input) is read only when the series without the key's days is too short to judge by.
	// A series the key created is held whatever its days: it becomes the model's input for its kind
	// (assertKeyMayCreate allows it only when the kind had none), with nothing to judge its days by.
	const flagged =
		opts.via === 'api_key' && daysChanged > 0
			? heldFor(
					!r.before,
					anomalousPushedDays(
						body.kind,
						r.before,
						body,
						r.keyDays,
						r.before && !othersSuffice(r.before, body, r.keyDays) ? await acceptedInput(db, r.meta.id) : null
					)
				)
			: null;
	if (flagged) await recordAudit(db, projectId, 'series.held', { seriesId: r.meta.id, kind: r.meta.kind, name: r.meta.name, ...flagged, ...opts.audit });
	// The new-data hook (series/newData.ts; queueRerunFor is onSeriesDaysChanged with the job id kept for the wake-up).
	const change: SeriesDaysChanged = { seriesId: r.meta.id, kind: r.meta.kind, name: r.meta.name, daysChanged, via: opts.via };
	const rerun = flagged ? null : await queueRerunFor(db, projectId, change);
	// And a run of the calibration rules, when they ask for one (issue #153); held data queues neither.
	if (!flagged) await queueAutoCalibrationFor(db, projectId, change);
	return { meta: r.meta, daysChanged, rerunQueuedFor: rerun?.runAfter ?? null, rerun, held: flagged };
}
