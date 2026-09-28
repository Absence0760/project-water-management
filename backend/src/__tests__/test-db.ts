// The DB tests' database, per checkout, so two worktrees can run
// `pnpm test:backend:db` at once (the e2e suite does the same; e2e/support/env.ts):
//   the main checkout (its `.git` is a directory) and CI   water_test
//   a git worktree (its `.git` is a file)                   water_test_w<1–98>, from a hash of its path
// TEST_DATABASE_URL + TEST_MIGRATION_DATABASE_URL still override both.
// DEV-ONLY docker credentials.
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function testDbName(checkout: string, isWorktree: boolean): string {
	if (!isWorktree) return 'water_test';
	return `water_test_w${1 + (createHash('sha256').update(checkout).digest().readUInt32BE(0) % 98)}`;
}

const checkout = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
let isWorktree = false;
try {
	isWorktree = statSync(`${checkout}/.git`).isFile();
} catch {
	// No .git (an exported tree): the main checkout's name.
}

export const TEST_DB = testDbName(checkout, isWorktree);
export const APP_URL = `postgresql://water_app:water_app@127.0.0.1:5434/${TEST_DB}`;
export const OWNER_URL = `postgresql://water:water@127.0.0.1:5434/${TEST_DB}`;
