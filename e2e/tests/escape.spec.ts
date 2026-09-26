import { createProject, putSeries } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// Popups close on Escape, except when closing would throw away unsaved input.

test('the "Rain up to" dropdown closes on Escape and on an outside click', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Escape freshness');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3] });
	await page.goto(`/projects/${project.id}`);

	const summary = page.locator('summary', { hasText: 'Rain up to' });
	const panel = page.getByRole('columnheader', { name: 'Series' }).first();

	await summary.click();
	await expect(panel).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(panel).toBeHidden();
	await expect(summary).toBeFocused();

	await summary.click();
	await expect(panel).toBeVisible();
	await page.getByRole('heading', { level: 1, name: 'Summary' }).click();
	await expect(panel).toBeHidden();
});

test('Add data closes on Escape, but asks first when a file is read and not uploaded', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Escape add data');
	await page.goto(`/projects/${project.id}`);
	const dialog = page.getByRole('dialog', { name: 'Add data' });

	// Nothing chosen yet: Escape just closes.
	await page.getByRole('button', { name: 'Add data' }).click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();

	// A file read but not uploaded: Escape asks. Staying keeps the file.
	await page.getByRole('button', { name: 'Add data' }).click();
	await dialog.getByLabel('CSV file').setInputFiles({
		name: 'pending.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,value\n2021-10-01,1\n2021-10-02,2\n')
	});
	await expect(dialog.getByRole('button', { name: 'Upload' })).toBeEnabled();

	let asked = '';
	page.once('dialog', (d) => {
		asked = d.message();
		void d.dismiss();
	});
	await page.keyboard.press('Escape');
	await expect.poll(() => asked).toBe("Discard the file you haven't uploaded yet?");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Upload' })).toBeEnabled();

	// Confirming discards and closes. (The first prompt is handled above, so
	// this listener can only see the second.)
	page.once('dialog', (d) => void d.accept());
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
});
