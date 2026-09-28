// Help's subpages in the app frame (issue #17): the glossary, search and one
// guide. They are reading pages: one title under a breadcrumb, the text in a
// readable column beside the help contents, the page scrolling only when the
// text is longer than the window.
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

test('a guide heads its page with a breadcrumb back to help', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/guides/add-a-transfer');
	const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
	await expect(crumbs.getByRole('listitem')).toHaveText(['Help', 'How to', 'Add a transfer']);
	await expect(crumbs.getByRole('link')).toHaveText(['Help']);
	await expect(crumbs.getByRole('link', { name: 'Help' })).toHaveAttribute('href', /\/help$/);
	await expect(crumbs.getByRole('listitem').last()).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Add a transfer']);
});

const SUBPAGES = [
	{ path: '/help/glossary', title: 'Glossary', crumbs: ['Help', 'Reference', 'Glossary'] },
	{ path: '/help/search?q=dam', title: 'Search help', crumbs: ['Help', 'Search'] },
	{
		path: '/help/guides/how-calibration-works',
		title: 'How calibration works',
		crumbs: ['Help', 'How it works', 'How calibration works']
	},
	{ path: '/help/guides/no-such-guide', title: 'Guide not found', crumbs: ['Help'] }
];

test('every help subpage has one title, the same size and height, under its breadcrumb', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const seen: { top: number; size: string }[] = [];
	for (const p of SUBPAGES) {
		await page.goto(p.path);
		const h1 = page.getByRole('heading', { level: 1 });
		await expect(h1).toHaveText([p.title]);
		await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('listitem')).toHaveText(p.crumbs);
		seen.push({ top: (await h1.boundingBox())!.y, size: await h1.evaluate((el) => getComputedStyle(el).fontSize) });
	}
	for (const s of seen.slice(1)) {
		expect(s.size).toBe(seen[0]!.size);
		expect(Math.abs(s.top - seen[0]!.top)).toBeLessThanOrEqual(1);
	}
});

test('a help page that fits the window does not scroll, and the contents column fits it too', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	for (const path of ['/help/search', '/help/search?q=zzzz', '/help/guides/no-such-guide']) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		const m = await page.evaluate(() => ({
			scroll: document.documentElement.scrollHeight - innerHeight,
			side: document.querySelector('aside[aria-label="Help contents"]')!.getBoundingClientRect().bottom - innerHeight
		}));
		expect(m.scroll, path).toBeLessThanOrEqual(0);
		expect(m.side, path).toBeLessThanOrEqual(0);
	}
});

test('search results sit in columns, with the glossary terms on the first screen at 1440', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto('/help/search?q=dam');
	const terms = page.getByRole('region', { name: 'Glossary' });
	await expect(terms.getByRole('listitem').first()).toBeVisible();
	const xs = new Set(
		await terms.getByRole('listitem').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)))
	);
	expect(xs.size).toBeGreaterThanOrEqual(2);
	await expect(terms.getByRole('heading', { name: 'Glossary' })).toBeInViewport();
});

test('on a phone the search results stack, and a jump link reaches the glossary terms', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/help/search?q=dam');
	const heading = page.getByRole('heading', { level: 2, name: 'Glossary' });
	await expect(heading).not.toBeInViewport();
	await page
		.getByRole('navigation', { name: 'Search results' })
		.getByRole('link', { name: /^Glossary terms \(\d+\)$/ })
		.click();
	await expect(page).toHaveURL(/\/help\/search\?q=dam#res-terms$/);
	await expect(heading).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);

	// Nothing found: no jump links.
	await page.goto('/help/search?q=zzzz');
	await expect(page.getByText('Nothing matches.')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Search results' })).toHaveCount(0);
});

test('a guide’s "On this page" marks the section being read', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto('/help/guides/how-calibration-works');
	const onPage = page.getByRole('navigation', { name: 'On this page' });
	const marked = onPage.locator('a[aria-current="location"]');
	// The intro is in view: nothing is marked yet.
	await expect(page.getByRole('heading', { level: 1, name: 'How calibration works' })).toBeInViewport();
	await expect(onPage.getByRole('link')).toHaveCount(3);
	await expect(marked).toHaveCount(0);

	await onPage.getByRole('link', { name: 'The search' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'The search' })).toBeInViewport();
	await expect(marked).toHaveText(['The search']);
	// The rail stays in view beside the text.
	await expect(onPage).toBeInViewport();

	// At the end of the page, the last section.
	// Scrolled there directly: Chromium's animated End/Home keyboard scroll
	// sometimes ignores a Home pressed after End (2 runs in 20, no key
	// handler in the app), and what this checks is the marker, not the keys.
	await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
	await expect(marked).toHaveText(['Validation: the honest measure']);
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
	await expect(marked).toHaveCount(0);
});

test('a link to one section of a guide lands on it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/help/guides/how-calibration-works#the-search');
	const heading = page.getByRole('heading', { level: 2, name: 'The search' });
	await expect(heading).toBeFocused();
	await expect(heading).toBeInViewport();
	await expect(page.getByRole('navigation', { name: 'On this page' }).locator('a[aria-current="location"]')).toHaveText([
		'The search'
	]);
});

for (const colorScheme of ['light', 'dark'] as const) {
	for (const [size, viewport] of [
		['desktop', { width: 1280, height: 800 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		test.describe(`${colorScheme}, ${size}`, () => {
			test.use({ colorScheme, viewport });
			test('the help subpages have no accessibility violations', async ({ page, owner }) => {
				void owner;
				test.setTimeout(60_000);
				for (const p of SUBPAGES) {
					await page.goto(p.path);
					await expect(page.getByRole('heading', { level: 1, name: p.title })).toBeVisible();
					await expectNoViolations(page);
				}
			});
		});
	}
}
