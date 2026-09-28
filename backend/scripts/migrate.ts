// Applies backend/migrations/*.sql in filename order, once each, recording
// them in schema_migrations with a sha256 of each file's contents. Each file
// runs in its own transaction, with lock and statement timeouts. Then it
// syncs the `language` table (080_language.sql) from the engine's language
// table, so a language is added in one place (LANGUAGES) and the database's
// foreign keys accept it on the next deploy. It only adds: a language that
// left the list stays, since stored locales may still name it.
//
// Forward-only is enforced, not just a convention (docs/data-model.md §
// Migrations): before applying anything, the runner refuses to go on if an
// applied file's contents changed, an applied file is missing, or a pending
// file sorts before the latest applied one (an out-of-order merge). Rows from
// before checksums existed get theirs backfilled from the current file.
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), never as water_app.
//   pnpm dev:db:migrate                     — dev database
//   MIGRATION_DATABASE_URL=… tsx scripts/migrate.ts
import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { LOCALES } from '@water-management/engine/languages';

/** The directory the real migrations live in (next to scripts/, and next to dist/ in the Lambda bundle). */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/**
 * Per-migration timeouts. The statement timeout stays under the migrate
 * Lambda's 300 s (infra/lambda.tf), so a runaway statement fails with a clear
 * error instead of the Lambda being killed mid-transaction; the lock timeout
 * stops a migration queueing behind live traffic (and everything else queueing
 * behind it) on a busy table. A file can raise either with a header comment
 * (see parseDirectives).
 */
export const DEFAULT_TIMEOUTS = { lock_timeout: '5s', statement_timeout: '240s' } as const;
type Timeouts = { lock_timeout: string; statement_timeout: string };

export interface MigrateOptions {
	/** Migrations directory; tests point it at a temp dir. */
	dir?: string;
	/** Overrides the defaults for every file (a file's own directive still wins). */
	timeouts?: Partial<Timeouts>;
}

export interface MigrationFile {
	name: string;
	checksum: string;
}

export interface AppliedRow {
	name: string;
	checksum: string | null;
}

export interface MigrationPlan {
	/** Files to apply, in order. */
	pending: MigrationFile[];
	/** Applied rows recorded before checksums existed: store the current file's. */
	backfill: MigrationFile[];
	/** Why the run must stop; empty when it may go on. */
	problems: string[];
}

export function checksumOf(sql: string): string {
	return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Compare the files on disk with what schema_migrations says was applied.
 * Pure, so the rules are unit-tested (scripts/migrate.test.ts).
 */
export function planMigrations(files: readonly MigrationFile[], applied: readonly AppliedRow[]): MigrationPlan {
	const onDisk = new Map(files.map((f) => [f.name, f]));
	const done = new Map(applied.map((r) => [r.name, r]));
	const problems: string[] = [];
	const backfill: MigrationFile[] = [];
	for (const row of [...applied].sort((a, b) => cmp(a.name, b.name))) {
		const file = onDisk.get(row.name);
		if (!file) {
			problems.push(`${row.name} was applied but its file is missing (deleted or renamed)`);
		} else if (row.checksum === null) {
			backfill.push(file);
		} else if (row.checksum !== file.checksum) {
			problems.push(`${row.name} was applied but its contents have changed since (recorded sha256 ${row.checksum.slice(0, 12)}…, file ${file.checksum.slice(0, 12)}…)`);
		}
	}
	const pending = files.filter((f) => !done.has(f.name));
	const latest = [...done.keys()].sort(cmp).at(-1);
	for (const f of pending) {
		if (latest !== undefined && cmp(f.name, latest) < 0) {
			problems.push(`${f.name} is pending but sorts before ${latest}, which is already applied (out-of-order merge: renumber it after ${latest})`);
		}
	}
	return { pending, backfill, problems };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const DIRECTIVE = /^--\s*migrate:\s*(lock_timeout|statement_timeout)\s*=\s*(\S+)\s*$/gm;
const DURATION = /^(0|[1-9][0-9]*(ms|s|min|h)?)$/;

/**
 * A migration that genuinely needs longer (a big backfill, an index on a
 * large table) raises its own limit with a comment line anywhere in the file:
 *   -- migrate: statement_timeout = 900s
 *   -- migrate: lock_timeout = 30s
 * Values are a Postgres duration (`0` = no limit). Past ~280 s the migrate
 * Lambda's own timeout (infra/lambda.tf) must be raised too.
 */
export function parseDirectives(sql: string): Partial<Timeouts> {
	const out: Partial<Timeouts> = {};
	for (const m of sql.matchAll(DIRECTIVE)) {
		const [, key, value] = m as unknown as [string, keyof Timeouts, string];
		if (!DURATION.test(value)) throw new Error(`bad migrate directive: ${key} = ${value} (use e.g. 900s, 15min or 0)`);
		out[key] = value;
	}
	return out;
}

async function readMigrations(dir: string): Promise<(MigrationFile & { sql: string })[]> {
	const names = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort(cmp);
	return Promise.all(
		names.map(async (name) => {
			const sql = await readFile(join(dir, name), 'utf8');
			return { name, sql, checksum: checksumOf(sql) };
		})
	);
}

export async function migrate(databaseUrl: string, log = console.log, opts: MigrateOptions = {}): Promise<string[]> {
	const files = await readMigrations(opts.dir ?? MIGRATIONS_DIR);
	const base: Timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	const applied: string[] = [];
	try {
		// Serialise concurrent migrators (e.g. parallel test workers), before
		// even the bootstrap below, so two first runs can't race on it.
		await client.query('SELECT pg_advisory_lock(727274)');
		// The runner's own bookkeeping lives here rather than in a numbered
		// migration: it must exist, with its checksum column, before any
		// numbered file can be checked or recorded. The ALTER upgrades tables
		// made before checksums (existing dev, test and production databases).
		await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
			name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text)`);
		await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
		const { rows } = await client.query<AppliedRow>('SELECT name, checksum FROM schema_migrations');
		const plan = planMigrations(files, rows);
		if (plan.problems.length) {
			throw new Error(
				`refusing to migrate: applied migrations are forward-only.\n  - ${plan.problems.join('\n  - ')}\n` +
					'Put the applied file back as it was and make the change in a new NNN_*.sql. ' +
					'A local database built from an edited 001 or a stale branch: `pnpm dev:db:reset`. ' +
					'Production: docs/deployment.md § Migration integrity.'
			);
		}
		for (const f of plan.backfill) {
			await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL', [f.name, f.checksum]);
		}
		if (plan.backfill.length) log(`recorded checksums for ${plan.backfill.length} earlier migration(s)`);
		const byName = new Map(files.map((f) => [f.name, f]));
		for (const { name, checksum } of plan.pending) {
			const { sql } = byName.get(name)!;
			const timeouts = { ...base, ...parseDirectives(sql) };
			await client.query('BEGIN');
			try {
				// is_local = true: SET LOCAL, gone at COMMIT/ROLLBACK.
				await client.query(`SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`, [
					timeouts.lock_timeout,
					timeouts.statement_timeout
				]);
				await client.query(sql);
				await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
				await client.query('COMMIT');
			} catch (err) {
				await client.query('ROLLBACK');
				const e = err as Error & { code?: string };
				const hint =
					e.code === '55P03'
						? ` (lock_timeout ${timeouts.lock_timeout}: another session held a lock it needed; retry when traffic is lower, or raise it with a "-- migrate: lock_timeout = …" line)`
						: e.code === '57014'
							? ` (statement_timeout ${timeouts.statement_timeout}; a migration that needs longer says so with a "-- migrate: statement_timeout = …" line)`
							: '';
				throw new Error(`migration ${name} failed: ${e.message}${hint}`);
			}
			applied.push(name);
			log(`applied ${name}`);
		}
		const added = await syncLanguages(client);
		if (added.length) log(`added language(s) ${added.join(', ')}`);
		await client.query('SELECT pg_advisory_unlock(727274)');
	} finally {
		await client.end();
	}
	return applied;
}

/** Insert every code in LOCALES the `language` table lacks (once 080 has made it); returns the codes added. */
export async function syncLanguages(client: pg.ClientBase, codes: readonly string[] = LOCALES): Promise<string[]> {
	const { rows: exists } = await client.query<{ ok: boolean }>(`SELECT to_regclass('public.language') IS NOT NULL AS ok`);
	if (!exists[0]?.ok) return [];
	const { rows } = await client.query<{ code: string }>('INSERT INTO language (code) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING RETURNING code', [codes]);
	return rows.map((r) => r.code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	// Only the CLI loads dev env files. Importing this module (tests, the
	// migrate Lambda) must never touch process.env — the DB tests once ran
	// against the dev database because this lived at module top level.
	config({ path: ['.env.development.local', '.env.development'] });
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	migrate(url)
		.then((applied) => console.log(applied.length ? `${applied.length} migration(s) applied` : 'schema up to date'))
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
