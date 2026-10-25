// The panels that followed the Settings form (issue #521 § 11; docs/ui.md § Data feeds, § API keys, § Scheduled
// reports), on their pages since issue #586 round 1 (Data feeds on Data, API keys and Scheduled reports on
// Project): each has its add action in its head, which opens an inline card with its own action row above
// the list, and the words that were a paragraph under the heading are the (i)'s. Data feeds' card holds
// the map's two proposals as Area options, and an editor opens them from the head's "Rain from the map".
// Find a setting still finds the registered-volumes comparison band, which moved to Allocations, and its
// link lands on that card. The high flows' paste is a dialog whose preview fills. Synthetic data only.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, sampleModel, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';
import { openSettings } from '../support/settings.ts';

/** Data, with Data feeds drawn. */
async function openFeeds(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=series${query}#data-feeds`);
	await expect(page.getByRole('region', { name: 'Data feeds' }).getByRole('heading', { name: 'Data feeds', level: 2 })).toBeVisible();
}

/** Project, with API keys (an owner's) and Scheduled reports drawn. */
async function openProjectPanels(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=project`);
	for (const name of ['API keys', 'Scheduled reports']) {
		await expect(page.getByRole('region', { name }).getByRole('heading', { name, level: 2 })).toBeVisible();
	}
}

/** The page's own scroll goes to `id`'s panel, as the menu's link does, and the head's action is in the window. */
async function landOn(page: Page, id: string, action: Locator) {
	await page.locator(`#${id}`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
	await expect(action).toBeInViewport();
}

/** Every box inside `scope` within the window's width (a long choice must not poke out of a phone's card). */
async function insideWidth(scope: Locator, width: number) {
	const poking = await scope.evaluate((el, w) => [...el.querySelectorAll('*')].filter((c) => c.getBoundingClientRect().right > w + 0.5).map((c) => c.outerHTML.slice(0, 80)), width);
	expect(poking).toEqual([]);
}

test('Data feeds has its add action in its head, opening a card above the list with its action on screen at 1440×900', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await createProject(page.request, 'After the form');
	const feed = await page.request.post(`${API_URL}/projects/${project.id}/feeds`, { data: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] } } });
	expect(feed.status(), await feed.text()).toBe(201);
	await openFeeds(page, project.id);

	// Data feeds: Refresh status and Attach a feed in the head; no paragraph under the heading.
	const feeds = page.getByRole('region', { name: 'Data feeds' });
	const attach = feeds.getByRole('button', { name: 'Attach a feed' });
	await landOn(page, 'data-feeds', attach);
	const heading = (await feeds.getByRole('heading', { name: 'Data feeds', level: 2 }).boundingBox())!;
	const attachBox = (await attach.boundingBox())!;
	expect(Math.abs(attachBox.y + attachBox.height / 2 - (heading.y + heading.height / 2))).toBeLessThanOrEqual(8);
	await expect(feeds.getByText(/^Rainfall and gauge flow that arrive by themselves/)).toHaveCount(0);
	await attach.click();
	const card = feeds.getByRole('form', { name: 'Attach a feed' });
	await expect(card.getByLabel('Source')).toBeFocused();
	// The card sits above the list (an add form above a long list), its own action in the window.
	expect((await card.boundingBox())!.y).toBeLessThan((await feeds.getByRole('list', { name: 'Data feeds' }).boundingBox())!.y);
	await expect(card.getByRole('button', { name: 'Attach feed' })).toBeInViewport();
	// The map's two proposals are choices of the Area (they were two unlabelled buttons under the list).
	await expect(card.getByLabel('Area').locator('option')).toHaveText(['Grid cells', 'Bounding box', 'The catchment boundary, from the map', 'Each unit’s parcel: a feed per unit']);
	await expect(feeds.getByRole('button', { name: /^(?:Use the catchment boundary|Rain for each unit)$/ })).toHaveCount(0);
	// Another source has no map proposals; a DWS gauge has no area at all.
	await card.getByLabel('Source').selectOption({ label: 'CHIRPS-GEFS rainfall forecast' });
	await expect(card.getByLabel('Area').locator('option')).toHaveText(['Grid cells', 'Bounding box']);
	await card.getByLabel('Source').selectOption({ label: 'CHIRPS daily rainfall' });
	// The boundary's proposal replaces the hand-typed area and Attach feed with its own Close (no boundary here: it says so).
	await card.getByLabel('Area').focus();
	await card.getByLabel('Area').selectOption('boundary');
	const proposal = card.getByRole('region', { name: 'Rain from the catchment boundary' });
	await expect(proposal.getByRole('alert')).toContainText('no catchment boundary');
	await expect(card.getByRole('button', { name: 'Attach feed' })).toHaveCount(0);
	await expect(card.getByLabel('Grid cells')).toHaveCount(0);
	await expect(card.getByLabel('Area')).toBeFocused();
	await expectNoViolations(page, { include: '#data-feeds' });
	await proposal.getByRole('button', { name: 'Close' }).click();
	await expect(card).toHaveCount(0);
	await expect(attach).toBeFocused();

	// The field help keeps being the field's description.
	await attach.click();
	await card.getByLabel('Area').selectOption('bbox');
	await expect(card.getByLabel('Bounding box')).toHaveAccessibleDescription(/in degrees\..*The rainfall is the area-weighted mean/);
});

test('API keys and Scheduled reports have their add actions in their heads, each card’s action on screen at 1440×900', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await createProject(page.request, 'After the form project');
	await openProjectPanels(page, project.id);

	// API keys: the make form is closed until Make a key, in the head; its action row in the window.
	const keys = page.getByRole('region', { name: 'API keys' });
	const make = keys.getByRole('button', { name: 'Make a key' });
	await landOn(page, 'project-api-keys', make);
	await expect(keys.getByRole('form', { name: 'Make an API key' })).toHaveCount(0);
	await make.click();
	await expect(keys.getByRole('button', { name: 'Make key' })).toBeInViewport();
	await expect(keys.getByRole('button', { name: 'Cancel' })).toBeInViewport();

	// Scheduled reports: Add a schedule in the head, its card above the empty list, its action in the window.
	const schedules = page.getByRole('region', { name: 'Scheduled reports' });
	const add = schedules.getByRole('button', { name: 'Add a schedule' });
	await landOn(page, 'project-report-schedules', add);
	await expect(schedules.getByRole('heading', { name: 'Scheduled reports', level: 2 }).getByRole('button', { name: 'About report PDFs and schedules' })).toBeVisible();
	await add.click();
	const form = schedules.getByRole('form', { name: 'Add a schedule' });
	await expect(form.getByLabel('Every', { exact: true })).toBeFocused();
	await expect(form.getByRole('button', { name: 'Add schedule' })).toBeInViewport();
	expect((await form.boundingBox())!.y).toBeLessThan((await schedules.getByText('No scheduled reports.').boundingBox())!.y);
	await form.getByRole('button', { name: 'Cancel' }).click();
	await expect(add).toBeFocused();
});

test('on a phone the three panels and their open cards fit the screen with nothing scrolling sideways', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'After the form phone');
	await page.setViewportSize({ width: 390, height: 844 });
	await openProjectPanels(page, project.id);
	await page.getByRole('region', { name: 'API keys' }).getByRole('button', { name: 'Make a key' }).click();
	await page.getByRole('region', { name: 'Scheduled reports' }).getByRole('button', { name: 'Add a schedule' }).click();
	for (const width of [390, 320]) {
		await resizeTo(page, { width, height: 844 });
		await expectNoSidewaysScroll(page);
	}
	await resizeTo(page, { width: 390, height: 844 });
	await openFeeds(page, project.id);
	const feeds = page.getByRole('region', { name: 'Data feeds' });
	await feeds.getByRole('button', { name: 'Attach a feed' }).click();
	for (const area of ['cells', 'boundary', 'units'] as const) {
		await feeds.getByLabel('Area').selectOption(area);
		for (const width of [390, 320]) {
			await resizeTo(page, { width, height: 844 });
			await expectNoSidewaysScroll(page);
			await insideWidth(feeds, width);
		}
		await resizeTo(page, { width: 390, height: 844 });
	}
	await expectNoViolations(page, { include: '#data-feeds' });
});

test('an editor opens the map’s proposals from Rain from the map; ?rain=boundary opens it on its heading, from an old Settings link too', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'After the form editor');
	const editor = await signIn('After the form editor');
	await addMember(page.request, project.id, editor.user.email, 'editor');
	await openFeeds(editor.page, project.id);
	const feeds = editor.page.getByRole('region', { name: 'Data feeds' });
	await expect(feeds.getByRole('button', { name: 'Attach a feed' })).toHaveCount(0);
	await feeds.getByRole('button', { name: 'Rain from the map' }).click();
	const card = feeds.getByRole('form', { name: 'Rain from the map' });
	// Only the map's two choices; no source, series or Attach feed.
	await expect(card.getByLabel('Area').locator('option')).toHaveText(['The catchment boundary, from the map', 'Each unit’s parcel: a feed per unit']);
	await expect(card.getByLabel('Area')).toBeFocused();
	await expect(card.getByLabel('Source')).toHaveCount(0);
	await expect(card.getByRole('button', { name: 'Attach feed' })).toHaveCount(0);
	await expect(card.getByRole('region', { name: 'Rain from the catchment boundary' })).toBeVisible();

	// The Map tab's link: the card opens on the boundary's proposal, its heading focused.
	await editor.page.goto(`/projects/${project.id}?tab=series&rain=boundary#data-feeds`);
	await expect(feeds.getByRole('heading', { name: 'Rain from the catchment boundary' })).toBeFocused();
	// The link as it was on Settings, with its # and without: forwarded to Data, rain= kept, the same landing (issue #586).
	for (const old of ['?tab=settings&rain=boundary#set-feeds', '?tab=settings&rain=boundary']) {
		await editor.page.goto('about:blank');
		await editor.page.goto(`/projects/${project.id}${old}`);
		await expect(editor.page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=series&rain=boundary#data-feeds$`));
		await expect(feeds.getByRole('heading', { name: 'Rain from the catchment boundary' })).toBeFocused();
	}
});

test('Find a setting still finds the comparison band, which moved to Allocations, and its link lands on the card', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Find the band');
	await openSettings(page, project.id);
	const menu = page.getByRole('navigation', { name: 'Settings sections' });
	const box = page.getByRole('searchbox', { name: 'Find a setting' });
	for (const q of ['comparison band', 'registered volumes', 'tolerance']) {
		await box.fill(q);
		await expect(menu.getByRole('link', { name: 'Comparison band, on Allocations' }), q).toBeVisible();
	}
	await expect(menu.getByRole('status')).toHaveText('1 match');
	await menu.getByRole('link', { name: 'Comparison band, on Allocations' }).click();
	await expect(page).toHaveURL(/[?&]tab=allocations(?:&[^#]*)?#alloc-band$/);
	const band = page.getByRole('heading', { name: 'Comparison band', level: 2 });
	await expect(band).toBeFocused();
	await expect(band).toBeInViewport();
});

test('the high flows’ paste is a dialog: its preview lists the rows, and Fill fills them, its action on screen at 1440×900', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await createProject(page.request, 'High flows paste');
	await putModel(page.request, project.id, sampleModel());
	const points = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
	await updateSettings(page.request, project.id, {
		ewrRules: [{ siteNodeId: null, source: 'Synthetic', component: 'total', unit: 'mcm', points, ewr: Array.from({ length: 12 }, () => points.map(() => 0)), naturalSource: 'run', natural: null, scale: 1 }]
	});
	await openSettings(page, project.id);
	const high = page.getByRole('group', { name: 'High flows: freshets and floods' });
	// The list's actions sit above it; no always-open box under it.
	await expect(high.getByRole('textbox')).toHaveCount(0);
	await high.getByRole('button', { name: /^Paste or load a CSV… high flows at / }).click();
	const dialog = page.getByRole('dialog', { name: /^Paste high flows at / });
	await dialog.getByLabel('Rows copied from a spreadsheet').fill('Name,Months,Peak,Days,Per year\nClass II freshet,Nov-Jan,0.5,3,2\nSmall flood,Feb,4,5,1');
	await expect(dialog.getByTestId('high-flow-paste-summary')).toHaveText('2 high-flow components.');
	await expect(dialog.getByRole('region', { name: 'Pasted high flows' }).getByRole('row')).toHaveCount(3);
	const fill = dialog.getByRole('button', { name: 'Fill 2 high flows' });
	await expect(fill).toBeInViewport();
	await expectNoViolations(page, { include: 'dialog[open]' });
	await fill.click();
	await expect(dialog).toBeHidden();
	await expect(high.getByLabel('High flow 2 name')).toHaveValue('Small flood');
	await expect(high.getByRole('status', { name: 'High-flow paste result' })).toHaveText('Filled 2 high-flow components.');
	await resizeTo(page, { width: 390, height: 844 });
	await high.getByRole('button', { name: /^Paste or load a CSV… high flows at / }).click();
	await dialog.getByLabel('Rows copied from a spreadsheet').fill('Class II freshet,Nov-Jan,0.5,3,2');
	await expect(dialog.getByRole('button', { name: 'Replace with 1 high flow' })).toBeInViewport();
	await expectNoSidewaysScroll(page);
});

test('Data feeds, API keys and Scheduled reports show an empty list the same way, LoadState’s dashed box (issue #586, C17)', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await createProject(page.request, 'Empty after the form');
	const looks: string[] = [];
	for (const [region, words] of [
		['Data feeds', 'No feeds yet.'],
		['API keys', 'No API keys yet.'],
		['Scheduled reports', 'No scheduled reports.']
	] as const) {
		if (region === 'Data feeds') await openFeeds(page, project.id);
		else if (region === 'API keys') await openProjectPanels(page, project.id);
		const empty = page.getByRole('region', { name: region }).locator('.state.empty');
		await expect(empty, region).toHaveText(words);
		looks.push(await empty.evaluate((el) => { const c = getComputedStyle(el); return `${c.borderStyle} ${c.borderRadius} ${c.textAlign}`; }));
	}
	expect(looks[0]).toMatch(/^dashed /);
	expect(new Set(looks).size).toBe(1);
});
