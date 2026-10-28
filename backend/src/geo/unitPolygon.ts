// Which map features can be a hydrological unit's polygon (issue #646 F1;
// docs/maps.md § Rain for each unit, § MAP for each unit, § Cultivated area
// from land cover). One rule for every per-unit proposal and the reference
// cell, so they can't disagree about a unit's outline:
//
//   1. the area feature the unit's area was accepted from (node.area_feature_id,
//      which Start, Divide, Sub-catchments from clicks and Use this area set),
//      of either area kind (AREA_KINDS: a farm parcel or an *other* area), linked
//      to the unit or not, while it is a polygon;
//   2. else the unit's only linked farm parcel (map_feature.node_id).
//
// A unit with several linked parcels and no area feature has no single
// polygon (fromUnits.ts unitParcel says 'several'). Every query runs under the
// caller's RLS (withUser), as before.

/**
 * The SQL condition for `map_feature f` being a candidate polygon of `node n`:
 * its linked farm parcels and its area feature (rule 1 above). Callers pick
 * the area feature first (`f.id = n.area_feature_id`).
 */
export const UNIT_POLYGONS_SQL = `f.project_id = n.project_id
	AND ((f.node_id = n.id AND f.kind = 'farm_parcel') OR (f.id = n.area_feature_id AND f.kind IN ('farm_parcel', 'other') AND f.area_m2 IS NOT NULL))`;
