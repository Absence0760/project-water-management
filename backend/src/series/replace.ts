// Replacing a series whole (replaceSeries), apart from the series routes so
// the job worker's data-feed ingest (feeds/ingest.ts) reaches it without the
// routes' post-commit wakeWorker (jobs/wake.ts). The worker Lambda never wakes
// itself: it has no permission to send to the `jobs` queue (infra/jobs.tf),
// and lambda-worker.test.ts guards that nothing it bundles reaches wake.ts.
import type { Db } from '../db/tx.js';
import { lockSeries, recordAudit, recordSeriesRevision, seriesSubject, valuesSha256, type SeriesRow } from '../history/record.js';
import { originLabel, provenanceLabel, sameOrigin, sameProvenance, type SeriesOrigin, type SeriesProvenance } from '@water-management/engine';
import { assertRoomForSeries, rowOrigin, rowProvenance, SERIES_META as META, type SeriesMetaRow } from './merge.js';

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
	opts: { restoredFrom?: string; revisionReason?: 'replace' | 'feed_replace'; audit?: Record<string, unknown>; feedId?: string } = {}
): Promise<{ meta: SeriesMetaRow; daysChanged: number }> {
	const existing = await lockSeries(db, projectId, body.kind, body.name);
	if (!existing) await assertRoomForSeries(db, projectId);
	const provenance = body.provenance ?? null;
	// Where the values came from and the unit they were given in (107): a replace records exactly what it was, or clears it.
	const origin = body.origin ?? null;
	const { rows } = await db.query<SeriesMetaRow>(
		// A person's replace (or restore) makes the whole series the user's: a
		// data feed writing it keeps every day from here on (feed_id NULL clears
		// feed_days, 031_feed_days). A data feed's confirmed replacement
		// (opts.feedId, feeds/ingest.ts) makes it the feed's: every day of the
		// new record is one it wrote, so its later re-reads still revise them.
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", product, product_version, feed_id, feed_days,
			source, source_unit, source_unit_factor)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid,
			CASE WHEN $9::uuid IS NULL THEN NULL ELSE datemultirange(daterange($5::date, $5::date + cardinality($6::float8[]))) END,
			$10, $11, $12)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", product = EXCLUDED.product,
			product_version = EXCLUDED.product_version, updated_at = now(), feed_id = EXCLUDED.feed_id, feed_days = EXCLUDED.feed_days,
			source = EXCLUDED.source, source_unit = EXCLUDED.source_unit, source_unit_factor = EXCLUDED.source_unit_factor
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
			origin?.factor ?? null
		]
	);
	const meta = rows[0]!;
	// Nor is any day an API key's now (series_key_days, 053: what the ingest hold leaves out of a key's limit).
	await db.query('DELETE FROM series_key_days WHERE project_id = $1 AND series_id = $2', [projectId, meta.id]);
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
