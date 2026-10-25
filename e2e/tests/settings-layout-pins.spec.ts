// Layout pins for Settings & calibration (?tab=settings), issue #586 round 0: the page is about to be split into
// Model settings and a new Calibration page. These pins hold today's page, so a later round that moves a panel has
// to move its pin with it and can't lose one silently: the panels and their #set-* anchors in page order, the side
// index in the same order and pointing at them, every anchor landing on its heading with the focus there,
// ?tab=calibration opening the page, and the one save bar saving edits from both halves together. Round 1 moved
// Data feeds to Data and API keys and Scheduled reports to Project: their old anchors forward there. The detailed checks live elsewhere and aren't
// repeated: the index's keys and find box (settings-index.spec.ts), the bar's rows at 1280 and More at 1024
// (section-nav.spec.ts), the header's fit line and jump (settings-page.spec.ts), Discard's Cancel and a Save
// blocker's link (settings.spec.ts), leaving with unsaved settings (leave-guard.spec.ts). Synthetic data only.
import type { Page } from '@playwright/test';
import { addMember, createProject, putModel, sampleModel, updateSettings } from '../support/api.ts';
import { answerConfirm, confirmBox } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { anySaveBar, isProjectPatch, openSettings, saveSettings, settingsBar, settingsMenu } from '../support/settings.ts';

/**
 * Every panel on the page, top to bottom, by its anchor and its heading (word for word, without its ⓘ tip): Judge
 * results by heads the page, the form's panels follow, Automatic runs last. settings/sections.ts lists the form's;
 * SettingsTab.svelte sets the ids.
 */
const PANELS: [id: string, heading: string][] = [
	['set-judge', 'Judge results by'],
	['set-period', 'Simulation period'],
	['set-rain', 'Rain gaps'],
	['set-quality', 'Data quality'],
	['set-demand', 'Demand'],
	['set-restrict', 'Drought restrictions'],
	['set-reporting', 'Reporting'],
	['set-share', 'Flow generation'],
	['set-flow', 'Flow calibration'],
	['set-record', 'Calibration record'],
	['set-fit', 'Fit the parameters'],
	['set-wr2012', 'WR2012 check'],
	['set-ewr', 'EWR'],
	['set-reserve', 'Reserve rule tables'],
	['set-outcomes', 'Outcome matrix'],
	['set-outlook', 'Seasonal outlook'],
	['set-evidence', 'Evidence'],
	['set-auto', 'Automatic runs']
];

/**
 * The panels that moved away in round 1 (issue #586): each old anchor, where it forwards to (any other parameter
 * kept), and the heading it lands on there. Data and Project set the new ids.
 */
const MOVED: [old: string, tab: string, id: string, heading: string][] = [
	['set-feeds', 'series', 'data-feeds', 'Data feeds'],
	['set-api-keys', 'project', 'project-api-keys', 'API keys'],
	['set-report-schedules', 'project', 'project-report-schedules', 'Scheduled reports']
];

/** The anchors inside a panel: Evaporation from the map, a card of Flow calibration that saves on its own. */
const INNER: [id: string, heading: string, panel: string][] = [['set-evaporation', 'Evaporation from the map', 'set-flow']];

/** The side index at 1440 px: its groups by task, in page order, each link to its panel's anchor. */
const INDEX: [group: string, links: [label: string, id: string][]][] = [
	[
		'Data & rain',
		[
			['Simulation period', 'set-period'],
			['Rain gaps', 'set-rain'],
			['Data quality', 'set-quality']
		]
	],
	[
		'Demand & supply',
		[
			['Demand', 'set-demand'],
			['Drought restrictions', 'set-restrict'],
			['Reporting', 'set-reporting']
		]
	],
	[
		'Runoff & calibration',
		[
			['Flow generation', 'set-share'],
			['Flow calibration', 'set-flow'],
			['Calibration record', 'set-record'],
			['Fit the parameters', 'set-fit'],
			['WR2012 check', 'set-wr2012']
		]
	],
	[
		'EWR & Reserve',
		[
			['EWR', 'set-ewr'],
			['Reserve rule tables', 'set-reserve']
		]
	],
	[
		'Reading results',
		[
			['Outcome matrix', 'set-outcomes'],
			['Seasonal outlook', 'set-outlook'],
			['Evidence', 'set-evidence']
		]
	],
	// Its one panel, named as its heading (C9): the three that shared the group moved away.
	['Automatic runs', [['Automatic runs', 'set-auto']]]
];

/** A panel's own heading: the first h2 (h3 for a card) under its anchor, read as shown (its ⓘ tip adds no text). */
const panelHeading = (page: Page, id: string) => page.locator(`#${id}`).locator('h2, h3').first();
const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const pageTitle = (page: Page) => page.getByRole('heading', { level: 1, name: 'Settings & calibration', exact: true });

/** A panel's heading, whether the anchor is on the heading itself or on the panel around it. */
const anchoredHeading = (page: Page, id: string) => page.locator(`:is(h2, h3)#${id}, #${id} :is(h2, h3)`).first();

/** Opens Settings and waits for the lazy panel (Evaporation from the map) to draw. */
async function openAllPanels(page: Page, projectId: string) {
	await openSettings(page, projectId);
	for (const [id, heading] of INNER) {
		await expect(panelHeading(page, id)).toHaveText(heading, { useInnerText: true });
	}
}

test('the panels, their anchors and the side index, in page order', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings pins order');
	await openAllPanels(page, project.id);

	// Every #set-* anchor on the page, in order: the panels, with Evaporation from the map inside Flow calibration.
	const ids = PANELS.map(([id]) => id);
	ids.splice(ids.indexOf('set-flow') + 1, 0, 'set-evaporation');
	expect(await page.locator('[id^="set-"]').evaluateAll((els) => els.map((e) => e.id))).toEqual(ids);

	// Each panel's heading, word for word, each one below the last.
	let above = -Infinity;
	for (const [id, heading] of PANELS) {
		const h = panelHeading(page, id);
		await expect(h, id).toHaveText(heading, { useInnerText: true });
		const y = (await h.boundingBox())!.y;
		expect(y, `${heading} sits below the panel before it`).toBeGreaterThan(above);
		above = y;
	}
	for (const [id, heading, panel] of INNER) {
		await expect(page.locator(`#${panel} #${id}`).locator('h2, h3').first()).toHaveText(heading, { useInnerText: true });
	}
	// Nothing follows the form now: no panels that save on their own, and no line saying they do.
	await expect(page.getByText(/save as you change them/)).toHaveCount(0);
	for (const [old] of MOVED) await expect(page.locator(`#${old}`)).toHaveCount(0);

	// The side index: its groups in order, each a named list of its panels' headings, each linking to its anchor,
	// and nothing else in it. Judge results by heads the page above the index's first panel and has no link.
	const menu = settingsMenu(page);
	await expect(menu.getByRole('list')).toHaveCount(INDEX.length);
	for (const [group, links] of INDEX) {
		const list = menu.getByRole('list', { name: group, exact: true });
		await expect(list.getByRole('link')).toHaveText(links.map(([label]) => label));
		for (const [i, [, id]] of links.entries()) await expect(list.getByRole('link').nth(i)).toHaveAttribute('href', `#${id}`);
	}
	await expect(menu.getByRole('link')).toHaveCount(INDEX.flatMap(([, l]) => l).length);
	// The index is in page order: its anchors are the panels' minus the head.
	expect(INDEX.flatMap(([, l]) => l.map(([, id]) => id))).toEqual(PANELS.map(([id]) => id).filter((id) => id !== 'set-judge'));
	// Each link's label is its panel's heading.
	for (const [label, id] of INDEX.flatMap(([, l]) => l)) expect(PANELS.find(([p]) => p === id)?.[1], id).toBe(label);
});

test('in Per unit flow generation, the units’ rain and MAP from the grid are cards of Flow generation', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings pins per unit');
	await putModel(page.request, project.id, sampleModel());
	await updateSettings(page.request, project.id, { unitRain: { mode: 'perUnit' } });
	await openSettings(page, project.id);
	await expect(page.locator('#set-share #set-unit-rain')).toBeVisible();
	await expect(page.locator('#set-share #set-unit-map')).toBeVisible();
	await expect(page.locator('#set-unit-rain > legend')).toHaveText('Units without a station', { useInnerText: true });
	await expect(page.locator('#set-unit-map').locator('h2, h3, h4').first()).toHaveText('MAP from the grid', { useInnerText: true });
});

for (const [id, heading] of [...PANELS, ...INNER.map(([i, h]): [string, string] => [i, h])]) {
	test(`a load of #${id} lands on ${heading}: in view below the bar, and focused`, async ({ page, owner }) => {
		void owner;
		// The lazy panel too (Evaporation from the map): the page waits for the panel, then for its heading (issue #586).
		// 1280 px: the index is the bar that sticks over the content, so the heading must clear it too.
		await page.setViewportSize({ width: 1280, height: 800 });
		const project = await createProject(page.request, `Settings pins ${id}`);
		await page.goto(`/projects/${project.id}?tab=settings#${id}`);
		await expect(pageTitle(page)).toBeVisible();
		const h = panelHeading(page, id);
		await expect(h).toHaveText(heading, { useInnerText: true });
		await expect(h).toBeInViewport();
		await expect(h).toBeFocused();
		const bar = (await settingsMenu(page).boundingBox())!;
		expect((await h.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
	});
}

for (const [old, tab, id, heading] of MOVED) {
	test(`an old link to #${old} forwards to ?tab=${tab}#${id}, keeping its other parameters, and lands on ${heading} there`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 1280, height: 800 });
		const project = await createProject(page.request, `Settings pins moved ${old}`);
		// From the Summary, as an old email's or bookmark's link is opened: a page load, with the parameters it carried
		// (any other parameter; settings-after-form-layout.spec.ts follows ?rain=boundary, which opens a card of its own).
		await page.goto(`/projects/${project.id}`);
		await expect(page.getByRole('heading', { level: 1, name: 'Summary', exact: true })).toBeVisible();
		await page.goto(`/projects/${project.id}?tab=settings&ref=bookmark#${old}`);
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=${tab}&ref=bookmark#${id}$`));
		const h = anchoredHeading(page, id);
		await expect(h).toHaveText(heading, { useInnerText: true });
		await expect(h).toBeInViewport();
		await expect(h).toBeFocused();
		// The forward replaced the old entry: Back returns to the Summary, not to Settings and on again.
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
		await expect(page.getByRole('heading', { level: 1, name: 'Summary', exact: true })).toBeVisible();
	});
}

test('an old #set- link to a moved panel followed while Settings is open forwards too', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await createProject(page.request, 'Settings pins moved in page');
	// A note's or a pasted link's fragment, with the page already open: only the #fragment changes.
	for (const [old, tab, id, heading] of MOVED) {
		await openSettings(page, project.id);
		await page.evaluate((hash) => (location.hash = hash), `#${old}`);
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=${tab}#${id}$`));
		const h = anchoredHeading(page, id);
		await expect(h).toHaveText(heading, { useInnerText: true });
		await expect(h).toBeFocused();
	}
});

test('a load of #set-unit-rain lands on its card’s heading, an h4 in its legend', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await createProject(page.request, 'Settings pins unit rain link');
	await putModel(page.request, project.id, sampleModel());
	await updateSettings(page.request, project.id, { unitRain: { mode: 'perUnit' } });
	await page.goto(`/projects/${project.id}?tab=settings#set-unit-rain`);
	const h = page.locator('#set-unit-rain > legend h4');
	await expect(h).toHaveText('Units without a station', { useInnerText: true });
	await expect(h).toBeInViewport();
	await expect(h).toBeFocused();
});

test('a viewer sees which radio option is chosen: the read-only form keeps a radio’s mark (issue #586)', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Settings pins viewer radio');
	const viewer = await signIn('Settings radio viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await openSettings(v, project.id);
	const method = v.getByTestId('flowgen-method');
	const chosen = method.getByRole('radio', { name: 'Fragmentation', exact: true });
	await expect(chosen).toBeChecked();
	await expect(chosen).toBeDisabled();
	// Drawn as a radio (the read-only rule for text fields once took its circle away: appearance none, no border).
	for (const radio of await method.getByRole('radio').all()) {
		await expect(radio).toBeVisible();
		expect(await radio.evaluate((el) => getComputedStyle(el).appearance)).not.toBe('none');
		const box = (await radio.boundingBox())!;
		expect(box.width).toBeGreaterThan(0);
		expect(box.height).toBeGreaterThan(0);
	}
});

test('a click on the sidebar link of the page already shown sets no title focus for a later link (issue #586)', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings pins active tab');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await openSettings(page, project.id);
	const sidebar = page.getByRole('navigation', { name: 'Project sections' });
	// Settings is the page shown: the link goes nowhere.
	await sidebar.getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(page).toHaveURL(/\?tab=settings$/);
	// A link in the page to Data is not a sidebar link: Data's title doesn't take the focus.
	const link = page.getByTestId('rules-run-why').getByRole('link', { name: 'Add one on Data' });
	await link.click();
	await expect(page).toHaveURL(/\?tab=series$/);
	const data = page.getByRole('heading', { level: 1, name: 'Data', exact: true });
	await expect(data).toBeVisible();
	await expect(data).not.toBeFocused();
	// A sidebar link still focuses the title it goes to.
	await sidebar.getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(pageTitle(page)).toBeFocused();
});

test('?tab=calibration opens Settings & calibration under its own sidebar row at Flow calibration, and lands its anchors', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings pins alias');
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(pageTitle(page)).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration$`));
	// It opens at Flow calibration, its heading focused, not at the top of Settings (issue #586).
	const flow = panelHeading(page, 'set-flow');
	await expect(flow).toHaveText('Flow calibration', { useInnerText: true });
	await expect(flow).toBeInViewport();
	await expect(flow).toBeFocused();
	// The sidebar marks Settings & calibration: there is no Calibration row (yet).
	await expect(sections(page).getByRole('link', { name: 'Settings & calibration', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(sections(page).getByRole('link', { name: /^Calibration/ })).toHaveCount(0);
	await expect(settingsMenu(page).getByRole('link')).toHaveCount(INDEX.flatMap(([, l]) => l).length);

	// The calibration panels' anchors land from the alias as from ?tab=settings.
	for (const [id, heading] of [
		['set-fit', 'Fit the parameters'],
		['set-flow', 'Flow calibration'],
		['set-record', 'Calibration record'],
		['set-wr2012', 'WR2012 check']
	] as const) {
		await page.goto('about:blank');
		await page.goto(`/projects/${project.id}?tab=calibration#${id}`);
		const h = panelHeading(page, id);
		await expect(h).toHaveText(heading, { useInnerText: true });
		await expect(h).toBeInViewport();
		await expect(h).toBeFocused();
	}
});

test('the save bar: edits in a model-input panel and a calibration panel show it, go along to another page, and save together; Discard asks and restores both', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings pins save bar');
	await openSettings(page, project.id);
	await expect(anySaveBar(page)).toHaveCount(0);
	const apan = page.locator('#set-demand').getByLabel('A-pan evaporation, Oct, mm');
	const x1 = page.locator('#set-flow').getByLabel(/^Production store capacity X1/);
	const x1Saved = await x1.inputValue();

	// An edit in Demand (stays on Model settings) raises the bar.
	await apan.fill('152');
	await apan.blur();
	await expect(settingsBar(page)).toContainText('Unsaved changes to the settings');
	// An edit in Flow calibration (goes to Calibration) joins it: one bar, still the settings.
	await x1.fill('432');
	await x1.blur();
	await expect(anySaveBar(page)).toHaveCount(1);
	await expect(settingsBar(page)).toContainText('Unsaved changes to the settings');

	// Another section keeps both without asking; the bar goes along, and they are there on the way back.
	await sections(page).getByRole('link', { name: 'Runs & results', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Runs & results' })).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	await expect(settingsBar(page)).toBeVisible();
	await sections(page).getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(apan).toHaveValue('152');
	await expect(x1).toHaveValue('432');

	// Discard asks, then restores both, says so and puts the focus on the page's title.
	await settingsBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
	await answerConfirm(page, true, 'Your unsaved changes to the settings will be lost.');
	await expect(apan).toHaveValue('0');
	await expect(x1).toHaveValue(x1Saved);
	await expect(anySaveBar(page)).toHaveCount(0);
	await expect(page.getByTestId('savebar-announcement')).toHaveText('Changes discarded.');
	await expect(pageTitle(page)).toBeFocused();

	// Again, and Save: one PATCH carries both, the bar goes, and a reload reads them back.
	await apan.fill('152');
	await x1.fill('432');
	await x1.blur();
	const patches: string[] = [];
	page.on('request', (r) => {
		if (isProjectPatch(r.method(), r.url())) patches.push(r.postData() ?? '');
	});
	await saveSettings(page);
	expect(patches).toHaveLength(1);
	await expect(pageTitle(page)).toBeFocused();
	const saved = ((await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { project: { settings: { apanMm: number[] } } }).project.settings;
	expect(saved.apanMm[0]).toBe(152);
	await page.reload();
	await expect(apan).toHaveValue('152');
	await expect(x1).toHaveValue('432');
	await expect(anySaveBar(page)).toHaveCount(0);
});
