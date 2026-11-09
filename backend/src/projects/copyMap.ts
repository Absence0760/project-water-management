// Copying a project's catchment map with it (POST /projects/:id/copy;
// docs/api.md § Projects, docs/data-model.md § Catchment map).
//
// A copy gets the original's GeoJSON sources and map features under new ids,
// each feature linked to the copy's node (the node id map freshIds made), and
// the copy's nodes keep where their area came from: a unit whose area was
// accepted from the map is still `area_source = 'map'`, linked to the copied
// feature, with the same basis. The records of what an accepted value was read
// over (273: node.map_polygon, crop_area_land_cover, evaporation_accepted)
// follow, their featureId rewritten to the copied feature's id.
//
// Left behind, as the original's history: delineation and Start proposals
// (175, 191; a copy starts from the result, not the proposal), dam waterbody
// matches and dam observations (261; the tick matches and reads a copied dam
// again, as it does a new one), observed ET (277; the copy's parcels mark their
// units to be read again on insert) and every data feed.
//
// All set-based and under the copier's RLS (withUser): they read what they may
// see of the original (viewer) and write into the copy they own. Who imported
// or drew a feature (geo_source.imported_by, map_feature.created_by) isn't
// carried over: the copy's members may not be the original's, and naming the
// copier would misattribute the work, as notes don't copy for the same reason.
// The original times stay.
import type { Db } from '../db/tx.js';

type IdMap = ReadonlyMap<string, string>;

/** A feature id in a stamp the copy has no feature for (deleted, or out of the copier's sight) becomes a random one: the stamp still says "another outline now" (geo/acceptances.ts outlineChanged), without naming the original's row. */
const restamp = (col: string) =>
	`jsonb_set(${col}, '{featureId}', to_jsonb(COALESCE((SELECT x.new_id FROM fm x WHERE x.old_id::text = ${col} ->> 'featureId'), gen_random_uuid())::text))`;

/** Copy the catchment map of `srcId` into `newId` (whose model is already saved with the ids `ids` maps old → new). Returns the feature id map, old → new. */
export async function copyCatchmentMap(db: Db, srcId: string, newId: string, ids: IdMap): Promise<Map<string, string>> {
	const [from, to] = [[...ids.keys()], [...ids.values()]];
	// The GeoJSON files. The CTE is read twice, so each row's new id is drawn once.
	const { rows: sources } = await db.query<{ old: string; new: string }>(
		`WITH s AS MATERIALIZED (SELECT id, gen_random_uuid() AS new_id, file_name, sha256, crs, imported_at FROM geo_source WHERE project_id = $1),
		 ins AS (INSERT INTO geo_source (id, project_id, file_name, sha256, crs, imported_by, imported_at)
			SELECT new_id, $2, file_name, sha256, crs, NULL, imported_at FROM s)
		 SELECT id AS old, new_id AS new FROM s`,
		[srcId, newId]
	);
	// The features, each linked to the copy's node and source (NULL where the copy has none). A linked gauge is inserted
	// where it stood when it was linked (link_point, 273) and then moved to where it stands now, so its trigger-owned
	// link_point records the original's and the Map's Checks still say how far it moved since (F9).
	const { rows: features } = await db.query<{ old: string; new: string }>(
		`WITH f AS MATERIALIZED (SELECT *, gen_random_uuid() AS new_id FROM map_feature WHERE project_id = $1),
		 ins AS (INSERT INTO map_feature (id, project_id, kind, name, node_id, geometry, properties, area_m2, non_contributing_m2, dam_position, source_id, created_by, created_at)
			SELECT f.new_id, $2, f.kind, f.name, n.new_id, COALESCE(f.link_point, f.geometry), f.properties, f.area_m2, f.non_contributing_m2, f.dam_position, g.new_id, NULL, f.created_at
			FROM f
			LEFT JOIN unnest($3::uuid[], $4::uuid[]) AS n(old_id, new_id) ON n.old_id = f.node_id
			LEFT JOIN unnest($5::uuid[], $6::uuid[]) AS g(old_id, new_id) ON g.old_id = f.source_id)
		 SELECT id AS old, new_id AS new FROM f`,
		[srcId, newId, from, to, sources.map((r) => r.old), sources.map((r) => r.new)]
	);
	const fm = [features.map((r) => r.old), features.map((r) => r.new)];
	await db.query(
		`UPDATE map_feature c SET geometry = o.geometry
		 FROM unnest($2::uuid[], $3::uuid[]) AS m(old_id, new_id) JOIN map_feature o ON o.id = m.old_id
		 WHERE c.id = m.new_id AND c.project_id = $1 AND o.link_point IS NOT NULL AND o.link_point IS DISTINCT FROM o.geometry`,
		[newId, ...fm]
	);
	const FM = `fm AS (SELECT * FROM unnest($3::uuid[], $4::uuid[]) AS fm(old_id, new_id))`;
	// Where each copied node's area and MAP came from. saveModel wrote every node as typed; the CHECK holds
	// area_source and area_basis together, and a link to a feature the copy lacks is NULL, as a deleted one's is.
	await db.query(
		`WITH ${FM}, nm AS (SELECT * FROM unnest($5::uuid[], $6::uuid[]) AS nm(old_id, new_id))
		 UPDATE node c SET area_source = o.area_source, area_basis = o.area_basis,
			area_feature_id = (SELECT x.new_id FROM fm x WHERE x.old_id = o.area_feature_id),
			map_polygon = CASE WHEN o.map_polygon IS NULL THEN NULL ELSE ${restamp('o.map_polygon')} END
		 FROM nm JOIN node o ON o.id = nm.old_id
		 WHERE c.id = nm.new_id AND c.project_id = $2 AND o.project_id = $1 AND (o.area_source <> 'typed' OR o.map_polygon IS NOT NULL)`,
		[srcId, newId, ...fm, from, to]
	);
	// A planted area accepted from land cover (174, polygons 273), for a unit and crop the copy has.
	await db.query(
		`WITH ${FM}, nm AS (SELECT * FROM unnest($5::uuid[], $6::uuid[]) AS nm(old_id, new_id))
		 INSERT INTO crop_area_land_cover (project_id, node_id, crop_id, area_m2, dataset, source, version, method, basis, feature_name, accepted_at, layer, polygons)
		 SELECT $2, n.new_id, k.new_id, p.area_m2, p.dataset, p.source, p.version, p.method, p.basis, p.feature_name, p.accepted_at, p.layer,
			CASE WHEN p.polygons IS NULL THEN NULL
				ELSE (SELECT jsonb_agg(${restamp('e.v')} ORDER BY e.i) FROM jsonb_array_elements(p.polygons) WITH ORDINALITY AS e(v, i)) END
		 FROM crop_area_land_cover p JOIN nm n ON n.old_id = p.node_id JOIN nm k ON k.old_id = p.crop_id
		 WHERE p.project_id = $1`,
		[srcId, newId, ...fm, from, to]
	);
	// Evaporation accepted from the map (181, boundary 273).
	await db.query(
		`WITH ${FM}
		 INSERT INTO evaporation_accepted (project_id, target, monthly_mm, dataset, kind, source, version, method, coverage, accepted_at, boundary)
		 SELECT $2, target, monthly_mm, dataset, kind, source, version, method, coverage, accepted_at,
			CASE WHEN boundary IS NULL THEN NULL ELSE ${restamp('boundary')} END
		 FROM evaporation_accepted WHERE project_id = $1`,
		[srcId, newId, ...fm]
	);
	return new Map(features.map((r) => [r.old, r.new]));
}
