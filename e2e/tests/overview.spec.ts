// The Summary tab (id `overview`, issue #17): results, setup checklist and headline facts, built from the lists
// the project page loads (series, runs) and the model being edited.
import type { Page } from '@playwright/test';
import { createProject, createRun, PASSWORD, putModel, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
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

	// Which run it is: the section header's context line (issue #17), under the Summary title.
	const context = page.getByTestId('section-context');
	await expect(context).toContainText('Second');
	await expect(context).toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4} – \d{1,2} [A-Z][a-z]{2} \d{4}/);
	await expect(context).toContainText(/engine \d+\.\d+\.\d+/);
	await expect(context).toContainText('ran today');
	const latest = page.getByRole('region', { name: 'Latest run', exact: true });
	const card = (term: string) => latest.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) });
	await expect(card('EWR not met')).toContainText('of days');
	await expect(card('Irrigation supplied')).toContainText('of demand');
	await expect(card('Dams today')).toContainText(/\d+%full/);
	await expect(latest.locator('dl.stats > div')).toHaveCount(4);
	// Reserve · Irrigation supplied · Dams today · NSE, in that order; the mean outflow is the line under them.
	await expect(latest.locator('dl.stats > div > dt')).toContainText(['EWR not met', 'Irrigation supplied', 'Dams today', 'Calibration NSE']);
	await expect(latest.locator('[data-headline="outflow"]')).toContainText(/Mean simulated outflow [\d.]+ m³\/s \(\d+% of natural\), 0\s*no change\s*vs previous run\./);
	// Same inputs, so every change is zero, and it says which run it is against.
	await expect(card('Irrigation supplied')).toContainText(/0 pp\s*no change\s*vs previous run/);
	await expect(latest).toContainText('Changes are against the previous run, Baseline.');

	await context.getByRole('link', { name: 'Open in Runs' }).click();
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
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Summary order');
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
	// No run yet: the checklist is the first thing on the tab, and there is no KPI row or flow chart.
	await expect(setup(page)).toBeVisible();
	const box = async (name: string | RegExp) => (await page.getByRole('region', { name, exact: typeof name === 'string' }).boundingBox())!;
	expect((await box(/^Set(up| up this catchment)/)).y).toBeLessThan((await box('Needs attention')).y);
	await expect(page.getByRole('region', { name: 'Flow vs reserve' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toHaveCount(0);

	await createRun(page.request, project.id, 'Baseline');
	await page.reload();
	const flow = page.getByRole('region', { name: 'Flow vs reserve' });
	await expect(flow.getByRole('img', { name: /^EWR vs simulated outflow: line chart of Simulated outflow/ })).toBeVisible();
	await expect(flow.locator('figure.chart')).toHaveAttribute('data-ready', 'true');
	await expect(setup(page).getByRole('heading', { name: 'Setup complete' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Dam levels' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Supply by farm' })).toBeVisible();

	// First screen (board A1): the KPI row, then the chart on the left, Needs attention above Supply by farm on the right.
	const kpis = await box('Latest run');
	const chart = await box('Flow vs reserve');
	const attention = await box('Needs attention');
	const supply = await box('Supply by farm');
	expect(chart.y).toBeGreaterThan(kpis.y + kpis.height - 1);
	expect(attention.x).toBeGreaterThan(chart.x + chart.width);
	expect(Math.abs(attention.y - chart.y)).toBeLessThan(2);
	expect(supply.y).toBeGreaterThan(attention.y + attention.height - 1);
	expect(Math.round(supply.x)).toBe(Math.round(attention.x));
	// It fits the window: the chart and the side column end inside it, on one bottom edge, and fill it.
	const vh = page.viewportSize()!.height;
	expect(chart.y + chart.height).toBeLessThanOrEqual(vh);
	expect(Math.abs(chart.y + chart.height - (supply.y + supply.height))).toBeLessThan(2);
	expect(chart.y + chart.height).toBeGreaterThan(vh - 40);
	expect(chart.height).toBeGreaterThan(450);

	// Below it, in order: alerts, the published baseline, dam levels, the checklist, then the model's facts.
	const below = [
		chart.y + chart.height,
		(await box('Active alerts')).y,
		(await box('Published baseline')).y,
		(await box('Dam levels')).y,
		(await box(/^Set(up| up this catchment)/)).y
	];
	expect([...below].sort((a, b) => a - b)).toEqual(below);
	const modelH = (await page.getByRole('heading', { level: 2, name: 'The model' }).boundingBox())!.y;
	expect(modelH).toBeGreaterThan(below[4]!);

	// ?tab=summary is the same page.
	await page.goto(`/projects/${project.id}?tab=summary`);
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toBeVisible();
});

test('the flow chart: 30 days / 1 year / All, and the days below the reserve shaded', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary flow chart');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const flow = page.getByRole('region', { name: 'Flow vs reserve' });
	const fig = flow.locator('figure.chart');
	await expect(fig).toHaveAttribute('data-ready', 'true');
	const windows = flow.getByRole('group', { name: 'Time window' });
	// The run is 120 days (1 Oct 2021 – 28 Jan 2022): a year shows all of it, and the chart opens on it.
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true');
	await expect(fig).toHaveAttribute('data-view-start', '2021-10-01');
	await expect(fig).toHaveAttribute('data-view-end', '2022-01-28');
	await windows.getByRole('button', { name: '30 days' }).click();
	await expect(fig).toHaveAttribute('data-view-start', '2021-12-29');
	await expect(fig).toHaveAttribute('data-view-end', '2022-01-28');
	await expect(windows.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'false');
	await windows.getByRole('button', { name: 'All' }).click();
	await expect(fig).toHaveAttribute('data-view-start', '2021-10-01');
	await expect(windows.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

	// The shaded days are the run's own EWR-not-met days: the caption's count is the KPI card's.
	await expect(fig).toHaveAttribute('data-shaded', /^\d+$/);
	const card = page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="ewr"]');
	const notMet = /(\d+) of 120 days/.exec((await card.textContent()) ?? '')![1];
	await expect(fig).toContainText(`Shaded: the ${notMet} days the outflow was below the dashed EWR line (EWR not met).`);
});

test('needs attention cards and supply by farm: coloured by how much it matters, each farm opens its drawer', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary side column');
	// Plant far more on Lower farm than its water can serve, so it comes up short.
	const model = { ...project.model, cropAreas: project.model.cropAreas.map((a, i) => (i === 1 ? { ...a, areaM2: 3_000_000 } : a)) };
	await putModel(page.request, project.id, model);
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);

	const attention = page.getByRole('region', { name: 'Needs attention', exact: true });
	const short = attention.locator('[data-attention="short-farms"]');
	await expect(short).toContainText('1 of 2 farms below 95%');
	await expect(short).toContainText(/Lower farm got \d+% of its demand in the latest run/);
	await expect(short).toHaveAttribute('data-tone', /^(danger|warning)$/);
	await expect(attention.locator('[data-attention="stale-data"]')).toHaveAttribute('data-tone', 'warning');

	const supply = page.getByRole('region', { name: 'Supply by farm' });
	const rows = supply.getByRole('listitem');
	await expect(rows).toHaveCount(2);
	// Fullest first, emptiest last, in the Network's supply bands, with a key to them.
	await expect(rows.first()).toContainText('Upper farm');
	await expect(rows.last()).toContainText('Lower farm');
	await expect(rows.last()).toHaveAttribute('data-band', /^(short|low)$/);
	const pcts = await rows.evaluateAll((lis) => lis.map((li) => parseFloat(li.querySelector('.pct')!.textContent!)));
	expect(pcts[0]!).toBeGreaterThan(pcts[1]!);
	await expect(supply).toContainText(/supplied/);

	// A farm's name opens its planted areas over the Summary.
	await rows.last().getByRole('link', { name: 'Lower farm' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?farm=${project.model.nodes[2]!.id}$`));
	await expect(page.getByRole('dialog', { name: 'Lower farm: planted areas' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// The whole card is the link: a click on its detail follows the main action.
	await short.click({ position: { x: 16, y: 34 } });
	await expect(page).toHaveURL(/[?&]tab=runs&run=/);
});

test.describe('the first screen has no accessibility violations', () => {
	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 960 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		test(label, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize(viewport);
			const project = await seedRunnableProject(page.request, `Summary a11y ${label}`);
			await createRun(page.request, project.id, 'Baseline');
			await createRun(page.request, project.id, 'Second');
			await page.goto(`/projects/${project.id}`);
			await expect(page.getByRole('region', { name: 'Flow vs reserve' }).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
			await expect(page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="dams"]')).toContainText('full');
			await expect(page.getByRole('region', { name: 'Supply by farm' })).toBeVisible();
			if (label === 'phone') expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
			await expectNoViolations(page);
		});
	}
});

test('dam levels: every dam in the latest run, emptiest first, with its end-of-run and lowest level', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary dams');
	const run = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);

	const dams = page.getByRole('region', { name: 'Dam levels' });
	const rows = dams.getByRole('row').filter({ has: page.getByRole('rowheader') });
	// The two farm dams; the outflow gauge has none.
	await expect(rows).toHaveCount(2);
	await expect(rows.getByRole('rowheader')).toContainText([/Upper farm|Lower farm/, /Upper farm|Lower farm/]);
	await expect(rows.first().getByRole('rowheader')).toContainText(/\d{2},000 m³/);
	const ends = await rows.evaluateAll((trs) => trs.map((tr) => parseFloat(tr.querySelectorAll('td')[0]!.textContent!)));
	expect(ends.every((v) => v >= 0 && v <= 100)).toBe(true);
	expect([...ends].sort((a, b) => a - b)).toEqual(ends);
	await expect(rows.first().locator('td').nth(1)).toContainText(/\d+% · \d{1,2} [A-Z][a-z]{2} \d{4}/);
	await expect(dams.getByRole('link', { name: 'Open in Runs' })).toHaveAttribute('href', `?tab=runs&run=${run}`);
	// Dams today on the KPI row is every dam together, weighted by capacity (150 000 and 90 000 m³).
	const today = page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="dams"]');
	await expect(today).toContainText('2 dams on 28 Jan 2022');
	await expect(today).toContainText(/in 30 days/);
	const caps = await rows.evaluateAll((trs) => trs.map((tr) => parseFloat(tr.querySelector('th .cap')!.textContent!.replace(/,/g, ''))));
	const weighted = (ends[0]! * caps[0]! + ends[1]! * caps[1]!) / (caps[0]! + caps[1]!);
	const shownPct = parseFloat((await today.locator('dd.value').textContent())!);
	expect(Math.abs(shownPct - weighted)).toBeLessThanOrEqual(1);
	// Below the flow chart, above the setup checklist.
	const top = async (name: string | RegExp) => (await page.getByRole('region', { name }).boundingBox())!.y;
	expect(await top('Dam levels')).toBeGreaterThan(await top('Flow vs reserve'));
	expect(await top('Dam levels')).toBeLessThan(await top(/^Set(up| up this catchment)/));
	await expectNoViolations(page);
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
