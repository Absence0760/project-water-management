// A workspace chunk that fails to download (a network blip, or a deploy that
// removed it) says so and offers "Reload page", never "Try again": the
// browser keeps a module that failed to fetch for the life of the page, so
// only a reload recovers (common/lazy.ts, ChunkFailed.svelte). With unsaved
// model edits the message warns first, and the reload meets the page's
// beforeunload guard, so the edits are only dropped once the user agrees.
// The printable report, the alert email settings, the workbook reader, the
// run's workbook download, the account's data download and the verify-email
// banner (their own import() calls, not Lazy) say the same.
import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { createProject, createRun, register, seedRunnableProject, signInUnconfirmed } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal } from '../support/network.ts';

// Every code chunk the page asks for once this is routed is the one under test.
const BLOCKED = '**/_app/immutable/**/*.js';
const FAILED = 'This part of the page could not be loaded. Check your connection, then reload the page.';
const UNSAVED = 'You have unsaved changes: save them first, or the browser will ask before the reload discards them.';

const WORKBOOK = new URL('../../scripts/wbt-import/fixtures/synthetic_b023.xlsx', import.meta.url);
const XLSM = 'application/vnd.ms-excel.sheet.macroEnabled.12';

/** A route handler that aborts only the chunk whose code holds `marker` (chunk file names are only hashes). */
const blockChunkWith = (marker: string) => async (route: Route) => {
	const res = await route.fetch();
	const body = await res.text();
	if (body.includes(marker)) return route.abort();
	return route.fulfill({ response: res, body });
};

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name });
const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
// The History tab's own content (its heading is the page's section header, drawn before the chunk loads).
const historyFilters = (page: Page) => page.getByRole('group', { name: 'Filter the history' });

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
	await expect(historyFilters(page)).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
	expect(prompted).toBe(false);
});

test('with unsaved model edits the failure warns, and the reload asks before discarding them', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Chunk failure, unsaved');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.getByRole('button', { name: 'Add crop', exact: true }).click();
	// The new crop's sheet opens; Done leaves the edit for the save bar.
	await closeModal(page);
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
	await expect(historyFilters(page)).toBeVisible();
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
	const blockTables = blockChunkWith('Groundwater by water year');
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

// The run's workbook download loads its writer on click. A failed download
// used to show the browser's own "Failed to fetch dynamically imported
// module" text, and pressing again failed the same way.
test('a workbook download whose writer fails to download says so below the menu, and a reload recovers', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Chunk failure, workbook');
	const runId = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();
	const trigger = page.getByRole('button', { name: 'Download', exact: true });
	const menu = page.locator('.download', { has: trigger });
	const openMenu = async () => {
		await trigger.scrollIntoViewIfNeeded();
		await expect(trigger).toBeInViewport();
		await trigger.click();
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	};

	await openMenu();
	await page.route(BLOCKED, (r) => r.abort());
	await page.getByRole('button', { name: /^Workbook \(\.xlsx\)/ }).click();
	const alert = menu.getByRole('alert');
	await expect(alert).toHaveText('The workbook download could not be loaded. Check your connection, then reload the page. Reload page');
	await expect(menu.getByRole('status')).toHaveText('');

	await page.unroute(BLOCKED);
	await alert.getByRole('button', { name: 'Reload page' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();
	await openMenu();
	const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Workbook \(\.xlsx\)/ }).click()]);
	expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
	await expect(menu.getByRole('alert')).toHaveCount(0);
});

// The account page is translated, so its wording is its own (t()).
test('the account’s data download failing to load says so, and a reload recovers', async ({ page, owner }) => {
	void owner;
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Your data' });
	await expect(panel.getByRole('button', { name: 'Download my data' })).toBeEnabled();

	await page.route(BLOCKED, (r) => r.abort());
	await panel.getByRole('button', { name: 'Download my data' }).click();
	const alert = panel.getByRole('alert');
	await expect(alert).toHaveText('The download could not be loaded. Check your connection, then reload the page. Reload page');
	await expect(panel.getByRole('button', { name: 'Download my data' })).toBeEnabled();

	await page.unroute(BLOCKED);
	await alert.getByRole('button', { name: 'Reload page' }).click();
	const [file] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download my data' }).click()]);
	expect(file.suggestedFilename()).toMatch(/^my-data_.*\.json$/);
	await expect(panel.getByRole('alert')).toHaveCount(0);
});

// The verify-email banner is its own chunk. It used to vanish when that
// failed, hiding that an unconfirmed address holds back pending invitations.
test('a verify-email banner that fails to download says so in its place, and a reload recovers', async ({ page }) => {
	const user = await register(page.context().request, 'Unconfirmed chunk', { verified: false });
	await signInUnconfirmed(page.context(), user);
	const blockBanner = blockChunkWith('Please confirm your email address');
	await page.route(BLOCKED, blockBanner);
	await page.goto('/');
	const alert = page.getByRole('alert');
	await expect(alert).toHaveText(
		'The reminder to confirm your email address could not be loaded. Check your connection, then reload the page. Reload page'
	);
	await expect(page.getByRole('region', { name: 'Email confirmation' })).toHaveCount(0);

	await page.unroute(BLOCKED, blockBanner);
	await alert.getByRole('button', { name: 'Reload page' }).click();
	await expect(page.getByRole('region', { name: 'Email confirmation' })).toContainText(`We sent a link to ${user.email}`);
	await expect(page.getByRole('alert')).toHaveCount(0);
});
