// Rebuilds the checkout's test database (water_test, or water_test_w<n> in a worktree; test-db.ts) schema from backend/migrations before the
// DB test project runs. Needs local Postgres: `pnpm dev:db:up`.
import pg from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { OWNER_URL } from './test-db.js';

export default async function setup() {
	const url = process.env.TEST_MIGRATION_DATABASE_URL ?? OWNER_URL;
	// Create a per-checkout test database on first use (water_test_<name>).
	const dbName = new URL(url).pathname.slice(1);
	if (!/^water_test(_[a-z0-9_]+)?$/.test(dbName)) throw new Error(`not a test database: ${dbName}`);
	const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/water') });
	try {
		await admin.connect();
		const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
		if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	} catch (err) {
		throw new Error(`DB tests need local Postgres — run \`pnpm dev:db:up\` (${(err as Error).message})`);
	} finally {
		await admin.end().catch(() => {});
	}
	const client = new pg.Client({ connectionString: url });
	try {
		await client.connect();
	} catch (err) {
		throw new Error(`DB tests need local Postgres — run \`pnpm dev:db:up\` (${(err as Error).message})`);
	}
	await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO water_app;');
	await client.end();
	await migrate(url, () => {});
}
