// Ports and database for the isolated e2e stack. Chosen so a run never
// collides with `pnpm dev` (frontend :7777, backend :3001, database `water`),
// nor with an e2e run in another checkout of this repo.
// DEV-ONLY docker-compose credentials (docker-compose.yml, dev/postgres).
//
// Each checkout gets a slot, and the slot picks the ports and the database:
//   slot 0  the main checkout (its `.git` is a directory), and CI: :3101, :7801, water_e2e
//   1–98    a git worktree (its `.git` is a file), from a hash of its path:
//           :3101+slot, :7801+slot, water_e2e_<slot>
// E2E_SLOT=<0–98> overrides it. Two checkouts on one slot can't share a
// database unseen: Playwright starts the servers before global setup, so the
// second run stops on a port that is already in use.
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SLOTS = 99;

export function slotFor(checkout: string, isWorktree: boolean, override?: string): number {
	if (override !== undefined && override !== '') {
		const n = Number(override);
		if (!Number.isInteger(n) || n < 0 || n >= SLOTS) throw new Error(`E2E_SLOT must be a whole number from 0 to ${SLOTS - 1}, got ${override}`);
		return n;
	}
	if (!isWorktree) return 0;
	return 1 + (createHash('sha256').update(checkout).digest().readUInt32BE(0) % (SLOTS - 1));
}

const checkout = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
let isWorktree = false;
try {
	isWorktree = statSync(`${checkout}/.git`).isFile();
} catch {
	// No .git at all (an exported tree): treat it as the main checkout.
}

export const E2E_SLOT = slotFor(checkout, isWorktree, process.env.E2E_SLOT);
export const API_PORT = 3101 + E2E_SLOT;
export const WEB_PORT = 7801 + E2E_SLOT;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

export const E2E_DB = E2E_SLOT === 0 ? 'water_e2e' : `water_e2e_${E2E_SLOT}`;
const PG = process.env.E2E_PG_HOST ?? '127.0.0.1:5434';
/** Schema owner: creates the database and runs migrations. */
export const OWNER_ADMIN_URL = `postgresql://water:water@${PG}/water`;
export const OWNER_E2E_URL = `postgresql://water:water@${PG}/${E2E_DB}`;
/** What the backend connects as: RLS-bound, like in dev and prod. */
export const APP_E2E_URL = `postgresql://water_app:water_app@${PG}/${E2E_DB}`;
