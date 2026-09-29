// Automated calibration run by the server (issue #153, docs/api.md
// § Automated calibration, 108_auto_calibration.sql).
//
//   POST /projects/:id/auto-calibrations                 editor  plan a run of the saved rules and queue its first case (202 { calibration, jobId, job })
//   GET  /projects/:id/auto-calibrations                 viewer  the project's runs of the rules, newest first
//   GET  /projects/:id/auto-calibrations/:cid            viewer  one run, every case with its score and why it was or wasn't kept
//   POST /projects/:id/auto-calibrations/:cid/apply      editor  write the kept fit into the settings, make a run with it and (after.ensemble) queue its ensemble
//
// Planning and the run an apply makes compute with no transaction open
// (docs/architecture.md § A model run); each case is a job.
import { resolveCalibrationRules, type AutoCalibrationPlan } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
import { runLiveModel, trimRuns } from '../runs/execute.js';
import { runModelInput } from '../runs/uncertainty.js';
import { AUTO_CALIBRATION_JOBS_PER_USER } from './schema.js';
import {
	appliedRunLabel,
	applyCalibration,
	CalibrationRefused,
	calibrationInput,
	getCalibration,
	inputSha256,
	insertCalibration,
	listCalibrations,
	pendingCalibrationJobs,
	planCalibration,
	recordAppliedRun,
	startCalibrationEnsemble
} from './store.js';

/** Both writes take no options: the saved rules decide everything. */
const NoBody = z.object({}).strict();

const calibrationId = (raw: string) => {
	if (!UUID.test(raw)) throw new ApiError(404, 'not found');
	return raw;
};

export const autoCalibrationRoutes = new Hono<AuthEnv>()
	.post('/:id/auto-calibrations', async (c) => {
		NoBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const input = await withUser(
			userId,
			async (db) => {
				await requireRole(db, id, 'editor');
				return calibrationInput(db, id);
			},
			{ readOnly: true }
		);
		let plan: AutoCalibrationPlan;
		try {
			plan = planCalibration(input);
		} catch (err) {
			if (err instanceof CalibrationRefused) throw new ApiError(400, `the calibration rules can't run: ${err.message}`);
			throw err;
		}
		const rules = resolveCalibrationRules(input.settings.calibrationRules, []);
		const { calibration, job } = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			const pending = await pendingCalibrationJobs(db);
			if (pending >= AUTO_CALIBRATION_JOBS_PER_USER) throw new ApiError(429, 'you already have an automated calibration queued or running; wait for it to finish');
			// The case jobs refuse an input that changed since this plan, so the plan's own hash is the one stored.
			return insertCalibration(db, id, { trigger: 'manual', rules, plan, inputSha256: inputSha256(input) });
		});
		await wakeWorker(job.id);
		return c.json({ calibration, jobId: job.id, job }, 202);
	})
	.get('/:id/auto-calibrations', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ calibrations: await listCalibrations(db, c.req.param('id')) });
		})
	)
	.get('/:id/auto-calibrations/:cid', async (c) => {
		const cid = calibrationId(c.req.param('cid'));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const calibration = await getCalibration(db, c.req.param('id'), cid);
			if (!calibration) throw new ApiError(404, 'not found');
			return c.json({ calibration });
		});
	})
	.post('/:id/auto-calibrations/:cid/apply', async (c) => {
		NoBody.parse(await readJson(c));
		const id = c.req.param('id');
		const cid = calibrationId(c.req.param('cid'));
		const userId = c.get('userId');
		const applied = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			await applyCalibration(db, id, cid);
			return (await getCalibration(db, id, cid))!;
		});
		// The run with the applied fit (and its ensemble), with no transaction open while the engine runs.
		let runId: string | null = null;
		let uncertaintyId: string | null = null;
		let jobId: string | null = null;
		let runError: string | null = null;
		try {
			({ runId, uncertaintyId, jobId } = await runLiveModel(userId, id, appliedRunLabel(applied.rulesRevision), 'manual', async (db, run) => {
				await trimRuns(db, id);
				if (!applied.rules.after.ensemble) {
					await recordAppliedRun(db, cid, run.id);
					return { runId: run.id, uncertaintyId: null, jobId: null };
				}
				return { runId: run.id, ...(await startCalibrationEnsemble(db, id, cid, run.id, await runModelInput(db, id, run.id))) };
			}));
		} catch (err) {
			// The fit is applied either way; say why no run followed (the engine's words, never DB text).
			if (err instanceof ApiError) runError = err.message;
			else if (err instanceof Error && !(err as { code?: string }).code) runError = `model run failed: ${err.message}`;
			else throw err;
		}
		if (jobId) await wakeWorker(jobId);
		return c.json({ calibration: await withUser(userId, async (db) => getCalibration(db, id, cid)), runId, uncertaintyId, runError });
	});
