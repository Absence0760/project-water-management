// Per-project API keys and the ingest endpoint (roadmap WP-2.9, docs/api.md §
// Ingest, docs/security.md § API keys).
//
// Owners list, create and revoke keys under /projects/:id/api-keys (RLS in
// 039_api_keys.sql enforces the same). The ingest routes under /ingest/v1 have
// no session: the key is the credential (ingest/auth.ts), and the work runs in
// withApiKey, where RLS lets the key write its own project's (allowed) series
// and nothing else.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withApiKey, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { mergeInto, SeriesBody } from '../series/merge.js';
import { wakeForRerun } from '../series/routes.js';
import { type IngestEnv, requireApiKey, requireScope } from './auth.js';
import { type ApiKeyRow, CreateKeyBody, IngestExtras, keyAllows, newApiKey, SELECT_KEYS, toApiKey } from './keys.js';

/** A new key's prefix (8 hex characters of its id) is unique across projects; a clash is a fresh id, a few times at most. */
const CREATE_TRIES = 3;
const PG_UNIQUE = '23505';

/** GET/POST /projects/:id/api-keys, DELETE /projects/:id/api-keys/:keyId (owner). */
export const apiKeyRoutes = new Hono<AuthEnv>()
	.get('/:id/api-keys', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'owner');
			const { rows } = await db.query<ApiKeyRow>(`${SELECT_KEYS} WHERE k.project_id = $1 ORDER BY k.created_at DESC, k.id`, [id]);
			return c.json({ keys: rows.map(toApiKey) });
		})
	)
	.post('/:id/api-keys', async (c) => {
		const body = CreateKeyBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const scopes = body.scopes ?? ['series:write'];
			for (let attempt = 1; ; attempt++) {
				const keyId = crypto.randomUUID();
				const { key, prefix, hash } = newApiKey(keyId);
				await db.query('SAVEPOINT api_key_insert');
				try {
					await db.query(
						`INSERT INTO api_key (id, project_id, name, key_hash, scopes, allowed_series, created_by, expires_at)
						 VALUES ($1, $2, $3, $4, $5, $6, app_current_user_id(), CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END)`,
						[keyId, id, body.name, hash, scopes, body.allowedSeries === null ? null : JSON.stringify(body.allowedSeries), body.expiresInDays ?? null]
					);
				} catch (err) {
					await db.query('ROLLBACK TO SAVEPOINT api_key_insert');
					if ((err as { code?: string }).code === PG_UNIQUE && attempt < CREATE_TRIES) continue;
					throw err;
				}
				const { rows } = await db.query<ApiKeyRow>(`${SELECT_KEYS} WHERE k.id = $1`, [keyId]);
				// Never the key or its hash: the log says which key, what it may do and for how long.
				await recordAudit(db, id, 'api_key.created', {
					keyId,
					name: body.name,
					prefix,
					scopes,
					allowedSeries: body.allowedSeries,
					expiresInDays: body.expiresInDays ?? null
				});
				c.header('Cache-Control', 'no-store');
				// The only time the key leaves the server: it isn't stored, so it can't be shown again.
				return c.json({ key: toApiKey(rows[0]!), secret: key }, 201);
			}
		});
	})
	.delete('/:id/api-keys/:keyId', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { id, keyId } = c.req.param();
			await requireRole(db, id, 'owner');
			if (!UUID.test(keyId)) throw new ApiError(404, 'not found');
			const { rows: revoked } = await db.query<{ name: string; prefix: string }>(
				`UPDATE api_key SET revoked_at = now(), revoked_by = app_current_user_id()
				 WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING name, prefix`,
				[keyId, id]
			);
			if (revoked[0]) await recordAudit(db, id, 'api_key.revoked', { keyId, name: revoked[0].name, prefix: revoked[0].prefix });
			else {
				// Already revoked is done; not this project's key is not found.
				const { rows } = await db.query('SELECT 1 FROM api_key WHERE id = $1 AND project_id = $2', [keyId, id]);
				if (!rows[0]) throw new ApiError(404, 'not found');
			}
			return c.body(null, 204);
		})
	);

/** GET /ingest/v1/whoami and POST /ingest/v1/series/merge: the API key is the credential. */
export const ingestRoutes = new Hono<IngestEnv>()
	.use('*', requireApiKey)
	.get('/v1/whoami', (c) => {
		const key = c.get('apiKey');
		c.header('Cache-Control', 'no-store');
		return c.json({
			project: { id: key.projectId, name: key.projectName },
			key: { id: key.id, name: key.name, scopes: key.scopes, allowedSeries: key.allowedSeries }
		});
	})
	// Merge days into one of the key's project's series: the body of POST
	// /projects/:id/series/merge, plus an optional `source` label, through the
	// same sequence (series/merge.ts mergeInto). Idempotent: re-sending the
	// same days changes nothing and records nothing.
	.post('/v1/series/merge', async (c) => {
		const key = requireScope(c, 'series:write');
		const raw = await readJson(c);
		const { source } = IngestExtras.parse(raw);
		const body = SeriesBody.parse(raw);
		// Checked here for a clear 403; the time_series policies check it again (app_api_key_allows).
		if (!keyAllows(key.allowedSeries, body.kind, body.name)) throw new ApiError(403, 'this key may not write that series');
		// via 'api_key': the new-data hook queues the project's automatic re-run as the key's creator (042_auto_rerun.sql).
		const r = await withApiKey(key.id, (db) => mergeInto(db, key.projectId, body, { keepRevision: false, via: 'api_key', audit: source ? { source } : {} }));
		await wakeForRerun(r.rerun);
		c.header('Cache-Control', 'no-store');
		// rerunHeld: the pushed days the data-quality rules flag; the automatic re-run waits for a person (series/hold.ts).
		return c.json({ series: r.meta, daysChanged: r.daysChanged, rerunQueuedFor: r.rerunQueuedFor, rerunHeld: r.held });
	});
