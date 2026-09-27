// /projects/:id/runs/:runId/signoffs — professional sign-off on a run
// (roadmap WP-3.13, 036_signoff.sql; docs/api.md § Sign-offs). Viewers read
// the statement and the sign-offs; editors and owners sign, as themselves.
// A sign-off is immutable: there is no route to change or remove one, and RLS
// gives water_app no UPDATE or DELETE on the table either.
import { createHash } from 'node:crypto';
import { DISCLAIMER, signoffStatement, signoffStatementText, type SignoffStatement } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { rank, requireRole, UUID } from '../projects/access.js';
import { lockProjectRuns } from '../runs/execute.js';
import { RUN_UNVERIFIED, runUnverified, runVerified } from '../runs/stamp.js';

const text = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(max)
		.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters');

/** Why a legacy run can't be signed. */const LEGACY = 'a legacy (b023 workbook) run, from before engine 1.0.0 removed that model, is a workbook comparison only, not evidence (audit H1), so it cannot be signed off';

export const SignoffBody = z.object({
	fullName: text(200),
	registrationBody: text(100),
	registrationNo: text(50),
	scope: text(1000),
	/** The ids of the confirmations ticked: all of the statement's must be. */
	confirmed: z.array(z.string().max(40)).max(20),
	/** SHA-256 of the statement the dialog showed (GET …/signoffs `statementSha256`). */
	statementSha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 hex digest')
});

export interface SignoffRow {
	id: string;
	runId: string;
	fullName: string;
	registrationBody: string;
	registrationNo: string;
	scope: string;
	statementVersion: string;
	statementSha256: string;
	disclaimerVersion: string;
	signedAt: string;
	/** The signer is the caller. */
	mine: boolean;
}

const SELECT = `SELECT id, run_id AS "runId", full_name AS "fullName", registration_body AS "registrationBody",
	registration_no AS "registrationNo", scope, statement_version AS "statementVersion",
	statement_sha256 AS "statementSha256", disclaimer_version AS "disclaimerVersion", signed_at AS "signedAt",
	user_id IS NOT DISTINCT FROM app_current_user_id() AS mine
	FROM signoff`;

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The run's statement as the engine builds it, with its hash; 404 for no such run. */
async function statementFor(
	db: Db,
	projectId: string,
	runId: string
): Promise<{ statement: SignoffStatement; sha256: string; legacy: boolean; forecast: boolean; verified: boolean }> {
	if (!UUID.test(runId)) throw new ApiError(404, 'not found');
	const { rows } = await db.query<{ engine_version: string; scenario: boolean; legacy: boolean; forecast: boolean }>(
		`SELECT engine_version, scenario_id IS NOT NULL AS scenario,
			COALESCE(inputs->'settings'->>'runoffModel', 'legacy') = 'legacy' AS legacy,
			"trigger" = 'forecast' AS forecast
		 FROM model_run WHERE project_id = $1 AND id = $2`,
		[projectId, runId]
	);
	const r = rows[0];
	if (!r) throw new ApiError(404, 'not found');
	const statement = signoffStatement({ id: runId, engineVersion: r.engine_version, scenario: r.scenario });
	// Its server stamp (077, runs/stamp.ts): a run written past the model run is never signed.
	const verified = await runVerified(db, runId);
	return { statement, sha256: sha256(signoffStatementText(statement)), legacy: r.legacy, forecast: r.forecast, verified };
}

/** Why a forecast run (WP-2.12) can't be signed off. */
export const FORECAST_NOT_SIGNABLE =
	'a forecast run cannot be signed off: a sign-off is judged on the record, and its last days are modelled on forecast rain; sign an ordinary run of the model';

export const signoffRoutes = new Hono<AuthEnv>()
	.get('/:id/runs/:runId/signoffs', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'viewer');
			const { statement, sha256: statementSha256, legacy, forecast, verified } = await statementFor(db, id, runId);
			const { rows } = await db.query<SignoffRow>(`${SELECT} WHERE project_id = $1 AND run_id = $2 ORDER BY signed_at, id`, [id, runId]);
			return c.json({
				statement,
				statementSha256,
				disclaimer: { version: DISCLAIMER.version, status: DISCLAIMER.status },
				// Why the caller can't sign, or null when they can.
				cannotSign: rank[role] < rank.editor ? 'requires editor role' : legacy ? LEGACY : forecast ? FORECAST_NOT_SIGNABLE : !verified ? RUN_UNVERIFIED : null,
				signoffs: rows
			});
		});
	})
	.post('/:id/runs/:runId/signoffs', async (c) => {
		const { id, runId } = c.req.param();
		const body = SignoffBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Citing a run: not while a trim or delete of this project's runs is under way.
			await lockProjectRuns(db, id);
			const { statement, sha256: expected, legacy, forecast, verified } = await statementFor(db, id, runId);
			if (legacy) throw new ApiError(409, LEGACY);
			// A sign-off is judged on history; a forecast run's tail is modelled on forecast rain (WP-2.12).
			if (forecast) throw new ApiError(409, FORECAST_NOT_SIGNABLE);
			// Only a run the backend stored and signed, whose rows still match (077).
			if (!verified) throw runUnverified();
			if (body.statementSha256 !== expected)
				throw new ApiError(409, 'the sign-off statement has changed since it was shown (a new limitation or wording); read it again and sign the new one');
			const missing = statement.confirmations.filter((k) => !body.confirmed.includes(k.id));
			if (missing.length) throw new ApiError(400, `every statement must be confirmed; missing: ${missing.map((k) => k.id).join(', ')}`);
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO signoff (project_id, run_id, user_id, full_name, registration_body, registration_no, scope, statement_version, statement_sha256, disclaimer_version)
				 VALUES ($1, $2, app_current_user_id(), $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
				[id, runId, body.fullName, body.registrationBody, body.registrationNo, body.scope, statement.version, expected, statement.disclaimerVersion]
			);
			const signoffId = rows[0]!.id;
			await recordAudit(db, id, 'signoff.created', {
				signoffId,
				runId,
				fullName: body.fullName,
				registrationBody: body.registrationBody,
				registrationNo: body.registrationNo,
				statementVersion: statement.version,
				statementSha256: expected
			});
			const { rows: out } = await db.query<SignoffRow>(`${SELECT} WHERE id = $1`, [signoffId]);
			return c.json({ signoff: out[0] }, 201);
		});
	});
