// Import a b023 workbook in the browser (WP-1.31): "Import b023 workbook" on
// the project list reads the committed synthetic workbook (invented data,
// scripts/wbt-import/fixtures/) in a Web Worker, shows the review (counts,
// the importer's notes, the unmapped report with Echo Farm's hand-written
// InOut formula), imports it with a first run, and the project opens with
// results, whose Overview keeps the import record (the same notes and
// unmapped report, 017_project_import). The run-of-river option converts the
// units the importer flags, as the Python importer's --run-of-river does. A workbook that isn't b023 names the
// ranges it lacks; a farm name that looks like HTML shows as text; and the
// review and the import record pass axe in both themes and on a phone.
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const FIXTURE = new URL('../../scripts/wbt-import/fixtures/synthetic_b023.xlsx', import.meta.url);
const XLSM = 'application/vnd.ms-excel.sheet.macroEnabled.12';

const synthetic = () => ({ name: 'synthetic_b023.xlsx', mimeType: XLSM, buffer: readFileSync(FIXTURE) });

/** A workbook that isn't b023: one plain sheet, no named ranges. */
function otherWorkbook() {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Farm', 'Area (ha)'], ['North', 12]]), 'Farms');
	return { name: 'farm_list.xlsx', mimeType: XLSM, buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer };
}

/** The synthetic workbook with Echo Farm renamed to an HTML payload in every text cell that names it. */
function hostileWorkbook(payload: string) {
	const wb = XLSX.read(readFileSync(FIXTURE), { cellNF: true, cellFormula: false });
	for (const ws of Object.values(wb.Sheets)) {
		for (const [addr, cell] of Object.entries(ws)) {
			if (!addr.startsWith('!') && cell && typeof cell === 'object' && 't' in cell && cell.t === 's' && /Echo\s+Farm/.test(String(cell.v))) {
				// The fixture also spells it with odd spacing, which the importer normalises.
				cell.v = String(cell.v).replace(/Echo\s+Farm/g, payload);
				delete cell.w;
			}
		}
	}
	return { name: 'hostile_b023.xlsx', mimeType: XLSM, buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer };
}

async function openWorkbookImport(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Import b023 workbook' }).click();
	const dialog = page.getByRole('dialog', { name: 'Import b023 workbook' });
	await expect(dialog.getByLabel('b023 workbook (.xlsm or .xlsx)')).toBeVisible();
	return dialog;
}

/** Pick the file and wait for the review (the name field is filled from the file name). */
async function review(dialog: Locator, file: { name: string; mimeType: string; buffer: Buffer }, expectedName: string) {
	await dialog.getByLabel('b023 workbook (.xlsm or .xlsx)').setInputFiles(file);
	await expect(dialog.getByLabel('Name')).toHaveValue(expectedName);
}

/**
 * The synthetic workbook's notes and unmapped report as the review renders
 * them: the count sentences, the severity badges, and the table's columns.
 */
async function expectReportLists(notes: Locator, unmapped: Locator) {
	await expect(notes.getByRole('heading', { level: 3 })).toHaveText('Importer notes');
	await expect(notes.getByRole('paragraph').first()).toHaveText('20 notes, 8 of them warnings. Read them before relying on a run.');
	// Foxtrot's transfer to Golf and India's to Delta have a =0 draw formula (switched off, issue #54); Delta Farm has
	// no dam but all the upstream inflow, and India Farm's dam is a pool on the river (issue #54, 2d); Charlie Farm's
	// gross demand is typed over the [Farm demand] formula (issue #54); India's transfer into Delta (no dam, no
	// demand) is a river off-take (engine 1.14.0). Fodder E has a lone 0 and a spike above 1, and Pasture F is Pasture C's
	// row pasted ([Crop demand] checks, issue #289).
	await expect(notes.getByText('Warning', { exact: true })).toHaveCount(8);
	await expect(notes.getByText('Note', { exact: true })).toHaveCount(12);
	await expect(unmapped.getByRole('heading', { level: 3 })).toHaveText('Unmapped report: not carried across as the workbook meant');
	await expect(unmapped.getByRole('columnheader')).toHaveText(['Where', 'Element', 'What', 'In the workbook']);
	await expect(unmapped.getByRole('row')).toHaveCount(1 + 7);
	await expect(unmapped.getByRole('paragraph').first()).toHaveText(
		"The importer couldn't map these 7 items onto the app's model exactly. It never changes a value on its own: check each against the workbook, and fix the project after importing if needed."
	);
}

/** The project's Project page (issue #17) shows the import record: file, date and importer, then both lists behind their disclosures. */
async function expectImportRecord(page: Page, importedBy: string) {
	const record = page.getByRole('region', { name: 'Import record' });
	await expect(record.getByRole('paragraph').first()).toHaveText(
		new RegExp(`^Imported from the b023 workbook synthetic_b023\\.xlsx on \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} by ${importedBy}\\.$`)
	);
	const notes = record.getByRole('region', { name: 'Importer notes' });
	const unmapped = record.getByRole('region', { name: /^Unmapped report/ });
	// Closed at first: the count sentences show, the lists don't.
	await expect(notes.getByRole('listitem').first()).toBeHidden();
	await expect(unmapped.getByRole('table')).toBeHidden();
	await notes.getByText('Show the 20 notes').click();
	await unmapped.getByText('Show the 7 items').click();
	await expect(notes.getByRole('listitem')).toHaveCount(20);
	await expect(notes.getByRole('listitem').filter({ hasText: 'transfer Alpha Farm -> Zulu Farm names an unknown element; skipped' })).toHaveCount(1);
	const echo = unmapped.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Echo Farm', exact: true }) }).filter({ hasText: '=U7*0.9-X7' });
	await expect(echo.getByRole('code')).toHaveText('=U7*0.9-X7');
	await expectReportLists(notes, unmapped);
	return record;
}

/** Import the synthetic workbook through the dialog (no run) and open the project's Overview. */
async function importAndOpen(page: Page) {
	await page.goto('/');
	const dialog = await openWorkbookImport(page);
	await review(dialog, synthetic(), 'synthetic_b023');
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('dialog', { name: 'Project imported' }).getByRole('link', { name: 'Open project' }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: 'synthetic_b023' })).toBeVisible();
	// The import record is on the Project page (issue #17).
	await page.goto(`${page.url().split('?')[0]}?tab=project`);
}

test('imports the synthetic workbook with a first run, and the project opens with results', async ({ page, owner }) => {
	await page.goto('/');
	const dialog = await openWorkbookImport(page);
	await review(dialog, synthetic(), 'synthetic_b023');

	// The counts: 9 farms and 2 gauges, 6 crops on 11 planted areas, 6 transfers (two switched off), 4 series.
	await expect(dialog.getByText('From synthetic_b023.xlsx')).toBeVisible();
	const contents = dialog.getByRole('region', { name: 'In this workbook' });
	await expect(contents.getByRole('definition').nth(0)).toHaveText('9 hydrological units, 2 gauges');
	await expect(contents.getByRole('definition').nth(1)).toHaveText('6 crops, 11 planted areas');
	await expect(contents.getByRole('definition').nth(2)).toHaveText('6');
	await expect(contents.getByRole('definition').nth(3)).toHaveText('4');

	// The importer's notes, then the unmapped report with Echo's hand-written InOut formula.
	const notes = dialog.getByRole('region', { name: 'Importer notes' });
	await expect(notes.getByRole('listitem')).toHaveCount(20);
	await expect(notes.getByRole('listitem').filter({ hasText: 'transfer Foxtrot Farm -> Golf Farm (column AA): its draw formula is the constant 0' })).toHaveCount(1);
	await expect(notes.getByRole('listitem').filter({ hasText: 'transfer Alpha Farm -> Zulu Farm names an unknown element; skipped' })).toHaveCount(1);
	await expect(notes.getByRole('listitem').filter({ hasText: 'farm India Farm: probable run-of-river, for the modeller to confirm' })).toHaveCount(1);
	// b023's upstream inflow % is stored as 1 − the value: its formula sent that share past the dam (model.md §3 Q1).
	await expect(notes.getByRole('listitem').filter({ hasText: "stores 100 % − the workbook's value" })).toHaveCount(1);
	const unmapped = dialog.getByRole('region', { name: /^Unmapped report/ });
	const echo = unmapped.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Echo Farm', exact: true }) }).filter({ hasText: '=U7*0.9-X7' });
	await expect(echo).toHaveCount(1);
	await expect(echo.getByRole('code')).toHaveText('=U7*0.9-X7');
	// How the two lists render (pinned before they were shared with the Overview's import panel).
	await expectReportLists(notes, unmapped);

	// The gauge option re-reads the workbook already in the worker: a warning appears, no new file needed.
	await dialog.getByLabel("It's a gauge on another river: import it as a reference gauge").check();
	await expect(notes.getByText(/gauge column imported as flow_reference_m3s/)).toBeVisible();
	await dialog.getByLabel("It's a gauge on another river: import it as a reference gauge").uncheck();
	await expect(notes.getByText(/gauge column imported as flow_reference_m3s/)).toHaveCount(0);

	// The CHIRPS column's product and version (issue #40c): v2.0 by default, what b023 workbooks were built on.
	const chirps = dialog.getByLabel('CHIRPS column');
	await expect(chirps).toHaveValue('CHIRPS/2.0');
	await expect(chirps).toHaveAccessibleDescription(/b023 workbooks were built on v2\.0; the CHIRPS data feed writes v3\.0/);

	await dialog.getByLabel('Name').fill('Synthetic — from the workbook');
	await dialog.getByLabel('Run the model after importing').check();
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();

	const done = page.getByRole('dialog', { name: 'Project imported' });
	await expect(done.getByRole('status')).toHaveText(/Imported Synthetic — from the workbook\.\s+Its first run is ready on the Runs tab\./);
	await expect(done.getByRole('alert')).toHaveCount(0);
	await done.getByRole('link', { name: 'Open project' }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: 'Synthetic — from the workbook' })).toBeVisible();

	// The Project page keeps what the importer flagged: the same notes and unmapped report, each list closed at first.
	await page.goto(`${page.url().split('?')[0]}?tab=project`);
	await expectImportRecord(page, owner.displayName);

	await page.goto(`${page.url().split('?')[0]}?tab=runs`);
	await expect(page.getByRole('region', { name: 'Run summary' })).toBeVisible();

	// What was sent is what the workbook holds: the same series as the Python importer's committed output.
	const id = new URL(page.url()).pathname.split('/').pop()!;
	const exported = (await (await page.request.get(`${API_URL}/projects/${id}/export.json`)).json()) as {
		series: { kind: string; values: unknown[]; product?: string; productVersion?: string }[];
	};
	// The CHIRPS series went in labelled with the review's answer; the others have no version.
	expect(exported.series.filter((x) => x.product).map((x) => [x.kind, x.product, x.productVersion])).toEqual([['rain_chirps_mm', 'CHIRPS', '2.0']]);
	const expected = JSON.parse(readFileSync(new URL('../../scripts/wbt-import/fixtures/synthetic_b023.project.json', import.meta.url), 'utf8')) as {
		series: { kind: string; values: unknown[] }[];
	};
	const byKind = (s: { kind: string; values: unknown[] }[]) => Object.fromEntries(s.map((x) => [x.kind, x.values]));
	expect(byKind(exported.series)).toEqual(byKind(expected.series));
});

test('the run-of-river option imports the flagged units as river pumping units, as --run-of-river does', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	const dialog = await openWorkbookImport(page);
	await review(dialog, synthetic(), 'synthetic_b023');
	// Off by default; it names the units the importer flags (issue #54, 2c/2d).
	const option = dialog.getByLabel('Import these 2 as run of river, pumping from the river');
	await expect(option).not.toBeChecked();
	await expect(option).toHaveAccessibleDescription(/flags 2 units as probable run-of-river: Delta Farm, India Farm\..*no pump limit until you enter the pump capacities/);
	const notes = dialog.getByRole('region', { name: 'Importer notes' });
	const converted = notes.getByRole('listitem').filter({ hasText: 'imported as run of river (--run-of-river)' });
	await expect(converted).toHaveCount(0);

	// On: the workbook already in the worker is extracted again, with one more warning per unit; off again undoes it.
	await option.check();
	await expect(converted).toHaveCount(2);
	await expect(notes.getByRole('paragraph').first()).toHaveText('22 notes, 10 of them warnings. Read them before relying on a run.');
	await option.uncheck();
	await expect(converted).toHaveCount(0);
	await option.check();
	await expect(converted).toHaveCount(2);

	await dialog.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('dialog', { name: 'Project imported' }).getByRole('link', { name: 'Open project' }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: 'synthetic_b023' })).toBeVisible();

	// What was stored is the Python importer's --run-of-river project: Delta and India pump from the river, uncapped, with no dam.
	const id = new URL(page.url()).pathname.split('/').pop()!;
	type Node = { name: string; supplyRule?: string; pumpCapacityM3Day?: number | null; damCapacityM3: number };
	const exported = (await (await page.request.get(`${API_URL}/projects/${id}/export.json`)).json()) as { model: { nodes: Node[] } };
	const expected = JSON.parse(readFileSync(new URL('../../scripts/wbt-import/fixtures/synthetic_b023.run-of-river.project.json', import.meta.url), 'utf8')) as {
		model: { nodes: Node[] };
	};
	const runOfRiver = (nodes: Node[]) => nodes.filter((n) => n.supplyRule === 'runOfRiver').map((n) => [n.name, n.damCapacityM3, n.pumpCapacityM3Day]);
	expect(runOfRiver(exported.model.nodes)).toEqual([
		['Delta Farm', 0, null],
		['India Farm', 0, null]
	]);
	expect(runOfRiver(exported.model.nodes)).toEqual(runOfRiver(expected.model.nodes));
});

test('a workbook that is not b023 names the ranges it lacks, and Cancel leaves nothing behind', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	const dialog = await openWorkbookImport(page);
	await dialog.getByLabel('b023 workbook (.xlsm or .xlsx)').setInputFiles(otherWorkbook());
	const alert = dialog.getByRole('alert');
	await expect(alert).toContainText("This isn't a b023 Water Balance Tool workbook.");
	await expect(alert).toContainText('Every b023 workbook has these named ranges, and this one lacks 47 of them:');
	await expect(alert.getByRole('listitem').first()).toHaveText('zNetwork_ElementNameLst');
	await expect(alert.getByRole('listitem').last()).toHaveText('and 39 more');
	await expectNoViolations(page);

	// Not a workbook at all, under a workbook's name.
	await dialog.getByLabel('b023 workbook (.xlsm or .xlsx)').setInputFiles({ name: 'rain.xlsx', mimeType: XLSM, buffer: Buffer.from('date,rain\n') });
	await expect(dialog.getByRole('alert')).toContainText("The file couldn't be opened as a workbook.");

	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByText('You have no projects yet.')).toBeVisible();
	const list = (await (await page.request.get(`${API_URL}/projects`)).json()) as { projects: unknown[] };
	expect(list.projects).toEqual([]);
});

test('closing the dialog mid-import: the late answer never overwrites a new pick', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	let release: () => void = () => {};
	const held = new Promise<void>((r) => (release = r));
	let posted: () => void = () => {};
	const reached = new Promise<void>((r) => (posted = r));
	await page.route('**/projects/import**', async (route) => {
		posted();
		await held;
		await route.continue();
	});
	const dialog = await openWorkbookImport(page);
	await review(dialog, synthetic(), 'synthetic_b023');
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();
	await reached;
	// Closing doesn't stop the request (the project still lands, below), so the button says Close, not Cancel.
	await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	const again = await openWorkbookImport(page);
	const answered = page.waitForResponse((r) => r.url().includes('/projects/import'));
	release();
	await answered;
	// The list reloads with the project the first import made …
	await expect(page.getByRole('rowheader', { name: 'synthetic_b023', exact: true })).toBeVisible();
	// … and the reopened dialog is still at its file picker.
	await expect(again.getByLabel('b023 workbook (.xlsm or .xlsx)')).toBeEnabled();
	await expect(page.getByRole('dialog', { name: 'Project imported' })).toHaveCount(0);
});

test('names from the workbook are shown as text, never as HTML', async ({ page, owner }) => {
	void owner;
	const payload = '<img src=x onerror="document.body.dataset.xss=1">Echo';
	await page.goto('/');
	const dialog = await openWorkbookImport(page);
	await review(dialog, hostileWorkbook(payload), 'hostile_b023');
	const unmapped = dialog.getByRole('region', { name: /^Unmapped report/ });
	await expect(unmapped.getByRole('cell', { name: payload, exact: true }).first()).toBeVisible();
	await expect(dialog.getByRole('region', { name: 'Importer notes' }).getByText(`farm ${payload}: [Farm spec] min dam %`)).toBeVisible();
	await expect(page.locator('dialog img')).toHaveCount(0);
	expect(await page.evaluate(() => document.body.dataset.xss)).toBeUndefined();

	// Stored with the project and shown again on its Project page: still text.
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('dialog', { name: 'Project imported' }).getByRole('link', { name: 'Open project' }).click();
	await expect(page.getByTestId('project-name').first()).toBeVisible();
	await page.goto(`${page.url().split('?')[0]}?tab=project`);
	const record = page.getByRole('region', { name: 'Import record' });
	const stored = record.getByRole('region', { name: /^Unmapped report/ });
	await stored.getByText(/^Show the \d+ items$/).click();
	await expect(stored.getByRole('cell', { name: payload, exact: true }).first()).toBeVisible();
	await record.getByRole('region', { name: 'Importer notes' }).getByText(/^Show the \d+ notes$/).click();
	await expect(record.getByText(`farm ${payload}: [Farm spec] min dam %`)).toBeVisible();
	await expect(page.locator('main img')).toHaveCount(0);
	expect(await page.evaluate(() => document.body.dataset.xss)).toBeUndefined();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} theme`, () => {
		test.use({ colorScheme });

		test('the workbook review has no violations', async ({ page, owner }) => {
			void owner;
			await page.goto('/');
			const dialog = await openWorkbookImport(page);
			await expectNoViolations(page);
			await review(dialog, synthetic(), 'synthetic_b023');
			await dialog.getByLabel("It's a gauge on another river: import it as a reference gauge").check();
			await expect(dialog.getByLabel('Scale factor (optional)')).toBeVisible();
			await dialog.getByLabel('Import these 2 as run of river, pumping from the river').check();
			await expect(dialog.getByRole('region', { name: 'Importer notes' }).getByText(/imported as run of river/)).toHaveCount(2);
			await expectNoViolations(page);
		});

		test('the Project page import record has no violations, open or closed', async ({ page, owner }) => {
			await importAndOpen(page);
			await expect(page.getByRole('region', { name: 'Import record' }).getByText('Show the 20 notes')).toBeVisible();
			await expectNoViolations(page);
			await expectImportRecord(page, owner.displayName);
			await expectNoViolations(page);
		});
	});
}

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the review fills the width with no sideways scroll', async ({ page, owner }) => {
		void owner;
		await page.goto('/');
		const dialog = await openWorkbookImport(page);
		await review(dialog, synthetic(), 'synthetic_b023');
		const box = (await dialog.boundingBox())!;
		// The page's width, not the 390 px viewport: the page always reserves room for a scrollbar
		// (app.css), 15 px in a desktop browser (a phone overlays it, so there the two are the same),
		// and the modal is centred in what is left.
		const pageWidth = await page.evaluate(() => document.body.getBoundingClientRect().width);
		// The 16 px gutter on both sides, exactly (the browser's own dialog cap made it 17).
		expect(Math.abs(box.x - 16)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(pageWidth - (box.x + box.width) - 16)).toBeLessThanOrEqual(0.5);
		expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
		await expectNoViolations(page);
	});

	test('the Project page import record fits the width, the wide table scrolling inside its own box', async ({ page, owner }) => {
		await importAndOpen(page);
		const record = await expectImportRecord(page, owner.displayName);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		const box = (await record.boundingBox())!;
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		await expectNoViolations(page);
	});
});
