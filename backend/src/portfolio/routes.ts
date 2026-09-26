// GET /teams/:id/portfolio (roadmap WP-2.14, docs/api.md § Portfolio): any
// team member. A farmer has no team membership, so the route answers them
// 404 like any other non-member (requireTeamRole).
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { utcToday } from '../feeds/fetch.js';
import { requireTeamRole } from '../teams/access.js';
import { loadPortfolio } from './portfolio.js';
import { EWR_THRESHOLDS } from './status.js';

export const portfolioRoutes = new Hono<AuthEnv>().get('/:id/portfolio', async (c) =>
	withUser(c.get('userId'), async (db) => {
		const id = c.req.param('id');
		await requireTeamRole(db, id, 'viewer');
		const today = utcToday();
		return c.json({ today, thresholds: EWR_THRESHOLDS, projects: await loadPortfolio(db, id, today) });
	})
);
