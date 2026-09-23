// Rebuilds the water_test database schema from backend/migrations before the
// DB test project runs. Needs local Postgres: `pnpm dev:db:up`.
import pg from 'pg';
import { migrate } from '../../scripts/migrate.js';

export default async function setup() {
	const url = process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgresql://water:water@127.0.0.1:5434/water_test';
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
