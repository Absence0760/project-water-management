// The DB tests' database, per checkout, so two worktrees can run
// `pnpm test:backend:db` at once (the e2e suite does the same; e2e/support/env.ts):
//   the main checkout (its `.git` is a directory) and CI   water_test
//   a git worktree (its `.git` is a file)                   water_test_w<tag>, 16 hex digits from its path (config/checkout.ts)
// TEST_DATABASE_URL + TEST_MIGRATION_DATABASE_URL still override both.
// DEV-ONLY docker credentials.
import { checkoutTag, thisCheckout } from '../config/checkout.js';

export function testDbName(checkout: string, isWorktree: boolean): string {
	return isWorktree ? `water_test_w${checkoutTag(checkout)}` : 'water_test';
}

const here = thisCheckout();
export const TEST_DB = testDbName(here.path, here.isWorktree);
export const APP_URL = `postgresql://water_app:water_app@127.0.0.1:5434/${TEST_DB}`;
export const OWNER_URL = `postgresql://water:water@127.0.0.1:5434/${TEST_DB}`;
