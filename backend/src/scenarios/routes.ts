// /projects/:id/scenarios — named overrides on a base run (roadmap WP-3.2,
// docs/api.md § Scenarios, docs/scenarios.md). Viewers read, editors write;
// farmers get 403 like every viewer route (their farm-scoped reads are
// elsewhere). RLS (024_scenarios.sql) enforces the same underneath.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { lockProjectRuns, trimRuns } from '../runs/execute.js';
import { RUN_META_SQL } from '../runs/routes.js';
import { checkScenario, executeScenarioRun, loadBaseInput, loadScenario, SCENARIO_SELECT, type ScenarioCheck, type ScenarioRow } from './execute.js';
import { CreateScenarioBody, opsSha256, PatchScenarioBody, RebaseBody, ScenarioRunBody, STATUS_MOVES } from './schema.js';

const json = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

/** What the editor shows beside the ops: which applied, which don't, and how each is classed. The input itself stays server-side. */
const checkView = (c: ScenarioCheck) => ({ applied: c.applied, problems: c.problems, classified: c.classified });

/** A scenario and its check against its base, or `check: null` with why when the base can't be rebuilt. */
async function withCheck(db: Db, projectId: string, s: ScenarioRow) {
	try {
		const base = await loadBaseInput(db, projectId, s.baseRunId);
		return { scenario: s, check: checkView(checkScenario(base, s.ops, s.ownedNodeIds)), checkError: null };
	} catch (err) {
		if (err instanceof ApiError && err.status === 409) return { scenario: s, check: null, checkError: err.message };
		throw err;
	}
}

const scenarioId = (sid: string) => {
	if (!UUID.test(sid)) throw new ApiError(404, 'not found');
	return sid;
};

/** A name already used in the project (scenario_name_idx) reads as a 409 that says so. */
const duplicateName = (err: unknown): never => {
	if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'this project already has a scenario with that name');
	throw err;
};

const frozen = (s: ScenarioRow) => new ApiError(409, `this scenario is ${s.status}, so its ops, owned nodes and base run can't change`);

export const scenarioRoutes = new Hono<AuthEnv>()
	.get('/:id/scenarios', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<ScenarioRow>(`${SCENARIO_SELECT} WHERE s.project_id = $1 ORDER BY s.created_at DESC, s.id DESC`, [id]);
			return c.json({ scenarios: rows });
		});
	})
	.post('/:id/scenarios', async (c) => {
		const id = c.req.param('id');
		const body = CreateScenarioBody.parse(await json(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Citing a run: not while a trim or delete of this project's runs is under way (it would miss the citation).
			await lockProjectRuns(db, id);
			await loadBaseInput(db, id, body.baseRunId);
			const { rows } = await db
				.query<{ id: string }>(
					`INSERT INTO scenario (project_id, name, description, base_run_id, ops, ops_sha256, owned_node_ids)
					 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
					[id, body.name, body.description, body.baseRunId, JSON.stringify(body.ops), opsSha256(body.ops), body.ownedNodeIds]
				)
				.catch(duplicateName);
			await recordAudit(db, id, 'scenario.created', { scenarioId: rows[0]!.id, name: body.name, baseRunId: body.baseRunId, ops: body.ops.length });
			return c.json(await withCheck(db, id, await loadScenario(db, id, rows[0]!.id)), 201);
		});
	})
	.get('/:id/scenarios/:sid', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json(await withCheck(db, id, await loadScenario(db, id, scenarioId(sid))));
		});
	})
	.patch('/:id/scenarios/:sid', async (c) => {
		const { id, sid } = c.req.param();
		const body = PatchScenarioBody.parse(await json(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const s = await loadScenario(db, id, scenarioId(sid));
			if ((body.ops !== undefined || body.ownedNodeIds !== undefined) && s.status !== 'draft') throw frozen(s);
			if (body.status !== undefined && body.status !== s.status && !STATUS_MOVES[s.status].includes(body.status))
				throw new ApiError(409, `a ${s.status} scenario can't become ${body.status}`);
			const set: [string, unknown][] = [];
			if (body.name !== undefined) set.push(['name', body.name]);
			if (body.description !== undefined) set.push(['description', body.description]);
			if (body.ops !== undefined) set.push(['ops', JSON.stringify(body.ops)], ['ops_sha256', opsSha256(body.ops)]);
			if (body.ownedNodeIds !== undefined) set.push(['owned_node_ids', body.ownedNodeIds]);
			if (body.status !== undefined) set.push(['status', body.status]);
			await db
				.query(`UPDATE scenario SET ${set.map(([k], i) => `${k} = $${i + 3}`).join(', ')} WHERE project_id = $1 AND id = $2`, [
					id,
					sid,
					...set.map(([, v]) => v)
				])
				.catch(duplicateName);
			await recordAudit(db, id, 'scenario.changed', {
				scenarioId: sid,
				name: body.name ?? s.name,
				fields: set.map(([k]) => k).filter((k) => k !== 'ops_sha256'),
				...(body.status !== undefined && body.status !== s.status ? { from: s.status, to: body.status } : {})
			});
			return c.json(await withCheck(db, id, await loadScenario(db, id, sid)));
		});
	})
	.delete('/:id/scenarios/:sid', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const s = await loadScenario(db, id, scenarioId(sid));
			if (s.status === 'submitted' || s.status === 'decided') throw new ApiError(409, `a ${s.status} scenario can't be deleted`);
			// Its base run stops being cited and may be trimmed: under the project's run lock, as a trim is.
			await lockProjectRuns(db, id);
			await db.query('DELETE FROM scenario WHERE project_id = $1 AND id = $2', [id, sid]);
			await recordAudit(db, id, 'scenario.deleted', { scenarioId: sid, name: s.name });
			return c.body(null, 204);
		});
	})
	.post('/:id/scenarios/:sid/runs', async (c) => {
		const { id, sid } = c.req.param();
		const body = ScenarioRunBody.parse(await json(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { id: runId, check } = await executeScenarioRun(db, id, scenarioId(sid), body.label).catch((err: Error) => {
				// As POST …/runs: engine problems with the input are the user's to fix.
				if (err instanceof ApiError || (err as { code?: string }).code) throw err;
				throw new ApiError(400, `model run failed: ${err.message}`);
			});
			// A scenario run counts toward the cap like any other.
			const removedRunIds = await trimRuns(db, id);
			const { rows } = await db.query(`SELECT ${RUN_META_SQL.meta}, r.summary ${RUN_META_SQL.from} WHERE r.id = $1`, [runId]);
			return c.json({ run: rows[0], removedRunIds, applied: check.applied, classified: check.classified }, 201);
		});
	})
	.post('/:id/scenarios/:sid/rebase', async (c) => {
		const { id, sid } = c.req.param();
		const body = RebaseBody.parse(await json(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			scenarioId(sid);
			// Lock first (as a trim and a scenario run do), then the new base's input.
			if (!body.dryRun) await lockProjectRuns(db, id);
			const base = await loadBaseInput(db, id, body.baseRunId);
			if (!body.dryRun) {
				// The update takes the row lock, so the ops checked below are the ones the
				// scenario has now, not ones a concurrent PATCH has since replaced.
				const { rowCount } = await db.query("UPDATE scenario SET base_run_id = $3 WHERE project_id = $1 AND id = $2 AND status = 'draft'", [id, sid, body.baseRunId]);
				if (!rowCount) throw frozen(await loadScenario(db, id, sid));
			}
			const s = await loadScenario(db, id, sid);
			if (!body.dryRun) await recordAudit(db, id, 'scenario.changed', { scenarioId: sid, name: s.name, fields: ['base_run_id'], baseRunId: body.baseRunId });
			return c.json({ scenario: s, ...checkView(checkScenario(base, s.ops, s.ownedNodeIds)) });
		});
	});
