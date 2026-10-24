// The rain feed from the map's catchment boundary in one action (issue #326
// B-rain; docs/api.md § Data feeds, docs/maps.md § Rain from the boundary).
//
//   GET  /projects/:id/feeds/chirps/from-boundary   (editor) the proposal: the
//        CHIRPS cells the boundary covers, area-weighted (boundaryCells.ts),
//        the boundary it came from, and what applying it would do.
//   POST /projects/:id/feeds/chirps/from-boundary   (owner, as every feed
//        change) apply it: create the CHIRPS feed with those cells, or give an
//        existing one them, recorded in the History naming the boundary.
//
// The map proposes, the modeller decides: nothing changes until Apply, and
// Apply names the boundary version it was shown (its updatedAt), so a
// boundary redrawn in between is refused rather than applied unseen.
//
// A feed never splices two areas into one record: the days already in a
// series were averaged over its old cells, so new cells go to a feed whose
// series holds nothing yet, or to a new feed writing a separate series.
//
// Nor does a new series take over unseen (issue #561): a run reads the first
// CHIRPS series by name, so a new one is named to sort after the record runs
// read now, or, when the owner chooses, replaces that record (the feed points
// at it and backfills it whole into a stage, swapped in once complete:
// routes.ts versionCheck, ingest.ts). And where a record exists, the feed
// reads from its first day (`rnl` when that is before 1998), never only the
// last 60 days.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Geometry } from '../geo/geojson.js';
import { withUser, type Db } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from '../history/record.js';
import { requireRole } from '../projects/access.js';
import { boundaryCells, type BoundaryCell } from './boundaryCells.js';
import { sameProvenance } from '@water-management/engine';
import { SeriesStartDate } from '../series/limits.js';
import { type BoundaryMark, CHIRPS_DAILY_PRODUCTS, CHIRPS_PRODUCT_FIRST_DAY, type ChirpsDailyProduct, FeedInput, feedProvenance, type GridConfig } from './config.js';
import { attachSlot, conflict, feedSubject, refuseTakeOver, seriesWords, takesOver, versionCheck } from './routes.js';
import { createFeed, getFeed, listFeeds, runSeries, type RunSeriesPick, targetSeries, updateFeed, type FeedMeta } from './store.js';

/** The series a boundary feed writes: CHIRPS as the reference rainfall, never the catchment rain itself (docs/model.md). */
export const BOUNDARY_TARGET_KIND = 'rain_chirps_mm';
/** The name of a separate series for the boundary's rain, when the default one already holds a record ("CHIRPS boundary", "… 2"). */
export const BOUNDARY_SERIES_NAME = 'CHIRPS boundary';

interface BoundaryRow {
	id: string;
	name: string;
	geometry: Geometry;
	area_m2: number;
	updated_at: Date;
}

async function loadBoundary(db: Db, projectId: string): Promise<BoundaryRow> {
	const { rows } = await db.query<BoundaryRow>(
		`SELECT id, name, geometry, area_m2, updated_at FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary'`,
		[projectId]
	);
	if (!rows[0]) {
		throw new ApiError(409, 'the project has no catchment boundary on its map: draw or upload one on the Map tab first', { code: 'no_boundary' });
	}
	return rows[0];
}

const mark = (b: BoundaryRow): BoundaryMark => ({
	featureId: b.id,
	name: b.name,
	updatedAt: b.updated_at.toISOString(),
	areaKm2: Math.round(b.area_m2 / 1e3) / 1e3
});

function cellsOf(b: BoundaryRow) {
	const r = boundaryCells(b.geometry);
	if ('problem' in r) throw new ApiError(409, r.problem.charAt(0).toUpperCase() + r.problem.slice(1), { code: 'boundary_cells' });
	return r;
}

/** A feed's listed cells as the feed config keeps them (weight only; the share is the proposal's to show). */
const configCells = (cells: readonly BoundaryCell[]) => cells.map(({ lat, lon, weight }) => ({ lat, lon, weight }));

/** Whether the feed already reads this version of the boundary. */
const readsBoundary = (f: Pick<FeedMeta, 'source' | 'config'>, b: BoundaryRow) => {
	const m = f.source === 'chirps' ? (f.config as GridConfig).boundary : undefined;
	return !!m && m.featureId === b.id && m.updatedAt === b.updated_at.toISOString();
};

/**
 * The product and first day the boundary's feed reads unless told otherwise
 * (issue #561): where runs read a CHIRPS record now, from that record's first
 * day (no earlier than CHIRPS begins), with `rnl` when it starts before 1998
 * (`sat` begins then); with no record, `sat` and the last 60 days (startDate null).
 */
export function boundaryDefaults(pick: Pick<RunSeriesPick, 'firstDay'> | null): { product: ChirpsDailyProduct; startDate: string | null } {
	if (!pick?.firstDay) return { product: 'sat', startDate: null };
	const product: ChirpsDailyProduct = pick.firstDay < CHIRPS_PRODUCT_FIRST_DAY.sat ? 'rnl' : 'sat';
	const first = CHIRPS_PRODUCT_FIRST_DAY[product];
	return { product, startDate: pick.firstDay < first ? first : pick.firstDay };
}

/**
 * The product and first day a boundary feed reads: the ones asked for, else
 * an empty feed's own (when it set a first day), else the defaults; a first
 * day not asked for starts no earlier than the product does.
 */
export function boundaryReads(
	defaults: { product: ChirpsDailyProduct; startDate: string | null },
	own: Pick<GridConfig, 'product' | 'startDate'> | null,
	asked: { product?: ChirpsDailyProduct; startDate?: string }
): { product: ChirpsDailyProduct; startDate: string | null } {
	const product = asked.product ?? (own?.startDate !== undefined ? (own.product ?? 'sat') : defaults.product);
	let startDate = asked.startDate ?? own?.startDate ?? defaults.startDate;
	if (asked.startDate === undefined && startDate !== null && startDate < CHIRPS_PRODUCT_FIRST_DAY[product]) startDate = CHIRPS_PRODUCT_FIRST_DAY[product];
	return { product, startDate };
}

/** The CHIRPS feeds a boundary could go to, and the CHIRPS series runs read now. */
async function choices(db: Db, projectId: string, b: BoundaryRow) {
	const feeds = (await listFeeds(db, projectId)).filter((f) => f.source === 'chirps');
	const current = feeds.find((f) => readsBoundary(f, b)) ?? null;
	const pick = await runSeries(db, projectId, BOUNDARY_TARGET_KIND);
	// A feed may take new cells only while its series holds nothing (no record to splice onto), and only one whose
	// series wouldn't take over from the record runs read (an empty feed attached into a name that sorts first).
	const open: FeedMeta[] = [];
	for (const f of feeds) {
		if ((f.config as GridConfig).unit) continue;
		const t = await targetSeries(db, projectId, f.targetKind, f.targetName);
		if (!t?.filled && !takesOver(pick, f.targetName, t !== null)) open.push(f);
	}
	return { feeds, current, open, pick };
}

/** The names a new boundary series may take, in order: the default (''), "CHIRPS boundary", "… 2" …, then the series runs read with " (boundary)" after it, which always sorts after it. */
function* candidateNames(pick: RunSeriesPick | null): Generator<string> {
	yield '';
	yield BOUNDARY_SERIES_NAME;
	for (let i = 2; i < 100; i++) yield `${BOUNDARY_SERIES_NAME} ${i}`;
	if (!pick) return;
	for (let i = 1; i < 100; i++) {
		const name = `${pick.name} (boundary${i === 1 ? '' : ` ${i}`})`;
		if (name.length <= 100) yield name;
	}
}

/**
 * The first target name for a new feed whose series is empty, that no feed
 * writes, and that sorts after the record runs read now (so it never takes
 * over unseen, issue #561): '' (the default series) while no record exists,
 * else "CHIRPS boundary", "… 2", or "<the record's name> (boundary)".
 */
async function freeName(db: Db, projectId: string, feeds: readonly FeedMeta[], pick: RunSeriesPick | null): Promise<string> {
	const taken = new Set(feeds.filter((f) => f.targetKind === BOUNDARY_TARGET_KIND).map((f) => f.targetName));
	for (const name of candidateNames(pick)) {
		if (taken.has(name)) continue;
		const t = await targetSeries(db, projectId, BOUNDARY_TARGET_KIND, name);
		if (!t?.filled && !takesOver(pick, name, t !== null)) return name;
	}
	throw new ApiError(409, 'no free series name for the boundary’s rain: name it (targetName) so it sorts after the CHIRPS series runs read');
}

/**
 * Whether Apply may replace the record runs read (issue #561, (b)): the feed
 * points at it and backfills it whole into a stage, swapped in once complete
 * (routes.ts versionCheck). Not while another feed writes it, nor when it
 * already holds the product and version the feed would write: the ingest
 * stages only a record of another version, and would splice into this one.
 * Null when runs read no record.
 */
function replaceChoice(
	pick: RunSeriesPick | null,
	product: ChirpsDailyProduct
): { available: true; targetName: string; product: ChirpsDailyProduct; startDate: string } | { available: false; targetName: string; reason: string } | null {
	if (!pick?.firstDay) return null;
	const targetName = pick.name;
	if (pick.feedId) return { available: false, targetName, reason: `a feed already writes ${seriesWords(pick.name)}: change or remove that feed to replace its record` };
	if (sameProvenance(pick.provenance, feedProvenance('chirps', { product }))) {
		return {
			available: false,
			targetName,
			reason: `${seriesWords(pick.name)} already holds CHIRPS v3 ${product} days of this version, so the feed would add to it rather than replace it whole`
		};
	}
	const first = CHIRPS_PRODUCT_FIRST_DAY[product];
	return { available: true, targetName, product, startDate: pick.firstDay < first ? first : pick.firstDay };
}

/** The series runs read, as the proposal shows it. */
const pickWords = (pick: RunSeriesPick | null) => (pick ? { name: pick.name, firstDay: pick.firstDay, lastDay: pick.lastDay } : null);

const ApplyBody = z
	.object({
		/** The boundary the proposal was made from, and its version: a boundary changed since is refused. */
		featureId: z.uuid(),
		updatedAt: z.iso.datetime({ offset: true }),
		/** Give these cells to this CHIRPS feed (its series must hold nothing yet); absent: attach a new feed. */
		feedId: z.uuid().optional(),
		/** A new feed's series name (rain_chirps_mm); absent: the one the proposal named. Never one that sorts ahead of the record runs read. */
		targetName: z.string().trim().max(100).optional(),
		/** The CHIRPS v3 daily product; absent: the proposal's (`rnl` when the record runs read starts before 1998). */
		product: z.enum(CHIRPS_DAILY_PRODUCTS).optional(),
		/** The first day to fetch; absent: the proposal's (the record's first day, or the last 60 days with no record). */
		startDate: SeriesStartDate.optional(),
		/** Replace the CHIRPS record runs read with the boundary's, backfilled whole and swapped in once complete (issue #561). */
		replace: z.literal(true).optional()
	})
	.strict()
	.refine((b) => !b.replace || (b.feedId === undefined && b.targetName === undefined), { message: 'replace names its own series: send it without feedId or targetName', path: ['replace'] });

export const feedFromBoundaryRoutes = new Hono<AuthEnv>()
	.get('/:id/feeds/chirps/from-boundary', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			const role = await requireRole(db, id, 'editor');
			const b = await loadBoundary(db, id);
			const r = cellsOf(b);
			const { current, open, feeds, pick } = await choices(db, id, b);
			const defaults = boundaryDefaults(pick);
			// What Apply would do: nothing (already read), give the cells to a feed whose series is empty, or attach one; with
			// the product and first day it would read (an empty feed's own, else the defaults).
			const reads = (f: FeedMeta) => boundaryReads(defaults, f.config as GridConfig, {});
			const apply = current
				? { action: 'none' as const, feedId: current.id }
				: open[0]
					? { action: 'update' as const, feedId: open[0].id, targetKind: open[0].targetKind, targetName: open[0].targetName, ...reads(open[0]) }
					: { action: 'create' as const, targetKind: BOUNDARY_TARGET_KIND, targetName: await freeName(db, id, feeds, pick), ...defaults };
			return c.json({
				boundary: mark(b),
				cells: r.cells,
				rows: r.rows,
				cellsKm2: r.cellsKm2,
				insideKm2: r.insideKm2,
				method: `area-weighted over ${r.cells.length} CHIRPS v3 cell${r.cells.length === 1 ? '' : 's'} (0.05°), each by the share of it inside the boundary`,
				apply,
				// The CHIRPS series runs read now (the first by name), which Apply never takes over from unseen.
				runSeries: pickWords(pick),
				// Or replace it with the boundary's (issue #561): offered while nothing reads the boundary yet.
				replace: current ? null : replaceChoice(pick, defaults.product),
				canApply: role === 'owner'
			});
		})
	)
	.post('/:id/feeds/chirps/from-boundary', async (c) => {
		const body = ApplyBody.parse(await readJson(c));
		const id = c.req.param('id');
		const out = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const b = await loadBoundary(db, id);
			if (b.id !== body.featureId || b.updated_at.getTime() !== new Date(body.updatedAt).getTime()) {
				throw new ApiError(409, 'the catchment boundary changed since this proposal: look at the new proposal before applying it', { code: 'boundary_changed' });
			}
			const r = cellsOf(b);
			const from = { featureId: b.id, name: b.name };
			const pick = await runSeries(db, id, BOUNDARY_TARGET_KIND);
			const defaults = boundaryDefaults(pick);
			if (body.replace) {
				await attachSlot(db, id);
				const product = body.product ?? defaults.product;
				const choice = replaceChoice(pick, product);
				if (!choice) throw new ApiError(409, 'no CHIRPS series holds a record yet, so there is nothing to replace: attach the boundary’s feed instead', { code: 'nothing_to_replace' });
				if (!choice.available) throw new ApiError(409, choice.reason.charAt(0).toUpperCase() + choice.reason.slice(1), { code: 'series_replace' });
				const input = FeedInput.parse({
					source: 'chirps',
					config: { cells: configCells(r.cells), boundary: mark(b), product, ...(body.startDate !== undefined ? { startDate: body.startDate } : {}) },
					targetKind: BOUNDARY_TARGET_KIND,
					targetName: choice.targetName,
					replaceSeries: true
				});
				// A full backfill from the record's first day (a later start date, or sat for a record before 1998, is refused).
				const { input: checked, replaceFrom } = await versionCheck(db, id, input, true);
				if (replaceFrom === undefined) throw new ApiError(409, 'the series already holds what this feed writes, so it would be added to, not replaced', { code: 'series_replace' });
				const fid = await createFeed(db, id, checked, replaceFrom).catch(conflict);
				await recordAudit(db, id, 'feed.configured', { ...feedSubject(fid, 'created', checked), boundary: from, cells: r.cells.length, replaceSeries: replaceFrom });
				return { feed: await getFeed(db, id, fid), created: true };
			}
			if (body.feedId) {
				const cur = await getFeed(db, id, body.feedId);
				if (!cur) throw new ApiError(404, 'not found');
				if (cur.source !== 'chirps') throw new ApiError(409, 'only a CHIRPS daily rainfall feed reads the boundary’s cells');
				// Hold the feed's row while checking its series and saving the new cells, and refuse while a fetch is out
				// (fetch_job_id, 029): its answer was asked for with the old cells, and an ingest that read the feed before this
				// save could still claim it after (app_take_feed_fetch waits on this lock), writing the old area's days into the
				// series the new cells start. Once the fetch is applied, the series is no longer empty, or it never answered.
				const { rows: held } = await db.query<{ fetching: boolean }>(
					'SELECT fetch_job_id IS NOT NULL AS fetching FROM data_feed WHERE id = $1 AND project_id = $2 FOR UPDATE',
					[cur.id, id]
				);
				if (held[0]?.fetching) {
					throw new ApiError(409, 'a fetch for this feed is still out: apply the boundary’s cells once it has come back', { code: 'feed_fetching' });
				}
				if ((await targetSeries(db, id, cur.targetKind, cur.targetName))?.filled) {
					throw new ApiError(
						409,
						'the feed’s series already holds days averaged over its old cells, and a feed never splices two areas into one record: attach a new feed for the boundary instead, into a separate series',
						{ code: 'series_area' }
					);
				}
				const old = cur.config as GridConfig;
				// The product and first day asked for, else the feed's own, else the defaults (the record's first day).
				const { product, startDate } = boundaryReads(defaults, old, body);
				const input = FeedInput.parse({
					source: 'chirps',
					config: {
						cells: configCells(r.cells),
						boundary: mark(b),
						product,
						...(startDate !== null ? { startDate } : {}),
						...(old.staleAfterDays !== undefined ? { staleAfterDays: old.staleAfterDays } : {})
					},
					targetKind: cur.targetKind,
					targetName: cur.targetName,
					schedule: cur.schedule,
					enabled: cur.enabled
				});
				await refuseTakeOver(db, id, input);
				// The series is empty: nothing for the version check to ask.
				const { input: checked } = await versionCheck(db, id, input, false);
				if (!(await updateFeed(db, id, cur.id, checked).catch(conflict))) throw new ApiError(404, 'not found');
				await recordAudit(db, id, 'feed.configured', { ...feedSubject(cur.id, 'changed', checked), boundary: from, cells: r.cells.length });
				return { feed: await getFeed(db, id, cur.id), created: false };
			}
			await attachSlot(db, id);
			const targetName = body.targetName ?? (await freeName(db, id, (await listFeeds(db, id)).filter((f) => f.source === 'chirps'), pick));
			if ((await targetSeries(db, id, BOUNDARY_TARGET_KIND, targetName))?.filled) {
				throw new ApiError(
					409,
					'that series already holds a record; the boundary’s rain goes into a series of its own, so the two can be compared rather than spliced',
					{ code: 'series_area' }
				);
			}
			const { product, startDate } = boundaryReads(defaults, null, body);
			const input = FeedInput.parse({
				source: 'chirps',
				config: { cells: configCells(r.cells), boundary: mark(b), product, ...(startDate !== null ? { startDate } : {}) },
				targetKind: BOUNDARY_TARGET_KIND,
				targetName
			});
			// Never into a new series that would take over from the record runs read (issue #561).
			await refuseTakeOver(db, id, input);
			const { input: checked } = await versionCheck(db, id, input, true);
			const fid = await createFeed(db, id, checked).catch(conflict);
			await recordAudit(db, id, 'feed.configured', { ...feedSubject(fid, 'created', checked), boundary: from, cells: r.cells.length });
			return { feed: await getFeed(db, id, fid), created: true };
		});
		return c.json({ feed: out.feed }, out.created ? 201 : 200);
	});
