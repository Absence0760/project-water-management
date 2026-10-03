// The run a project nominates as evidence, and every earlier nomination
// (010_run_nomination.sql, docs/data-model.md § Evidence nomination). The
// history is append-only in the database: water_app can read and add rows,
// never change or remove them, and a nominated run can't be deleted. A
// withdrawal (098_nomination_withdrawal) is a row of its own with no run and
// a reason: after it nothing is the evidence until a run is nominated again.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { inputFlowShares, overAllocationError, type ModelInput } from '@water-management/engine';

/** Longest history per project (the run_nomination_stamp trigger enforces the same number). */
export const NOMINATIONS_PER_PROJECT_MAX = 50;
/** Longest nomination reason, in characters (010_run_nomination.sql CHECK). */
export const NOMINATION_REASON_MAX = 2000;

/**
 * A run's evidence status as a SQL expression over `model_run r`: 'current'
 * for the project's newest nomination, 'past' for a run nominated before and
 * since replaced or withdrawn, NULL for a run never nominated.
 */
export const EVIDENCE_STATUS_SQL = `CASE
	WHEN r.id = (SELECT n.run_id FROM run_nomination n WHERE n.project_id = r.project_id ORDER BY n.nominated_at DESC LIMIT 1) THEN 'current'
	WHEN EXISTS (SELECT 1 FROM run_nomination n WHERE n.run_id = r.id) THEN 'past'
END`;

/** A row of the history: a run nominated, or (`withdrawn`, every run field null) the nomination before it withdrawn. */
export interface Nomination {
	id: string;
	withdrawn: boolean;
	runId: string | null;
	runLabel: string | null;
	runCreatedAt: string | null;
	runoffModel: string | null;
	engineVersion: string | null;
	reason: string;
	nominatedAt: string;
	nominatedBy: string | null;
}

/** A project's nominations, oldest first; the last one is the current nomination, unless it is a withdrawal. */
export async function listNominations(db: Db, projectId: string): Promise<Nomination[]> {
	const { rows } = await db.query<Nomination>(
		`SELECT n.id, n.run_id IS NULL AS withdrawn, n.run_id AS "runId", r.label AS "runLabel", r.created_at AS "runCreatedAt",
			n.runoff_model AS "runoffModel", n.engine_version AS "engineVersion", n.reason,
			n.nominated_at AS "nominatedAt", u.display_name AS "nominatedBy"
		 FROM run_nomination n
		 LEFT JOIN model_run r ON r.id = n.run_id
		 LEFT JOIN app_user u ON u.id = n.nominated_by
		 WHERE n.project_id = $1
		 ORDER BY n.nominated_at`,
		[projectId]
	);
	return rows;
}

/** One run's place in the evidence history, for compare and the summary CSV. */
export interface RunEvidence {
	status: 'current' | 'past';
	/** This run's most recent nomination. */
	nominatedAt: string;
	nominatedBy: string | null;
	reason: string;
	/** The row after it (status 'past' only): another run nominated, or (`withdrawn`, no run) the nomination withdrawn. */
	replacedBy: { withdrawn: boolean; runId: string | null; runLabel: string | null; nominatedAt: string; nominatedBy: string | null; reason: string } | null;
}

/** Where `runId` stands in a history (oldest first), or null when it was never nominated. */
export function runEvidence(history: readonly Nomination[], runId: string): RunEvidence | null {
	let i = -1;
	for (let k = history.length - 1; k >= 0; k--)
		if (history[k]!.runId === runId) {
			i = k;
			break;
		}
	if (i < 0) return null;
	const own = history[i]!;
	const next = history[i + 1];
	return {
		status: next ? 'past' : 'current',
		nominatedAt: iso(own.nominatedAt),
		nominatedBy: own.nominatedBy,
		reason: own.reason,
		replacedBy: next
			? {
					withdrawn: next.withdrawn,
					runId: next.runId,
					runLabel: next.runLabel,
					nominatedAt: iso(next.nominatedAt),
					nominatedBy: next.nominatedBy,
					reason: next.reason
				}
			: null
	};
}

const iso = (d: string | Date) => new Date(d).toISOString();

const reason = (missing: string) =>
	z
		.string()
		.trim()
		.min(1, missing)
		.max(NOMINATION_REASON_MAX)
		// Postgres text can't hold NUL; refuse it here rather than surface a database error.
		.refine((s) => !s.includes('\u0000'), 'reason cannot contain NUL characters');
const NominateBody = z.object({ runId: z.string().uuid(), reason: reason('say why this run is the evidence') }).strict();
const WithdrawBody = z.object({ reason: reason('say why the nomination is withdrawn') }).strict();

/** Why a forecast run (WP-2.12, model_run.trigger 'forecast') can't be nominated. */
export const FORECAST_NOT_EVIDENCE =
	'a forecast run cannot be nominated as evidence: evidence is judged on the record, and its last days are modelled on forecast rain; nominate an ordinary run of the model';

/** Why a scenario run (024_scenarios: a scenario's changes on a base run) can't be nominated: it is a what-if, not the catchment as it is. */
export const SCENARIO_NOT_EVIDENCE =
	'a scenario run cannot be nominated as evidence: it is its scenario’s changes applied to a base run, not the catchment as it is; nominate a run of the model (an application’s run is assessed against the nominated run in its evidence report)';

export const evidenceRoutes = new Hono<AuthEnv>()
	.get('/:id/evidence', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ nominations: await listNominations(db, id) });
		});
	})
	.post('/:id/evidence', async (c) => {
		const id = c.req.param('id');
		const body = NominateBody.parse(await readJson(c, { optional: true }));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Friendly answers first; the stamp trigger enforces each of these again.
			const { rows: run } = await db.query<{ runoffModel: string; model: ModelInput['model'] | null; settings: ModelInput['settings'] | null; trigger: string; scenario: boolean }>(
				`SELECT COALESCE(inputs->'settings'->>'runoffModel', 'legacy') AS "runoffModel", inputs->'model' AS model, inputs->'settings' AS settings, "trigger",
				        (scenario_id IS NOT NULL OR inputs ? 'scenario') AS scenario
				   FROM model_run WHERE project_id = $1 AND id = $2`,
				[id, body.runId]
			);
			if (!run[0]) throw new ApiError(404, 'run not found');
			// A scenario's run, or one whose scenario has since been deleted (its inputs still record the scenario).
			if (run[0].scenario) throw new ApiError(409, SCENARIO_NOT_EVIDENCE);
			// Evidence is judged on history; a forecast run's tail is modelled on forecast rain (WP-2.12).
			if (run[0].trigger === 'forecast') throw new ApiError(409, FORECAST_NOT_EVIDENCE);
			if (run[0].runoffModel === 'legacy')
				throw new ApiError(409, 'a run of the legacy runoff model is workbook comparison only and cannot be nominated as evidence');
			// Runs before engine 0.27.1 ran with flow shares over 100 % (water from nowhere); newer ones are refused.
			const over = run[0].model && overAllocationError(inputFlowShares({ model: run[0].model, settings: run[0].settings ?? {} }).sum);
			if (over) throw new ApiError(409, `this run cannot be nominated as evidence: its ${over.replace(/\. Correct .*$/, '')}`);
			const before = await listNominations(db, id);
			if (before.at(-1)?.runId === body.runId) throw new ApiError(409, 'this run is already the nominated evidence run');
			if (before.length >= NOMINATIONS_PER_PROJECT_MAX)
				throw new ApiError(409, `this project has reached the limit of ${NOMINATIONS_PER_PROJECT_MAX} nominations`);
			await db.query('INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, $3)', [id, body.runId, body.reason]);
			const nominations = await listNominations(db, id);
			return c.json({ nomination: nominations.at(-1), nominations }, 201);
		});
	})
	// Withdraw the current nomination (098): a history row with no run and a
	// reason. Nothing is the evidence until a run is nominated again.
	.post('/:id/evidence/withdraw', async (c) => {
		const id = c.req.param('id');
		const body = WithdrawBody.parse(await readJson(c, { optional: true }));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Friendly answers first; the stamp trigger enforces both again.
			const before = await listNominations(db, id);
			if (!before.at(-1)?.runId) throw new ApiError(409, 'no run is nominated as evidence, so there is nothing to withdraw');
			if (before.length >= NOMINATIONS_PER_PROJECT_MAX)
				throw new ApiError(409, `this project has reached the limit of ${NOMINATIONS_PER_PROJECT_MAX} nominations`);
			await db.query('INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, NULL, $2)', [id, body.reason]);
			const nominations = await listNominations(db, id);
			return c.json({ nomination: nominations.at(-1), nominations }, 201);
		});
	});
