// The synthetic evaporation grid (issue #326 B-evap; evaporation-proposal.spec.ts),
// loaded into the e2e database once per run with the backend's own loader
// (`pnpm import:evaporation`, backend/scripts/import-evaporation.ts).
// Invented reference ET only, not dPET.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSetupLock } from './db.ts';
import { OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading the grid (distinct from the land cover's, the register's, the stations' and the quaternaries'). */
const EVAPORATION_LOCK = 326_180;

/** Load the committed synthetic grid into the e2e database (replacing it; idempotent). */
export async function loadSyntheticEvaporation(): Promise<void> {
	await withSetupLock(EVAPORATION_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-evaporation.ts'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	});
}
