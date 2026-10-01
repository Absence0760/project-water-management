// The quaternary outlines layer of the catchment map (issue #326 A6;
// docs/maps.md § Quaternary outlines, docs/api.md § Catchment map):
//
//   GET /projects/:id/map/quaternaries?bbox=minLon,minLat,maxLon,maxLat   the quaternaries whose box meets the bbox (viewer)
//
// It reads quaternary_reference (152), the dataset the operator loads (the
// repo ships a synthetic one). That table is global, but the route is a
// project's: the caller must be a viewer of the project, checked under RLS
// (withUser), so it answers nothing a non-member could use to probe. It
// returns codes and outlines only: no MAP or MAR (those stay with the
// lookup, GET …/map/quaternary, which proposes them).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import type { Geometry } from './geojson.js';
import { quaternaryDatasets, SYNTHETIC_DATASET } from './quaternary.js';

/** The most outlines one answer carries; past it `truncated` says so and the codes are the first by code. */
export const QUATERNARY_LAYER_MAX = 100;
/** The widest bbox asked for, in degrees each way: a project's surroundings, never the country (real outlines run to thousands of vertices). */
export const QUATERNARY_BBOX_MAX_DEG = 5;

/** `minLon,minLat,maxLon,maxLat`, in WGS84 degrees, non-empty and at most QUATERNARY_BBOX_MAX_DEG on a side. */
export const BboxQuery = z.object({
	bbox: z
		.string()
		.max(200)
		.transform((s, ctx) => {
			const v = s.split(',').map((x) => Number(x.trim()));
			const [w, south, e, n] = v as [number, number, number, number];
			const ok =
				v.length === 4 &&
				v.every((x) => Number.isFinite(x)) &&
				w >= -180 &&
				e <= 180 &&
				south >= -90 &&
				n <= 90 &&
				w < e &&
				south < n;
			if (!ok) {
				ctx.addIssue({ code: 'custom', message: 'bbox must be minLon,minLat,maxLon,maxLat in WGS84 degrees, west of east and south of north' });
				return z.NEVER;
			}
			return { w, s: south, e, n };
		})
});

export interface QuaternaryOutlineRow {
	code: string;
	dataset: string;
	/** True for the repo's invented dataset: never real outlines. */
	synthetic: boolean;
	geometry: Geometry;
}

export const quaternaryLayerRoutes = new Hono<AuthEnv>().get('/:id/map/quaternaries', async (c) => {
	const { bbox } = BboxQuery.parse(c.req.query());
	if (bbox.e - bbox.w > QUATERNARY_BBOX_MAX_DEG || bbox.n - bbox.s > QUATERNARY_BBOX_MAX_DEG)
		throw new ApiError(400, `Ask for at most ${QUATERNARY_BBOX_MAX_DEG}° each way around the catchment.`);
	const id = c.req.param('id');
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'viewer');
		// The bounding-box index (quaternary_reference_bbox_idx) narrows it: each quaternary's box meets the asked one.
		const { rows } = await db.query<{ code: string; dataset: string; geometry: Geometry }>(
			`SELECT code, dataset, geometry FROM quaternary_reference
			 WHERE max_lon >= $1 AND min_lon <= $3 AND max_lat >= $2 AND min_lat <= $4
			 ORDER BY code
			 LIMIT $5`,
			[bbox.w, bbox.s, bbox.e, bbox.n, QUATERNARY_LAYER_MAX + 1]
		);
		const truncated = rows.length > QUATERNARY_LAYER_MAX;
		const quaternaries: QuaternaryOutlineRow[] = rows
			.slice(0, QUATERNARY_LAYER_MAX)
			.map((r) => ({ code: r.code, dataset: r.dataset, synthetic: r.dataset === SYNTHETIC_DATASET, geometry: r.geometry }));
		return c.json({ bbox: [bbox.w, bbox.s, bbox.e, bbox.n], quaternaries, truncated, datasets: await quaternaryDatasets(db) });
	});
});
