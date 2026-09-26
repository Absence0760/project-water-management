import type pg from 'pg';
import { getPool } from './pool.js';

export type Db = pg.PoolClient;

/**
 * Run `fn` in a transaction scoped to `userId`. Sets `app.current_user_id`
 * with is_local=true, so it is cleared at COMMIT/ROLLBACK and can never leak
 * to the next request that borrows this pooled connection. Every RLS policy
 * keys on this setting — all project-scoped queries must go through here.
 *
 * Also sets `app.change_set_id` to a fresh UUID: every history row the
 * transaction writes (model_revision, series_revision, audit_event;
 * 030_history.sql) defaults its change_set to it, so one request's rows group
 * together in the History tab.
 */
export async function withUser<T>(userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
	return inTransaction(async (db) => {
		await db.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.change_set_id', $2, true)", [
			userId,
			crypto.randomUUID()
		]);
		return fn(db);
	});
}

/**
 * Run `fn` in a transaction acting as the API key `keyId` (038_api_keys.sql,
 * the ingest endpoint): sets `app.current_api_key_id`, transaction-local like
 * withUser's setting, and **no** user id. The key's RLS policies then let it
 * read and write its own project's (allowed) series and add audit events
 * naming itself; every other policy needs a user, so the key sees nothing
 * else. `app_api_key_project` re-checks the key (live, in scope) on every
 * statement, so a revocation applies to the next request. Also sets a fresh
 * `app.change_set_id`, as withUser does.
 */
export async function withApiKey<T>(keyId: string, fn: (db: Db) => Promise<T>): Promise<T> {
	return inTransaction(async (db) => {
		await db.query("SELECT set_config('app.current_api_key_id', $1, true), set_config('app.change_set_id', $2, true)", [
			keyId,
			crypto.randomUUID()
		]);
		return fn(db);
	});
}

/**
 * Transaction with no user context: app_user lookups during auth, and the job
 * queue's cross-project SECURITY DEFINER calls (claim, failed finish, purge,
 * stats; jobs/runner.ts). Project data is never read here: RLS shows nothing.
 */
export async function withoutUser<T>(fn: (db: Db) => Promise<T>): Promise<T> {
	return inTransaction(fn);
}

async function inTransaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}
