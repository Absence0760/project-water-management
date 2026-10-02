// Planted areas proposed from land cover (issue #326 Part B, "B-landcover";
// 173_cropland_reference.sql, 174_crop_area_land_cover.sql; docs/api.md
// § Catchment map, docs/maps.md § Cultivated area from land cover).
//
//   GET  /projects/:id/nodes/:nodeId/cropland-proposals           a unit's parcels' cultivated area, the catchment's, and its crops (viewer)
//   POST /projects/:id/nodes/:nodeId/crop-area-from-land-cover    accept a cultivated area as one crop's planted area (editor)
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
import type { Geometry } from './geojson.js';

export const CropAreaFromLandCover = z
	.object({
		cropId: z.string().uuid(),
		dataset: z.string().trim().min(1).max(50),
		/** One parcel's cultivated area; absent = every parcel linked to the unit, summed. */
		featureId: z.string().uuid().optional()
	})
	.strict();

interface UnitNode {
	name: string;
}

/** The project's node, a hydrological unit (the only kind with crops): 404 when it isn't there, 400 when it's another kind. */
async function unitNode(db: Db, projectId: string, nodeId: string): Promise<UnitNode> {
	if (!UUID.test(nodeId)) throw notFound();
	const { rows } = await db.query<{ name: string; kind: string }>('SELECT name, kind::text AS kind FROM node WHERE id = $1 AND project_id = $2', [nodeId, projectId]);
	const n = rows[0];
	if (!n) throw notFound();
	if (n.kind !== 'farm') throw new ApiError(400, 'Only a hydrological unit (a farm node) has planted areas to propose.');
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
const summary = (r: CultivatedResult) => ('problem' in r ? { problem: r.problem } : { areaM2: round(r.areaM2), cultivatedM2: round(r.cultivatedM2) });

export const croplandRoutes = new Hono<AuthEnv>()
	.get('/:id/nodes/:nodeId/cropland-proposals', async (c) => {
		const { id, nodeId } = c.req.param();
		const wanted = c.req.query('dataset');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const n = await unitNode(db, id, nodeId);
			const { dataset, datasets } = await pickDataset(db, wanted);
			const parcels = await unitParcels(db, id, nodeId);
			const boundary = await boundaryOf(db, id);
			const polygons = [...parcels.map((p) => p.geometry), ...(boundary ? [boundary.geometry] : [])];
			const sums = dataset ? await cultivatedAreas(db, dataset, polygons) : [];
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
				feature_name: string | null;
				accepted_at: Date | null;
			}>(
				`SELECT c.id AS crop_id, c.name, ca.area_m2, p.area_m2 AS accepted_m2, p.dataset, p.source, p.version, p.method, p.basis, p.feature_name, p.accepted_at
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
			const { dataset } = await pickDataset(db, body.dataset);
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
			// Re-derived here from the dataset and the parcels as they are now.
			const sums = await cultivatedAreas(db, dataset!, parcels.map((p) => p.geometry));
			const bad = sums.find((s): s is { problem: string } => 'problem' in s);
			if (bad) throw new ApiError(400, `The land cover can’t be summarised over ${n.name}’s parcels: ${bad.problem}.`);
			const areaM2 = round(sums.reduce((s, r) => s + (r as { cultivatedM2: number }).cultivatedM2, 0));
			const what = body.featureId ? `the parcel “${parcels[0]!.name || 'unnamed'}”` : parcels.length === 1 ? `its parcel “${parcels[0]!.name || 'unnamed'}”` : `its ${parcels.length} parcels`;
			if (!(areaM2 > 0)) throw new ApiError(400, `${citeDataset(dataset!)} maps no cropland in ${what}, so there is no area to use.`);
			const change = await beginModelChange(db, id);
			await db.query(
				`INSERT INTO crop_area (project_id, node_id, crop_id, area_m2) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (node_id, crop_id) DO UPDATE SET area_m2 = EXCLUDED.area_m2`,
				[id, nodeId, body.cropId, areaM2]
			);
			await db.query(
				`INSERT INTO crop_area_land_cover (project_id, node_id, crop_id, area_m2, dataset, source, version, method, basis, feature_name)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				 ON CONFLICT (node_id, crop_id) DO UPDATE SET area_m2 = EXCLUDED.area_m2, dataset = EXCLUDED.dataset, source = EXCLUDED.source,
					version = EXCLUDED.version, method = EXCLUDED.method, basis = EXCLUDED.basis, feature_name = EXCLUDED.feature_name, accepted_at = now()`,
				[
					id,
					nodeId,
					body.cropId,
					areaM2,
					dataset!.dataset,
					dataset!.source,
					dataset!.version,
					dataset!.method,
					body.featureId ? 'parcel' : 'unit',
					body.featureId ? (parcels[0]!.name || 'unnamed').slice(0, 100) : null
				]
			);
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `Planted area of ${crop.name} on ${n.name} from land cover: ${ha(areaM2)} cultivated in ${what}; ${citeDataset(dataset!)}. ${dataset!.method}`.slice(0, 500)
			});
			return c.json({ nodeId, cropId: body.cropId, areaM2, dataset: dataset!.dataset, revisionId: revision?.id ?? null });
		});
	});
