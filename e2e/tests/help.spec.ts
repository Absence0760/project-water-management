import type { Locator, Page } from '@playwright/test';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// Every sampled point inside the bubble hits the bubble itself: nothing (a
// sticky table header, a scroll container's edge) covers or clips it.
async function expectOnTop(page: Page, bubble: Locator) {
	const box = await bubble.boundingBox();
	expect(box).not.toBeNull();
	const vp = page.viewportSize()!;
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.y).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
	expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
	const covered = await bubble.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const pts: [number, number][] = [
			[r.left + 4, r.top + 4],
			[r.right - 4, r.top + 4],
			[r.left + 4, r.bottom - 4],
			[r.right - 4, r.bottom - 4],
			[r.left + r.width / 2, r.top + r.height / 2]
		];
		return pts.filter(([x, y]) => !el.contains(document.elementFromPoint(x, y)));
	});
	expect(covered).toEqual([]);
}

test('a help tip in the network table opens on top, unclipped, and closes on Escape or outside click', async ({
	page,
	owner
}) => {
	void owner;
	await page.setViewportSize({ width: 900, height: 700 });
	const project = await createProject(page.request, 'Help tips');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);

	const tip = page.getByRole('columnheader', { name: /^Kind/ }).getByRole('button');
	const bubble = page.locator('.bubble:popover-open');

	await tip.click();
	await expect(tip).toHaveAttribute('aria-expanded', 'true');
	await expect(bubble).toBeVisible();
	await expect(bubble.getByRole('link', { name: 'More in the glossary' })).toBeVisible();
	// A farm term shows the farm close-up, loaded, and the bubble still fits on screen with it.
	const pic = bubble.locator('img');
	await expect(pic).toBeVisible();
	await expect.poll(() => pic.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
	await expectOnTop(page, bubble);

	await page.keyboard.press('Escape');
	await expect(bubble).toHaveCount(0);
	await expect(tip).toHaveAttribute('aria-expanded', 'false');
	await expect(tip).toBeFocused();

	await tip.click();
	await expect(bubble).toBeVisible();
	// Somewhere outside the bubble: the node table's own title (the page behind the grid is inert).
	await page.getByRole('dialog', { name: 'Node table' }).getByRole('heading', { name: 'Node table' }).click();
	await expect(bubble).toHaveCount(0);

	// "More in the glossary" lands on the term's entry.
	await tip.click();
	await bubble.getByRole('link', { name: 'More in the glossary' }).click();
	await expect(page).toHaveURL(/\/help\/glossary\/network#element-farm$/);
	await expect(page.getByRole('article', { name: 'Hydrological unit', exact: true })).toBeInViewport();
});

test('a help tip works from the keyboard alone and is announced to screen readers', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Help tip keys');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);

	const tip = page.getByRole('button', { name: 'About capacity', exact: true }).first();
	const controls = (await tip.getAttribute('aria-controls'))!;
	const live = page.locator(`[id="${controls}"]`);
	await expect(live).toHaveAttribute('role', 'status');
	await expect(live).toHaveAttribute('aria-live', 'polite');
	await expect(live).toBeEmpty();
	await expect(tip).toHaveAttribute('aria-expanded', 'false');
	await expect(tip).not.toHaveAttribute('aria-describedby');

	// Enter opens: the text lands in the live region and describes the button.
	await tip.focus();
	await page.keyboard.press('Enter');
	await expect(tip).toHaveAttribute('aria-expanded', 'true');
	await expect(tip).toHaveAttribute('aria-describedby', controls);
	await expect(live.locator('.term')).toHaveText('Dam capacity');
	await expect(live.locator('.short')).toHaveText(
		'Combined full-supply volume of the hydrological unit’s dams, in m³. 0 means no storage: water not used the same day flows on.'
	);
	await expect(live.locator('.units')).toHaveText('Units: m³');

	// Space toggles it shut and open again, focus staying on the button.
	await page.keyboard.press('Space');
	await expect(tip).toHaveAttribute('aria-expanded', 'false');
	await expect(live).toBeEmpty();
	await page.keyboard.press('Space');
	await expect(tip).toHaveAttribute('aria-expanded', 'true');

	// Tab reaches the glossary link inside the bubble; Escape from there closes and returns focus.
	await page.keyboard.press('Tab');
	await expect(live.getByRole('link', { name: 'More in the glossary' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(live).toBeEmpty();
	await expect(tip).toBeFocused();
	await expect(tip).toHaveAttribute('aria-expanded', 'false');

	// Tabbing out of an open tip closes it.
	await page.keyboard.press('Enter');
	await expect(tip).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Tab');
	await expect(tip).toHaveAttribute('aria-expanded', 'false');
	await expect(live).toBeEmpty();
});

test('neighbouring help tips show their own close-up, with their feature ringed', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Help tip pictures');
	await putModel(page.request, project.id, sampleModel());
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);

	const seen: { src: string; ring: { left: string; top: string } }[] = [];
	for (const name of ['About capacity', 'About runoff to dam', 'About upstream inflow to dam']) {
		await page.getByRole('button', { name, exact: true }).first().click();
		const bubble = page.locator('.bubble');
		const ring = bubble.locator('.ring');
		await expect(ring).toBeVisible();
		seen.push({
			src: (await bubble.locator('img').getAttribute('src'))!,
			ring: await ring.evaluate((r) => ({ left: (r as HTMLElement).style.left, top: (r as HTMLElement).style.top }))
		});
		await page.keyboard.press('Escape');
		await expect(bubble).toHaveCount(0);
	}
	// Capacity shows the dam; the two inflow tips share the inflow close-up but ring different features.
	expect(seen[0]!.src).toContain('/help/dam-');
	expect(seen[1]!.src).toContain('/help/inflow-');
	expect(seen[2]!.src).toBe(seen[1]!.src);
	expect(seen[2]!.ring).not.toEqual(seen[1]!.ring);
});

test('the help contents: groups under headings, the glossary one link per topic (issue #162)', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/help/glossary');
	const nav = page.getByRole('navigation', { name: 'Help' });

	// Each group's name is a heading, not a link, and names its list of links;
	// the group holding the page you're on is the one open.
	await expect(nav.getByRole('heading', { level: 2 })).toHaveText(['Start here', 'How it works', 'How to', 'Reference']);
	await expect(nav.getByRole('link', { name: /^(Start here|How it works|How to|Reference)$/i })).toHaveCount(0);
	await expect(nav.getByRole('button', { name: 'Reference' })).toHaveAttribute('aria-expanded', 'true');
	const reference = nav.getByRole('list', { name: 'Reference' });
	const topics = page.getByRole('main').getByRole('heading', { level: 2 });
	const names = (await topics.allTextContents()).map((t) => t.trim());
	expect(names.length).toBeGreaterThan(5);
	await expect(reference.getByRole('link')).toHaveText(['Glossary', ...names]);
	await expect(reference.getByRole('link', { name: 'Glossary', exact: true })).toHaveAttribute('aria-current', 'page');

	// The search heads the page, above the text (not in the contents column, issue #17).
	const search = await page.getByRole('searchbox', { name: 'Search help' }).boundingBox();
	const main = await page.getByRole('main').boundingBox();
	expect(search!.y).toBeLessThan(main!.y);
	expect(search!.x).toBeGreaterThanOrEqual(main!.x - 1);

	// A topic is a page of its own, marked in the contents; the contents don't
	// change as the page scrolls (no term list in them).
	const last = names.at(-1)!;
	await reference.getByRole('link', { name: last, exact: true }).click();
	await expect(page.getByRole('heading', { level: 1, name: last })).toBeVisible();
	await expect(reference.getByRole('link', { name: last, exact: true })).toHaveAttribute('aria-current', 'page');
	const before = await nav.getByRole('link').count();
	await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
	await expect(nav.getByRole('link')).toHaveCount(before);
	await expect(nav.getByRole('link', { name: last, exact: true })).toBeInViewport();
});

test('a glossary topic spans the help column, with "On this page" pinned to its right edge', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/help/glossary/goodness-of-fit');
	await expect(page.getByRole('heading', { level: 1, name: 'Goodness of fit' })).toBeVisible();
	const onPage = page.getByRole('navigation', { name: 'On this page' });
	const col = (await page.locator('.help-main').boundingBox())!;
	const rail = (await onPage.boundingBox())!;
	expect(Math.abs(rail.x + rail.width - (col.x + col.width))).toBeLessThanOrEqual(2);
	// The rail lists this topic's terms; a term link lands on its entry and marks it.
	const names = (await page.getByRole('main').getByRole('article').locator('h2 > span').allTextContents()).map((t) => t.trim());
	await expect(onPage.getByRole('link')).toHaveText(names);
	const term = names.at(-3)!;
	await onPage.getByRole('link', { name: term, exact: true }).click();
	await expect(page.getByRole('article', { name: term, exact: true })).toBeInViewport();
	await expect(onPage.locator('a[aria-current="location"]')).toHaveText([term]);
	await expect(onPage).toBeInViewport();
});

// A 44rem text measure left half the help column empty beside full-width
// figures (operator, 2026-09-30): a guide's and a glossary topic's text runs
// to the "On this page" rail, as the column's figures do.
for (const { path, heading, text } of [
	{ path: '/help/guides/the-whole-process', heading: 'The whole process, from catchment to results', text: 'ol.steps' },
	{ path: '/help/glossary/goodness-of-fit', heading: 'Goodness of fit', text: 'article.entry p.short' }
]) {
	test(`${path}: the text spans the help column up to the rail`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
		const rail = (await page.getByRole('navigation', { name: 'On this page' }).boundingBox())!;
		const block = (await page.locator(text).first().boundingBox())!;
		// The text's box ends at the rail's 2.5rem gap, not 44rem in.
		expect(rail.x - (block.x + block.width)).toBeLessThanOrEqual(42);
	});
}

// All four groups open made the sticky contents column ~1180 px tall, so it
// scrolled inside itself at 1440×960 and 1280×800. One group opens at a time
// (the current page's), and the column fits both windows with any one open.
for (const viewport of [
	{ width: 1440, height: 960 },
	{ width: 1280, height: 800 }
]) {
	test(`the help contents fit a ${viewport.width}×${viewport.height} window without scrolling, every page reachable by keyboard`, async ({
		page,
		owner
	}) => {
		void owner;
		await page.setViewportSize(viewport);
		const side = page.getByRole('complementary', { name: 'Help contents' });
		const nav = side.getByRole('navigation', { name: 'Help' });
		const fits = async (where: string) => {
			const m = await side.evaluate((el) => ({ over: el.scrollHeight - el.clientHeight, bottom: el.getBoundingClientRect().bottom }));
			expect(m.over, where).toBeLessThanOrEqual(0);
			expect(m.bottom, where).toBeLessThanOrEqual(viewport.height);
		};

		// A page in each group opens that group, marks the page, and fits.
		for (const [path, group] of [
			['/help/guides/the-whole-process', 'Start here'],
			['/help/guides/how-calibration-works', 'How it works'],
			['/help/guides/add-a-transfer', 'How to'],
			['/help/glossary/input-data', 'Reference']
		] as const) {
			await page.goto(path);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			await expect(nav.getByRole('button', { name: group })).toHaveAttribute('aria-expanded', 'true');
			await expect(nav.getByRole('button', { expanded: true })).toHaveCount(1);
			await expect(nav.locator('a[aria-current="page"]')).toBeVisible();
			await fits(path);
		}

		// From the overview, the keyboard opens each group in turn (closing the
		// last) and reaches its first page; together they list every guide and topic.
		await page.goto('/help');
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		const seen = new Set<string>();
		for (const group of ['Start here', 'How it works', 'How to', 'Reference']) {
			const button = nav.getByRole('button', { name: group });
			await button.focus();
			await page.keyboard.press('Enter');
			await expect(button).toHaveAttribute('aria-expanded', 'true');
			await expect(nav.getByRole('button', { expanded: true })).toHaveCount(1);
			const list = nav.getByRole('list', { name: group });
			const links = list.getByRole('link');
			await page.keyboard.press('Tab');
			await expect(links.first()).toBeFocused();
			for (const href of await links.evaluateAll((els) => els.map((a) => a.getAttribute('href')!))) seen.add(href);
			await fits(`/help, ${group} open`);
		}
		// Every link in the contents (hidden ones included) but the overview's.
		const all = await nav.locator('ul.links a').evaluateAll((els) => els.map((a) => a.getAttribute('href')!));
		expect(all.length).toBeGreaterThan(25);
		expect([...seen].sort()).toEqual([...all].sort());
	});
}

test('on a phone the help contents fold behind a button above the page', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto('/help');
	const toggle = page.getByRole('button', { name: 'Help contents' });
	const nav = page.getByRole('navigation', { name: 'Help' });
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(nav).toBeHidden();
	const toggleBox = (await toggle.boundingBox())!;
	const h1Box = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
	expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(h1Box.y);

	await toggle.click();
	await expect(nav).toBeVisible();
	// One group's pages at a time here too: open How to, then pick a page.
	await nav.getByRole('button', { name: 'How to' }).click();
	await nav.getByRole('link', { name: 'Add a transfer' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Add a transfer' })).toBeVisible();
	// Choosing a page folds the contents away again.
	await expect(nav).toBeHidden();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('the catchment tour links each picture marker to its stop', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/help');
	await expect(page.getByRole('img', { name: /An illustrated catchment/ })).toBeVisible();
	const stops = page.getByRole('main').getByRole('list').filter({ has: page.getByRole('heading', { name: 'Rain falls on the catchment' }) });
	await expect(stops.getByRole('heading', { level: 3 })).toHaveCount(8);

	// The markers are the pointer shortcut (hidden from assistive tech: the list is the text).
	await page.locator('.marker', { hasText: '5' }).click();
	const irrigation = stops.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Crops are irrigated from the dams' }) });
	await expect(irrigation).toHaveClass(/\bon\b/);
	await expect(page.locator('.marker', { hasText: '5' })).toHaveClass(/\bon\b/);

	// "Show more" opens a stop in place: its close-up and key points; "Show less" folds it.
	const dam = stops.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Dams catch part of it' }) });
	const more = page.getByRole('button', { name: 'Show more: Dams catch part of it' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(dam.getByRole('img', { name: /Close-up of one farm/ })).toBeHidden();
	await more.click();
	const less = page.getByRole('button', { name: 'Show less: Dams catch part of it' });
	await expect(less).toHaveAttribute('aria-expanded', 'true');
	await expect(dam.getByRole('img', { name: /Close-up of one farm/ })).toBeVisible();
	await expect(dam.getByText('Every hydrological unit’s daily balance closes to the cubic metre.')).toBeVisible();
	await less.click();
	await expect(dam.getByRole('img', { name: /Close-up of one farm/ })).toBeHidden();

	// The rain stop opens on a diagram instead of a close-up.
	await page.getByRole('button', { name: 'Show more: Rain falls on the catchment' }).click();
	await expect(page.getByRole('img', { name: /Each day takes the first series that has a value/ })).toBeVisible();

	await irrigation.getByRole('link', { name: /Set up crops and irrigation demand/ }).click();
	await expect(page).toHaveURL(/\/help\/guides\/set-up-crops-and-demand$/);
});

test('a guide shows a close-up of the catchment with its own numbered stops', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/guides/a-day-on-a-farm');
	const figure = page.getByRole('figure').filter({ has: page.getByRole('img', { name: /Close-up of one farm/ }) });
	await expect(figure.getByRole('img', { name: /Close-up of one farm/ })).toBeVisible();
	await expect(figure.getByRole('heading', { level: 3 })).toHaveText([
		'Inflow from upstream',
		'The hydrological unit’s own runoff',
		'Dam storage',
		'Spill over the wall',
		'Irrigation draw',
		'The crops',
		'Transfer to a neighbour',
		'Outflow'
	]);
	await expect(page.locator('.marker')).toHaveCount(8);
});

test('a guide shows its diagrams and links into the glossary', async ({ page, owner }) => {
	void owner;
	await page.goto('/help');
	await page.getByRole('region', { name: 'Understand the model' }).getByRole('link', { name: 'How calibration works' }).click();

	await expect(page).toHaveURL(/\/help\/guides\/how-calibration-works$/);
	await expect(page.getByRole('heading', { level: 1, name: 'How calibration works' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Help' }).getByRole('link', { name: 'How calibration works' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(page.getByRole('img', { name: /DDS perturbs fewer parameters/ })).toBeVisible();
	await expect(page.getByRole('img', { name: /dry to wet test fits on the four driest years/ })).toBeVisible();

	// "On this page" jumps to a section.
	await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Validation: the honest measure' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Validation: the honest measure' })).toBeInViewport();

	// A term link lands on its glossary entry.
	await page.getByRole('region', { name: 'Terms in this guide' }).getByRole('link', { name: 'Fit record' }).click();
	await expect(page).toHaveURL(/\/help\/glossary\/goodness-of-fit#fit-record$/);
	await expect(page.getByRole('article', { name: 'Fit record' })).toBeInViewport();
});

test('help search finds guides and glossary terms as you type', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/guides/how-gr4j-works');
	const box = page.getByRole('searchbox', { name: 'Search help' });
	await box.fill('transfer');
	await expect(page).toHaveURL(/\/help\/search\?q=transfer$/);
	await expect(box).toBeFocused();
	await expect(page.getByRole('status')).toContainText('match “transfer”');
	await expect(page.getByRole('region', { name: 'Guides' }).getByRole('link', { name: 'Add a transfer' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Glossary' }).getByRole('link', { name: 'Transfer', exact: true })).toBeVisible();

	await box.fill('zzzz');
	await expect(page.getByText('Nothing matches.')).toBeVisible();
});

test('old links to a term (/help#term, the one-page /help/glossary#term) go on to its topic page', async ({ page, owner }) => {
	void owner;
	await page.goto('/help#nse');
	await expect(page).toHaveURL(/\/help\/glossary\/goodness-of-fit#nse$/);
	await expect(page.getByRole('article', { name: /^NSE/ })).toBeInViewport();
	await expect(page.getByRole('article', { name: /^NSE/ })).toBeFocused();

	await page.goto('/help/glossary#spill');
	await expect(page).toHaveURL(/\/help\/glossary\/units-and-dams#spill$/);
	await expect(page.getByRole('article', { name: 'Spill', exact: true })).toBeInViewport();

	// A term linked under the wrong topic goes on to its own.
	await page.goto('/help/glossary/basics#nse');
	await expect(page).toHaveURL(/\/help\/glossary\/goodness-of-fit#nse$/);
	await expect(page.getByRole('article', { name: /^NSE/ })).toBeInViewport();
});

test('an unknown glossary topic says so and links to every topic', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/glossary/no-such-topic');
	await expect(page.getByRole('heading', { level: 1, name: 'Topic not found' })).toBeVisible();
	await page.getByRole('main').getByRole('link', { name: 'See every topic' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Glossary' })).toBeVisible();
});

test('the glossary lists every term by topic, as many as the help page counts, and shows each in full', async ({ page, owner }) => {
	void owner;
	await page.goto('/help');
	const link = page.getByRole('main').getByRole('link', { name: /^Glossary, \d+ terms/ });
	const count = Number((await link.textContent())!.match(/(\d+) terms/)![1]);
	expect(count).toBeGreaterThan(100);
	await link.click();
	await expect(page).toHaveURL(/\/help\/glossary$/);
	// The index: every topic, with its terms (each links to its entry).
	const topics = page.getByRole('main').getByRole('heading', { level: 2 });
	await expect(page.getByRole('main').getByRole('list', { name: /^Terms in / }).getByRole('link')).toHaveCount(count);
	let total = 0;
	for (const name of (await topics.allTextContents()).map((t) => t.trim())) {
		await page.goto('/help/glossary');
		await page.getByRole('main').getByRole('heading', { level: 2, name }).getByRole('link').click();
		await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
		total += await page.getByRole('main').getByRole('article').count();
	}
	expect(total).toBe(count);

	// One entry, every part: the short text, the fuller text, units, other
	// names and related terms (linked). Not where the idea comes from: that
	// names developer documents (docs/model.md, issues), kept in the data only.
	await page.goto('/help/glossary/units-and-dams');
	const dam = page.getByRole('article', { name: 'Dam capacity' });
	await expect(dam.locator('.short')).toHaveText(
		'Combined full-supply volume of the hydrological unit’s dams, in m³. 0 means no storage: water not used the same day flows on.'
	);
	await expect(dam.locator('.long')).toHaveText([/^b023 treats a hydrological unit’s dams as one composite dam\./]);
	await expect(dam.getByRole('term')).toHaveText(['Units', 'Also called', 'See also']);
	await expect(dam.getByRole('definition')).toHaveText(['m³', 'composite dam, storage capacity, full supply', /Spill/]);
	await expect(page.getByRole('main').getByRole('term').filter({ hasText: 'Source' })).toHaveCount(0);
	await expect(page.getByRole('main')).not.toContainText('docs/');
	await dam.getByRole('link', { name: 'Spill', exact: true }).click();
	await expect(page).toHaveURL(/\/help\/glossary\/units-and-dams#spill$/);
	await expect(page.getByRole('article', { name: 'Spill', exact: true })).toBeInViewport();
});

test('the farm glossary shows the glossary’s farmer words and jumps to the one linked', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/glossary/farm-page-words');
	const topic = page.getByRole('main');
	await expect(topic.getByRole('article').first()).toBeVisible();
	const terms = (await topic.getByRole('article').locator('h2 > span').allTextContents()).map((t) => t.trim());
	expect(terms.length).toBeGreaterThan(0);

	await page.goto('/farm/words#farm-reserve');
	const cards = page.getByRole('main').getByRole('region');
	await expect(cards.getByRole('heading', { level: 2 })).toHaveText(terms);
	await expect(page.locator('section#farm-reserve')).toBeInViewport();
});

test('an unknown guide says so and links back to help', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/guides/no-such-guide');
	await expect(page.getByRole('heading', { level: 1, name: 'Guide not found' })).toBeVisible();
	await expect(page.getByRole('main').getByRole('link', { name: 'See all guides and the glossary' })).toBeVisible();
});

test('the glossary says which entries apply only in South Africa (issue #76)', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/glossary/natural-flow#wr2012-check');
	const wr2012 = page.getByRole('article', { name: 'WR2012 check' });
	await expect(wr2012.getByRole('term').filter({ hasText: 'Applies in' })).toBeVisible();
	await expect(wr2012.getByRole('definition').filter({ hasText: /^South Africa$/ })).toBeVisible();
	// An entry that holds anywhere says nothing about a country.
	await page.goto('/help/glossary/basics');
	await expect(page.getByRole('article', { name: 'Water balance', exact: true }).getByRole('term').filter({ hasText: 'Applies in' })).toHaveCount(0);
});
