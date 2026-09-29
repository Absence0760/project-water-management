// The Dams page (?tab=dams, issue #17 option A · Outcomes): a card per dam with how full it was at the end of the
// latest run, the picked dam's storage chart (dam=<nodeId>), and the Dam levels table moved here from the Summary.
// Synthetic data only: the seeded catchment's two farm dams, plus a third farm's dam with no minimum level.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, putModel, sampleModel, seedRunnableProject, type Model } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const cards = (page: Page) => page.getByRole('list', { name: 'Dams' }).getByRole('listitem');
const card = (page: Page, name: string) => cards(page).filter({ has: page.getByText(name, { exact: true }) });
const chart = (page: Page) => page.getByRole('region', { name: /^Storage/ });
const table = (page: Page) => page.getByRole('region', { name: 'Dam levels' });
const strip = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });

/** The seeded catchment with a third farm dam, Middle farm, with no minimum level; and a capacity on the gauge, which the engine ignores. */
async function seedThreeDams(page: Page, name: string): Promise<{ id: string; model: Model }> {
	const project = await seedRunnableProject(page.request, name);
	const model = project.model;
	const gauge = model.nodes[0]!;
	gauge.damCapacityM3 = 50_000;
	model.nodes.push({ ...model.nodes[2]!, id: crypto.randomUUID(), name: 'Middle farm', sortOrder: 4, areaKm2: 4, damCapacityM3: 20_000, damMinPct: 0 });
	await putModel(page.request, project.id, model);
	return project;
}

async function openDams(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=dams${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
}

const chartReady = (page: Page) => expect(chart(page).locator('figure.chart')).toHaveAttribute('data-ready', 'true');

test('a card per dam, emptiest first, with % full, its change and a sparkline; the table below agrees', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedThreeDams(page, 'Dams cards');
	const run = await createRun(page.request, project.id, 'Baseline');
	await openDams(page, project.id);

	await expect(strip(page).getByRole('link', { name: 'Dams', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByTestId('dams-summary')).toHaveText('3 dams · 260\u202f000 m³ capacity · latest run “Baseline”, ran today');
	await expect(cards(page)).toHaveCount(3);
	await chartReady(page);

	// Emptiest first, each with % full, its change over 30 days and its sparkline; the same order and % as the table.
	const pcts = await cards(page).evaluateAll((lis) => lis.map((li) => parseFloat(li.querySelector('.level .v')!.textContent!)));
	expect(pcts.every((v) => v >= 0 && v <= 100)).toBe(true);
	expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
	for (const li of await cards(page).all()) {
		await expect(li).toContainText(/(up|down) \d+ pp in 30 days|no change in 30 days/);
		await expect(li.getByRole('img', { name: /: % full over the run's last year\. .* \d+% at the end; low \d+% on / })).toBeVisible();
	}
	const rows = table(page).getByRole('row').filter({ has: page.getByRole('rowheader') });
	await expect(rows).toHaveCount(3);
	const names = await cards(page).locator('.name').allInnerTexts();
	await expect(rows.getByRole('rowheader')).toContainText(names);
	const tablePcts = await rows.evaluateAll((trs) => trs.map((tr) => parseFloat(tr.querySelectorAll('td')[0]!.textContent!)));
	expect(tablePcts.map(Math.round)).toEqual(pcts.map(Math.round));
	// Every column and note of the Summary's old table.
	await expect(table(page).getByRole('columnheader')).toHaveText(['Dam', 'At the end of the run', 'Lowest in its last year', 'Days at minimum']);
	await expect(table(page)).toContainText("The tick on a bar is the dam's minimum operating level.");
	await expect(table(page).getByRole('link', { name: 'Open in Runs' })).toHaveAttribute('href', `?tab=runs&run=${run}`);
	// Middle farm has no minimum level: a dash, and no tick. The gauge's capacity isn't a dam (the engine ignores it).
	await expect(cards(page).filter({ hasText: 'Outflow gauge' })).toHaveCount(0);
	await expect(rows.filter({ hasText: 'Middle farm' }).locator('td').nth(2)).toHaveText('–');
	await expect(rows.filter({ hasText: 'Middle farm' }).locator('.min')).toHaveCount(0);

	// All dams together, weighted by capacity (the Summary's Dams today).
	const caps: Record<string, number> = { 'Upper farm': 150_000, 'Lower farm': 90_000, 'Middle farm': 20_000 };
	const weighted = names.reduce((s, n, i) => s + pcts[i]! * caps[n]!, 0) / 260_000;
	const shown = parseFloat((await page.getByTestId('dams-total').locator('strong').textContent())!);
	expect(Math.abs(shown - weighted)).toBeLessThanOrEqual(1);

	// The first card is the one charted, and the chart says how full it is; a farm's minimum level (10 %) is counted.
	await expect(card(page, names[0]!).getByRole('link', { name: names[0]!, exact: true })).toHaveAttribute('aria-current', 'true');
	await expect(chart(page).getByRole('heading')).toHaveText(`Storage: ${names[0]}`);
	await page.goto(`/projects/${project.id}?tab=dams&dam=${project.model.nodes[1]!.id}`);
	await expect(page.getByTestId('dam-facts')).toContainText('at its minimum level (10%)');
	const facts = (await page.getByTestId('dam-facts').textContent())!.replace(/[ \t\r\n]+/g, ' ').trim();
	expect(facts).toMatch(/^\d+% full on 28 Jan 2022 \([\d\u202f]+ of 150\u202f000 m³\) · lowest in its last year \d+% on \d{1,2} [A-Z][a-z]{2} 202[12] · \d+ days? at its minimum level \(10%\)$/);
	await expect(chart(page).getByRole('img', { name: 'Upper farm storage: line chart of Storage, Capacity, Minimum level' })).toBeVisible();
});

test('picking a dam puts it in the URL, and Back returns to the one before; the range and unit switches', async ({ page, owner }) => {
	void owner;
	const project = await seedThreeDams(page, 'Dams pick');
	await createRun(page.request, project.id, 'Baseline');
	await openDams(page, project.id);
	await chartReady(page);
	const first = (await chart(page).getByRole('heading').textContent())!.replace('Storage: ', '');
	const other = first === 'Middle farm' ? 'Lower farm' : 'Middle farm';
	const otherId = project.model.nodes.find((n) => n.name === other)!.id as string;

	// Anywhere on the card picks it.
	await card(page, other).click({ position: { x: 150, y: 70 } });
	await expect(page).toHaveURL(new RegExp(`[?&]tab=dams&dam=${otherId}$`));
	await expect(chart(page).getByRole('heading')).toHaveText(`Storage: ${other}`);
	await expect(card(page, other).getByRole('link', { name: other, exact: true })).toHaveAttribute('aria-current', 'true');
	await chartReady(page);
	await page.goBack();
	await expect(page).toHaveURL(/[?&]tab=dams$/);
	await expect(chart(page).getByRole('heading')).toHaveText(`Storage: ${first}`);
	await page.goForward();
	await expect(chart(page).getByRole('heading')).toHaveText(`Storage: ${other}`);
	// A reload keeps it (the link can be shared).
	await page.reload();
	await expect(chart(page).getByRole('heading')).toHaveText(`Storage: ${other}`);
	await chartReady(page);

	// 30 days / 1 year / All; it opens on a year (the whole of this 120-day run).
	const windows = chart(page).getByRole('group', { name: 'Time window' });
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true');
	await windows.getByRole('button', { name: '30 days' }).click();
	await expect(windows.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'false');
	await windows.getByRole('button', { name: 'All' }).click();
	await expect(windows.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

	// % full by default; m³ on request, the capacity line at the dam's capacity.
	const as = chart(page).getByRole('group', { name: 'Show storage as' });
	await expect(as.getByRole('button', { name: '% full' })).toHaveAttribute('aria-pressed', 'true');
	await expect(chart(page).locator('figure.chart')).toContainText('% of capacity');
	await as.getByRole('button', { name: 'm³' }).click();
	await expect(as.getByRole('button', { name: 'm³' })).toHaveAttribute('aria-pressed', 'true');
	await expect(chart(page).locator('figure.chart')).not.toContainText('% of capacity');
});

test('a card links to its node on the Network, and a farm’s card to its planted areas', async ({ page, owner }) => {
	void owner;
	const project = await seedThreeDams(page, 'Dams links');
	await createRun(page.request, project.id, 'Baseline');
	await openDams(page, project.id);
	const upperId = project.model.nodes[1]!.id as string;

	// The farm drawer opens over the Dams page and closes back to it.
	await card(page, 'Upper farm').getByRole('link', { name: 'Upper farm: planted areas' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=dams&farm=${upperId}$`));
	await expect(page.getByRole('dialog', { name: 'Upper farm: planted areas' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).toHaveURL(/\?tab=dams$/);

	await card(page, 'Upper farm').getByRole('link', { name: 'Upper farm on the Network' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=network&node=${upperId}$`));
	await expect(page.getByTestId('node-card').getByRole('heading', { name: 'Upper farm' })).toBeVisible();
});

test('before a run the cards show capacity with a prompt to run; with no dams it says how to add one', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dams no run');
	await openDams(page, project.id);
	await expect(page.getByTestId('dams-summary')).toHaveText('2 dams · 240\u202f000 m³ capacity · no run yet');
	await expect(page.getByRole('note')).toContainText('No run yet, so the cards show each dam\'s capacity only.');
	await expect(page.getByRole('note').getByRole('link', { name: 'Run the model' })).toHaveAttribute('href', '?tab=runs');
	await expect(cards(page)).toHaveCount(2);
	await expect(card(page, 'Upper farm')).toContainText('150\u202f000 m³');
	await expect(card(page, 'Upper farm')).toContainText('No run yet');
	await expect(chart(page)).toHaveCount(0);
	await expect(table(page)).toHaveCount(0);
	await expectNoViolations(page);

	const bare = await createProject(page.request, 'Dams none');
	const model = sampleModel();
	for (const n of model.nodes) n.damCapacityM3 = 0;
	await putModel(page.request, bare.id, model);
	await openDams(page, bare.id);
	await expect(page.getByTestId('dams-summary')).toHaveText('No dams in the model yet');
	const empty = page.getByRole('region', { name: 'No dams yet' });
	await expect(empty.getByRole('link', { name: 'Open the Network' })).toHaveAttribute('href', '?tab=network');
	// The node table opens over this page: a new dam there shows as a card at once (before any save).
	await empty.getByRole('link', { name: /^Node table/ }).click();
	await expect(page).toHaveURL(/\?tab=dams&grid=nodes$/);
	await expect(page.getByRole('dialog', { name: 'Node table' })).toBeVisible();
	await expectNoViolations(page);
});

test('a viewer sees the Dams page and its data, with no prompt to run', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dams viewer');
	const viewer = await signIn('Dams viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;

	await v.goto(`/projects/${project.id}`);
	await strip(v).getByRole('link', { name: 'Dams', exact: true }).click();
	await expect(v).toHaveURL(/\?tab=dams$/);
	await expect(v.getByRole('note').filter({ hasText: 'No run yet' })).toContainText('Once an editor runs the model');
	await expect(v.getByRole('note').filter({ hasText: 'No run yet' }).getByRole('link')).toHaveCount(0);

	await createRun(page.request, project.id, 'Baseline');
	await v.reload();
	await chartReady(v);
	await expect(cards(v)).toHaveCount(2);
	await expect(table(v).getByRole('rowheader')).toHaveCount(2);
});

/** The seeded catchment plus `extra` farm dams with long names (a big case: the cards fold, the table's rows too). */
async function seedManyDams(page: Page, name: string, extra: number): Promise<{ id: string; model: Model }> {
	const project = await seedRunnableProject(page.request, name);
	const model = project.model;
	const template = model.nodes[2]!;
	for (let i = 0; i < extra; i++) {
		const id = crypto.randomUUID();
		model.nodes.push({ ...template, id, name: `Farm dam ${i + 1} on the long tributary`, sortOrder: 4 + i, areaKm2: 2 + (i % 5), damCapacityM3: 20_000 + i * 5_000 });
		model.cropAreas.push({ nodeId: id, cropId: model.crops[0]!.id, areaM2: 100_000 + i * 10_000 });
	}
	await putModel(page.request, project.id, model);
	return project;
}

/** Elements on the Dams page that scroll vertically inside themselves (the page is the one scroll). */
const innerScrollers = (page: Page) =>
	page.locator('.dams-page').evaluate((root) =>
		[root, ...root.querySelectorAll('*')]
			.filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)
			.map((e) => `${e.tagName.toLowerCase()}.${e.className}`)
	);

test.describe('flows in the window’s scroll, with nothing scrolling inside a card, and has no accessibility violations', () => {
	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 960 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		test(label, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize(viewport);
			const project = await seedThreeDams(page, `Dams a11y ${label}`);
			await createRun(page.request, project.id, 'Baseline');
			await openDams(page, project.id);
			await chartReady(page);
			await expect(table(page).getByRole('rowheader')).toHaveCount(3);
			const list = (await page.getByRole('list', { name: 'Dams' }).boundingBox())!;
			const box = (await chart(page).boundingBox())!;
			// Three dams: every card shows, no fold.
			await expect(cards(page)).toHaveCount(3);
			await expect(page.getByRole('button', { name: /^Show all \d+ dams$/ })).toHaveCount(0);
			if (label === 'desktop') {
				// The cards in a column beside the chart, both on the first screen; the chart no longer stretches to the
				// window's foot (it was sized to it until 2026-09-29), and the Dam levels table starts below them.
				expect(box.x).toBeGreaterThan(list.x + list.width);
				expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
				expect(box.height).toBeGreaterThan(400);
				const t = (await table(page).boundingBox())!;
				expect(t.y).toBeGreaterThan(Math.max(box.y + box.height, list.y + list.height));
			} else {
				// Stacked: the cards, then the chart; nothing wider than the screen.
				expect(box.y).toBeGreaterThan(list.y + list.height - 1);
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
				// Picking a dam brings its chart into view.
				await cards(page).last().locator('a.name').click();
				await expect(chart(page).getByRole('heading')).toHaveText(`Storage: ${(await cards(page).last().locator('a.name').textContent())!}`);
				await expect(chart(page)).toBeInViewport();
			}
			expect(await innerScrollers(page)).toEqual([]);
			await expectNoViolations(page);
		});
	}
});

test('many dams: the emptiest few show, the rest open in place under “Show all”; the picked dam keeps its card; nothing scrolls inside itself', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedManyDams(page, 'Dams many', 12);
	await createRun(page.request, project.id, 'Baseline');
	await openDams(page, project.id);
	await chartReady(page);
	await expect(page.getByTestId('dams-summary')).toContainText('14 dams');

	// Beside the chart: the three emptiest, then the fold.
	const more = page.getByRole('button', { name: 'Show all 14 dams' });
	await expect(cards(page)).toHaveCount(3);
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(more).toHaveAttribute('aria-controls', 'dam-cards');
	const firstThree = await cards(page).locator('a.name').allInnerTexts();
	expect(await innerScrollers(page)).toEqual([]);

	// Open: all 14 in place, emptiest first, the page (not the list) growing; the chart stays in view beside them.
	await more.click();
	await expect(cards(page)).toHaveCount(14);
	expect((await cards(page).locator('a.name').allInnerTexts()).slice(0, 3)).toEqual(firstThree);
	const fewer = page.getByRole('button', { name: 'Show the 3 emptiest' });
	await expect(fewer).toHaveAttribute('aria-expanded', 'true');
	expect(await innerScrollers(page)).toEqual([]);
	await cards(page).nth(12).scrollIntoViewIfNeeded();
	await expect(chart(page)).toBeInViewport();

	// Pick one far down, then fold: its card stays, after the three emptiest.
	const far = (await cards(page).nth(12).locator('a.name').innerText()).trim();
	await cards(page).nth(12).locator('a.name').click();
	await expect(chart(page).getByRole('heading')).toHaveText(`Storage: ${far}`);
	await fewer.click();
	await expect(cards(page)).toHaveCount(4);
	await expect(cards(page).locator('a.name')).toHaveText([...firstThree, far]);
	await expect(page.getByRole('button', { name: 'Show all 14 dams' })).toBeVisible();
	// A shared link to that dam opens with its card shown too.
	await page.reload();
	await expect(cards(page)).toHaveCount(4);
	await expect(cards(page).last().locator('a.name')).toHaveAttribute('aria-current', 'true');

	// The Dam levels table: eight rows, then all of them, growing with the page rather than scrolling in its box.
	await expect(table(page).getByRole('rowheader')).toHaveCount(8);
	await table(page).getByRole('button', { name: 'Show all 14 rows' }).click();
	await expect(table(page).getByRole('rowheader')).toHaveCount(14);
	await expect(table(page).getByRole('button', { name: 'Show the 8 emptiest rows' })).toHaveAttribute('aria-expanded', 'true');
	expect(await innerScrollers(page)).toEqual([]);

	// On a phone: four cards (two rows) before the chart, still no inner scroll and no sideways scroll.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=dams`);
	await chartReady(page);
	await expect(cards(page)).toHaveCount(4);
	await expect(page.getByRole('button', { name: 'Show all 14 dams' })).toBeVisible();
	expect(await innerScrollers(page)).toEqual([]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await expectNoViolations(page);
});
