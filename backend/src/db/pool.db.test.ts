// The app's pool survives a connection dropped while idle: Postgres restarting,
// an RDS failover or a terminated backend makes the pool emit 'error', which
// without a listener throws and ends the process (it took down `pnpm dev`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner } from '../__tests__/helpers.js';
import { getPool } from './pool.js';

afterEach(() => vi.restoreAllMocks());

describe('the database pool', () => {
	it('logs an idle connection that drops, and the next query gets a fresh one', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const pool = getPool();
		const client = await pool.connect();
		const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
		client.release();

		const dropped = new Promise((resolve) => pool.once('error', resolve));
		// Positive control: the backend was there to terminate.
		expect(await asOwner('SELECT pg_terminate_backend($1) AS done', [pid])).toEqual([{ done: true }]);
		await dropped;

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"db_idle_client_error"'));
		expect(warn.mock.calls.flat().join(' ')).toMatch(/"code":"57P01"/);
		const again = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
		expect(again).not.toBe(pid);
	});
});
