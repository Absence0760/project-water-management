// The synthetic land-cover grid (issue #326 B-landcover; cropland-proposals.spec.ts),
// loaded into the e2e database once per run with the backend's own loader
// (`pnpm import:land-cover`, backend/scripts/import-land-cover.ts).
// Invented cropland shares only, not ESA WorldCover.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSetupLock } from './db.ts';
import { OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading the grid (distinct from the register's, the stations' and the quaternaries'). */
const LAND_COVER_LOCK = 326_173;

/** Load the committed synthetic grid into the e2e database (replacing it; idempotent). */
export async function loadSyntheticLandCover(): Promise<void> {
	await withSetupLock(LAND_COVER_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-land-cover.ts'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	});
}
