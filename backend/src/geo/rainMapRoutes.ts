// The MAP grid layer of the catchment map (docs/maps.md § MAP grid,
// docs/api.md § Catchment map):
//
//   GET /projects/:id/map/map-grid?bbox=minLon,minLat,maxLon,maxLat[&dataset=…]   one MAP grid's points in the box (viewer)
//
// It reads rain_map_dataset and rain_map_cell_reference (207), which the
// operator loads (the repo ships a synthetic grid). The tables are global, but
// the route is a project's: the caller must be a viewer of the project,
// checked under RLS (withUser), as the quaternary layer's is. One dataset per
// answer, never a mix: a 100 m surface and a 1.7 km one differ by tens of
// percent in places, and a view of both would read as one field. A box holding
// more of the grid's cells than one answer carries comes back with
// `tooDense: true` and no cells, counted from the grid before any read: the
// layer says zoom in.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { BboxQuery } from './quaternaryLayer.js';
import { rainMapCellsIn, rainMapDatasets } from './rainMap.js';

/** The most grid points one answer carries: about a 70 × 70 block, as many labels as a screen can hold apart. */
export const MAP_GRID_LAYER_MAX = 5_000;
/** The widest box asked for, in degrees each way: a catchment and its surroundings. */
export const MAP_GRID_BBOX_MAX_DEG = 2;

const Query = BboxQuery.extend({ dataset: z.string().trim().min(1).max(50).optional() });

export const rainMapRoutes = new Hono<AuthEnv>().get('/:id/map/map-grid', async (c) => {
	const { bbox, dataset: asked } = Query.parse(c.req.query());
	if (bbox.e - bbox.w > MAP_GRID_BBOX_MAX_DEG || bbox.n - bbox.s > MAP_GRID_BBOX_MAX_DEG)
		throw new ApiError(400, `Ask for at most ${MAP_GRID_BBOX_MAX_DEG}° each way.`);
	const id = c.req.param('id');
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'viewer');
		const datasets = await rainMapDatasets(db);
		const chosen = asked === undefined ? (datasets[0] ?? null) : (datasets.find((d) => d.dataset === asked) ?? null);
		if (asked !== undefined && !chosen) throw new ApiError(404, `No MAP grid “${asked}” is loaded.`);
		const read = chosen ? await rainMapCellsIn(db, chosen.dataset, bbox, MAP_GRID_LAYER_MAX) : { cells: [], inBox: 0 };
		return c.json({
			bbox: [bbox.w, bbox.s, bbox.e, bbox.n],
			dataset: chosen,
			datasets,
			cells: read?.cells ?? [],
			tooDense: read === null,
			max: MAP_GRID_LAYER_MAX
		});
	});
});
