// GET /teams/:id/portfolio (roadmap WP-2.14, docs/api.md § Portfolio): any
// team member. A farmer has no team membership, so the route answers them
// 404 like any other non-member (requireTeamRole). The EWR status is judged
// by the team's thresholds (055_team_settings), or the defaults when it has
// set none, and the response says which apply.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { requireTeamRole } from '../teams/access.js';
import { appliedThresholds } from '../teams/settings.js';
import { loadPortfolio } from './portfolio.js';

export const portfolioRoutes = new Hono<AuthEnv>().get('/:id/portfolio', async (c) =>
	withUser(c.get('userId'), async (db) => {
		const id = c.req.param('id');
		const role = await requireTeamRole(db, id, 'viewer');
		const { rows } = await db.query<{ name: string; settings: unknown }>('SELECT name, settings FROM team WHERE id = $1', [id]);
		const thresholds = appliedThresholds(rows[0]!.settings);
		const { source: _source, ...cutoffs } = thresholds;
		// Each project's ages count to its own today (its time zone, 058): there is no one "today" for the team.
		return c.json({ team: { id, name: rows[0]!.name, role }, thresholds, projects: await loadPortfolio(db, id, new Date(), cutoffs) });
	})
);
