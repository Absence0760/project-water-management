// Sends a page's API calls to the second e2e API (MFA_API_URL: the two-step
// requirement on, as in production, and its mail sent through Mailpit;
// playwright.config.ts), for the specs that need it.
//
// The route rewrites the request's URL and lets the browser send it
// (route.continue), rather than fetching it from the test process and
// fulfilling with that response. The fetch-and-fulfill proxy raced the end of
// a test: the page's own background calls (a list's load, /auth/mfa) can still
// be in the handler when the test passes, and closing the context disposes the
// fetched response, so the fulfill threw "Fetch response has been disposed"
// and failed a test whose every step had passed. `unrouteAll({ behavior:
// 'wait' })` doesn't help with several calls in flight: in Playwright 1.63 the
// first handler to finish drops the interception for the rest, which then
// fail with "Route is already handled". With continue nothing is held in the
// test process, so there is nothing to dispose.
import type { Page } from '@playwright/test';
import { API_URL, MFA_API_URL } from './env.ts';

export async function viaMfaApi(page: Page): Promise<void> {
	await page.route(`${API_URL}/**`, (route) => route.continue({ url: route.request().url().replace(API_URL, MFA_API_URL) }));
}
