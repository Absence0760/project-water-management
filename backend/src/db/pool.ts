import pg from 'pg';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';

// Return DATE columns as ISO strings, not JS Dates in the server's timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

let pool: pg.Pool | undefined;

/** Lazily-created pool, connected as the RLS-bound app role (DATABASE_URL). */
export function getPool(): pg.Pool {
	if (!pool) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error('DATABASE_URL is not set');
		// Lambda: one container serves one request at a time, so a tiny pool.
		pool = new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 5) });
		// An idle client whose connection drops (Postgres restarts, an RDS
		// failover, a terminated backend) emits 'error' on the pool. With no
		// listener Node throws it and the whole process exits; the pool has
		// already discarded that client and opens a new one on the next query.
		// Name and SQLSTATE only (safeError): a pg message can carry row values.
		pool.on('error', (err) => logEvent('warn', { event: 'db_idle_client_error', ...safeError(err) }));
	}
	return pool;
}

export async function closePool(): Promise<void> {
	await pool?.end();
	pool = undefined;
}
