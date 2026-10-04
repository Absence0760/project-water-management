// The catchment map (issue #288; catchment-map.spec.ts): synthetic GeoJSON
// files, and the synthetic quaternary dataset loaded into the e2e database
// once per run with the backend's own loader (`pnpm import:quaternaries`,
// backend/scripts/import-quaternaries.ts). Invented data only: region Z, no
// real place.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createProject, node, putModel } from './api.ts';
import { withSetupLock } from './db.ts';
import { API_URL, OWNER_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading the dataset (distinct from the examples' seed). */
const QUATERNARY_LOCK = 288_288;
/** And for the gauging stations (issue #326 B-gauge). */
const STATIONS_LOCK = 326_153;
/** And for the river network (issue #345). */
const RIVERS_LOCK = 345_345;

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

/** A dam's water surface inside Upper farm's parcel: a polygon whose area is never a unit's catchment area. */
export const damGeoJson = () =>
	JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Upper dam' }, geometry: { type: 'Polygon', coordinates: [box(21.32, -33.68, 0.004)] } }] });

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

/** Load the committed synthetic gauging stations into the e2e database (`pnpm import:gauge-stations`; replacing them; idempotent). */
export async function loadSyntheticStations(): Promise<void> {
	await withSetupLock(STATIONS_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-gauge-stations.ts'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	});
}

/** Load the committed synthetic river network into the e2e database (`pnpm import:rivers`; replacing it; idempotent). */
export async function loadSyntheticRivers(): Promise<void> {
	await withSetupLock(RIVERS_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-rivers.ts'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	});
}

/**
 * Load a river network of its own (a dataset label of the spec's, so parallel specs never share one) into the e2e
 * database, through the importer as an operator would: `reaches` as HydroRIVERS-style lines with their upstream areas.
 */
export async function loadRiverNetwork(dataset: string, reaches: { id: number; upstreamKm2: number; order: number; line: [number, number][] }[]): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'e2e-rivers-'));
	const file = join(dir, `${dataset}.geojson`);
	writeFileSync(
		file,
		JSON.stringify({
			type: 'FeatureCollection',
			features: reaches.map((r) => ({ type: 'Feature', properties: { HYRIV_ID: r.id, ORD_STRA: r.order, UPLAND_SKM: r.upstreamKm2 }, geometry: { type: 'LineString', coordinates: r.line } }))
		})
	);
	try {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-rivers.ts', file, '--dataset', dataset, '--source', 'e2e test reaches'], {
			cwd: backendDir,
			env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL },
			stdio: 'pipe'
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The big case (ui-playbook § 1.3): a project with `n` hydrological units, a
 * parcel for each (linked by name, sizes all different), a boundary round
 * them, a dam polygon, two gauges and a river. Invented names and places.
 */
export async function seedBigMap(request: APIRequestContext, name: string, n = 30): Promise<{ id: string; farms: string[] }> {
	const project = await createProject(request, name);
	const gauge = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const farms = Array.from({ length: n }, (_, i) => node(`Hydrological unit with a long name ${i + 1}`, 'farm', gauge.id, i + 2, { areaKm2: 5 + i }));
	await putModel(request, project.id, { nodes: [gauge, ...farms], crops: [], cropAreas: [], transfers: [] } as unknown as Parameters<typeof putModel>[2]);
	const post = async (fileName: string, kind: string, features: unknown[]) => {
		const res = await request.post(`${API_URL}/projects/${project.id}/map/import`, { data: { fileName, kind, text: JSON.stringify({ type: 'FeatureCollection', features }) } });
		expect(res.status(), await res.text()).toBe(201);
	};
	const poly = (nm: string, ring: [number, number][]) => ({ type: 'Feature', properties: { name: nm }, geometry: { type: 'Polygon', coordinates: [ring] } });
	await post('big-boundary.geojson', 'catchment_boundary', [poly('Big catchment', box(21.0, -34.0, 0.7))]);
	await post(
		'big-parcels.geojson',
		'farm_parcel',
		farms.map((f, i) => poly(f.name, box(21.02 + (i % 6) * 0.11, -33.98 + Math.floor(i / 6) * 0.13, 0.03 + (i % 7) * 0.008)))
	);
	await post('big-dams.geojson', 'dam', [poly('Big dam', box(21.05, -33.95, 0.004))]);
	await post('big-gauges.geojson', 'gauge', [
		{ type: 'Feature', properties: { name: 'Outflow gauge' }, geometry: { type: 'Point', coordinates: [21.69, -33.31] } },
		{ type: 'Feature', properties: { name: 'Upper weir' }, geometry: { type: 'Point', coordinates: [21.2, -33.8] } }
	]);
	await post('big-river.geojson', 'river', [{ type: 'Feature', properties: { name: 'Big river' }, geometry: { type: 'LineString', coordinates: [[21.05, -33.95], [21.4, -33.6], [21.69, -33.31]] } }]);
	return { id: project.id, farms: farms.map((f) => f.id) };
}

/** The Map tab, once its features have loaded (`data-ready`): the header line and the list are final. */
export async function openMap(page: Page, projectId: string, query = ''): Promise<void> {
	await page.goto(`/projects/${projectId}?tab=map${query}`);
	await expect(page.locator('.map-page[data-ready]')).toBeVisible();
}

export const geoFile = (name: string, text: string) => ({ name, mimeType: 'application/geo+json', buffer: Buffer.from(text) });

/**
 * The Upload GeoJSON sheet, open. The URL decides, not a look at the page: the sheet is open while the URL
 * names it (`upload=1`), but it is a lazily loaded component, so it shows a moment after the URL changes.
 * Checking `isVisible()` in that moment and clicking the header's link again hit the sheet that had just
 * opened over it (a modal dialog intercepts the click), and the click timed out.
 */
export async function openUploadSheet(page: Page): Promise<Locator> {
	const sheet = page.getByRole('dialog', { name: 'Upload a GeoJSON file' });
	if (new URL(page.url()).searchParams.get('upload') !== '1') {
		await page.getByTestId('section-header').getByRole('link', { name: 'Upload GeoJSON' }).click();
		await expect(page).toHaveURL(/[?&]upload=1/);
	}
	await expect(sheet).toBeVisible();
	return sheet;
}

/**
 * Upload a file through the header's Upload GeoJSON sheet (issue #326 D2): choose it, Review, optionally
 * set every row's kind, then Import. `expectImported` waits for the notice (the sheet closes); without it
 * the review stays open (a refused file lists its problems and offers no import).
 */
export async function uploadThroughSheet(page: Page, kind: string | null, name: string, text: string, expectImported = true): Promise<void> {
	const sheet = await openUploadSheet(page);
	const another = sheet.getByRole('button', { name: 'Choose another file' });
	// settled: the sheet is open and the caller's last step (a refused review, or none) has been awaited.
	if (await another.isVisible()) await another.click();
	await sheet.getByLabel(/^GeoJSON file/).setInputFiles(geoFile(name, text));
	await sheet.getByRole('button', { name: 'Review', exact: true }).click();
	await expect(sheet.getByTestId('map-review-table')).toBeVisible();
	if (kind) await sheet.getByLabel('Set every row’s kind').selectOption(kind);
	if (expectImported) {
		await sheet.getByRole('button', { name: /^Import \d+ features?$/ }).click();
		await expect(page.getByTestId('map-notice')).toContainText(`from ${name}.`);
		await expect(sheet).toBeHidden();
		// Closing drops `upload=1` from the URL a moment later: wait for it, so the next call sees the sheet closed.
		await expect(page).not.toHaveURL(/[?&]upload=1/);
	}
}

/**
 * The side column's tab (Details, Features, Checks; docs/ui.md § Map): one panel shows at a time, and a pick
 * shows its Details, so a spec opens the list's tab before reading the list after a pick.
 */
export async function showTab(page: Page, tab: 'details' | 'features' | 'checks' | 'layers' | 'key'): Promise<void> {
	const t = page.getByTestId(`map-tab-${tab}`);
	await expect(t).toBeVisible();
	if ((await t.getAttribute('aria-selected')) !== 'true') await t.click();
	await expect(t).toHaveAttribute('aria-selected', 'true');
}

/** Layers, opened if it isn't: the side column's tab beside the map, a panel over the map's right edge otherwise. */
export async function openLayers(page: Page): Promise<void> {
	const b = page.getByTestId('map-layers-toggle');
	await expect(b).toBeVisible();
	if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
	await expect(b).toHaveAttribute('aria-expanded', 'true');
}

/** The Key, opened if it isn't: the side column's tab beside the map, a panel over the map's bottom-left corner otherwise. */
export async function openKey(page: Page): Promise<void> {
	const b = page.getByTestId('map-key-toggle');
	await expect(b).toBeVisible();
	if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
	await expect(b).toHaveAttribute('aria-expanded', 'true');
}
