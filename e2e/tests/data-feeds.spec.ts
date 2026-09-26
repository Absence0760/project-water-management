// Data feeds (WP-2.10, docs/ui.md § Data feeds): an owner attaches a
// CHIRPS-GEFS forecast feed on the synthetic fixtures (FEED_SOURCE=fixtures,
// no network), runs it, and the status panel shows it healthy with its newest
// day; the forecast series appears on the Data tab. A feed pointed at the
// fixture grid's sea cell shows as failing, with the warning above the list,
// and the panel passes axe (WCAG 2.2 AA) in that state with its form open.
import { AxeBuilder } from '@axe-core/playwright';
import type { APIRequestContext } from '@playwright/test';
import { addMember, createProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';

// One at a time: runJobsTick runs the whole e2e database's worker tick, and a
// tick also queues every due feed (a new feed is due at once), so a tick in
// one test would fetch another test's feed mid-test ("The last 2 fetches
// failed", a feed no longer Waiting). No other spec ticks the worker.
test.describe.configure({ mode: 'default' });

const MONTHS =['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A UTC calendar day n days from now, as the panel writes it ("10 Oct 2026"). */
const day = (n: number) => {
	const d = new Date(Date.now() + n * 86_400_000);
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** Attach a CHIRPS feed straight through the API (as whoever `request` is signed in as). */
async function attachFeed(request: APIRequestContext, projectId: string): Promise<string> {
	const res = await request.post(`${API_URL}/projects/${projectId}/feeds`, {
		data: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] } }
	});
	expect(res.status(), await res.text()).toBe(201);
	return ((await res.json()) as { feed: { id: string } }).feed.id;
}

test('an owner attaches a forecast feed on fixtures, runs it, and the status panel shows it OK', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feeds');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const panel = page.getByRole('region', { name: 'Data feeds' });
	await expect(panel.getByText('No feeds yet.')).toBeVisible();
	await expect(panel.getByText('Sample data')).toBeVisible();

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Source').selectOption({ label: 'CHIRPS-GEFS rainfall forecast' });
	await expect(panel.getByLabel('Into series')).toHaveValue('rain_forecast_mm');
	// A bad cell is caught before anything is sent.
	await panel.getByLabel('Grid cells').fill('-20.12');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	await expect(panel.getByRole('alert')).toHaveText('Cell 1 (“-20.12”) should be “latitude, longitude” or “latitude, longitude, weight”.');
	await panel.getByLabel('Grid cells').fill('-20.12, 25.17');
	await panel.getByRole('button', { name: 'Attach feed' }).click();

	const feeds = panel.getByRole('list', { name: 'Data feeds' });
	const feed = feeds.getByRole('listitem');
	await expect(feed).toHaveCount(1);
	await expect(feed).toHaveAttribute('data-state', 'pending');
	await expect(feed.getByText('Waiting', { exact: true })).toBeVisible();
	await expect(feed).toContainText('CHIRPS-GEFS rainfall forecast → Rainfall — forecast');
	await expect(feed).toContainText('cell -20.12, 25.17 · daily · runs as Owner');
	await expect(feed.getByText('Waiting for its first fetch.')).toBeVisible();
	await expect(feed.getByText('No data yet · not checked yet')).toBeVisible();

	await feed.getByRole('button', { name: 'Run now: Rainfall — forecast' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();
	await runJobsTick();

	await panel.getByRole('button', { name: 'Refresh status' }).click();
	await expect(feed).toHaveAttribute('data-state', 'ok');
	await expect(feed.getByText('OK', { exact: true })).toBeVisible();
	await expect(feed).toContainText(`Last data ${day(15)} · checked `);
	// The health sentence, written by the panel from the server's reason code, its days formatted the same way (never raw ISO).
	await expect(feed).toContainText(`OK; newest data ${day(15)}, checked ${day(0)}.`);
	await expect(panel.getByTestId('feeds-attention')).toHaveCount(0);

	// The forecast landed in the project's series.
	await page.goto(`/projects/${project.id}?tab=series`);
	const inputs = page.getByRole('region', { name: 'Input time series' });
	await expect(inputs.getByRole('rowheader', { name: /^Rainfall — forecast/ })).toBeVisible();
	await expect(inputs).toContainText('1 series');
});

test('a feed that fails shows as failing, with the warning above the list', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Failing feed');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	// CHIRPS daily, at the fixture grid's sea cell.
	await panel.getByLabel('Grid cells').fill('-20.27, 25.37');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await feed.getByRole('button', { name: 'Run now: Rainfall — CHIRPS' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();
	await runJobsTick();

	await panel.getByRole('button', { name: 'Refresh status' }).click();
	await expect(feed).toHaveAttribute('data-state', 'failing');
	await expect(feed).toContainText('The last fetch failed: the source’s data could not be read: the grid has no data at -20.27, 25.37');
	await expect(panel.getByTestId('feeds-attention')).toHaveText('1 feed needs attention: its data is out of date or its last fetch failed.');

	// WCAG 2.2 AA on the panel in its busiest state: a failing feed, the warning, the open form.
	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Source').selectOption({ label: 'DWS gauge flow' });
	await expect(panel.getByLabel('DWS station')).toBeVisible();
	const { violations } = await new AxeBuilder({ page })
		.include('#set-feeds')
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
		.analyze();
	expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
	await panel.getByRole('button', { name: 'Cancel' }).click();

	// Switching it off clears the warning.
	await feed.getByRole('button', { name: 'Switch off: Rainfall — CHIRPS' }).click();
	await expect(feed).toHaveAttribute('data-state', 'disabled');
	await expect(panel.getByTestId('feeds-attention')).toHaveCount(0);
});

test('an action on a feed changed elsewhere says why it failed and shows the list as it is now', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feed changed elsewhere');
	const feedId = await attachFeed(page.request, project.id);
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveAttribute('data-state', 'pending');

	// Another tab (or owner) switches it off while this page still shows it on.
	const off = await page.request.patch(`${API_URL}/projects/${project.id}/feeds/${feedId}`, { data: { enabled: false } });
	expect(off.status()).toBe(200);

	await feed.getByRole('button', { name: 'Run now: Rainfall — CHIRPS' }).click();
	await expect(panel.getByRole('alert')).toHaveText('The feed is switched off');
	// The card is no longer stale: it reads Off, with no Run now.
	await expect(feed).toHaveAttribute('data-state', 'disabled');
	await expect(feed.getByRole('button', { name: /^Run now/ })).toHaveCount(0);
	await expect(feed.getByRole('button', { name: 'Switch on: Rainfall — CHIRPS' })).toBeVisible();

	// Refresh status clears the old error and says it refreshed.
	await panel.getByRole('button', { name: 'Refresh status' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Status refreshed.' })).toBeVisible();
	await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('the panel works from the keyboard: focus follows the form, a bad field is marked and focused, and a pressed button keeps focus', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feeds keyboard');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	const attach = panel.getByRole('button', { name: 'Attach a feed' });

	// Opening the form moves focus into it; Cancel brings it back.
	await attach.focus();
	await page.keyboard.press('Enter');
	await expect(panel.getByLabel('Source')).toBeFocused();
	await panel.getByRole('button', { name: 'Cancel' }).focus();
	await page.keyboard.press('Enter');
	await expect(attach).toBeFocused();

	// A bad value: the field is marked invalid, described by the message, and focused.
	await page.keyboard.press('Enter');
	const cells = panel.getByLabel('Grid cells');
	await cells.fill('-20.12');
	await panel.getByRole('button', { name: 'Attach feed' }).focus();
	await page.keyboard.press('Enter');
	await expect(cells).toBeFocused();
	await expect(cells).toHaveAttribute('aria-invalid', 'true');
	await expect(cells).toHaveAccessibleDescription(/Cell 1 \(“-20\.12”\) should be “latitude, longitude”/);

	// Attaching closes the form and returns focus to "Attach a feed".
	await cells.fill('-20.12, 25.17');
	await panel.getByRole('button', { name: 'Attach feed' }).focus();
	await page.keyboard.press('Enter');
	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveCount(1);
	await expect(attach).toBeFocused();

	// Run now keeps focus on the button while and after it works.
	const run = feed.getByRole('button', { name: 'Run now: Rainfall — CHIRPS' });
	await run.focus();
	await page.keyboard.press('Enter');
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();
	await expect(run).toBeFocused();

	// Removing takes the feed's buttons away: focus lands on the section heading, not the page body.
	page.once('dialog', (d) => void d.accept());
	await feed.getByRole('button', { name: 'Remove feed: Rainfall — CHIRPS' }).focus();
	await page.keyboard.press('Enter');
	await expect(panel.getByText('No feeds yet.')).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Data feeds', level: 2 })).toBeFocused();
});

test('what each role sees: editors can only run a feed, viewers only read', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Feed roles');
	await attachFeed(page.request, project.id);
	const editor = await signIn('Feed editor');
	const viewer = await signIn('Feed viewer');
	await addMember(page.request, project.id, editor.user.email, 'editor');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');

	// Editor: Run now (the API lets editors queue a fetch), nothing that changes the feed.
	await editor.page.goto(`/projects/${project.id}?tab=settings`);
	let panel = editor.page.getByRole('region', { name: 'Data feeds' });
	let feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveAttribute('data-state', 'pending');
	await expect(feed.getByRole('button')).toHaveText(['Run now']);
	await expect(panel.getByRole('button', { name: 'Attach a feed' })).toHaveCount(0);
	await feed.getByRole('button', { name: 'Run now: Rainfall — CHIRPS' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();

	// Viewer: the list and its health, with no buttons on the feed and no form.
	await viewer.page.goto(`/projects/${project.id}?tab=settings`);
	panel = viewer.page.getByRole('region', { name: 'Data feeds' });
	feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveAttribute('data-state', 'pending');
	await expect(feed.getByText('Waiting for its first fetch.')).toBeVisible();
	await expect(feed.getByRole('button')).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Attach a feed' })).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Refresh status' })).toBeVisible();

	// With no feeds, a non-owner is told who can attach one.
	const empty = await createProject(page.request, 'Feed roles empty');
	await addMember(page.request, empty.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${empty.id}?tab=settings`);
	await expect(viewer.page.getByRole('region', { name: 'Data feeds' }).getByText('No feeds yet. An owner can attach one.')).toBeVisible();
});

test('on a phone the panel, its feed card and the open form fit the screen', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feeds phone');
	await attachFeed(page.request, project.id);
	await page.setViewportSize({ width: 320, height: 800 });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	await expect(panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem')).toHaveCount(1);
	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Source').selectOption({ label: 'CHIRPS-GEFS rainfall forecast' });
	await expect(panel.getByLabel('Grid cells')).toBeVisible();
	// The panel sits inside the 320 px screen and nothing in it (card, fields, buttons) pokes out of it.
	expect(await panel.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(320);
	expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
	const poking = await panel.evaluate((el) => {
		const edge = el.getBoundingClientRect().right;
		return [...el.querySelectorAll('*')].filter((c) => c.getBoundingClientRect().right > edge + 0.5).map((c) => c.outerHTML.slice(0, 80));
	});
	expect(poking).toEqual([]);
});
