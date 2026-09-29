// The golden path: a new user builds a catchment from nothing, runs the model
// and reads the results, then keeps going with more catchments, as users with
// many places do.
//
// Four tests, not one journey, so that each has Playwright's 30 s budget to
// itself (issue #138). As one test it was ~165 UI steps: 7 s alone, 15–24 s
// beside five other workers, and past 30 s in 2 of 24 runs under that load,
// with no slow step to blame: the time was spread evenly over the steps (e2e/
// README.md § The golden path). The first test still does the critical path
// through the UI alone: register, create the project, build the network, upload
// rain, flow and daily A-pan, run, read the results. The others
// arrange that same catchment through the API (seedCatchmentD) and drive
// through the UI only what the first leaves out: crops and a transfer into a
// run and each unit's results; the A-pan and EWR into the run's summary, and
// a reload; more catchments beside one with a run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PASSWORD, createProject, createRun, node, putModel, putSeries, seedRunnableProject, uniqueEmail, updateSettings } from '../support/api.ts';
import { plantEmailToken } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';
import { addCrop } from '../support/crops.ts';
import { closeModal, openNodeTable } from '../support/network.ts';
import { agreeToTerms, fillNewPassword } from '../support/signup.ts';
import { openAddData, uploadedNote } from '../support/addData.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name });
const projectRow = (page: Page, name: string) =>
	page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
const runsList = (page: Page) => page.getByRole('region', { name: 'Runs', exact: true });
const runSummary = (page: Page) => page.getByRole('region', { name: 'Run summary' });

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;
const CROP_FACTORS = ['0.55', '0.65', '0.75', '0.8', '0.8', '0.7', '0.6', '0.5', '0.45', '0.45', '0.5', '0.55'];
const APAN_MM = ['155', '185', '225', '235', '195', '165', '115', '85', '65', '65', '85', '115'];
const EWR_M3_DAY = ['2100', '1600', '1100', '1000', '1000', '1400', '2400', '3900', '5100', '5200', '4200', '3100'];

async function createProjectThroughUi(page: Page, name: string) {
	await page.getByRole('button', { name: 'New project' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New project' });
	await dialog.getByLabel('Name').fill(name);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: name })).toBeVisible();
}

/** A fixture CSV's values (second column), for arranging the same series through the API. */
const csvValues = (name: string) =>
	readFileSync(fixture(name), 'utf8')
		.trim()
		.split('\n')
		.slice(1)
		.map((l) => Number(l.split(',')[1]));

/**
 * "Catchment D" as the first test builds it in the UI, arranged through the
 * API: the outlet gauge, Ridge draining into Middle, River, the two dams, and
 * two years of rain and observed flow. `crops` adds the crop, its planted
 * areas and the Ridge → River transfer the crops test enters by hand; `apan`
 * the monthly A-pan the first test enters in Settings.
 */
async function seedCatchmentD(page: Page, { crops, apan }: { crops: boolean; apan: boolean }): Promise<string> {
	const { id } = await createProject(page.request, 'Catchment D');
	const gauge = node('D outlet weir', 'gauge', null, 1, { areaKm2: 5, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const middle = node('Middle farm', 'farm', gauge.id, 3, { areaKm2: 9, damCapacityM3: 80_000, damInitialPct: 0.4 });
	const ridge = node('Ridge farm', 'farm', middle.id, 2, { areaKm2: 12, damCapacityM3: 150_000, damInitialPct: 0.5 });
	const river = node('River farm', 'farm', gauge.id, 4, { areaKm2: 7 });
	const citrus = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: CROP_FACTORS.map(Number) };
	const ha = (n: number) => n * 10_000;
	await putModel(page.request, id, {
		nodes: [gauge, ridge, middle, river],
		crops: crops ? [citrus] : [],
		cropAreas: crops
			? [
					{ nodeId: ridge.id, cropId: citrus.id, areaM2: ha(20) },
					{ nodeId: middle.id, cropId: citrus.id, areaM2: ha(15) },
					{ nodeId: river.id, cropId: citrus.id, areaM2: ha(10) }
				]
			: [],
		transfers: crops
			? [{ id: crypto.randomUUID(), fromNodeId: ridge.id, toNodeId: river.id, months: [11, 12, 1, 2], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0.25, enabled: true, priority: 0 }]
			: []
	});
	if (apan) await updateSettings(page.request, id, { apanMm: APAN_MM.map(Number) });
	const startDate = '2020-10-01';
	await putSeries(page.request, id, { kind: 'rain_catchment_mm', unit: 'mm', startDate, values: csvValues('rainfall-2y.csv') });
	await putSeries(page.request, id, { kind: 'flow_observed_m3s', name: 'D outlet weir', unit: 'm³/s', startDate, values: csvValues('observed-flow-2y.csv') });
	return id;
}

test('a new user builds a catchment through the UI, runs it and reads the results', async ({ page }) => {
	// --- register --------------------------------------------------------------
	await page.goto('/register');
	await page.getByLabel('Display name').fill('Catchment Planner');
	const email = uniqueEmail('planner');
	await page.getByLabel('Email').fill(email);
	await fillNewPassword(page, PASSWORD);
	await agreeToTerms(page);
	await page.getByRole('button', { name: 'Create account' }).click();
	// On to sign-in, until the emailed link confirms the address (issue #57).
	await expect(page.getByRole('status').filter({ hasText: 'Check your email to finish signing up' })).toBeVisible();
	await page.goto(`/verify-email?token=${await plantEmailToken(email, 'verify')}`);
	await expect(page.getByRole('status')).toContainText('is confirmed');
	await page.goto('/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

	// --- a new project ------------------------------------------------------------
	await createProjectThroughUi(page, 'Catchment D');

	// --- network: outflow gauge + three farms, one nested ------------------------
	await tab(page, 'Network').click();
	// This path builds the network in the node table (Grids → Node table).
	const grid = await openNodeTable(page);
	await grid.getByRole('button', { name: 'Add outflow gauge' }).click();
	for (let i = 0; i < 3; i++) await grid.getByRole('button', { name: '+ Add node' }).click();
	const names = page.getByRole('textbox', { name: 'Name' });
	await expect(names).toHaveCount(4);
	await names.nth(0).fill('D outlet weir');
	await names.nth(1).fill('Ridge farm');
	await names.nth(2).fill('Middle farm');
	await names.nth(3).fill('River farm');
	await page.getByLabel('Ridge farm drains into').selectOption({ label: 'Middle farm' });

	const area = (n: string) => page.getByLabel(`Area of ${n}, km²`, { exact: true });
	await area('D outlet weir').fill('5');
	await area('Ridge farm').fill('12');
	await area('Middle farm').fill('9');
	await area('River farm').fill('7');
	await page.getByLabel('Dam capacity of Ridge farm, m³').fill('150000');
	await page.getByLabel('Dam initial storage of Ridge farm, %').fill('50');
	await page.getByLabel('Dam capacity of Middle farm, m³').fill('80000');
	await page.getByLabel('Dam initial storage of Middle farm, %').fill('40');

	// The drainage tree lists each node under the one it drains into: Ridge
	// follows Middle, not the outlet.
	const tree = page.getByRole('list', { name: 'Drainage tree' }).getByRole('listitem');
	await expect(tree).toHaveText([/^D outlet weir/, /^Middle farm/, /^Ridge farm/, /^River farm/]);
	await expect(tree.nth(0)).toContainText('outlet');
	await closeModal(page);

	// --- save the model ------------------------------------------------------------
	const saveBar = page.getByRole('region', { name: 'Unsaved model changes' });
	await expect(saveBar).toContainText('Unsaved changes to the model');
	await saveBar.getByRole('button', { name: 'Save changes' }).click();
	await expect(saveBar).toBeHidden();

	// --- time series: two years of daily rain, observed flow and A-pan ---------
	// The run needs evaporation: here a daily A-pan record (the monthly means in
	// Settings are the other way, which the A-pan and EWR test below takes).
	await tab(page, 'Data').click();
	let upload = await openAddData(page);
	await upload.getByLabel('Kind').selectOption({ label: 'Rainfall — catchment' });
	await upload.getByLabel('CSV file').setInputFiles(fixture('rainfall-2y.csv'));
	await expect(upload.getByRole('definition').nth(0)).toHaveText('2020-10-01 → 2022-09-30');
	await upload.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 730 days to “Rainfall — catchment”.');

	upload = await openAddData(page);
	await upload.getByLabel('Kind').selectOption({ label: 'Flow — observed gauge' });
	await upload.getByLabel('CSV file').setInputFiles(fixture('observed-flow-2y.csv'));
	await upload.getByLabel(/^Name/).fill('D outlet weir');
	await upload.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 730 days to “D outlet weir”.');

	upload = await openAddData(page);
	await upload.getByLabel('Kind').selectOption({ label: 'Evaporation — A-pan, daily' });
	await upload.getByLabel('CSV file').setInputFiles(fixture('apan-2y.csv'));
	await upload.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 730 days to “Evaporation — A-pan, daily”.');
	await expect(page.getByRole('region', { name: 'Input time series' }).getByRole('row')).toHaveCount(4);

	// --- run the model ---------------------------------------------------------------
	await tab(page, 'Runs & results').click();
	await page.getByLabel(/^Run label/).fill('Catchment D baseline');
	// Exact: the uploads' line under the header offers its own "Re-run model".
	await page.getByRole('button', { name: 'Run model', exact: true }).click();

	const runs = runsList(page);
	await expect(runs.getByRole('button', { name: /^Catchment D baseline/ })).toHaveAttribute('aria-current', 'true');
	await expect(runs.getByRole('button', { name: /^Catchment D baseline/ })).toContainText('2020–2022');
	await expect(page.locator('#res-h').locator('..')).toContainText('2020-10-01 → 2022-09-30');

	const summary = runSummary(page);
	await expect(summary.getByRole('heading', { name: 'Catchment' })).toBeVisible();
	// Headline flows in m³/s, with the annual volume and m³/day beneath.
	const stat = (term: string) => summary.getByRole('term').filter({ hasText: term }).locator('xpath=following-sibling::dd[1]');
	await expect(stat('Mean natural flow')).toHaveText(/^[\d\s,.]+m³\/s$/);
	await expect(stat('Mean simulated outflow')).toHaveText(/^[\d\s,.]+m³\/s$/);
	const calibration = page.getByRole('region', { name: 'Calibration against observed flow' });
	await expect(calibration.getByRole('term').filter({ hasText: 'Observations' }).locator('xpath=following-sibling::dd[1]')).toContainText('730 days');

	await expect(page.getByRole('img', { name: /^Catchment · .*: line chart/ }).locator('canvas')).toBeVisible();
});

test('crops and a transfer, entered through the UI, feed a run and each unit’s results', async ({ page, owner }) => {
	void owner;
	const projectId = await seedCatchmentD(page, { crops: false, apan: true });
	await page.goto(`/projects/${projectId}?tab=crops`);

	// --- crops: one crop with monthly factors, planted on every farm -------------
	// + Add crop opens the crop's sheet (name and 12 factors); Edit areas opens the planted-areas grid.
	const sheet = await addCrop(page);
	await sheet.getByRole('textbox', { name: 'Crop name' }).fill('Citrus');
	for (const [i, m] of MONTHS.entries()) await sheet.getByLabel(`Citrus crop factor, ${m}`).fill(CROP_FACTORS[i]!);
	await closeModal(page);
	await page.getByRole('link', { name: 'Edit areas' }).click();
	const areas = page.getByRole('dialog', { name: 'Planted areas' });
	await areas.getByLabel('Citrus on Ridge farm, ha').fill('20');
	await areas.getByLabel('Citrus on Middle farm, ha').fill('15');
	await areas.getByLabel('Citrus on River farm, ha').fill('10');
	await expect(areas.getByRole('row', { name: /^Total/ })).toContainText('45.00 ha');
	await closeModal(page);
	await expect(page.getByTestId('crop-row').filter({ hasText: 'Citrus' })).toContainText('45 ha · peak need in');

	// --- transfers: Ridge → River in summer ------------------------------------
	await tab(page, 'Transfers').click();
	// The section header's main action (issue #17).
	await page.getByTestId('section-header').getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await page.getByLabel('Source of transfer 1').selectOption({ label: 'Ridge farm' });
	await page.getByLabel('Destination of transfer 1').selectOption({ label: 'River farm' });
	for (const m of ['Nov', 'Dec', 'Jan', 'Feb']) await page.getByLabel(`Max rate of transfer 1 in ${m}, m³/s`).fill('0.01');
	await page.getByLabel('Minimum source storage for transfer 1, %').fill('25');

	// --- save the model ------------------------------------------------------------
	const saveBar = page.getByRole('region', { name: 'Unsaved model changes' });
	await expect(saveBar).toContainText('Unsaved changes to the model');
	await saveBar.getByRole('button', { name: 'Save changes' }).click();
	await expect(saveBar).toBeHidden();

	// --- run the model ---------------------------------------------------------------
	await tab(page, 'Runs & results').click();
	await page.getByLabel(/^Run label/).fill('Catchment D with crops');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(runsList(page).getByRole('button', { name: /^Catchment D with crops/ })).toHaveAttribute('aria-current', 'true');

	// --- each unit's results, on Units & supply for the same run (issue #17) ----------
	await page.getByRole('link', { name: 'Hydrological units for this run' }).click();
	const farms = page.getByRole('region', { name: 'Hydrological unit results' }).getByRole('table');
	for (const f of ['Ridge farm', 'Middle farm', 'River farm']) {
		await expect(farms.getByRole('rowheader', { name: new RegExp(`^${f}`) })).toBeVisible();
	}
	await expect(farms.getByRole('rowheader', { name: 'D outlet weir' })).toHaveCount(0);
});

test('A-pan and EWR, entered in Settings, feed the run’s summary, and the run stays selected after a reload', async ({ page, owner }) => {
	void owner;
	const projectId = await seedCatchmentD(page, { crops: true, apan: false });
	await page.goto(`/projects/${projectId}?tab=settings`);

	// --- settings: monthly A-pan and pragmatic EWR -----------------------------
	for (const [i, m] of MONTHS.entries()) {
		await page.getByLabel(`A-pan evaporation, ${m}, mm`).fill(APAN_MM[i]!);
		await page.getByLabel(`Pragmatic EWR, ${m}, m³/day`).fill(EWR_M3_DAY[i]!);
	}
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	// --- run the model ---------------------------------------------------------------
	await tab(page, 'Runs & results').click();
	await page.getByLabel(/^Run label/).fill('Catchment D baseline');
	await page.getByRole('button', { name: 'Run model' }).click();
	const runs = runsList(page);
	await expect(runs.getByRole('button', { name: /^Catchment D baseline/ })).toHaveAttribute('aria-current', 'true');

	const summary = runSummary(page);
	await expect(summary.getByRole('heading', { name: 'Catchment' })).toBeVisible();
	// The plain-words summary above the cards: no rule table, so the pragmatic EWR at the gauge, then the farms. The fit is
	// left to the NSE and PBIAS cards below it (issue #177).
	const lede = summary.getByText(/^Flow at the outflow gauge (was below the EWR on [\d.]+% of days|met the EWR on every day)/);
	await expect(lede).toHaveText(/^Flow at the outflow gauge (was below the EWR on [\d.]+% of days \([\d\s]+ days\)|met the EWR on every day of the run)\. .*hydrological units? got .*\.$/);
	await expect(lede).not.toContainText('Calibration');
	await expect(summary.getByText('Calibration NSE', { exact: true })).toBeVisible();

	// --- reload: the run is stored ---------------------------------------------------
	await page.reload();
	await expect(runs.getByRole('button', { name: /^Catchment D baseline/ })).toHaveAttribute('aria-current', 'true');
	await expect(summary.getByRole('heading', { name: 'Catchment' })).toBeVisible();
});

test('a user with a catchment adds more catchments, and the first still opens with its run', async ({ page, owner }) => {
	void owner;
	const d = await seedRunnableProject(page.request, 'Catchment D');
	await createRun(page.request, d.id, 'Catchment D baseline');
	const main = page.getByRole('navigation', { name: 'Main' });

	await page.goto('/');
	await expect(projectRow(page, 'Catchment D')).toBeVisible();
	await createProjectThroughUi(page, 'Catchment E');
	await main.getByRole('link', { name: 'Projects' }).click();
	await createProjectThroughUi(page, 'Catchment F');
	await main.getByRole('link', { name: 'Projects' }).click();

	for (const name of ['Catchment D', 'Catchment E', 'Catchment F']) {
		await expect(projectRow(page, name).getByTestId('project-role')).toHaveText('owner');
	}
	await expect(page.getByRole('row')).toHaveCount(4);

	// Catchment D still opens with its model and run.
	await projectRow(page, 'Catchment D').getByRole('link', { name: 'Catchment D', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${d.id}(\\?|$)`));
	await tab(page, 'Runs & results').click();
	await expect(runsList(page).getByRole('button', { name: /^Catchment D baseline/ })).toBeVisible();
});
