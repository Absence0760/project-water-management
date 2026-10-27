// Dams seen from space (issue #604 R5-B; docs/api.md § Dams seen from space,
// docs/model.md § Modelled vs observed dam area).
//
//   GET /projects/:id/dams/observations[?run=<runId>][&node=<nodeId>]   viewer
//
// Each unit's dam polygons, their observed wet area from Digital Earth Africa
// (dam_observation, 249) and the run's modelled dam area on the same days,
// flagged (./compare.ts). The run is `run` when given, else the project's
// newest, the one the Dams tab shows. Read only, under the caller's RLS.
import { Hono } from 'hono';
import type { AuthEnv } from '../../auth/middleware.js';
import { withUser } from '../../db/tx.js';
import { notFound } from '../../http/errors.js';
import { requireRole, UUID } from '../../projects/access.js';
import { OBSERVED } from './compare.js';
import { compareAll, compareRun, OBSERVED_ATTRIBUTION, observationsOf, observedFeatures } from './read.js';

export const damObservedRoutes = new Hono<AuthEnv>().get('/:id/dams/observations', async (c) => {
	const id = c.req.param('id');
	const runParam = c.req.query('run') ?? null;
	const nodeParam = c.req.query('node') ?? null;
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
		return c.json(
			{
				attribution: OBSERVED_ATTRIBUTION,
				thresholds: OBSERVED,
				run: run ? { id: run.id, label: run.label, createdAt: run.createdAt, engineVersion: run.engineVersion, forecastFrom: run.forecastFrom } : null,
				dams: compareAll(features, observations, run)
			},
			200,
			{ 'Cache-Control': 'no-store' }
		);
	});
});
