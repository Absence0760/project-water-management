// The nearest gauging stations, proposed as the observed-flow source (issue
// #326 Part B, "B-gauge"; docs/api.md § Catchment map, docs/maps.md §
// Gauging stations).
//
//   GET /projects/:id/map/stations[?lon=&lat=][&within=]   the river gauges within N km, nearest first (viewer)
//
// Without a point, the catchment's outlet is used (stations.ts outletPoint:
// the map gauge linked to the outflow gauge node, else the boundary's
// centre). Read-only: the reference table is global, but the outlet is read
// from the project's map under the caller's RLS, so the route is a project
// read for viewers and above (a farmer gets 403, a stranger 404).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { requireRole } from '../projects/access.js';
import type { Position } from './geojson.js';
import { nearestStations, outletPoint, stationDatasets, STATIONS_WITHIN_KM, STATIONS_WITHIN_MAX_KM, type OutletFrom } from './stations.js';

export const StationsQuery = z
	.object({
		lon: z.coerce.number().finite().min(-180).max(180).optional(),
		lat: z.coerce.number().finite().min(-90).max(90).optional(),
		within: z.coerce.number().finite().positive().max(STATIONS_WITHIN_MAX_KM).optional()
	})
	.strict()
	.refine((q) => (q.lon === undefined) === (q.lat === undefined), 'give both lon and lat, or neither (the outlet)');

export const stationRoutes = new Hono<AuthEnv>().get('/:id/map/stations', async (c) => {
	const q = StationsQuery.parse(c.req.query());
	const id = c.req.param('id');
	const withinKm = q.within ?? STATIONS_WITHIN_KM;
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'viewer');
		let point: Position | null = null;
		let from: OutletFrom | 'query' | null = null;
		let pointName: string | null = null;
		if (q.lon !== undefined && q.lat !== undefined) {
			point = [q.lon, q.lat];
			from = 'query';
		} else {
			const outlet = await outletPoint(db, id);
			if (outlet) ({ point, from, name: pointName } = outlet);
		}
		const datasets = await stationDatasets(db);
		if (!point) return c.json({ point: null, pointFrom: null, pointName: null, withinKm, stations: [], datasets });
		return c.json({ point, pointFrom: from, pointName, withinKm, stations: await nearestStations(db, point, withinKm), datasets });
	});
});
