// The synthetic register of dams (issue #326 B-dams; dam-proposals.spec.ts),
// loaded into the e2e database once per run with the backend's own loader
// (`pnpm import:dam-register`, backend/scripts/import-dam-register.ts).
// Invented dams only: register numbers in region Z, no real place.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSetupLock } from './db.ts';
import { OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading the register (distinct from the quaternaries' and the examples'). */
const DAM_REGISTER_LOCK = 326_154;

/** Load the committed synthetic register into the e2e database (replacing it; idempotent). */
export async function loadSyntheticDamRegister(): Promise<void> {
	await withSetupLock(DAM_REGISTER_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-dam-register.ts'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	});
}
