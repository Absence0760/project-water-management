import { API_URL } from '../support/env.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

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
	const [head, ...body] = csv.replace(/^﻿/, '').trim().split('\r\n');
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
		const shown = Number((await cells.nth(c + 1).textContent())!.replace(/,/g, ''));
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
