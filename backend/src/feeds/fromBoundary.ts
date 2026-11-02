// The rain feed, or the reference ET feed, from the map's catchment boundary
// in one action (issue #326 B-rain; docs/api.md § Data feeds, docs/maps.md §
// Rain from the boundary).
//
//   GET  /projects/:id/feeds/chirps/from-boundary   (editor) the proposal: the
//        CHIRPS cells the boundary covers, area-weighted (boundaryCells.ts),
//        the boundary it came from, and what applying it would do.
//   POST /projects/:id/feeds/chirps/from-boundary   (owner, as every feed
//        change) apply it: create the CHIRPS feed with those cells, or give an
//        existing one them, recorded in the History naming the boundary.
//   GET/POST /projects/:id/feeds/agera5_et0/from-boundary   the same for the
//        daily reference ET feed (`agera5_et0` into `evap_et0_mm`), on our
//        copy's 0.1° grid (boundaryCells.ts ET0_GRID). One code path, set by
//        the source (BoundarySource): reference ET has no daily product and no
//        product version, so it never offers one, and replacing the record runs
//        read is offered only through the catchment feed that wrote it (an area
//        replacement, 296), never over a record a person uploaded.
//
// The map proposes, the modeller decides: nothing changes until Apply, and
// Apply names the boundary version it was shown (its updatedAt), so a
// boundary redrawn in between is refused rather than applied unseen.
//
// A feed never splices two areas into one record: the days already in a
// series were averaged over its old cells, so new cells go to a feed whose
// series holds nothing yet, or to a new feed writing a separate series, or,
// when the owner chooses to replace the record runs read and a catchment
// CHIRPS feed writes it, to that feed, which re-reads its whole record over
// them into its stage and swaps it in once complete (296_feed_area_replace,
// routes.ts areaCheck), so the boundary's rain takes over the default series.
//
// Nor does a new series take over unseen (issue #561): a run reads the first
// CHIRPS series by name, so a new one is named to sort after the record runs
// read now, or, when the owner chooses, replaces that record (the feed points
// at it and backfills it whole into a stage, swapped in once complete:
// routes.ts versionCheck, ingest.ts). And where a record exists, the feed
// reads from its first day (`rnl` when that is before 1998), never only the
// last 60 days.
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Geometry } from '../geo/geojson.js';
import { withUser, type Db } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from '../history/record.js';
import { requireRole } from '../projects/access.js';
import { boundaryCells, type BoundaryCell, type BoundaryGrid, CHIRPS_GRID, ET0_GRID } from './boundaryCells.js';
import { sameProvenance } from '@water-management/engine';
import { SeriesStartDate } from '../series/limits.js';
import {
	type BoundaryMark,
	CHIRPS_DAILY_PRODUCTS,
	CHIRPS_FIRST_DAY,
	CHIRPS_PRODUCT_FIRST_DAY,
	type ChirpsDailyProduct,
	chirpsProduct,
	type FeedConfig,
	FeedInput,
	feedProvenance,
	type GridConfig
} from './config.js';
import { areaCheck, attachSlot, conflict, feedSubject, refuseTakeOver, seriesWords, takesOver, versionCheck } from './routes.js';
import { createFeed, feedFirstOwnDay, getFeed, listFeeds, runSeries, type RunSeriesPick, targetSeries, updateFeed, type FeedMeta } from './store.js';

/** A source a feed from the boundary can read, and how it differs from the others. */
export interface BoundarySource {
	source: 'chirps' | 'agera5_et0';
	/** The series it writes: CHIRPS as the reference rainfall, never the catchment rain itself (docs/model.md); daily reference ET. */
	targetKind: string;
	/** The name of a separate series for the boundary's, when the default one already holds a record ("CHIRPS boundary", "… 2"). */
	seriesName: string;
	grid: BoundaryGrid;
	/** The product in the method's words. */
	product: string;
	/** The source in a message's words: "a catchment CHIRPS feed", "the CHIRPS series runs read". */
	short: string;
	/** What the feed reads, in a message's words: "the boundary’s rain". */
	reads: string;
	/** Whether the feed has a daily product (`config.product`, CHIRPS only) and a product version its series records. */
	products: boolean;
}

export const CHIRPS_BOUNDARY: BoundarySource = {
	source: 'chirps',
	targetKind: 'rain_chirps_mm',
	seriesName: 'CHIRPS boundary',
	grid: CHIRPS_GRID,
	product: 'CHIRPS v3',
	short: 'CHIRPS',
	reads: 'rain',
	products: true
};

export const ET0_BOUNDARY: BoundarySource = {
	source: 'agera5_et0',
	targetKind: 'evap_et0_mm',
	seriesName: 'Reference ET boundary',
	grid: ET0_GRID,
	product: 'AgERA5',
	short: 'reference ET',
	reads: 'reference ET',
	products: false
};

/** The series a CHIRPS boundary feed writes (CHIRPS_BOUNDARY.targetKind). */
export const BOUNDARY_TARGET_KIND = CHIRPS_BOUNDARY.targetKind;
/** The name of a separate series for the boundary's rain (CHIRPS_BOUNDARY.seriesName). */
export const BOUNDARY_SERIES_NAME = CHIRPS_BOUNDARY.seriesName;

/** The first day a feed of `k` may read: its daily product's, or the grid config's floor for reference ET (config.ts GridConfig). */
const firstDayOf = (k: BoundarySource, product: ChirpsDailyProduct | undefined) => (k.products ? CHIRPS_PRODUCT_FIRST_DAY[product ?? 'sat'] : CHIRPS_FIRST_DAY);
/** What a boundary feed reads: CHIRPS's daily product (none for reference ET), and its first day (null: the source's own default). */
export interface BoundaryReads {
	product?: ChirpsDailyProduct;
	startDate: string | null;
}

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

function cellsOf(b: BoundaryRow, k: BoundarySource) {
	const r = boundaryCells(b.geometry, 'the catchment boundary', k.grid);
	if ('problem' in r) throw new ApiError(409, r.problem.charAt(0).toUpperCase() + r.problem.slice(1), { code: 'boundary_cells' });
	return r;
}

/** A feed's listed cells as the feed config keeps them (weight only; the share is the proposal's to show). */
const configCells = (cells: readonly BoundaryCell[]) => cells.map(({ lat, lon, weight }) => ({ lat, lon, weight }));

/** Whether the feed (of `k`'s source) already reads this version of the boundary. */
const readsBoundary = (k: BoundarySource, f: Pick<FeedMeta, 'source' | 'config'>, b: BoundaryRow) => {
	const m = f.source === k.source ? (f.config as GridConfig).boundary : undefined;
	return !!m && m.featureId === b.id && m.updatedAt === b.updated_at.toISOString();
};

/**
 * The product and first day the boundary's feed reads unless told otherwise
 * (issue #561): where runs read a CHIRPS record now, from that record's first
 * day (no earlier than CHIRPS begins), with `rnl` when it starts before 1998
 * (`sat` begins then); with no record, `sat` and the last 60 days (startDate null).
 * Reference ET (`k` ET0_BOUNDARY): no product, from the record's first day
 * (1981 at the earliest), else null (the last 365 days, fetch.ts ET0_FIRST_DAYS).
 */
export function boundaryDefaults(pick: Pick<RunSeriesPick, 'firstDay'> | null, k: BoundarySource = CHIRPS_BOUNDARY): BoundaryReads {
	if (!k.products) return { startDate: pick?.firstDay ? (pick.firstDay < CHIRPS_FIRST_DAY ? CHIRPS_FIRST_DAY : pick.firstDay) : null };
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
	defaults: BoundaryReads,
	own: Pick<GridConfig, 'product' | 'startDate'> | null,
	asked: { product?: ChirpsDailyProduct; startDate?: string },
	k: BoundarySource = CHIRPS_BOUNDARY
): BoundaryReads {
	const product = k.products ? (asked.product ?? (own?.startDate !== undefined ? (own.product ?? 'sat') : (defaults.product ?? 'sat'))) : undefined;
	let startDate = asked.startDate ?? own?.startDate ?? defaults.startDate;
	const first = firstDayOf(k, product);
	if (asked.startDate === undefined && startDate !== null && startDate < first) startDate = first;
	return { ...(product !== undefined ? { product } : {}), startDate };
}

/** The feeds of `k`'s source a boundary could go to, and the series of its kind runs read now. */
async function choices(db: Db, projectId: string, b: BoundaryRow, k: BoundarySource) {
	const feeds = (await listFeeds(db, projectId)).filter((f) => f.source === k.source);
	const current = feeds.find((f) => readsBoundary(k, f, b)) ?? null;
	const pick = await runSeries(db, projectId, k.targetKind);
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
function* candidateNames(pick: RunSeriesPick | null, k: BoundarySource): Generator<string> {
	yield '';
	yield k.seriesName;
	for (let i = 2; i < 100; i++) yield `${k.seriesName} ${i}`;
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
async function freeName(db: Db, projectId: string, feeds: readonly FeedMeta[], pick: RunSeriesPick | null, k: BoundarySource): Promise<string> {
	const taken = new Set(feeds.filter((f) => f.targetKind === k.targetKind).map((f) => f.targetName));
	for (const name of candidateNames(pick, k)) {
		if (taken.has(name)) continue;
		const t = await targetSeries(db, projectId, k.targetKind, name);
		if (!t?.filled && !takesOver(pick, name, t !== null)) return name;
	}
	throw new ApiError(409, `no free series name for the boundary’s ${k.reads}: name it (targetName) so it sorts after the ${k.short} series runs read`);
}

type ReplaceChoice =
	| { available: true; targetName: string; product?: ChirpsDailyProduct; startDate: string; feedId?: string; area?: true }
	| { available: false; targetName: string; reason: string };

/**
 * Whether Apply may replace the record runs read (issue #561, (b)), and how.
 * With no feed writing it: a new feed points at it and backfills it whole
 * into a stage, swapped in once complete (routes.ts versionCheck); not when it
 * already holds the product and version the feed would write, since then the
 * feed would only fill its empty days around a person's. With a catchment
 * CHIRPS feed writing it (296_feed_area_replace): that feed takes the
 * boundary's cells and re-reads its whole record over them into its stage
 * (`area`; routes.ts areaCheck), its own product unless another is asked
 * for, which makes it a version replacement instead. A unit's feed never
 * writes the series runs read. Null when runs read no record.
 *
 * Reference ET has no product version to replace a record by, so it is
 * replaced only through the catchment feed that writes it, as an area
 * replacement; a record no feed writes (a person's upload) is kept.
 */
async function replaceChoice(
	db: Db,
	projectId: string,
	pick: RunSeriesPick | null,
	feeds: readonly FeedMeta[],
	k: BoundarySource,
	defaults: ChirpsDailyProduct | undefined,
	asked?: ChirpsDailyProduct
): Promise<ReplaceChoice | null> {
	if (!pick?.firstDay) return null;
	const targetName = pick.name;
	if (pick.feedId) {
		const f = feeds.find((x) => x.id === pick.feedId);
		if (!f || f.source !== k.source || (f.config as GridConfig).unit) {
			return { available: false, targetName, reason: `a feed other than a catchment ${k.short} feed writes ${seriesWords(pick.name)}: change or remove that feed to replace its record` };
		}
		if (!k.products) {
			// The feed's own days, from its first one, re-read over the boundary's cells.
			const own = (await feedFirstOwnDay(db, projectId, f.id, f.targetKind, f.targetName)) ?? pick.firstDay;
			return { available: true, targetName, startDate: own < CHIRPS_FIRST_DAY ? CHIRPS_FIRST_DAY : own, feedId: f.id, area: true };
		}
		const product = asked ?? chirpsProduct(f.config);
		if (!sameProvenance(pick.provenance, feedProvenance('chirps', { product }))) {
			// The series holds another product or version: it is replaced whole (#40c), from its first day.
			const first = CHIRPS_PRODUCT_FIRST_DAY[product];
			return { available: true, targetName, product, startDate: pick.firstDay < first ? first : pick.firstDay, feedId: f.id };
		}
		// The same product: the feed's own days, from its first one, re-read over the boundary's cells.
		const own = (await feedFirstOwnDay(db, projectId, f.id, f.targetKind, f.targetName)) ?? pick.firstDay;
		const first = CHIRPS_PRODUCT_FIRST_DAY[product];
		return { available: true, targetName, product, startDate: own < first ? first : own, feedId: f.id, area: true };
	}
	if (!k.products) {
		return {
			available: false,
			targetName,
			reason: `no feed writes ${seriesWords(pick.name)}, and a ${k.short} feed replaces only a record its own feed wrote: keep it, and compare the boundary’s beside it`
		};
	}
	const product = asked ?? defaults ?? 'sat';
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
		/** Give these cells to this feed of the route's source (its series must hold nothing yet); absent: attach a new feed. */
		feedId: z.uuid().optional(),
		/** A new feed's series name (rain_chirps_mm, evap_et0_mm); absent: the one the proposal named. Never one that sorts ahead of the record runs read. */
		targetName: z.string().trim().max(100).optional(),
		/** CHIRPS only: the v3 daily product; absent: the proposal's (`rnl` when the record runs read starts before 1998). */
		product: z.enum(CHIRPS_DAILY_PRODUCTS).optional(),
		/** The first day to fetch; absent: the proposal's (the record's first day, or the last 60 days with no record). */
		startDate: SeriesStartDate.optional(),
		/** Replace the record runs read with the boundary's, backfilled whole and swapped in once complete (issue #561). */
		replace: z.literal(true).optional()
	})
	.strict()
	.refine((b) => !b.replace || (b.feedId === undefined && b.targetName === undefined), { message: 'replace names its own series: send it without feedId or targetName', path: ['replace'] });

/**
 * Hold the feed's row while checking its series and saving new cells, and
 * refuse while a fetch is out (fetch_job_id, 029): its answer was asked for
 * with the old cells, and an ingest that read the feed before this save could
 * still claim it after (app_take_feed_fetch waits on this lock), writing the
 * old area's days into the series the new cells start. Once the fetch is
 * applied, the series is no longer empty, or it never answered.
 */
async function holdFeed(db: Db, projectId: string, feedId: string): Promise<void> {
	const { rows: held } = await db.query<{ fetching: boolean }>('SELECT fetch_job_id IS NOT NULL AS fetching FROM data_feed WHERE id = $1 AND project_id = $2 FOR UPDATE', [
		feedId,
		projectId
	]);
	if (held[0]?.fetching) {
		throw new ApiError(409, 'a fetch for this feed is still out: apply the boundary’s cells once it has come back', { code: 'feed_fetching' });
	}
}

/**
 * Replace the record runs read through the catchment feed that writes it
 * (296_feed_area_replace): the feed takes the boundary's cells, and re-reads
 * its whole record over them (routes.ts areaCheck), or, with another CHIRPS
 * product, replaces the series whole (versionCheck); either way staged and
 * swapped in once complete.
 */
async function replaceThroughFeed(
	db: Db,
	projectId: string,
	cur: FeedMeta,
	b: BoundaryRow,
	cells: readonly BoundaryCell[],
	product: ChirpsDailyProduct | undefined,
	startDate: string | undefined
): Promise<{ feed: FeedMeta | null; created: false }> {
	await holdFeed(db, projectId, cur.id);
	const old = cur.config as GridConfig;
	const input = FeedInput.parse({
		source: cur.source,
		config: {
			cells: configCells(cells),
			boundary: mark(b),
			...(product !== undefined ? { product } : {}),
			...(startDate !== undefined ? { startDate } : {}),
			...(old.staleAfterDays !== undefined ? { staleAfterDays: old.staleAfterDays } : {})
		},
		targetKind: cur.targetKind,
		targetName: cur.targetName,
		schedule: cur.schedule,
		enabled: cur.enabled,
		replaceSeries: true
	});
	const version = await versionCheck(db, projectId, input, !sameProvenance(feedProvenance(input.source, input.config), cur.writes));
	let checked = version.input;
	let replaceFrom: string | undefined = version.replaceFrom;
	let configFrom: FeedConfig | null = null;
	if (replaceFrom === undefined) {
		const area = await areaCheck(db, projectId, cur, checked, true, true);
		checked = area.input;
		replaceFrom = area.replaceFrom ?? undefined;
		configFrom = area.replaceConfigFrom ?? null;
	}
	if (!(await updateFeed(db, projectId, cur.id, checked, replaceFrom, configFrom).catch(conflict))) throw new ApiError(404, 'not found');
	await recordAudit(db, projectId, 'feed.configured', {
		...feedSubject(cur.id, 'changed', checked),
		boundary: { featureId: b.id, name: b.name },
		cells: cells.length,
		...(replaceFrom !== undefined ? { replaceSeries: replaceFrom } : {})
	});
	return { feed: await getFeed(db, projectId, cur.id), created: false };
}

/** GET …/feeds/<source>/from-boundary: the proposal. */
const proposal = (k: BoundarySource) => async (c: Context<AuthEnv>) =>
	withUser(c.get('userId'), async (db) => {
		const id = c.req.param('id')!;
		const role = await requireRole(db, id, 'editor');
		const b = await loadBoundary(db, id);
		const r = cellsOf(b, k);
		const { current, open, feeds, pick } = await choices(db, id, b, k);
		const defaults = boundaryDefaults(pick, k);
		// What Apply would do: nothing (already read), give the cells to a feed whose series is empty, or attach one; with
		// the product and first day it would read (an empty feed's own, else the defaults).
		const reads = (f: FeedMeta) => boundaryReads(defaults, f.config as GridConfig, {}, k);
		const apply = current
			? { action: 'none' as const, feedId: current.id }
			: open[0]
				? { action: 'update' as const, feedId: open[0].id, targetKind: open[0].targetKind, targetName: open[0].targetName, ...reads(open[0]) }
				: { action: 'create' as const, targetKind: k.targetKind, targetName: await freeName(db, id, feeds, pick, k), ...defaults };
		return c.json({
			boundary: mark(b),
			cells: r.cells,
			rows: r.rows,
			cellsKm2: r.cellsKm2,
			insideKm2: r.insideKm2,
			method: `area-weighted over ${r.cells.length} ${k.product} cell${r.cells.length === 1 ? '' : 's'} (${k.grid.step}°), each by the share of it inside the boundary`,
			apply,
			// The series of the kind runs read now (the first by name), which Apply never takes over from unseen.
			runSeries: pickWords(pick),
			// Or replace it with the boundary's (issue #561; through the feed that writes it, 296): offered while nothing reads the boundary yet.
			replace: current ? null : await replaceChoice(db, id, pick, feeds, k, defaults.product),
			canApply: role === 'owner'
		});
	});

/** POST …/feeds/<source>/from-boundary: apply it. */
const applyProposal = (k: BoundarySource) => async (c: Context<AuthEnv>) => {
	const body = ApplyBody.parse(await readJson(c));
	if (!k.products && body.product !== undefined) throw new ApiError(400, 'only a CHIRPS feed has a daily product');
	const id = c.req.param('id')!;
	const out = await withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'owner');
		const b = await loadBoundary(db, id);
		if (b.id !== body.featureId || b.updated_at.getTime() !== new Date(body.updatedAt).getTime()) {
			throw new ApiError(409, 'the catchment boundary changed since this proposal: look at the new proposal before applying it', { code: 'boundary_changed' });
		}
		const r = cellsOf(b, k);
		const from = { featureId: b.id, name: b.name };
		const pick = await runSeries(db, id, k.targetKind);
		const defaults = boundaryDefaults(pick, k);
		const withProduct = (product: ChirpsDailyProduct | undefined) => (product !== undefined ? { product } : {});
		if (body.replace) {
			const feeds = (await listFeeds(db, id)).filter((f) => f.source === k.source);
			const choice = await replaceChoice(db, id, pick, feeds, k, defaults.product, body.product);
			if (!choice) throw new ApiError(409, `no ${k.short} series holds a record yet, so there is nothing to replace: attach the boundary’s feed instead`, { code: 'nothing_to_replace' });
			if (!choice.available) throw new ApiError(409, choice.reason.charAt(0).toUpperCase() + choice.reason.slice(1), { code: 'series_replace' });
			const product = choice.product;
			if (choice.feedId) return replaceThroughFeed(db, id, feeds.find((f) => f.id === choice.feedId)!, b, r.cells, product, body.startDate);
			await attachSlot(db, id);
			const input = FeedInput.parse({
				source: k.source,
				config: { cells: configCells(r.cells), boundary: mark(b), ...withProduct(product), ...(body.startDate !== undefined ? { startDate: body.startDate } : {}) },
				targetKind: k.targetKind,
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
			if (cur.source !== k.source) throw new ApiError(409, `only ${k.source === 'chirps' ? 'a CHIRPS daily rainfall feed' : 'an AgERA5 reference evapotranspiration feed'} takes these cells of the boundary`);
			await holdFeed(db, id, cur.id);
			if ((await targetSeries(db, id, cur.targetKind, cur.targetName))?.filled) {
				throw new ApiError(
					409,
					'the feed’s series already holds days averaged over its old cells, and a feed never splices two areas into one record: attach a new feed for the boundary instead, into a separate series, or replace the record runs read (replace)',
					{ code: 'series_area' }
				);
			}
			const old = cur.config as GridConfig;
			// The product and first day asked for, else the feed's own, else the defaults (the record's first day).
			const { product, startDate } = boundaryReads(defaults, old, body, k);
			const input = FeedInput.parse({
				source: k.source,
				config: {
					cells: configCells(r.cells),
					boundary: mark(b),
					...withProduct(product),
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
		const targetName = body.targetName ?? (await freeName(db, id, (await listFeeds(db, id)).filter((f) => f.source === k.source), pick, k));
		if ((await targetSeries(db, id, k.targetKind, targetName))?.filled) {
			throw new ApiError(
				409,
				`that series already holds a record; the boundary’s ${k.reads} goes into a series of its own, so the two can be compared rather than spliced`,
				{ code: 'series_area' }
			);
		}
		const { product, startDate } = boundaryReads(defaults, null, body, k);
		const input = FeedInput.parse({
			source: k.source,
			config: { cells: configCells(r.cells), boundary: mark(b), ...withProduct(product), ...(startDate !== null ? { startDate } : {}) },
			targetKind: k.targetKind,
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
};

export const feedFromBoundaryRoutes = new Hono<AuthEnv>()
	.get('/:id/feeds/chirps/from-boundary', proposal(CHIRPS_BOUNDARY))
	.post('/:id/feeds/chirps/from-boundary', applyProposal(CHIRPS_BOUNDARY))
	.get('/:id/feeds/agera5_et0/from-boundary', proposal(ET0_BOUNDARY))
	.post('/:id/feeds/agera5_et0/from-boundary', applyProposal(ET0_BOUNDARY));
