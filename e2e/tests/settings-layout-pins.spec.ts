// Layout pins for Settings & calibration (?tab=settings), issue #586 round 0: the page is about to be split into
// Model settings and a new Calibration page, with Data feeds, API keys and Scheduled reports moving to Data and
// Project. These pins hold today's page, so a later round that moves a panel has to move its pin with it and can't
// lose one silently: the panels and their #set-* anchors in page order, the side index in the same order and
// pointing at them, every anchor landing on its heading with the focus there, ?tab=calibration opening the page,
// and the one save bar saving edits from both halves together. The detailed checks live elsewhere and aren't
// repeated: the index's keys and find box (settings-index.spec.ts), the bar's rows at 1280 and More at 1024
// (section-nav.spec.ts), the header's fit line and jump (settings-page.spec.ts), Discard's Cancel and a Save
// blocker's link (settings.spec.ts), leaving with unsaved settings (leave-guard.spec.ts). Synthetic data only.
import type { Page } from '@playwright/test';
import { createProject, putModel, sampleModel, updateSettings } from '../support/api.ts';
import { answerConfirm, confirmBox } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { anySaveBar, isProjectPatch, openSettings, saveSettings, settingsBar, settingsMenu } from '../support/settings.ts';

/**
 * Every panel on the page, top to bottom, by its anchor and its heading (word for word, without its ⓘ tip): Judge
 * results by heads the page, the form's panels follow, then the three after the form that save on their own (API
 * keys for an owner only). settings/sections.ts lists the form's; SettingsTab.svelte sets the ids.
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
	['set-auto', 'Automatic runs'],
	['set-feeds', 'Data feeds'],
	['set-api-keys', 'API keys'],
	['set-report-schedules', 'Scheduled reports']
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
	[
		'Automation & access',
		[
			['Automatic runs', 'set-auto'],
			['Data feeds', 'set-feeds'],
			['API keys', 'set-api-keys'],
			['Scheduled reports', 'set-report-schedules']
		]
	]
];

/** A panel's own heading: the first h2 (h3 for a card) under its anchor, read as shown (its ⓘ tip adds no text). */
const panelHeading = (page: Page, id: string) => page.locator(`#${id}`).locator('h2, h3').first();
const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const pageTitle = (page: Page) => page.getByRole('heading', { level: 1, name: 'Settings & calibration', exact: true });

/** Opens Settings and waits for the lazy panels (Evaporation from the map, and the three after the form) to draw. */
async function openAllPanels(page: Page, projectId: string) {
	await openSettings(page, projectId);
	for (const [id, heading] of [...INNER, ...PANELS.slice(-3)]) {
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
	// The line that says the panels after the form save on their own sits between the form and them.
	const line = (await page.getByText(/^Data feeds, API keys and scheduled reports save as you change them/).boundingBox())!;
	expect(line.y).toBeGreaterThan((await panelHeading(page, 'set-auto').boundingBox())!.y);
	expect(line.y).toBeLessThan((await panelHeading(page, 'set-feeds').boundingBox())!.y);

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

/**
 * Anchors that don't land today, from a load of the page (a link from another page or a bookmark): each panel is a
 * lazy chunk that isn't drawn when SettingsTab's onMount looks for the anchor's heading, so the heading is never
 * focused, and for the two whose id is inside the chunk (API keys, Evaporation from the map) nothing scrolls at all.
 * Expected to fail until issue #586 lands them (its round 1 moves the three after the form); remove the entry with
 * the fix, and this pin then holds it.
 */
const NOT_LANDING: Record<string, string> = {
	'set-evaporation': 'the id is inside the lazy card: the page stays at the top',
	'set-feeds': 'the heading is drawn after onMount: in view, not focused',
	'set-api-keys': 'the id is inside the lazy panel: the page stays at the top',
	'set-report-schedules': 'the heading is drawn after onMount: in view, not focused'
};

for (const [id, heading] of [...PANELS, ...INNER.map(([i, h]): [string, string] => [i, h])]) {
	test(`a load of #${id} lands on ${heading}: in view below the bar, and focused`, async ({ page, owner }) => {
		void owner;
		test.fail(id in NOT_LANDING, `issue #586: #${id} ${NOT_LANDING[id]}`);
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

test('?tab=calibration opens Settings & calibration under its own sidebar row, and lands its anchors', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings pins alias');
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(pageTitle(page)).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration$`));
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
