// Uncertainty bands (issue #4 phase 9, docs/ui.md § Runs, docs/run-comparison.md):
// an editor runs an ensemble on a run in the calibration worker, the server
// checks and stores it, the Runs tab shows the decision rule next to the
// bands, and anyone can reproduce it. Then run comparison bands the difference
// a bigger dam makes, member by member, over the baseline's kept sets. The
// sensitivity runs (CR-21) sit under the bands: run in the worker, never stored.
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, putModel, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('an ensemble is stored with its rule, reproduces, and pairs with another run in compare', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Uncertainty');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const baseline = await createRun(page.request, project.id, 'Baseline');

	// The bands sit on River & reserve with the findings they qualify (issue #17).
	await page.goto(`/projects/${project.id}?tab=river&run=${baseline}`);
	const panel = page.getByTestId('uncertainty-panel');
	await expect(panel.getByText('No uncertainty ensemble has been stored for this run.')).toBeVisible();
	// The ensemble's boxes line up: the low-flow checkbox under its box doesn't lift that field's label.
	const tops = await Promise.all(['Parameter sets', /^Lowest skill kept/, /^Largest low-flow bias kept/].map(async (l) => (await panel.getByLabel(l).boundingBox())!.y));
	expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(2);

	// A small, loose ensemble: 30 sets (the fewest that can show percentiles) on 120 synthetic days.
	await panel.getByLabel('Parameter sets').fill('30');
	await panel.getByLabel(/^Lowest skill kept/).fill('-10');
	await panel.getByLabel('Worst WR2012 flag kept').selectOption('unusable');
	await panel.getByRole('checkbox', { name: 'Check the low-flow bias' }).uncheck();
	await panel.getByRole('button', { name: 'Run ensemble' }).click();

	// The server fixed the rule; the browser ran it; the server checked and stored it.
	const rule = panel.getByTestId('decision-rule');
	await expect(rule).toContainText('A parameter set is kept when it has KGE′ ≥ -10.0 against its observed record before 2021-');
	await expect(rule).toContainText('shown only with at least 30 kept');
	await expect(rule).toContainText('Sample: 30 Latin-hypercube sets');
	await expect(panel.getByTestId('kept')).toHaveText('31 of 31');
	await expect(panel.getByTestId('coverage')).toContainText('held-out gauge record observations');
	const ewrRow = panel.getByTestId('band-ewr-days');
	await expect(ewrRow.getByRole('cell')).toHaveCount(4);
	await expect(ewrRow.getByRole('cell').first()).toHaveText(/^\d[\d\u202f]*$/);
	await expect(panel.getByRole('table', { name: /^EWR days not met at the outlet by month/ }).getByRole('columnheader')).toHaveCount(13);
	await expect(panel.getByRole('img', { name: /^Oct flow-duration band of simulated outflow against the EWR/ })).toBeVisible();

	// Stored: a reload shows the same band, and the browser reproduces it from the seed.
	await page.reload();
	await expect(panel.getByTestId('kept')).toHaveText('31 of 31');
	await panel.getByRole('button', { name: 'Reproduce in this browser' }).click();
	await expect(panel.getByTestId('reproduced')).toHaveText('Reproduced: the same 31 members, verdicts, outputs and coverage.');

	// The application: a bigger dam on the upper farm, then a run of it.
	const model = project.model;
	(model.nodes[1] as Record<string, unknown>).damCapacityM3 = 600_000;
	(model.nodes[1] as Record<string, unknown>).pctRunoffToDam = 1;
	await putModel(page.request, project.id, model);
	const application = await createRun(page.request, project.id, 'Bigger dam');

	await page.goto(`/compare?a=${project.id}:${baseline}&b=${project.id}:${application}`);
	const paired = page.getByTestId('paired-uncertainty');
	await expect(paired.getByText("No paired band yet for A's newest ensemble.")).toBeVisible();
	await paired.getByRole('button', { name: 'Compute the paired band' }).click();
	await expect(paired.getByTestId('paired-rule')).toContainText('percentiles of the difference (other − baseline), shown only with at least 30 pairs');
	const row = paired.getByTestId('paired-ewr-days');
	await expect(row.getByRole('cell')).toHaveCount(4);
	await expect(row.getByRole('cell').last()).toHaveText(/^\d+ %$/);
	await expect(paired.getByTestId('rule-diff')).toHaveCount(0);
});

test('sensitivity runs: a verdict per EWR site, the tornado with its table, and a threshold re-judged without a re-run (CR-21)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Sensitivity');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const run = await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=river&run=${run}`);
	const panel = page.getByTestId('sensitivity-panel');
	await panel.getByRole('button', { name: 'Run sensitivity' }).click();

	// The worker ran the cases; one verdict per EWR site (the sample model has the outlet only).
	const verdicts = panel.getByTestId('sensitivity-verdicts').getByRole('listitem');
	await expect(verdicts).toHaveCount(1);
	await expect(verdicts.first()).toHaveText(/^(Meets the threshold|Below the threshold|Not determinable with current data)\. .+: .+ against a threshold of 80 %/);
	await expect(panel.getByRole('img', { name: /^EWR days not met at .+, days, by sensitivity factor\. Central run \d+ days\. Threshold \d+\. / })).toBeVisible();
	const table = panel.getByRole('table', { name: /^EWR days not met at .+ \(days\): central \d+$/ });
	await expect(table.getByRole('columnheader')).toHaveText(['Factor', 'Low', 'Result', 'High', 'Result', 'Swing']);
	await expect(table.getByRole('rowheader', { name: 'Rain', exact: true })).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Run again' })).toBeEnabled();

	// Every run meets a 0 % threshold: re-judged at once, nothing re-run.
	await panel.getByLabel('Threshold: days the EWR is met (%)').fill('0');
	await expect(verdicts.first()).toHaveText(/^Meets the threshold\. /);
	await expectNoViolations(page, { include: '[data-testid="sensitivity-panel"]' });
});
