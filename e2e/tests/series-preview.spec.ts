import { createProject, putSeries } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// The Data tab's "Preview data" dialog: every input series' daily values
// side by side, searchable/filterable, in the shared Dialog.svelte modal.

function previewValues(n: number): (number | null)[] {
	// Deterministic: two missing days (5, 15), a 10 every 5th day, 2 otherwise.
	return Array.from({ length: n }, (_, i) => (i === 5 || i === 15 ? null : i % 5 === 0 ? 10 : 2));
}

test('a row’s Preview opens the daily table, a search narrows the row count, and Escape closes it and returns focus', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series preview');
	const days = 731; // 2020 (leap, 366) + 2021 (365)
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: previewValues(days) });
	await page.goto(`/projects/${project.id}?tab=series`);

	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Rainfall — catchment' });
	const previewButton = row.getByRole('button', { name: 'Preview' });
	await previewButton.click();

	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(`${days} of ${days} days shown`);

	// The search box is focused as soon as the dialog opens.
	const search = dialog.getByLabel('Search by date or value');
	await expect(search).toBeFocused();

	// A year prefix narrows the count to that year's days.
	await search.fill('2021');
	await expect(dialog).toContainText('365 of 731 days shown');

	// A full date narrows to the one day, and its value shows in the row.
	await search.fill('2020-01-01');
	await expect(dialog).toContainText('1 of 731 days shown');
	const table = dialog.getByRole('table');
	await expect(table.getByRole('row').filter({ hasText: '2020-01-01' })).toContainText('10');

	// Missing only, with the search cleared, finds the two null days.
	await search.fill('');
	await dialog.getByLabel('Missing only').check();
	await expect(dialog).toContainText('2 of 731 days shown');

	// Escape closes the dialog and returns focus to the button that opened it.
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(previewButton).toBeFocused();
});

test('the card header’s "Preview data" opens with every column, the column picker can hide one, and Escape returns focus to the header button', async ({
	page,
	owner
}) => {
	void owner;
	const project = await createProject(page.request, 'Series preview data');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: [1, 2, 3] });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2020-01-01', values: [0.1, 0.2, 0.3] });
	await page.goto(`/projects/${project.id}?tab=series`);

	const openButton = page.getByRole('button', { name: 'Preview data' });
	await openButton.click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('3 of 3 days shown');

	// Every column: Date, one per series, then "how the model used it" — the flow
	// series' m³/day, Rain used (there is rain) and Excluded from calibration.
	const headerCells = dialog.locator('thead th');
	await expect(headerCells).toHaveText([
		'Date',
		/^Flow — observed gauge/,
		/^Rainfall — catchment/,
		/^Flow — observed gauge \(m³\/day\)/,
		/^Rain used \(model\)/,
		'Excluded from calibration'
	]);

	// The column picker's "Series" group can hide a raw series column. (Its
	// <summary> toggle carries no ARIA button role in this browser build, so
	// it's found by its own text rather than getByRole.)
	await dialog.locator('summary', { hasText: 'Columns' }).click();
	const seriesGroup = dialog.getByRole('group', { name: 'Series' });
	const flowCheckbox = seriesGroup.getByRole('checkbox', { name: 'Flow — observed gauge', exact: true });
	await expect(flowCheckbox).toBeChecked();
	await flowCheckbox.uncheck();
	// Only the raw flow column goes; its m³/day column is a separate choice.
	await expect(headerCells).toHaveCount(5);
	await expect(headerCells.filter({ hasText: /^Flow — observed gauge\(/ })).toHaveCount(0);

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(openButton).toBeFocused();
});
