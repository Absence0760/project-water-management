// GR4J's potential-evaporation input (settings.pe, issue #39): Settings shows
// which source GR4J's PE comes from and its annual total; switching to a
// monthly PE row moves GR4J's PE (and so the natural flow) while irrigation
// demand, which reads the A-pan row, stays exactly the same.
import type { APIRequestContext } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

/** One stored run series (the catchment's without `nodeId`). */
async function runSeries(request: APIRequestContext, projectId: string, runId: string, key: string, nodeId?: string): Promise<number[]> {
	const q = new URLSearchParams({ key, ...(nodeId ? { nodeId } : {}) });
	const res = await request.get(`${API_URL}/projects/${projectId}/runs/${runId}/series?${q}`);
	expect(res.status(), `${key} ${nodeId ?? 'catchment'}`).toBe(200);
	return ((await res.json()) as { values: number[] }).values;
}

const sum = (v: number[]) => v.reduce((t, x) => t + x, 0);

test('a monthly PE row moves GR4J’s PE and natural flow, and leaves irrigation demand alone', async ({ page, owner }) => {
	void owner;
	// GR4J (the default), A-pan 1 630 mm a year, two farms growing a crop.
	const { id, model } = await seedRunnableProject(page.request, 'GR4J PE source');
	const farms = model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id as string);
	const panRun = await createRun(page.request, id, 'Pan PE');

	await page.goto(`/projects/${id}?tab=settings`);
	const group = page.getByRole('group', { name: 'GR4J potential evaporation' });
	const pan = group.getByRole('radio', { name: 'Pan coefficient × A-pan' });
	const monthly = group.getByRole('radio', { name: 'Monthly PE, entered directly' });
	await expect(pan).toBeChecked();
	// 0.7 × 1 630 mm, and the A-pan row's other two uses said plainly.
	await expect(group.getByTestId('gr4j-pe-annual')).toHaveText('Annual GR4J PE: 1\u202f141 mm (pan coefficient × A-pan; A-pan 1\u202f630 mm a year)');
	await expect(group).toContainText('also drives irrigation demand and dam evaporation');
	await expect(page.getByLabel('Pan coefficient, Oct')).toHaveValue('0.7');

	await monthly.check();
	// The row starts from today's PE (0.7 × 150 mm in Oct), and the pan coefficient goes: GR4J no longer reads it.
	await expect(page.getByLabel('Monthly PE, Oct, mm')).toHaveValue('105');
	await expect(page.getByLabel('Pan coefficient, Oct')).toHaveCount(0);
	await expect(page.getByLabel('Pan-coefficient preset', { exact: true })).toHaveCount(0);
	await expect(group).toContainText('Irrigation demand and dam evaporation still use the A-pan row');
	// The source is required before Save.
	const save = page.getByRole('button', { name: 'Save settings' });
	await expect(save).toBeDisabled();
	const blockers = page.getByRole('status').filter({ hasText: 'to fix before saving' });
	await expect(blockers.getByRole('link', { name: 'Flow calibration: Say where the monthly PE comes from: its source is required.' })).toBeVisible();

	// A clearly lower PE: 40 mm every month, 480 mm a year.
	for (const m of ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']) {
		await page.getByLabel(`Monthly PE, ${m}, mm`).fill('40');
	}
	await expect(group.getByTestId('gr4j-pe-annual')).toHaveText('Annual GR4J PE: 480 mm (the monthly PE row below)');
	await page.getByLabel('Source', { exact: true }).fill('Synthetic station ET₀ × 1.0, 2015–2020');
	await expect(save).toBeEnabled();
	await expect(blockers).toBeHidden();
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	await page.reload();
	await expect(page.getByRole('radio', { name: 'Monthly PE, entered directly' })).toBeChecked();
	await expect(page.getByLabel('Monthly PE, Jan, mm')).toHaveValue('40');
	await expect(page.getByLabel('Source', { exact: true })).toHaveValue('Synthetic station ET₀ × 1.0, 2015–2020');

	const monthlyRun = await createRun(page.request, id, 'Monthly PE');

	// GR4J's PE: 40 mm spread over October's 31 days, against 105 mm before.
	const [petPan, petMonthly] = await Promise.all([runSeries(page.request, id, panRun, 'pet'), runSeries(page.request, id, monthlyRun, 'pet')]);
	expect(petPan[0]).toBeCloseTo(105 / 31, 6);
	expect(petMonthly[0]).toBeCloseTo(40 / 31, 6);
	// Less evaporation leaves more rain to become flow.
	const [flowPan, flowMonthly] = await Promise.all([
		runSeries(page.request, id, panRun, 'natural_flow'),
		runSeries(page.request, id, monthlyRun, 'natural_flow')
	]);
	expect(sum(flowMonthly)).toBeGreaterThan(sum(flowPan));
	// Irrigation demand reads the A-pan row only: the same to the cubic metre on every farm and day.
	for (const farm of farms) {
		const [before, after] = await Promise.all([
			runSeries(page.request, id, panRun, 'gross_demand', farm),
			runSeries(page.request, id, monthlyRun, 'gross_demand', farm)
		]);
		expect(sum(before)).toBeGreaterThan(0);
		expect(after).toEqual(before);
	}
});

test('the FAO-56 Table 5 helper fills the pan-coefficient row from humidity and wind', async ({ page, owner }) => {
	void owner;
	const { id } = await seedRunnableProject(page.request, 'GR4J Kp helper');
	await page.goto(`/projects/${id}?tab=settings`);
	await page.getByText('Suggest from FAO-56 Table 5 (humidity, wind, siting)').click();
	await page.getByLabel('Windward fetch of green crop').selectOption('10');
	const fill = page.getByRole('button', { name: 'Fill the pan-coefficient row' });
	await expect(fill).toBeDisabled();
	// Case A, 10 m green fetch, moderate wind: 0.70 at RH 40–70 %, 0.75 above 70 % (Table 5).
	const months = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
	for (const [i, m] of months.entries()) {
		await page.getByLabel(`Mean relative humidity, ${m}, %`).fill(i < 7 ? '55' : '80');
		await page.getByLabel(`Mean wind speed at 2 m, ${m}, m/s`).fill('3');
	}
	await page.getByLabel('Where the RH and wind came from').fill('Synthetic station, 2010–2020 monthly means');
	await expect(fill).toBeEnabled();
	await fill.click();
	await expect(page.getByLabel('Pan coefficient, Oct')).toHaveValue('0.7');
	await expect(page.getByLabel('Pan coefficient, May')).toHaveValue('0.75');
	await expect(page.getByLabel('Pan coefficient, Sep')).toHaveValue('0.75');
	// The cells and the RH/wind note go into the row's source note (issue #39).
	const source = page.getByLabel('Pan coefficient source');
	await expect(source).toHaveValue('FAO-56 Table 5, Case A, 10 m green crop fetch; RH and wind: Synthetic station, 2010–2020 monthly means');
	// It only fills the form: nothing is saved until Save; then the note is kept.
	const save = page.getByRole('button', { name: 'Save settings' });
	await expect(save).toBeEnabled();
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Pan coefficient source')).toHaveValue('FAO-56 Table 5, Case A, 10 m green crop fetch; RH and wind: Synthetic station, 2010–2020 monthly means');
	await expect(page.getByLabel('Pan coefficient, May')).toHaveValue('0.75');
	// A preset replaces the row and names itself in the note.
	await page.getByLabel('Pan-coefficient preset', { exact: true }).selectOption({ label: 'Generic (flat 0.70)' });
	await expect(page.getByLabel('Pan coefficient source')).toHaveValue(/^Generic \(flat 0\.70\) preset: indicative, from FAO-56 Table 5/);
	// The picker is an action, not a setting: it goes back to "Choose a preset…", so the same preset can be picked again.
	await expect(page.getByLabel('Pan-coefficient preset', { exact: true })).toHaveValue('');
});
