// Settings → Flow calibration → "Evaporation from the map" (issue #326 B-evap;
// docs/ui.md § Settings, docs/maps.md § Evaporation from the map). The
// catchment boundary is averaged over the committed synthetic reference-ET
// grid (the four cells it lies in hold the base row, 120 … 95 mm, exactly);
// the panel proposes it as GR4J's monthly PE beside the saved settings, with
// ET₀ ÷ A-pan as a cross-check; Use asks first, saves the 12 values as one
// settings revision and the form reloads them; History cites the dataset.
// Use waits while the form has unsaved changes. A viewer reads it but can't
// use it, and a project with no boundary is told to draw one. The tables
// are read, never the map. Invented data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, putSeries, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { loadSyntheticEvaporation } from '../support/evaporation.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('evaporation-proposal');
const row = (page: Page, name: string) => panel(page).locator(`tr[data-row="${name}"]`);

/** Settings with the evaporation panel's proposal loaded. */
async function openPanel(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=settings`);
	await expect(panel(page).getByTestId('evaporation-body')).toHaveAttribute('data-ready', 'true');
}

/** A catchment boundary over the synthetic grid's four base cells (21.26–21.44° E, 33.74–33.56° S). */
async function drawBoundary(page: Page, projectId: string) {
	const made = await page.request.post(`${API_URL}/projects/${projectId}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [box(21.26, -33.74, 0.18)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
}

test.beforeAll(async () => {
	await loadSyntheticEvaporation();
});

test('an editor uses the boundary’s reference ET as GR4J’s monthly PE; History cites the dataset; a viewer can’t', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evaporation from the map');
	await drawBoundary(page, project.id);

	await openPanel(page, project.id);
	await expect(panel(page).getByTestId('evaporation-synthetic')).toContainText('Synthetic test data.');
	await expect(panel(page)).toContainText('Over the boundary “Catchment” (4 grid cells; 100 % of the boundary has values), into GR4J’s monthly PE.');
	await expect(row(page, 'proposed').getByRole('cell')).toHaveText(['120', '150', '175', '180', '150', '130', '90', '65', '50', '55', '75', '95', '1\u202f335']);
	await expect(row(page, 'saved')).toContainText('None: GR4J runs on pan coefficient × A-pan');
	// ET₀ ÷ the seeded A-pan row (150 … 110 mm): above FAO-56's 0.85 in Jul, Aug and Sep.
	await expect(row(page, 'implied').getByRole('cell').first()).toHaveText('0.8');
	await expect(panel(page).getByTestId('evaporation-implied')).toContainText('In Jul, Aug, Sep it is outside FAO-56’s typical Class A range');
	await panel(page).getByText('Source and method').click();
	await expect(panel(page).getByTestId('evaporation-source')).toContainText('SYNTHETIC test data, invented for this repository (not dPET or ERA5-Land) (synthetic 1, 1991–2020 monthly means; dataset “synthetic”)');

	const use = panel(page).getByRole('button', { name: 'Use as GR4J’s monthly PE' });
	await use.click();
	// Cancel changes nothing.
	await answerConfirm(page, false, 'Use these values as GR4J’s monthly PE?');
	await expect(row(page, 'saved')).toContainText('None');
	await use.click();
	await answerConfirm(page, true, /GR4J will run on these 12 monthly values \(1\u202f335 mm a year of reference evapotranspiration\) instead of pan coefficient × A-pan\. Irrigation demand and dam evaporation keep reading the A-pan row\./);
	await expect(panel(page).getByTestId('evaporation-notice')).toHaveText(
		'GR4J’s monthly PE is now the map’s 1\u202f335 mm a year, saved as a settings revision citing SYNTHETIC test data, invented for this repository (not dPET or ERA5-Land) (synthetic 1). Run the model to see its effect.'
	);
	// The Use button is gone: the keyboard lands on what happened, not the top of the page.
	await expect(panel(page).getByTestId('evaporation-notice')).toBeFocused();
	await expect(panel(page).getByTestId('evaporation-same')).toHaveText('The saved settings hold these values.');
	await expect(panel(page).getByTestId('evaporation-accepted')).toHaveAttribute('data-current', 'true');
	// The form took the saved settings: GR4J runs on the monthly row, its source naming the dataset, and nothing is unsaved.
	await expect(page.getByTestId('gr4j-pe').getByRole('radio', { checked: true })).toHaveAccessibleName(/monthly/i);
	await expect(page.getByLabel('Monthly PE, Oct, mm')).toHaveValue('120');
	await expect(page.locator('#st-pe-source')).toHaveValue(/^Proposed from the map: reference evapotranspiration \(FAO-56 Penman-Monteith ET₀\), SYNTHETIC/);
	await expect(page.getByText('Unsaved settings')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="evaporation-proposal"]' });

	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').nth(0)).toContainText(/GR4J’s monthly PE from the map: 1335 mm a year of reference evapotranspiration .*\(synthetic 1, 1991–2020 monthly means; dataset “synthetic”\)\. Pre-summarised at import/);

	// A viewer reads the proposal and has no Use; on a phone nothing scrolls sideways.
	const viewer = await signIn('Evaporation viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 390, height: 844 });
	await openPanel(v, project.id);
	await expect(panel(v).getByTestId('evaporation-same')).toBeVisible();
	await expect(panel(v).getByRole('button', { name: /^Use / })).toHaveCount(0);
	await expectNoSidewaysScroll(v);
	// The months scroll in their own box; the row labels stay pinned at its left edge.
	const wrap = panel(v).locator('.table-wrap');
	await wrap.evaluate((el) => (el.scrollLeft = el.scrollWidth));
	const [wrapBox, labelBox] = [await wrap.boundingBox(), await row(v, 'proposed').getByRole('rowheader').boundingBox()];
	expect(Math.abs(labelBox!.x - wrapBox!.x)).toBeLessThan(2);
	await expectNoViolations(v, { include: '[data-testid="evaporation-proposal"]' });
});

test('with a daily A-pan record, the confirmation says demand and the dams keep it and GR4J stops reading it (round 4)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evaporation with a pan record');
	await putSeries(page.request, project.id, { kind: 'evap_apan_mm', unit: 'mm', startDate: '2021-10-01', values: [6, 7, 8] });
	await drawBoundary(page, project.id);
	await openPanel(page, project.id);
	await panel(page).getByRole('button', { name: 'Use as GR4J’s monthly PE' }).click();
	await answerConfirm(page, false, /keep reading the A-pan row and the daily A-pan record \(1 Oct 2021 to 3 Oct 2021\); GR4J stops reading both\./);
});

test('Use waits for unsaved settings, and a project with no boundary is told to draw one', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evaporation waits');
	await openPanel(page, project.id);
	await expect(panel(page).getByTestId('evaporation-no-boundary')).toContainText('There is no catchment boundary on the map yet.');
	await expect(panel(page).getByRole('button', { name: /^Use / })).toHaveCount(0);

	await drawBoundary(page, project.id);
	await openPanel(page, project.id);
	const use = panel(page).getByRole('button', { name: 'Use as GR4J’s monthly PE' });
	await expect(use).toBeEnabled();
	const apanOct = page.getByLabel('A-pan evaporation, Oct, mm');
	await apanOct.fill('151');
	await apanOct.blur();
	await expect(use).toBeDisabled();
	await expect(panel(page)).toContainText('Save or discard your settings changes first');
	await page.getByRole('button', { name: 'Discard' }).click();
	await expect(use).toBeEnabled();
});
