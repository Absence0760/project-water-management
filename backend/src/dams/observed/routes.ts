// Dams seen from space (issue #604 R5-B; docs/api.md § Dams seen from space,
// docs/model.md § Modelled vs observed dam area).
//
//   GET /projects/:id/dams/observations[?run=<runId>][&node=<nodeId>]   viewer
//
// Each unit's dam polygons, their observed wet area from Digital Earth Africa
// (dam_observation, 261; Sentinel-2 and Sentinel-1 since 278, with
// Copernicus's credit for their years, `sentinelCredit`) and the run's modelled dam area on the same days,
// flagged (./compare.ts). The run is `run` when given, else the project's
// newest, the one the Dams tab shows. Read only, under the caller's RLS.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../auth/middleware.js';
import { withUser } from '../../db/tx.js';
import { notFound } from '../../http/errors.js';
import { requireRole, UUID } from '../../projects/access.js';
import { OBSERVED } from './compare.js';
import { compareAll, compareRun, OBSERVED_ATTRIBUTION, observationsOf, observedFeatures } from './read.js';
import { isSentinel, sentinelCredit } from './upstream.js';

// Parsed as one object, as every other route parses its query: a single
// named query read is reserved for credential slots, which
// auth/token-confusion.security.db.test.ts lists one by one.
const ObservationsQuery = z.object({ run: z.string().optional(), node: z.string().optional() });

export const damObservedRoutes = new Hono<AuthEnv>().get('/:id/dams/observations', async (c) => {
	const id = c.req.param('id');
	const q = ObservationsQuery.parse(c.req.query());
	const runParam = q.run ?? null;
	const nodeParam = q.node ?? null;
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'viewer');
		if ((runParam !== null && !UUID.test(runParam)) || (nodeParam !== null && !UUID.test(nodeParam))) throw notFound();
		const features = await observedFeatures(db, id, nodeParam ?? undefined);
		const nodeIds = [...new Set(features.flatMap((f) => (f.nodeId ? [f.nodeId] : [])))];
		const run = await compareRun(db, id, runParam, nodeIds);
		if (runParam && !run) throw notFound();
		const observations = await observationsOf(
			db,
			id,
			features.map((f) => f.id)
		);
		const dams = compareAll(features, observations, run);
		return c.json(
			{
				attribution: OBSERVED_ATTRIBUTION,
				// Copernicus's credit, for the years of the Sentinel views listed; null with none.
				sentinelCredit: sentinelCredit(dams.flatMap((d) => d.points.filter((p) => isSentinel(p.source)).map((p) => p.date))),
				thresholds: OBSERVED,
				run: run ? { id: run.id, label: run.label, createdAt: run.createdAt, engineVersion: run.engineVersion, forecastFrom: run.forecastFrom } : null,
				dams
			},
			200,
			{ 'Cache-Control': 'no-store' }
		);
	});
});
