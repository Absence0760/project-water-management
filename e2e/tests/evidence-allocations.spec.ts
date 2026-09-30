// § 5 of the licensing evidence report, registered water use (issue #71,
// WP-3.10; docs/allocations.md § In the evidence report, docs/ui.md §
// Evidence report): a nominated run of two whole water years with a volume
// on each farm shows the over/under-use chart and the comparison, with the
// unit's name and never the holder's, and page 1's row and flag. The case
// without volumes ("Not assessed") is in evidence-report.spec.ts.
// Synthetic catchment and invented volumes.
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, putSeries, seedRunnableProject, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

test('the evidence report compares modelled use with the registered volumes, by unit, never naming a holder', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evidence allocations');
	// Two whole water years (1 Oct 2019 – 30 Sep 2021), so each year is judged.
	const days = 731;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const nodes = project.model.nodes as { id: string; name: string }[];
	const volume = async (name: string, volumeM3PerYear: number, holder: string, registrationNo: string) => {
		const res = await page.request.post(`${API_URL}/projects/${project.id}/allocations`, {
			data: { nodeId: nodes.find((n) => n.name === name)!.id, waterSource: 'surface', authorisation: 'registration', volumeM3PerYear, holder, registrationNo }
		});
		expect(res.status()).toBe(201);
	};
	// Upper farm's orchard takes far more than 1 000 m³ a year; Lower farm's volume is far above its use.
	await volume('Upper farm', 1000, 'Invented Holder Upper', 'E2E-EV-1');
	await volume('Lower farm', 1e9, 'Invented Holder Lower', 'E2E-EV-2');
	const run = await createRun(page.request, project.id, 'Baseline with volumes');
	await nominateRun(page.request, project.id, run, 'Baseline with registered volumes');

	await page.goto(`/projects/${project.id}/report?run=${run}&evidence`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByTestId('evidence-report')).toHaveAttribute('data-evidence-mode', 'baseline');

	// Page 1: the fixed row counts the unit-years above a volume, and the flag names the unit.
	const row = page.getByTestId('evidence-change-table').getByRole('row', { name: /^Registered vs modelled use/ });
	await expect(row).toContainText('2 unit-years');
	await expect(row).toContainText('2 of 4 unit-years judged');
	await expect(page.getByTestId('evidence-flags')).toContainText(
		'The baseline’s modelled use is more than ±10 % above the registered volume: Upper farm, surface water, 2 of 2 whole water years (§ 5).'
	);

	// § 5: the chart and both tables.
	const section = page.locator('#ev-allocations');
	await expect(section.getByRole('heading', { level: 2, name: '5. Registered water use' })).toBeVisible();
	const chart = section.getByRole('img', { name: /^Modelled use as a share of the registered volume/ });
	await expect(chart).toBeVisible();
	// A screen reader hears the count the chart shows: Upper farm's two years above the band, of four drawn.
	await expect(chart).toHaveAccessibleDescription(/^2 of 4 whole water years are above the ±10\s% band \(over 110\s% of the registered volume\), in 1 of 2 units and water sources\.$/);
	const summary = section.getByTestId('evidence-allocations');
	await expect(summary.getByRole('row', { name: /^Upper farm, surface water/ })).toContainText('2 above, 0 within, 0 below, of 2');
	await expect(summary.getByRole('row', { name: /^Lower farm, surface water/ })).toContainText('0 above, 0 within, 2 below, of 2');
	const years = section.getByTestId('evidence-allocation-years');
	await expect(years.getByRole('row', { name: /Upper farm/ })).toHaveCount(2);
	await expect(years.getByRole('row', { name: /Upper farm/ }).first()).toContainText('Above registered');
	// Volumes only: no holder's name or registration number anywhere in the report (D3).
	const text = await page.getByTestId('evidence-report').innerText();
	for (const secret of ['Invented Holder Upper', 'Invented Holder Lower', 'E2E-EV-1', 'E2E-EV-2']) expect(text).not.toContain(secret);

	await expectNoViolations(page);
});
