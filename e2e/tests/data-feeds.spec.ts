// Data feeds (WP-2.10, docs/ui.md § Data feeds): an owner attaches a
// CHIRPS-GEFS forecast feed on the synthetic fixtures (FEED_SOURCE=fixtures,
// no network), runs it, and the status panel shows it healthy with its newest
// day; the forecast series appears on the Data tab, marked as the feed's. A feed pointed at the
// fixture grid's sea cell shows as failing, with the warning above the list,
// and the panel passes axe (WCAG 2.2 AA) in that state with its form open.
// Automatic runs (WP-2.11, docs/ui.md § Automatic runs) live here too: new
// data runs the model through the same worker tick, so they share the file's
// one-at-a-time order. With a CHIRPS feed the panel says how far our copy of
// the rain data reaches (issue #604; the committed sample copy here, on time
// as of the day it was made, once a worker tick has recorded it), and a feed
// whose copy is late says so instead of looking stale. An ECMWF forecast
// feed (issue #604 R4-C) reads the copy's ECMWF issue and credits ECMWF.
import { readFileSync } from 'node:fs';
import type { APIRequestContext } from '@playwright/test';
import { addMember, createProject, createRun, putSeries, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveSettings } from '../support/settings.ts';
import { runJobsTick } from '../support/jobs.ts';
import { answerConfirm } from '../support/confirm.ts';
import { projectDay } from '../support/dates.ts';

// One at a time: these ticks run the feed schedule, which looks at every
// project (a new feed is due at once), so a tick in one test would queue
// another test's feed mid-test (a feed no longer Waiting). The tick claims
// only this test's project's jobs (runJobsTick's `projects`), so it never
// runs that fetch; every other spec's tick is `schedule: false`.
test.describe.configure({ mode: 'default' });

const MONTHS =['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The UTC calendar day n days from `at` (ms), as the panel writes it ("10 Oct 2026"). */
const day = (n: number, at: number) => {
	const d = new Date(at + n * 86_400_000);
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
/**
 * The day where the catchment is at `at`, as the panel writes it. The health
 * sentence dates when a feed was checked in the project's time zone
 * (health.ts; project.time_zone defaults to Africa/Johannesburg, 058), which
 * is a day ahead of UTC from 22:00 to 24:00 UTC.
 */
const projectToday = (at: number) => {
	const [y, m, d] = projectDay(undefined, new Date(at)).split('-').map(Number) as [number, number, number];
	return `${d} ${MONTHS[m - 1]} ${y}`;
};

/**
 * Run this project's jobs once (the fetch), and the two ends of it. The server
 * dates what the fetch writes by its own clock (the fixtures' days count from
 * the fetch's UTC day, the check from its day in the project's zone), which
 * the spec can't fake, so the days it can have used are those at either end.
 */
async function fetchOnce(projectId: string): Promise<[number, number]> {
	const from = Date.now();
	await runJobsTick({ projects: [projectId] });
	return [from, Date.now()];
}

/** `text` exactly, as dated at either end of `span`: one text unless a midnight fell inside the fetch. */
const datedIn = (span: [number, number], text: (at: number) => string) =>
	new RegExp([...new Set(span.map(text))].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

/**
 * Fire the panel's next follow-up poll now instead of waiting it out: after
 * Run now the panel re-reads the list on its own, at most 10 s apart
 * (frontend feeds/follow.ts FOLLOW_DELAYS_MS), until the fetch has run. The
 * page's clock must be installed (page.clock.install()) before the page loads.
 */
const nextPoll = (page: import('@playwright/test').Page) => page.clock.runFor(10_000);

/** `at + minutes` as the row writes the next try (feeds.ts nextTryNote): the time alone on the same UTC day (timezoneId), else the day too. */
const triesAgain = (at: number, minutes: number) => {
	const t = new Date(at + minutes * 60_000);
	const iso = t.toISOString();
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const day = `${t.getUTCDate()} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
	const when = iso.slice(0, 10) === new Date(at).toISOString().slice(0, 10) ? iso.slice(11, 16) : `${day} ${iso.slice(11, 16)}`;
	return `It tries again after ${when}.`;
};

/** A product's manifest in the committed sample copy of the rain data (backend/fixtures/mirror/), which the e2e worker tick reads and records. */
const sampleManifest = (product: 'sat' | 'rnl' | 'prelim') =>
	JSON.parse(readFileSync(new URL(`../../backend/fixtures/mirror/${product}/manifest.json`, import.meta.url), 'utf8')) as {
		finalThrough: string | null;
		prelimThrough: string | null;
	};
/** A YYYY-MM-DD day as the panel writes it ("6 Feb 2026"). */
const isoDay = (d: string) => day(0, Date.parse(`${d}T00:00:00Z`));

/** Attach a CHIRPS feed straight through the API (as whoever `request` is signed in as). */
async function attachFeed(request: APIRequestContext, projectId: string): Promise<string> {
	const res = await request.post(`${API_URL}/projects/${projectId}/feeds`, {
		data: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] } }
	});
	expect(res.status(), await res.text()).toBe(201);
	return ((await res.json()) as { feed: { id: string } }).feed.id;
}

test('an owner attaches a forecast feed on fixtures, runs it, and the status panel follows the fetch and shows it OK', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feeds');
	await page.clock.install();
	await page.goto(`/projects/${project.id}?tab=series`);

	const panel = page.getByRole('region', { name: 'Data feeds' });
	await expect(panel.getByText('No feeds yet.')).toBeVisible();
	await expect(panel.getByText('Sample data')).toBeVisible();
	// No CHIRPS feed, so nothing about our copy of the rain data.
	await expect(panel.getByTestId('rain-copy')).toHaveCount(0);

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

	const run = feed.getByRole('button', { name: 'Run now: Rainfall — forecast' });
	await run.click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();
	const fetched = await fetchOnce(project.id);

	// No Refresh status: the panel follows the queued fetch, updates the row and announces it, focus staying on Run now.
	await nextPoll(page);
	await expect(feed).toHaveAttribute('data-state', 'ok');
	await expect(panel.getByRole('status')).toHaveText(datedIn(fetched, (at) => `Fetch done: Rainfall — forecast. OK; newest data ${day(15, at)}, checked ${projectToday(at)}.`));
	await expect(run).toBeFocused();
	await expect(feed.getByText('OK', { exact: true })).toBeVisible();
	await expect(feed).toContainText(datedIn(fetched, (at) => `Last data ${day(15, at)} · checked `));
	// The health sentence, written by the panel from the server's reason code, its days formatted the same way (never raw ISO).
	await expect(feed).toContainText(datedIn(fetched, (at) => `OK; newest data ${day(15, at)}, checked ${projectToday(at)}.`));
	await expect(panel.getByTestId('feeds-attention')).toHaveCount(0);

	// The forecast landed in the project's series.
	await page.goto(`/projects/${project.id}?tab=series`);
	const inputs = page.getByRole('region', { name: 'Input time series' });
	const forecast = inputs.getByRole('rowheader', { name: /^Rainfall — forecast/ });
	await expect(forecast).toBeVisible();
	// Marked as the feed's (SeriesMeta.feed): every day of it came from the feed, so no count.
	await expect(forecast.getByTestId('series-feed')).toHaveText('Written by the CHIRPS-GEFS rainfall forecast feed');
	// The count is the section header's since the list's own summary line went (issue #174).
	await expect(page.getByTestId('section-context')).toHaveText('1 daily input series');
});

test('an ECMWF forecast feed reads our copy, credits ECMWF and says it is not yet calibrated (issue #604 R4-C)', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feeds');
	await page.clock.install();
	await page.goto(`/projects/${project.id}?tab=series`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Source').selectOption({ label: 'ECMWF ENS rainfall forecast' });
	await expect(panel.getByLabel('Into series')).toHaveValue('rain_forecast_mm');
	await panel.getByLabel('Grid cells').fill('-20.12, 25.17');
	await panel.getByRole('button', { name: 'Attach feed' }).click();

	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveCount(1);
	await expect(feed).toContainText('ECMWF ENS rainfall forecast → Rainfall — forecast');
	// Before its first fetch: the credit alone.
	await expect(feed).toContainText('ECMWF open data, CC BY 4.0');
	await expect(feed).not.toContainText('calibrated');

	await feed.getByRole('button', { name: 'Run now: Rainfall — forecast' }).click();
	const fetched = await fetchOnce(project.id);
	await nextPoll(page);
	await expect(feed).toHaveAttribute('data-state', 'ok');
	// 15 days from the issue (today, in the committed sample copy re-dated), and no fit in the copy yet.
	await expect(feed).toContainText(datedIn(fetched, (at) => `Last data ${day(14, at)} · checked `));
	await expect(feed).toContainText('ECMWF open data, CC BY 4.0 · not yet calibrated');
});

test('an owner attaches a CHIRPS feed by bounding box, and it fetches the area’s rainfall', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Box feed');
	await page.goto(`/projects/${project.id}?tab=series`);
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
	const fetched = await fetchOnce(project.id);

	await panel.getByRole('button', { name: 'Refresh status' }).click();
	await expect(feed).toHaveAttribute('data-state', 'ok');
	// Preliminary days reach three days back on the fixtures (chirps-sample.json prelimLagDays).
	await expect(feed).toContainText(datedIn(fetched, (at) => `OK; newest data ${day(-3, at)}, checked ${projectToday(at)}.`));
});

test('with a CHIRPS feed the panel says how far our copy of the rain data reaches, and a late copy is told apart from a stale feed', async ({ page, owner, fetchRoute }) => {
	void owner;
	const project = await createProject(page.request, 'Rain copy');
	// The API reads the copy's days from what the worker's tick last recorded (mirror_copy); the e2e backend has no
	// worker, so tick once (it reads the committed sample copy's manifests), before the feed exists so nothing is fetched.
	await runJobsTick({ projects: [project.id] });
	await attachFeed(page.request, project.id);
	await page.goto(`/projects/${project.id}?tab=series`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveCount(1);

	// The sample copy's own days (read from its manifests), on time: its lags count to the day it was made.
	const final = isoDay(sampleManifest('sat').finalThrough!);
	const prelim = isoDay(sampleManifest('prelim').prelimThrough!);
	const note = panel.getByTestId('rain-copy');
	await expect(note).toHaveText(`Rain data copied to ${final} (final) / ${prelim} (preliminary). This is the sample copy, as it stood on 9 Feb 2026.`);
	await expect(note).toHaveAttribute('data-behind', 'false');
	await expect(note).not.toHaveRole('alert');

	// A late copy: no copy on this server can be late on demand (the sample's days are fixed), so the live list
	// with the copy moved back and the feed's health as the server words a late copy (backend feeds/health.ts copy-behind).
	const listUrl = `${API_URL}/projects/${project.id}/feeds`;
	const late = await fetchRoute(page, listUrl, async (route) => {
		const res = await route.fetch();
		const body = await res.json();
		body.rainCopy = {
			readable: true,
			sample: false,
			asOf: '2026-10-27',
			final: { sat: { through: '2026-07-31', behind: true }, rnl: { through: '2026-07-31', behind: true } },
			preliminary: { through: '2026-10-05', behind: true }
		};
		body.feeds[0].health = {
			state: 'copy-behind',
			stale: true,
			staleAfterDays: 12,
			reason: { code: 'copy-behind', product: 'sat', final: '2026-07-31', preliminary: '2026-10-05', newest: '2026-10-05' }
		};
		await route.fulfill({ response: res, json: body });
	});
	await page.reload();
	await expect(note).toHaveText(
		'Rain data copied to 31 Jul 2026 (final) / 5 Oct 2026 (preliminary). The copy is behind the published data: feeds fill in the newer days once it catches up, with nothing to do here.'
	);
	await expect(note).toHaveAttribute('data-behind', 'true');
	await expect(feed).toHaveAttribute('data-state', 'copy-behind');
	await expect(feed.getByText('Copy behind', { exact: true })).toBeVisible();
	await expect(feed.locator('.health')).toHaveText(
		'Our copy of the rain data is behind: it holds final days to 31 Jul 2026 and preliminary days to 5 Oct 2026. The feed itself is fine and fills in the newer days once the copy catches up; there is nothing to do here. Newest data 5 Oct 2026.'
	);
	// Not the feed's fault, and nothing here fixes it: no "needs attention" warning.
	await expect(panel.getByTestId('feeds-attention')).toHaveCount(0);
	await expectNoViolations(page, { include: '#data-feeds' });
	await late.unroute();
});

test('a coastal box leaves out its sea cells when asked, and fetches the land’s rainfall', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Coastal box');
	await page.goto(`/projects/${project.id}?tab=series`);
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
	const fetched = await fetchOnce(project.id);
	await panel.getByRole('button', { name: 'Refresh status' }).click();
	await expect(feed).toHaveAttribute('data-state', 'ok');
	await expect(feed).toContainText(datedIn(fetched, (at) => `OK; newest data ${day(15, at)}, checked ${projectToday(at)}.`));
	// Three of its four cells are land (the ingest refuses a later fetch whose count changes).
	await expect(feed).toContainText('· 3 of 4 cells with data');
});

test('a feed that fails shows as failing, says when it tries again, with the warning above the list', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Failing feed');
	await page.clock.install();
	await page.goto(`/projects/${project.id}?tab=series`);
	const panel = page.getByRole('region', { name: 'Data feeds' });

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	// CHIRPS daily, at the fixture grid's sea cell.
	await panel.getByLabel('Grid cells').fill('-20.27, 25.37');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await feed.getByRole('button', { name: 'Run now: Rainfall — CHIRPS' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();
	// The tick's schedule takes the feed (it was never scheduled) and the fetch fails: the
	// scheduler's backoff, 15 min less its minute's slack (243_feed_next_attempt.sql), counts from then.
	const fetched = await fetchOnce(project.id);

	await nextPoll(page);
	await expect(feed).toHaveAttribute('data-state', 'failing');
	const why = 'the source’s data could not be read: the grid has no data at -20.27, 25.37 (the sea, or outside the product’s coverage)';
	await expect(panel.getByRole('status')).toHaveText(datedIn(fetched, (at) => `Fetch failed: Rainfall — CHIRPS: ${why}. ${triesAgain(at, 14)}`));
	await expect(feed.locator('.health')).toHaveText(datedIn(fetched, (at) => `The last fetch failed: ${why}. No data yet. ${triesAgain(at, 14)}`));
	await expect(panel.getByTestId('feeds-attention')).toHaveText('1 feed needs attention: its data is out of date or its last fetch failed.');

	// WCAG 2.2 AA on the panel in its busiest state: a failing feed, the warning, the open form.
	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Source').selectOption({ label: 'DWS gauge flow' });
	await expect(panel.getByLabel('DWS station')).toBeVisible();
	await expectNoViolations(page, { include: '#data-feeds' });
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
	await page.goto(`/projects/${project.id}?tab=series`);
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
	await expectNoViolations(page, { include: '#data-feeds' });

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
	await page.goto(`/projects/${project.id}?tab=series`);
	const panel = page.getByRole('region', { name: 'Data feeds' });

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	// The product choice: sat by default, rnl for a record before 1998.
	await expect(panel.getByLabel('Daily product')).toHaveValue('sat');
	await panel.getByLabel('Grid cells').fill('-20.12, 25.17');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	const ask = panel.getByRole('alertdialog', { name: '“Rainfall — CHIRPS” already has data (3 days).' });
	await expect(ask).toHaveAccessibleDescription(/It holds CHIRPS v2\.0, and this feed writes CHIRPS sat v3\.0\..*never splices one onto the other.*such as “CHIRPS”/);
	await expect(ask.getByRole('button', { name: 'Use a separate series: CHIRPS' })).toBeFocused();
	await expectNoViolations(page, { include: '#data-feeds' });

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
	await runJobsTick({ projects: [project.id] });
	await page.reload();
	await expect(feed.getByRole('paragraph').filter({ hasText: /^Replacing the series: the new record runs 1 Jan 2001 to 30 Apr 2001 so far\./ })).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByTestId('rebuilding-note')).toHaveText(/Runs use the current series until the replacement completes/);
	await page.goto(`/projects/${project.id}?tab=series`);
	await expect(page.getByTestId('series-rebuilding')).toHaveText('Being replaced');

	// Withdrawing discards what was staged; the card then says every fetch is refused and offers the replacement again.
	await page.goto(`/projects/${project.id}?tab=series`);
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
	await page.goto(`/projects/${project.id}?tab=series`);
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
	await page.goto(`/projects/${project.id}?tab=series`);
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
	await editor.page.goto(`/projects/${project.id}?tab=series`);
	let panel = editor.page.getByRole('region', { name: 'Data feeds' });
	let feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveAttribute('data-state', 'pending');
	await expect(feed.getByRole('button')).toHaveText(['Run now']);
	await expect(panel.getByRole('button', { name: 'Attach a feed' })).toHaveCount(0);
	await feed.getByRole('button', { name: 'Run now: Rainfall — CHIRPS' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetch queued.' })).toBeVisible();

	// Viewer: the list and its health, with no buttons on the feed and no form.
	await viewer.page.goto(`/projects/${project.id}?tab=series`);
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
	await viewer.page.goto(`/projects/${empty.id}?tab=series`);
	await expect(viewer.page.getByRole('region', { name: 'Data feeds' }).getByText('No feeds yet. An owner can attach one.')).toBeVisible();
});

test('on a phone the panel, its feed card and the open form fit the screen', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Feeds phone');
	await attachFeed(page.request, project.id);
	await page.setViewportSize({ width: 320, height: 800 });
	await page.goto(`/projects/${project.id}?tab=series`);
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
	await saveSettings(page);

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

	await runJobsTick({ projects: [project.id] });

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
