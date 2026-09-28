// The migration runner against Postgres (scripts/migrate.ts): checksums,
// the forward-only refusals, backfilling pre-checksum rows, and the
// per-migration timeouts. Each test builds its own migrations in a temp
// directory and runs them on a scratch database of its own
// (<test db>_migrate), never the real migrations or the shared test schema.
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checksumOf, migrate } from '../../scripts/migrate.js';
import { OWNER_URL, TEST_DB } from '../__tests__/test-db.js';

const SCRATCH = `${TEST_DB}_migrate`;
const ADMIN_URL = OWNER_URL.replace(/\/[^/]+$/, '/water');
const URL_ = OWNER_URL.replace(/\/[^/]+$/, `/${SCRATCH}`);
const quiet = () => {};

let db: pg.Client;
let dir: string;

async function write(name: string, sql: string) {
	await writeFile(join(dir, name), sql);
}

async function rows() {
	return (await db.query<{ name: string; checksum: string | null }>('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows;
}

async function tables() {
	return (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1")).rows.map((r) => r.t);
}

beforeAll(async () => {
	const admin = new pg.Client({ connectionString: ADMIN_URL });
	await admin.connect();
	try {
		const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [SCRATCH]);
		if (!rowCount) await admin.query(`CREATE DATABASE "${SCRATCH}" OWNER water`);
	} finally {
		await admin.end();
	}
	db = new pg.Client({ connectionString: URL_ });
	await db.connect();
});

afterAll(async () => {
	await db?.end();
});

beforeEach(async () => {
	await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
	dir = await mkdtemp(join(tmpdir(), 'wm-migrate-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('migrate', () => {
	it('applies pending files in order, records each checksum, and is a no-op the second time', async () => {
		await write('001_a.sql', 'CREATE TABLE a (id int);');
		await write('002_b.sql', 'CREATE TABLE b (id int);');
		expect(await migrate(URL_, quiet, { dir })).toEqual(['001_a.sql', '002_b.sql']);
		expect(await rows()).toEqual([
			{ name: '001_a.sql', checksum: checksumOf('CREATE TABLE a (id int);') },
			{ name: '002_b.sql', checksum: checksumOf('CREATE TABLE b (id int);') }
		]);
		expect(await migrate(URL_, quiet, { dir })).toEqual([]);
		await write('003_c.sql', 'CREATE TABLE c (id int);');
		expect(await migrate(URL_, quiet, { dir })).toEqual(['003_c.sql']);
		expect(await tables()).toEqual(['a', 'b', 'c']);
	});

	it('refuses when an applied file changed, naming it, and applies nothing', async () => {
		await write('001_a.sql', 'CREATE TABLE a (id int);');
		await migrate(URL_, quiet, { dir });
		await write('001_a.sql', 'CREATE TABLE a (id int, extra text);');
		await write('002_b.sql', 'CREATE TABLE b (id int);');
		await expect(migrate(URL_, quiet, { dir })).rejects.toThrow(/refusing to migrate[\s\S]*001_a\.sql was applied but its contents have changed/);
		expect(await tables()).toEqual(['a']);
	});

	it('refuses when an applied file is missing', async () => {
		await write('001_a.sql', 'CREATE TABLE a (id int);');
		await write('002_b.sql', 'CREATE TABLE b (id int);');
		await migrate(URL_, quiet, { dir });
		await unlink(join(dir, '002_b.sql'));
		await expect(migrate(URL_, quiet, { dir })).rejects.toThrow(/002_b\.sql was applied but its file is missing/);
	});

	it('refuses a pending file that sorts before the latest applied one', async () => {
		await write('001_a.sql', 'CREATE TABLE a (id int);');
		await write('003_c.sql', 'CREATE TABLE c (id int);');
		await migrate(URL_, quiet, { dir });
		await write('002_b.sql', 'CREATE TABLE b (id int);');
		await expect(migrate(URL_, quiet, { dir })).rejects.toThrow(/002_b\.sql is pending but sorts before 003_c\.sql/);
		expect(await tables()).toEqual(['a', 'c']);
	});

	it('upgrades a pre-checksum schema_migrations and backfills its rows instead of refusing', async () => {
		// The table exactly as the runner made it before checksums.
		await db.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
		await db.query('CREATE TABLE a (id int)');
		await db.query("INSERT INTO schema_migrations (name) VALUES ('001_a.sql')");
		await write('001_a.sql', 'CREATE TABLE a (id int);');
		await write('002_b.sql', 'CREATE TABLE b (id int);');
		const log: string[] = [];
		expect(await migrate(URL_, (m) => log.push(m), { dir })).toEqual(['002_b.sql']);
		expect(log).toContain('recorded checksums for 1 earlier migration(s)');
		expect(await rows()).toEqual([
			{ name: '001_a.sql', checksum: checksumOf('CREATE TABLE a (id int);') },
			{ name: '002_b.sql', checksum: checksumOf('CREATE TABLE b (id int);') }
		]);
		// From now on the backfilled file is held to its contents.
		await write('001_a.sql', 'CREATE TABLE a (id bigint);');
		await expect(migrate(URL_, quiet, { dir })).rejects.toThrow(/001_a\.sql was applied but its contents have changed/);
	});

	it('rolls a failed file back and does not record it', async () => {
		await write('001_a.sql', 'CREATE TABLE a (id int); SELECT no_such_function();');
		await expect(migrate(URL_, quiet, { dir })).rejects.toThrow(/migration 001_a\.sql failed/);
		expect(await tables()).toEqual([]);
		expect(await rows()).toEqual([]);
	});

	it('stops a statement past the statement timeout, and a file can raise its own', async () => {
		await write('001_slow.sql', 'SELECT pg_sleep(0.5);');
		await expect(migrate(URL_, quiet, { dir, timeouts: { statement_timeout: '100ms' } })).rejects.toThrow(
			/migration 001_slow\.sql failed: .*statement timeout.*\(statement_timeout 100ms;/
		);
		expect(await rows()).toEqual([]);
		await write('001_slow.sql', '-- migrate: statement_timeout = 5s\nSELECT pg_sleep(0.5);');
		expect(await migrate(URL_, quiet, { dir, timeouts: { statement_timeout: '100ms' } })).toEqual(['001_slow.sql']);
	});

	it('gives up waiting for a lock after the lock timeout', async () => {
		await write('001_a.sql', 'CREATE TABLE a (id int);');
		await migrate(URL_, quiet, { dir });
		const holder = new pg.Client({ connectionString: URL_ });
		await holder.connect();
		try {
			await holder.query('BEGIN; LOCK TABLE a IN ACCESS SHARE MODE;');
			await write('002_alter.sql', 'ALTER TABLE a ADD COLUMN b int;');
			await expect(migrate(URL_, quiet, { dir, timeouts: { lock_timeout: '100ms' } })).rejects.toThrow(
				/migration 002_alter\.sql failed: .*lock timeout.*\(lock_timeout 100ms: another session held a lock/
			);
			await holder.query('ROLLBACK');
		} finally {
			await holder.end();
		}
		expect(await migrate(URL_, quiet, { dir })).toEqual(['002_alter.sql']);
	});

	it('sets the default timeouts inside each migration transaction', async () => {
		await write('001_show.sql', "CREATE TABLE seen AS SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s;");
		await migrate(URL_, quiet, { dir });
		expect((await db.query('SELECT l, s FROM seen')).rows).toEqual([{ l: '5s', s: '4min' }]);
	});
});
