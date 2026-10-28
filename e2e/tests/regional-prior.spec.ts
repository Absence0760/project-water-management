// Calibration → Fit the parameters → "Regional prior" (issue #622 step 5;
// docs/ui.md § Calibration, docs/model.md §2.10m). An ungauged project (rain
// and A-pan, no flow record) with its boundary on the synthetic soil grid's
// 120 mm cells: the panel shows GR4J's p10–p50–p90 from the synthetic donors
// beside the parameters now, the donors kept, the leave-one-out skill and the
// donor set's credit. "Start from the prior" asks first, then saves the
// medians as one settings revision naming the donors; the form takes them and
// the panel says they are started. A viewer reads it but can't start it, and a
// project with no boundary is told to draw one. The tables are read, never the
// map. Invented data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, putSeries, sampleModel, seedRunnableProject, syntheticRain, updateSettings } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { loadSyntheticPrior } from '../support/gr4jPrior.ts';
import { box } from '../support/map.ts';
import { anySaveBar, openFold } from '../support/settings.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('regional-prior');

/** Calibration with the prior panel's answer loaded. */
async function openPanel(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=calibration`);
	await expect(panel(page).getByTestId('prior-body')).toHaveAttribute('data-ready', 'true');
}

/** A project with no flow record: the model, A-pan, and two whole water years of rain (2019/20 has 366 days). */
async function ungauged(page: Page, name: string, boundary = true) {
	const project = await createProject(page.request, name);
	await putModel(page.request, project.id, sampleModel());
	await updateSettings(page.request, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(731) });
	if (boundary) {
		// Over the synthetic soil grid's four 120 mm cells (21.26–21.44° E, 33.74–33.56° S), among the synthetic donors.
		const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
			data: { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [box(21.26, -33.74, 0.18)] } }
		});
		expect(made.status(), await made.text()).toBe(201);
	}
	return project;
}

test.beforeAll(async () => {
	await loadSyntheticPrior();
});

test('an editor starts an ungauged project’s GR4J from the regional prior; History names the donors; a viewer can’t', async ({ page, owner, signIn }) => {
	void owner;
	const project = await ungauged(page, 'Regional prior');
	await openPanel(page, project.id);
	await expect(panel(page).getByTestId('prior-synthetic')).toContainText('Synthetic test data.');
	await expect(panel(page).getByTestId('prior-skill')).toContainText(/^Skill: \d\.\d\d \(leave-one-out over 14 donors\)$/);
	await expect(panel(page).getByTestId('prior-no-skill')).toHaveCount(0);
	const ranges = panel(page).getByTestId('prior-ranges');
	await expect(ranges.getByRole('row')).toHaveCount(5);
	// X1's range is the soil relation's at the boundary's 120 mm (the synthetic donors' x1 ≈ 1.9 × PAWC).
	await expect(ranges.getByRole('rowheader').first()).toContainText('from soil water capacity');
	await expect(panel(page)).toContainText('7 of 14 donors from “synthetic” (invented donors)');
	await expect(panel(page)).toContainText('distance from the catchment boundary’s centre');
	await panel(page).getByText('The 7 donors').click();
	await expect(panel(page).getByTestId('prior-donors').getByRole('row')).toHaveCount(8);
	await expect(panel(page).getByTestId('prior-credits')).toContainText('Synthetic test data (this repository) ');
	// Fit automatically has no record to fit to here: the prior is the start.
	await expect(page.getByTestId('fit-no-record')).toBeVisible();

	const p50 = Number((await ranges.getByRole('row').nth(1).getByRole('cell').nth(1).innerText()).replace(/\s/g, ''));
	const start = panel(page).getByRole('button', { name: 'Start from the prior' });
	await expect(start).toHaveAccessibleDescription('Saves now');
	await start.click();
	// Cancel changes nothing.
	await answerConfirm(page, false, 'Start GR4J from the regional prior?');
	await expect(panel(page).getByTestId('prior-started')).toHaveCount(0);
	await start.click();
	await answerConfirm(page, true, /into the catchment’s GR4J parameters and saves them now, as a settings revision naming the 7 donors\. They are not calibrated/);
	await expect(panel(page).getByTestId('prior-notice')).toHaveText('GR4J’s parameters for the catchment now start from the regional prior’s medians, saved as a settings revision. Run the model to see its effect.');
	await expect(panel(page).getByTestId('prior-notice')).toBeFocused();
	await expect(panel(page).getByTestId('prior-started')).toContainText('the donors’ medians, not a fit');
	await expect(panel(page).getByRole('button', { name: 'Start from the prior' })).toHaveCount(0);
	// The form took the saved settings, and nothing is unsaved.
	await expect(anySaveBar(page)).toHaveCount(0);
	const settings = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings;
	expect(Math.round(settings.gr4j.x1)).toBe(p50);
	expect(settings.gr4jPrior[0].provenance).toMatchObject({ dataset: 'synthetic', donorCount: 14, target: { zoneNodeId: null, units: null } });
	await expectNoViolations(page, { include: '[data-testid="regional-prior"]' });

	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').nth(0)).toContainText(/GR4J’s parameters started from the regional prior: X1 \d+ mm, X3 [\d.]+ mm, X4 [\d.]+ days, the medians of 7 donor basins of donor set “synthetic”/);

	// A viewer reads it and has no Start; on a phone nothing scrolls sideways.
	const viewer = await signIn('Prior viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 390, height: 844 });
	await openPanel(v, project.id);
	await expect(panel(v).getByTestId('prior-ranges')).toBeVisible();
	await expect(panel(v).getByRole('button', { name: 'Start from the prior' })).toHaveCount(0);
	await expectNoSidewaysScroll(v);
});

test('a project with no boundary is told to draw one', async ({ page, owner }) => {
	void owner;
	const project = await ungauged(page, 'Regional prior, no boundary', false);
	await openPanel(page, project.id);
	await expect(panel(page).getByTestId('prior-problem')).toContainText('There is no catchment boundary on the map');
	await expect(panel(page).getByRole('button', { name: 'Start from the prior' })).toHaveCount(0);
});

test('Fit automatically uses the prior as a penalty and its box, and the fit record names it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Regional prior fit');
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [box(21.26, -33.74, 0.18)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await openPanel(page, project.id);
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await fit.getByLabel(/^Regional prior/).selectOption('both');
	await expect(fit.getByLabel('Penalty weight')).toHaveValue('0.1');
	await openFold(fit, 'fit-search');
	// The prior's box sets the Bounds choice aside.
	await expect(fit.getByLabel(/^Bounds/)).toBeDisabled();
	await expect(fit.getByTestId('fit-search-summary')).toContainText('Regional prior (p10–p90) bounds');
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByLabel('Starts').fill('1');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	await expect(fit.getByText(/Regional prior \(p10–p90\) bounds · seed 1/)).toBeVisible();
	await expect(fit.getByText(/The fit used the regional GR4J prior from 7 donor basins of 14 \(synthetic, invented donors\): a penalty of weight 0\.1 pulled the parameters toward its medians, and the search kept to its p10–p90 box\./)).toBeVisible();
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	const record = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(record.getByTestId('fit-prior')).toContainText(/Regional prior: penalty weight 0\.10, searched its p10–p90 box; 7 of 14 donors from “synthetic” \(invented donors\), SHA-256 [0-9a-f]{12}…/);
});
