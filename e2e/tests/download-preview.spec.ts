import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { seedSupplyProject } from '../support/supply.ts';
import { ungroup } from '../support/format.ts';

// Download menu → Preview beside an all-farms table (Fragmented flow /
// Fragmented EWR): the table the file holds, in a dialog, before saving it.
// The preview parses the export itself, so it must show exactly the file.

test('the all-farms preview shows the downloaded file’s table, finds a date, saves the same file and closes back to the menu button', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Download preview');
	const runId = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=runs`);

	// The file, as the download gives it.
	const csv = await (await page.request.get(`${API_URL}/projects/${project.id}/runs/${runId}/export/farms.csv?key=runoff`)).text();
	const [disclaimer, provenance, head, ...body] = csv.replace(/^﻿/, '').trim().split('\r\n');
	expect(disclaimer).toMatch(/^# model estimates /); // the disclaimer line first (docs/api.md § Export)
	expect(provenance).toMatch(/^# run=Baseline; engine=/); // the run's provenance line, ahead of the header (docs/api.md § Export)
	const farms = head!.split(',').slice(1);
	expect(farms).toHaveLength(2);

	const menuButton = page.getByRole('button', { name: 'Download' });
	await menuButton.click();
	// A preview only on the two all-farms tables.
	await expect(page.getByRole('button', { name: /^Preview / })).toHaveCount(2);
	await page.getByRole('button', { name: 'Preview Fragmented flow — all units (CSV)' }).click();

	const dialog = page.getByRole('dialog', { name: 'Fragmented flow — all units' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(`${body.length} of ${body.length} days · 2 units`);
	await expect(dialog.locator('thead th')).toHaveText(['Date', ...farms]);

	// The first day's values are the file's, to the shown precision; numbers line up right under their headers.
	const [date, ...values] = body[0]!.split(',');
	const first = dialog.getByRole('row').filter({ hasText: date! });
	const cells = first.getByRole('cell');
	await expect(cells.first()).toHaveText(date!);
	for (let c = 0; c < values.length; c++) {
		const shown = ungroup((await cells.nth(c + 1).textContent())!);
		const v = Number(values[c]);
		expect(Math.abs(shown - v)).toBeLessThanOrEqual(Math.max(0.5, Math.abs(v) * 0.005));
	}
	await expect(dialog.locator('thead th').nth(1)).toHaveCSS('text-align', 'right');
	await expect(cells.nth(1)).toHaveCSS('text-align', 'right');

	// A date prefix narrows the rows.
	const month = date!.slice(0, 7);
	const inMonth = body.filter((r) => r.startsWith(month)).length;
	await dialog.getByLabel('Find a date').fill(month);
	await expect(dialog).toContainText(`${inMonth} of ${body.length} days`);

	// Download CSV saves the same file, under the server's name.
	const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download CSV' }).click()]);
	expect(download.suggestedFilename()).toMatch(/_baseline_all-farms_runoff_daily_\d{4}-\d{2}-\d{2}\.csv$/);

	await dialog.getByRole('button', { name: 'Close dialog' }).click();
	await expect(dialog).toBeHidden();
	await expect(menuButton).toBeFocused();

	// The EWR table opens in the same dialog with its own file.
	await menuButton.click();
	await page.getByRole('button', { name: 'Preview Fragmented EWR — all units (CSV)' }).click();
	const ewr = page.getByRole('dialog', { name: 'Fragmented EWR — all units' });
	await expect(ewr.locator('thead th').nth(1)).toHaveText(/\[Y\] \(m³\/day\)$/);
});

// The big case: 30 units over two years. The table fills the dialog and
// scrolls inside it, only the rows in view are drawn, and each drawn row is
// exactly the height the spacers assume, so the rows line up from the first
// day to the last.
for (const size of [
	{ name: 'desktop', width: 1440, height: 960 },
	{ name: 'phone', width: 390, height: 844 }
]) {
	test(`30 units × 730 days: the table scrolls in the dialog, rows line up to the last day, no a11y violations (${size.name})`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: size.width, height: size.height });
		const project = await seedSupplyProject(page.request, `Download preview big ${size.name}`, 28, 730);
		await createRun(page.request, project.id, 'Baseline');
		await page.goto(`/projects/${project.id}?tab=runs`);
		await page.getByRole('button', { name: 'Download' }).click();
		await page.getByRole('button', { name: 'Preview Fragmented flow — all units (CSV)' }).click();
		const dialog = page.getByRole('dialog', { name: 'Fragmented flow — all units' });
		await expect(dialog).toContainText('2019-10-01 → 2021-09-29 · 730 of 730 days · 30 units');
		await expect(dialog.locator('thead th')).toHaveCount(31);

		// Inside the window, Download CSV in view; nothing scrolls sideways but the table.
		const box = (await dialog.boundingBox())!;
		expect(box.y + box.height).toBeLessThanOrEqual(size.height);
		await expect(dialog.getByRole('button', { name: 'Download CSV' })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		const scroll = dialog.locator('.scroll');
		expect(await scroll.evaluate((d) => d.scrollWidth > d.clientWidth && d.scrollHeight > d.clientHeight)).toBe(true);

		// The first row starts right under the header, and rows are exactly 28 px apart.
		const rows = dialog.locator('tbody tr:not([aria-hidden])');
		const head = (await dialog.locator('thead').boundingBox())!;
		const first = (await rows.first().boundingBox())!;
		expect(Math.abs(first.y - (head.y + head.height))).toBeLessThan(2);
		expect((await rows.nth(20).boundingBox())!.y - first.y).toBeCloseTo(20 * 28, 0);

		// Scrolled to the end, the last day is the last row, at the foot of the scroll box.
		await scroll.evaluate((d) => (d.scrollTop = d.scrollHeight));
		const last = rows.last();
		await expect(last.getByRole('cell').first()).toHaveText('2021-09-29');
		const end = (await scroll.boundingBox())!;
		expect(Math.abs((await last.boundingBox())!.y + 28 - (end.y + end.height))).toBeLessThan(3);
		// Halfway, the row at the top of the box is the day that far in.
		await scroll.evaluate((d) => (d.scrollTop = 365 * 28));
		await expect(dialog.getByRole('row', { name: /^2020-09-30 / })).toBeInViewport();

		await scroll.evaluate((d) => (d.scrollTop = 0));
		await expectNoViolations(page, { include: 'dialog[open]' });

		// A date with no match says so.
		await dialog.getByLabel('Find a date').fill('1999');
		await expect(dialog).toContainText('0 of 730 days');
		await expect(dialog.getByText('No days match this date.')).toBeVisible();
	});
}
