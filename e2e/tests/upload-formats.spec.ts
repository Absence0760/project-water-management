// Every file upload and paste box says what it expects (issue #456, docs/ui.md
// § Expected format): a closed "Expected format" beside the box with the file
// types, the structure and an example, and where it helps an example file to
// download. The examples are proved here by feeding them back into the box
// they describe, through the real parsers (the browser's and the server's).
// Synthetic data only.
import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addDataDialog } from '../support/addData.ts';
import { openAllocations } from '../support/allocations.ts';
import { createProject, putModel, putSeries, sampleModel, seedRunnableProject, syntheticRain } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap, openUploadSheet } from '../support/map.ts';

/** Opens the box's "Expected format" and checks its first line says what it takes. */
async function openFormat(scope: Locator, accepts: string | RegExp): Promise<Locator> {
	const help = scope.getByTestId('format-help');
	await expect(help).toHaveCount(1);
	await expect(help).not.toHaveAttribute('open', '');
	await help.getByText(/^Expected format/).click();
	await expect(help.getByTestId('format-accepts')).toHaveText(accepts);
	return help;
}

/** Clicks the example file's link and returns its name and text. */
async function downloadExample(page: Page, help: Locator): Promise<{ name: string; text: string }> {
	const [download] = await Promise.all([page.waitForEvent('download'), help.getByRole('link', { name: 'Download an example file' }).click()]);
	return { name: download.suggestedFilename(), text: await readFile((await download.path())!, 'utf8') };
}

const file = (name: string, text: string, mimeType = 'text/csv') => ({ name, mimeType, buffer: Buffer.from(text) });

test('Add data: the expected format, and its example file reads as a week with three gaps', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Formats add data');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(30) });
	await page.goto(`/projects/${project.id}`);
	await page.getByRole('button', { name: 'Add data', exact: true }).click();
	const dialog = addDataDialog(page);
	const help = await openFormat(dialog, /^A \.csv, \.tsv or \.txt file, or a DWS daily export/);
	await expect(help.getByTestId('format-example')).toHaveText('date,value\n2025-04-01,0.0\n2025-04-02,12.4\n2025-04-03,');
	await expect(help).toContainText('Several readings a day');
	await expect(help).toContainText('Blank, NA, NaN, null or - = no reading');
	await expectNoViolations(page, { include: 'dialog[open]' });

	const example = await downloadExample(page, help);
	expect(example.name).toBe('example-daily-rainfall.csv');
	await dialog.getByLabel('CSV file or DWS export', { exact: true }).setInputFiles(file(example.name, example.text));
	const summary = dialog.getByLabel('File summary');
	await expect(summary).toContainText('2025-04-01 → 2025-04-07');
	await expect(summary).toContainText(/Gaps\s*3/);
	await expect(dialog.getByTestId('negative-gaps')).toContainText('1 read as gaps');
	await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('Allocations import: the expected format, and its example imports through the server’s parser', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Formats allocations');
	await openAllocations(page, project.id, '&import=1');
	const sheet = page.getByTestId('allocation-import');
	const help = await openFormat(sheet, /^A CSV file \(\.csv\), comma- or semicolon-separated/);
	await expect(help).toContainText('Every file needs a volume column');
	await expectNoViolations(page, { include: 'dialog[open]' });

	const example = (await help.getByTestId('format-example').textContent())!;
	await sheet.getByLabel('What the file is').selectOption('csv');
	await sheet.getByLabel('File (CSV, up to 2 MB)').setInputFiles(file('example.csv', example));
	// Both rows read without a problem; their invented farm isn't in this catchment, so neither is matched.
	await expect(page.getByTestId('allocation-preview-summary')).toHaveText('example.csv: 2 rows, 0 matched to a hydrological unit, 2 not matched.');
});

test('Invite farmers: the expected format, and its example file previews row by row', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Formats invite');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=project`);
	await page.getByRole('region', { name: /^Farmers/ }).getByRole('button', { name: 'Invite farmers' }).click();
	const dialog = page.getByRole('dialog', { name: 'Invite farmers' });
	await dialog.getByLabel('Several, from a CSV').check();
	const help = await openFormat(dialog, 'Paste the rows, or upload a .csv or .txt file, in UTF-8.');
	await expect(help).toContainText('A header row is optional');
	await expectNoViolations(page, { include: 'dialog[open]' });

	const example = await downloadExample(page, help);
	expect(example.name).toBe('invite-farmers-example.csv');
	await dialog.getByLabel('…or upload a .csv file').setInputFiles(file(example.name, example.text));
	await dialog.getByRole('button', { name: 'Preview' }).click();
	const results = dialog.getByRole('region', { name: /^Preview/ });
	// Built from the catchment's own units, so every row would be invited; nothing is sent by a preview.
	await expect(results.getByRole('heading')).toHaveText(/^Preview: \d+ to invite$/);
	await expect(results.getByRole('row').nth(1)).toHaveText(/^2\s*farmer1@example\.com\s*.+\s*Will be invited by email$/);
});

test('Map upload: the expected format, and its example file passes the server’s checks with each kind named', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Formats map');
	await openMap(page, project.id);
	const sheet = await openUploadSheet(page);
	const help = await openFormat(sheet, /^A GeoJSON file \(\.geojson or \.json\): at most 5 MB/);
	await expect(help).toContainText('Shapefiles and KML aren’t read');
	await expectNoViolations(page, { include: 'dialog[open]' });

	const example = await downloadExample(page, help);
	expect(example.name).toBe('example-features.geojson');
	await sheet.getByLabel(/^GeoJSON file/).setInputFiles(file(example.name, example.text, 'application/geo+json'));
	await sheet.getByRole('button', { name: 'Review', exact: true }).click();
	await expect(sheet.getByTestId('map-review-summary')).toContainText('4 features (1 catchment boundary, 1 farm parcel, 1 gauge, 1 river)');
	await expect(sheet.getByTestId('map-import-error')).toHaveCount(0);
});

test('Load crop factors: each workbook source says what its sheet must hold', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Formats crop factors');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.getByRole('button', { name: 'Load crop factors…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Load crop factors' });
	// The reference library reads no file, so there is nothing to describe.
	await expect(dialog.getByTestId('format-help')).toHaveCount(0);
	await dialog.getByRole('radio', { name: 'A b023 workbook' }).check();
	let help = await openFormat(dialog, /^A b023 Water Balance Tool workbook \(\.xlsx or \.xlsm\)/);
	await expect(help).toContainText('[Crop demand]');
	await dialog.getByRole('radio', { name: 'A hydrological-unit-based workbook' }).check();
	help = await openFormat(dialog, /with a sheet named Crop_Factors/);
	await expect(help.getByTestId('format-example')).toContainText('Crop      Oct');
	await expectNoViolations(page, { include: 'dialog[open]' });
});

test('Project import and API keys: the expected format of a project file, a workbook and an ingest request', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await expect(page.getByText('You have no projects yet.')).toBeVisible();
	for (const [button, title, accepts] of [
		['Import b023 workbook', 'Import b023 workbook', /^A b023 Water Balance Tool workbook \(\.xlsm or \.xlsx\)/],
		['Import project file (.json)', 'Import project file', /^A project file \(\.json\), at most 5 MB/]
	] as const) {
		await page.getByRole('button', { name: button, exact: true }).click();
		const dialog = page.getByRole('dialog', { name: title });
		await openFormat(dialog, accepts);
		await expectNoViolations(page, { include: 'dialog[open]' });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}

	const project = await createProject(page.request, 'Formats ingest');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'API keys' });
	const help = panel.getByTestId('format-help');
	await help.getByText('Expected format of a request').click();
	await expect(help.getByTestId('format-accepts')).toContainText('/ingest/v1/series/merge');
	await expect(help.getByTestId('format-example')).toContainText('"kind": "rain_catchment_mm"');
	await expect(help).toContainText('a null clears its day');
});
