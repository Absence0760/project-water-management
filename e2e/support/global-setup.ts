// Rebuilds the checkout's isolated e2e database (support/env.ts) from backend/migrations before
// the suite runs: create it if missing, drop + recreate the public schema,
// migrate. Needs local Postgres (`pnpm dev:db:up`).
//
// `pg` and the migrator are the backend's own (resolved from backend/), so
// e2e adds no database dependency of its own.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E2E_DB, OWNER_ADMIN_URL, OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));

interface PgClient {
	connect(): Promise<void>;
	query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
	end(): Promise<void>;
}
type PgModule = { Client: new (opts: { connectionString: string }) => PgClient };

export default async function globalSetup(): Promise<void> {
	const pg = createRequire(`${backendDir}package.json`)('pg') as PgModule;

	const admin = new pg.Client({ connectionString: OWNER_ADMIN_URL });
	try {
		await admin.connect();
	} catch (err) {
		throw new Error(`e2e needs local Postgres on :5434 — run \`pnpm dev:db:up\` first (${(err as Error).message})`);
	}
	try {
		const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [E2E_DB]);
		if (!rowCount) await admin.query(`CREATE DATABASE ${E2E_DB} OWNER water`);
	} finally {
		await admin.end();
	}

	const db = new pg.Client({ connectionString: OWNER_E2E_URL });
	await db.connect();
	try {
		await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO water_app;');
	} finally {
		await db.end();
	}

	const { migrate } = (await import(pathToFileURL(`${backendDir}scripts/migrate.ts`).href)) as {
		migrate: (url: string, log?: (m: string) => void) => Promise<string[]>;
	};
	await migrate(OWNER_E2E_URL, () => {});
}
