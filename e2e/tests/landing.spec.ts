// The public landing page (issue #57; docs/ui.md § Landing page): a signed-out
// visitor to `/` sees it instead of a sign-in redirect, /welcome is the same
// page prerendered for crawlers and link previews, and a signed-in `/` is still
// the projects list. Every other signed-out route still goes to /login?next=.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { words } from '../support/lang.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { expect, test } from '../support/fixtures.ts';

const HEADLINE = 'Every drop in the catchment, accounted for.';
const PHONE = { width: 390, height: 844 };

// The what-if's figures, from the generated module the page reads (by URL, so
// the e2e typecheck doesn't pull in the frontend's modules).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Cell = { reserveDays: number; supplied: number };
const { DATA } = (await import(pathToFileURL(path.join(ROOT, 'frontend/src/lib/components/landing/data.generated.ts')).href)) as {
	DATA: { hero: { calibrationNse: number }; whatIf: { farm: string; extraHa: number[]; damScale: number[]; grid: Cell[][] } };
};
const DESKTOP = { width: 1280, height: 800 };

const headline = (page: Page) => page.getByRole('heading', { level: 1, name: HEADLINE });

/** Scroll the whole page so lazy pictures and in-view reveals have all run. */
async function scrollThrough(page: Page) {
	const height = await page.evaluate(() => document.documentElement.scrollHeight);
	for (let y = 0; y < height; y += 600) await page.evaluate((top) => window.scrollTo(0, top), y);
	await page.evaluate(() => window.scrollTo(0, 0));
}

test('a signed-out visitor to / sees the landing page, and its buttons lead to sign-in and sign-up', async ({ page }) => {
	await page.goto('/');
	await expect(headline(page)).toBeVisible();
	await expect(page).toHaveURL('/');
	await expect(page).toHaveTitle('Water Management: daily water balance for a catchment');

	await page.getByRole('link', { name: 'Create an account' }).first().click();
	await expect(page).toHaveURL('/register');
	await page.goBack();
	await expect(headline(page)).toBeVisible();

	await page.getByRole('main').getByRole('link', { name: 'Sign in' }).first().click();
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
});

test('a signed-in / is still the projects list, and /welcome still shows the landing page', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(headline(page)).toHaveCount(0);
	await page.goto('/welcome');
	await expect(headline(page)).toBeVisible();
});

test('every other signed-out route still goes to /login, remembering where', async ({ page }) => {
	for (const route of ['/teams', '/account', '/projects/00000000-0000-4000-8000-000000000000']) {
		await page.goto(route);
		await expect(page).toHaveURL(`/login?next=${encodeURIComponent(route)}`);
	}
});

test('/welcome is prerendered HTML with its link-preview tags, before any script runs', async ({ request }) => {
	const res = await request.get('/welcome');
	expect(res.status()).toBe(200);
	const html = await res.text();
	// The content is in the HTML itself, not rendered by the client.
	expect(html).toContain(HEADLINE);
	// No inline event handler survived prerendering (an img's onload did once): the CSP blocks them (infra/scripts/check-csp.mjs).
	expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
	expect(html).toContain('From rainfall to river');
	expect(html).toMatch(/<meta name="description" content="Model a catchment day by day/);
	expect(html).toMatch(/<meta property="og:title" content="Water Management: daily water balance for a catchment"/);
	expect(html).toMatch(/<meta name="twitter:card" content="summary_large_image"/);
	const image = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
	expect(image, 'og:image').toMatch(/^https?:\/\/[^/]+\/landing\/og\.jpg$/);
	expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^/"]+\/welcome"/);
	// The social card itself is served.
	const card = await request.get('/landing/og.jpg');
	expect(card.status()).toBe(200);
	expect(card.headers()['content-type']).toBe('image/jpeg');
});

test('the what-if answers from the precomputed runs, in words and figures', async ({ page }) => {
	const w = DATA.whatIf;
	const today = w.grid[0]![0]!;
	await page.goto('/');
	const card = page.getByRole('region', { name: 'Try a what-if' });
	await card.scrollIntoViewIfNeeded();
	await expect(card.getByText('This is the hydrological unit as it is today. Move a slider to change it.')).toBeVisible();

	// The most apples, today's dam.
	const apples = card.getByRole('slider', { name: /More apples/ });
	await apples.focus();
	await page.keyboard.press('End');
	await expect(apples).toHaveAttribute('aria-valuetext', `${w.extraHa.at(-1)} more hectares`);
	const most = w.grid[w.extraHa.length - 1]![0]!;
	await expect(card.getByText(`${Math.round(most.supplied)} % of what the hydrological unit needs`)).toBeVisible();
	const days = Math.round(most.reserveDays - today.reserveDays);
	const points = Math.round(today.supplied - most.supplied);
	await expect(card.getByText(`It costs the river ${days} more days a year below the reserve, and the hydrological unit gets ${points} points less of what it needs.`)).toBeVisible();

	// A dam twice the size gives the farm back much of it.
	const dam = card.getByRole('slider', { name: /Dam size/ });
	await dam.focus();
	await page.keyboard.press('End');
	const both = w.grid[w.extraHa.length - 1]![w.damScale.length - 1]!;
	await expect(card.getByText(`${Math.round(both.supplied)} % of what the hydrological unit needs`)).toBeVisible();
	await expect(card.getByText(`${Math.round(both.reserveDays)} days a year`)).toBeVisible();
});

test('the hero moves only when motion is allowed, and rests on its last frame otherwise', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');
	const scene = page.locator('.hero .scene');
	await expect(scene).toHaveAttribute('data-motion', 'off');
	// The still frame shows the gauge's tag.
	await expect(page.getByText(/Reserve not met on \d+ % of days/)).toBeVisible();

	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.reload();
	await expect(scene).toHaveAttribute('data-motion', 'on');
	await expect(scene).toHaveAttribute('data-playing', 'yes');
	// Scrolled out of view, the loop pauses.
	await page.getByRole('heading', { level: 2, name: 'Why trust it' }).scrollIntoViewIfNeeded();
	await expect(scene).toHaveAttribute('data-playing', 'no');
});

// WCAG 2.2.2 Pause, Stop, Hide (issue #51): the loop runs for as long as the
// hero is on screen, so the visitor can stop it, and the gauge's statistic is
// text to read, so it never fades.
test('the hero’s loop can be stopped on its still frame and started again, and its statistic never fades', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto('/');
	const scene = page.locator('.hero .scene');
	await expect(scene).toHaveAttribute('data-playing', 'yes');
	const running = () => scene.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length);
	expect(await running()).toBeGreaterThan(0);
	// The statistic isn't animated at all: shown the whole loop.
	const tag = page.locator('.hero .tag');
	expect(await tag.evaluate((el) => el.getAnimations().length)).toBe(0);
	await expect(tag).toHaveCSS('opacity', '1');
	await expect(page.getByText(/Reserve not met on \d+ % of days/)).toBeVisible();

	const pause = page.getByRole('button', { name: 'Pause the animation' });
	await expect(pause).toHaveAttribute('aria-pressed', 'false');
	await pause.click();
	await expect(pause).toHaveAttribute('aria-pressed', 'true');
	await expect(scene).toHaveAttribute('data-motion', 'off');
	expect(await running()).toBe(0);
	await expect(page.getByText(/Reserve not met on \d+ % of days/)).toBeVisible();

	await pause.press('Enter');
	await expect(pause).toHaveAttribute('aria-pressed', 'false');
	await expect(scene).toHaveAttribute('data-playing', 'yes');
	expect(await running()).toBeGreaterThan(0);

	// Under reduced motion nothing moves, so there is nothing to stop.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(scene).toHaveAttribute('data-motion', 'off');
	await expect(pause).toHaveCount(0);
});

test('the hero’s first animated frame is its still frame, so turning motion on changes nothing', async ({ page }) => {
	// What each animated part shows: its opacity and transform, and the pulse's dash.
	const frame = () =>
		page.evaluate(() => {
			const q = (sel: string) => document.querySelector(`.hero ${sel}`)!;
			// At rest a transform reads as the identity (or a zero translate) where the still frame sets none.
			const rest = (v: string) => {
				// Rounded, so a rotate(0deg) reached through the keyframes (1.5e-17 off) reads as none.
				const m = /^matrix\((.*)\)$/.exec(v)?.[1]?.split(',').map((n) => Math.round(Number(n) * 1000) / 1000 + 0);
				if (m && m.join() === '1,0,0,1,0,0') return 'none';
				return /^0px( 0px)?$/.test(v) ? 'none' : v;
			};
			const of = (el: Element) => {
				const cs = getComputedStyle(el);
				return { opacity: Number(cs.opacity).toFixed(2), transform: rest(cs.transform), translate: rest(cs.translate) };
			};
			return {
				// The streaks are hidden by their own opacity when still and by their group's in the loop's rest: what shows is the product.
				rain: (Number(getComputedStyle(q('.rain')).opacity) * Number(getComputedStyle(q('.rain path')).opacity)).toFixed(2),
				glow: of(q('.streams .glow')),
				dam: of(q('.dams path')),
				needle: of(q('.gauge path')),
				tag: of(q('.tag')),
				pulse: Number.parseFloat(getComputedStyle(q('.streams .pulse')).strokeDashoffset) % 114
			};
		});
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');
	await expect(page.locator('.hero .scene')).toHaveAttribute('data-motion', 'off');
	const still = await frame();

	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.reload();
	const scene = page.locator('.hero .scene');
	await expect(scene).toHaveAttribute('data-motion', 'on');
	// Hold every loop on its first frame (its current time 0, where the negative delay puts it in the rest).
	await page.evaluate(() => {
		for (const a of document.querySelector('.hero .scene')!.getAnimations({ subtree: true })) {
			a.pause();
			a.currentTime = 0;
		}
	});
	expect(await frame()).toEqual(still);
});

test('the audience icons are drawn without script and under reduced motion, and wait undrawn only once armed', async ({ browser, page }) => {
	const dash = (p: Page) => p.locator('.audiences svg path[pathLength]').first().evaluate((el) => getComputedStyle(el).strokeDashoffset);
	const noScript = await browser.newContext({ javaScriptEnabled: false });
	const still = await noScript.newPage();
	await still.goto('/welcome');
	await expect(still.getByRole('heading', { level: 2, name: 'Who it’s for' })).toBeAttached();
	expect(await dash(still)).toBe('0px');
	await noScript.close();

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');
	await expect(page.locator('.audiences')).toHaveAttribute('data-armed', 'yes');
	expect(await dash(page)).toBe('0px');

	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.reload();
	await expect(page.locator('.audiences')).toHaveAttribute('data-armed', 'yes');
	// Out of view, armed: waiting undrawn (it never flashes drawn, then blank, then drawn).
	expect(await dash(page)).toBe('1px');
	await page.locator('.audiences ul').evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await expect.poll(() => dash(page)).toBe('0px');
});

test('robots.txt is a real file that lets crawlers in, not the SPA fallback', async ({ request }) => {
	const res = await request.get('/robots.txt');
	expect(res.status()).toBe(200);
	const body = await res.text();
	expect(body).not.toContain('<html');
	expect(body).toMatch(/^User-agent: \*$/m);
	expect(body).toMatch(/^Allow: \/$/m);
});

test('the prerendered page loads every asset it asks for, the contour texture among them, with and without script', async ({ browser, page }) => {
	// Its base is relative ('./') until it hydrates: a url() that resolved against
	// a stylesheet instead of the page asked for /_app/immutable/assets/landing/….
	for (const p of [await (await browser.newContext({ javaScriptEnabled: false })).newPage(), page]) {
		const failed: string[] = [];
		p.on('response', (r) => {
			// Assets, not the API (the layout's session check may answer 401).
			if (!['fetch', 'xhr'].includes(r.request().resourceType()) && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
		});
		const texture = p.waitForResponse((r) => r.url().endsWith('/landing/contours.svg'));
		await p.goto('/welcome', { waitUntil: 'load' });
		const res = await texture;
		expect(new URL(res.url()).pathname).toBe('/landing/contours.svg');
		expect(res.status()).toBe(200);
		expect(failed).toEqual([]);
		// And it draws: the file's line group, through <use>, spans the texture's box.
		const drawn = await p.locator('main .contours use').evaluate((u) => (u as SVGUseElement).getBBox().width);
		expect(drawn).toBeGreaterThan(1000);
	}
});

test('the largest contentful paint is the hero render, never the background texture', async ({ page }) => {
	// As a CSS mask the page-sized contour texture was an image to the browser,
	// so it was the page's LCP, fetched only once the styles had resolved
	// (docs/design/landing-art.md § Quality bar). Drawn as vector through <use>,
	// it isn't a candidate. Checked on a phone, where the hero sits below the copy.
	for (const size of [PHONE, DESKTOP]) {
		await page.setViewportSize(size);
		await page.goto('/welcome');
		await expect(page.locator('.hero .scene')).toHaveClass(/\bloaded\b/);
		// Every candidate has loaded by the page's load event (the texture too,
		// when it was a mask). An image is reported on the paint after it is
		// decoded, not after it loads, and the hero's AVIF/WebP decodes off the
		// main thread, later than its load on a busy machine (CI once read the
		// H1 as the last entry at 1280 px): so wait for the hero's decode, then
		// two frames past it, and the last entry is the page's LCP.
		const lcp = await page.evaluate(async () => {
			if (document.readyState !== 'complete') await new Promise((r) => addEventListener('load', r, { once: true }));
			await document.querySelector<HTMLImageElement>('.hero .scene img')!.decode();
			for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
			return new Promise<string>((resolve) => {
				new PerformanceObserver((list) => {
					const last = list.getEntries().at(-1) as PerformanceEntry & { element?: Element | null; url?: string };
					resolve(`${last.element?.tagName ?? '?'} ${new URL(last.url || location.href).pathname}`);
				}).observe({ type: 'largest-contentful-paint', buffered: true });
			});
		});
		expect(lcp, `${size.width} px`).toMatch(/^IMG \/landing\/hero-(day|dusk)-\d+\.(avif|webp)$/);
	}
});

test('on a desktop the story’s pinned scene fits the window, and the step in the middle lights its part', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto('/');
	const scene = page.locator('.story .scene');
	const pin = page.locator('.story .pin');
	for (const step of ['rain', 'runoff', 'dams', 'farms', 'river'] as const) {
		const card = page.locator(`.story .steps li[data-step="${step}"]`);
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await expect(scene).toHaveAttribute('data-step', step);
		await expect(card).toHaveClass(/\bon\b/);
		await expect(page.locator('.story .steps li.on')).toHaveCount(1);
		// The whole scene is on screen; once stuck (past the first step), centred in the window.
		const box = (await pin.boundingBox())!;
		expect(box.y, `${step}: pin top`).toBeGreaterThanOrEqual(0);
		expect(box.y + box.height, `${step}: pin bottom`).toBeLessThanOrEqual(DESKTOP.height);
		if (step !== 'rain') expect(Math.abs(box.y + box.height / 2 - DESKTOP.height / 2), `${step}: pin centred`).toBeLessThan(24);
	}
	// The river's chart says its scale is not linear.
	await expect(page.locator('.story li[data-step="river"] svg text.unit')).toHaveText('m³/s, on a square-root scale');
});

test('the story’s heading is on the first screen at 1440 × 960, and the page doesn’t scroll sideways at desktop sizes', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto('/');
	const heading = page.getByRole('heading', { level: 2, name: 'From rainfall to river' });
	await expect(heading).toBeInViewport({ ratio: 1 });
	await expectNoSidewaysScroll(page);
	await page.setViewportSize(DESKTOP);
	await expectNoSidewaysScroll(page);
	// The header's controls are touch-sized.
	const signIn = page.getByRole('banner').getByRole('link', { name: 'Sign in' });
	expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

// Named, and said to be invented, with the fit in plain words (issue #162),
// in the prerendered HTML as well as on screen.
test('the trust figures are the invented Kleinberg example’s, the model’s fit to its river flow among them', async ({ page, request }) => {
	const html = await (await request.get('/welcome')).text();
	expect(html).toContain('From Kleinberg, an invented example catchment:');
	expect(html).toContain('fit to the measured river flow (1 is perfect)');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');
	const trust = page.getByRole('region', { name: 'Why trust it' });
	await expect(trust.getByText('From Kleinberg, an invented example catchment:')).toBeVisible();
	await expect(trust.locator('dd').nth(2).locator('.visually-hidden')).toHaveText(DATA.hero.calibrationNse.toFixed(2));
	await expect(trust.getByText('fit to the measured river flow (1 is perfect)')).toBeVisible();
});

test('the what-if names each bar, draws today in a muted grey and the plan’s supply in the supply bands', async ({ page }) => {
	await page.goto('/');
	const card = page.getByRole('region', { name: 'Try a what-if' });
	await card.scrollIntoViewIfNeeded();
	const supply = card.locator('.figure').first();
	await expect(supply.locator('.bar-label')).toHaveText(['Today', 'This plan']);
	await expect(card.locator('.figure').nth(1).locator('.bar-label')).toHaveText(['Today', 'This plan']);
	const muted = await page.evaluate(() => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--text-muted)';
		document.body.append(probe);
		const c = getComputedStyle(probe).color;
		probe.remove();
		return c;
	});
	await expect(supply.locator('.bar.today')).toHaveCSS('background-color', muted);
	// Today's farm gets 70–95 % (short, amber); sixty more hectares on today's dam, under 70 % (low, red).
	const band = (pct: number) => (pct >= 95 ? 'met' : pct >= 70 ? 'short' : 'low');
	const plan = supply.locator('.bar.plan');
	await expect(plan).toHaveClass(new RegExp(`\\b${band(DATA.whatIf.grid[0]![0]!.supplied)}\\b`));
	await card.getByRole('slider', { name: /More apples/ }).focus();
	await page.keyboard.press('End');
	await expect(plan).toHaveClass(new RegExp(`\\b${band(DATA.whatIf.grid.at(-1)![0]!.supplied)}\\b`));
});

test('the landing page has no a11y violations with motion on, at desktop and phone size', async ({ page }) => {
	test.setTimeout(60_000);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	for (const size of [DESKTOP, PHONE]) {
		await page.setViewportSize(size);
		await page.goto('/');
		await expect(headline(page)).toBeVisible();
		await expect(page.locator('.hero .scene')).toHaveAttribute('data-motion', 'on');
		await scrollThrough(page);
		// The hero's loop held on its first frame, so the scan sees the frame a
		// still page shows (the pulse and dams mid-fill are only animation).
		await page.evaluate(() => {
			for (const a of document.querySelector('.hero .scene')!.getAnimations({ subtree: true })) {
				a.pause();
				a.currentTime = 0;
			}
		});
		await expectNoViolations(page);
	}
});

for (const scheme of ['light', 'dark'] as const) {
	test(`the landing page has no a11y violations at desktop and phone size, ${scheme}`, async ({ page }) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto('/');
		await expect(headline(page)).toBeVisible();
		await scrollThrough(page);
		await expectNoViolations(page);

		await page.setViewportSize(PHONE);
		await page.goto('/welcome');
		await expect(headline(page)).toBeVisible();
		await scrollThrough(page);
		await expectNoViolations(page);
		await expectNoSidewaysScroll(page);
	});
}

test('the landing page switches to Afrikaans', async ({ page }) => {
	const af = await words('af');
	await page.goto('/');
	await expect(headline(page)).toBeVisible();
	await page.getByRole('button', { name: 'Afrikaans' }).click();
	await expect(page.getByRole('heading', { level: 1, name: af(HEADLINE) })).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'af');
	await expect(page.getByRole('heading', { level: 2, name: af('From rainfall to river') })).toBeVisible();
});
