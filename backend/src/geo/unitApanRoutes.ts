// Each hydrological unit's mean monthly A-pan from an A-pan grid (geo/unitApan.ts;
// docs/api.md § Catchment map, docs/maps.md § A-pan for each unit):
//
//   GET /projects/:id/map/unit-apan[?dataset=]   (viewer) each land unit's 12 monthly A-pan means over its
//       parcel, beside the catchment boundary's average over the same grid, each unit's year and its
//       difference from the catchment's, and the units the grid doesn't describe with the reason
//
// For comparison only: nothing is written, and the model keeps running every
// unit on the one catchment A-pan row. A grid asked for that isn't loaded (or
// isn't an A-pan grid) answers `dataset: null`, as the evaporation proposals do
// for Model settings → Demand's CCWR option: not loaded is a normal state.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { requireRole } from '../projects/access.js';
import { mergeSettings } from '../projects/settings.js';
import { unitApanProposal } from './unitApan.js';

const Query = z.object({ dataset: z.string().trim().min(1).max(50).optional() });

export const unitApanRoutes = new Hono<AuthEnv>().get('/:id/map/unit-apan', async (c) => {
	const { dataset } = Query.parse(c.req.query());
	const id = c.req.param('id');
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'viewer');
		const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [id]);
		return c.json(await unitApanProposal(db, id, dataset, [...mergeSettings(rows[0]?.settings).apanMm]));
	});
});
