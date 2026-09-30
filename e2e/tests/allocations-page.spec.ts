// The Allocations page (?tab=allocations, issue #17 option A, docs/ui.md § Allocations): the section header counts
// the volumes and the units above registered and carries Download CSV, Import and + Add volume (side sheets,
// `import=1`, `volume=new|<id>`) and the run picker (`run=`); a list of each unit and source, the ones to look into
// first, beside the picked unit's water years (`unit=`); below, the registered volumes and every unit's water years.
// The page flows in the window's one scroll (it fitted the window until 2026-09-29): every long list shows its first
// few with a "Show all" that opens the rest in place, and nothing scrolls inside a card. A viewer sees volumes
// without names and nothing to change. On a phone it stacks. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { compareCard, openAllocations, seedManyAllocations, volumesCard } from '../support/allocations.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const header = (page: Page) => page.getByTestId('section-header');
const detail = (page: Page) => page.getByTestId('allocation-unit');
const units = (page: Page) => compareCard(page).getByRole('list', { name: 'Hydrological units, the ones to look into first' }).getByRole('listitem');
const RANK = { over: 0, unregistered: 1, under: 2, within: 3, none: 4 } as const;

/** Elements on the page that scroll vertically inside themselves (the window is the one scroll). */
const innerScrollers = (page: Page) =>
	page.locator('.allocations').evaluate((root) =>
		[root, ...root.querySelectorAll('*')]
			.filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)
			.map((e) => `${e.tagName.toLowerCase()}.${e.className}`)
	);

test('many hydrological units: the ones to look into first, folded, with nothing scrolling inside a card; picking a hydrological unit is a link, and the sheets are too', async ({ page, owner, signIn }) => {
	test.setTimeout(120_000);
	void owner;
	const project = await seedManyAllocations(page.request, 'Allocations big');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openAllocations(page, project.id);

	// One title; the header counts the volumes, the unmatched ones and the units above registered, and has the actions.
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(header(page).getByTestId('section-context')).toHaveText(/^40 registered volumes · 4 not matched · \d+ hydrological units above registered$/);
	await expect(header(page).getByRole('link', { name: 'Download CSV', exact: true })).toHaveAttribute('href', /\/allocations\/export\.csv$/);
	await expect(header(page).getByRole('link', { name: 'Import', exact: true })).toBeVisible();
	await expect(header(page).getByRole('link', { name: '+ Add volume', exact: true })).toBeVisible();
	await expect(page.getByTestId('allocation-compare')).toContainText('modelled, not metered');

	// The five to look into first beside the picked unit, then "Show all"; the page flows, nothing scrolls inside a
	// card, and the Registered volumes card's top edge shows inside the window, so it's plain there is more below.
	await expect(units(page)).toHaveCount(5);
	const more = compareCard(page).getByRole('button', { name: 'Show all 36 hydrological units and sources' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(more).toHaveAttribute('aria-controls', 'alloc-units');
	expect(await innerScrollers(page)).toEqual([]);
	await expect(volumesCard(page).getByRole('heading', { name: 'Registered volumes' })).toBeInViewport();
	const firstName = (await units(page).first().getByRole('link').textContent())!.trim();
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText(firstName);
	await expect(detail(page)).toBeInViewport();
	await expectNoSidewaysScroll(page);

	// Opened: every unit and source with use or a volume (30 surface + 6 groundwater), in the order to look into
	// them, in place; the page grows, the list doesn't scroll in its card.
	await more.click();
	await expect(units(page)).toHaveCount(36);
	await expect(compareCard(page).getByRole('button', { name: 'Show the 5 to look into first' })).toHaveAttribute('aria-expanded', 'true');
	expect(await innerScrollers(page)).toEqual([]);
	const statuses = (await units(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-status')))) as (keyof typeof RANK)[];
	expect(statuses[0]).toBe('over');
	expect(statuses.map((s) => RANK[s])).toEqual([...statuses.map((s) => RANK[s])].sort((a, b) => a - b));
	await expect(units(page).first()).toContainText(/Above registered in 3 of 3 whole years/);

	// Pick the unit with groundwater too, read far down the opened list: the page brings its detail back into view.
	// Its six water years, both sources, its two volumes; Back returns.
	const farm1 = project.units[0]!;
	const farm1Row = units(page).filter({ hasText: farm1.name }).first();
	await farm1Row.scrollIntoViewIfNeeded();
	await expect(detail(page)).not.toBeInViewport();
	await farm1Row.getByRole('link', { name: farm1.name, exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]unit=${farm1.id}`));
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText(farm1.name);
	await expect(detail(page).getByRole('heading', { level: 2 })).toBeInViewport();
	await expect(detail(page).getByTestId('allocation-unit-years').locator('tbody tr')).toHaveCount(6);
	await expect(detail(page).getByTestId('allocation-unit-bars').getByRole('listitem', { includeHidden: true })).toHaveCount(6);
	// The bars say what they are, and each carries its value: the table's modelled use for that year and source, row for row.
	await expect(detail(page).getByTestId('allocation-unit-bars-caption')).toHaveText('Modelled use per water year (October–September), m³');
	const barValues = await detail(page).getByTestId('allocation-unit-bars').locator('.yv').allInnerTexts();
	const tableModelled = await detail(page).getByTestId('allocation-unit-years').locator('tbody tr').evaluateAll((trs) =>
		trs.map((tr) => {
			const heads = [...tr.closest('table')!.querySelectorAll('thead th')].map((th) => th.textContent!.trim());
			const col = heads.findIndex((h) => h.startsWith('Modelled use'));
			return tr.children[col]!.textContent!.trim();
		})
	);
	expect(barValues.map((v) => v.replace(/\s*m³$/, ''))).toEqual(tableModelled);
	await expect(detail(page).getByText('SYN-G1000', { exact: false })).toBeVisible();
	await expect(detail(page)).toContainText('Invented Holdings 1');
	await expect(detail(page).getByRole('link', { name: `${farm1.name} on the Network` })).toHaveAttribute('href', `?tab=network&node=${farm1.id}`);
	await page.goBack();
	await expect(page).not.toHaveURL(/unit=/);
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText(firstName);

	// A shared link to a unit further down: the folded list keeps its rows (both sources) after the first five,
	// on the first screen, without scrolling the page.
	await openAllocations(page, project.id, `&unit=${farm1.id}`);
	await expect(units(page)).toHaveCount(7);
	await expect(compareCard(page).locator('li.unit.picked')).toHaveCount(2);
	await expect(compareCard(page).locator('li.unit.picked').first()).toBeInViewport();
	expect(await page.evaluate(() => window.scrollY)).toBe(0);

	// + Add volume opens the sheet (`volume=new`); saving adds it and closes the sheet in place.
	await header(page).getByRole('link', { name: '+ Add volume', exact: true }).click();
	await expect(page).toHaveURL(/volume=new/);
	const sheet = page.getByRole('dialog', { name: 'Add a registered volume' });
	await sheet.getByLabel('Hydrological unit or water user').selectOption({ label: farm1.name });
	await sheet.getByLabel('Water source').selectOption('groundwater');
	await sheet.getByLabel('Volume (m³ per year)').fill('12000');
	await sheet.getByLabel('Registration or licence number').fill('SYN-NEW');
	await sheet.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(sheet).toBeHidden();
	await expect(page).not.toHaveURL(/volume=/);
	await expect(header(page).getByTestId('section-context')).toHaveText(/^41 registered volumes/);
	await expect(detail(page)).toContainText('SYN-NEW');

	// Change from the picked unit's list: the sheet holds the volume; Escape closes it, and Back doesn't reopen it.
	await detail(page).getByRole('button', { name: 'Change SYN-NEW', exact: true }).click();
	await expect(page).toHaveURL(/volume=/);
	const change = page.getByRole('dialog', { name: 'Change the registered volume' });
	await expect(change.getByLabel('Volume (m³ per year)')).toHaveValue('12000');
	await expectNoViolations(page);
	await page.keyboard.press('Escape');
	await expect(change).toBeHidden();
	await expect(page).not.toHaveURL(/volume=/);
	await page.goBack();
	await expect(change).toBeHidden();

	// Import opens its sheet from `import=1`, with the template link.
	await openAllocations(page, project.id, '&import=1');
	const imp = page.getByRole('dialog', { name: 'Import registered volumes' });
	await expect(imp.getByRole('link', { name: 'Download the CSV template' })).toBeVisible();
	await imp.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page).not.toHaveURL(/import=/);

	// Below the first screen: the volumes, unmatched first as before, eight until "Show all" (41 since the one added).
	const volRows = volumesCard(page).getByTestId('allocation-list').locator('tbody tr');
	await expect(volRows).toHaveCount(8);
	await expect(volumesCard(page).getByTestId('allocation-list').getByRole('row', { name: /^Not matched/ })).toHaveCount(4);
	const allVols = volumesCard(page).getByRole('button', { name: 'Show all 41 registered volumes' });
	await expect(allVols).toHaveAttribute('aria-controls', 'alloc-vol-table');
	await allVols.click();
	await expect(volRows).toHaveCount(41);
	await expect(volumesCard(page).getByRole('button', { name: 'Show the first 8 registered volumes' })).toHaveAttribute('aria-expanded', 'true');
	// Every unit's water years in the list's order (the first unit's first), folded whole behind "Show all units'
	// water years" (issue #175: the picked unit's table for every unit); the band note sits under the picked unit's.
	const yearRows = page.getByTestId('allocation-compare-table').locator('tbody tr');
	await expect(yearRows).toHaveCount(0);
	await expect(detail(page).getByTestId('allocation-band-note')).toHaveText(/^“Within band” is within ±\d+ % of the registered volume\./);
	const allRows = page.getByRole('button', { name: "Show all units' water years (108 rows)" });
	await expect(allRows).toHaveAttribute('aria-controls', 'alloc-all-years');
	await expect(allRows).toHaveAttribute('aria-expanded', 'false');
	await allRows.click();
	await expect(yearRows).toHaveCount(36 * 3);
	await expect(yearRows.first().getByRole('rowheader')).toHaveText(firstName);
	// What the table carries, and which a fold must keep (issue #175): every unit's name, source and water year, the
	// figures, and the band note.
	await expect(page.getByTestId('allocation-compare-table').getByRole('columnheader')).toHaveText([
		'Hydrological unit or user',
		'Source',
		'Water year',
		'Registered (m³)',
		/^Modelled use \(m³\)/,
		'Modelled ÷ registered',
		'Comparison'
	]);
	await expect(page.getByText(/^“Within band” is within ±\d+ % of the registered volume\./)).toHaveCount(1);
	await expect(page.getByRole('button', { name: "Hide all units' water years" })).toHaveAttribute('aria-expanded', 'true');
	// Every list open, still nothing scrolls inside itself, and no two buttons share a name.
	expect(await innerScrollers(page)).toEqual([]);
	const names = await page.locator('.allocations').getByRole('button').allInnerTexts();
	expect(new Set(names.filter((n) => /^Show /.test(n))).size).toBe(names.filter((n) => /^Show /.test(n)).length);
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'light' });

	// 1280 × 800: nothing scrolls inside itself, and neither the volumes table nor the picked unit's years (cards in
	// its column there) need sideways scroll.
	await page.setViewportSize({ width: 1280, height: 800 });
	expect(await innerScrollers(page)).toEqual([]);
	for (const wrapEl of [volumesCard(page).locator('.table-wrap'), detail(page).locator('.table-wrap')]) {
		const wrap = await wrapEl.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
		expect(wrap.sw).toBeLessThanOrEqual(wrap.cw);
	}
	await expectNoSidewaysScroll(page);

	// A phone: one column, the lists capped until "Show all", no sideways scroll.
	await page.setViewportSize({ width: 390, height: 844 });
	await openAllocations(page, project.id);
	await expect(units(page)).toHaveCount(6);
	await compareCard(page).getByRole('button', { name: 'Show all 36 hydrological units and sources' }).click();
	await expect(units(page)).toHaveCount(36);
	await expect(volumesCard(page).getByTestId('allocation-list').locator('tbody tr')).toHaveCount(8);
	await volumesCard(page).getByRole('button', { name: 'Show all 41 registered volumes' }).click();
	await expect(volumesCard(page).getByTestId('allocation-list').locator('tbody tr')).toHaveCount(41);
	await page.getByRole('button', { name: "Show all units' water years (108 rows)" }).click();
	await expect(page.getByTestId('allocation-compare-table').locator('tbody tr')).toHaveCount(108);
	await expect(page.getByTestId('allocation-compare-table').locator('thead')).toBeHidden();
	expect(await innerScrollers(page)).toEqual([]);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);

	// A viewer: the volumes and the comparison, no names anywhere and nothing to change.
	const viewer = await signIn('Allocations page viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 960 });
	await openAllocations(v, project.id, `&unit=${farm1.id}`);
	await expect(header(v).getByRole('link', { name: 'Download CSV', exact: true })).toBeVisible();
	await expect(header(v).getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);
	await expect(header(v).getByRole('link', { name: '+ Add volume', exact: true })).toHaveCount(0);
	await expect(detail(v)).toContainText('SYN-G1000');
	await expect(detail(v)).not.toContainText('Invented Holdings');
	await expect(detail(v).getByRole('button')).toHaveCount(0);
	await expect(volumesCard(v)).not.toContainText('Invented Holdings');
	await expect(volumesCard(v).getByText('Names of registered users are shown to editors only.')).toBeVisible();
	// A sheet link doesn't open for a viewer.
	await openAllocations(v, project.id, '&volume=new');
	await expect(v.getByRole('dialog')).toHaveCount(0);
	await expectNoViolations(v);
});

test('the run is a link (`run=`), a deleted one falls back and says so; no run and nothing registered say what to do', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Allocations runs');

	// No run yet, nothing registered.
	await openAllocations(page, project.id);
	await expect(header(page).getByTestId('section-context')).toHaveText('No registered volumes yet');
	await expect(page.getByTestId('allocation-compare')).toContainText('Run the model to compare its use with the registered volumes.');
	await expect(page.getByTestId('allocations-empty')).toContainText('No registered volumes yet.');
	await expect(header(page).getByRole('link', { name: 'Download CSV' })).toHaveCount(0);

	const firstRun = await createRun(page.request, project.id, 'First');
	const second = await createRun(page.request, project.id, 'Second');
	await openAllocations(page, project.id);
	// Nothing registered, so each unit's use has no registered volume.
	await expect(units(page).first()).toContainText('No registered volume');
	await expect(units(page).first()).toContainText('Nothing registered');
	const picker = header(page).getByLabel('Run compared');
	await expect(picker).toHaveValue(second);
	await picker.selectOption(firstRun);
	await expect(page).toHaveURL(/[?&]run=/);
	await expect(page.getByTestId('allocation-compare')).toContainText('Run “First”');
	await page.goBack();
	await expect(page.getByTestId('allocation-compare')).toContainText('Run “Second”');

	await openAllocations(page, project.id, '&run=00000000-0000-0000-0000-000000000000');
	await expect(page.getByRole('note').filter({ hasText: 'That run no longer exists' })).toBeVisible();
	await expect(page.getByTestId('allocation-compare')).toContainText('Run “Second”');
	await expectNoViolations(page);
});

test('a long run: the picked unit shows its latest six water years until "Show all"; nothing scrolls inside a card', async ({ page, owner }) => {
	test.setTimeout(90_000);
	void owner;
	// Three units over nine whole water years; the first has groundwater too (both sources a year).
	const project = await seedManyAllocations(page.request, 'Allocations long run', { farms: 3, days: 9 * 365 + 2, unmatched: 0 });
	const farm1 = project.units[0]!;
	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 960 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		await page.setViewportSize(viewport);
		await openAllocations(page, project.id, `&unit=${farm1.id}`);
		const years = detail(page).getByTestId('allocation-unit-years').locator('tbody tr');
		const bars = detail(page).getByTestId('allocation-unit-bars').getByRole('listitem', { includeHidden: true });
		await expect(years, label).toHaveCount(12);
		await expect(bars, label).toHaveCount(12);
		// The latest six: the oldest shown is 2022/23 of 2019/20 … 2027/28.
		await expect(bars.first()).toContainText('2022/23');
		const all = detail(page).getByRole('button', { name: 'Show all 9 water years' });
		await expect(all).toHaveAttribute('aria-expanded', 'false');
		await expect(all).toHaveAttribute('aria-controls', 'alloc-unit-years');
		expect(await innerScrollers(page)).toEqual([]);
		await all.click();
		await expect(years).toHaveCount(18);
		await expect(bars).toHaveCount(18);
		await expect(bars.first()).toContainText('2019/20');
		const fewer = detail(page).getByRole('button', { name: 'Show the latest 6 water years' });
		await expect(fewer).toHaveAttribute('aria-expanded', 'true');
		expect(await innerScrollers(page)).toEqual([]);
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
		await fewer.click();
		await expect(years).toHaveCount(12);
	}
});

test('the over/under-use chart: every unit and source with a volume in the list’s order, ten until "Show all", described by the years above the band; px for px on a phone', async ({ page, owner }) => {
	test.setTimeout(120_000);
	void owner;
	const project = await seedManyAllocations(page.request, 'Allocations chart');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openAllocations(page, project.id);
	const plot = page.getByTestId('allocation-use-plot');
	const svg = plot.getByRole('img', { name: /^Modelled use as a share of the registered volume, per hydrological unit and water source/ });
	const labels = plot.locator('svg text.lbl');
	const marks = plot.locator('svg .mark');

	// Every unit here has a volume, so the chart follows the list: its first ten, in the list's order.
	await expect(labels).toHaveCount(10);
	await compareCard(page).getByRole('button', { name: 'Show all 36 hydrological units and sources' }).click();
	const listed = await units(page).evaluateAll((els) =>
		els.map((el) => `${el.querySelector('.name')!.textContent!.trim()}, ${el.querySelector('.src')!.textContent!.trim().toLowerCase()}`)
	);
	// What each label draws (its own text, not its tooltip's) and its tooltip, the full label.
	const drawn = await labels.evaluateAll((ts) =>
		ts.map((t) => ({ text: [...t.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(''), full: t.querySelector('title')!.textContent }))
	);
	expect(drawn.map((d) => d.full)).toEqual(listed.slice(0, 10));
	// A long name is cut with "…" to fit its column, keeping the source whole; the full name is in the table.
	drawn.forEach((d, i) => {
		const [head, tail] = d.text.split('…');
		expect(listed[i]!.startsWith(head!)).toBe(true);
		if (tail !== undefined) expect(listed[i]!.endsWith(tail)).toBe(true);
		expect(d.text).toMatch(/, (surface water|groundwater)$/);
	});
	// Each mark's tooltip names its year and share.
	await expect(marks.first().locator('title')).toHaveText(/^\d{4}\/\d{2}: .*% of the registered volume$/);
	await expect(marks).toHaveCount(10 * 3);
	// Folded, the description still counts every row, and says how many are drawn.
	await expect(svg).toHaveAccessibleDescription(/ in \d+ of 36 units and water sources\. The chart draws the first 10 of 36 units and water sources\.$/);
	await expect(plot).toContainText('Modelled, not metered.');
	await expect(plot.locator('figcaption')).toContainText(/the shaded band ±\d+\s%/);

	// Show all: every unit and source (30 surface + 6 groundwater), three whole years each; the small volumes (every
	// seventh unit) are far past the axis, an arrowhead at its edge.
	const all = page.getByRole('button', { name: 'Show all 36 in the chart' });
	await expect(all).toHaveAttribute('aria-controls', 'alloc-use-plot');
	await expect(all).toHaveAttribute('aria-expanded', 'false');
	await all.click();
	await expect(labels).toHaveCount(36);
	await expect(marks).toHaveCount(36 * 3);
	expect(await plot.locator('svg path.mark').count()).toBeGreaterThan(0);
	await expect(page.getByRole('button', { name: 'Show the first 10 in the chart' })).toHaveAttribute('aria-expanded', 'true');

	// The description counts the years above the band: the same count as the table's "Above registered" rows.
	await page.getByRole('button', { name: "Show all units' water years (108 rows)" }).click();
	// A part year can be above too, but isn't drawn or counted (this seed has none: every year is whole).
	const aboveRows = page.getByTestId('allocation-compare-table').locator('tbody tr').filter({ hasText: 'Above registered' }).filter({ hasNotText: 'part (' });
	const above = await aboveRows.count();
	expect(above).toBeGreaterThan(0);
	const unitsAbove = new Set(
		await aboveRows.evaluateAll((trs) => trs.map((tr) => `${tr.children[0]!.textContent!.trim()}:${tr.children[1]!.textContent!.trim()}`))
	).size;
	await expect(svg).toHaveAccessibleDescription(
		new RegExp(`^${above} of 108 whole water years are above the ±\\d+\\s% band \\(over \\d+\\s% of the registered volume\\), in ${unitsAbove} of 36 units and water sources\\.$`)
	);
	expect(await innerScrollers(page)).toEqual([]);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'light' });

	// Drawn px for px at its box's width, so its text stays 11 px: at 1440, and on a phone, where each label takes
	// its own line above its marks.
	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 960 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		await page.setViewportSize(viewport);
		const figure = plot.getByTestId('use-plot');
		await expect
			.poll(() => figure.evaluate((f) => Math.abs(Number(f.getAttribute('data-width')) - Math.round(f.clientWidth))), { message: label })
			.toBeLessThanOrEqual(1);
		const smallest = await plot.locator('svg text').evaluateAll((ts) => Math.min(...ts.map((t) => t.getBoundingClientRect().height)));
		expect(smallest, label).toBeGreaterThanOrEqual(11);
		const firstLabel = await labels.first().boundingBox();
		const firstMark = await marks.first().boundingBox();
		if (label === 'phone') expect(firstMark!.y).toBeGreaterThan(firstLabel!.y + firstLabel!.height - 1);
		else expect(firstMark!.x).toBeGreaterThan(firstLabel!.x + firstLabel!.width);
		// Nothing runs through a label: neither the 100 % line nor the band crosses one.
		const crossings = await plot.locator('svg').evaluate((svg) => {
			const boxes = (sel: string) => [...svg.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
			const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
			const lbls = boxes('text.lbl');
			return [...boxes('line.hundred'), ...boxes('rect.band')].filter((r) => lbls.some((l) => hit(r, l))).length;
		});
		expect(crossings, label).toBe(0);
		await expectNoSidewaysScroll(page);
	}
	await expectNoViolations(page);
});
