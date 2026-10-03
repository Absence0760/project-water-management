// Which checkout of the repo this process runs from, and a name-safe tag for
// it, for the per-checkout databases (config/devEnv.ts water_w<tag>,
// __tests__/test-db.ts water_test_w<tag>).
//
// The tag is 16 hex digits (64 bits) of a SHA-256 of the checkout's real path.
// It used to be a slot from 1 to 98, and with a dozen worktrees at once three
// of them landed on the same water_test_w3: their DB test runs dropped each
// other's schema mid-run (missing tables, 500s on sign-up). At 64 bits two
// paths sharing a tag is negligible (about 1 in 10^17 for a hundred worktrees).
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHECKOUT_TAG_LENGTH = 16;

/** 16 lowercase hex digits from the checkout's path: stable for a path, distinct between paths. */
export function checkoutTag(checkout: string): string {
	return createHash('sha256').update(checkout).digest('hex').slice(0, CHECKOUT_TAG_LENGTH);
}

/** This checkout's real path, and whether it is a git worktree (its `.git` is a file, not a directory). */
export function thisCheckout(): { path: string; isWorktree: boolean } {
	const path = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
	let isWorktree = false;
	try {
		isWorktree = statSync(`${path}/.git`).isFile();
	} catch {
		// No .git (an exported tree): the main checkout's names.
	}
	return { path, isWorktree };
}
