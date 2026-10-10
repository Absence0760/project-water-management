// Test fixtures: `owner` is a fresh user already signed in to `page`'s
// browser context (registered through the context's own request client, so
// the session cookie lands in its jar). `signIn` makes more signed-in pages
// for multi-user specs. `fetchRoute` routes a page's requests through a
// handler that fetches the real answer and changes it, and lets every call
// still in that handler finish before the test's contexts close.
import { test as base, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
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

/** A route registered by `fetchRoute`. `unroute()` waits for the calls still in its handler, then removes it. */
export interface FetchedRoute {
	unroute(): Promise<void>;
}

export type FetchRoute = (page: Page, url: Parameters<Page['route']>[0], handler: (route: Route) => Promise<unknown>) => Promise<FetchedRoute>;

export const test = base.extend<{ owner: TestUser; signIn: (displayName: string) => Promise<SignedIn>; fetchRoute: FetchRoute }>({
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
	},
	// A handler that awaits route.fetch() holds the call in the test process. If the test ends (or closes the
	// page's context) while one is in there, the fetch throws "Target page, context or browser has been closed", or the
	// fulfill "Fetch response has been disposed", and a test whose every step passed fails. Neither
	// page.unroute nor unrouteAll({ behavior: 'wait' }) settles them: in Playwright 1.63, removing a page's last
	// route continues every call still in a handler, whose fulfill then throws "Route is already handled". So
	// unroute() first sends new calls past the handler (route.fallback(), which holds nothing), then waits for the
	// calls already inside it to be answered, and only then removes the route. A handler's own error is not caught
	// here: Playwright still reports it and fails the test. Every route still on at the end is unrouted this way
	// before `context` or a `signIn` context closes (the fixture depends on both, so it tears down first); a page
	// in a context the test closes itself needs `await r.unroute()` before that close.
	fetchRoute: async ({ context, signIn }, use) => {
		void context;
		void signIn;
		const open = new Map<FetchedRoute, Page>();
		await use(async (page, url, handler) => {
			const inFlight = new Set<Promise<unknown>>();
			let stopping = false;
			const wrapper = (route: Route) => {
				if (stopping) return route.fallback();
				const call = handler(route);
				const done = () => inFlight.delete(call);
				call.then(done, done);
				inFlight.add(call);
				return call;
			};
			await page.route(url, wrapper);
			let stopped: Promise<void> | undefined;
			const r: FetchedRoute = {
				unroute: () =>
					(stopped ??= (async () => {
						stopping = true;
						open.delete(r);
						await Promise.allSettled([...inFlight]);
						if (!page.isClosed()) await page.unroute(url, wrapper);
					})())
			};
			open.set(r, page);
			return r;
		});
		await Promise.all([...open.keys()].map((r) => r.unroute()));
	}
});

export { expect };
