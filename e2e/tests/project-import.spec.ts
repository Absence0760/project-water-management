// Import a project file from the project list (WP-1.8, POST /projects/import):
// an invented example catchment, exactly as `pnpm seed:examples` builds it,
// goes in through the dialog and comes out as a project with a run and an
// import record on its Overview; a broken
// file creates nothing; and the dialog passes axe at each step, in both themes.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

interface ExampleDoc {
	name: string;
	model: { nodes: { downstreamNodeId: string | null }[] };
	series: unknown[];
}

let example: ExampleDoc;

test.beforeAll(() => {
	// Droëvlei, the second example, built by the seeding code itself (without
	// Kleinberg's automatic fit, which only that example stores).
	const script =
		"import('./scripts/examples/catchments.ts').then((m) => process.stdout.write(JSON.stringify(m.buildExamples({ fit: false })[1])))";
	example = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', '--eval', script], { cwd: backendDir, encoding: 'utf8' })) as ExampleDoc;
});

const asFile = (doc: unknown, name = 'droevlei_project.json') => ({
	name,
	mimeType: 'application/json',
	buffer: Buffer.from(JSON.stringify(doc))
});

const row = (page: Page, name: string) =>
	page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });

async function openImport(page: Page) {
	await page.getByRole('button', { name: 'Import project file (.json)' }).click();
	const dialog = page.getByRole('dialog', { name: 'Import project file' });
	await expect(dialog.getByLabel('Project file (.json)')).toBeVisible();
	return dialog;
}

async function expectNoViolations(page: Page) {
	const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
	expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('imports an example catchment into a team and runs it', async ({ page, owner }) => {
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Import Hydrology' } });
	expect(res.status()).toBe(201);
	await page.goto('/');
	await expect(page.getByText('You have no projects yet.')).toBeVisible();

	const dialog = await openImport(page);
	await dialog.getByLabel('Project file (.json)').setInputFiles(asFile(example));

	// The preview: the file's name (editable), what's in it, the team and run choices.
	await expect(dialog.getByLabel('Name')).toHaveValue(example.name);
	await expect(dialog.getByText('From droevlei_project.json')).toBeVisible();
	const contents = dialog.getByRole('region', { name: 'In this file' });
	await expect(contents.getByRole('definition').nth(3)).toHaveText(String(example.series.length));
	await expect(contents.getByRole('table', { name: 'Time series in the file' }).getByRole('row')).toHaveCount(example.series.length + 1);
	await dialog.getByLabel('Name').fill('Droëvlei — imported');
	await dialog.getByLabel('Belongs to').selectOption({ label: 'Import Hydrology' });
	await dialog.getByLabel('Run the model after importing').check();
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();

	const done = page.getByRole('dialog', { name: 'Project imported' });
	await expect(done.getByRole('status')).toHaveText(/Imported Droëvlei — imported into Import Hydrology\.\s+Its first run is ready on the Runs tab\./);
	await expect(done.getByRole('alert')).toHaveCount(0);
	// The list behind the dialog already has it, in the team's group.
	await done.getByRole('button', { name: 'Close', exact: true }).click();
	const group = page.getByRole('region', { name: 'Import Hydrology' });
	await expect(row(page, 'Droëvlei — imported')).toBeVisible();
	await expect(group.getByRole('rowheader', { name: 'Droëvlei — imported' })).toBeVisible();

	// Open it: the workspace shows the imported catchment and its run.
	await row(page, 'Droëvlei — imported').getByRole('link', { name: 'Open' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Droëvlei — imported' })).toBeVisible();
	// The Overview's import record names the project file; a file has no unmapped report, and this one no notes.
	const record = page.getByRole('region', { name: 'Import record' });
	await expect(record.getByRole('paragraph').first()).toHaveText(
		new RegExp(`^Imported from the project file droevlei_project\\.json on \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} by ${owner.displayName}\\.$`)
	);
	await expect(record.getByRole('region', { name: 'Importer notes' }).getByRole('paragraph')).toHaveText('None.');
	await expect(record.getByRole('region', { name: /^Unmapped report/ })).toHaveCount(0);
	await page.goto(`${page.url().split('?')[0]}?tab=runs`);
	await expect(page.getByRole('region', { name: 'Run summary' })).toBeVisible();
});

test('an imported project exports back to the same file', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	const dialog = await openImport(page);
	await dialog.getByLabel('Project file (.json)').setInputFiles(asFile(example));
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Project imported' });
	await expect(done.getByRole('status')).toContainText(`Imported ${example.name}.`);
	await done.getByRole('link', { name: 'Open project' }).click();
	await expect(page.getByRole('heading', { level: 1, name: example.name })).toBeVisible();

	// The export of what was imported is the same catchment (fresh ids aside).
	const id = new URL(page.url()).pathname.split('/').pop()!;
	const exported = (await (await page.request.get(`${API_URL}/projects/${id}/export.json`)).json()) as ExampleDoc & { format: string };
	expect(exported.format).toBe('water-management/project');
	expect(exported.name).toBe(example.name);
	// (The export lists series by kind and name.)
	const byKey = (xs: unknown[]) =>
		[...(xs as { kind: string; name: string }[])].sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
	expect(byKey(exported.series)).toEqual(byKey(example.series));
	expect(exported.model.nodes).toHaveLength(example.model.nodes.length);
});

test('a broken file is refused and nothing is created', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	const dialog = await openImport(page);

	// Not JSON at all: refused in the browser, before anything is sent.
	await dialog.getByLabel('Project file (.json)').setInputFiles({ name: 'rain.json', mimeType: 'application/json', buffer: Buffer.from('date,value\n') });
	await expect(dialog.getByRole('alert')).toHaveText("This file isn't valid JSON, so it can't be a project file.");

	// Well-formed but invalid (two outflow nodes): the server lists the problem, and nothing is created.
	const broken = structuredClone(example);
	for (const n of broken.model.nodes) n.downstreamNodeId = null;
	await dialog.getByLabel('Project file (.json)').setInputFiles(asFile(broken, 'broken.json'));
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();
	const alert = dialog.getByRole('alert');
	await expect(alert).toContainText('The import failed.');
	await expect(alert).toContainText(`the network needs exactly one outflow node (drains into nothing); found ${broken.model.nodes.length}`);
	await expect(alert).toContainText('Nothing was created.');
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByText('You have no projects yet.')).toBeVisible();
	const list = (await (await page.request.get(`${API_URL}/projects`)).json()) as { projects: unknown[] };
	expect(list.projects).toEqual([]);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} theme`, () => {
		test.use({ colorScheme });

		test('the import dialog has no violations at each step', async ({ page, owner }) => {
			void owner;
			await page.goto('/');
			const dialog = await openImport(page);
			await expectNoViolations(page);

			await dialog.getByLabel('Project file (.json)').setInputFiles(asFile(example));
			await expect(dialog.getByLabel('Name')).toHaveValue(example.name);
			await expectNoViolations(page);

			await dialog.getByRole('button', { name: 'Import', exact: true }).click();
			await expect(page.getByRole('dialog', { name: 'Project imported' }).getByRole('link', { name: 'Open project' })).toBeVisible();
			await expectNoViolations(page);
		});
	});
}

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the dialog fills the width and the preview has no sideways scroll', async ({ page, owner }) => {
		void owner;
		await page.goto('/');
		const dialog = await openImport(page);
		await dialog.getByLabel('Project file (.json)').setInputFiles(asFile(example));
		await expect(dialog.getByLabel('Name')).toHaveValue(example.name);
		// Edge to edge but for the page gutter (16 px a side, plus the dialog's own border).
		const box = (await dialog.boundingBox())!;
		expect(box.x).toBeLessThanOrEqual(16 + 2);
		expect(box.x + box.width).toBeGreaterThanOrEqual(390 - 16 - 2);
		expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
		await expectNoViolations(page);
	});
});
