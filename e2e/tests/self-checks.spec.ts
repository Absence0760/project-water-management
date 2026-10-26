// The self-checks panel (engine 0.12.0): the model's checks on its own run,
// the water balance's closure by water year (the table is its own Model
// quality section since issue #137, linked from the self-checks, and links to
// the EWR page's Water account, which links back), and the trace of one farm's day
// with its working columns (docs/ui.md § Self-checks).
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

test('a run shows its self-checks, its water balance and a traced day that closes', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Self-checks');
	await createRun(page.request, project.id, 'Checked');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Checked' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Arithmetic checks' }).click();

	const checks = page.getByRole('region', { name: /^Arithmetic checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'arithmetic checks' })).toHaveText('All 13 arithmetic checks passed.'); // the 7th: EWR attribution (engine 0.17.0, audit Q17); the 8th: groundwater (0.23.0, WP-1.34); the 9th: land cover (0.24.0, WP-1.35); the 10th: registered volumes (1.18.0, issue #72); the 11th: operating rules (1.32.0, issue #204); the 12th: the assurance of supply (1.34.0, issue #192); the 13th: the drought restriction rule (1.54.0, WP-3.8)
	// All passed, so the list waits behind one button (#586 round 2; runs-record-actions.spec.ts).
	await checks.getByRole('button', { name: 'Show the 13 checks' }).click();
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
		'✓Passed: The water balance closes in its one water year and over the whole run: each residual is float noise. The balance itself, term by term: Water balance by water year.'
	);
	await expect(page.locator('#res-checks').getByRole('table')).toHaveCount(0);
	await closure.getByRole('link', { name: 'Water balance' }).click();
	// 120 days from 2021-10-01: one water year, then the whole run.
	const balance = page.locator('#res-water-balance').getByRole('region', { name: 'Water balance by water year' });
	await expect(balance).toBeInViewport();
	await expect(balance.getByRole('rowheader')).toHaveText(['2021/22', 'Whole run']);
	// No groundwater, users, storage resets or lost seepage here: the equation names only the columns shown.
	await expect(balance).toContainText('Start storage + hydrological unit runoff + transfers + rain on dams = consumptive use + dam evaporation + outflow + end storage.');
	// Two pairs stack in one column each (rain over its runoff coefficient, the balance's residual over the
	// runoff model's), so the table fits its column at 1440 (runs-page.spec.ts).
	await expect(balance.getByRole('columnheader')).toHaveText([
		'Water year',
		'Rain (mm) runoff coeff.',
		'Start storage',
		'Unit runoff',
		'Transfers',
		'Rain on dams',
		'Consumptive use',
		'Dam evaporation',
		'Outflow',
		'End storage',
		'Residual (m³) runoff model (mm)'
	]);

	// The catchment's own account is on EWR: linked, for the same run, not copied here; Back returns.
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
	// The day is a day-first text field (a native date field shows the browser's own order, 12/30/2021 in a US browser):
	// it starts on a run day, day first, and says the run's days under the form.
	const dayField = trace.getByLabel('Day');
	await expect(dayField).toHaveValue(/^\d{1,2} [A-Z][a-z]{2} 20\d{2}$/);
	await expect(dayField).toHaveAccessibleDescription('Run days 1 Oct 2021 to 28 Jan 2022, day first.');
	// Month first is never read, a day outside the run is refused, each saying so at the field, and nothing is traced.
	for (const [typed, problem] of [
		['11/15/2021', 'Type a day, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15.'],
		['15 Nov 2023', 'Pick a day of the run, from 1 Oct 2021 to 28 Jan 2022.']
	] as const) {
		await dayField.fill(typed);
		await trace.getByRole('button', { name: 'Trace' }).click();
		await expect(trace.getByRole('alert')).toHaveText(problem);
		await expect(dayField).toHaveAttribute('aria-invalid', 'true');
		await expect(dayField).toBeFocused();
		await expect(trace.getByRole('table')).toHaveCount(0);
	}
	await expectNoViolations(page);
	// The field and its line fit a phone, with the complaint showing (issue #521's 320 px rule).
	const desktop = page.viewportSize()!;
	for (const width of [390, 320]) {
		await resizeTo(page, { width, height: 844 });
		await expect(trace.getByRole('alert')).toBeVisible();
		await expectNoSidewaysScroll(page);
	}
	await expectNoViolations(page);
	await resizeTo(page, desktop);
	// Typing clears the complaint; an ISO day is read and shown day first once the field is left.
	await dayField.fill('2021-11-15');
	await expect(trace.getByRole('alert')).toHaveCount(0);
	await expect(dayField).not.toHaveAttribute('aria-invalid');
	await dayField.blur();
	await expect(dayField).toHaveValue('15 Nov 2021');
	await trace.getByRole('button', { name: 'Trace' }).click();
	const table = trace.getByRole('table', { name: 'Upper farm on 15 Nov 2021' });
	await expect(table).toBeVisible();
	for (const name of ['Dam storage at the end of the day before', 'Soil-water store at the end of the day before', 'Soil-water store at the end of the day', 'Upstream inflow into the dam', 'Irrigation return flow', 'Balance check (should be 0)']) {
		await expect(table.getByRole('rowheader', { name, exact: true })).toBeVisible();
	}
	await expect(table.getByRole('row').filter({ hasText: 'Irrigation supplied' }).getByRole('cell').first()).toHaveText('G');
	// The day closes from the numbers shown: in − used − stored − out is 0 or float noise, which reads "< 0.001",
	// never an exponent (checks.ts fmtBalance, #586 D10).
	await expect(trace.locator('.closure strong')).toHaveText(/^([-−]?0|< 0\.001)$/);

	// The catchment's day: how the runoff model (GR4J, the default) turned rain into natural flow.
	await trace.getByLabel('Hydrological unit, gauge or catchment').selectOption({ label: 'Catchment (rain to natural flow)' });
	await trace.getByRole('button', { name: 'Trace' }).click();
	const runoff = trace.getByRole('table', { name: 'Catchment (GR4J) on 15 Nov 2021' });
	await expect(runoff).toBeVisible();
	for (const name of ['All stores at the end of the day before', 'Production store (soil moisture), the day before', 'Production store (soil moisture)', 'Routing store', 'Actual evaporation', 'Natural flow']) {
		await expect(runoff.getByRole('rowheader', { name, exact: true })).toBeVisible();
	}
	// The store balance closes from the numbers shown: before + P + F − AET − Q − after is 0 or float noise.
	await expect(trace.locator('.closure strong')).toHaveText(/^([-−]?0|< 0\.001)$/);
	await expect(trace.locator('.closure')).toContainText('mm');
});
