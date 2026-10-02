// Trace a dam from a click inside its water (issue #326 C2; docs/maps.md §
// Assisted drawing, docs/api.md § Catchment map).
//
//   GET  /projects/:id/map/dam-trace     on or off, and the dataset (viewer)
//   POST /projects/:id/map/dam-trace     the outline of the water round a point: a proposal, nothing saved (editor)
//
// The proposal is drawn on the map as a drawing the editor adjusts, then saves
// through POST …/map/features with `traced` (geo/routes.ts), which traces it
// again so the method it records is the server's. The trace reads a few tiles
// (about 8 km round the click, 16 km at most) and touches no database between
// the role check and the answer.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { safeError } from '../logging/safeError.js';
import { logEvent } from '../logging/logEvent.js';
import { requireRole } from '../projects/access.js';
import { configuredWater, traceDam, TraceRefused } from './damTrace.js';
import { countMapCompute } from './throttle.js';

export const TraceBody = z
	.object({
		lon: z.number().finite().min(-180).max(180),
		lat: z.number().finite().min(-90).max(90),
		minOccurrence: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(75)]).optional()
	})
	.strict();

export const traceRoutes = new Hono<AuthEnv>()
	.get('/:id/map/dam-trace', async (c) => {
		const id = c.req.param('id');
		await withUser(c.get('userId'), (db) => requireRole(db, id, 'viewer'));
		const water = configuredWater();
		let dataset = null;
		if (water) {
			try {
				const i = await water.info();
				dataset = { label: i.label, attribution: i.attribution, fingerprint: i.fingerprint, maxZoom: i.maxZoom, bounds: i.bounds };
			} catch (err) {
				logEvent('warn', { event: 'water_unreadable', ...safeError(err) });
			}
		}
		// On only when the raster is configured *and* readable, so the Map never offers a tool that can only fail.
		return c.json({ available: dataset !== null, dataset });
	})
	.post('/:id/map/dam-trace', async (c) => {
		const body = TraceBody.parse(await readJson(c));
		const id = c.req.param('id');
		await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Every trace counts before the work (186_map_compute_throttle).
			await countMapCompute(c, db, id, 'trace');
		});
		const water = configuredWater();
		if (!water) throw new ApiError(409, 'Tracing is off: the server has no water occurrence data (WATER_URL is empty).');
		try {
			const t = await traceDam(water, [body.lon, body.lat], body.minOccurrence ?? 25);
			return c.json({
				trace: {
					click: t.click,
					seed: t.seed,
					snapDistanceM: t.snapDistanceM,
					geometry: t.geometry,
					areaM2: t.areaM2,
					cells: t.cells,
					cellSizeM: t.cellSizeM,
					zoom: t.zoom,
					minOccurrence: t.minOccurrence,
					dataset: t.dataset.label,
					attribution: t.dataset.attribution,
					datasetFingerprint: t.dataset.fingerprint,
					method: t.method,
					methodVersion: t.methodVersion
				}
			});
		} catch (err) {
			if (err instanceof TraceRefused) throw new ApiError(422, err.message, { reason: err.code });
			logEvent('error', { event: 'dam_trace_failed', ...safeError(err) });
			throw new ApiError(503, 'The water occurrence data could not be read just now. Try again; if it keeps failing, the operator should check WATER_URL.');
		}
	});
