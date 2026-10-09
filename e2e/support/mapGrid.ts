// The synthetic MAP grid (docs/maps.md § MAP grid; map-layers.spec.ts), loaded
// into the e2e database once per run with the backend's own loader (`pnpm
// import:map-grid`, backend/scripts/import-map-grid.ts). Invented rainfall
// over region Z only, never a real grid.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSetupLock } from './db.ts';
import { OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading the grid (distinct from every other reference loader's). */
const MAP_GRID_LOCK = 326_207;

/** Load the committed synthetic grid into the e2e database (replacing it; idempotent). */
export async function loadSyntheticMapGrid(): Promise<void> {
	await withSetupLock(MAP_GRID_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-map-grid.ts'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	});
}
