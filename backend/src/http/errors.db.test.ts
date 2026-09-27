// Real Postgres errors reach the caller as a fixed message, never the database's
// own text (CLAUDE.md rule 6): each case throws the genuine pg error from a
// failing statement and checks the response carries none of its words.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { handleError } from './errors.js';

async function respond(userId: string, sql: string) {
	let dbMessage = '';
	const app = new Hono();
	app.onError(handleError);
	app.get('/', () =>
		withUser(userId, async (db) => {
			try {
				await db.query(sql);
			} catch (e) {
				dbMessage = (e as Error).message;
				throw e;
			}
			throw new Error('the statement was expected to fail');
		})
	);
	const r = await app.request('/');
	return { status: r.status, text: await r.text(), dbMessage };
}

describe('database errors in API responses', () => {
	it.each([
		['an unknown table (unhandled)', 'SELECT * FROM no_such_table_for_errors_test', 500, 'no_such_table_for_errors_test'],
		['a syntax error (unhandled)', 'SELEC 1', 500, 'SELEC'],
		['a row RLS refuses to insert', `INSERT INTO project (name) VALUES ('rls probe')`, 403, 'project'],
		['a failed cast', `SELECT 'not-a-uuid'::uuid`, 500, 'not-a-uuid']
	])('%s: a fixed message, none of the database text', async (_, sql, status, word) => {
		const u = await signUp('Errors');
		const r = await respond(u.id, sql);
		expect(r.dbMessage, 'positive control: Postgres really failed').not.toBe('');
		expect(r.status).toBe(status);
		expect(JSON.parse(r.text).error).toMatch(/^(Internal server error|forbidden)$/);
		expect(r.text).not.toContain(r.dbMessage);
		expect(r.text).not.toContain(word);
	});
});
