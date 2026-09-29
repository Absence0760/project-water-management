// The sign-in CAPTCHA (issue #126, frontend lib/auth/wafCaptcha.ts). There is
// no WAF locally, so this spec plays its part: page.route answers the first
// sign-in with the WAF's CAPTCHA response (405, `x-amzn-waf-action:
// captcha`) and serves a stub of AWS's CAPTCHA script at the build's script
// URL (support/build-site.ts E2E_CAPTCHA); nothing reaches AWS. The stub's
// "puzzle" is one button that hands back a token, as renderCaptcha's
// onSuccess does.
//
// In production /api is same-origin, so the page reads the WAF's header as it
// is. Here the API is another origin, so the faked 405 carries the CORS
// headers that let the page read it, as the real API's answers do.
import type { Page, Route } from '@playwright/test';
import { register } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { E2E_CAPTCHA } from '../support/build-site.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const SCRIPT = E2E_CAPTCHA.PUBLIC_WAF_CAPTCHA_SCRIPT_URL;
const TOKEN = 'e2e-solved-token';

// What renderCaptcha does, in miniature: a titled group with a button that
// "solves" it, onLoad once it's drawn, onSuccess(token) on the press.
const STUB_SDK = `
window.AwsWafCaptcha = {
	renderCaptcha(container, options) {
		window.__captchaOptions = { apiKey: options.apiKey, defaultLocale: options.defaultLocale };
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = 'Stub puzzle: solve';
		button.addEventListener('click', () => options.onSuccess(${JSON.stringify(TOKEN)}));
		container.appendChild(button);
		options.onLoad && options.onLoad();
	}
};`;

/** Answer the first sign-in with the WAF's CAPTCHA, and record every sign-in's token header. */
async function wafAsksForCaptcha(page: Page, pageOrigin: string) {
	const tokens: Array<string | null> = [];
	await page.route(`${API_URL}/auth/login`, async (route: Route) => {
		if (route.request().method() !== 'POST') return route.continue();
		const token = route.request().headers()['x-aws-waf-token'] ?? null;
		tokens.push(token);
		if (token === null) {
			return route.fulfill({
				status: 405,
				headers: {
					'x-amzn-waf-action': 'captcha',
					'content-type': 'text/html',
					'access-control-allow-origin': pageOrigin,
					'access-control-allow-credentials': 'true',
					'access-control-expose-headers': 'x-amzn-waf-action'
				},
				body: '<html><body>CAPTCHA</body></html>'
			});
		}
		return route.continue();
	});
	return tokens;
}

async function signIn(page: Page, email: string, password: string) {
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

test('past the WAF’s sign-in limit the page shows the puzzle, and the solved token signs in', async ({ page, playwright, baseURL }) => {
	const standalone = await playwright.request.newContext();
	const user = await register(standalone, 'Captcha');
	await standalone.dispose();

	const scriptLoads: string[] = [];
	await page.route(SCRIPT, (route) => {
		scriptLoads.push(route.request().url());
		return route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB_SDK });
	});
	const tokens = await wafAsksForCaptcha(page, new URL(baseURL!).origin);

	await page.goto('/login');
	await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
	// Nothing from AWS on an ordinary visit: the script loads only on demand.
	expect(scriptLoads).toEqual([]);

	await signIn(page, user.email, user.password);
	const check = page.getByRole('region', { name: 'Check that you’re a person' });
	await expect(check).toBeVisible();
	await expect(check.getByRole('heading', { level: 2, name: 'Check that you’re a person' })).toBeFocused();
	await expect(check).toContainText('The audio button in the puzzle plays a spoken version.');
	await expect(check).toHaveAttribute('data-state', 'ready');
	expect(scriptLoads).toEqual([SCRIPT]);
	expect(await page.evaluate(() => (window as unknown as { __captchaOptions: unknown }).__captchaOptions)).toEqual({
		apiKey: E2E_CAPTCHA.PUBLIC_WAF_CAPTCHA_API_KEY,
		defaultLocale: 'en-US'
	});
	await expect(page).toHaveURL(/\/login/);
	await expectNoViolations(page);

	await check.getByRole('button', { name: 'Stub puzzle: solve' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL('/');
	// The first try had no token; the retry carried the solved one, and the real API signed in.
	expect(tokens).toEqual([null, TOKEN]);
	expect(scriptLoads).toHaveLength(1);
});

test('a puzzle that can’t load says to wait, and the page stays usable', async ({ page, playwright, baseURL }) => {
	const standalone = await playwright.request.newContext();
	const user = await register(standalone, 'CaptchaDown');
	await standalone.dispose();

	await page.route(SCRIPT, (route) => route.abort());
	const tokens = await wafAsksForCaptcha(page, new URL(baseURL!).origin);

	await page.goto('/login');
	await signIn(page, user.email, user.password);
	await expect(page.getByRole('alert')).toHaveText('Too many sign-in attempts from your network. Wait a few minutes, then try again.');
	await expect(page.getByRole('region', { name: 'Check that you’re a person' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
	expect(tokens).toEqual([null]);
});
