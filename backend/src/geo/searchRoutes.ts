// The Map's search (issue #523 C5, #90 Q23; docs/api.md § Catchment map,
// docs/maps.md § Search).
//
//   GET /projects/:id/map/search?q=   gauges, registered dams, quaternaries, then places whose names start with the words (viewer)
//
// Read-only, our own reference tables only (gazetteer.ts searchMap), never a
// third-party geocoder. The tables are global, but the route is a project's,
// like the quaternary layer and the station proposals: the caller must be a
// viewer of the project, checked under RLS (withUser), so a farmer gets 403
// and a stranger 404, and it answers nothing a non-member could use.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { requireRole } from '../projects/access.js';
import { searchKey, searchMap } from './gazetteer.js';

/** What was typed: 2 to 100 characters, at least one letter or digit among them. */
export const SearchQuery = z
	.object({
		q: z
			.string()
			.transform((s) => s.trim())
			.pipe(z.string().min(2, 'type at least 2 characters').max(100, 'at most 100 characters'))
			.refine((s) => searchKey(s).length > 0, 'type a name or a code: letters or digits')
	})
	.strict();

export const searchRoutes = new Hono<AuthEnv>().get('/:id/map/search', async (c) => {
	const { q } = SearchQuery.parse(c.req.query());
	const id = c.req.param('id');
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'viewer');
		return c.json(await searchMap(db, q));
	});
});
