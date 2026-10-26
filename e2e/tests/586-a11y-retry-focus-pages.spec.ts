// A page's own Try again keeps the focus through a retry (issue #586 R4-L,
// WCAG 2.4.3), as a panel's does (586-a11y-retry-focus.spec.ts): Try again
// takes its alert (or card) out of the page, and the focus fell to <body>.
// Now common/loadState.ts followRetry puts it on the loading line while the
// retry loads, on the new Try again when it fails again, and on the page's
// title once it has loaded (lib/a11y/focusPage.ts pageStart). The pages: the
// root layout's "Could not reach the API", the account's Alert emails and
// Invitations, an evidence pack's page, a team's Projects panel, /share and
// /verify. Each answer is held back until the test lets it go, so the
// loading line is seen focused. Synthetic data only.
import type { Locator, Page } from '@playwright/test';
import { createProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

/** Fails the `method` calls `match` picks while `down`, holding each answer until `letGo` is called. */
async function flaky(page: Page, match: (url: URL) => boolean, method = 'GET') {
	const state = { down: true, held: null as Promise<void> | null, release: () => {} };
	await page.route(match, async (r) => {
		if (r.request().method() !== method) return r.fallback();
		if (state.held) await state.held;
		return state.down ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server unavailable"}' }) : r.fallback();
	});
	return {
		hold: () => (state.held = new Promise((resolve) => (state.release = resolve))),
		letGo: () => {
			state.held = null;
			state.release();
		},
		up: () => (state.down = false)
	};
}

/**
 * Enter on Try again while the answer is held: the loading line has the focus; let go, it fails again and the new
 * Try again has it; back up, Enter lands on `landed`, never on <body>.
 */
async function walk(page: Page, net: Awaited<ReturnType<typeof flaky>>, scope: Locator, loading: Locator, landed: Locator) {
	const retry = scope.getByRole('button', { name: 'Try again' });
	net.hold();
	await retry.focus();
	await page.keyboard.press('Enter');
	await expect(loading).toBeFocused();
	net.letGo();
	await expect(retry).toBeFocused();
	net.up();
	await page.keyboard.press('Enter');
	await expect(landed).toBeFocused();
	await expect(page.locator('body')).not.toBeFocused();
}

const api = (path: RegExp) => (url: URL) => url.origin === new URL(API_URL).origin && path.test(url.pathname);

test('the root layout: Could not reach the API keeps the focus, then lands on the page’s title', async ({ page, owner }) => {
	void owner;
	const net = await flaky(page, api(/^\/auth\/me$/));
	await page.goto('/account/alerts');
	const main = page.locator('main');
	await expect(main.getByRole('alert')).toContainText('Could not reach the API: Server unavailable');
	await walk(page, net, main, main.getByRole('status').filter({ hasText: 'Loading…' }), page.getByRole('heading', { level: 1, name: 'Alert emails' }));
	await expect(page).toHaveURL(/\/account\/alerts$/);
});

test('Alert emails: Try again keeps the focus, then lands on the page’s title', async ({ page, owner }) => {
	void owner;
	const net = await flaky(page, api(/^\/me\/alerts$/));
	await page.goto('/account/alerts');
	const main = page.locator('main');
	await expect(main.getByRole('alert')).toContainText('Something went wrong on our side.');
	await walk(page, net, main, main.getByRole('status').filter({ hasText: 'Loading…' }), page.getByRole('heading', { level: 1, name: 'Alert emails' }));
	await expect(main.getByRole('alert')).toHaveCount(0);
});

test('Invitations: Try again keeps the focus on a loading line that says so, then lands on the page’s title', async ({ page, owner }) => {
	void owner;
	const net = await flaky(page, api(/^\/me\/invites$/));
	await page.goto('/account/invitations');
	const main = page.locator('main');
	await expect(main.getByRole('alert')).toContainText('Something went wrong on our side.');
	await walk(page, net, main, main.getByRole('status').filter({ hasText: 'Loading…' }), page.getByRole('heading', { level: 1, name: 'Invitations' }));
	await expect(main.getByText('You have no invitations waiting.')).toBeVisible();
});

test('an evidence pack’s page: Try again keeps the focus, then the page’s start once it has answered', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Retry focus pack');
	const packId = '00000000-0000-4000-8000-0000000005a6';
	// The pack and its sign-offs, which the page reads together: both fail, and both are held.
	const net = await flaky(page, api(new RegExp(`^/projects/${project.id}/packs/${packId}(/signoffs)?$`)));
	await page.goto(`/projects/${project.id}/packs/${packId}`);
	const main = page.locator('main.pack-page');
	await expect(main.getByRole('alert')).toContainText('The evidence pack could not be loaded: Server unavailable');
	// Back up, the pack doesn't exist: no title to land on, so the page's start (#main, the skip link's target).
	await walk(page, net, main, main.getByRole('status').filter({ hasText: 'Loading the evidence pack…' }), page.locator('#main'));
	await expect(main.getByRole('alert')).toContainText('This evidence pack doesn’t exist');
});

test('a team’s Projects: Try again keeps the focus, then lands on the panel’s heading', async ({ page, owner }) => {
	void owner;
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Retry focus team' } });
	const { team } = (await res.json()) as { team: { id: string } };
	const net = await flaky(page, api(new RegExp(`^/teams/${team.id}/portfolio$`)));
	await page.goto(`/teams/${team.id}`);
	const panel = page.locator('section.projects');
	await expect(panel.getByRole('alert')).toContainText("The projects couldn't be loaded: Server unavailable");
	await walk(page, net, panel, panel.getByRole('status').filter({ hasText: 'Loading…' }), panel.getByRole('heading', { level: 2, name: /^Projects/ }));
	await expect(panel.getByText('No projects yet', { exact: false })).toBeVisible();
});

test('/share: Try again keeps the focus, then lands on the page’s title', async ({ page }) => {
	const net = await flaky(page, api(/^\/share\/view$/), 'POST');
	// A well-formed token nobody issued: once the API is back, the link is dead.
	await page.goto(`/share#t=${'r'.repeat(43)}`);
	const main = page.locator('main');
	await expect(main.getByRole('alert')).toContainText('Couldn’t load this just now.');
	await walk(page, net, main, main.getByRole('status').filter({ hasText: 'Loading…' }), page.getByRole('heading', { level: 1, name: 'This link doesn’t open anything' }));
});

test('/verify: Try again keeps the focus, then lands on the page’s title', async ({ page }) => {
	const code = 'abcd-ef01-2345';
	const net = await flaky(page, api(/^\/verify\/[^/]+$/));
	await page.goto(`/verify/${code}`);
	const main = page.locator('main');
	await expect(main.getByRole('alert')).toContainText('The lookup failed just now: Server unavailable');
	await walk(page, net, main, main.getByRole('status').filter({ hasText: 'Looking up the code…' }), page.getByRole('heading', { level: 1, name: 'No issued evidence pack has this code' }));
});
