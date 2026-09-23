import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { loadModel, saveModel } from './store.js';
import { ModelBody, modelProblems } from './validate.js';

export const modelRoutes = new Hono<AuthEnv>()
	.get('/:id/model', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json(await loadModel(db, c.req.param('id')));
		})
	)
	.put('/:id/model', async (c) => {
		const model = ModelBody.parse(await c.req.json());
		const problems = modelProblems(model);
		if (problems.length) throw new ApiError(400, 'invalid model', problems);
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			await saveModel(db, id, model);
			return c.json(await loadModel(db, id));
		});
	});
