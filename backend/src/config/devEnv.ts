// Local-dev env for the Node entry points and CLI scripts (server.ts,
// jobs/worker.ts, scripts/*). Never reached from a Lambda entry: no Lambda
// bundle may carry dotenv (infra/scripts/package-lambdas.sh).
//
// The committed .env.development holds non-sensitive defaults; the gitignored
// .env.development.local (listed first, so it wins) holds personal overrides.
// Missing files are skipped, so a fresh clone runs with zero env setup.
//
// Each checkout gets its own dev database, so a branch's unmerged migrations
// never reach the database another checkout's `pnpm dev` runs against:
//   the main checkout (its `.git` is a directory)   water
//   a git worktree (its `.git` is a file)           water_w<1–98>, from a hash of its path
// (the same number as its DB tests' water_test_w<n>, src/__tests__/test-db.ts).
// When every worktree migrated the one `water` database, a branch that
// renumbered its migration before merging left the main checkout's dev server
// refusing to start ("applied but its file is missing").
//
// Only a local URL naming the default `water` database is pointed at the
// checkout's own, so a DATABASE_URL set to anything else is left alone.
// DEV_DB_NAME overrides the name (DEV_DB_NAME=water shares the main checkout's).
// DEV-ONLY docker credentials.
import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const DEV_DB_URL_VARS = ['DATABASE_URL', 'MIGRATION_DATABASE_URL'] as const;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function devDbName(checkout: string, isWorktree: boolean): string {
	if (!isWorktree) return 'water';
	return `water_w${1 + (createHash('sha256').update(checkout).digest().readUInt32BE(0) % 98)}`;
}

/** This checkout's dev database: DEV_DB_NAME, else by where it is (see above). */
export function checkoutDevDbName(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.DEV_DB_NAME?.trim();
	if (override) {
		if (!DB_NAME.test(override)) throw new Error(`DEV_DB_NAME must be a lowercase database name, got ${JSON.stringify(override)}`);
		return override;
	}
	const checkout = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
	let isWorktree = false;
	try {
		isWorktree = statSync(`${checkout}/.git`).isFile();
	} catch {
		// No .git (an exported tree): the main checkout's name.
	}
	return devDbName(checkout, isWorktree);
}

/** `url` pointed at database `name` when it is a local URL naming the default `water`; otherwise unchanged. */
export function withDevDb(url: string, name: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	if (!LOCAL_HOSTS.has(parsed.hostname) || parsed.pathname !== '/water') return url;
	parsed.pathname = `/${name}`;
	return parsed.toString();
}

/**
 * Load the dev env files from `dir` (the working directory: every entry point
 * runs from `backend/`), then point the database URLs at this checkout's dev
 * database. Tests pass a temp `dir`, so a developer's own
 * `.env.development.local` never reaches them.
 */
export function loadDevEnv(env: NodeJS.ProcessEnv = process.env, dir: string = process.cwd()): void {
	config({ path: [join(dir, '.env.development.local'), join(dir, '.env.development')], processEnv: env as Record<string, string> });
	const name = checkoutDevDbName(env);
	for (const key of DEV_DB_URL_VARS) {
		const url = env[key];
		if (url) env[key] = withDevDb(url, name);
	}
}

/**
 * Create the dev database `ownerUrl` names when it doesn't exist yet (a
 * worktree's first `pnpm dev` or `pnpm dev:db:migrate`). It connects to the
 * `water` database on the same server to do so; `water` itself always exists
 * (the container makes it).
 */
export async function ensureDevDb(ownerUrl: string): Promise<boolean> {
	const parsed = new URL(ownerUrl);
	const name = decodeURIComponent(parsed.pathname.slice(1));
	if (name === 'water' || !LOCAL_HOSTS.has(parsed.hostname)) return false;
	if (!DB_NAME.test(name)) throw new Error(`refusing to create dev database ${JSON.stringify(name)}`);
	parsed.pathname = '/water';
	const admin = new pg.Client({ connectionString: parsed.toString() });
	try {
		await admin.connect();
		const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
		if (rowCount) return false;
		try {
			await admin.query(`CREATE DATABASE "${name}" OWNER water`);
		} catch (err) {
			// Another process created it first: a duplicate name (42P04), or,
			// when both got past the check above, the catalogue's unique index (23505).
			const code = (err as { code?: string }).code;
			if (code === '42P04' || code === '23505') return false;
			throw err;
		}
		console.log(`created this checkout's dev database ${name} (empty: \`pnpm seed:examples\` adds the demo catchments)`);
		return true;
	} finally {
		await admin.end().catch(() => {});
	}
}
