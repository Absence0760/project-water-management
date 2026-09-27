// The split sign-in / register layout (AuthCard) under `html { overflow-y:
// scroll }` (app.css): the always-on scrollbar takes width from the viewport,
// so check the layout still fits beside it, the brand panel still fills the
// height, and the scrollbar gutter takes the form side's colour rather than
// showing as a strip. Each case saves a screenshot to its test-results folder
// (and the report) for a visual check.
import { expect, test } from '@playwright/test';

// Headless Chromium hides scrollbars (--hide-scrollbars) and macOS draws overlay
// ones that take no width, either of which would make this check vacuous. So
// keep scrollbars on, and style them: a styled ::-webkit-scrollbar is a
// classic, space-taking one, as on Windows or Linux desktops.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });
const CLASSIC_SCROLLBAR = '::-webkit-scrollbar { width: 15px; height: 15px } ::-webkit-scrollbar-thumb { background: #8a8f98 }';

const SIZES = [
	{ name: 'desktop', viewport: { width: 1440, height: 900 } },
	{ name: 'phone', viewport: { width: 390, height: 844 } }
] as const;

for (const size of SIZES) {
	for (const colorScheme of ['light', 'dark'] as const) {
		test.describe(`${size.name}, ${colorScheme}`, () => {
			test.use({ viewport: size.viewport, colorScheme });

			for (const path of ['/login', '/register']) {
				test(`${path} fits the viewport beside a classic scrollbar`, async ({ page }, testInfo) => {
					await page.goto(path);
					await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
					await page.addStyleTag({ content: CLASSIC_SCROLLBAR });

					const m = await page.evaluate(() => {
						const html = document.documentElement;
						const form = document.querySelector('.side-form')!;
						const brand = document.querySelector('.panel-brand')!.getBoundingClientRect();
						return {
							overflowY: getComputedStyle(html).overflowY,
							scrollWidth: html.scrollWidth,
							clientWidth: html.clientWidth,
							htmlBg: getComputedStyle(html).backgroundColor,
							formBg: getComputedStyle(form).backgroundColor,
							brand: { top: brand.top, height: brand.height, width: brand.width },
							innerHeight,
							innerWidth
						};
					});
					expect(m.overflowY).toBe('scroll');
					// The scrollbar is really there, taking its 15 px…
					expect(m.innerWidth - m.clientWidth).toBe(15);
					// …and nothing is wider than the space left beside it.
					expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
					// The gutter shows the form side's colour.
					expect(m.htmlBg).toBe(m.formBg);
					if (size.name === 'desktop') {
						// Brand panel: the full height, on the left, beside the form.
						expect(m.brand.top).toBe(0);
						expect(m.brand.height).toBe(m.innerHeight); // no horizontal scrollbar
						expect(m.brand.width).toBeGreaterThan(m.clientWidth / 2);
					} else {
						// Phone: a short band above the form.
						expect(m.brand.height).toBe(84);
						await expect(page.getByLabel('Email')).toBeInViewport();
					}
					const shot = testInfo.outputPath(`${size.name}-${colorScheme}${path.replace('/', '-')}.png`);
					await page.screenshot({ path: shot, fullPage: true });
					await testInfo.attach('layout', { path: shot, contentType: 'image/png' });
				});
			}
		});
	}
}
