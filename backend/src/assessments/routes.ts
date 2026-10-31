// Cumulative impact assessments (roadmap WP-3.11, docs/api.md § Assessments,
// 145_assessment.sql).
//
//   POST /projects/:id/assessments            editor   check the scenarios combine; write the assessment and queue its job (202 { assessment, jobId, job }),
//                                                      or with dryRun only check (200 { check }); 422 { details: { conflicts, problems } } when they don't combine
//   GET  /projects/:id/assessments            editor   the project's assessments, newest first, without their reports
//   GET  /projects/:id/assessments/backgrounds?baseRunId=   editor   the runs that can be an assessment's background at full
//                                                      allocation on that baseline (295, background.ts), newest first
//   GET  /projects/:id/assessments/:aid       editor   one assessment with its cumulative report and its applications'
//                                                      "Ask the assessors why" questions and answers (issue #523 G7)
//
// Editors only: an assessment names submitted applications, which neither
// contributors nor viewers read (045). The optional background at full
// allocation (`backgroundRunId`, 295) is a second, labelled row set beside the
// baseline's, never the baseline (licences never drive the baseline, #507); a
// reader kept from the registered volumes reads its verdicts only (D3). Status and progress of the job: the
// assessment's `job`, or GET /projects/:id/jobs (WP-2.8).
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
import { allocationUnitsHidden } from '../allocations/viewerUnits.js';
import { requireRole, UUID } from '../projects/access.js';
import { assessorQuestionsOf } from '../scenarios/questions.js';
import { backgroundVerdicts, listBackgroundRuns } from './background.js';
import { ASSESSMENT_JOBS_PER_USER, CreateAssessmentBody } from './schema.js';
import { createAssessment, getAssessment, listAssessments, pendingAssessmentJobs } from './store.js';

export const assessmentRoutes = new Hono<AuthEnv>()
	.post('/:id/assessments', async (c) => {
		const body = CreateAssessmentBody.parse(await readJson(c));
		const id = c.req.param('id');
		const out = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!body.dryRun) {
				const pending = await pendingAssessmentJobs(db);
				if (pending >= ASSESSMENT_JOBS_PER_USER) throw new ApiError(429, `you already have ${pending} assessments queued or running; wait for one to finish`);
			}
			return createAssessment(db, id, body);
		});
		if (!out.assessment || !out.job) return c.json({ check: out.check });
		await wakeWorker(out.job.id);
		return c.json({ assessment: out.assessment, jobId: out.job.id, job: out.job }, 202);
	})
	.get('/:id/assessments', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'editor');
			return c.json({ assessments: await listAssessments(db, c.req.param('id')) });
		})
	)
	// Before /:aid, which would take "backgrounds" for an id.
	.get('/:id/assessments/backgrounds', async (c) => {
		const baseRunId = c.req.query('baseRunId') ?? '';
		if (!UUID.test(baseRunId)) throw new ApiError(400, 'baseRunId must be a run id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'editor');
			return c.json({ runs: await listBackgroundRuns(db, c.req.param('id'), baseRunId) });
		});
	})
	.get('/:id/assessments/:aid', async (c) => {
		const aid = c.req.param('aid');
		if (!UUID.test(aid)) throw new ApiError(404, 'not found');
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, c.req.param('id'), 'editor');
			const found = await getAssessment(db, c.req.param('id'), aid);
			if (!found) throw new ApiError(404, 'not found');
			// The background is a full-allocation run's table: verdicts only for a reader kept from the volumes (D3; 218's render).
			const assessment = (await allocationUnitsHidden(db, c.req.param('id'), role)) ? { ...found, report: backgroundVerdicts(found.report) } : found;
			// The applicants' "Ask the assessors why" questions on its applications, with the answers: exported with
			// the matrix as the applications' record for the authority's s42 written reasons (issue #523 G7).
			const ids = assessment.members.map((m) => m.scenarioId).filter((s): s is string => s !== null);
			return c.json({ assessment: { ...assessment, questions: await assessorQuestionsOf(db, c.req.param('id'), ids) } });
		});
	});
