// Daily series entered by hand (issue #477; docs/ui.md § Data, Edit a day and
// Paste rows): one day of the charted series set or cleared under its chart,
// marked as edited by hand on the row, in Series details and in History; and
// rows pasted from a spreadsheet into Add data, read by the upload's own
// parser, with the same Expected format note, summary and overwrite question.
// Synthetic series only.
import { expectNoViolations } from '../support/a11y.ts';
import { addDataDialog } from '../support/addData.ts';
import { addMember, createProject, putSeries } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import type { Page } from '@playwright/test';

const RAIN = { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [0, 12.4, 0, 3.6, 0, 0, 8.2, 0, 0, 1.5] };

async function onData(page: Page, name: string) {
	const project = await createProject(page.request, name);
	await putSeries(page.request, project.id, RAIN);
	await page.goto(`/projects/${project.id}?tab=series`);
	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Rainfall — catchment' });
	await row.getByRole('button', { name: 'View', exact: true }).click();
	return { project, row, edit: page.getByRole('group', { name: 'Edit a day' }) };
}

test('a day set by hand is saved through the API, marked on the row and in the details, and logged in History', async ({ page, owner }) => {
	void owner;
	const { project, row, edit } = await onData(page, 'Hand edit');
	await expect(edit).toBeVisible();
	const day = edit.getByLabel('Day', { exact: true });
	await expect(day).toHaveAttribute('min', '2021-10-01');
	await expect(day).toHaveAttribute('max', '2021-10-10');
	await day.fill('2021-10-02');
	// The stored value is put in the box to correct, and said beside it.
	await expect(edit.getByLabel('Value (mm)', { exact: true })).toHaveValue('12.4');
	await expect(edit.getByTestId('edit-day-stored')).toContainText('Stored: 12.4 mm.');
	// Nothing to save until the value changes.
	await expect(edit.getByRole('button', { name: 'Save the day' })).toBeDisabled();
	await edit.getByLabel('Value (mm)', { exact: true }).fill('14,2');
	const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/days/2021-10-02`));
	await edit.getByRole('button', { name: 'Save the day' }).click();
	const res = await saved;
	expect(res.status()).toBe(200);
	expect(res.request().postDataJSON()).toEqual({ value: 14.2 });
	await expect(edit.getByTestId('edit-day-done')).toContainText('Saved 2021-10-02: 14.2 mm.');
	await expect(row.getByTestId('series-hand')).toHaveText('1 day edited by hand');
	await expect(page.getByTestId('series-hand-days')).toHaveText('2021-10-02');
	await expect(edit.getByTestId('edit-day-stored')).toContainText('Stored: 14.2 mm, edited by hand.');

	// History names the edit.
	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByText('Edited 2021-10-02 of the Rainfall — catchment series by hand')).toBeVisible();
});

test('a blank value clears the day; a negative or text is refused before it is sent', async ({ page, owner }) => {
	void owner;
	const { row, edit } = await onData(page, 'Hand clear');
	await edit.getByLabel('Day', { exact: true }).fill('2021-10-04');
	await edit.getByLabel('Value (mm)', { exact: true }).fill('-1');
	await expect(edit.getByTestId('edit-day-invalid')).toContainText('never below zero');
	await expect(edit.getByRole('button', { name: 'Save the day' })).toBeDisabled();
	await edit.getByLabel('Value (mm)', { exact: true }).fill('abc');
	await expect(edit.getByTestId('edit-day-invalid')).toContainText('Type a number');
	await edit.getByLabel('Value (mm)', { exact: true }).fill('');
	const cleared = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/days/2021-10-04`));
	await edit.getByRole('button', { name: 'Clear the day' }).click();
	expect((await cleared).request().postDataJSON()).toEqual({ value: null });
	await expect(edit.getByTestId('edit-day-done')).toContainText('Cleared 2021-10-04.');
	await expect(row.getByTestId('series-hand')).toHaveText('1 day edited by hand');
	await expect(edit.getByTestId('edit-day-stored')).toContainText('Stored: no reading, edited by hand.');
});

test('a viewer sees the hand-edit mark but no Edit a day', async ({ page, owner, signIn }) => {
	void owner;
	const { project, edit } = await onData(page, 'Hand viewer');
	await edit.getByLabel('Day', { exact: true }).fill('2021-10-03');
	await edit.getByLabel('Value (mm)', { exact: true }).fill('2');
	await edit.getByRole('button', { name: 'Save the day' }).click();
	await expect(edit.getByTestId('edit-day-done')).toBeVisible();
	await expectNoViolations(page);

	const viewer = await signIn('Hand viewer reader');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=series`);
	const row = viewer.page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Rainfall — catchment' });
	await expect(row.getByTestId('series-hand')).toHaveText('1 day edited by hand');
	await row.getByRole('button', { name: 'View', exact: true }).click();
	await expect(viewer.page.getByTestId('series-hand-days')).toHaveText('2021-10-03');
	await expect(viewer.page.getByRole('group', { name: 'Edit a day' })).toHaveCount(0);
});

test('rows pasted from a spreadsheet are read like a file, previewed, and asked about before they overwrite', async ({ page, owner }) => {
	void owner;
	const { row } = await onData(page, 'Paste rows');
	await page.getByRole('button', { name: 'Add data', exact: true }).click();
	const dialog = addDataDialog(page);
	await dialog.getByRole('radio', { name: 'Rows pasted from a spreadsheet' }).check();
	await expect(dialog.getByLabel('CSV file or DWS export', { exact: true })).toHaveCount(0);
	// The upload's Expected format note, in the paste's own words.
	await dialog.getByText('Expected format', { exact: true }).click();
	await expect(dialog).toContainText('Rows copied from a spreadsheet');
	await expect(dialog.getByRole('button', { name: 'Save and merge' })).toBeDisabled();

	// A block as a spreadsheet copies it: tab-separated, a header, a decimal comma, a blank cell.
	await dialog.getByLabel('Dates and values').fill('Date\tRain\n2021-10-02\t9,5\n2021-10-03\t\n2021-10-11\t4\n2021-10-12\t1');
	await expect(dialog.getByLabel('Pasted rows summary')).toContainText('2021-10-02 → 2021-10-12');
	await expect(dialog.getByText('Pasted rows preview', { exact: true })).toBeVisible();
	await dialog.getByRole('button', { name: 'Save and merge' }).click();
	const confirm = dialog.getByTestId('overwrite-confirm');
	await expect(confirm).toContainText('This changes 1 day already stored in “Rainfall — catchment”');
	const merged = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/series/merge'));
	await dialog.getByRole('button', { name: 'Overwrite 1 day' }).click();
	expect((await merged).status()).toBe(200);
	await expect(dialog).toBeHidden();
	await expect(page.getByText('Updated “Rainfall — catchment”: 2 new days, 1 changed. Data now runs to 2021-10-12.')).toBeVisible();
	// A paste is data from elsewhere, like a file: no day of it is marked as edited by hand.
	await expect(row.getByTestId('series-hand')).toHaveCount(0);
});

test('a bad pasted row is named by its line, and closing asks before the rows are thrown away', async ({ page, owner }) => {
	void owner;
	await onData(page, 'Paste bad');
	await page.getByRole('button', { name: 'Add data', exact: true }).click();
	const dialog = addDataDialog(page);
	await dialog.getByRole('radio', { name: 'Rows pasted from a spreadsheet' }).check();
	await dialog.getByLabel('Dates and values').fill('2021-10-02\t1\nyesterday\t2');
	await expect(dialog.getByRole('alert')).toContainText('Pasted rows: Line 2: "yesterday" is not a date');
	await dialog.getByLabel('Dates and values').fill('2021-10-11\t1');
	await expectNoViolations(page, { include: '[role="dialog"]' });
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByRole('alertdialog')).toContainText('Discard the pasted rows?');
});
