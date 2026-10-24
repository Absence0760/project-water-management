import pg from 'pg';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';

// Return DATE columns as ISO strings, not JS Dates in the server's timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

let pool: pg.Pool | undefined;

/** The pool's size when DB_POOL_MAX is unset: local dev and the tests. */
export const DEFAULT_POOL_MAX = 5;

/**
 * The pool's size from DB_POOL_MAX. Unset is DEFAULT_POOL_MAX; Terraform sets
 * 2 for the API and the worker, whose containers serve one request or job at
 * a time, and their caps × 2 are what the database's connections are sized
 * on (infra/README.md § Connections, issue #541). Anything but a whole number
 * of at least 1 throws: `Number('')` would be 0 and `Number('two')` NaN,
 * either a pool that quietly misbehaves instead of a clear start-up error.
 */
export function poolMax(value: string | undefined = process.env.DB_POOL_MAX): number {
	if (value === undefined || value.trim() === '') return DEFAULT_POOL_MAX;
	const n = Number(value.trim());
	if (!Number.isInteger(n) || n < 1) throw new Error('DB_POOL_MAX must be a whole number of at least 1');
	return n;
}

/** Lazily-created pool, connected as the RLS-bound app role (DATABASE_URL). */
export function getPool(): pg.Pool {
	if (!pool) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error('DATABASE_URL is not set');
		// Lambda: one container serves one request at a time, so a tiny pool.
		pool = new pg.Pool({ connectionString, max: poolMax(), connectionTimeoutMillis: acquireTimeoutMs() });
		// An idle client whose connection drops (Postgres restarts, an RDS
		// failover, a terminated backend) emits 'error' on the pool. With no
		// listener Node throws it and the whole process exits; the pool has
		// already discarded that client and opens a new one on the next query.
		// Name and SQLSTATE only (safeError): a pg message can carry row values.
		pool.on('error', (err) => logEvent('warn', { event: 'db_idle_client_error', ...safeError(err) }));
	}
	return pool;
}

/**
 * How long a query waits for a free pooled connection. In Lambda a container
 * serves one request at a time and every request path holds at most one
 * connection (docs/architecture.md § Connections per request), so a wait
 * means a path that nests transactions past the pool of 2: fail it in 10 s,
 * logged and counted by the errors alarm, rather than hang until the 30 s
 * timeout with the container billed and busy. Off Lambda (dev, tests, the
 * local worker) it waits as pg does by default (0, for ever), since there
 * many requests share one pool and a wait is load, not a bug.
 */
export function acquireTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	return env.AWS_LAMBDA_FUNCTION_NAME ? 10_000 : 0;
}

export async function closePool(): Promise<void> {
	await pool?.end();
	pool = undefined;
}
