// The A-pan and S-pan grid layers of the catchment map (docs/maps.md § A-pan
// and S-pan grids, docs/api.md § Catchment map):
//
//   GET /projects/:id/map/evaporation-grid?kind=apan|span&bbox=minLon,minLat,maxLon,maxLat[&dataset=…][&month=1–12]   (viewer)
//
// One loaded evaporation grid of that kind (evaporationLayer.ts), its cells in
// the box, each with the month's mean total or, without `month`, the year's
// (the 12 months summed). The tables are global, but the route is a project's:
// the caller must be a viewer of the project, checked under RLS (withUser), as
// the MAP grid's is (rainMapRoutes.ts), with the same caps: at most
// EVAPORATION_GRID_LAYER_MAX points an answer and EVAPORATION_GRID_BBOX_MAX_DEG
// a side; a box holding more of the grid's cells comes back `tooDense: true`
// with no cells (zoom in). One dataset an answer, never a mix.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { EVAPORATION_LAYER_KINDS, evaporationCellsIn, evaporationLayerDatasets } from './evaporationLayer.js';
import { BboxQuery } from './quaternaryLayer.js';
import { MAP_GRID_BBOX_MAX_DEG, MAP_GRID_LAYER_MAX } from './rainMapRoutes.js';

/** The most grid points one answer carries: the MAP grid's cap. */
export const EVAPORATION_GRID_LAYER_MAX = MAP_GRID_LAYER_MAX;
/** The widest box asked for, in degrees each way: the MAP grid's. */
export const EVAPORATION_GRID_BBOX_MAX_DEG = MAP_GRID_BBOX_MAX_DEG;

const Query = BboxQuery.extend({
	kind: z.enum(EVAPORATION_LAYER_KINDS),
	dataset: z.string().trim().min(1).max(50).optional(),
	month: z.coerce.number().int().min(1).max(12).optional()
});

const KIND_WORD = { apan: 'A-pan', span: 'S-pan' } as const;

export const evaporationLayerRoutes = new Hono<AuthEnv>().get('/:id/map/evaporation-grid', async (c) => {
	const { bbox, kind, dataset: asked, month } = Query.parse(c.req.query());
	if (bbox.e - bbox.w > EVAPORATION_GRID_BBOX_MAX_DEG || bbox.n - bbox.s > EVAPORATION_GRID_BBOX_MAX_DEG)
		throw new ApiError(400, `Ask for at most ${EVAPORATION_GRID_BBOX_MAX_DEG}° each way.`);
	const id = c.req.param('id');
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'viewer');
		const found = await evaporationLayerDatasets(db, kind);
		const chosen = asked === undefined ? (found[0] ?? null) : (found.find((d) => d.dataset === asked) ?? null);
		if (asked !== undefined && !chosen) throw new ApiError(404, `No ${KIND_WORD[kind]} grid “${asked}” is loaded.`);
		const cells = chosen ? await evaporationCellsIn(db, chosen.grid, bbox, EVAPORATION_GRID_LAYER_MAX, month ?? null) : [];
		const strip = ({ grid: _grid, ...d }: (typeof found)[number]) => d;
		return c.json({
			bbox: [bbox.w, bbox.s, bbox.e, bbox.n],
			kind,
			month: month ?? null,
			dataset: chosen ? strip(chosen) : null,
			datasets: found.map(strip),
			cells: cells ?? [],
			tooDense: cells === null,
			max: EVAPORATION_GRID_LAYER_MAX
		});
	});
});
