// The synthetic orchard and vine grid (issue #604 R5-D; crop-types-proposals.spec.ts),
// loaded into the e2e database once per run with the backend's own loader
// (`pnpm import:crop-types`, backend/scripts/import-crop-types.ts).
// Invented shares only, not SANLC.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSetupLock } from './db.ts';
import { OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading the grid (distinct from the land cover's and the other grids'). */
const CROP_TYPES_LOCK = 604_255;

/** Load the committed synthetic grid into the e2e database (replacing it; idempotent). */
export async function loadSyntheticCropTypes(): Promise<void> {
	await withSetupLock(CROP_TYPES_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-crop-types.ts'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	});
}
