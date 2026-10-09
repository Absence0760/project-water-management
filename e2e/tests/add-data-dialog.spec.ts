// The header's Add data dialog (docs/ui.md § Header: data freshness and "Add
// data"): what it shows, the ways it opens (the button, a CSV dropped on the
// page) and closes (Escape, the close button, Cancel, an upload), the question
// before a read file is thrown away, where focus goes, and a11y at desktop and
// phone. It is the app's shared Dialog: the drawn close button, and Cancel and
// the upload button at the right of the action row. Synthetic series only.
import { expectNoViolations } from '../support/a11y.ts';
import { addDataDialog, csv, dropCsv } from '../support/addData.ts';
import { addMember, createProject, putSeries, syntheticRain } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import type { Page } from '@playwright/test';
import { answerConfirm } from '../support/confirm.ts';

const RAIN = { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(30) };
const NEW_DAYS = 'date,value\n2021-10-31,4\n2021-11-01,1\n';

async function seeded(page: Page, name: string) {
	const project = await createProject(page.request, name);
	await putSeries(page.request, project.id, RAIN);
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	return project;
}

const addButton = (page: Page) => page.getByRole('button', { name: 'Add data', exact: true });

test('the dialog shows the upload form, closes on Escape and gives focus back to Add data', async ({ page, owner }) => {
	void owner;
	await seeded(page, 'Add data form');
	const dialog = addDataDialog(page);
	await addButton(page).click();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('heading', { level: 2, name: 'Add data' })).toBeVisible();
	await expect(dialog).toContainText('Upload a CSV (or a DWS export) of daily rainfall, flow or evaporation. New days are appended to the matching series');
	await expect(dialog.getByText('Expected format', { exact: true })).toBeVisible();
	for (const label of ['CSV file or DWS export', 'Kind', 'Unit']) await expect(dialog.getByLabel(label, { exact: true })).toBeVisible();
	// The kind's own tip, beside the field where the kind is chosen.
	await expect(dialog.getByRole('button', { name: 'About Catchment rainfall' })).toBeVisible();
	await expect(dialog.getByLabel(/^Name/)).toBeVisible();
	// The one series of the default kind is picked, so the form offers to merge into it; nothing to send yet.
	await expect(dialog.getByRole('group', { name: /“Rainfall — catchment” already exists/ })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toBeDisabled();

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(addButton(page)).toBeFocused();
});

test('it is the shared dialog: a drawn close button, and Cancel then the upload button at the right of the action row', async ({ page, owner }) => {
	void owner;
	await seeded(page, 'Add data layout');
	const dialog = addDataDialog(page);
	await addButton(page).click();
	// The close button draws its cross (an SVG), not a font's ✕, which some fonts render as a plain X.
	const close = dialog.getByRole('button', { name: 'Close dialog' });
	await expect(close).toHaveText('');
	await expect(close.locator('svg')).toHaveCount(1);
	const actions = dialog.locator('.actions').getByRole('button');
	await expect(actions).toHaveText(['Cancel', 'Upload and merge']);
	const box = (await dialog.boundingBox())!;
	const upload = (await actions.nth(1).boundingBox())!;
	const cancel = (await actions.nth(0).boundingBox())!;
	// Right-aligned inside the dialog's padding (1.25rem = 17.5 px), side by side on one line.
	expect(box.x + box.width - (upload.x + upload.width)).toBeLessThan(24);
	expect(cancel.x + cancel.width).toBeLessThanOrEqual(upload.x);
	expect(Math.abs(cancel.y - upload.y)).toBeLessThan(2);
	// Cancel with nothing read closes at once and gives focus back.
	await actions.nth(0).click();
	await expect(dialog).toBeHidden();
	await expect(addButton(page)).toBeFocused();
});

test('the close button closes at once with nothing read, and asks before discarding a read file', async ({ page, owner }) => {
	void owner;
	await seeded(page, 'Add data close');
	const dialog = addDataDialog(page);
	const closeButton = dialog.getByRole('button', { name: /^Close/ });

	await addButton(page).click();
	await closeButton.click();
	await expect(dialog).toBeHidden();
	await expect(addButton(page)).toBeFocused();

	await addButton(page).click();
	await dialog.getByLabel('CSV file').setInputFiles(csv('rain.csv', NEW_DAYS));
	await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toBeEnabled();
	await closeButton.click();
	await answerConfirm(page, false, 'Discard the file?');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toBeEnabled();

	await closeButton.click();
	await answerConfirm(page, true);
	await expect(dialog).toBeHidden();
	// Opened again, the form starts empty.
	await addButton(page).click();
	await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toBeDisabled();
});

test('a CSV dropped on the page opens the dialog with the file read; uploading it closes the dialog and says what changed', async ({ page, owner }) => {
	void owner;
	await seeded(page, 'Add data drop');
	const dialog = addDataDialog(page);
	await dropCsv(page, 'Rainfall — catchment.csv', NEW_DAYS);
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Looks like Rainfall — catchment');
	const summary = dialog.getByRole('definition').filter({ hasText: '2021-10-31 → 2021-11-01' });
	await expect(summary).toBeVisible();
	await expect(dialog.getByText('File preview', { exact: true })).toBeVisible();

	await dialog.getByRole('button', { name: 'Upload and merge' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText('Updated “Rainfall — catchment”: 2 new days, 0 changed. Data now runs to 2021-11-01.')).toBeVisible();
});

test('an upload that changes stored days asks in the dialog; Back returns to the upload button', async ({ page, owner }) => {
	void owner;
	await seeded(page, 'Add data confirm');
	const dialog = addDataDialog(page);
	await addButton(page).click();
	await dialog.getByLabel('CSV file').setInputFiles(csv('rain.csv', 'date,value\n2021-10-02,9\n2021-10-03,3\n'));
	await dialog.getByRole('button', { name: 'Upload and merge' }).click();
	const confirm = dialog.getByTestId('overwrite-confirm');
	await expect(confirm).toContainText('This changes 2 days already stored in “Rainfall — catchment”');
	await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toHaveCount(0);
	// The action row asks too: Back beside Overwrite, where Cancel and Upload were.
	await expect(dialog.locator('.actions').getByRole('button')).toHaveText(['Back', 'Overwrite 2 days']);
	const back = dialog.getByRole('button', { name: 'Back', exact: true });
	await back.click();
	await expect(confirm).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toBeEnabled();
	// The button that was Back is Cancel again and keeps the focus; Cancel asks before discarding the file.
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await answerConfirm(page, false, 'Discard the file?');
	await expect(dialog).toBeVisible();
});

test('a viewer has no Add data, and a dropped file opens nothing', async ({ page, owner, signIn }) => {
	const project = await createProject(page.request, 'Add data viewer');
	await putSeries(page.request, project.id, RAIN);
	const viewer = await signIn('Add data viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	void owner;
	const v = viewer.page;
	await v.goto(`/projects/${project.id}`);
	await expect(v.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await expect(v.getByRole('button', { name: 'Add data', exact: true })).toHaveCount(0);
	await dropCsv(v, 'rain.csv', NEW_DAYS);
	await expect(addDataDialog(v)).toHaveCount(0);
});

for (const size of [
	{ name: 'desktop', width: 1440, height: 960 },
	{ name: 'phone', width: 390, height: 844 }
]) {
	test(`the dialog with a file read has no a11y violations (${size.name})`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: size.width, height: size.height });
		await seeded(page, `Add data a11y ${size.name}`);
		const dialog = addDataDialog(page);
		await dropCsv(page, 'rain.csv', NEW_DAYS);
		await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toBeEnabled();
		await expectNoViolations(page, { include: 'dialog[open]' });
		// No sideways scroll in the dialog or the page.
		expect(await dialog.evaluate((d) => d.scrollWidth - d.clientWidth)).toBeLessThanOrEqual(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
	});
}

test('a failed read of the stored series says so and Try again recovers', async ({ page, owner }) => {
	void owner;
	// Every read of a series' values fails at the network until the route is lifted (the summary may have warmed the cache otherwise).
	let fail = true;
	await page.route(/\/series\/[^/?]+$/, async (route) => {
		if (route.request().method() !== 'GET' || !fail) return route.fallback();
		await route.abort('connectionrefused');
	});
	await seeded(page, 'Add data stored read fails');
	const dialog = addDataDialog(page);
	await addButton(page).click();
	await dialog.getByLabel('CSV file', { exact: false }).setInputFiles(csv('rain.csv', NEW_DAYS));
	const err = dialog.getByTestId('target-error');
	await expect(err).toBeVisible();
	await expect(dialog.getByText('Comparing with the stored series…')).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toBeDisabled();

	fail = false;
	await err.getByRole('button', { name: 'Try again' }).click();
	await expect(err).toHaveCount(0);
	const newDays = dialog.getByRole('term').filter({ hasText: /^New days$/ });
	await expect(newDays).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Upload and merge' })).toBeEnabled();
});

test('a refused upload shows its reason in view beside the action, and another file clears it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 640 });
	await page.route(/\/series\/merge$/, (route) =>
		route.request().method() === 'POST'
			? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This series holds another version.' }) })
			: route.fallback()
	);
	await seeded(page, 'Add data refused');
	const dialog = addDataDialog(page);
	await addButton(page).click();
	// A long file: the summary and the preview chart make the form taller than the dialog.
	const long = ['date,value', ...Array.from({ length: 60 }, (_, i) => `${new Date(Date.UTC(2021, 9, 31 + i)).toISOString().slice(0, 10)},${i % 7}`)].join('\n');
	await dialog.getByLabel('CSV file', { exact: false }).setInputFiles(csv('rain.csv', long));
	await dialog.getByRole('button', { name: 'Upload and merge' }).click();
	const alert = dialog.getByTestId('upload-error');
	await expect(alert).toHaveText('This series holds another version.');
	await expect(alert).toBeInViewport();
	await dialog.getByLabel('CSV file', { exact: false }).setInputFiles(csv('rain2.csv', NEW_DAYS));
	await expect(alert).toHaveCount(0);
});

test('a new series of a kind that has one says whether runs will read it, and offers a name that differs only in case', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Add data second series');
	await putSeries(page.request, project.id, { ...RAIN, name: 'Station 0021' });
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	const dialog = addDataDialog(page);
	await addButton(page).click();
	const name = dialog.getByLabel(/^Name/);
	const effect = dialog.getByTestId('new-series-effect');

	await name.fill('Aa station');
	await expect(effect).toContainText('Creates a second Rainfall — catchment series. Runs read the first by name, so this one will replace “Station 0021” in runs.');
	await name.fill('Zz station');
	await expect(effect).toContainText('so they keep reading “Station 0021”.');
	await name.fill('station 0021');
	await expect(effect).toContainText('Did you mean “Station 0021”?');
	await effect.getByRole('button', { name: 'Use “Station 0021”' }).click();
	await expect(name).toHaveValue('Station 0021');
	await expect(dialog.getByRole('group', { name: /“Station 0021” already exists/ })).toBeVisible();
});

test('the alternative gauge’s product and version are one optional pair: one without the other is said and blocks the upload', async ({ page, owner }) => {
	void owner;
	await seeded(page, 'Add data half label');
	const dialog = addDataDialog(page);
	await addButton(page).click();
	await dialog.getByLabel('Kind').selectOption('rain_catchment_alt_mm');
	await dialog.getByLabel('CSV file', { exact: false }).setInputFiles(csv('aws.csv', NEW_DAYS));
	await expect(dialog.getByRole('group', { name: 'Product and version (optional)' })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Upload' })).toBeEnabled();
	await dialog.getByLabel('Product', { exact: true }).fill('SASSCAL AWS');
	await expect(dialog.getByTestId('half-label')).toHaveText('Give both, or leave both blank.');
	await expect(dialog.getByLabel('Version', { exact: true })).toHaveAttribute('aria-invalid', 'true');
	await expect(dialog.getByRole('button', { name: 'Upload' })).toBeDisabled();
	await dialog.getByLabel('Version', { exact: true }).fill('1');
	await expect(dialog.getByTestId('half-label')).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: 'Upload' })).toBeEnabled();
});

test('while uploading, Cancel is disabled and Escape doesn’t ask to discard a file already on its way', async ({ page, owner }) => {
	void owner;
	let release: () => void = () => {};
	const held = new Promise<void>((r) => (release = r));
	await page.route(/\/series\/merge$/, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		await held;
		await route.fallback();
	});
	await seeded(page, 'Add data uploading');
	const dialog = addDataDialog(page);
	await addButton(page).click();
	await dialog.getByLabel('CSV file', { exact: false }).setInputFiles(csv('rain.csv', NEW_DAYS));
	await dialog.getByRole('button', { name: 'Upload and merge' }).click();
	await expect(dialog.getByRole('button', { name: 'Uploading…' })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(dialog).toBeVisible();
	release();
	await expect(dialog).toBeHidden();
	await expect(page.getByText('Updated “Rainfall — catchment”: 2 new days')).toBeVisible();
});

test('a second file dropped on a read one asks before replacing it', async ({ page, owner }) => {
	void owner;
	await seeded(page, 'Add data drop twice');
	const dialog = addDataDialog(page);
	await dropCsv(page, 'Rainfall — catchment.csv', NEW_DAYS);
	await expect(dialog.getByRole('definition').filter({ hasText: '2021-10-31 → 2021-11-01' })).toBeVisible();

	await dropCsv(page, 'other.csv', 'date,value\n2021-11-05,2\n');
	await answerConfirm(page, false, 'Replace the file?');
	await expect(dialog.getByRole('definition').filter({ hasText: '2021-10-31 → 2021-11-01' })).toBeVisible();

	await dropCsv(page, 'other.csv', 'date,value\n2021-11-05,2\n');
	await answerConfirm(page, true, 'Replace the file?');
	await expect(dialog.getByRole('definition').filter({ hasText: '2021-11-05 → 2021-11-05' })).toBeVisible();
});
