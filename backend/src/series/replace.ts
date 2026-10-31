// Replacing a series whole (replaceSeries), apart from the series routes so
// the job worker's data-feed ingest (feeds/ingest.ts) reaches it without the
// routes' post-commit wakeWorker (jobs/wake.ts). The worker Lambda never wakes
// itself: it has no permission to send to the `jobs` queue (infra/jobs.tf),
// and lambda-worker.test.ts guards that nothing it bundles reaches wake.ts.
import type { Db } from '../db/tx.js';
import { lockSeries, recordAudit, recordSeriesRevision, seriesSubject, valuesSha256, type SeriesRow } from '../history/record.js';
import { originLabel, provenanceLabel, sameOrigin, sameProvenance, type SeriesOrigin, type SeriesProvenance } from '@water-management/engine';
import { toEpochDay, fromEpochDay } from '@water-management/engine/calendar';
import { ApiError } from '../http/errors.js';
import {
	assertRoomForSeries,
	type Daily,
	type DayRuns,
	feedDaysSql,
	intersectRuns,
	MAX_SERIES_VALUES,
	type ProductDays,
	rowOrigin,
	rowProvenance,
	runParams,
	SERIES_META as META,
	type SeriesMetaRow,
	subtractRuns,
	unionRuns,
	valueRuns
} from './merge.js';

const sameValues = (a: SeriesRow, unit: string, startDate: string, values: readonly (number | null)[]) =>
	a.unit === unit && a.startDate === startDate && valuesSha256(a.values) === valuesSha256(values);

/** A version change as the audit subject records it: `{ provenance: { from, to } }` labels, or nothing. */
export const provenanceChange = (before: SeriesProvenance | null, after: SeriesProvenance | null) =>
	sameProvenance(before, after) ? {} : { provenance: { from: provenanceLabel(before), to: provenanceLabel(after) } };

/** A source or unit change as the audit subject records it (107_series_source.sql): `{ origin: { from, to } }` labels, or nothing. */
export const originChange = (before: SeriesOrigin | null, after: SeriesOrigin | null) =>
	sameOrigin(before, after) ? {} : { origin: { from: originLabel(before), to: originLabel(after) } };

/**
 * Replace a series whole, keeping its previous values as a series revision
 * first (the history's restore point), so a replace, and a restore too, can
 * be undone. Unchanged values and label record nothing. `restoredFrom`: this
 * puts a series revision back (POST …/revisions/:revId/restore), logged as
 * `restore`. `provenance` is what the new values are (032_series_provenance;
 * null or absent = not recorded: a replace says what it holds or clears it).
 * `revisionReason` / `audit`: a data feed's confirmed replacement
 * (feeds/ingest.ts) keeps the old values as `feed_replace` and adds its feed.
 * `daysChanged`: days whose value changed (a new series: its days with a
 * value), what the new-data hook (series/newData.ts) keys on.
 */
export async function replaceSeries(
	db: Db,
	projectId: string,
	body: { kind: string; name: string; unit: string; startDate: string; values: (number | null)[]; provenance?: SeriesProvenance | null; origin?: SeriesOrigin | null },
	opts: {
		restoredFrom?: string;
		revisionReason?: 'replace' | 'feed_replace';
		audit?: Record<string, unknown>;
		feedId?: string;
		reuseId?: string;
		/**
		 * A feed's area replacement (replaceFeedRecord, 296): which days are the feed's, which a person edited, and which
		 * reference ET product wrote each feed day, written with the values; the API keys' days (a person's, kept) stay.
		 */
		ownership?: { feedDays: DayRuns; handDays: DayRuns; products: ProductDays };
	} = {}
): Promise<{ meta: SeriesMetaRow; daysChanged: number }> {
	const existing = await lockSeries(db, projectId, body.kind, body.name);
	if (!existing) await assertRoomForSeries(db, projectId);
	const provenance = body.provenance ?? null;
	// Where the values came from and the unit they were given in (107): a replace records exactly what it was, or clears it.
	const origin = body.origin ?? null;
	const { rows } = await db.query<SeriesMetaRow>(
		// A replace is new values throughout, so no day of it is one edited by hand (212_series_hand_days; a
		// restore puts its revision's marks back afterwards, history/routes.ts).
		// A person's replace (or restore) makes the whole series the user's: a
		// data feed writing it keeps every day from here on (feed_id NULL clears
		// feed_days, 031_feed_days). A data feed's confirmed replacement
		// (opts.feedId, feeds/ingest.ts) makes it the feed's: every day of the
		// new record is one it wrote, so its later re-reads still revise them.
		// Either way no day has a recorded reference ET product (292_feed_et0_product_days): a replace says none.
		// A restore of a deleted series (opts.reuseId, history/routes.ts) brings it back under its own id while no series
		// holds that id, so what names it by id (settings.rainStations, issue #553) finds it again.
		`INSERT INTO time_series (id, project_id, kind, name, unit, start_date, "values", product, product_version, feed_id, feed_days,
			source, source_unit, source_unit_factor)
		 VALUES (COALESCE((SELECT $13::uuid WHERE NOT EXISTS (SELECT 1 FROM time_series WHERE id = $13::uuid)), gen_random_uuid()),
			$1, $2, $3, $4, $5, $6, $7, $8, $9::uuid,
			CASE WHEN $9::uuid IS NULL THEN NULL ELSE datemultirange(daterange($5::date, $5::date + cardinality($6::float8[]))) END,
			$10, $11, $12)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", product = EXCLUDED.product,
			product_version = EXCLUDED.product_version, updated_at = now(), feed_id = EXCLUDED.feed_id, feed_days = EXCLUDED.feed_days,
			source = EXCLUDED.source, source_unit = EXCLUDED.source_unit, source_unit_factor = EXCLUDED.source_unit_factor,
			hand_days = NULL, feed_agera5_days = NULL, feed_power_days = NULL
		 RETURNING ${META}`,
		[
			projectId,
			body.kind,
			body.name,
			body.unit,
			body.startDate,
			body.values,
			provenance?.product ?? null,
			provenance?.version ?? null,
			opts.feedId ?? null,
			origin?.source ?? null,
			origin?.unit ?? null,
			origin?.factor ?? null,
			opts.reuseId ?? null
		]
	);
	let meta = rows[0]!;
	if (opts.ownership) {
		const o = opts.ownership;
		const { rows: owned } = await db.query<SeriesMetaRow>(
			`UPDATE time_series SET feed_days = ${feedDaysSql(3, 4)}, hand_days = ${feedDaysSql(5, 6)},
				feed_agera5_days = ${feedDaysSql(7, 8)}, feed_power_days = ${feedDaysSql(9, 10)}
			 WHERE project_id = $1 AND id = $2 RETURNING ${META}`,
			[projectId, meta.id, ...runParams(o.feedDays), ...runParams(o.handDays), ...runParams(o.products.agera5), ...runParams(o.products.power)]
		);
		meta = owned[0]!;
	} else {
		// Nor is any day an API key's now (series_key_days, 053: what the ingest hold leaves out of a key's limit).
		await db.query('DELETE FROM series_key_days WHERE project_id = $1 AND series_id = $2', [projectId, meta.id]);
	}
	const restore = opts.restoredFrom ? { target: 'series', restoredFrom: opts.restoredFrom } : null;
	if (!existing) {
		const subject = seriesSubject(meta, null, body, { ...restore, ...opts.audit });
		await recordAudit(db, projectId, restore ? 'restore' : 'series.created', subject);
		return { meta, daysChanged: subject.daysChanged as number };
	}
	const held = rowProvenance({ product: existing.product ?? null, productVersion: existing.productVersion ?? null });
	const heldOrigin = rowOrigin(existing);
	if (!sameValues(existing, body.unit, body.startDate, body.values) || !sameProvenance(held, provenance) || !sameOrigin(heldOrigin, origin)) {
		const revisionId = await recordSeriesRevision(db, projectId, existing, opts.revisionReason ?? 'replace');
		const subject = seriesSubject(meta, existing, body, {
			revisionId,
			...restore,
			...provenanceChange(held, provenance),
			...originChange(heldOrigin, origin),
			...opts.audit
		});
		await recordAudit(db, projectId, restore ? 'restore' : 'series.replaced', subject);
		return { meta, daysChanged: subject.daysChanged as number };
	}
	return { meta, daysChanged: 0 };
}

/**
 * A feed's record re-read over new cells, as it goes into the series
 * (296_feed_area_replace; feeds/ingest.ts): the staged record on every day
 * but the ones a person wrote or edited, which keep their value, as every
 * feed merge keeps them (031_feed_days, 212_series_hand_days). A day the
 * feed wrote over its old cells and the stage has no value for is cleared:
 * it would otherwise be the old area's day in the new area's record.
 *
 * `owned`: the days the feed holds now (its feed_days); `hand`: the days a
 * person edited. Returns the values, the feed's days afterwards (the stage's
 * span less the kept days) and which reference ET product wrote each of them
 * (the stage's, 292).
 */
export function feedRecordSwap(
	existing: Daily | null,
	owned: DayRuns,
	hand: DayRuns,
	stage: Daily,
	stageProducts: ProductDays
): { daily: Daily; feedDays: DayRuns; products: ProductDays } {
	const s0 = toEpochDay(stage.startDate);
	const s1 = s0 + stage.values.length;
	const e0 = existing ? toEpochDay(existing.startDate) : s0;
	const e1 = existing ? e0 + existing.values.length : s0;
	// A person's days: a value the feed didn't write, and every day edited by hand (even one cleared by hand).
	const keep = existing ? unionRuns(subtractRuns(valueRuns(existing), owned), hand) : [];
	const start = Math.min(s0, e0);
	const end = Math.max(s1, e1);
	const values: (number | null)[] = new Array(end - start).fill(null);
	for (let d = s0; d < s1; d++) values[d - start] = stage.values[d - s0] ?? null;
	for (const [a, b] of keep) for (let d = Math.max(a, start); d < Math.min(b, end); d++) values[d - start] = existing!.values[d - e0] ?? null;
	const feedDays = subtractRuns(stage.values.length ? [[s0, s1]] : [], keep);
	return {
		daily: { startDate: fromEpochDay(start), values },
		feedDays,
		products: { agera5: intersectRuns(stageProducts.agera5, feedDays), power: intersectRuns(stageProducts.power, feedDays) }
	};
}

const RUNS_SQL = (col: string) =>
	`(SELECT coalesce(json_agg(json_build_array(lower(r) - DATE '1970-01-01', upper(r) - DATE '1970-01-01') ORDER BY r), '[]') FROM unnest(${col}) r)`;

/**
 * Swap a feed's area replacement into its series (296_feed_area_replace,
 * feeds/ingest.ts): feedRecordSwap's values, written through replaceSeries
 * so the old values are kept as a `feed_replace` series revision and the
 * change is logged as `series.replaced`. The product and version stay what
 * the feed writes; a series holding values keeps its own source (107), a new
 * or empty one takes the feed's. As the feed's acting user, in the ingest's
 * transaction.
 */
export async function replaceFeedRecord(
	db: Db,
	projectId: string,
	body: { kind: string; name: string; unit: string; provenance: SeriesProvenance | null; origin: SeriesOrigin },
	stage: Daily,
	stageProducts: ProductDays,
	opts: { feedId: string; audit: Record<string, unknown> }
): Promise<{ meta: SeriesMetaRow; daysChanged: number }> {
	const { rows } = await db.query<{
		startDate: string;
		values: (number | null)[];
		feedId: string | null;
		feedDays: DayRuns;
		handDays: DayRuns;
		source: string | null;
		sourceUnit: string | null;
		sourceUnitFactor: number | null;
	}>(
		`SELECT to_char(start_date, 'YYYY-MM-DD') AS "startDate", "values", feed_id AS "feedId", ${RUNS_SQL('feed_days')} AS "feedDays",
			${RUNS_SQL('hand_days')} AS "handDays", source, source_unit AS "sourceUnit", source_unit_factor AS "sourceUnitFactor"
		 FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, body.kind, body.name]
	);
	const row = rows[0] ?? null;
	const existing = row ? { startDate: row.startDate, values: row.values } : null;
	// Only this feed's days are its own (a series' feed is the one feed that writes it; the check is for a stale mark).
	const owned = row && row.feedId === opts.feedId ? row.feedDays : [];
	const swap = feedRecordSwap(existing, owned, row?.handDays ?? [], stage, stageProducts);
	if (swap.daily.values.length > MAX_SERIES_VALUES) throw new ApiError(413, `series would exceed ${MAX_SERIES_VALUES} days`);
	const filled = !!existing && existing.values.some((v) => v !== null);
	const origin = filled ? rowOrigin(row!) : body.origin;
	return replaceSeries(
		db,
		projectId,
		{ kind: body.kind, name: body.name, unit: body.unit, startDate: swap.daily.startDate, values: swap.daily.values, provenance: body.provenance, origin },
		{ revisionReason: 'feed_replace', audit: opts.audit, feedId: opts.feedId, ownership: { feedDays: swap.feedDays, handDays: row?.handDays ?? [], products: swap.products } }
	);
}
