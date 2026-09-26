import {
	fromEpochDay,
	provenanceError,
	provenanceLabel,
	sameProvenance,
	scaleValues,
	SERIES_KINDS,
	seriesUnit,
	toEpochDay,
	type SeriesProvenance
} from '@water-management/engine';
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

/**
 * A series' product and version as a body carries them (031_series_provenance.sql):
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
// product / productVersion: what the values are (031_series_provenance.sql), null = not recorded.
export const SERIES_META = `id, kind, name, unit, start_date AS "startDate", cardinality("values") AS length, updated_at AS "updatedAt",
	product, product_version AS "productVersion"`;

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
}

/** Any day with a value. */
export const hasValues = (values: readonly (number | null)[]): boolean => values.some((v) => v !== null);

/** The 409 for days of one version merged into a series of another. */
export const versionMismatch = (holds: SeriesProvenance | null, incoming: SeriesProvenance | null) =>
	new ApiError(
		409,
		`the series holds ${provenanceLabel(holds)} and these days are ${provenanceLabel(incoming)}: merging them would splice two versions into one record. Replace the series whole, or use a series of another name`
	);

/** What a merge did: the series' meta after it, and its values before (null when the merge created it) and after. */
export interface MergeResult {
	meta: SeriesMetaRow;
	before: { id: string; unit: string; startDate: string; values: (number | null)[]; product: string | null; productVersion: string | null } | null;
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
	const { rows: cur } = await db.query<{ id: string; unit: string; start_date: string; values: (number | null)[]; product: string | null; productVersion: string | null }>(
		`SELECT id, unit, start_date, "values", product, product_version AS "productVersion" FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, body.kind, body.name]
	);
	const existing = cur[0] ? { startDate: cur[0].start_date, values: cur[0].values } : null;
	const held = cur[0] ? rowProvenance(cur[0]) : null;
	const filled = !!existing && hasValues(existing.values);
	if (options.provenance !== undefined && filled && !sameProvenance(held, options.provenance)) throw versionMismatch(held, options.provenance);
	// An empty or new series takes the incoming days' label; a filled one keeps its own (the same, or not said).
	const provenance = options.provenance !== undefined && !filled ? options.provenance : held;
	const merged = mergeDaily(existing, { startDate: body.startDate, values: body.values }, options);
	if (merged.values.length > MAX_SERIES_VALUES) throw new ApiError(413, `series would exceed ${MAX_SERIES_VALUES} days`);
	const c = cur[0];
	const before = c ? { id: c.id, unit: c.unit, startDate: c.start_date, values: c.values, product: c.product, productVersion: c.productVersion } : null;
	// Nothing changed (a re-sent batch, a feed re-reading its revision window):
	// leave the row, so updated_at still says when the values last changed.
	if (cur[0] && cur[0].unit === body.unit && sameDaily(existing!, merged) && sameProvenance(held, provenance)) {
		const { rows } = await db.query<SeriesMetaRow>(`SELECT ${SERIES_META} FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3`, [
			projectId,
			body.kind,
			body.name
		]);
		return { meta: rows[0]!, before, after: merged };
	}
	const { rows } = await db.query<SeriesMetaRow>(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", product, product_version)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", product = EXCLUDED.product,
			product_version = EXCLUDED.product_version, updated_at = now()
		 RETURNING ${SERIES_META}`,
		[projectId, body.kind, body.name, body.unit, merged.startDate, merged.values, provenance?.product ?? null, provenance?.version ?? null]
	);
	return { meta: rows[0]!, before, after: merged };
}
