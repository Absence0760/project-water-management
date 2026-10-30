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

// The brand panel follows the app's theme (the operator's report: production
// /login in light mode kept a navy panel beside the light form). Light: a pale
// ground with dark text; dark: the navy panel; a dark OS with data-theme="light"
// on <html>: light again. In each, the copy passes WCAG 1.4.3 (4.5:1) and the
// scene's marks (rivers, farms, outlet) 1.4.11 (3:1) against the panel.
const PANEL_THEMES = [
	{ name: 'light', colorScheme: 'light', force: false, light: true },
	{ name: 'dark', colorScheme: 'dark', force: false, light: false },
	{ name: 'data-theme light on a dark OS', colorScheme: 'dark', force: true, light: true }
] as const;
for (const theme of PANEL_THEMES) {
	test(`the brand panel follows the theme: ${theme.name}`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.emulateMedia({ colorScheme: theme.colorScheme });
		await page.goto('/login');
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		if (theme.force) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

		const m = await page.evaluate(() => {
			const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
			const lum = ([r, g, b]: number[]) => {
				const f = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
				return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
			};
			const ratio = (a: number[], b: number[]) => {
				const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
				return (x + 0.05) / (y + 0.05);
			};
			/** A colour at an opacity, laid over the panel's ground. */
			const over = (c: number[], alpha: number, ground: number[]) => c.map((v, i) => v * alpha + ground[i] * (1 - alpha));
			const panel = document.querySelector('.panel-brand')!;
			const ground = rgb(getComputedStyle(panel).backgroundColor);
			const text = (sel: string) => ratio(rgb(getComputedStyle(panel.querySelector(sel)!).color), ground);
			const mark = (sel: string, prop: 'fill' | 'stroke') => {
				const s = getComputedStyle(panel.querySelector(sel)!);
				const alpha = Number(prop === 'fill' ? s.fillOpacity : s.strokeOpacity);
				return ratio(over(rgb(prop === 'fill' ? s.fill : s.stroke), alpha, ground), ground);
			};
			return {
				groundLum: lum(ground),
				heading: text('h2'),
				kicker: text('.kicker'),
				bullet: text('li'),
				river: mark('.bed.main', 'stroke'),
				farm: mark('.farm', 'fill'),
				outlet: mark('.core', 'fill')
			};
		});
		if (theme.light) expect(m.groundLum).toBeGreaterThan(0.7);
		else expect(m.groundLum).toBeLessThan(0.05);
		expect(m.heading).toBeGreaterThanOrEqual(4.5);
		expect(m.kicker).toBeGreaterThanOrEqual(4.5);
		expect(m.bullet).toBeGreaterThanOrEqual(4.5);
		expect(m.river).toBeGreaterThanOrEqual(3);
		expect(m.farm).toBeGreaterThanOrEqual(3);
		expect(m.outlet).toBeGreaterThanOrEqual(3);
	});
}
