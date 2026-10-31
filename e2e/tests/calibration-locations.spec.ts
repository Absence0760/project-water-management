// Calibration locations (issue #659, engine 1.110.0; docs/ui.md § Settings &
// calibration, docs/model.md §2.10n): the outlet and every gauge with a record
// are equals in one table, none required. With none ticked every unit runs on
// the catchment parameters and the page says so; each ticked location keeps its
// own period; the headline gives the run's statistics; the fit runs in
// dependency order and Apply writes every location; a flow record not placed in
// the network is flagged with a link to its Measured at. Replaces
// calibration-site.spec.ts and calibration-zones.spec.ts. Names and numbers are
// invented.
//
// The saves here send settings.calibrateAtOutlet, calibrationRest and the
// headline pointer: they need the API to accept them (slice B of issue #659).
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { addMember, calibratedAtGauge, createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFold, saveSettings } from '../support/settings.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

const DAYS = 120;
const APAN = [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110];

/** Outflow gauge ← Middle weir ← Upper farm; Outflow gauge ← Low weir ← Side farm; Outflow gauge ← Lower farm. */
async function seed(request: APIRequestContext, name: string, opts: { outletRecord: boolean }) {
	const project = await createProject(request, name);
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const low = node('Low weir', 'gauge', outlet.id, 3, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const upper = node('Upper farm', 'farm', weir.id, 4, { areaKm2: 12, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const side = node('Side farm', 'farm', low.id, 5, { areaKm2: 6, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const lower = node('Lower farm', 'farm', outlet.id, 6, { areaKm2: 20, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const model: Model = { nodes: [outlet, weir, low, upper, side, lower], crops: [], cropAreas: [], transfers: [] };
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, { runoffModel: 'gr4j', apanMm: APAN });
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(DAYS) });
	if (opts.outletRecord) await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: 'Outlet record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS) });
	for (const [rec, at, f] of [
		['Weir record', weir.id, 0.4],
		['Low weir record', low.id, 0.2]
	] as const) {
		await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: rec, unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS).map((v) => v * f) });
		const id = await seriesId(request, project.id, rec);
		expect((await request.patch(`${API_URL}/projects/${project.id}/series/${id}`, { data: { siteNodeId: at } })).status()).toBe(200);
	}
	return { project, outlet, weir, low, upper, side, lower };
}

async function seriesId(request: APIRequestContext, projectId: string, name: string): Promise<string> {
	const list = (await (await request.get(`${API_URL}/projects/${projectId}/series`)).json()).series as { id: string; name: string }[];
	return list.find((s) => s.name === name)!.id;
}

const stored = async (request: APIRequestContext, projectId: string) => (await (await request.get(`${API_URL}/projects/${projectId}`)).json()).project.settings;
const locations = (page: Page) => page.getByTestId('calibration-locations');
const row = (page: Page, name: string) => locations(page).getByTestId('calibration-location-row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${name}`) }) });
const zoneFold = (page: Page, name: string) => locations(page).getByTestId('calibration-zone-fold').filter({ hasText: `${name}:` });
async function openZoneFold(fold: Locator) {
	if ((await fold.getAttribute('open')) === null) await fold.locator(':scope > summary').click();
	await expect(fold).toHaveAttribute('open', '');
}

test('a new project’s outlet is ticked before it has a record: the row and the fit say why; unticked, none is calibrated and a run still runs', async ({ page, owner }) => {
	void owner;
	const { project } = await seed(page.request, 'Locations none', { outletRecord: false });
	await page.goto(`/projects/${project.id}?tab=calibration`);
	// A new project is created with the outlet ticked (slice B): its row shows, with no record yet.
	await expect(locations(page).getByTestId('calibration-location-row')).toHaveCount(3);
	const outletTick = locations(page).getByRole('checkbox', { name: 'Calibrate here: Outflow gauge' });
	await expect(outletTick).toBeChecked();
	await expect(row(page, 'Outflow gauge').getByTestId('calibration-location-problem')).toHaveText(
		'Can’t be fitted: no flow record at the outlet yet. Add one on Data, or untick it.'
	);
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await expect(fit.getByTestId('fit-plan-error')).toContainText('The outlet has no flow record yet');
	await expect(fit.getByRole('button', { name: 'Fit automatically', exact: true })).toBeDisabled();
	await expectNoViolations(page);

	// Unticked: with no record the outlet leaves the table, and no location is calibrated; the page and the fit say so.
	// A click, not uncheck(): there is no box left to see unchecked.
	await outletTick.click();
	await expect(locations(page).getByTestId('calibration-location-row')).toHaveCount(2);
	await expect(page.getByTestId('calibration-none')).toHaveText(
		'No location is calibrated: every unit runs on the catchment parameters (GR4J parameters, above). Tick Calibrate here at a location to fit it.'
	);
	await expect(page.getByTestId('summary-record')).toContainText('No location calibrated');
	await expect(fit.getByTestId('fit-plan-error')).toContainText('No location is calibrated');
	await expect(fit.getByRole('button', { name: 'Fit automatically', exact: true })).toBeDisabled();
	await saveSettings(page);
	expect((await stored(page.request, project.id)).calibrateAtOutlet).toBe(false);
	// Zero ticked is allowed: a run runs on the catchment parameters.
	const runId = await createRun(page.request, project.id, 'None calibrated');
	expect(runId).toBeTruthy();
});

test('the outlet and a gauge each keep their own period; the headline picks whose statistics a run reports', async ({ page, owner }) => {
	void owner;
	const { project, weir } = await seed(page.request, 'Locations periods', { outletRecord: true });
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(row(page, 'Outflow gauge')).toContainText('(outlet)');
	await expect(locations(page).getByRole('checkbox', { name: 'Calibrate here: Outflow gauge' })).toBeChecked();
	await locations(page).getByRole('checkbox', { name: 'Calibrate here: Middle weir' }).check();
	await expect(page.getByTestId('calibration-locations-ticked')).toContainText('Fit automatically fits 2 locations. Headline: Outflow gauge (picked automatically');
	await expect(locations(page).getByTestId('calibration-headline-auto')).toHaveCount(1);
	// The outlet's period is its fields under the table; the weir's is in its fold.
	const outletFrom = page.getByRole('group', { name: 'Calibration window', exact: true }).getByLabel('From', { exact: true });
	await outletFrom.fill('2021-10-15');
	await outletFrom.press('Enter');
	await expect(outletFrom).toHaveValue('15 Oct 2021');
	const fold = zoneFold(page, 'Middle weir');
	await openZoneFold(fold);
	await fold.getByLabel('From', { exact: true }).fill('2021-11-01');
	await fold.getByLabel('From', { exact: true }).press('Enter');
	await expect(fold.getByLabel('From', { exact: true })).toHaveValue('1 Nov 2021');
	// The weir as the headline.
	await row(page, 'Middle weir').getByRole('radio', { name: 'Headline: Middle weir' }).check();
	await expect(page.getByTestId('calibration-locations-ticked')).toContainText('Headline: Middle weir.');
	await saveSettings(page);
	const saved = await stored(page.request, project.id);
	expect(saved.calibrateAtOutlet).toBe(true);
	expect(saved.calibrationStart).toBe('2021-10-15');
	expect(saved.calibrationSiteNodeId).toBe(weir.id);
	expect(saved.calibrationZones).toEqual([expect.objectContaining({ nodeId: weir.id, enabled: true, calibrationStart: '2021-11-01' })]);

	// After a reload each keeps its own period.
	await page.reload();
	await expect(page.getByRole('group', { name: 'Calibration window', exact: true }).getByLabel('From', { exact: true })).toHaveValue('15 Oct 2021');
	await openZoneFold(zoneFold(page, 'Middle weir'));
	await expect(zoneFold(page, 'Middle weir').getByLabel('From', { exact: true })).toHaveValue('1 Nov 2021');
	await expect(row(page, 'Middle weir').getByRole('radio', { name: 'Headline: Middle weir' })).toBeChecked();
	await expectNoViolations(page);

	// A run reports the headline's statistics: the weir's record, on its own period.
	const runId = await createRun(page.request, project.id, 'Headline at the weir');
	await page.goto(`/projects/${project.id}?tab=calibration&run=${runId}`);
	await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', runId);
	await expect(page.getByTestId('calibration-compared-with')).toContainText('at the gauge “Middle weir”');
	// Back to auto: the outlet again.
	await page.getByRole('radio', { name: 'Pick the headline automatically' }).check();
	await expect(page.getByTestId('calibration-locations-ticked')).toContainText('Headline: Outflow gauge (picked automatically');
});

test('Fit automatically fits each ticked location in dependency order, and Apply writes each one', async ({ page, owner }) => {
	void owner;
	const { project, weir, upper } = await seed(page.request, 'Locations fit', { outletRecord: true });
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await locations(page).getByRole('checkbox', { name: 'Calibrate here: Middle weir' }).check();
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	// The order before anything runs: the weir, then the outlet after it.
	await expect(fit.getByTestId('fit-plan-step')).toHaveText(['Middle weir', 'Outflow gauge (headline), after Middle weir']);
	await openFold(fit, 'fit-search');
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByLabel('Starts').fill('1');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	const steps = fit.getByTestId('fit-steps').getByTestId('fit-step');
	await expect(steps).toHaveCount(2);
	await expect(steps.nth(0)).toContainText('1. Location');
	await expect(steps.nth(0)).toContainText('Middle weir');
	await expect(steps.nth(1)).toContainText('2. Headline');
	await expect(steps.nth(1)).toContainText('after Middle weir');
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	await expect(row(page, 'Middle weir')).not.toContainText('Not fitted yet');
	await saveSettings(page);
	const after = await stored(page.request, project.id);
	expect(after.calibrationZones[0].gr4j).toEqual(expect.objectContaining({ x1: expect.any(Number) }));
	expect(after.calibrationZones[0].fitRecord.zone).toEqual(expect.objectContaining({ nodeId: weir.id, units: [upper.id] }));
	expect(after.fitRecord).toEqual(expect.objectContaining({ engineVersion: expect.any(String) }));
	await expectNoViolations(page);
});

test('a flow record not placed in the network is flagged, and its link opens it on the Data page', async ({ page, owner }) => {
	void owner;
	const { project } = await seed(page.request, 'Locations unplaced', { outletRecord: true });
	// A second outlet record of the same kind: a run reads only the first by name ("Outlet record").
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Second outlet record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS) });
	const id = await seriesId(page.request, project.id, 'Second outlet record');
	await page.goto(`/projects/${project.id}?tab=calibration`);
	const flag = page.getByTestId('calibration-unplaced');
	await expect(flag.getByTestId('calibration-unplaced-record')).toHaveCount(1);
	await expect(flag).toContainText('Second outlet record: it is a second outlet record of its kind, and a run reads only the first by name.');
	await expectNoViolations(page, { include: '[data-testid="calibration-unplaced"]' });
	await flag.getByRole('link', { name: 'Second outlet record' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=series&series=${id}#data-chart$`));
	await expect(page.getByTestId('series-unplaced')).toContainText('Not placed in the network, so no calibration location can be fitted on it');
	await expect(page.getByTestId('series-unplaced')).toContainText('Set its Measured at, on Data, to a gauge inside the network.');
});

test('a viewer reads the locations and the unplaced record, with nothing to tick and no advice to act on', async ({ page, owner, signIn }) => {
	void owner;
	const { project } = await seed(page.request, 'Locations viewer', { outletRecord: true });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Second outlet record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS) });
	const viewer = await signIn('Locations viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(locations(viewer.page).getByRole('checkbox', { name: 'Calibrate here: Middle weir' })).toBeDisabled();
	await expect(locations(viewer.page).getByRole('radio', { name: 'Pick the headline automatically' })).toBeDisabled();
	await expect(locations(viewer.page).getByLabel('Units with no ticked location downstream take')).toBeDisabled();
	await expect(viewer.page.getByTestId('calibration-unplaced')).toBeVisible();
	await expect(viewer.page.getByTestId('calibration-unplaced')).not.toContainText('Set its Measured at');
	await expectNoViolations(viewer.page, { include: '#set-record' });
});

test('on a phone the locations table scrolls in its box, never the page', async ({ page, owner }) => {
	void owner;
	const { project } = await seed(page.request, 'Locations phone', { outletRecord: true });
	await resizeTo(page, { width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await locations(page).getByRole('checkbox', { name: 'Calibrate here: Middle weir' }).check();
	await expect(page.getByTestId('calibration-locations-ticked')).toContainText('2 locations');
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page, { include: '#set-record' });
});

test('a ticked gauge that lost its record says it can’t be fitted, and can still be unticked', async ({ page, owner }) => {
	void owner;
	const { project, weir } = await seed(page.request, 'Locations record gone', { outletRecord: true });
	// Calibrated at the weir alone, its headline, then its record moved back to the outlet.
	await updateSettings(page.request, project.id, calibratedAtGauge(weir.id));
	const rec = await seriesId(page.request, project.id, 'Weir record');
	expect((await page.request.patch(`${API_URL}/projects/${project.id}/series/${rec}`, { data: { siteNodeId: null } })).status()).toBe(200);

	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(row(page, 'Middle weir')).toContainText('Can’t be fitted: it has no flow record.');
	const tick = locations(page).getByRole('checkbox', { name: 'Calibrate here: Middle weir' });
	await expect(tick).toBeChecked();
	// Still a location (a run gives its units its parameters), and the headline, so it can't be fitted until it has a record.
	await expect(page.getByTestId('calibration-locations-ticked')).toContainText('Headline: Middle weir.');
	// A click, not uncheck(): unticked, the row leaves the table, so there is no box left to see unchecked.
	await tick.click();
	// Unticked, with no record it leaves the table, and nothing is ticked.
	await expect(row(page, 'Middle weir')).toHaveCount(0);
	await expect(page.getByTestId('calibration-none')).toBeVisible();
});
