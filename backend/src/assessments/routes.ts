// Cumulative impact assessments (roadmap WP-3.11, docs/api.md § Assessments,
// 145_assessment.sql).
//
//   POST /projects/:id/assessments            editor   check the scenarios combine; write the assessment and queue its job (202 { assessment, jobId, job }),
//                                                      or with dryRun only check (200 { check }); 422 { details: { conflicts, problems } } when they don't combine
//   GET  /projects/:id/assessments            editor   the project's assessments, newest first, without their reports
//   GET  /projects/:id/assessments/:aid       editor   one assessment with its cumulative report
//
// Editors only: an assessment names submitted applications, which neither
// contributors nor viewers read (045). Status and progress of the job: the
// assessment's `job`, or GET /projects/:id/jobs (WP-2.8).
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
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
	.get('/:id/assessments/:aid', async (c) => {
		const aid = c.req.param('aid');
		if (!UUID.test(aid)) throw new ApiError(404, 'not found');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'editor');
			const assessment = await getAssessment(db, c.req.param('id'), aid);
			if (!assessment) throw new ApiError(404, 'not found');
			return c.json({ assessment });
		});
	});
