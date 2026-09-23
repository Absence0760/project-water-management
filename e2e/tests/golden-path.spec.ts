// The golden path: a new user builds a catchment from nothing, purely through
// the UI (no API shortcuts), runs the model and reads the results — then keeps
// going with more catchments, as users with many places do.
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PASSWORD, uniqueEmail } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name });
const projectRow = (page: Page, name: string) =>
	page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;
const CROP_FACTORS = ['0.55', '0.65', '0.75', '0.8', '0.8', '0.7', '0.6', '0.5', '0.45', '0.45', '0.5', '0.55'];
const APAN_MM = ['155', '185', '225', '235', '195', '165', '115', '85', '65', '65', '85', '115'];
const EWR_M3_DAY = ['2100', '1600', '1100', '1000', '1000', '1400', '2400', '3900', '5100', '5200', '4200', '3100'];

async function createProjectThroughUi(page: Page, name: string) {
	await page.getByRole('button', { name: 'New project' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New project' });
	await dialog.getByLabel('Name').fill(name);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('a new user builds a catchment, runs it, and adds more catchments', async ({ page }) => {
	// --- register --------------------------------------------------------------
	await page.goto('/register');
	await page.getByLabel('Display name').fill('Catchment Planner');
	await page.getByLabel('Email').fill(uniqueEmail('planner'));
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

	// --- a new project ------------------------------------------------------------
	await createProjectThroughUi(page, 'Catchment D');
	const projectUrl = page.url();

	// --- network: outflow gauge + three farms, one nested ------------------------
	await tab(page, 'Network').click();
	await page.getByRole('button', { name: 'Add outflow gauge' }).click();
	for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '+ Add node' }).click();
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

	// --- crops: one crop with monthly factors, planted on every farm -------------
	await tab(page, 'Crops').click();
	await page.getByRole('button', { name: 'Add crop' }).click();
	await page.getByRole('textbox', { name: 'Crop name' }).fill('Citrus');
	for (const [i, m] of MONTHS.entries()) await page.getByLabel(`Citrus crop factor, ${m}`).fill(CROP_FACTORS[i]!);
	await page.getByLabel('Citrus on Ridge farm, m²').fill('200000');
	await page.getByLabel('Citrus on Middle farm, m²').fill('150000');
	await page.getByLabel('Citrus on River farm, m²').fill('100000');
	await expect(page.getByRole('row', { name: /^Total/ })).toContainText('45.00 ha');

	// --- transfers: Ridge → River in summer ------------------------------------
	await tab(page, 'Transfers').click();
	await page.getByRole('button', { name: 'Add transfer' }).click();
	await page.getByLabel('Source of transfer 1').selectOption({ label: 'Ridge farm' });
	await page.getByLabel('Destination of transfer 1').selectOption({ label: 'River farm' });
	const months = page.getByRole('group', { name: /^Months transfer 1 runs/ });
	for (const m of ['Nov', 'Dec', 'Jan', 'Feb']) await months.getByRole('checkbox', { name: new RegExp(`${m}$`) }).check();
	await page.getByLabel('Max rate of transfer 1, m³/s').fill('0.01');
	await page.getByLabel('Minimum source storage for transfer 1, %').fill('25');

	// --- save the model ------------------------------------------------------------
	const saveBar = page.getByRole('region', { name: 'Unsaved model changes' });
	await expect(saveBar).toContainText('Unsaved changes to the model');
	await saveBar.getByRole('button', { name: 'Save changes' }).click();
	await expect(saveBar).toBeHidden();

	// --- settings: monthly A-pan and pragmatic EWR -----------------------------
	await tab(page, 'Settings').click();
	for (const [i, m] of MONTHS.entries()) {
		await page.getByLabel(`A-pan evaporation, ${m}, mm`).fill(APAN_MM[i]!);
		await page.getByLabel(`Pragmatic EWR, ${m}, m³/day`).fill(EWR_M3_DAY[i]!);
	}
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	// --- time series: two years of daily rain and observed flow ----------------
	await tab(page, 'Time series').click();
	const upload = page.getByRole('region', { name: 'Upload CSV' });
	await upload.getByLabel('Kind').selectOption({ label: 'Rainfall — catchment' });
	await upload.getByLabel('CSV file').setInputFiles(fixture('rainfall-2y.csv'));
	await expect(upload.getByRole('definition').nth(0)).toHaveText('2020-10-01 → 2022-09-30');
	await upload.getByRole('button', { name: 'Upload' }).click();
	await expect(upload.getByRole('status')).toHaveText('Uploaded 730 days to “Rainfall — catchment”.');

	await upload.getByLabel('Kind').selectOption({ label: 'Flow — observed gauge' });
	await upload.getByLabel('CSV file').setInputFiles(fixture('observed-flow-2y.csv'));
	await upload.getByLabel(/^Name/).fill('D outlet weir');
	await upload.getByRole('button', { name: 'Upload' }).click();
	await expect(upload.getByRole('status')).toHaveText('Uploaded 730 days to “D outlet weir”.');
	await expect(page.getByRole('region', { name: 'Input time series' }).getByRole('row')).toHaveCount(3);

	// --- run the model ---------------------------------------------------------------
	await tab(page, 'Runs').click();
	await page.getByLabel(/^Run label/).fill('Catchment D baseline');
	await page.getByRole('button', { name: 'Run model' }).click();

	const runs = page.getByRole('region', { name: 'Runs' });
	await expect(runs.getByRole('button', { name: /^Catchment D baseline/ })).toHaveAttribute('aria-current', 'true');
	await expect(runs.getByRole('button', { name: /^Catchment D baseline/ })).toContainText('2020-10-01 → 2022-09-30');

	const summary = page.getByRole('region', { name: 'Run summary' });
	await expect(summary.getByRole('heading', { name: 'Catchment' })).toBeVisible();
	const stat = (term: string) => summary.getByRole('term').filter({ hasText: term }).locator('xpath=following-sibling::dd');
	await expect(stat('Mean natural flow')).toHaveText(/^[\d\s,.]+m³\/day$/);
	await expect(stat('Mean simulated outflow')).toHaveText(/^[\d\s,.]+m³\/day$/);
	await expect(stat('Overlapping days')).toHaveText('730');

	const farms = summary.getByRole('table');
	for (const f of ['Ridge farm', 'Middle farm', 'River farm']) {
		await expect(farms.getByRole('rowheader', { name: new RegExp(`^${f}`) })).toBeVisible();
	}
	await expect(farms.getByRole('rowheader', { name: 'D outlet weir' })).toHaveCount(0);
	await expect(page.getByRole('img', { name: /^Catchment · .*: line chart/ }).locator('canvas')).toBeVisible();

	// --- reload: the run is stored ---------------------------------------------------
	await page.reload();
	await expect(runs.getByRole('button', { name: /^Catchment D baseline/ })).toHaveAttribute('aria-current', 'true');
	await expect(summary.getByRole('rowheader', { name: /^Ridge farm/ })).toBeVisible();

	// --- more catchments for the same user ----------------------------------
	await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Projects' }).click();
	await expect(projectRow(page, 'Catchment D')).toBeVisible();
	await createProjectThroughUi(page, 'Catchment E');
	await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Projects' }).click();
	await createProjectThroughUi(page, 'Catchment F');
	await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Projects' }).click();

	for (const name of ['Catchment D', 'Catchment E', 'Catchment F']) {
		await expect(projectRow(page, name).getByRole('cell').nth(1)).toHaveText('owner');
	}
	await expect(page.getByRole('row')).toHaveCount(4);

	// Catchment D still opens with its model and run.
	await projectRow(page, 'Catchment D').getByRole('link', { name: 'Catchment D' }).click();
	await expect(page).toHaveURL(projectUrl);
	await tab(page, 'Runs').click();
	await expect(runs.getByRole('button', { name: /^Catchment D baseline/ })).toBeVisible();
});
