// Calibration → Flow calibration → "Evaporation from the map" (issue #326 B-evap;
// docs/ui.md § Calibration, docs/maps.md § Evaporation from the map). The
// catchment boundary is averaged over the committed synthetic reference-ET
// grid (the four cells it lies in hold the base row, 120 … 95 mm, exactly);
// the panel proposes it as GR4J's monthly PE beside the saved settings, with
// ET₀ ÷ A-pan as a cross-check; Use asks first, saves the 12 values as one
// settings revision and the form reloads them; History cites the dataset.
// Use waits while the form has unsaved changes. A viewer reads it but can't
// use it, and a project with no boundary is told to draw one. An S-pan grid
// (issue #738; its answer stood in for by a route, so the shared e2e
// database keeps one grid) is shown as a cross-check beside the saved A-pan,
// with no Use. Model settings → Demand → A-pan from "CCWR A-pan grid
// (catchment average)" is the same panel pinned to Atlas-Apan-2007: not
// loaded on the e2e server, it says so with the import command; loaded (its
// answer stood in for by a route, the synthetic grid's months as A-pan), it
// proposes the A-pan row under the name "CCWR A-pan" and Use asks first. The
// tables are read, never the map. Invented data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, putSeries, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { loadSyntheticEvaporation } from '../support/evaporation.ts';
import { expect, test } from '../support/fixtures.ts';
import { anySaveBar } from '../support/settings.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('evaporation-proposal');
const row = (page: Page, name: string) => panel(page).locator(`tr[data-row="${name}"]`);

/** Calibration (issue #586 round 3) with the evaporation panel's proposal loaded. */
async function openPanel(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=calibration`);
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
	// Use saves straight away, unlike the form's fields: it sits in the heading's row and says so (issue #521).
	await expect(use).toHaveAccessibleDescription('Saves now');
	const heading = (await panel(page).getByRole('heading', { name: 'Evaporation from the map' }).boundingBox())!;
	const button = (await use.boundingBox())!;
	expect(Math.abs(button.y + button.height / 2 - (heading.y + heading.height / 2))).toBeLessThan(12);
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
	await expect(anySaveBar(page)).toHaveCount(0);
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
	// An unsaved edit on Model settings (Demand's A-pan) is the same draft: back on Calibration, Use waits for it.
	const sections = page.getByRole('navigation', { name: 'Project sections' });
	await sections.getByRole('link', { name: 'Model settings', exact: true }).click();
	const apanOct = page.getByLabel('A-pan evaporation, Oct, mm');
	await apanOct.fill('151');
	await apanOct.blur();
	await sections.getByRole('link', { name: 'Calibration', exact: true }).click();
	await expect(panel(page).getByTestId('evaporation-body')).toHaveAttribute('data-ready', 'true');
	await expect(use).toBeDisabled();
	await expect(panel(page)).toContainText('Save or discard your settings changes first');
	await anySaveBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
	await answerConfirm(page, true);
	await expect(use).toBeEnabled();
});

test('an S-pan grid is a cross-check only: its months, the saved A-pan and A-pan ÷ S-pan, and no Use (issue #738)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evaporation S-pan cross-check');
	await drawBoundary(page, project.id);
	// The synthetic grid's answer, presented as an S-pan grid: what the server sends for one (no target).
	await page.route(/\/evaporation-proposals(\?|$)/, async (route) => {
		const res = await route.fetch();
		const body = await res.json();
		body.dataset = { ...body.dataset, dataset: 'Atlas-Span-2007', kind: 'span', synthetic: false };
		body.datasets = [{ dataset: 'Atlas-Span-2007', kind: 'span', version: body.dataset.version, synthetic: false }];
		body.target = null;
		await route.fulfill({ response: res, json: body });
	});
	await openPanel(page, project.id);
	await expect(panel(page)).toContainText('a cross-check only, nothing to use');
	await expect(row(page, 'span').getByRole('cell')).toHaveText(['120', '150', '175', '180', '150', '130', '90', '65', '50', '55', '75', '95', '1\u202f335']);
	// The seeded A-pan row starts at 150 mm: 150 ÷ 120.
	await expect(row(page, 'ratio').getByRole('cell').first()).toHaveText('1.25');
	await expect(panel(page).getByTestId('evaporation-span-note')).toContainText('never written to the project');
	await expect(panel(page).getByRole('button', { name: /^Use / })).toHaveCount(0);
	await expect(row(page, 'proposed')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="evaporation-proposal"]' });
});

test('Demand’s CCWR A-pan grid: not loaded says so with the import command; loaded, it proposes the catchment’s A-pan row', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'CCWR A-pan grid');
	await drawBoundary(page, project.id);
	await page.goto(`/projects/${project.id}?tab=settings`);
	await page.getByTestId('apan-from').selectOption({ label: 'CCWR A-pan grid (catchment average)' });
	const ccwr = page.getByTestId('ccwr-apan-proposal');
	await expect(ccwr.getByTestId('ccwr-apan-body')).toHaveAttribute('data-ready', 'true');
	await expect(ccwr.getByRole('heading', { name: 'CCWR A-pan grid (catchment average)' })).toBeVisible();
	// The e2e server loads no Atlas grid (as production until issue #755): none loaded, not an error, and nothing else proposed.
	await expect(ccwr.getByTestId('ccwr-apan-not-loaded')).toContainText('The CCWR A-pan grid isn’t loaded on this server');
	await expect(ccwr.getByTestId('ccwr-apan-not-loaded').locator('code')).toHaveText('pnpm import:evaporation --apan-asc <jan.asc> … <dec.asc> --dataset Atlas-Apan-2007');
	await expect(ccwr.locator('tr[data-row="proposed"]')).toHaveCount(0);

	// Loaded: the synthetic grid's answer, presented as the Atlas A-pan grid (what the server sends once it is loaded).
	await page.route(/\/evaporation-proposals\?dataset=Atlas-Apan-2007$/, async (route) => {
		const res = await route.fetch({ url: route.request().url().replace('?dataset=Atlas-Apan-2007', '') });
		const body = await res.json();
		body.dataset = { ...body.dataset, dataset: 'Atlas-Apan-2007', kind: 'apan', synthetic: false, firstYear: null, lastYear: null };
		body.datasets = [...body.datasets, { dataset: 'Atlas-Apan-2007', kind: 'apan', version: body.dataset.version, synthetic: false }];
		body.target = 'apan';
		await route.fulfill({ response: res, json: body });
	});
	await page.getByTestId('apan-from').selectOption('typed');
	await page.getByTestId('apan-from').selectOption('ccwr');
	await expect(ccwr.getByTestId('ccwr-apan-body')).toHaveAttribute('data-ready', 'true');
	await expect(ccwr.locator('tr[data-row="proposed"]').getByRole('cell')).toHaveText(['120', '150', '175', '180', '150', '130', '90', '65', '50', '55', '75', '95', '1\u202f335']);
	await expect(ccwr).toContainText('into the A-pan evaporation row');
	await expect(ccwr.getByTestId('evaporation-source')).toContainText('monthly means, no period stated by the source; dataset “Atlas-Apan-2007”');
	// Pinned: no grid picker.
	await expect(ccwr.getByLabel('Grid')).toHaveCount(0);
	await ccwr.getByRole('button', { name: 'Use as the A-pan evaporation row' }).click();
	await answerConfirm(page, false, /Irrigation demand, dam evaporation and, under pan coefficient × A-pan, GR4J will read these 12 monthly values \(1\u202f335 mm a year\) instead of the A-pan row it holds now\./);
	await expectNoViolations(page, { include: '[data-testid="ccwr-apan-proposal"]' });
});
