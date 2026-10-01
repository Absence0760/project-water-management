// "Ask the assessors why" (164_applicant_visibility, build item 6;
// docs/scenarios.md § Applications, docs/api.md § Applications). A rule an
// application breaks because of data its applicant can't see reads only
// MASKED_RULE (or, past FARMER_K hidden holders, the catchment's aggregate),
// and such an application can't be submitted. The assessors never read a
// draft, so a note on it would reach no one: the applicant's question goes to
// application_question instead, with the line as they read it, the ops it
// names, the rules' kinds and the line in its real words, which the server
// computed (the check's assessorProblems) and the applicant never reads back.
// The editors read and answer it, once; the authority decides what its answer
// discloses (provisional position, pre-counsel research, 2026-10-01).
//
//  POST /projects/:id/scenarios/:sid/questions            a party asks about one problem line
//  GET  /projects/:id/scenarios/:sid/questions            the parties' view (never the real words)
//  GET  /projects/:id/application-questions               the editors' list, every application's
//  POST /projects/:id/application-questions/:qid/answer   an editor answers, once
import type { ScenarioOp } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { checkScenario, hiddenHolders, loadBaseInput, loadScenario } from './execute.js';

/** Most questions one application may hold: a cap on what an applicant can write, not a quota anyone should meet. */
export const QUESTIONS_PER_APPLICATION_MAX = 50;
/** An answer's longest (the table's CHECK). */
export const ANSWER_MAX = 4000;

export const AskBody = z
	.object({
		/** The problem line's index in the check's `problems`. */
		problem: z.number().int().min(0).max(10_000),
		/** The line as the applicant's check showed it: the ask is refused when the check has changed since. */
		line: z.string().min(1).max(4000)
	})
	.strict();

export const AnswerBody = z
	.object({
		answer: z.string().trim().min(1, 'an answer needs some text').max(ANSWER_MAX)
	})
	.strict();

/** A question as an application's parties read it (app_application_questions): never the real words or the ops. */
export interface PartyQuestion {
	id: string;
	askedAt: string;
	problem: string;
	opIndexes: number[];
	rules: string[];
	answer: string | null;
	answeredAt: string | null;
}

/** A question as the assessors read it. */
export interface AssessorQuestion extends PartyQuestion {
	scenarioId: string;
	scenarioName: string;
	ops: ScenarioOp[];
	assessorText: string;
}

const notFound = () => new ApiError(404, 'not found');

async function partyQuestions(db: Db, scenarioId: string): Promise<PartyQuestion[]> {
	const { rows } = await db.query<PartyQuestion>(
		`SELECT id, asked_at AS "askedAt", problem, op_indexes AS "opIndexes", rules, answer, answered_at AS "answeredAt"
		 FROM app_application_questions($1)`,
		[scenarioId]
	);
	return rows;
}

const ASSESSOR_SELECT = `SELECT id, scenario_id AS "scenarioId", scenario_name AS "scenarioName", asked_at AS "askedAt", problem,
	op_indexes AS "opIndexes", ops, rules, assessor_text AS "assessorText", answer, answered_at AS "answeredAt"
	FROM application_question`;

async function isParty(db: Db, scenarioId: string): Promise<boolean> {
	const { rows } = await db.query<{ party: boolean }>('SELECT app_scenario_party($1) AS party', [scenarioId]);
	return !!rows[0]?.party;
}

export const questionRoutes = new Hono<AuthEnv>()
	.post('/:id/scenarios/:sid/questions', async (c) => {
		const { id, sid } = c.req.param();
		const body = AskBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			if (!UUID.test(sid)) throw notFound();
			const s = await loadScenario(db, id, sid);
			if (s.origin !== 'applicant') throw new ApiError(409, 'only an application has rules hidden from its applicant to ask about');
			if (!(await isParty(db, s.id))) throw new ApiError(403, "only the application's applicant and the people they share it with ask the assessors about it");
			const base = await loadBaseInput(db, id, s.baseRunId, role);
			const check = checkScenario(base, s, await hiddenHolders(db, s));
			if (check.problems[body.problem] !== body.line)
				throw new ApiError(409, 'the check has changed since you read it: read the application again, then ask');
			const ref = check.maskedRules.find((m) => m.problem === body.problem);
			if (!ref) throw new ApiError(422, 'that line gives its rule in full; there is nothing hidden to ask the assessors about');
			const { rows: count } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app_application_questions($1)', [s.id]);
			if ((count[0]?.n ?? 0) >= QUESTIONS_PER_APPLICATION_MAX)
				throw new ApiError(409, `an application holds at most ${QUESTIONS_PER_APPLICATION_MAX} questions`);
			const { rows: asked } = await db.query<{ id: string }>('SELECT app_ask_assessors($1, $2, $3, $4::jsonb, $5, $6) AS id', [
				s.id,
				body.line,
				ref.ops,
				JSON.stringify(ref.ops.map((i) => s.ops[i]).filter((op) => op !== undefined)),
				ref.rules,
				check.assessorProblems[body.problem] ?? body.line
			]);
			const questionId = asked[0]!.id;
			// Ids and the rules' kinds only: the history is read by every viewer.
			await recordAudit(db, id, 'application.question_asked', { scenarioId: s.id, questionId, application: true, ops: ref.ops, rules: ref.rules });
			const question = (await partyQuestions(db, s.id)).find((q) => q.id === questionId)!;
			return c.json({ question }, 201);
		});
	})
	.get('/:id/scenarios/:sid/questions', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'contributor');
				if (!UUID.test(sid)) throw notFound();
				// The assessors read the table (every line in its real words); the parties through the definer function; anyone else 404.
				const { rows: assessor } = await db.query<{ editor: boolean }>(`SELECT app_has_role($1, 'editor') AS editor`, [id]);
				if (assessor[0]?.editor) {
					const { rows } = await db.query<AssessorQuestion>(`${ASSESSOR_SELECT} WHERE project_id = $1 AND scenario_id = $2 ORDER BY asked_at DESC, id`, [id, sid]);
					return c.json({ questions: rows });
				}
				const { rows: sc } = await db.query('SELECT 1 FROM scenario WHERE project_id = $1 AND id = $2', [id, sid]);
				if (!sc.length || !(await isParty(db, sid))) throw notFound();
				return c.json({ questions: await partyQuestions(db, sid) });
			},
			{ readOnly: true }
		);
	})
	.get('/:id/application-questions', async (c) => {
		const id = c.req.param('id');
		return withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'editor');
				// Unanswered first, then the newest: the assessors' queue.
				const { rows } = await db.query<AssessorQuestion>(
					`${ASSESSOR_SELECT} WHERE project_id = $1 ORDER BY answer IS NOT NULL, asked_at DESC, id LIMIT 200`,
					[id]
				);
				return c.json({ questions: rows });
			},
			{ readOnly: true }
		);
	})
	.post('/:id/application-questions/:qid/answer', async (c) => {
		const { id, qid } = c.req.param();
		const body = AnswerBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(qid)) throw notFound();
			const { rows: done } = await db.query<{ result: 'answered' | 'already' | 'none' }>('SELECT app_answer_assessors_question($1, $2, $3) AS result', [id, qid, body.answer]);
			if (done[0]?.result === 'already') throw new ApiError(409, 'this question is answered already; an answer is given once');
			if (done[0]?.result !== 'answered') throw notFound();
			const { rows } = await db.query<{ scenarioId: string }>('SELECT scenario_id AS "scenarioId" FROM application_question WHERE project_id = $1 AND id = $2', [id, qid]);
			await recordAudit(db, id, 'application.question_answered', { scenarioId: rows[0]!.scenarioId, questionId: qid, application: true });
			const { rows: q } = await db.query<AssessorQuestion>(`${ASSESSOR_SELECT} WHERE project_id = $1 AND id = $2`, [id, qid]);
			return c.json({ question: q[0] });
		});
	});
