// The invented example catchments (`pnpm seed:examples`) and their demo users,
// seeded into the e2e database once per suite run with the backend's own
// seeding CLI. Several specs use them (examples.spec.ts, farm-view.spec.ts);
// they may run at once in parallel workers, so the seeding happens under an
// advisory lock and the second caller finds it done.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import { withSetupLock } from './db.ts';
import { API_URL, APP_E2E_URL } from './env.ts';

// DEV-ONLY demo credentials, as printed by `pnpm seed:examples`.
export const DEMO = { email: 'demo@example.com', password: 'demo-password' };
export const ANALYST = { email: 'analyst@example.com', password: 'demo-password' };
export const FARMER1 = { email: 'farmer1@example.com', password: 'demo-password' };
export const FARMER2 = { email: 'farmer2@example.com', password: 'demo-password' };
export const KLEINBERG = 'Example · Kleinberg (winter rainfall)';
export const DROEVLEI = 'Example · Droëvlei (water-stressed)';
export const SANDSPRUIT = 'Example · Sandspruit (summer rainfall, larger network)';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Any fixed number: the advisory lock's key for this one-off setup. */
const SEED_LOCK = 25_014;

/**
 * Seed the examples unless this run already has. Seeding is real work, not
 * waiting (Kleinberg's automatic GR4J calibration and three 15-year runs):
 * callers give their beforeAll ~90 s.
 */
export async function seedExamplesOnce(request: APIRequestContext): Promise<void> {
	await withSetupLock(SEED_LOCK, async () => {
		const probe = await request.post(`${API_URL}/auth/login`, { data: DEMO });
		if (probe.ok()) return; // already seeded earlier in this run (another spec, or --repeat-each)
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/seed-examples.ts'], {
			cwd: backendDir,
			env: { ...process.env, DATABASE_URL: APP_E2E_URL },
			stdio: 'pipe'
		});
	});
}
