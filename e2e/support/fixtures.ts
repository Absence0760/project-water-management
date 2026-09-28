// Test fixtures: `owner` is a fresh user already signed in to `page`'s
// browser context (registered through the context's own request client, so
// the session cookie lands in its jar). `signIn` makes more signed-in pages
// for multi-user specs.
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { register, type TestUser } from './api.ts';

export interface SignedIn {
	user: TestUser;
	context: BrowserContext;
	page: Page;
}

async function signedInContext(browser: Browser, displayName: string): Promise<SignedIn> {
	// Playwright Test applies the config's `use` options (baseURL, timezoneId…)
	// to contexts created here too.
	const context = await browser.newContext();
	const page = await context.newPage();
	const user = await register(context.request, displayName);
	return { user, context, page };
}

export const test = base.extend<{ owner: TestUser; signIn: (displayName: string) => Promise<SignedIn> }>({
	owner: async ({ page }, use, testInfo) => {
		await use(await register(page.context().request, `Owner ${testInfo.workerIndex}`));
	},
	signIn: async ({ browser }, use) => {
		const opened: BrowserContext[] = [];
		await use(async (displayName) => {
			const s = await signedInContext(browser, displayName);
			opened.push(s.context);
			return s;
		});
		await Promise.all(opened.map((c) => c.close()));
	}
});

export { expect };
