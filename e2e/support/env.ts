// Ports and database for the isolated e2e stack. Chosen so a run never
// collides with `pnpm dev` (frontend :7777, backend :3001, database `water`),
// nor with an e2e run in another checkout of this repo.
// DEV-ONLY docker-compose credentials (docker-compose.yml, dev/postgres).
//
// Each checkout gets a slot, and the slot picks the ports:
//   slot 0  the main checkout (its `.git` is a directory), and CI: :3101, :7801, water_e2e
//   1–98    a git worktree (its `.git` is a file): :3101+slot, :7801+slot
// A worktree's slot comes from the registry in the repo's shared git directory
// (support/slots.ts), so two live worktrees never hold the same one; when the
// registry can't be reached, from a hash of the path. A worktree's database is
// water_e2e_w<16 hex digits from its path>_<slot>, distinct from every other
// checkout's whatever the slot (e2eDbName). E2E_SLOT=<0–98> overrides the slot;
// two runs on one slot by hand can't share a database unseen either:
// Playwright starts the servers before global setup, so the second run stops
// on a port that is already in use.
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claimSlot, registryDir } from './slots.ts';

const SLOTS = 99;

function hashOf(checkout: string): Buffer {
	return createHash('sha256').update(checkout).digest();
}

/** A worktree's preferred slot from 1 to 98: where the registry starts looking, and the slot itself when there is no registry. */
export function hashedSlot(checkout: string): number {
	return 1 + (hashOf(checkout).readUInt32BE(0) % (SLOTS - 1));
}

export function slotFor(checkout: string, isWorktree: boolean, override?: string, registry: string | null = isWorktree ? registryDir(checkout) : null): number {
	if (override !== undefined && override !== '') {
		const n = Number(override);
		if (!Number.isInteger(n) || n < 0 || n >= SLOTS) throw new Error(`E2E_SLOT must be a whole number from 0 to ${SLOTS - 1}, got ${override}`);
		return n;
	}
	if (!isWorktree) return 0;
	return registry ? claimSlot(registry, checkout, hashedSlot(checkout), SLOTS) : hashedSlot(checkout);
}

/** The e2e database: `water_e2e` for the main checkout on slot 0 (and CI), else one named by the checkout's path and the slot. */
export function e2eDbName(checkout: string, isWorktree: boolean, slot: number): string {
	if (!isWorktree && slot === 0) return 'water_e2e';
	return `water_e2e_w${hashOf(checkout).toString('hex').slice(0, 16)}_${slot}`;
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

/**
 * The site build's folders under frontend/ for a slot: slot 0 (the main checkout, CI) keeps
 * `build-e2e` and `.svelte-kit-e2e`; any other slot gets its own, so two runs in one checkout on
 * different slots (E2E_SLOT) never rebuild the site the other is serving, with the other's API URL.
 */
export function buildDirsFor(slot: number): { build: string; kit: string } {
	return slot === 0 ? { build: 'build-e2e', kit: '.svelte-kit-e2e' } : { build: `build-e2e-${slot}`, kit: `.svelte-kit-e2e-${slot}` };
}

export const E2E_DB = e2eDbName(checkout, isWorktree, E2E_SLOT);
const PG = process.env.E2E_PG_HOST ?? '127.0.0.1:5434';
/** Schema owner: creates the database and runs migrations. */
export const OWNER_ADMIN_URL = `postgresql://water:water@${PG}/water`;
export const OWNER_E2E_URL = `postgresql://water:water@${PG}/${E2E_DB}`;
/** What the backend connects as: RLS-bound, like in dev and prod. */
export const APP_E2E_URL = `postgresql://water_app:water_app@${PG}/${E2E_DB}`;
