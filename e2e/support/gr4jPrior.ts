// The regional GR4J prior's reference data (issue #622; regional-prior.spec.ts):
// the synthetic soil water capacity grid and donor basins, loaded into the e2e
// database once per run with the backend's own loaders (`pnpm import:soils`,
// `pnpm import:gr4j-donors`). Invented data only, not SoilGrids or GRDC-Caravan.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSetupLock } from './db.ts';
import { OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading them (distinct from the other reference loaders'). */
const PRIOR_LOCK = 622_268;

/** Load the committed synthetic soil grid and donors into the e2e database (replacing them; idempotent). */
export async function loadSyntheticPrior(): Promise<void> {
	await withSetupLock(PRIOR_LOCK, async () => {
		for (const script of ['scripts/import-soils.ts', 'scripts/import-gr4j-donors.ts']) {
			execFileSync('pnpm', ['exec', 'tsx', script], { cwd: backendDir, env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL }, stdio: 'pipe' });
		}
	});
}
