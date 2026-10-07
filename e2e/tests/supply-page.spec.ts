// Units & supply (?tab=supply, issue #17 option A · Outcomes; docs/ui.md §
// Units & supply): three tiles, a card per unit worst supplied first in the
// Summary's and the Network's supply bands, the picked unit's supply against
// its demand (unit=<nodeId>), and the panels moved here from Runs & results
// (the unit results table, curtailment, assurance of supply). Synthetic data
// only: the seeded catchment plus two units whose orchards outgrow their water.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openSupply, seedSupplyProject, supplyTile, supplyTiles, unitCards, unitChart } from '../support/supply.ts';

const strip = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
/** Elements on the page that scroll vertically inside themselves (the window is the one scroll). */
const innerScrollers = (page: Page) =>
	page.locator('.supply-page').evaluate((root) =>
		[root, ...root.querySelectorAll('*')]
			.filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)
			.map((e) => `${e.tagName.toLowerCase()}.${e.className}`)
	);
const pcts = (page: Page) => unitCards(page).evaluateAll((lis) => lis.map((li) => parseFloat(li.querySelector('.level .v')?.textContent ?? 'NaN')));

test('three tiles, a card per hydrological unit worst supplied first in the Summary’s bands, and the tables that moved from Runs & results', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedSupplyProject(page.request, 'Supply cards');
	await createRun(page.request, project.id, 'Earlier');
	const run = await createRun(page.request, project.id, 'Baseline');
	await openSupply(page, project.id);

	await expect(strip(page).getByRole('link', { name: 'Hydrological units', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(page.getByTestId('supply-summary')).toHaveText(/^4 hydrological units · \d short in the week to 28 Jan 2022 · run “Baseline”, ran today$/);
	await expect(page.getByRole('link', { name: 'Open in Runs' })).toHaveAttribute('href', `?tab=runs&run=${run}`);

	// The tiles: the Summary's irrigation supplied with the units below 95 % under it and its change (the same inputs,
	// so no change; the units below were a tile of their own until issue #175), short in the run's last 7 days
	// (named by their last day, long past: issue #162; linking to the curtailment over them) and the total shortfall.
	await expect(supplyTiles(page)).toHaveCount(3);
	await expect(page.locator('[data-kpi="below"]')).toHaveCount(0);
	await expect(supplyTile(page, 'supplied')).toContainText(/Irrigation supplied\s*[\d.]+%\s*of demand/);
	await expect(supplyTile(page, 'supplied')).toContainText(/0 pp\s*no change vs previous run/);
	await expect(supplyTile(page, 'supplied').getByTestId('supply-below')).toHaveText(/^(\d of 4 hydrological units below 95%|all hydrological units ≥ 95%)$/);
	await expect(supplyTile(page, 'week')).toContainText('2022-01-22 to 2022-01-28');
	await expect(supplyTile(page, 'week').getByRole('link', { name: 'Short in the week to 28 Jan 2022' })).toHaveAttribute('href', `?tab=supply&run=${run}&window=last7#res-curtailment`);
	await expect(supplyTile(page, 'shortfall')).toContainText(/Total shortfall\s*[\d.]+\s*Mm³\/a/);

	// Worst supplied first, each in its band (words as well as colour), with its facts and links.
	await expect(unitCards(page)).toHaveCount(4);
	const shown = await pcts(page);
	expect([...shown].sort((a, b) => a - b)).toEqual(shown);
	const bands = await unitCards(page).evaluateAll((lis) => lis.map((li) => li.getAttribute('data-band')));
	const band = (p: number) => (p >= 95 ? 'met' : p >= 70 ? 'short' : 'low');
	// The % is rounded for show, so only check the cards clear of a band edge.
	shown.forEach((p, i) => {
		if (Math.abs(p - 95) > 1 && Math.abs(p - 70) > 1) expect(bands[i]).toBe(band(p));
	});
	expect(bands[0]).not.toBe('met');
	const below = shown.filter((p) => p < 95).length;
	await expect(supplyTile(page, 'supplied').getByTestId('supply-below')).toHaveText(below ? `${below} of 4 hydrological units below 95%` : 'all hydrological units ≥ 95%');
	const first = unitCards(page).first();
	await expect(first).toContainText(/below (95|70)%/);
	await expect(first).toContainText(/Short [\d\u202f]+ m³\/day on average \([\d.]+ Mm³\/a\)/);
	await expect(first).toContainText(/\d+ of \d+ demand days short in the reporting window/);
	const firstId = (await first.getAttribute('data-unit'))!;
	const firstName = (await first.locator('a.name').textContent())!.trim();
	await expect(first.getByRole('link', { name: `${firstName} on the Network` })).toHaveAttribute('href', `?tab=network&node=${firstId}`);
	await expect(first.getByRole('link', { name: `${firstName}: planted areas` })).toHaveAttribute('href', `?tab=supply&farm=${firstId}`);
	// The tile counts the units with a short day in the week; each such card says so.
	const week = parseInt((await supplyTile(page, 'week').locator('.value').textContent())!, 10);
	await expect(unitCards(page).filter({ hasText: /Short on \d of the 7 days to 28 Jan 2022/ })).toHaveCount(week);
	await expect(page.getByTestId('supply-summary')).toContainText(`${week} short in the week to 28 Jan 2022`);

	// The same bands as the Summary's Supply by unit.
	await page.goto(`/projects/${project.id}`);
	const summaryBands = page.getByRole('region', { name: 'Supply by hydrological unit' }).getByRole('listitem');
	await expect(summaryBands).toHaveCount(4);
	await expect(summaryBands.filter({ hasText: firstName })).toHaveAttribute('data-band', bands[0]!);
	await page.getByRole('link', { name: 'More on Hydrological units' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=supply&run=${run}$`));

	// Below the first screen: the unit results table, curtailment with its reporting window, and assurance of supply.
	const results = page.getByRole('region', { name: 'Hydrological unit results' });
	await expect(results.getByRole('rowheader', { name: 'All hydrological units' })).toBeVisible();
	await expect(results.getByRole('rowheader', { name: /^Upper farm/ })).toBeVisible();
	await expect(results.getByTestId('farms-period')).toHaveText(
		'Daily averages over the whole record, 2021-10-01 to 2022-01-28 (120 days); the curtailment targets cover the reporting window.'
	);
	await expect(page.locator('#res-curtailment').getByRole('heading', { name: 'Curtailment targets' })).toBeVisible();
	await expect(page.locator('#res-curtailment').getByLabel('Reporting window')).toHaveValue('project');
	await expect(page.getByRole('region', { name: 'Assurance of supply', exact: true }).getByTestId('reliability-table').getByRole('rowheader')).toHaveCount(4);

	// The page flows in the window's one scroll (it was fitted to the window, cards scrolling in their column, until
	// 2026-09-29): four units show whole, no fold, nothing scrolls inside itself, and the tables start below the cards.
	await expect(page.getByRole('button', { name: /^Show all \d+ hydrological units$/ })).toHaveCount(0);
	expect(await innerScrollers(page)).toEqual([]);
	const list = (await page.getByRole('list', { name: 'Hydrological units', exact: true }).boundingBox())!;
	const chart = (await unitChart(page).boundingBox())!;
	expect(chart.y + chart.height).toBeLessThanOrEqual(960);
	expect((await results.boundingBox())!.y).toBeGreaterThan(Math.max(list.y + list.height, chart.y + chart.height));
});

test('many hydrological units: every unit below the target or short this week shows, the rest open in place under “Show all”; the picked unit keeps its card; the chart and the table header stay in view; nothing scrolls inside itself', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedSupplyProject(page.request, 'Supply many', 30);
	// Twenty units without an orchard (no irrigation demand, so nothing to look into): the fold has units to leave out.
	const bare = new Set(project.model.nodes.slice(-20).map((n) => n.id));
	project.model.cropAreas = project.model.cropAreas.filter((a) => !bare.has(a.nodeId));
	await putModel(page.request, project.id, project.model);
	await createRun(page.request, project.id, 'Baseline');
	await openSupply(page, project.id);
	await expect(page.getByTestId('supply-summary')).toContainText('32 hydrological units');
	await expect(page.getByTestId('supply-summary')).toContainText(/short (this week|in the week)/);

	// Open first, to read every card: its band, and whether it was short in the run's last 7 days.
	const more = page.getByRole('button', { name: 'Show all 32 hydrological units' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(more).toHaveAttribute('aria-controls', 'unit-cards');
	// The fold follows the cards that need a look, however many: here it is below the first screen.
	await more.click();
	await expect(unitCards(page)).toHaveCount(32);
	const all = await unitCards(page).evaluateAll((lis) =>
		lis.map((li) => ({
			name: li.querySelector('a.name')!.textContent!.trim(),
			band: li.getAttribute('data-band'),
			week: [...li.querySelectorAll('.facts li')].some((f) => /^Short on \d+ of the /.test(f.textContent ?? ''))
		}))
	);
	const look = all.filter((c, i) => i < 3 || c.band === 'short' || c.band === 'low' || c.week);
	// More than three need a look (the client saw "only three" when the rest were folded away), and some don't.
	expect(all.filter((c) => c.band === 'short' || c.band === 'low').length).toBeGreaterThan(3);
	expect(look.length).toBeLessThan(31);
	expect(all.filter((c) => c.band === 'none')).toHaveLength(20);
	const fewer = page.getByRole('button', { name: 'Show only the units to look into first' });
	await expect(fewer).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByTestId('unit-fold-note')).toHaveCount(0);
	const shown = await pcts(page);
	expect([...shown.filter((p) => !Number.isNaN(p))].sort((a, b) => a - b)).toEqual(shown.filter((p) => !Number.isNaN(p)));
	expect(await innerScrollers(page)).toEqual([]);

	// Folded: exactly those, in the list's order, and a line saying what the rest are.
	await fewer.click();
	await expect(unitCards(page).locator('a.name')).toHaveText(look.map((c) => c.name));
	await expect(page.getByTestId('unit-fold-note')).toHaveText(`${32 - look.length} more meet the 95% supply target or have no irrigation demand, and none is short this week.`);
	expect(await innerScrollers(page)).toEqual([]);

	// Open again: the chart sticks beside the long list…
	await more.click();
	await unitCards(page).nth(28).scrollIntoViewIfNeeded();
	await expect(unitChart(page).getByRole('heading', { level: 2 })).toBeInViewport();
	// …under the "On this page" menu, not behind it.
	const menu = (await page.getByRole('navigation', { name: 'Hydrological units sections' }).boundingBox())!;
	expect((await unitChart(page).boundingBox())!.y).toBeGreaterThanOrEqual(menu.y + menu.height);

	// Pick one far down, then fold: its card stays, after the ones to look into; a reload of its link keeps it.
	const far = unitCards(page).nth(30);
	const farName = (await far.locator('a.name').innerText()).trim();
	await far.locator('a.name').click();
	await expect(page).toHaveURL(/[?&]unit=/);
	await expect(unitChart(page).getByRole('heading', { level: 2 })).toHaveText(`Hydrological unit detail: ${farName}`);
	await fewer.click();
	await expect(unitCards(page).locator('a.name')).toHaveText([...look.map((c) => c.name), farName]);
	await page.reload();
	await expect(unitCards(page)).toHaveCount(look.length + 1);
	await expect(unitCards(page).last().locator('a.name')).toHaveAttribute('aria-current', 'true');
	await expect(page.getByRole('button', { name: 'Show all 32 hydrological units' })).toBeVisible();

	// The unit results table grows with its rows (no 70vh box), its header row sticking under the menu as the window scrolls.
	const results = page.getByRole('region', { name: 'Hydrological unit results' });
	await expect(results.locator('tbody tr')).toHaveCount(32);
	await results.locator('tbody tr').nth(30).scrollIntoViewIfNeeded();
	const head = (await results.locator('thead').boundingBox())!;
	const bar = (await page.getByRole('navigation', { name: 'Hydrological units sections' }).boundingBox())!;
	expect(Math.abs(head.y - (bar.y + bar.height))).toBeLessThanOrEqual(2);
	expect(await innerScrollers(page)).toEqual([]);

	// On a phone: the same cards and the fold before the chart, still nothing scrolling inside itself, no sideways scroll.
	await page.setViewportSize({ width: 390, height: 844 });
	await openSupply(page, project.id);
	await expect(unitCards(page)).toHaveCount(look.length);
	await expect(page.getByRole('button', { name: 'Show all 32 hydrological units' })).toBeVisible();
	// Stacked in reading order: the cards, their fold, then the chart (measured in one go, so a scroll between can't skew it).
	const order = await page.evaluate(() => {
		const top = (el: Element | null) => el!.getBoundingClientRect().top;
		return [top(document.getElementById('unit-cards')), top(document.querySelector('#unit-cards ~ button.more')), top(document.getElementById('res-farm'))];
	});
	expect([...order].sort((a, b) => a - b)).toEqual(order);
	expect(await innerScrollers(page)).toEqual([]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await expectNoViolations(page);
});

test('picking a hydrological unit charts its supply against demand, the link round-trips, Back returns, and the windows switch', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedSupplyProject(page.request, 'Supply pick', 2, 800);
	await createRun(page.request, project.id, 'Baseline');
	await openSupply(page, project.id);

	// The worst unit opens picked.
	const first = unitCards(page).first();
	const firstName = (await first.locator('a.name').textContent())!.trim();
	await expect(first.locator('a.name')).toHaveAttribute('aria-current', 'true');
	await expect(unitChart(page).getByRole('heading', { level: 2 })).toHaveText(`Hydrological unit detail: ${firstName}`);

	// Pick Upper farm (it has a dam): the URL names it, the chart and facts follow.
	const upper = project.model.nodes[1]!;
	await unitCards(page).filter({ hasText: 'Upper farm' }).locator('a.name').click();
	await expect(page).toHaveURL(new RegExp(`[?&]unit=${upper.id as string}$`));
	await expect(unitChart(page).getByRole('heading', { level: 2 })).toHaveText('Hydrological unit detail: Upper farm');
	await expect(unitCards(page).filter({ hasText: 'Upper farm' }).locator('a.name')).toHaveAttribute('aria-current', 'true');
	await expect(page.getByTestId('unit-facts')).toHaveText(/^Abstraction demand [\d\u202f]+ m³\/day, supplied [\d\u202f]+ m³\/day\s+\([\d.]+%\) · dam 150\u202f000 m³\.$/);
	const fig = unitChart(page).locator('figure.chart');
	await expect(fig).toHaveAttribute('data-ready', 'true');
	await expect(unitChart(page).getByRole('img', { name: /^Supply vs demand/ })).toBeVisible();

	// 30 days / 1 year / All, opening on a year; Earlier / Later move through the record; no flow-unit switch.
	const windows = unitChart(page).getByRole('group', { name: /window/i });
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true');
	await windows.getByRole('button', { name: '30 days' }).click();
	await expect(windows.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
	const end = await fig.getAttribute('data-view-end');
	await unitChart(page).getByRole('button', { name: /Earlier/ }).click();
	await expect(fig).not.toHaveAttribute('data-view-end', end!);
	await windows.getByRole('button', { name: 'All' }).click();
	await expect(windows.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
	await expect(unitChart(page).getByRole('button', { name: 'm³/s' })).toHaveCount(0);

	// Its dam: a link to its storage chart on the Dams page (issue #175 dropped this panel's weaker copy of it).
	await expect(unitChart(page).getByRole('button', { name: 'Dam storage' })).toHaveCount(0);
	await expect(unitChart(page).getByRole('link', { name: 'Dam storage on the Dams page' })).toHaveAttribute('href', `?tab=dams&dam=${upper.id as string}`);

	// Back returns to the worst unit; a reload of a unit link opens it.
	await page.goBack();
	await expect(page).not.toHaveURL(/[?&]unit=/);
	await expect(unitChart(page).getByRole('heading', { level: 2 })).toHaveText(`Hydrological unit detail: ${firstName}`);
	await page.goto(`/projects/${project.id}?tab=supply&unit=${upper.id as string}`);
	await expect(unitChart(page).getByRole('heading', { level: 2 })).toHaveText('Hydrological unit detail: Upper farm');
	// A unit the run doesn't have: the worst one instead.
	await page.goto(`/projects/${project.id}?tab=supply&unit=nope`);
	await expect(unitChart(page).getByRole('heading', { level: 2 })).toHaveText(`Hydrological unit detail: ${firstName}`);

	// The dam link opens that dam's storage chart on the Dams page.
	await page.goto(`/projects/${project.id}?tab=supply&unit=${upper.id as string}`);
	await unitChart(page).getByRole('link', { name: 'Dam storage on the Dams page' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
	await expect(page.getByRole('region', { name: /^Storage/ }).getByRole('heading', { level: 2 })).toHaveText('Storage: Upper farm');
});

test('the run follows run= and the header picker; Runs & results links here for its run; old Runs anchors land here', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await seedSupplyProject(page.request, 'Supply runs');
	const earlier = await createRun(page.request, project.id, 'Earlier');
	const latest = await createRun(page.request, project.id, 'Latest');

	// Runs & results: the run header links here, keeping the run shown.
	await page.goto(`/projects/${project.id}?tab=runs&run=${earlier}`);
	await page.getByRole('navigation', { name: 'Outcomes for this run' }).getByRole('link', { name: 'Hydrological units for this run' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=supply&run=${earlier}$`));
	await expect(page.getByTestId('supply-summary')).toContainText('run “Earlier”');
	// The oldest run has nothing before it, so no change is shown.
	await expect(supplyTile(page, 'supplied')).not.toContainText('vs previous run');

	// The header's run picker.
	const picker = page.getByRole('combobox', { name: 'Run shown' });
	await expect(picker).toHaveValue(earlier);
	await picker.selectOption(latest);
	await expect(page).toHaveURL(new RegExp(`[?&]run=${latest}(&|$)`));
	await expect(page.getByTestId('supply-summary')).toContainText('run “Latest”');
	await page.goBack();
	await expect(picker).toHaveValue(earlier);

	// Old links to the moved panels: sent here for the same run, the old address replaced.
	for (const anchor of ['res-farm', 'res-farms', 'res-assurance']) {
		await page.goto(`/projects/${project.id}?tab=runs&run=${earlier}#${anchor}`);
		await expect(page).toHaveURL(new RegExp(`\\?tab=supply&run=${earlier}#${anchor}$`));
		await expect(page.locator(`#${anchor}`)).toBeInViewport();
	}

	// A run that's gone: the newest instead, said so.
	await page.goto(`/projects/${project.id}?tab=supply&run=00000000-0000-4000-8000-000000000000`);
	await expect(page.getByRole('note').filter({ hasText: 'That run no longer exists, so this shows the newest run.' })).toBeVisible();
	await expect(page.getByTestId('supply-summary')).toContainText('run “Latest”');
});

test('empty states: no run yet (owner and viewer), and no hydrological units in the model', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedSupplyProject(page.request, 'Supply empty');
	await page.goto(`/projects/${project.id}?tab=supply`);
	await expect(page.getByRole('heading', { level: 1, name: 'Hydrological units' })).toBeVisible();
	await expect(page.getByTestId('supply-summary')).toHaveText('4 hydrological units');
	await expect(page.getByText('No run yet. Run the model to see how much of each of the 4 hydrological units’ demand is supplied.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Run the model (Runs & results)' })).toHaveAttribute('href', '?tab=runs');

	const viewer = await signIn('Supply viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=supply`);
	await expect(viewer.page.getByText('No run yet. Once an editor runs the model, how much of each hydrological unit’s demand was supplied shows here.')).toBeVisible();

	const bare = await createProject(page.request, 'Supply no hydrological units');
	const model = sampleModel();
	await putModel(page.request, bare.id, { ...model, nodes: [model.nodes[0]!], cropAreas: [], transfers: [] });
	await page.goto(`/projects/${bare.id}?tab=supply`);
	await expect(page.getByTestId('supply-summary')).toHaveText('0 hydrological units');
	await expect(page.getByText(/^No hydrological units in this catchment’s model yet\./)).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open the Network' })).toHaveAttribute('href', '?tab=network');
});

test('a viewer sees the page and its tables; it passes axe at desktop, in dark and on a phone', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedSupplyProject(page.request, 'Supply viewer');
	await createRun(page.request, project.id, 'Baseline');
	const viewer = await signIn('Supply viewer 2');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 960 });
	await openSupply(v, project.id);
	await expect(strip(v).getByRole('link', { name: 'Hydrological units', exact: true })).toBeVisible();
	await expect(unitCards(v)).toHaveCount(4);
	await expect(v.getByRole('region', { name: 'Hydrological unit results' }).getByRole('rowheader', { name: 'All hydrological units' })).toBeVisible();
	await expect(v.locator('#res-curtailment').getByTestId('curtailment-period')).toBeVisible();
	await expectNoViolations(v);
	await v.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(v);
	await v.emulateMedia({ colorScheme: 'light' });

	// Phone: one column, no sideways scroll; picking a unit brings its chart into view.
	await v.setViewportSize({ width: 390, height: 844 });
	await expect(unitCards(v)).toHaveCount(4);
	expect(await v.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	expect(await innerScrollers(v)).toEqual([]);
	await expectNoViolations(v);
	await unitCards(v).nth(2).locator('a.name').click();
	await expect(v).toHaveURL(/[?&]unit=/);
	await expect(unitChart(v)).toBeInViewport();
});
