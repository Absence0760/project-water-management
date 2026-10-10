// The DEM grid layer of the catchment map (docs/maps.md § DEM grid,
// docs/api.md § Catchment map):
//
//   GET /projects/:id/map/dem-grid?bbox=minLon,minLat,maxLon,maxLat   every 10th DEM cell each way in the box, with its elevation (viewer)
//
// Off (409) without a DEM (DEM_URL empty). Reading a few decoded tiles is
// cheap next to delineation (dem.ts caches them per process), so it isn't
// counted against the per-account elevation-model cap; the box and the point
// count bound it instead. A box holding more points than one answer carries
// comes back `tooDense` with none, counted before any tile is read.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { BboxQuery } from '../geo/quaternaryLayer.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { requireRole } from '../projects/access.js';
import { configuredDem } from './dem.js';
import { DEM_GRID_STRIDE, demGridPoints } from './demGrid.js';

/** The most points one answer carries: about a 70 × 70 block, as many labels as a screen holds apart. */
export const DEM_GRID_LAYER_MAX = 5_000;
/** The widest box asked for, degrees each way: at ~320 m spacing a 0.5° box is already past MAX, so the layer says zoom in. */
export const DEM_GRID_BBOX_MAX_DEG = 0.5;

export const demGridRoutes = new Hono<AuthEnv>().get('/:id/map/dem-grid', async (c) => {
	const { bbox } = BboxQuery.strict().parse(c.req.query());
	if (bbox.e - bbox.w > DEM_GRID_BBOX_MAX_DEG || bbox.n - bbox.s > DEM_GRID_BBOX_MAX_DEG)
		throw new ApiError(400, `Ask for at most ${DEM_GRID_BBOX_MAX_DEG}° each way.`);
	const id = c.req.param('id');
	await withUser(c.get('userId'), (db) => requireRole(db, id, 'viewer'));
	const dem = configuredDem();
	if (!dem) throw new ApiError(409, 'The DEM grid is off: the server has no elevation model (DEM_URL is empty).');
	try {
		const info = await dem.info();
		const got = await demGridPoints(dem, bbox, DEM_GRID_LAYER_MAX);
		return c.json({
			bbox: [bbox.w, bbox.s, bbox.e, bbox.n],
			dataset: { label: info.label, attribution: info.attribution, zoom: info.maxZoom },
			stride: DEM_GRID_STRIDE,
			cellM: got?.cellM ?? null,
			points: got?.points ?? [],
			tooDense: got === null,
			max: DEM_GRID_LAYER_MAX
		});
	} catch (err) {
		logEvent('error', { event: 'dem_grid_failed', ...safeError(err) });
		throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
	}
});
