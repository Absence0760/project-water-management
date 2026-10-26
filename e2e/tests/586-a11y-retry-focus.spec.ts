// A hand-built Try again keeps the focus through a retry, the way the shared
// LoadState does (issue #586 R4-I, WCAG 2.4.3): Try again takes itself out of
// the page (a loading line replaces the error), and the focus fell to <body>,
// so the next Tab started again from the top of the page. Now
// common/loadState.ts followRetry puts it on the loading line while the retry
// loads, on the new Try again when it fails again, and on the panel's heading
// once it has loaded. One panel on each page: Project (Registration checks),
// Runs & results (the runs list) and Data (Preview all data). Each answer is
// held back until the test lets it go, so the loading line is seen focused.
import type { Locator, Page } from '@playwright/test';
import { createProject, putSeries, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

/** Fails the GETs `url` matches while `down`, holding each answer until `let go` is called. */
async function flaky(page: Page, url: RegExp) {
	const state = { down: true, held: null as Promise<void> | null, release: () => {} };
	await page.route(url, async (r) => {
		if (r.request().method() !== 'GET') return r.fallback();
		if (state.held) await state.held;
		return state.down ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server unavailable"}' }) : r.fallback();
	});
	return {
		hold: () => (state.held = new Promise((resolve) => (state.release = resolve))),
		letGo: () => {
			state.held = null;
			state.release();
		},
		up: () => (state.down = false)
	};
}

/** Presses Try again from the keyboard while the answer is held: the loading line has the focus; then it fails again and the new Try again has it. */
async function failsAgain(page: Page, net: Awaited<ReturnType<typeof flaky>>, scope: Locator, loading: Locator) {
	const retry = scope.getByRole('button', { name: 'Try again' });
	net.hold();
	await retry.focus();
	await page.keyboard.press('Enter');
	await expect(loading).toBeFocused();
	net.letGo();
	await expect(retry).toBeFocused();
}

test('Project: Registration checks’ Try again keeps the focus, then lands on its heading', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Retry focus checks');
	const net = await flaky(page, new RegExp(`/projects/${project.id}/registration-checks$`));
	await page.goto(`/projects/${project.id}?tab=project`);
	const panel = page.getByTestId('registration-checks');
	await expect(panel.getByRole('alert')).toContainText('Server unavailable');

	await failsAgain(page, net, panel, panel.getByRole('status').filter({ hasText: 'Loading…' }));

	net.up();
	await page.keyboard.press('Enter');
	await expect(panel.getByText('No check recorded yet.')).toBeVisible();
	await expect(panel.getByRole('heading', { level: 2, name: /^Registration checks/ })).toBeFocused();
});

test('Runs & results: the runs list’s Try again keeps the focus, then lands on the Runs heading', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Retry focus runs');
	const net = await flaky(page, new RegExp(`/projects/${project.id}/runs$`));
	await page.goto(`/projects/${project.id}?tab=runs`);
	const list = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Runs', exact: true }) });
	await expect(list.getByRole('alert')).toContainText('Couldn’t load the runs: Server unavailable');

	await failsAgain(page, net, list, list.getByRole('status').filter({ hasText: 'Loading runs…' }));

	net.up();
	await page.keyboard.press('Enter');
	await expect(list.getByRole('alert')).toHaveCount(0);
	await expect(list.getByRole('heading', { level: 2, name: 'Runs', exact: true })).toBeFocused();
});

test('Data: Preview all data’s Try again keeps the focus, then the search has it once the values load', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Retry focus preview');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: [1, 2, 3] });
	const net = await flaky(page, /\/series\/[^/?]+$/);
	await page.goto(`/projects/${project.id}?tab=series`);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await expect(dialog.getByRole('alert')).toContainText("Couldn't load the values of Rainfall — catchment (");

	await failsAgain(page, net, dialog, dialog.getByRole('status').filter({ hasText: /^\s*Loading…\s*$/ }));

	net.up();
	await page.keyboard.press('Enter');
	await expect(dialog).toContainText('3 of 3 days shown');
	await expect(dialog.getByRole('searchbox', { name: 'Search by date or value' })).toBeFocused();
});
