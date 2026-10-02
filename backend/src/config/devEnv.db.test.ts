// ensureDevDb (config/devEnv.ts): a worktree's first `pnpm dev` creates its
// dev database, and a second call (or a racing process) is a no-op.
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDevDb } from './devEnv.js';

const name = `water_devenv_${process.pid}`;
const url = () => {
	const u = new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
	u.pathname = `/${name}`;
	return u.toString();
};
const admin = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
	const u = new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
	u.pathname = '/water';
	const c = new pg.Client({ connectionString: u.toString() });
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.end();
	}
};

afterAll(() => admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}"`)));

describe('ensureDevDb', () => {
	it('creates the database once, owned by water, and then leaves it', async () => {
		expect(await ensureDevDb(url())).toBe(true);
		const { rows } = await admin((c) =>
			c.query<{ owner: string }>('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [name])
		);
		expect(rows).toEqual([{ owner: 'water' }]);
		expect(await ensureDevDb(url())).toBe(false);
	});

	it('two at once both succeed (`pnpm dev` and `pnpm dev:db:migrate` in a new worktree)', async () => {
		await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}"`));
		const results = await Promise.all([ensureDevDb(url()), ensureDevDb(url())]);
		expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
		const { rowCount } = await admin((c) => c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]));
		expect(rowCount).toBe(1);
	});

	it('never creates `water` itself or a database on another host', async () => {
		const u = new URL(url());
		u.pathname = '/water';
		expect(await ensureDevDb(u.toString())).toBe(false);
		expect(await ensureDevDb('postgresql://water:water@db.example.org:5432/water_w3')).toBe(false);
	});
});
