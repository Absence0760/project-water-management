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
 *
 * `readOnly`: a READ ONLY transaction at REPEATABLE READ, so every statement
 * sees one snapshot of the database. A model run reads its inputs this way
 * (runs/execute.ts runOutsideTransaction): the settings, model and series it
 * loads are consistent with each other however many queries that takes.
 */
export async function withUser<T>(userId: string, fn: (db: Db) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
	return inTransaction(async (db) => {
		await db.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.change_set_id', $2, true)", [
			userId,
			crypto.randomUUID()
		]);
		return fn(db);
	}, opts.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
}

/**
 * Run `fn` in a transaction acting as the API key `keyId` (039_api_keys.sql,
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
 * Inside a withoutUser transaction, act as `userId` from here on: for the
 * few auth flows whose identity is proven mid-transaction, by a consumed
 * email token (verify, reset) or by the account the sign-up just created
 * (068_app_user_rls.sql). Only ever with an id such a proof returned, never
 * one from a request.
 */
export async function actAsUser(db: Db, userId: string): Promise<void> {
	await db.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
}

/**
 * Transaction with no user context: pre-sign-in auth (through the SECURITY
 * DEFINER lookups of 068_app_user_rls.sql; app_user shows no row here), and the job
 * queue's cross-project SECURITY DEFINER calls (claim, failed finish, purge,
 * stats; jobs/runner.ts). Project data is never read here: RLS shows nothing.
 */
export async function withoutUser<T>(fn: (db: Db) => Promise<T>): Promise<T> {
	return inTransaction(fn);
}

/**
 * One statement with no user context, on its own (autocommit), for a
 * single-row auth lookup that runs on every request (auth/session.ts). A
 * lone statement is already atomic, so wrapping it in withoutUser only adds
 * the BEGIN and COMMIT round trips: 3 trips instead of 1, on every
 * authenticated request (issue #41). RLS sees no user, as in withoutUser.
 */
export async function queryWithoutUser<R extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<R[]> {
	return (await getPool().query<R>(text, values)).rows;
}

async function inTransaction<T>(fn: (db: Db) => Promise<T>, begin = 'BEGIN'): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query(begin);
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
