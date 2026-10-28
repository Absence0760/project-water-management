// Calibration → Flow calibration → "Evaporation stations" (issue #646 item 6;
// docs/ui.md § Set up the fit, docs/maps.md § Evaporation stations). The
// committed INVENTED evaporation stations round a catchment boundary: a
// Class-A pan inside it is proposed first, its monthly means as the A-pan and
// its daily record as the daily A-pan series; Use asks first and saves one
// settings revision citing the station, which History shows. A Symons pan
// is converted only once an equation is picked (WR90's is refused for its
// winter S-pan), and writes no daily series. The tables are read, never the map.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { withSetupLock } from '../support/db.ts';
import { API_URL, OWNER_E2E_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
/** Advisory lock key for loading the stations (distinct from the other reference loaders'). */
const EVAPORATION_STATIONS_LOCK = 646_274;

/** Load the committed synthetic stations into the e2e database (`pnpm import:evaporation-stations`; replacing them; idempotent). */
async function loadSyntheticEvaporationStations(): Promise<void> {
	await withSetupLock(EVAPORATION_STATIONS_LOCK, async () => {
		execFileSync('pnpm', ['exec', 'tsx', 'scripts/import-evaporation-stations.ts'], { cwd: backendDir, env: { ...process.env, MIGRATION_DATABASE_URL: OWNER_E2E_URL }, stdio: 'pipe' });
	});
}

const panel = (page: Page) => page.getByTestId('evaporation-station-proposal');
const row = (page: Page, name: string) => panel(page).locator(`tr[data-row="${name}"]`);
const option = (page: Page, code: string) => panel(page).locator(`[data-testid="evaporation-station-option"][data-code="${code}"]`);

async function openPanel(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=calibration`);
	await expect(panel(page).getByTestId('evaporation-station-body')).toHaveAttribute('data-ready', 'true');
}

/** A boundary round the synthetic stations: Z1E001 inside, Z1E002 and Z1E003 within 100 km. */
async function drawBoundary(page: Page, projectId: string) {
	const made = await page.request.post(`${API_URL}/projects/${projectId}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [box(21.25, -33.85, 0.15)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
}

test.beforeAll(async () => {
	await loadSyntheticEvaporationStations();
});

test('an editor uses the nearest Class-A station’s record as the A-pan and its daily series; History cites the station', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evaporation station');
	await drawBoundary(page, project.id);
	await openPanel(page, project.id);

	await expect(panel(page).getByTestId('evaporation-station-synthetic')).toContainText('Synthetic test data.');
	await expect(panel(page).getByTestId('evaporation-station-option')).toHaveCount(3);
	await expect(option(page, 'Z1E001')).toContainText('Z1E001 Testpan Dam (invented) · Class-A pan · inside the boundary · 2014–2019 (6 years), 98 % of days read');
	await expect(option(page, 'Z1E001').getByRole('radio')).toBeChecked();
	await expect(row(page, 'proposed').getByRole('cell').first()).toHaveText('184.5');
	await expect(row(page, 'span')).toHaveCount(0);
	await expect(panel(page).getByTestId('evaporation-station-daily')).toBeChecked();

	const use = panel(page).getByRole('button', { name: 'Use as the A-pan' });
	await expect(use).toHaveAccessibleDescription('Saves now');
	await use.click();
	await answerConfirm(page, false, 'Use Z1E001’s record as the A-pan?');
	await expect(use).toBeVisible();
	await use.click();
	await answerConfirm(page, true, /The A-pan row becomes .* mm a year, the monthly means of Z1E001 \(Testpan Dam \(invented\)\), a Class-A pan inside the boundary\..*written as the daily A-pan series “DWS Z1E001”/);
	await expect(panel(page).getByTestId('evaporation-station-notice')).toContainText(/The A-pan row is now Z1E001’s .* mm a year, and its daily record the series “DWS Z1E001”, saved as a settings revision citing the station\./);
	await expect(panel(page).getByTestId('evaporation-station-notice')).toBeFocused();
	await expect(panel(page).getByTestId('evaporation-station-same')).toBeVisible();
	await expect(row(page, 'saved').getByRole('cell').first()).toHaveText('184.5');
	await expect(panel(page).getByTestId('evaporation-station-daily-now')).toContainText('“DWS Z1E001” (2014-01-01 to 2019-12-31)');
	await expectNoViolations(page, { include: '[data-testid="evaporation-station-proposal"]' });

	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').filter({ hasText: 'A-pan evaporation from DWS evaporation station Z1E001' }).first()).toContainText(
		/Class-A pan, inside the catchment boundary “Catchment”.*daily series “DWS Z1E001” written \(2014-01-01 to 2019-12-31\)/
	);
});

test('a Symons station converts only with the equation picked, refuses WR90’s for its winter, and writes no daily series', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evaporation Symons station');
	await drawBoundary(page, project.id);
	await openPanel(page, project.id);

	await option(page, 'Z1E002').getByRole('radio').check();
	const conv = panel(page).getByTestId('evaporation-station-conversion');
	await expect(conv).toContainText('cannot be inverted');
	await expect(conv.getByRole('radio', { name: /WR90/ })).toBeDisabled();
	await expect(conv).toContainText('can’t be used here: the S-pan in Jul is below 32.5 mm');
	await expect(row(page, 'span').getByRole('cell').first()).toHaveText('136.1');
	await expect(row(page, 'proposed')).toContainText('Pick an equation above');
	await expect(panel(page).getByRole('button', { name: 'Use as the A-pan' })).toHaveCount(0);
	await expect(panel(page).getByTestId('evaporation-station-daily')).toHaveCount(0);

	await conv.getByRole('radio', { name: /Taljaard/ }).check();
	await expect(row(page, 'proposed').getByRole('cell').first()).toHaveText('169.2');
	await panel(page).getByRole('button', { name: 'Use as the A-pan' }).click();
	await answerConfirm(page, true, /Z1E002 \(Symons Testpan \(invented\)\), a Symons pan .* km from the boundary, converted by the Taljaard \(2023\) general monthly equation, inverted\./);
	await expect(panel(page).getByTestId('evaporation-station-notice')).toHaveText(/^The A-pan row is now Z1E002’s .* mm a year, saved as a settings revision citing the station\. Run the model to see its effect\.$/);
	await expect(panel(page).getByTestId('evaporation-station-daily-now')).toHaveCount(0);

	// On a phone nothing scrolls sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await openPanel(page, project.id);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page, { include: '[data-testid="evaporation-station-proposal"]' });
});
