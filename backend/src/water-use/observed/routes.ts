// Observed actual ET against a unit's modelled irrigation use (issue #623
// step 5; docs/api.md § Observed actual ET, docs/model.md §2.10o).
//
//   GET /projects/:id/nodes/:nodeId/et-observed[?run=<runId>]   viewer
//
// The unit's dekads of satellite actual ET (et_observation, 277) and the run's
// crop ET, effective rain and irrigation reaching the crop over the same
// dekads, compared (./compare.ts). The run is `run` when given, else the
// project's newest. Read only, under the caller's RLS. No observations (the
// usual case: the fetch is off by default) is an empty `sources`, not an error.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../auth/middleware.js';
import { withUser } from '../../db/tx.js';
import { ApiError, notFound } from '../../http/errors.js';
import { requireRole, UUID } from '../../projects/access.js';
import { compareEt, ET_OBSERVED } from './compare.js';
import { ET_ATTRIBUTION, etCompareRun, etObservationsOf } from './read.js';

// Parsed as one object, as every other route parses its query (dams/observed/routes.ts says why).
const EtObservedQuery = z.object({ run: z.string().optional() });

export const etObservedRoutes = new Hono<AuthEnv>().get('/:id/nodes/:nodeId/et-observed', async (c) => {
	const { id, nodeId } = c.req.param();
	const q = EtObservedQuery.parse(c.req.query());
	const runParam = q.run ?? null;
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'viewer');
		if (!UUID.test(nodeId) || (runParam !== null && !UUID.test(runParam))) throw notFound();
		const { rows } = await db.query<{ name: string; kind: string }>('SELECT name, kind::text AS kind FROM node WHERE id = $1 AND project_id = $2', [nodeId, id]);
		const unit = rows[0];
		if (!unit) throw notFound();
		if (unit.kind !== 'farm') throw new ApiError(400, 'Only a hydrological unit with land (not a gauge or other water user) has irrigation to compare.');
		const run = await etCompareRun(db, id, runParam, nodeId);
		if (runParam && !run) throw notFound();
		const observations = await etObservationsOf(db, id, nodeId);
		const result = compareEt({
			observations,
			modelled: run?.modelled ?? null,
			seriesMissing: !!run && !run.modelled && run.hasUnit,
			forecastFrom: run?.forecastFrom ?? null,
			plantedAreaM2: run?.modelled ? run.plantedAreaM2 : null
		});
		return c.json(
			{
				nodeId,
				name: unit.name,
				thresholds: ET_OBSERVED,
				run: run ? { id: run.id, label: run.label, createdAt: run.createdAt, engineVersion: run.engineVersion, forecastFrom: run.forecastFrom, inRun: !!run.modelled } : null,
				plantedAreaM2: run?.modelled ? run.plantedAreaM2 : null,
				sources: result.sources.map((s) => ({ ...s, attribution: ET_ATTRIBUTION[s.source] }))
			},
			200,
			{ 'Cache-Control': 'no-store' }
		);
	});
});
