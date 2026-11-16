// A weather station API feed (issue #784, docs/ui.md § Data feeds): an owner
// attaches a rainfall station that fetches from its provider's web API,
// against the synthetic station API the server answers in fixtures mode
// (backend/src/feeds/stationFixtures.ts, host station.example, no network).
// The form starts from the Generic JSON preset, tries a pasted answer in the
// browser (nothing sent), and saves with a key, which the card then shows
// only as "Key saved · ends …". Run now fetches through the keyed endpoint
// and days arrive; the owner replaces the key; a viewer sees the key line
// but no key controls.
import { addMember, createProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { answerConfirm } from '../support/confirm.ts';
import { projectDay } from '../support/dates.ts';

/** The keyed endpoint's key (backend stationFixtures.ts STATION_FIXTURE_KEY: dev-only, invented). */
const FIXTURE_KEY = 'fixture-station-key-0001';
const URL_TEMPLATE = 'https://station.example/v1/keyed/daily.json?station={station}&start={start}&end={end}';
const TARGET = 'Rainfall — catchment · Hilltop gauge';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isoToText = (iso: string) => {
	const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
	return `${d} ${MONTHS[m - 1]} ${y}`;
};
const epochDay = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const isoOf = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
/**
 * The newest day the fixture's daily endpoint has rain for at `at`: yesterday in Africa/Johannesburg, or the day
 * before when yesterday is one of its missing days (stationFixtureMissing: every 29th epoch day, -9999).
 */
const newestFixtureDay = (at: number) => {
	const yesterday = epochDay(projectDay(undefined, new Date(at))) - 1;
	return isoOf(yesterday % 29 === 0 ? yesterday - 1 : yesterday);
};

// Its tick claims only this project's jobs and never runs the schedule, so it stays parallel with the other specs.
test('an owner attaches a station API feed with a key, tries a sample, runs it, and replaces the key; a viewer sees no key controls', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Station API');
	await page.goto(`/projects/${project.id}?tab=series`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	await expect(panel.getByText('No feeds yet.')).toBeVisible();
	// The section's live region (the open form's sample preview is a status of its own).
	const status = panel.getByTestId('feeds-status');

	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Source').selectOption({ label: 'Weather station API' });
	const form = panel.getByTestId('station-api-form');
	await expect(form).toBeVisible();
	// No area or series choice for a station: it writes its own series, named after it.
	await expect(panel.getByLabel('Area')).toHaveCount(0);
	await expect(panel.getByLabel('Into series')).toHaveCount(0);

	// Whose permission it is to fetch the station this way (docs/data-sources.md § station-api).
	await expect(form.getByTestId('station-terms')).toContainText('As the project’s owner you are responsible for having the provider’s permission');
	await form.getByLabel('Start from a known API').selectOption({ label: 'Generic JSON (daily totals)' });
	await expect(form.getByText('A preset only fills in the fields: check them against your provider’s documentation.')).toBeVisible();
	await expect(form.getByLabel('Path to the records')).toHaveValue('data');
	await expect(form.getByLabel('Time field')).toHaveValue('date');
	await expect(form.getByLabel('Rain field')).toHaveValue('rain_mm');

	// A key in the URL is refused before anything is sent, on the URL field.
	await form.getByLabel('Station name').fill('Hilltop gauge');
	await form.getByLabel('Station ID').fill('WS-01');
	await form.getByLabel('The API’s URL').fill(`${URL_TEMPLATE}&api_key=abc`);
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	await expect(panel.getByRole('alert')).toHaveText(/^The URL carries a key \(api_key=…\)/);
	await expect(form.getByLabel('The API’s URL')).toBeFocused();
	await expect(form.getByLabel('The API’s URL')).toHaveAttribute('aria-invalid', 'true');
	// The problem shows under its own field (not at the foot of the long form), as that field's description.
	const urlField = form.locator('.field').filter({ has: page.getByLabel('The API’s URL') });
	await expect(urlField.getByRole('alert')).toBeVisible();
	await expect(form.getByLabel('The API’s URL')).toHaveAccessibleDescription(/The URL carries a key \(api_key=…\)/);
	// A long URL wraps in its box, so it can be read whole.
	const urlBox = await form.getByLabel('The API’s URL').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
	expect(urlBox.scroll).toBeLessThanOrEqual(urlBox.client);

	// A refusal only the server can make (a private address) lands on its field too, in the server's own words.
	await form.getByLabel('The API’s URL').fill('https://10.1.2.3/v1/daily.json?station={station}&start={start}&end={end}');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	await expect(urlField.getByRole('alert')).toHaveText('The URL points at a private or reserved address.');
	await expect(form.getByLabel('The API’s URL')).toBeFocused();
	await expect(form.getByLabel('The API’s URL')).toHaveAttribute('aria-invalid', 'true');
	await form.getByLabel('The API’s URL').fill(URL_TEMPLATE);

	// A problem inside a closed fold opens it and focuses the field.
	const requests = form.getByTestId('station-requests');
	await expect(requests).not.toHaveAttribute('open');
	await requests.locator('summary').click();
	await form.getByLabel('Days per request').fill('400');
	await requests.locator('summary').click();
	await expect(requests).not.toHaveAttribute('open');
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	await expect(requests).toHaveAttribute('open');
	await expect(form.getByLabel('Days per request')).toBeFocused();
	await expect(requests.getByRole('alert')).toHaveText('Days per request is a whole number from 1 to 366.');
	await form.getByLabel('Days per request').fill('');
	await requests.locator('summary').click();

	// A key method with no key is refused too.
	await form.getByLabel('How the key is sent').selectOption({ label: 'Bearer token (Authorization: Bearer …)' });
	await panel.getByRole('button', { name: 'Attach feed' }).click();
	await expect(panel.getByRole('alert')).toHaveText('Enter the key.');
	const key = form.getByLabel('Key', { exact: true });
	await expect(key).toBeFocused();
	await expect(key).toHaveAttribute('type', 'password');
	await expect(key).toHaveAttribute('autocomplete', 'off');
	await key.fill(FIXTURE_KEY);

	// Try it on a sample: read in the browser, nothing sent.
	await expect(form.getByText('Paste what your provider’s API returns; nothing leaves your browser.')).toBeVisible();
	const sample = form.getByLabel('An answer from the API');
	const preview = form.getByTestId('station-preview');
	await sample.fill('<!doctype html><title>Sign in</title>');
	await form.getByRole('button', { name: 'Try it' }).click();
	await expect(preview).toHaveText('The answer is a web page (HTML), not JSON: check the URL and the key.');
	await sample.fill(
		JSON.stringify({ station: 'WS-01', unit: 'mm', data: [{ date: '2026-01-01', rain_mm: 1.2 }, { date: '2026-01-02', rain_mm: -9999 }, { date: '2026-01-03', rain_mm: 0 }] })
	);
	await form.getByRole('button', { name: 'Try it' }).click();
	await expect(preview.locator('p')).toHaveText('Read 3 records: 3 days, 2 with rain data and 1 gap.');
	// Newest first; a gap says so in words.
	const days = preview.getByRole('table', { name: 'The last days the sample would write' });
	await expect(days.getByRole('rowheader')).toHaveText(['3 Jan 2026', '2 Jan 2026', '1 Jan 2026']);
	await expect(days.getByRole('cell')).toHaveText(['0', 'gap', '1.2']);

	await expectNoViolations(page, { include: '#data-feeds' });

	await panel.getByRole('button', { name: 'Attach feed' }).click();
	await expect(status).toContainText('Feed attached: Rainfall — catchment · Hilltop gauge from station.example, station WS-01.');
	const feed = panel.getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(feed).toHaveCount(1);
	await expect(feed).toHaveAttribute('data-state', 'pending');
	await expect(feed).toContainText(`Weather station API → ${TARGET}`);
	// The card names the host and station, never the URL's path or query, and never the key.
	await expect(feed).toContainText('station.example, station WS-01 · daily · runs as Owner');
	await expect(feed).not.toContainText('/v1/keyed');
	await expect(feed.getByTestId('feed-key')).toHaveText('Key saved · ends …0001');
	await expect(page.getByText(FIXTURE_KEY)).toHaveCount(0);

	// Run now, the worker fetches through the keyed endpoint, and the card follows it to its days.
	await feed.getByRole('button', { name: `Run now: ${TARGET}` }).click();
	await expect(feed).toHaveAttribute('data-fetch', 'queued');
	const from = Date.now();
	await runJobsTick({ projects: [project.id], schedule: false });
	const to = Date.now();
	await expect(feed).toHaveAttribute('data-fetch', 'done');
	await expect(feed).toHaveAttribute('data-state', 'ok');
	const newest = [...new Set([from, to].map(newestFixtureDay))].map(isoToText);
	await expect(feed.getByText(new RegExp(`^Last data (${newest.join('|')}) · checked`))).toBeVisible();

	// Replace the key: write-only, an empty one refused, the field never filled from the server.
	const replace = feed.getByRole('button', { name: `Replace key: ${TARGET}` });
	await replace.click();
	await expect(replace).toHaveAttribute('aria-expanded', 'true');
	const newKey = feed.getByLabel('New key', { exact: true });
	await expect(newKey).toBeFocused();
	await expect(newKey).toHaveValue('');
	await feed.getByRole('button', { name: 'Save the key' }).click();
	await expect(feed.getByRole('alert')).toHaveText('Enter the new key.');
	await newKey.fill(FIXTURE_KEY);
	await feed.getByRole('button', { name: 'Save the key' }).click();
	await expect(status).toHaveText('Key replaced: the next fetch uses it.');
	await expect(feed.getByLabel('New key', { exact: true })).toHaveCount(0);
	await expect(replace).toBeFocused();
	await expect(feed.getByTestId('feed-key')).toHaveText('Key saved · ends …0001');

	// A viewer reads the feed and that a key is saved, with no key controls (or any other button on it).
	const viewer = await signIn('Station viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=series`);
	const vfeed = viewer.page.getByRole('region', { name: 'Data feeds' }).getByRole('list', { name: 'Data feeds' }).getByRole('listitem');
	await expect(vfeed).toHaveAttribute('data-state', 'ok');
	// The key's last characters are for editors and owners only (backend 321 app_feed_credential_state).
	await expect(vfeed.getByTestId('feed-key')).toHaveText('Key saved');
	await expect(vfeed.getByRole('button')).toHaveCount(0);

	// The owner removes the key (after a confirm): the card says none is saved, and offers to add one.
	await feed.getByRole('button', { name: `Remove key: ${TARGET}` }).click();
	await answerConfirm(page, true, 'Remove the key?');
	// The API warns that the feed now sends a key it hasn't got; the panel says so after its own words.
	await expect(status).toHaveText(
		'Key removed. Note: the feed sends a key but none is saved: its fetches will be refused until you enter the key (Add a key).'
	);
	await expect(feed.getByTestId('feed-key')).toHaveText('No key saved: the feed can’t sign in to its API until an owner adds one.');
	await expect(feed.getByRole('button', { name: `Add a key: ${TARGET}` })).toBeVisible();
	await expect(feed.getByRole('button', { name: `Remove key: ${TARGET}` })).toHaveCount(0);
	// Adding one opens a form named for adding, not replacing.
	await feed.getByRole('button', { name: `Add a key: ${TARGET}` }).click();
	await expect(feed.getByRole('form', { name: `Add a key: ${TARGET}` })).toBeVisible();
	await expect(feed.getByLabel('New key', { exact: true })).toBeFocused();
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the station form fits a phone with no sideways scroll, passes axe, and says when the server has the source off', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Station phone');
		await page.goto(`/projects/${project.id}?tab=series`);
		const panel = page.getByRole('region', { name: 'Data feeds' });
		await expect(panel.getByText('No feeds yet.')).toBeVisible();
		await panel.getByRole('button', { name: 'Attach a feed' }).click();
		await panel.getByLabel('Source').selectOption({ label: 'Weather station API' });
		const form = panel.getByTestId('station-api-form');
		// The longest choices: a preset with a long URL, the ISO time format, a key in a header.
		await form.getByLabel('Start from a known API').selectOption({ label: 'Weather Underground PWS (daily)' });
		await form.getByLabel('Time format').selectOption({ label: 'ISO date and time (2026-11-15T08:05:00, with or without a zone)' });
		await form.getByLabel('How the key is sent').selectOption({ label: 'In a header' });
		await form.getByTestId('station-requests').locator('summary').click();
		await form.getByTestId('station-values').locator('summary').click();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(0);
		// Every field stays inside the card.
		const card = await panel.locator('form.add').boundingBox();
		for (const box of await form.locator('input, select, textarea').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) {
			expect(box).toBeLessThanOrEqual(card!.x + card!.width + 0.5);
		}
		await expectNoViolations(page, { include: '#data-feeds' });

		// A server with station API feeds off (STATION_API_FEEDS): the source is offered disabled, its note the select's description.
		await page.route(`**/projects/${project.id}/feeds`, async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			const r = await route.fetch();
			await route.fulfill({ response: r, json: { ...(await r.json()), stationApiFeeds: false } });
		});
		await page.reload();
		await panel.getByRole('button', { name: 'Attach a feed' }).click();
		await expect(panel.getByRole('option', { name: 'Weather station API (off on this server)' })).toBeDisabled();
		await expect(panel.getByLabel('Source')).toHaveAccessibleDescription('Weather station API feeds are off on this server: the operator switches them on.');
	});
});
