import { expectNoViolations } from '../support/a11y.ts';
import { createProject, putSeries } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { grouped } from '../support/format.ts';

// The Data tab's "Preview all data" dialog: every input series' daily values
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

test('opened while the values still load, the preview focuses its search once they arrive', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series preview slow');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: [1, 2, 3] });
	// Hold back the series' values until the dialog is open and showing its loading state.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	await page.route(/\/series\/[^/?]+$/, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		await held;
		await route.fallback();
	});
	await page.goto(`/projects/${project.id}?tab=series`);

	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await expect(dialog.getByRole('status').filter({ hasText: 'Loading…' })).toBeVisible();
	release();
	await expect(dialog).toContainText('3 of 3 days shown');
	await expect(dialog.getByLabel('Search by date or value')).toBeFocused();
});

test('values that fail to load show an error with Try again, never an endless Loading…', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series preview failed');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: [1, 2, 3] });
	// Every request for the series' values fails at the network until the route is lifted.
	let fail = true;
	await page.route(/\/series\/[^/?]+$/, async (route) => {
		if (route.request().method() !== 'GET' || !fail) return route.fallback();
		await route.abort('connectionrefused');
	});
	await page.goto(`/projects/${project.id}?tab=series`);

	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	const alert = dialog.getByRole('alert');
	await expect(alert).toContainText("Couldn't load the values of Rainfall — catchment (");
	await expect(dialog.getByRole('status').filter({ hasText: 'Loading…' })).toHaveCount(0);

	// Try again loads them once the network is back.
	fail = false;
	await alert.getByRole('button', { name: 'Try again' }).click();
	await expect(dialog).toContainText('3 of 3 days shown');
	await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('the card header’s "Preview all data" opens with every column, the column picker can hide one, and Escape returns focus to the header button', async ({
	page,
	owner
}) => {
	void owner;
	const project = await createProject(page.request, 'Series preview data');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: [1, 2, 3] });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2020-01-01', values: [0.1, 0.2, 0.3] });
	await page.goto(`/projects/${project.id}?tab=series`);

	const openButton = page.getByRole('button', { name: 'Preview all data' });
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

test('the preview fills the viewport and renders rows to the bottom of its taller scroll box', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series preview size');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: previewValues(731) });
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.goto(`/projects/${project.id}?tab=series`);
	await page.getByRole('button', { name: 'Preview all data' }).click();

	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await expect(dialog).toContainText('731 of 731 days shown');
	const box = await dialog.boundingBox();
	expect(box?.width).toBeGreaterThan(1400);
	expect(box?.height).toBeGreaterThan(900);

	// Scroll to the middle: the row windowing must follow the measured height, so
	// the cell just above the scroll box's bottom edge is a real date, not a spacer.
	const scroller = dialog.locator('.scroll');
	await scroller.evaluate((el) => (el.scrollTop = 300 * 28));
	await expect(dialog.getByRole('row').filter({ hasText: '2020-10-27' })).toBeVisible();
	const bottomCell = await scroller.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + 40, r.bottom - 20);
		return hit?.closest('tr')?.querySelector('th, td')?.textContent?.trim() ?? '';
	});
	expect(bottomCell).toMatch(/^2020-\d\d-\d\d$/);
});

// The big case: two series over fifteen years. Only the rows in view are drawn,
// and each is exactly the 28 px the spacers assume, so the rows line up from the
// first day to the last (as Download → Preview's do, download-preview.spec.ts).
for (const size of [
	{ name: 'desktop', width: 1440, height: 960 },
	{ name: 'phone', width: 390, height: 844 }
]) {
	test(`fifteen years: rows line up to the last day, no gap under the header, the table scrolls from the keyboard, no a11y violations (${size.name})`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: size.width, height: size.height });
		const project = await createProject(page.request, `Series preview long ${size.name}`);
		const days = 5479; // 2010-01-01 … 2024-12-31
		await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2010-01-01', values: previewValues(days) });
		await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2010-01-01', values: previewValues(days).map((v) => (v === null ? null : v / 10)) });
		await page.goto(`/projects/${project.id}?tab=series`);
		await page.getByRole('button', { name: 'Preview all data' }).click();
		const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
		await expect(dialog).toContainText(`${grouped(days)} of ${grouped(days)} days shown`);

		// The first row starts right under the header, and rows are exactly 28 px apart.
		const scroll = dialog.getByRole('region', { name: 'Input time series: the daily table' });
		const rows = dialog.locator('tbody tr:not([aria-hidden])');
		const head = (await dialog.locator('thead').boundingBox())!;
		const first = (await rows.first().boundingBox())!;
		expect(Math.abs(first.y - (head.y + head.height))).toBeLessThan(2);
		expect((await rows.nth(20).boundingBox())!.y - first.y).toBeCloseTo(20 * 28, 0);

		// Scrolled to the end, the last day is the last row, at the foot of the scroll box.
		await scroll.evaluate((d) => (d.scrollTop = d.scrollHeight));
		const last = rows.last();
		await expect(last.getByRole('cell').first()).toHaveText('2024-12-31');
		const end = (await scroll.boundingBox())!;
		const bottomScrollbar = await scroll.evaluate((d) => (d as HTMLElement).offsetHeight - d.clientHeight);
		expect(Math.abs((await last.boundingBox())!.y + 28 - (end.y + end.height - bottomScrollbar))).toBeLessThan(3);
		// Far in, the row at the top of the box is the day that far in.
		await scroll.evaluate((d) => (d.scrollTop = 4000 * 28));
		await expect(dialog.getByRole('row', { name: /^2020-12-14 / })).toBeInViewport();

		// The scroll box takes focus and scrolls from the keyboard.
		await scroll.evaluate((d) => (d.scrollTop = 0));
		await scroll.focus();
		await expect(scroll).toBeFocused();
		await page.keyboard.press('PageDown');
		await expect.poll(() => scroll.evaluate((d) => d.scrollTop)).toBeGreaterThan(0);
		await scroll.evaluate((d) => (d.scrollTop = 0));
		await expectNoViolations(page, { include: 'dialog[open]' });
	});
}

test('the column picker keeps each checkbox beside its label', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series preview picker');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: previewValues(40) });
	await page.goto(`/projects/${project.id}?tab=series`);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await dialog.getByText('Columns', { exact: true }).click();

	// A checkbox stretched to the row's width would sit far from its label.
	const box = dialog.getByRole('checkbox', { name: 'Rain used (model)' });
	await expect(box).toBeVisible();
	const size = await box.boundingBox();
	expect(size?.width).toBeLessThan(30);
});

test('every column header has an ⓘ tip explaining that column, and the tips work from the keyboard inside the dialog', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series preview tips');
	// One series of every kind, so every column the preview can produce is on screen.
	const rain = { unit: 'mm', startDate: '2020-01-01', values: [1, 0, 3] };
	const flow = { unit: 'm³/s', startDate: '2020-01-01', values: [0.1, 0.2, 0.3] };
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Station A', ...rain });
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', name: 'Grid B', ...rain });
	await putSeries(page.request, project.id, { kind: 'rain_forecast_mm', name: 'Outlook C', ...rain });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Weir D', ...flow });
	await putSeries(page.request, project.id, { kind: 'flow_logger_m3s', name: 'Logger E', ...flow });
	await putSeries(page.request, project.id, { kind: 'flow_reference_m3s', name: 'River F', ...flow });
	await page.goto(`/projects/${project.id}?tab=series`);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await expect(dialog).toContainText('3 of 3 days shown');

	// Header text → the glossary term its tip opens on.
	const expected: [RegExp, string][] = [
		[/^Date\s*$/, 'Date (daily preview)'],
		[/^Rainfall — catchment · Station A\s*\(mm\)\s*$/, 'Catchment rainfall'],
		[/^Rainfall — CHIRPS · Grid B\s*\(mm\)\s*$/, 'CHIRPS rainfall'],
		[/^Rainfall — forecast · Outlook C\s*\(mm\)\s*$/, 'Forecast rainfall'],
		[/^Flow — observed gauge · Weir D\s*\(m³\/s\)\s*$/, 'Observed flow'],
		[/^Flow — logger · Logger E\s*\(m³\/s\)\s*$/, 'Observed flow'],
		[/^Flow — reference gauge \(other catchment\) · River F\s*\(m³\/s\)\s*$/, 'Reference gauge (other catchment)'],
		[/^Flow — observed gauge · Weir D \(m³\/day\)\s*$/, 'Flow in m³/day (daily preview)'],
		[/^Flow — logger · Logger E \(m³\/day\)\s*$/, 'Flow in m³/day (daily preview)'],
		[/^Flow — reference gauge \(other catchment\) · River F \(m³\/day\)\s*$/, 'Flow in m³/day (daily preview)'],
		[/^Rain used \(model\)/, 'Rain used (daily preview)'],
		[/^CHIRPS bias factor/, 'CHIRPS bias factor (daily preview)'],
		[/^CHIRPS \(corrected\)/, 'CHIRPS corrected (daily preview)'],
		[/^Excluded from calibration\s*$/, 'Excluded from calibration (daily preview)']
	];
	const headers = dialog.locator('thead th');
	await expect(headers).toHaveCount(expected.length);

	for (const [text, term] of expected) {
		const th = headers.filter({ hasText: text });
		await expect(th, `header ${text}`).toHaveCount(1);
		const tip = th.getByRole('button', { name: /^About / });
		await expect(tip, `tip in ${text}`).toHaveCount(1);
		const live = page.locator(`[id="${await tip.getAttribute('aria-controls')}"]`);
		await tip.click();
		await expect(live.locator('.term'), `tip in ${text}`).toHaveText(term);
		await expect(live.locator('.short')).not.toBeEmpty();
		// Escape closes the tip only, not the dialog around it.
		await page.keyboard.press('Escape');
		await expect(live).toBeEmpty();
		await expect(dialog).toBeVisible();
	}

	// From the keyboard: Enter opens a tip, Escape closes it and focus returns to its button.
	const rainTip = dialog.getByRole('button', { name: 'About Rain used (model)' });
	const live = page.locator(`[id="${await rainTip.getAttribute('aria-controls')}"]`);
	await rainTip.focus();
	await page.keyboard.press('Enter');
	await expect(rainTip).toHaveAttribute('aria-expanded', 'true');
	await expect(live.locator('.term')).toHaveText('Rain used (daily preview)');
	await expect(live.locator('.units')).toHaveText('Units: mm/day');
	await page.keyboard.press('Escape');
	await expect(live).toBeEmpty();
	await expect(rainTip).toBeFocused();
	await expect(rainTip).toHaveAttribute('aria-expanded', 'false');
	await expect(dialog).toBeVisible();

	// The Date column's own tip, the same way.
	const dateTip = dialog.getByRole('button', { name: 'About the date column' });
	await dateTip.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator(`[id="${await dateTip.getAttribute('aria-controls')}"] .term`)).toHaveText('Date (daily preview)');
	await page.keyboard.press('Escape');
	await expect(dateTip).toBeFocused();
	await expect(dialog).toBeVisible();
});

test('the preview has a visible close button, and its number columns line up under right-aligned headers', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series preview close');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: [1, 22.5, 3] });
	await page.goto(`/projects/${project.id}?tab=series`);

	const openButton = page.getByRole('button', { name: 'Preview all data' });
	await openButton.click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await expect(dialog).toContainText('3 of 3 days shown');

	// A number sits under its own header, not between two: both are right-aligned.
	const rainHeader = dialog.getByRole('columnheader', { name: /^Rainfall — catchment/ });
	await expect(rainHeader).toHaveCSS('text-align', 'right');
	const rainCell = dialog.getByRole('row').filter({ hasText: '2020-01-02' }).getByRole('cell').nth(1);
	await expect(rainCell).toHaveText('22.50');
	await expect(rainCell).toHaveCSS('text-align', 'right');
	const headerBox = (await rainHeader.boundingBox())!;
	const cellBox = (await rainCell.boundingBox())!;
	expect(Math.abs(headerBox.x + headerBox.width - (cellBox.x + cellBox.width))).toBeLessThan(1);
	// The date column stays left-aligned, as text.
	await expect(dialog.getByRole('columnheader', { name: /^Date/ })).toHaveCSS('text-align', 'left');

	// The ✕ in the top-right corner closes it, for anyone who doesn't know Esc does.
	const close = dialog.getByRole('button', { name: 'Close dialog' });
	const dialogBox = (await dialog.boundingBox())!;
	const closeBox = (await close.boundingBox())!;
	expect(closeBox.y - dialogBox.y).toBeLessThan(24);
	expect(dialogBox.x + dialogBox.width - (closeBox.x + closeBox.width)).toBeLessThan(24);
	await close.click();
	await expect(dialog).toBeHidden();
	await expect(openButton).toBeFocused();
});
