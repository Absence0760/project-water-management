// The catchment map (issue #288; catchment-map.spec.ts): synthetic GeoJSON
// files, and the synthetic quaternary dataset loaded into the e2e database
// once per run with the backend's own loader (`pnpm import:quaternaries`,
// backend/scripts/import-quaternaries.ts). Invented data only: region Z, no
// real place.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSetupLock } from './db.ts';
import { OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading the dataset (distinct from the examples' seed). */
const QUATERNARY_LOCK = 288_288;

/** A box `d` degrees on a side, south-west corner at (x, y). Around (21.35, -33.65) it lies in the synthetic quaternary Z01B. */
export const box = (x: number, y: number, d: number): [number, number][] => [
	[x, y],
	[x + d, y],
	[x + d, y + d],
	[x, y + d],
	[x, y]
];

export const boundaryGeoJson = (name = 'Synthetic catchment') =>
	JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [box(21.3, -33.7, 0.1)] } }] });

/** Two parcels named like sampleModel()'s farms, so the import links them. */
export const parcelsGeoJson = () =>
	JSON.stringify({
		type: 'FeatureCollection',
		features: [
			{ type: 'Feature', properties: { name: 'Upper farm' }, geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.03)] } },
			{ type: 'Feature', properties: { name: 'Lower farm' }, geometry: { type: 'Polygon', coordinates: [box(21.36, -33.69, 0.02)] } }
		]
	});

/** A file in projected metres (a Lo zone's), which the server refuses rather than guesses. */
export const projectedGeoJson = () =>
	JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [box(-45_000, 3_700_000, 1000)] } }] });

/** Load the committed synthetic quaternary dataset into the e2e database (replacing it; idempotent). */
export async function loadSyntheticQuaternaries(): Promise<void> {
	await withSetupLock(QUATERNARY_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-quaternaries.ts'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	});
}
