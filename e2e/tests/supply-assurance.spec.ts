// Assurance of supply, stress classes and the water account (engine 0.32.0,
// WP-3.4) on a synthetic run: assurance of supply on Units & supply and the
// water account on River & reserve, both reached from the run on Runs &
// results (issue #17; docs/ui.md § Assurance of supply).
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('a run shows each farm’s reliability, the stress grid with class names, and a water account that closes', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assurance');
	await createRun(page.request, project.id, 'Assured');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Assured' })).toBeVisible();

	// Assurance of supply moved to Units & supply (issue #17): the Runs page links there for this run.
	await page.getByRole('navigation', { name: 'Outcomes for this run' }).getByRole('link', { name: 'Hydrological units for this run' }).click();
	await expect(page).toHaveURL(/[?&]tab=supply&run=/);
	const assurance = page.getByRole('region', { name: 'Assurance of supply', exact: true });
	const reliability = assurance.getByTestId('reliability-table');
	await expect(reliability.getByRole('rowheader')).toHaveText(['Upper farm', 'Lower farm']);
	// Every metric is a percentage (or – without demand), never blank.
	for (const row of await reliability.getByRole('row').filter({ has: page.getByRole('rowheader') }).all()) {
		await expect(row.getByRole('cell').nth(0)).toHaveText(/^(\d+(\.\d)?%|–)$/);
		await expect(row.getByRole('cell').nth(1)).toHaveText(/^(\d+(\.\d)?%|–)$/);
	}
	// 120 days from 2021-10-01: one water year row; every simulated month carries a class name or is blank (no demand).
	const grid = assurance.getByTestId('stress-grid');
	await expect(grid.getByRole('rowheader')).toHaveText(['2021/22']);
	await expect(grid).toContainText(/\b(Low|Mod|High|Sev|Crit)\b/);
	await assurance.getByLabel('Show').selectOption({ label: 'Upper farm' });
	await expect(grid.getByRole('caption')).toContainText('Upper farm');

	// The water account moved to River & reserve (issue #17): the Runs page links there for this run.
	await page.goBack();
	await page.getByRole('navigation', { name: 'Outcomes for this run' }).getByRole('link', { name: 'River & reserve for this run' }).click();
	await expect(page).toHaveURL(/[?&]tab=river&run=/);
	const account = page.getByRole('region', { name: 'Water account' });
	const table = account.getByTestId('account-table');
	await expect(table.getByRole('columnheader')).toHaveText(['m³', '2021/22', 'Whole run']);
	for (const name of ['In: Natural flow', 'Out: Consumptive irrigation', 'Out: Outflow at the outlet', 'Change in dam storage', 'Residual (in − out − change in storage)']) {
		await expect(table.getByRole('rowheader', { name, exact: true })).toBeVisible();
	}
	// The residual is float noise: printed to two significant figures, it is 0 or tiny.
	const residual = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Residual (in − out − change in storage)' }) });
	for (const cell of await residual.getByRole('cell').all()) await expect(cell).toHaveText(/^(-?0(\.0)?|-?\d\.\de-\d+)$/);
	await expect(account.getByTestId('account-bars')).toContainText('Natural flow');
	// The outlet's EWR required vs met: under the EWR by month grid, with the compliance findings, not in the water
	// account, whose balance it isn't part of (issue #175).
	await expect(account.getByRole('heading', { name: /EWR required vs met/ })).toHaveCount(0);
	const required = page.locator('#res-ewr-grid').getByRole('region', { name: 'EWR required vs met, each water year' });
	const met = required.getByTestId('ewr-required-met');
	await expect(met.getByRole('columnheader')).toHaveText(['Site', '2021/22', 'Whole run']);
	await expect(met.getByRole('rowheader')).toHaveText(['Outflow gauge (outlet)']);
	for (const cell of await met.getByRole('cell').all()) await expect(cell).toHaveText(/^\d+(\.\d)?% of [\d.\u202f]+ (m³|Mm³); [\d\u202f]+ days short$/);
	await expect(required).toContainText('Met = the part of the requirement that passed the site');
});

test('a unit’s detail and its dam on the Dams page carry the unit’s reliability and stress by month (issue #444)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assurance where you look');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	await createRun(page.request, project.id, 'Assured');

	// Hydrological units → the picked unit: its reliability in one line, then a strip of twelve months.
	await page.goto(`/projects/${project.id}?tab=supply&unit=${upper.id}`);
	const unit = page.locator('#res-farm').getByRole('region', { name: 'Assurance of supply: Upper farm' });
	await expect(unit.getByTestId('node-reliability')).toHaveText(/^[\d.]+% of demand days fully met · [\d.]+% of the demand volume supplied \(2021-10-01 to 2022-01-28\)$/);
	const strip = unit.getByTestId('node-stress-strip');
	const cells = strip.getByRole('listitem');
	await expect(cells).toHaveCount(12);
	// 120 days from 1 October: October … January have demand and a class name; February … September don't.
	for (let m = 0; m < 4; m++) await expect(cells.nth(m)).toContainText(/(Low|Moderate|High|Severe|Critical) stress, [\d.]+% of demand supplied/);
	for (let m = 4; m < 12; m++) await expect(cells.nth(m)).toContainText('no demand');
	await expect(unit).toContainText(/Over the whole run: \d+ (Low|Moderate|High|Severe|Critical)/);
	const figures = (await unit.getByTestId('node-reliability').textContent())!.trim();
	// Every year's grid is in Assurance of supply below, opened on this unit.
	await unit.getByTestId('unit-assurance-link').click();
	await expect(page).toHaveURL(/#res-assurance$/);
	const panel = page.locator('#res-assurance').getByRole('region', { name: 'Assurance of supply' });
	await expect(panel.getByLabel('Show')).toHaveValue(upper.id as string);
	await expect(panel.getByTestId('stress-grid').getByRole('caption')).toContainText('Upper farm');

	// The Dams page: the picked dam's unit, labelled as the unit's supply, linking back to the unit.
	await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
	const dam = page.getByRole('region', { name: /^Storage/ }).getByRole('region', { name: 'Assurance of supply: Upper farm' });
	await expect(dam).toContainText('The hydrological unit\'s supply, which this dam serves: a dam has no assurance of supply of its own.');
	// The same figures as the unit's detail: the dam has none of its own.
	await expect(dam.getByTestId('node-reliability')).toHaveText(figures);
	await expect(dam.getByTestId('node-stress-strip').getByRole('listitem')).toHaveCount(12);
	await dam.getByTestId('dam-unit-link').click();
	await expect(page).toHaveURL(new RegExp(`[?&]tab=supply&run=[^&]+&unit=${upper.id}#res-farm$`));
	await expect(page.locator('#res-farm').getByRole('heading', { level: 2 })).toContainText('Upper farm');
});
