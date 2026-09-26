// The Summary tab (id `overview`, issue #17): results, setup checklist and headline facts, built from the lists
// the project page loads (series, runs) and the model being edited.
import type { Page } from '@playwright/test';
import { createProject, createRun, PASSWORD, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const stat = (page: Page, term: string) =>
	page.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) }).getByRole('definition');
const setup = (page: Page) => page.getByRole('region', { name: /^Set(up| up this catchment)/ });

test('a fresh project: nothing loaded, every step to do', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview empty');
	await page.goto(`/projects/${project.id}`);
	await expect(setup(page).getByRole('heading', { name: 'Set up this catchment' })).toBeVisible();
	await expect(setup(page)).toContainText('0 of 5 done');
	await expect(setup(page)).toContainText('Upload daily catchment rainfall (mm).');
	await expect(setup(page)).toContainText('Run it to get farm supply & deficit');
	await expect(stat(page, 'Time series')).toHaveText('0');
	await expect(stat(page, 'Model runs')).toHaveText('0');
	await expect(stat(page, 'Farms')).toHaveText('0+ 0 gauges');
});

test('a project with data and a run: setup complete, counts shown', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview ready');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const done = setup(page);
	await expect(done.getByRole('heading', { name: 'Setup complete' })).toBeVisible();
	await done.getByText('All 5 steps done. Show checklist').click();
	await expect(done).toContainText('Rainfall and observed flow loaded.');
	await expect(done).toContainText(/1 run, latest \d{4}-\d{2}-\d{2}\./);
	await expect(stat(page, 'Time series')).toHaveText('2');
	await expect(stat(page, 'Model runs')).toHaveText('1');
	await expect(stat(page, 'Farms')).toHaveText('2+ 1 gauge');
	await expect(stat(page, 'Outflow gauge')).toHaveText('Outflow gauge');
});

test('the latest run: its headline figures, the change from the run before, and a link to it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview latest run');
	await createRun(page.request, project.id, 'Baseline');
	const second = await createRun(page.request, project.id, 'Second');
	await page.goto(`/projects/${project.id}`);

	const latest = page.getByRole('region', { name: 'Latest run', exact: true });
	await expect(latest).toContainText('Second');
	await expect(latest).toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4} – \d{1,2} [A-Z][a-z]{2} \d{4}/);
	await expect(latest).toContainText(/engine \d+\.\d+\.\d+/);
	await expect(latest).toContainText('ran today');
	const card = (term: string) => latest.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) });
	await expect(card('EWR not met')).toContainText('of days');
	await expect(card('Irrigation supplied')).toContainText('of demand');
	await expect(card('Mean simulated outflow')).toContainText('m³/s');
	await expect(latest.locator('dl.stats > div')).toHaveCount(4);
	// Same inputs, so every change is zero, and it says which run it is against.
	await expect(card('Irrigation supplied')).toContainText(/0 pp\s*no change\s*vs previous run/);
	await expect(latest).toContainText('Changes are against the previous run, Baseline.');

	await latest.getByRole('link', { name: 'Open in Runs' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${second}`));
	await expect(page.getByRole('heading', { level: 2, name: 'Second' })).toBeVisible();
});

test('needs attention: stale data links to the Data tab; a project with no runs has no latest-run strip', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview attention');
	await page.goto(`/projects/${project.id}`);
	// The seeded rain ends in January 2022, long before today.
	const panel = page.getByRole('region', { name: 'Needs attention', exact: true });
	await expect(panel).toContainText('The newest recorded rain ends 28 Jan 2022');
	await expect(panel.getByRole('link', { name: 'Add data' })).toHaveAttribute('href', '?tab=series');
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toHaveCount(0);

	await createRun(page.request, project.id, 'Only run');
	await page.reload();
	const latest = page.getByRole('region', { name: 'Latest run', exact: true });
	await expect(latest.locator('dl.stats > div')).toHaveCount(4);
	await expect(latest).not.toContainText('vs previous run');
});

test('the Summary leads with the results once there is a run, the setup checklist before one', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary order');
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
	// No run yet: the checklist is the first thing on the tab, and there is no flow chart.
	await expect(setup(page)).toBeVisible();
	const top = async (name: string | RegExp) => (await page.getByRole('region', { name, exact: typeof name === 'string' }).boundingBox())!.y;
	expect(await top(/^Set(up| up this catchment)/)).toBeLessThan(await top('Needs attention'));
	await expect(page.getByRole('region', { name: 'Flow vs reserve' })).toHaveCount(0);

	await createRun(page.request, project.id, 'Baseline');
	await page.reload();
	const flow = page.getByRole('region', { name: 'Flow vs reserve' });
	await expect(flow.getByRole('img', { name: /^EWR vs simulated outflow: line chart of Simulated outflow/ })).toBeVisible();
	await expect(setup(page).getByRole('heading', { name: 'Setup complete' })).toBeVisible();
	// Latest run, then what needs attention, then the flow chart, then the checklist, then the model's facts.
	const order = [await top('Latest run'), await top('Needs attention'), await top('Flow vs reserve'), await top(/^Set(up| up this catchment)/)];
	expect([...order].sort((a, b) => a - b)).toEqual(order);
	const modelH = (await page.getByRole('heading', { level: 2, name: 'The model' }).boundingBox())!.y;
	expect(modelH).toBeGreaterThan(order[3]!);

	// ?tab=summary is the same page.
	await page.goto(`/projects/${project.id}?tab=summary`);
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toBeVisible();
});

test('each headline fact opens the tab behind it, from anywhere on its tile', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview fact links');
	await page.goto(`/projects/${project.id}`);
	const tabs: [string, string][] = [
		['Farms', 'Network'],
		['Irrigated area', 'Crops & demand'],
		['Active transfers', 'Transfers'],
		['Time series', 'Data'],
		['Model runs', 'Runs & results']
	];
	for (const [term, tab] of tabs) {
		await page.goto(`/projects/${project.id}`);
		// Click the tile's bottom-right corner, away from the label: the link covers the whole tile.
		const tile = page.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) });
		const box = await tile.boundingBox();
		if (!box) throw new Error(`no ${term} tile`);
		await tile.click({ position: { x: box.width - 6, y: box.height - 6 } });
		await expect(page.getByRole('link', { name: tab, exact: true })).toHaveAttribute('aria-current', 'page');
	}
});

test('who has access sits together: Team above Members, in one column beside Project details', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1600, height: 1000 });
	const project = await createProject(page.request, 'Overview access column');
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('region', { name: 'Members', exact: true }).getByRole('rowheader').first()).toBeVisible();
	const details = await page.getByRole('region', { name: 'Project details', exact: true }).boundingBox();
	const team = await page.getByRole('region', { name: 'Team', exact: true }).boundingBox();
	const members = await page.getByRole('region', { name: 'Members', exact: true }).boundingBox();
	if (!details || !team || !members) throw new Error('an Overview panel is missing');
	expect(Math.round(team.x)).toBe(Math.round(members.x));
	expect(team.x).toBeGreaterThan(details.x + details.width);
	expect(team.y + team.height).toBeLessThanOrEqual(members.y);
	expect(Math.round(team.y)).toBe(Math.round(details.y));
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 360, height: 740 } });

	test('the page stacks details, team, members, and a long description shows in full', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Overview phone stack');
		await page.goto(`/projects/${project.id}`);
		const desc = page.getByLabel('Description');
		await desc.fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long catchment description.`).join('\n'));
		// It grows to fit rather than hiding the text behind an inner scrollbar.
		const fits = await desc.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
		expect(fits).toBe(true);

		const ys: number[] = [];
		for (const name of ['Project details', 'Team', 'Members']) {
			const box = await page.getByRole('region', { name, exact: true }).boundingBox();
			if (!box) throw new Error(`${name} missing`);
			ys.push(box.y);
		}
		expect(ys).toEqual([...ys].sort((a, b) => a - b));
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
	});

	test('a long email in a member row wraps at its dots and @, never mid-word', async ({ page }) => {
		// Realistic parts (a short unique tag): one part longer than the column may still break anywhere.
		const tag = `${process.pid}${Date.now()}`.slice(-7);
		const email = `catchment.hydrology-consultant.${tag}@very-long-subdomain.example.com`;
		const res = await page.request.post(`${API_URL}/auth/register`, { data: { email, password: PASSWORD, displayName: 'Long Address' } });
		expect(res.status()).toBe(201);
		const project = await createProject(page.request, 'Long email');
		await page.goto(`/projects/${project.id}`);
		const cell = page.getByRole('region', { name: 'Members' }).getByRole('rowheader', { name: /Long Address/ });
		await expect(cell).toContainText(email);

		// Each part between break points is its own text node; none may span two lines.
		const lines = await cell.locator('.sub-email').evaluate((el) => {
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			const out: { text: string; lines: number }[] = [];
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const r = document.createRange();
				r.selectNodeContents(n);
				const tops = new Set([...r.getClientRects()].map((b) => Math.round(b.top)));
				out.push({ text: n.textContent ?? '', lines: tops.size });
			}
			return { parts: out, height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) };
		});
		expect(lines.parts.map((p) => p.text).join('')).toBe(email);
		expect(lines.height).toBeGreaterThan(lines.lineHeight * 1.5); // it did wrap
		expect(lines.parts.filter((p) => p.lines > 1)).toEqual([]);
	});
});

test('data added from the Overview tab shows up in its counts and checklist straight away', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview upload');
	await page.goto(`/projects/${project.id}`);
	await expect(stat(page, 'Time series')).toHaveText('0');

	await page.getByRole('button', { name: 'Add data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await dialog.getByLabel('Kind').selectOption({ label: 'Rainfall — catchment' });
	await dialog.getByLabel('CSV file').setInputFiles({
		name: 'rain.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,value\n2021-10-01,1\n2021-10-02,0\n2021-10-03,4\n')
	});
	await dialog.getByRole('button', { name: 'Upload' }).click();
	await expect(dialog).toBeHidden();

	await expect(stat(page, 'Time series')).toHaveText('1');
	await expect(setup(page)).toContainText('Rainfall loaded. No observed flow yet');
});
