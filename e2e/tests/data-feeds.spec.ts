// Data feeds (WP-2.10, docs/ui.md § Data feeds): an owner attaches a
// CHIRPS-GEFS forecast feed on the synthetic fixtures (FEED_SOURCE=fixtures,
// no network), runs it, and the status panel shows it healthy with its newest
// day; the forecast series appears on the Data tab. A feed pointed at the
// fixture grid's sea cell shows as failing, with the warning above the list,
// and the panel passes axe (WCAG 2.2 AA) in that state with its form open.
// Automatic runs (WP-2.11, docs/ui.md § Automatic runs) live here too: new
// data runs the model through the same worker tick, so they share the file's
// one-at-a-time order.
import type { APIRequestContext } from '@playwright/test';
import { addMember, createProject, createRun, putSeries, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { answerConfirm } from '../support/confirm.ts';

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
/**
 * Today where the catchment is, as the panel writes it. The health sentence
 * dates when a feed was checked in the project's time zone (health.ts;
 * project.time_zone defaults to Africa/Johannesburg, 058), which is a day
 * ahead of UTC from 22:00 to 24:00 UTC.
 */
const projectToday = () => {
	const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date()).split('-').map(Number) as [number, number, number];
	return `${d} ${MONTHS[m - 1]} ${y}`;
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
	await expect(feed).toContainText(`OK; newest data ${day(15)}, checked ${projectToday()}.`);
	await expect(panel.getByTestId('feeds-attention')).toHaveCount(0);

	// The forecast landed in the project's series.
	await page.goto(`/projects/${project.id}?tab=series`);
	const inputs = page.getByRole('region', { name: 'Input time series' });
	await expect(inputs.getByRole('rowheader', { name: /^Rainfall — forecast/ })).toBeVisible();
	// The count is the section header's since the list's own summary line went (issue #174).
	await expect(page.getByTestId('section-context')).toHaveText('1 daily input series');
});

test('an owner attaches a CHIRPS feed by bounding box, and it fetches the area’s rainfall', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Box feed');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Area').selectOption({ label: 'Bounding box' });
	await expect(panel.getByLabel('Grid cells')).toHaveCount(0);
	const box = panel.getByLabel('Bounding box');
	await expect(box).toHaveAccessibleDescription(/“south, west, north, east” in degrees.*try −20\.20, 25\.10, −20\.10, 25\.20\./);
	// A box over the limit is caught before anything is sent, on its field.
	await box.fill('-21, 25, -20, 26');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	await expect(panel.getByRole('alert')).toContainText('The box covers 400 grid cells in 20 rows; at most 100 cells in 25 rows');
	await expect(box).toBeFocused();
	await expect(box).toHaveAttribute('aria-invalid', 'true');
	// The sample box as the hint writes it, typeset minus signs and all.
	await box.fill('−20.20, 25.10, −20.10, 25.20');
	await panel.getByRole('button', { name: 'Attach feed' }).click();

	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveCount(1);
	await expect(feed).toContainText('CHIRPS daily rainfall → Rainfall — CHIRPS');
	await expect(feed).toContainText('box -20.20, 25.10 to -20.10, 25.20 · CHIRPS sat v3.0 · daily');
	await feed.getByRole('button', { name: 'Run now: Rainfall — CHIRPS' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();
	await runJobsTick();

	await panel.getByRole('button', { name: 'Refresh status' }).click();
	await expect(feed).toHaveAttribute('data-state', 'ok');
	// Preliminary days reach three days back on the fixtures (chirps-sample.json prelimLagDays).
	await expect(feed).toContainText(`OK; newest data ${day(-3)}, checked ${projectToday()}.`);
});

test('a coastal box leaves out its sea cells when asked, and fetches the land’s rainfall', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Coastal box');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Source').selectOption({ label: 'CHIRPS-GEFS rainfall forecast' });
	await panel.getByLabel('Area').selectOption({ label: 'Bounding box' });
	// The sample grid's corner, whose south-east cell is sea (chirps-sample.json `sea`).
	await panel.getByLabel('Bounding box').fill('-20.30, 25.30, -20.20, 25.40');
	const skip = panel.getByRole('checkbox', { name: 'Leave out sea cells' });
	await expect(skip).toHaveAccessibleDescription(/cells with no data \(the sea\) are left out and the rest averaged/);
	await skip.check();
	await panel.getByRole('button', { name: 'Attach feed' }).click();

	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toContainText('box -20.30, 25.30 to -20.20, 25.40, sea cells left out · daily');
	await feed.getByRole('button', { name: 'Run now: Rainfall — forecast' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();
	await runJobsTick();
	await panel.getByRole('button', { name: 'Refresh status' }).click();
	await expect(feed).toHaveAttribute('data-state', 'ok');
	await expect(feed).toContainText(`OK; newest data ${day(15)}, checked ${projectToday()}.`);
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
	await expectNoViolations(page, { include: '#set-feeds' });
	await panel.getByRole('button', { name: 'Cancel' }).click();

	// Switching it off clears the warning.
	await feed.getByRole('button', { name: 'Switch off: Rainfall — CHIRPS' }).click();
	await expect(feed).toHaveAttribute('data-state', 'disabled');
	await expect(panel.getByTestId('feeds-attention')).toHaveCount(0);
});

test('attaching a feed to a series that already has data asks first, and offers a separate series', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feed takeover');
	// A CHIRPS record of the feed's own product and version (so no version question, #40c) the feed would mix with (it keeps these values and fills only empty days).
	await putSeries(page.request, project.id, {
		kind: 'rain_chirps_mm',
		unit: 'mm',
		startDate: '2023-01-01',
		values: Array.from({ length: 1200 }, (_, i) => i % 7),
		product: 'CHIRPS sat',
		productVersion: '3.0'
	});
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Grid cells').fill('-20.12, 25.17');
	await panel.getByRole('button', { name: 'Attach feed' }).click();

	// Nothing is attached yet: the form asks, with focus on the safe choice.
	const ask = panel.getByRole('alertdialog', { name: '“Rainfall — CHIRPS” already has data (1\u202f200 days).' });
	await expect(ask).toBeVisible();
	await expect(ask).toHaveAccessibleDescription(/The values already there stay, including ones you uploaded or imported: the feed fills only the days without one.*such as “CHIRPS”/);
	const separate = ask.getByRole('button', { name: 'Use a separate series: CHIRPS' });
	await expect(separate).toBeFocused();
	await expect(panel.getByText('No feeds yet.')).toBeVisible();
	await expectNoViolations(page, { include: '#set-feeds' });

	// Escape backs out to the name field.
	await page.keyboard.press('Escape');
	await expect(ask).toHaveCount(0);
	const name = panel.getByLabel(/^Series name/);
	await expect(name).toBeFocused();

	// Asked again, the separate series fills the name; attaching then needs no question.
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	await ask.getByRole('button', { name: 'Use a separate series: CHIRPS' }).press('Enter');
	await expect(ask).toHaveCount(0);
	await expect(name).toHaveValue('CHIRPS');
	await expect(name).toBeFocused();
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	const feeds = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feeds).toHaveCount(1);
	await expect(feeds).toContainText('Rainfall — CHIRPS · CHIRPS');

	// Mixing on purpose: "Fill its empty days" attaches into the existing series.
	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Grid cells').fill('-20.12, 25.17');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	// "CHIRPS" is taken now (the first feed's series name), so the suggestion moves on.
	await expect(ask.getByRole('button', { name: 'Use a separate series: CHIRPS 2' })).toBeFocused();
	await ask.getByRole('button', { name: 'Fill its empty days' }).click();
	await expect(feeds).toHaveCount(2);
	await expect(panel.getByRole('status').filter({ hasText: 'Feed attached: Rainfall — CHIRPS from cell -20.12, 25.17.' })).toBeVisible();
	await expect(panel.getByRole('alertdialog')).toHaveCount(0);
});

// Issue #40 part c: the feed writes CHIRPS sat v3.0 and never splices it onto a series of another version.
test('a series of another CHIRPS version: the form asks to replace it whole or use a separate series, and a feed that clashes later offers the replacement', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feed version');
	const v2 = { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2001-01-01', values: [1, 2, 3], product: 'CHIRPS', productVersion: '2.0' };
	await putSeries(page.request, project.id, v2);
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	// The product choice: sat by default, rnl for a record before 1998.
	await expect(panel.getByLabel('Daily product')).toHaveValue('sat');
	await panel.getByLabel('Grid cells').fill('-20.12, 25.17');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	const ask = panel.getByRole('alertdialog', { name: '“Rainfall — CHIRPS” already has data (3 days).' });
	await expect(ask).toHaveAccessibleDescription(/It holds CHIRPS v2\.0, and this feed writes CHIRPS sat v3\.0\..*never splices one onto the other.*such as “CHIRPS”/);
	await expect(ask.getByRole('button', { name: 'Use a separate series: CHIRPS' })).toBeFocused();
	await expectNoViolations(page, { include: '#set-feeds' });

	// Replacing: the feed is attached with the replacement confirmed, waiting for its first fetch.
	await ask.getByRole('button', { name: 'Replace the series with CHIRPS sat v3.0' }).click();
	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveCount(1);
	await expect(panel.getByRole('status').filter({ hasText: 'Feed attached: its first fetch replaces Rainfall — CHIRPS with CHIRPS sat v3.0.' })).toBeVisible();
	await expect(feed).toContainText('cell -20.12, 25.17 · CHIRPS sat v3.0');
	await expect(feed.getByTestId('feed-version-conflict')).toHaveText(
		/^Replacement confirmed: the feed backfills CHIRPS sat v3\.0 from its start date, then replaces the series \(CHIRPS v2\.0\) with it whole/
	);

	// The first fetch stages the new record (2001 onwards is a long backfill): the card says how far it has got,
	// and the Data and Runs tabs say runs keep the current series until it completes.
	await runJobsTick();
	await page.reload();
	await expect(feed.getByRole('paragraph').filter({ hasText: /^Replacing the series: the new record runs 1 Jan 2001 to 30 Apr 2001 so far\./ })).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByTestId('rebuilding-note')).toHaveText(/Runs use the current series until the replacement completes/);
	await page.goto(`/projects/${project.id}?tab=series`);
	await expect(page.getByTestId('series-rebuilding')).toHaveText('Being replaced');

	// Withdrawing discards what was staged; the card then says every fetch is refused and offers the replacement again.
	await page.goto(`/projects/${project.id}?tab=settings`);
	await feed.getByRole('button', { name: 'Withdraw the replacement: Rainfall — CHIRPS' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Replacement withdrawn' })).toBeVisible();
	await expect(feed.getByTestId('feed-version-conflict')).toHaveText(/^The series holds CHIRPS v2\.0 and this feed writes CHIRPS sat v3\.0, so every fetch is refused/);
	await feed.getByRole('button', { name: 'Replace the series: Rainfall — CHIRPS' }).click();
	await answerConfirm(page, true, 'Replace “Rainfall — CHIRPS”?');
	await expect(panel.getByRole('status').filter({ hasText: 'Replacement confirmed: the feed backfills the new record' })).toBeVisible();
	await expect(feed.getByRole('button', { name: /^Replace the series/ })).toHaveCount(0);
	await expect(feed.getByRole('button', { name: 'Withdraw the replacement: Rainfall — CHIRPS' })).toBeVisible();
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
	await feed.getByRole('button', { name: 'Remove feed: Rainfall — CHIRPS' }).focus();
	await page.keyboard.press('Enter');
	await answerConfirm(page, true, 'Remove this feed?');
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

test('with automatic runs on, new data runs the model without anyone pressing Run, and the editor is offered to publish it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Auto runs');
	const baseline = await createRun(page.request, project.id, 'Baseline');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId: baseline } })).status()).toBe(201);

	// Settings → Automatic runs: on, with no wait (the dev setting), saved like any setting.
	await page.goto(`/projects/${project.id}?tab=settings`);
	const group = page.getByRole('region', { name: 'Automatic runs' });
	await group.getByLabel('Re-run the model after new data').check();
	await group.getByLabel(/^Wait after the latest new data/).fill('0');
	await expect(group.getByLabel('Publishing')).toHaveValue('never');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	// New days (the seed's rain runs 2021-10-01 to 2022-01-28): the merge answers when the re-run is due.
	const merged = await page.request.post(`${API_URL}/projects/${project.id}/series/merge`, {
		data: { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-01-29', values: [4, 0] }
	});
	expect(merged.status(), await merged.text()).toBe(200);
	expect(((await merged.json()) as { rerunQueuedFor: string | null }).rerunQueuedFor).not.toBeNull();

	// The header says a re-run is on its way instead of offering the button.
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByTestId('rerun-queued')).toHaveText('An automatic re-run is due now.');
	await expect(page.getByRole('button', { name: 'Re-run model' })).toHaveCount(0);

	await runJobsTick();

	// The run is there, labelled and tagged as automatic, without anyone pressing Run.
	await page.goto(`/projects/${project.id}?tab=runs`);
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	const auto = list.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Auto · data to 2022-01-30/ }) });
	await expect(auto).toHaveCount(1);
	await expect(auto.getByText('Auto', { exact: true })).toBeVisible();

	// Publication stays a person's act: the Overview offers it, with the comparison.
	await page.goto(`/projects/${project.id}`);
	const offer = page.getByRole('region', { name: 'Published baseline' }).getByTestId('auto-publish-offer');
	await expect(offer).toContainText('New auto run: publish? “Auto · data to 2022-01-30” is newer than the published run.');
	// The workspace's Compare runs tab, published run as A (d0a5d5d5, issue #17 option A step 3).
	await expect(offer.getByRole('link', { name: 'Compare with the published run' })).toHaveAttribute(
		'href',
		new RegExp(`^\\?tab=compare&a=${project.id}%3A${baseline}&b=${project.id}%3A[^&]+$`)
	);
	await expect(offer.getByRole('link', { name: 'Review and publish' })).toBeVisible();
	await expect(page.getByTestId('rerun-queued')).toHaveCount(0);
});
