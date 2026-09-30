// The self-checks panel (engine 0.12.0): the model's checks on its own run,
// the water balance's closure by water year (the table is its own Model
// quality section since issue #137, linked from the self-checks, and links to
// River & reserve's Water account, which links back), and the trace of one farm's day
// with its working columns (docs/ui.md § Self-checks).
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('a run shows its self-checks, its water balance and a traced day that closes', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Self-checks');
	await createRun(page.request, project.id, 'Checked');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Checked' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Self-checks' }).click();

	const checks = page.getByRole('region', { name: /^Self-checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'self-checks' })).toHaveText('All 13 self-checks passed.'); // the 7th: EWR attribution (engine 0.17.0, audit Q17); the 8th: groundwater (0.23.0, WP-1.34); the 9th: land cover (0.24.0, WP-1.35); the 10th: registered volumes (1.18.0, issue #72); the 11th: operating rules (1.32.0, issue #204); the 12th: the assurance of supply (1.34.0, issue #192); the 13th: the drought restriction rule (1.52.0, WP-3.8)
	await expect(checks.getByRole('listitem')).toHaveCount(13);
	// The workspace's word: the engine's "farm" reads "unit" (#54), and the checks say which engine made them.
	await expect(checks.getByRole('listitem').first()).toContainText('Every hydrological unit balances every day');
	await expect(checks.getByRole('listitem').filter({ hasText: /\bfarms?\b/i })).toHaveCount(0);
	await expect(checks.getByTestId('checks-engine')).toHaveText(/^Checked by engine \d+\.\d+\.\d+ when the run was made\.$/);

	// The water balance has its own section in Model quality (issue #137): once on the page. The self-checks keep only
	// its closure check, each water year's residual, and link to the table (followups § UI, issue #175's overlap check).
	await expect(page.getByRole('region', { name: 'Water balance by water year' })).toHaveCount(1);
	const closure = page.locator('#res-checks').getByTestId('checks-balance-link');
	await expect(closure).toHaveText(
		'✓Passed: The water balance closes in its one water year and over the whole run: each residual is float noise. The balance itself, term by term: Water balance.'
	);
	await expect(page.locator('#res-checks').getByRole('table')).toHaveCount(0);
	await closure.getByRole('link', { name: 'Water balance' }).click();
	// 120 days from 2021-10-01: one water year, then the whole run.
	const balance = page.locator('#res-water-balance').getByRole('region', { name: 'Water balance by water year' });
	await expect(balance).toBeInViewport();
	await expect(balance.getByRole('rowheader')).toHaveText(['2021/22', 'Whole run']);
	// No groundwater, users, storage resets or lost seepage here: the equation names only the columns shown.
	await expect(balance).toContainText('Start storage + hydrological unit runoff + transfers + rain on dams = consumptive use + dam evaporation + outflow + end storage.');
	await expect(balance.getByRole('columnheader')).toHaveText([
		'Water year',
		'Rain (mm)',
		'Runoff coeff.',
		'Start storage',
		'Hydrological unit runoff',
		'Transfers',
		'Rain on dams',
		'Consumptive use',
		'Dam evaporation',
		'Outflow',
		'End storage',
		'Residual (m³)',
		'Runoff-model residual (mm)'
	]);

	// The catchment's own account is on River & reserve: linked, for the same run, not copied here; Back returns.
	const runUrl = page.url();
	await page.locator('#res-water-balance').getByTestId('balance-account-link').getByRole('link', { name: 'Water account' }).click();
	await expect(page).toHaveURL(/[?&]tab=river&run=[^#]+#res-water-account$/);
	const account = page.getByRole('region', { name: 'Water account' });
	await expect(account.getByTestId('account-table')).toBeVisible();
	await expect(account).toBeInViewport();
	// And back again: the account links to the balance for the same run, which lands on it.
	await account.getByTestId('account-balance-link').getByRole('link', { name: 'Water balance' }).click();
	await expect(page).toHaveURL(/[?&]tab=runs&run=[^#]+#res-water-balance$/);
	await expect(page.locator('#res-water-balance').getByRole('region', { name: 'Water balance by water year' })).toBeInViewport();
	await page.goBack();
	await page.goBack();
	await expect(page).toHaveURL(runUrl);
	await expect(page.getByRole('region', { name: /^Trace a day/ })).toBeVisible();

	const trace = page.getByRole('region', { name: /^Trace a day/ });
	await trace.getByLabel('Hydrological unit, gauge or catchment').selectOption({ label: 'Upper farm' });
	await trace.getByLabel('Day').fill('2021-11-15');
	await trace.getByRole('button', { name: 'Trace' }).click();
	const table = trace.getByRole('table', { name: 'Upper farm on 2021-11-15' });
	await expect(table).toBeVisible();
	for (const name of ['Dam storage at the end of the day before', 'Soil-water store at the end of the day before', 'Soil-water store at the end of the day', 'Upstream inflow into the dam', 'Irrigation return flow', 'Balance check (should be 0)']) {
		await expect(table.getByRole('rowheader', { name, exact: true })).toBeVisible();
	}
	await expect(table.getByRole('row').filter({ hasText: 'Irrigation supplied' }).getByRole('cell').first()).toHaveText('G');
	// The day closes from the numbers shown: in − used − stored − out is 0 or float noise.
	await expect(trace.locator('.closure strong')).toHaveText(/^(-?0|-?\d\.\d{2}e-\d+)$/);

	// The catchment's day: how the runoff model (GR4J, the default) turned rain into natural flow.
	await trace.getByLabel('Hydrological unit, gauge or catchment').selectOption({ label: 'Catchment (rain to natural flow)' });
	await trace.getByRole('button', { name: 'Trace' }).click();
	const runoff = trace.getByRole('table', { name: 'Catchment (GR4J) on 2021-11-15' });
	await expect(runoff).toBeVisible();
	for (const name of ['All stores at the end of the day before', 'Production store (soil moisture), the day before', 'Production store (soil moisture)', 'Routing store', 'Actual evaporation', 'Natural flow']) {
		await expect(runoff.getByRole('rowheader', { name, exact: true })).toBeVisible();
	}
	// The store balance closes from the numbers shown: before + P + F − AET − Q − after is 0 or float noise.
	await expect(trace.locator('.closure strong')).toHaveText(/^(-?0|-?\d\.\d{2}e-\d+)$/);
	await expect(trace.locator('.closure')).toContainText('mm');
});
