// § 5 of the licensing evidence report, registered water use (issue #71,
// WP-3.10; docs/allocations.md § In the evidence report, docs/ui.md §
// Evidence report): a nominated run of two whole water years with a volume
// on each farm. Since evidence-13 (decision D3) § 5 lists only the
// applicant's own units one by one, and every other unit as one total per
// water source at 5 or more units: baseline evidence (no applicant) with two
// farms lists none and says so, while page 1's row still counts the
// unit-years; an application on Upper farm lists Upper farm, never Lower
// farm. Never a holder's name. The case without volumes ("Not assessed") is
// in evidence-report.spec.ts. Synthetic catchment and invented volumes.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, putSeries, seedRunnableProject, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

/** An application owning Upper farm on the nominated baseline (a slightly smaller dam), run: its run id. */
async function application(page: Page, projectId: string, baseRunId: string, upper: string): Promise<string> {
	const res = await page.request.post(`${API_URL}/projects/${projectId}/scenarios`, {
		data: { name: 'Upper farm application', baseRunId, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 90_000 }], ownedNodeIds: [upper] }
	});
	expect(res.status()).toBe(201);
	const { scenario } = (await res.json()) as { scenario: { id: string } };
	const ran = await page.request.post(`${API_URL}/projects/${projectId}/scenarios/${scenario.id}/runs`, { data: {} });
	expect(ran.status()).toBe(201);
	return ((await ran.json()) as { run: { id: string } }).run.id;
}

test('the evidence report compares modelled use with the registered volumes, listing only the applicant’s own units, never naming a holder', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evidence allocations');
	// Two whole water years (1 Oct 2019 – 30 Sep 2021), so each year is judged.
	const days = 731;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const nodes = project.model.nodes as { id: string; name: string }[];
	const upper = nodes.find((n) => n.name === 'Upper farm')!.id;
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

	// Baseline evidence: no applicant, so no unit is listed, and two units are too few for a total.
	await page.goto(`/projects/${project.id}/report?run=${run}&evidence`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByTestId('evidence-report')).toHaveAttribute('data-evidence-mode', 'baseline');
	// Page 1: the fixed row still counts every unit's years above a volume, by count only.
	const row = page.getByTestId('evidence-change-table').getByRole('row', { name: /^Registered vs modelled use/ });
	await expect(row).toContainText('2 unit-years');
	await expect(row).toContainText('2 of 4 unit-years judged');
	await expect(page.getByTestId('evidence-flags')).not.toContainText('Upper farm, surface water');
	const section = page.locator('#ev-allocations');
	await expect(section.getByRole('heading', { level: 2, name: '5. Registered water use' })).toBeVisible();
	await expect(section.getByTestId('evidence-allocations-others')).toContainText('No unit is listed one by one.');
	await expect(section.getByTestId('evidence-allocations-others')).toContainText('2 other units with a registered volume are left out: fewer than 5 hold one');
	await expect(section).not.toContainText('Upper farm');
	await expect(section).not.toContainText('Lower farm');
	await expectNoViolations(page);

	// An application on Upper farm: § 5 lists the applicant's unit, never Lower farm's.
	const app = await application(page, project.id, run, upper);
	await page.goto(`/projects/${project.id}/report?run=${app}&evidence`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByTestId('evidence-report')).toHaveAttribute('data-evidence-mode', 'application');
	await expect(page.getByTestId('evidence-flags')).toContainText('Upper farm (the applicant’s), surface water, 2 of 2 whole water years');
	const appSection = page.locator('#ev-allocations');
	await expect(appSection.getByRole('img', { name: /^Modelled use as a share of the registered volume/ })).toBeVisible();
	const summary = appSection.getByTestId('evidence-allocations');
	await expect(summary.getByRole('row', { name: /^Upper farm \(the applicant’s\), surface water/ })).toContainText('2 above, 0 within, 0 below, of 2');
	const years = appSection.getByTestId('evidence-allocation-years');
	await expect(years.getByRole('row', { name: /Upper farm/ })).toHaveCount(2);
	await expect(years.getByRole('row', { name: /Upper farm/ }).first()).toContainText('Above registered');
	await expect(appSection.getByTestId('evidence-allocations-others')).toContainText('Only the applicant’s own units are listed one by one.');
	await expect(appSection.getByTestId('evidence-allocations-others')).toContainText('1 other unit with a registered volume is left out');
	await expect(appSection).not.toContainText('Lower farm');
	// A run that compares only cites no cap.
	await expect(appSection.getByTestId('evidence-allocation-cap')).toHaveCount(0);
	// Volumes only: no holder's name or registration number anywhere in the report (D3).
	const text = await page.getByTestId('evidence-report').innerText();
	for (const secret of ['Invented Holder Upper', 'Invented Holder Lower', 'E2E-EV-1', 'E2E-EV-2']) expect(text).not.toContain(secret);

	await expectNoViolations(page);
});

test('the evidence report cites a capped run’s cap: the years it used its volume up and the days each limit held use back (evidence-6)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evidence allocation cap');
	const days = 731;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', allocationMode: 'cap' });
	const nodes = project.model.nodes as { id: string; name: string }[];
	// Upper farm: a volume far above its use, taken only October to March, so the months are what hold it back.
	const res = await page.request.post(`${API_URL}/projects/${project.id}/allocations`, {
		data: { nodeId: nodes.find((n) => n.name === 'Upper farm')!.id, waterSource: 'surface', authorisation: 'licence', volumeM3PerYear: 1e9, months: [10, 11, 12, 1, 2, 3] }
	});
	expect(res.status()).toBe(201);
	const run = await createRun(page.request, project.id, 'Capped baseline');
	await nominateRun(page.request, project.id, run, 'Capped baseline');
	// The applicant's own unit is cited one by one (evidence-13); the baseline column is the capped baseline's.
	const app = await application(page, project.id, run, nodes.find((n) => n.name === 'Upper farm')!.id);

	await page.goto(`/projects/${project.id}/report?run=${app}&evidence`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	const cap = page.locator('#ev-allocations').getByTestId('evidence-allocation-cap');
	const row = cap.getByRole('row', { name: /^Upper farm \(the applicant’s\), surface water/ });
	await expect(row.getByRole('cell').first()).toHaveText('The cap held use back on 18 days in 2 water years: 18 outside the months of use. The registered volume was never used up.');
	await expect(row.getByRole('cell').nth(1)).toHaveText(/^The cap held use back on \d+ days in 2 water years: \d+ outside the months of use\./);
	// Lower farm has no volume: not capped, not listed.
	await expect(cap.getByRole('row', { name: /^Lower farm/ })).toHaveCount(0);
	await expectNoViolations(page);
});

// Both impact bases (licensing build item 8, evidence-14): an application's page 1 leads with the board against full authorised use,
// once an editor runs the pair, with the authorised volumes' mix; until then a fixed row says it isn't run.
test('an application’s evidence report leads with the board against full authorised use, run by an editor', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evidence authorised use');
	const days = 731;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const nodes = project.model.nodes as { id: string; name: string }[];
	const upper = nodes.find((n) => n.name === 'Upper farm')!.id;
	for (const [name, authorisation, volumeM3PerYear] of [
		['Upper farm', 'licence', 50_000],
		['Lower farm', 'registration', 200_000]
	] as const) {
		const res = await page.request.post(`${API_URL}/projects/${project.id}/allocations`, {
			data: { nodeId: nodes.find((n) => n.name === name)!.id, waterSource: 'surface', authorisation, volumeM3PerYear }
		});
		expect(res.status()).toBe(201);
	}
	const run = await createRun(page.request, project.id, 'Baseline with volumes');
	await nominateRun(page.request, project.id, run, 'Baseline with registered volumes');
	const created = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: { name: 'Upper dam raised', baseRunId: run, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 300_000 }], ownedNodeIds: [upper] }
	});
	expect(created.status(), await created.text()).toBe(201);
	const ran = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${((await created.json()) as { scenario: { id: string } }).scenario.id}/runs`, { data: {} });
	expect(ran.status(), await ran.text()).toBe(201);
	const appRun = ((await ran.json()) as { run: { id: string } }).run.id;

	await page.goto(`/projects/${project.id}/report?run=${appRun}&evidence`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	const authorised = page.getByTestId('evidence-impact-authorised');
	await expect(authorised.getByTestId('evidence-impact-authorised-na')).toHaveAttribute('data-status', 'notBuilt');
	await expect(page.getByTestId('evidence-impact-modelled-h')).toHaveText('Against modelled current use');

	await page.getByTestId('evidence-authorised-run').getByRole('button', { name: 'Run at full authorised use' }).click();
	await expect(authorised.getByTestId('evidence-impact-authorised-na')).toHaveCount(0);
	const mix = authorised.getByTestId('evidence-authorised-mix');
	await expect(mix.getByRole('rowheader')).toHaveText(['Licence', 'Registration (WARMS)', /^All of it/]);
	await expect(mix.getByRole('row', { name: /^Licence/ })).toContainText('Yes');
	await expect(mix.getByRole('row', { name: /^Registration/ })).toContainText('No');
	await expect(page.getByTestId('evidence-authorised-run')).toHaveCount(0);
	await expectNoViolations(page);
});
