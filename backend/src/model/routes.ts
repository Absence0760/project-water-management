import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { beginModelChange, Reason, recordDroppedLinks, recordModelRevision } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { loadModel, saveModel } from './store.js';
import { ModelBody, modelProblems } from './validate.js';
import { readJson } from '../http/body.js';

export const modelRoutes = new Hono<AuthEnv>()
	.get('/:id/model', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json(await loadModel(db, c.req.param('id')));
		})
	)
	// The body is the model document, plus an optional `reason` for the change
	// (the save bar's "Reason for this change"), kept with its revision.
	.put('/:id/model', async (c) => {
		const raw = await readJson(c);
		const model = ModelBody.parse(raw);
		const reason = Reason.parse((raw as { reason?: unknown } | null)?.reason);
		const problems = modelProblems(model);
		if (problems.length) throw new ApiError(400, 'invalid model', problems);
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const change = await beginModelChange(db, id);
			await saveModel(db, id, model);
			// Same transaction: the save and its history commit together.
			await recordDroppedLinks(db, id, change, 'model_saved');
			await recordModelRevision(db, id, { source: 'model_put', before: change.before, reason });
			return c.json(await loadModel(db, id));
		});
	});
