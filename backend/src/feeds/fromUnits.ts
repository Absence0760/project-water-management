// Rain for each hydrological unit in one action (issue #482 part B; docs/api.md
// § Data feeds, docs/maps.md § Rain for each unit).
//
//   GET  /projects/:id/feeds/chirps/from-units   (editor) the proposal: for
//        each land unit (a farm node with an area) with a polygon on the map,
//        the CHIRPS cells it covers, area-weighted (boundaryCells.ts), and
//        whether it already has its feed; the units with no polygon; the units
//        whose feed can't be set up, and why.
//   POST /projects/:id/feeds/chirps/from-units   (owner, as every feed change:
//        data_feed's RLS, 018) create or update one CHIRPS feed per unit, each
//        writing the unit's own rain (`rain_chirps_mm`, the series sited at the
//        unit, 209_unit_rain_series), recorded as one History entry.
//
// A unit's polygon is its farm parcel on the map (map_feature.node_id): the
// one its area was accepted from (node.area_feature_id, which the delineation
// sets for every unit it saves), else its only parcel. A unit with several
// parcels and none accepted is refused, since which one is its catchment is
// the modeller's call (Use this area on the Map tab).
//
// As with the boundary's feed, a feed never splices two areas or two products
// into one record: an existing unit feed takes new cells (or another product)
// only while its series holds nothing yet. A unit whose polygon changed after
// its feed has fetched is refused, saying so; its feed is left as it is.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import type { Geometry } from '../geo/geojson.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from '../history/record.js';
import { requireRole } from '../projects/access.js';
import { assertRoomForSeries } from '../series/merge.js';
import { SeriesStartDate } from '../series/limits.js';
import { boundaryCells, type BoundaryCell } from './boundaryCells.js';
import { CHIRPS_DAILY_PRODUCTS, CHIRPS_PRODUCT_FIRST_DAY, chirpsProduct, type ChirpsDailyProduct, FeedInput, type GridConfig, type UnitMark } from './config.js';
import { conflict, MAX_FEEDS } from './routes.js';
import { createFeed, listFeeds, updateFeed, type FeedMeta } from './store.js';

/** The series a unit's feed writes: its own CHIRPS (the reference rainfall), sited at the unit. */
export const UNIT_TARGET_KIND = 'rain_chirps_mm';
/** The product a unit's feed reads unless told otherwise: `rnl`, from 1981 (a hydrologist's question in #482, provisional). */
export const DEFAULT_UNIT_PRODUCT: ChirpsDailyProduct = 'rnl';
/** The most units one request takes (the model holds at most 500 nodes; a project at most MAX_FEEDS feeds). */
const MAX_UNITS = 500;

/**
 * A unit feed's series name: `CHIRPS v3 (<product>) <unit>`. The unit's name
 * is part of it because a project's series are unique by kind and name, and
 * every unit has its own; the series is found by its site, not its name, so
 * renaming the unit later changes nothing.
 */
export const unitSeriesName = (product: ChirpsDailyProduct, unitName: string) => `CHIRPS v3 (${product}) ${unitName}`.slice(0, 100).trim();

/** A unit's cell as the GET shows it (the feed config keeps the weight only). */
export type UnitCell = Pick<BoundaryCell, 'lat' | 'lon' | 'share' | 'weight'>;

interface Parcel {
	id: string;
	geometry: Geometry;
	updatedAt: string;
	areaM2: number;
}

interface UnitRow {
	nodeId: string;
	name: string;
	areaFeatureId: string | null;
	parcels: Parcel[] | null;
}

/** A unit's own CHIRPS series (rain_chirps_mm sited at it), the first by name, as a run reads it. */
interface UnitSeries {
	id: string;
	name: string;
	days: number;
}

/** What POST would do for a unit. */
type UnitAction = 'create' | 'update' | 'none';

export interface UnitProposal {
	nodeId: string;
	name: string;
	featureId: string;
	areaKm2: number;
	cells: UnitCell[];
	feedId: string | null;
	seriesDays: number;
	/** create: no feed yet; update: its feed takes these cells or this product (its series is empty); none: it already reads them. */
	action: UnitAction;
}

export interface UnitsProposal {
	product: ChirpsDailyProduct;
	units: UnitProposal[];
	withoutPolygon: { nodeId: string; name: string }[];
	refused: { nodeId: string; name: string; reason: string }[];
}

interface Plan extends UnitsProposal {
	/** Per proposed unit: its feed (when it has one), its series, the mark and the config cells. */
	detail: Map<string, { feed: FeedMeta | null; series: UnitSeries | null; mark: UnitMark; targetName: string }>;
}

async function loadUnits(db: Db, projectId: string): Promise<UnitRow[]> {
	const { rows } = await db.query<UnitRow>(
		`SELECT n.id AS "nodeId", n.name, n.area_feature_id AS "areaFeatureId",
			(SELECT json_agg(json_build_object('id', f.id, 'geometry', f.geometry, 'areaM2', f.area_m2,
				'updatedAt', to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY f.created_at, f.id)
			 FROM map_feature f WHERE f.project_id = n.project_id AND f.node_id = n.id AND f.kind = 'farm_parcel') AS parcels
		 FROM node n WHERE n.project_id = $1 AND n.kind = 'farm' AND n.area_km2 > 0
		 ORDER BY n.sort_order, n.name`,
		[projectId]
	);
	return rows;
}

/** The unit's polygon: the parcel its area came from, else its only parcel; 'several' when it has more and none was accepted. */
function unitParcel(u: UnitRow): Parcel | 'several' | null {
	const parcels = u.parcels ?? [];
	const accepted = parcels.find((p) => p.id === u.areaFeatureId);
	if (accepted) return accepted;
	if (parcels.length === 1) return parcels[0]!;
	return parcels.length ? 'several' : null;
}

/** The unit feeds (a CHIRPS feed with a unit mark), by unit. */
function unitFeeds(feeds: readonly FeedMeta[]): Map<string, FeedMeta> {
	const out = new Map<string, FeedMeta>();
	for (const f of feeds) {
		const unit = f.source === 'chirps' ? (f.config as GridConfig).unit : undefined;
		if (unit && !out.has(unit.nodeId)) out.set(unit.nodeId, f);
	}
	return out;
}

/** Each unit's own CHIRPS series (sited at it), the first by name, and how many days it holds. */
async function unitSeries(db: Db, projectId: string, nodeIds: string[]): Promise<Map<string, UnitSeries>> {
	const { rows } = await db.query<UnitSeries & { nodeId: string }>(
		`SELECT DISTINCT ON (site_node_id) site_node_id AS "nodeId", id, name, cardinality(array_remove("values", NULL)) AS days
		 FROM time_series WHERE project_id = $1 AND kind = $2 AND site_node_id = ANY($3::uuid[])
		 ORDER BY site_node_id, name`,
		[projectId, UNIT_TARGET_KIND, nodeIds]
	);
	return new Map(rows.map(({ nodeId, ...s }) => [nodeId, s]));
}

/** A series of the kind and name, whoever's it is (the name is unique per kind). */
async function seriesNamed(db: Db, projectId: string, name: string) {
	const { rows } = await db.query<{ id: string; siteNodeId: string | null; days: number }>(
		`SELECT id, site_node_id AS "siteNodeId", cardinality(array_remove("values", NULL)) AS days FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3`,
		[projectId, UNIT_TARGET_KIND, name]
	);
	return rows[0] ?? null;
}

const sameCells = (a: readonly { lat: number; lon: number; weight: number }[], b: readonly { lat: number; lon: number; weight: number }[]) =>
	a.length === b.length && a.every((c, i) => c.lat === b[i]!.lat && c.lon === b[i]!.lon && c.weight === b[i]!.weight);

/** The product the proposal uses: the one asked for, else the one every existing unit feed reads, else DEFAULT_UNIT_PRODUCT. */
function proposalProduct(asked: ChirpsDailyProduct | undefined, feeds: Map<string, FeedMeta>): ChirpsDailyProduct {
	if (asked) return asked;
	const products = new Set([...feeds.values()].map((f) => chirpsProduct(f.config)));
	return products.size === 1 ? [...products][0]! : DEFAULT_UNIT_PRODUCT;
}

/** Work out, for every land unit, what POST would do with `product`. Read-only. */
async function plan(db: Db, projectId: string, asked?: ChirpsDailyProduct): Promise<Plan> {
	const units = await loadUnits(db, projectId);
	const feeds = unitFeeds(await listFeeds(db, projectId));
	const product = proposalProduct(asked, feeds);
	const series = await unitSeries(db, projectId, units.map((u) => u.nodeId));
	const out: Plan = { product, units: [], withoutPolygon: [], refused: [], detail: new Map() };
	const takenNames = new Set<string>();
	for (const u of units) {
		const parcel = unitParcel(u);
		if (parcel === null) {
			out.withoutPolygon.push({ nodeId: u.nodeId, name: u.name });
			continue;
		}
		const refuse = (reason: string) => out.refused.push({ nodeId: u.nodeId, name: u.name, reason });
		if (parcel === 'several') {
			refuse('the unit has several parcels on the map and none is its area: use one parcel’s area for the unit on the Map tab first');
			continue;
		}
		const r = boundaryCells(parcel.geometry, 'the unit’s parcel');
		if ('problem' in r) {
			refuse(r.problem);
			continue;
		}
		const cells = r.cells.map(({ lat, lon, share, weight }) => ({ lat, lon, share, weight }));
		const mark: UnitMark = { nodeId: u.nodeId, featureId: parcel.id, updatedAt: parcel.updatedAt, areaKm2: Math.round(parcel.areaM2 / 1e3) / 1e3 };
		const feed = feeds.get(u.nodeId) ?? null;
		const own = series.get(u.nodeId) ?? null;
		let action: UnitAction = 'create';
		let targetName = unitSeriesName(product, u.name);
		if (feed) {
			const config = feed.config as GridConfig;
			// Reads them already: the same product over the same cells and weights. A parcel redrawn (or swapped) to the
			// same cells changes nothing the feed averages, so it needs nothing either, its series holding days or not.
			const reads = chirpsProduct(feed.config) === product && sameCells(config.cells ?? [], cells);
			// The feed's series holds a record (it has fetched): new cells or another product would splice it.
			const filled = feed.series?.filled ?? false;
			if (reads) action = 'none';
			else if (filled) {
				refuse(
					chirpsProduct(feed.config) !== product
						? `its feed’s series already holds CHIRPS ${chirpsProduct(feed.config)} days, and a feed never splices two products into one record: change the product of its feed on its own (Settings → Data feeds) to replace the record`
						: 'its parcel changed after its feed began fetching, and a feed never splices two areas into one record: remove the unit’s feed, and its series, to start it again with the new cells'
				);
				continue;
			} else action = 'update';
			// A product change renames the (empty) series to say what it will hold.
			targetName = action === 'update' && chirpsProduct(feed.config) !== product ? targetName : feed.targetName;
		} else if (own && own.days > 0) {
			refuse(`the unit already has a CHIRPS series of its own (“${own.name}”) that no feed writes: remove it, or give it back to the catchment, before attaching a feed`);
			continue;
		} else if (own) {
			// An empty series of the unit's own: the feed writes that one, so the unit never has two (a run reads the first by name).
			targetName = own.name;
		}
		if (action !== 'none' && (!feed || targetName !== feed.targetName)) {
			const named = await seriesNamed(db, projectId, targetName);
			if (takenNames.has(targetName) || (named && (named.days > 0 || (named.siteNodeId !== null && named.siteNodeId !== u.nodeId)))) {
				refuse(`a series named “${targetName}” already holds another record: rename the unit, or that series, first`);
				continue;
			}
		}
		takenNames.add(targetName);
		out.units.push({ nodeId: u.nodeId, name: u.name, featureId: parcel.id, areaKm2: mark.areaKm2, cells, feedId: feed?.id ?? null, seriesDays: own?.days ?? 0, action });
		out.detail.set(u.nodeId, { feed, series: own, mark, targetName });
	}
	return out;
}

const publicProposal = ({ detail: _detail, ...p }: Plan): UnitsProposal => p;

const ProductQuery = z.enum(CHIRPS_DAILY_PRODUCTS).optional();

const ApplyBody = z
	.object({
		/** The CHIRPS v3 daily product every unit's feed reads; absent: the one the units' feeds already read, else `rnl` (from 1981). */
		product: z.enum(CHIRPS_DAILY_PRODUCTS).optional(),
		/** The first day to fetch; absent: the product's first day. */
		startDate: SeriesStartDate.optional(),
		/** Only these units; absent: every unit the proposal lists. A unit the proposal refuses or that has no polygon is a 409. */
		nodeIds: z.array(z.uuid()).min(1).max(MAX_UNITS).optional()
	})
	.strict();

export const feedFromUnitsRoutes = new Hono<AuthEnv>()
	.get('/:id/feeds/chirps/from-units', async (c) => {
		const product = ProductQuery.parse(c.req.query('product'));
		return withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			const role = await requireRole(db, id, 'editor');
			return c.json({ ...publicProposal(await plan(db, id, product)), canApply: role === 'owner' });
		});
	})
	.post('/:id/feeds/chirps/from-units', async (c) => {
		const body = ApplyBody.parse(await readJson(c));
		const id = c.req.param('id');
		const out = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			// One request at a time per project, counted against the feed cap as one (attachSlot's lock).
			await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('data_feed_cap:' || $1::text, 0))`, [id]);
			// The product as the proposal chose it: the one asked for, else the units' feeds' own, else rnl.
			const p = await plan(db, id, body.product);
			const product = p.product;
			const startDate = body.startDate ?? CHIRPS_PRODUCT_FIRST_DAY[product];
			if (startDate < CHIRPS_PRODUCT_FIRST_DAY[product]) {
				throw new ApiError(400, `CHIRPS v3’s ${product} daily product begins on ${CHIRPS_PRODUCT_FIRST_DAY[product]}; for earlier days use the rnl product`, { code: 'start_date' });
			}
			const listed = new Set(p.units.map((u) => u.nodeId));
			if (body.nodeIds) {
				const named = new Set(body.nodeIds);
				const blocked = [...p.refused.map((r) => ({ ...r })), ...p.withoutPolygon.map((u) => ({ ...u, reason: 'the unit has no polygon on the map' }))].filter((u) => named.has(u.nodeId));
				if (blocked.length) {
					throw new ApiError(409, `${blocked.map((u) => `“${u.name}”: ${u.reason}`).join('; ')}`, { code: 'unit_refused', units: blocked });
				}
				const unknown = body.nodeIds.filter((n) => !listed.has(n));
				if (unknown.length) throw new ApiError(400, 'nodeIds: not a land unit of this project', { code: 'unit_unknown' });
			}
			const chosen = p.units.filter((u) => !body.nodeIds || body.nodeIds.includes(u.nodeId));
			const creating = chosen.filter((u) => u.action === 'create').length;
			const { rows: count } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM data_feed WHERE project_id = $1', [id]);
			if (count[0]!.n + creating > MAX_FEEDS) {
				throw new ApiError(409, `a project can have at most ${MAX_FEEDS} feeds; it has ${count[0]!.n}, and this would add ${creating}: choose fewer units (nodeIds), or remove feeds it no longer needs`, {
					code: 'feed_limit'
				});
			}
			const feeds: { nodeId: string; feedId: string }[] = [];
			const changed: { nodeId: string; name: string; feedId: string; action: 'created' | 'updated'; cells: number }[] = [];
			for (const u of chosen) {
				const d = p.detail.get(u.nodeId)!;
				if (u.action === 'none') {
					feeds.push({ nodeId: u.nodeId, feedId: d.feed!.id });
					continue;
				}
				const config = { cells: u.cells.map(({ lat, lon, weight }) => ({ lat, lon, weight })), unit: d.mark, product, startDate };
				if (u.action === 'update') {
					const cur = d.feed!;
					// As the boundary's Apply: hold the feed's row, and refuse while a fetch is out, whose answer was asked for
					// with the old cells (fetch_job_id, 029; app_take_feed_fetch waits on this lock).
					// And refuse a feed saved since the proposal was worked out (a PATCH takes no lock of ours): its settings
					// would otherwise be overwritten with the ones read before.
					const { rows: held } = await db.query<{ fetching: boolean; updatedAt: Date }>(
						'SELECT fetch_job_id IS NOT NULL AS fetching, updated_at AS "updatedAt" FROM data_feed WHERE id = $1 AND project_id = $2 FOR UPDATE',
						[cur.id, id]
					);
					if (held[0]?.fetching) {
						throw new ApiError(409, `a fetch for the feed of “${u.name}” is still out: set up the units’ rain once it has come back`, { code: 'feed_fetching' });
					}
					if (!held[0] || new Date(held[0].updatedAt).getTime() !== new Date(cur.updatedAt).getTime()) {
						throw new ApiError(409, `the feed of “${u.name}” changed meanwhile: look at the new proposal and try again`, { code: 'feed_changed' });
					}
					const old = cur.config as GridConfig;
					if (d.targetName !== cur.targetName) await placeSeries(db, id, u.nodeId, d.targetName, startDate, d.series?.name === cur.targetName ? d.series.id : null);
					const input = FeedInput.parse({
						source: 'chirps',
						config: { ...config, ...(old.staleAfterDays !== undefined ? { staleAfterDays: old.staleAfterDays } : {}) },
						targetKind: UNIT_TARGET_KIND,
						targetName: d.targetName,
						schedule: cur.schedule,
						enabled: cur.enabled
					});
					if (!(await updateFeed(db, id, cur.id, input).catch(conflict))) throw new ApiError(404, 'not found');
					feeds.push({ nodeId: u.nodeId, feedId: cur.id });
					changed.push({ nodeId: u.nodeId, name: u.name, feedId: cur.id, action: 'updated', cells: u.cells.length });
					continue;
				}
				await placeSeries(db, id, u.nodeId, d.targetName, startDate, null);
				const input = FeedInput.parse({ source: 'chirps', config, targetKind: UNIT_TARGET_KIND, targetName: d.targetName });
				const fid = await createFeed(db, id, input).catch(conflict);
				feeds.push({ nodeId: u.nodeId, feedId: fid });
				changed.push({ nodeId: u.nodeId, name: u.name, feedId: fid, action: 'created', cells: u.cells.length });
			}
			const created = changed.filter((x) => x.action === 'created').length;
			const updated = changed.length - created;
			// One History entry for the whole action, naming each unit it set up.
			if (changed.length) await recordAudit(db, id, 'feed.configured', { action: 'units', source: 'chirps', targetKind: UNIT_TARGET_KIND, product, startDate, created, updated, units: changed });
			// The units left out (refused, or with no polygon) say why, so the caller sees what wasn't done.
			const skipped = body.nodeIds ? [] : [...p.refused, ...p.withoutPolygon.map((u) => ({ ...u, reason: 'the unit has no polygon on the map' }))];
			return { created, updated, feeds, skipped };
		});
		return c.json(out);
	});

/**
 * Give the unit an empty series of its own, named `name`, before its feed's
 * first fetch: the feed then merges into a series sited at the unit (209).
 * `renameFrom`: the unit's empty series to rename instead (a product change).
 * An empty series of that name that is no one's (or already the unit's) is
 * taken over; plan() refused the rest.
 */
async function placeSeries(db: Db, projectId: string, nodeId: string, name: string, startDate: string, renameFrom: string | null): Promise<void> {
	const named = await seriesNamed(db, projectId, name);
	if (named) {
		if (named.siteNodeId !== nodeId) await db.query('UPDATE time_series SET site_node_id = $3 WHERE project_id = $1 AND id = $2', [projectId, named.id, nodeId]);
		return;
	}
	if (renameFrom) {
		await db.query('UPDATE time_series SET name = $3 WHERE project_id = $1 AND id = $2', [projectId, renameFrom, name]);
		return;
	}
	await assertRoomForSeries(db, projectId);
	await db.query(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", site_node_id) VALUES ($1, $2, $3, 'mm', $4, '{}', $5)`,
		[projectId, UNIT_TARGET_KIND, name, startDate, nodeId]
	);
}
