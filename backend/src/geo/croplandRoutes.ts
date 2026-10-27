// Planted areas proposed from land cover (issue #326 Part B, "B-landcover";
// 173_cropland_reference.sql, 174_crop_area_land_cover.sql; docs/api.md
// § Catchment map, docs/maps.md § Cultivated area from land cover).
//
//   GET  /projects/:id/nodes/:nodeId/cropland-proposals           a unit's parcels' cultivated area, the catchment's, their orchards and vines, and its crops (viewer)
//   POST /projects/:id/nodes/:nodeId/crop-area-from-land-cover    accept a cultivated area, or an orchard or vine area (`layer`), as one crop's planted area (editor)
//
// Orchards and vines (issue #604 R5-D, 255_crop_type_reference.sql) come from
// a crop-type grid (SANLC) beside the land cover, with the part of each new
// since the earlier edition (for a licence applicant; never a value to use).
// SANLC's terms are not yet recorded, so production holds no crop-type
// dataset (referenceLoad.ts refuses the load) and `cropTypes` is null there.
//
// The map proposes, the modeller decides: the land cover says where land is
// cultivated, not what grows there (#90 Q9) or whether it is irrigated, so
// the modeller picks the crop. Each accept is one value, recorded as a model
// revision whose reason names the dataset, its version and the method (what
// an evidence pack prints), and as a crop_area_land_cover row. The server
// re-derives the value; the client only names the crop, the dataset and,
// for one parcel, the feature.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { beginModelChange, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { citeDataset, croplandDatasets, cultivatedAreas, type CroplandDataset, type CultivatedResult } from './cropland.js';
import { cropTypeAreas, cropTypeDatasets, layerM2, type CropTypeArea, type CropTypeResult } from './cropTypes.js';
import { LAYER_WORDS } from './cropTypeGrid.js';
import type { Geometry } from './geojson.js';

export const CropAreaFromLandCover = z
	.object({
		cropId: z.string().uuid(),
		dataset: z.string().trim().min(1).max(50),
		/** One parcel's cultivated area; absent = every parcel linked to the unit, summed. */
		featureId: z.string().uuid().optional(),
		/** Orchards or vines from the crop-type grid (then `dataset` names a crop-type dataset); absent = the land cover's cropland. */
		layer: z.enum(['orchard', 'vine']).optional()
	})
	.strict();

/** The proposals' one query parameter: a dataset label (absent = the default). */
export const ProposalsQuery = z.object({ dataset: z.string().trim().min(1).max(50).optional() });

interface UnitNode {
	name: string;
}

/** The project's node, a hydrological unit (the only kind with crops): 404 when it isn't there, 400 when it's another kind. */
async function unitNode(db: Db, projectId: string, nodeId: string): Promise<UnitNode> {
	if (!UUID.test(nodeId)) throw notFound();
	const { rows } = await db.query<{ name: string; kind: string }>('SELECT name, kind::text AS kind FROM node WHERE id = $1 AND project_id = $2', [nodeId, projectId]);
	const n = rows[0];
	if (!n) throw notFound();
	if (n.kind !== 'farm') throw new ApiError(400, 'Only a hydrological unit with land (not a gauge or other water user) has planted areas to propose.');
	return n;
}

interface Polygon {
	id: string;
	name: string;
	geometry: Geometry;
}

/** The farm parcels on the map linked to the unit, oldest first. */
async function unitParcels(db: Db, projectId: string, nodeId: string): Promise<Polygon[]> {
	const { rows } = await db.query<Polygon>(
		`SELECT id, name, geometry FROM map_feature
		 WHERE project_id = $1 AND node_id = $2 AND kind = 'farm_parcel'
		 ORDER BY created_at, id`,
		[projectId, nodeId]
	);
	return rows;
}

/** The catchment boundary, if drawn. */
async function boundaryOf(db: Db, projectId: string): Promise<Polygon | null> {
	const { rows } = await db.query<Polygon>(
		`SELECT id, name, geometry FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at, id LIMIT 1`,
		[projectId]
	);
	return rows[0] ?? null;
}

/** The dataset asked for, or the default (a real one before the synthetic grid); null with none loaded. */
async function pickDataset(db: Db, wanted: string | undefined): Promise<{ dataset: CroplandDataset | null; datasets: CroplandDataset[] }> {
	const datasets = await croplandDatasets(db);
	if (wanted === undefined) return { dataset: datasets[0] ?? null, datasets };
	const hit = datasets.find((d) => d.dataset === wanted);
	if (!hit) throw new ApiError(400, `No land-cover dataset “${wanted}” is loaded.`);
	return { dataset: hit, datasets };
}

const round = (x: number) => Math.round(x);
const ha = (m2: number) => `${(m2 / 10_000).toFixed(2)} ha`;
const typeSummary = (r: CropTypeResult) =>
	'problem' in r
		? { problem: r.problem }
		: { areaM2: round(r.areaM2), orchardM2: round(r.orchardM2), vineM2: round(r.vineM2), newOrchardM2: round(r.newOrchardM2), newVineM2: round(r.newVineM2) };
const summary = (r: CultivatedResult) => ('problem' in r ? { problem: r.problem } : { areaM2: round(r.areaM2), cultivatedM2: round(r.cultivatedM2) });

export const croplandRoutes = new Hono<AuthEnv>()
	.get('/:id/nodes/:nodeId/cropland-proposals', async (c) => {
		const { id, nodeId } = c.req.param();
		const { dataset: wanted } = ProposalsQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const n = await unitNode(db, id, nodeId);
			const { dataset, datasets } = await pickDataset(db, wanted);
			const parcels = await unitParcels(db, id, nodeId);
			const boundary = await boundaryOf(db, id);
			const polygons = [...parcels.map((p) => p.geometry), ...(boundary ? [boundary.geometry] : [])];
			const sums = dataset ? await cultivatedAreas(db, dataset, polygons) : [];
			// The crop-type grid's default dataset, over the parcels only (the catchment's orchards are no unit's to use).
			const typeSet = (await cropTypeDatasets(db))[0] ?? null;
			const typeSums = typeSet ? await cropTypeAreas(db, typeSet, parcels.map((p) => p.geometry)) : [];
			// The unit's sums add the parcels' rounded figures, so the table's total is its rows' sum (as the land cover's).
			const typeParcels = typeSet ? parcels.map((p, i) => ({ featureId: p.id, name: p.name, ...typeSummary(typeSums[i]!) })) : [];
			const typeOk = typeParcels.filter((r): r is typeof r & CropTypeArea => !('problem' in r));
			const total = (k: keyof CropTypeArea) => typeOk.reduce((s, r) => s + r[k], 0);
			const cropTypes = typeSet
				? {
						dataset: typeSet,
						parcels: typeParcels,
						unit:
							parcels.length && typeOk.length === parcels.length
								? { areaM2: total('areaM2'), orchardM2: total('orchardM2'), vineM2: total('vineM2'), newOrchardM2: total('newOrchardM2'), newVineM2: total('newVineM2') }
								: null
					}
				: null;
			const parcelSums = parcels.map((p, i) => ({ featureId: p.id, name: p.name, ...(dataset ? summary(sums[i]!) : {}) }));
			const ok = parcelSums.filter((p): p is typeof p & { areaM2: number; cultivatedM2: number } => 'cultivatedM2' in p);
			const unit =
				dataset && parcels.length && ok.length === parcels.length
					? { areaM2: ok.reduce((s, p) => s + p.areaM2, 0), cultivatedM2: ok.reduce((s, p) => s + p.cultivatedM2, 0) }
					: null;
			const { rows: crops } = await db.query<{
				crop_id: string;
				name: string;
				area_m2: number | null;
				accepted_m2: number | null;
				dataset: string | null;
				source: string | null;
				version: string | null;
				method: string | null;
				basis: 'unit' | 'parcel' | null;
				layer: 'orchard' | 'vine' | null;
				feature_name: string | null;
				accepted_at: Date | null;
			}>(
				`SELECT c.id AS crop_id, c.name, ca.area_m2, p.area_m2 AS accepted_m2, p.dataset, p.source, p.version, p.method, p.basis, p.layer, p.feature_name, p.accepted_at
				 FROM crop c
				 LEFT JOIN crop_area ca ON ca.crop_id = c.id AND ca.node_id = $2
				 LEFT JOIN crop_area_land_cover p ON p.crop_id = c.id AND p.node_id = $2
				 WHERE c.project_id = $1
				 ORDER BY c.name, c.id`,
				[id, nodeId]
			);
			return c.json({
				nodeId,
				nodeName: n.name,
				dataset,
				datasets: datasets.map((d) => ({ dataset: d.dataset, version: d.version, synthetic: d.synthetic })),
				parcels: parcelSums,
				unit,
				catchment: boundary && dataset ? { featureId: boundary.id, name: boundary.name, ...summary(sums[parcels.length]!) } : null,
				cropTypes,
				crops: crops.map((r) => ({
					cropId: r.crop_id,
					name: r.name,
					areaM2: r.area_m2 ?? 0,
					accepted:
						r.accepted_m2 === null
							? null
							: {
									areaM2: r.accepted_m2,
									dataset: r.dataset!,
									source: r.source!,
									version: r.version!,
									method: r.method!,
									basis: r.basis!,
									layer: r.layer,
									featureName: r.feature_name,
									acceptedAt: r.accepted_at!.toISOString(),
									// Still what the model holds (crop_area is rewritten on every save, so the link is by value).
									current: r.area_m2 !== null && Math.abs(r.area_m2 - r.accepted_m2) < 0.5
								}
				}))
			});
		});
	})
	.post('/:id/nodes/:nodeId/crop-area-from-land-cover', async (c) => {
		const body = CropAreaFromLandCover.parse(await readJson(c));
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const n = await unitNode(db, id, nodeId);
			const { rows: cropRows } = await db.query<{ name: string }>('SELECT name FROM crop WHERE id = $1 AND project_id = $2', [body.cropId, id]);
			const crop = cropRows[0];
			if (!crop) throw notFound();
			// The dataset first, as before the parcels: an unknown label is a 400 whatever is drawn.
			const typeSet = body.layer ? ((await cropTypeDatasets(db)).find((d) => d.dataset === body.dataset) ?? null) : null;
			if (body.layer && !typeSet) throw new ApiError(400, `No crop-type dataset “${body.dataset}” is loaded.`);
			const dataset = body.layer ? null : (await pickDataset(db, body.dataset)).dataset;
			const all = await unitParcels(db, id, nodeId);
			let parcels = all;
			if (body.featureId) {
				parcels = all.filter((p) => p.id === body.featureId);
				if (!parcels.length) {
					const { rows } = await db.query('SELECT 1 FROM map_feature WHERE id = $1 AND project_id = $2', [body.featureId, id]);
					if (!rows.length) throw notFound();
					throw new ApiError(400, `That feature isn’t a farm parcel linked to ${n.name}; link it on the Map first.`);
				}
			}
			if (!parcels.length) throw new ApiError(400, `No farm parcel on the map is linked to ${n.name}: draw or import its parcel on the Map and link it first.`);
			const what = body.featureId ? `the parcel “${parcels[0]!.name || 'unnamed'}”` : parcels.length === 1 ? `its parcel “${parcels[0]!.name || 'unnamed'}”` : `its ${parcels.length} parcels`;
			// Re-derived here from the dataset and the parcels as they are now; the cited dataset is the land cover's, or the crop-type grid's for a layer.
			let areaM2: number;
			let cited: { dataset: string; source: string; version: string; method: string };
			let reason: string;
			if (body.layer && typeSet) {
				const sums = await cropTypeAreas(db, typeSet, parcels.map((p) => p.geometry));
				const bad = sums.find((s): s is { problem: string } => 'problem' in s);
				if (bad) throw new ApiError(400, `The crop types can’t be summarised over ${n.name}’s parcels: ${bad.problem}.`);
				// Each parcel's figure rounded before the sum, as the proposals add them, so the value used is the one shown.
				areaM2 = sums.reduce((s, r) => s + round(layerM2(r as CropTypeArea, body.layer!)), 0);
				const words = LAYER_WORDS[body.layer];
				if (!(areaM2 > 0)) throw new ApiError(400, `${citeDataset(typeSet)} maps no ${words} in ${what}, so there is no area to use.`);
				const classes = body.layer === 'orchard' ? typeSet.orchardClasses : typeSet.vineClasses;
				cited = { ...typeSet, method: `${words[0]!.toUpperCase()}${words.slice(1)} (class ${classes.join(', ')}). ${typeSet.method}`.slice(0, 1000) };
				reason = `Planted area of ${crop.name} on ${n.name} from crop types: ${ha(areaM2)} of ${words} in ${what}; ${citeDataset(typeSet)}. ${cited.method}`;
			} else {
				const sums = await cultivatedAreas(db, dataset!, parcels.map((p) => p.geometry));
				const bad = sums.find((s): s is { problem: string } => 'problem' in s);
				if (bad) throw new ApiError(400, `The land cover can’t be summarised over ${n.name}’s parcels: ${bad.problem}.`);
				// Each parcel rounded before the sum, as the proposals add them, so the value used is the unit total shown.
				areaM2 = sums.reduce((s, r) => s + round((r as { cultivatedM2: number }).cultivatedM2), 0);
				if (!(areaM2 > 0)) throw new ApiError(400, `${citeDataset(dataset!)} maps no cropland in ${what}, so there is no area to use.`);
				cited = dataset!;
				reason = `Planted area of ${crop.name} on ${n.name} from land cover: ${ha(areaM2)} cultivated in ${what}; ${citeDataset(dataset!)}. ${dataset!.method}`;
			}
			const change = await beginModelChange(db, id);
			await db.query(
				`INSERT INTO crop_area (project_id, node_id, crop_id, area_m2) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (node_id, crop_id) DO UPDATE SET area_m2 = EXCLUDED.area_m2`,
				[id, nodeId, body.cropId, areaM2]
			);
			await db.query(
				`INSERT INTO crop_area_land_cover (project_id, node_id, crop_id, area_m2, dataset, source, version, method, basis, feature_name, layer)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				 ON CONFLICT (node_id, crop_id) DO UPDATE SET area_m2 = EXCLUDED.area_m2, dataset = EXCLUDED.dataset, source = EXCLUDED.source,
					version = EXCLUDED.version, method = EXCLUDED.method, basis = EXCLUDED.basis, feature_name = EXCLUDED.feature_name, layer = EXCLUDED.layer, accepted_at = now()`,
				[
					id,
					nodeId,
					body.cropId,
					areaM2,
					cited.dataset,
					cited.source,
					cited.version,
					cited.method,
					body.featureId ? 'parcel' : 'unit',
					body.featureId ? (parcels[0]!.name || 'unnamed').slice(0, 100) : null,
					body.layer ?? null
				]
			);
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: reason.slice(0, 500)
			});
			return c.json({ nodeId, cropId: body.cropId, areaM2, dataset: cited.dataset, ...(body.layer ? { layer: body.layer } : {}), revisionId: revision?.id ?? null });
		});
	});
