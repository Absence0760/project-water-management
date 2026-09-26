// A workspace chunk that fails to download (a network blip, or a deploy that
// removed it) says so and offers "Reload page", never "Try again": the
// browser keeps a module that failed to fetch for the life of the page, so
// only a reload recovers (common/lazy.ts, ChunkFailed.svelte). With unsaved
// model edits the message warns first, and the reload meets the page's
// beforeunload guard, so the edits are only dropped once the user agrees.
// The printable report, the alert email settings and the workbook reader
// (their own import() calls, not Lazy) say the same.
import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// Every code chunk the page asks for once this is routed is the one under test.
const BLOCKED = '**/_app/immutable/**/*.js';
const FAILED = 'This part of the page could not be loaded. Check your connection, then reload the page.';
const UNSAVED = 'You have unsaved changes: save them first, or the browser will ask before the reload discards them.';

const WORKBOOK = new URL('../../scripts/wbt-import/fixtures/synthetic_b023.xlsx', import.meta.url);
const XLSM = 'application/vnd.ms-excel.sheet.macroEnabled.12';

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name });
const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const historyHeading = (page: Page) => page.getByRole('heading', { name: 'History', level: 2 });

test('a tab that fails to download offers a reload, and the reload recovers', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Chunk failure');
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('region', { name: 'Active alerts' })).toHaveAttribute('data-ready', 'true');

	await page.route(BLOCKED, (r) => r.abort());
	await tab(page, 'History').click();
	await expect(page).toHaveURL(/tab=history/);
	const alert = page.getByRole('alert');
	await expect(alert).toHaveText(`${FAILED} Reload page`);
	await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(0);

	await page.unroute(BLOCKED);
	// Nothing is unsaved, so no prompt: the reload goes straight through.
	let prompted = false;
	page.on('dialog', (d) => {
		prompted = true;
		void d.dismiss();
	});
	await alert.getByRole('button', { name: 'Reload page' }).click();
	await expect(historyHeading(page)).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
	expect(prompted).toBe(false);
});

test('with unsaved model edits the failure warns, and the reload asks before discarding them', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Chunk failure, unsaved');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.getByRole('button', { name: 'Add crop' }).click();
	await expect(saveBar(page)).toContainText('Unsaved changes to the model');

	await page.route(BLOCKED, (r) => r.abort());
	await tab(page, 'History').click();
	const alert = page.getByRole('alert');
	await expect(alert).toHaveText(`${FAILED} ${UNSAVED} Reload page`);

	// Stay: the browser's "leave site?" prompt keeps the page and the edit.
	// (The click only completes once the prompt is answered, so answer it from
	// the dialog handler.)
	const prompts: string[] = [];
	page.once('dialog', (d) => {
		prompts.push(d.type());
		void d.dismiss();
	});
	await alert.getByRole('button', { name: 'Reload page' }).click();
	expect(prompts).toEqual(['beforeunload']);
	await expect(saveBar(page)).toContainText('Unsaved changes to the model');
	await expect(alert).toHaveText(`${FAILED} ${UNSAVED} Reload page`);

	// Reload after all: the edit goes (the user agreed) and the tab loads.
	await page.unroute(BLOCKED);
	page.once('dialog', (d) => {
		prompts.push(d.type());
		void d.accept();
	});
	await alert.getByRole('button', { name: 'Reload page' }).click();
	expect(prompts).toEqual(['beforeunload', 'beforeunload']);
	await expect(historyHeading(page)).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(saveBar(page)).toHaveCount(0);
});

// The printable report waits for the human-impact tables' chunk before it is
// ready. Blocked by its content (its file name is only a hash): if it fails,
// the report says so and offers a reload rather than a "Try again" that
// would fail the same way.
test('a report whose tables fail to download offers a reload, and the reload recovers', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Chunk failure, report');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const blockTables = async (route: Route) => {
		const res = await route.fetch();
		const body = await res.text();
		if (body.includes('Groundwater by water year')) return route.abort();
		return route.fulfill({ response: res, body });
	};
	await page.route(BLOCKED, blockTables);
	await page.goto(`/projects/${project.id}/report?run=${runId}`);
	const alert = page.getByRole('alert');
	await expect(alert).toHaveText('The report could not be loaded. Check your connection, then reload the page. Reload page');
	await expect(page.locator('main[data-report-ready="true"]')).toHaveCount(0);

	await page.unroute(BLOCKED, blockTables);
	await alert.getByRole('button', { name: 'Reload page' }).click();
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the alert email settings failing to download say so and offer a reload', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Chunk failure, alerts');
	await page.goto(`/projects/${project.id}`);
	const panel = page.getByRole('region', { name: 'Active alerts' });
	await expect(panel).toHaveAttribute('data-ready', 'true');

	await page.route(BLOCKED, (r) => r.abort());
	await panel.getByRole('button', { name: 'Set up alert emails' }).click();
	const alert = panel.getByRole('alert');
	await expect(alert).toHaveText(
		'The alert email settings could not be loaded. Check your connection, then reload the page. Reload page'
	);

	await page.unroute(BLOCKED);
	await alert.getByRole('button', { name: 'Reload page' }).click();
	await expect(panel).toHaveAttribute('data-ready', 'true');
	await panel.getByRole('button', { name: 'Set up alert emails' }).click();
	await expect(panel.getByRole('form', { name: 'Alert emails for this catchment' })).toBeVisible();
	await expect(panel.getByRole('alert')).toHaveCount(0);
});

// The workbook reader is a chunk of its own, fetched when a workbook is
// picked. Its failing used to leave the dialog stuck on "Reading…" with the
// file input disabled.
test('a workbook reader that fails to download says so and frees the file input', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await page.getByRole('button', { name: 'Import b023 workbook' }).click();
	const dialog = page.getByRole('dialog', { name: 'Import b023 workbook' });
	const input = dialog.getByLabel('b023 workbook (.xlsm or .xlsx)');
	await expect(input).toBeVisible();

	await page.route(BLOCKED, (r) => r.abort());
	await input.setInputFiles({ name: 'synthetic_b023.xlsx', mimeType: XLSM, buffer: readFileSync(WORKBOOK) });
	await expect(dialog.getByRole('alert')).toHaveText('The workbook reader could not be loaded. Check your connection, then reload the page. Reload page');
	await expect(input).toBeEnabled();
	await expect(dialog.getByRole('progressbar')).toHaveCount(0);

	await page.unroute(BLOCKED);
	await dialog.getByRole('button', { name: 'Reload page' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Import b023 workbook' })).toBeVisible();
});
