// A transaction whose session Postgres ends between two statements
// (idle_in_transaction_session_timeout in production, FATAL 25P03; infra/rds.tf)
// answers an ordinary 500: the checked-out client's 'error' is caught by
// withUser's listener rather than thrown by Node, which would end the process.
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '../http/errors.js';
import { getPool } from './pool.js';
import { withUser } from './tx.js';

afterEach(() => vi.restoreAllMocks());

const USER = '00000000-0000-4000-8000-000000000000';

describe('withUser when the session is ended mid-transaction', () => {
	it('answers 500 and the pool goes on with a fresh connection', async () => {
		const warnings: string[] = [];
		let lost!: () => void;
		const sessionLost = new Promise<void>((resolve) => (lost = resolve));
		vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
			warnings.push(String(line));
			if (String(line).includes('"event":"db_client_lost"')) lost();
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		let pid = 0;
		const app = new Hono()
			.get('/', (c) =>
				withUser(USER, async (db) => {
					pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
					// The production setting, shortened for the test: this transaction is now idle.
					await db.query("SET LOCAL idle_in_transaction_session_timeout = '100ms'");
					await sessionLost;
					await db.query('SELECT 1');
					return c.json({ ok: true });
				})
			)
			.onError(handleError);

		const res = await app.request('/');
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'Internal server error' });
		// Postgres said why: the idle-in-transaction timeout's SQLSTATE.
		expect(warnings.join(' ')).toMatch(/"event":"db_client_lost".*"code":"25P03"/);

		// Positive control: the pool discarded the dead client and serves the next query on a new session.
		const again = (await getPool().query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
		expect(pid).toBeGreaterThan(0);
		expect(again).not.toBe(pid);
	});
});
