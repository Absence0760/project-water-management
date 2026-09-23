import pg from 'pg';

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
	}
	return pool;
}

export async function closePool(): Promise<void> {
	await pool?.end();
	pool = undefined;
}
