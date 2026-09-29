// The team portfolio (WP-2.14, docs/ui.md § Portfolio): every catchment of a
// team on one screen with its EWR status in words, where the figures come
// from and how old they are; sortable; cards on a phone; a farmer never gets
// in. axe in both themes, at desktop and phone width.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { DEMO, DROEVLEI, KLEINBERG, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';

const PHONE = { width: 360, height: 740 };

interface Row {
	id: string;
	name: string;
	ewr: { status: 'green' | 'amber' | 'red' | 'unknown'; daysNotMet30: number | null; days30: number | null };
}

/** A team of three catchments (published, run only, empty) and a personal project that must stay out. */
async function arrange(request: APIRequestContext, tag: string) {
	const team = (await (await request.post(`${API_URL}/teams`, { data: { name: `Portfolio WUA ${tag}` } })).json()).team as { id: string };
	const toTeam = async (id: string) => expect((await request.patch(`${API_URL}/projects/${id}`, { data: { teamId: team.id } })).status()).toBe(200);
	const published = await seedRunnableProject(request, `Pf published ${tag}`);
	await toTeam(published.id);
	const runId = await createRun(request, published.id, 'Baseline');
	const pub = await request.post(`${API_URL}/projects/${published.id}/publication`, { data: { runId, restriction: { level: 'advisory', pct: 15 } } });
	expect(pub.status(), await pub.text()).toBe(201);
	const runOnly = await seedRunnableProject(request, `Pf run only ${tag}`);
	await toTeam(runOnly.id);
	await createRun(request, runOnly.id, 'Draft');
	const empty = (await (await request.post(`${API_URL}/projects`, { data: { name: `Pf empty ${tag}`, teamId: team.id } })).json()).project as { id: string };
	await createProject(request, `Pf personal ${tag}`);
	const rows = (await (await request.get(`${API_URL}/teams/${team.id}/portfolio`)).json()).projects as Row[];
	return { team, published, runOnly, empty, rows, farmId: published.model.nodes.find((n) => n.kind === 'farm')!.id as string };
}

const LABEL = { red: 'Red', amber: 'Amber', green: 'Green' } as const;
/** What the page must say for a known status. */
const statusText = (r: Row) =>
	r.ewr.status === 'unknown' ? null : r.ewr.daysNotMet30 ? `${LABEL[r.ewr.status]}: EWR not met ${r.ewr.daysNotMet30} of ${r.ewr.days30} days` : `${LABEL[r.ewr.status]}: EWR met all ${r.ewr.days30} days`;

const tableRow = (page: Page, name: string) => page.getByRole('table').getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${name}`) }) });

test('a WUA sees every team catchment with its status, where the figures come from and how old they are', async ({ page, owner }) => {
	void owner;
	const a = await arrange(page.request, 'A');
	const pubRow = a.rows.find((r) => r.id === a.published.id)!;
	expect(pubRow.ewr.status).not.toBe('unknown');

	// From the team page.
	await page.goto(`/teams/${a.team.id}`);
	await page.getByRole('link', { name: /^Portfolio/ }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Portfolio WUA A: portfolio' })).toBeVisible();
	const table = page.getByRole('table', { name: 'Catchments of Portfolio WUA A' });
	await expect(table.getByRole('rowheader')).toHaveCount(3);
	await expect(page.getByText('Pf personal A')).toHaveCount(0);

	// Published: the status in words, the source, the age, the restriction, and the farms link to the Runs tab.
	const pr = tableRow(page, 'Pf published A');
	await expect(pr).toContainText(statusText(pubRow)!);
	await expect(pr).toContainText('Published run');
	// The seeded rain ends on 28 Jan 2022: the one age wording, and dates, not "this week" (issue #162).
	await expect(pr).toContainText(/Figures to 28 Jan 2022 \(\d+ years ago\)/);
	await expect(pr).toContainText('Stale: over 7 days old');
	await expect(pr).toContainText('Advisory · 15 %');
	await expect(pr).toContainText(/\d+ of \d+ hydrological units? short in the week to 28 Jan 2022/);
	await expect(pr).toContainText(/Rain to 28 Jan 2022 \(\d+ years ago\)/);
	await expect(page.getByRole('columnheader', { name: /^EWR, 30 days to 28 Jan 2022/ })).toBeVisible();

	// Run only: the EWR from the run, farms and dams honestly unknown.
	const rr = tableRow(page, 'Pf run only A');
	await expect(rr).toContainText('Latest run, not published');
	await expect(rr).toContainText('Unknown until a run is published');
	await expect(rr).toContainText('Not published');

	// Nothing run: unknown, and why.
	const er = tableRow(page, 'Pf empty A');
	await expect(er).toContainText('Unknown: no run yet');
	await expect(er).toContainText('Not run yet');
	await expect(er).toContainText('No rain yet');

	// The row opens the project.
	await pr.getByRole('link', { name: 'Pf published A' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${a.published.id}$`));
});

test('the page states which thresholds apply, and judges by the team’s once an admin sets them', async ({ page, owner }) => {
	void owner;
	const a = await arrange(page.request, 'T');
	const pub = a.rows.find((r) => r.id === a.published.id)!;
	expect(pub.ewr.status).not.toBe('unknown');
	const d = pub.ewr.daysNotMet30!;
	const n = pub.ewr.days30!;

	await page.goto(`/teams/${a.team.id}/portfolio`);
	await expect(page.getByText(/green when it was not met on under 5 % of them, amber under 20 %, red otherwise/)).toBeVisible();
	await expect(page.getByText('These are the default thresholds, still to be confirmed by the hydrologist.')).toBeVisible();
	await expect(tableRow(page, 'Pf published T')).toContainText(statusText(pub)!);

	// Thresholds that move the published row where they can: a default green becomes amber
	// under a 0 % green, anything short of every day becomes green under 99.9 %; a row that
	// missed every day is red under any thresholds.
	const t = d === n ? { green: 1, amber: 2 } : d * 100 < 5 * n ? { green: 0, amber: 100 } : { green: 99.9, amber: 100 };
	await page.getByRole('link', { name: 'Change them on the team page' }).click();
	const panel = page.getByRole('region', { name: 'Portfolio traffic lights' });
	await panel.getByLabel('Green below (%)').fill(String(t.green));
	await panel.getByLabel('Amber below (%)').fill(String(t.amber));
	await panel.getByRole('button', { name: 'Save thresholds' }).click();
	await expect(panel.getByRole('status')).toHaveText('Saved. The portfolio now uses these thresholds.');

	const after = (await (await page.request.get(`${API_URL}/teams/${a.team.id}/portfolio`)).json()) as { thresholds: unknown; projects: Row[] };
	expect(after.thresholds).toEqual({ ...t, source: 'team' });
	const now = after.projects.find((r) => r.id === a.published.id)!;
	const expected = d * 100 < t.green * n ? 'green' : d * 100 < t.amber * n ? 'amber' : 'red';
	expect(now.ewr.status).toBe(expected);
	if (d < n) expect(now.ewr.status).not.toBe(pub.ewr.status);

	await page.goto(`/teams/${a.team.id}/portfolio`);
	await expect(page.getByText(`green when it was not met on under ${String(t.green)} % of them, amber under ${String(t.amber)} %, red otherwise`, { exact: false })).toBeVisible();
	await expect(page.getByText('These are the team’s own thresholds.')).toBeVisible();
	await expect(tableRow(page, 'Pf published T')).toContainText(statusText(now)!);
});

// The link lands on the table, not the top of Units & supply (docs/followups.md;
// the Runs tab before issue #17): the panels render after the run's details
// load, past the browser's own jump, so the page scrolls there itself and moves
// focus to the table's heading.
test('“hydrological units short in the week to …” opens Hydrological units at the curtailment table, over the last 7 days; an old Runs link lands there too', async ({ page, owner }) => {
	void owner;
	// A published team catchment whose orchards are far too big for the water: its farms go short.
	const request = page.request;
	const team = (await (await request.post(`${API_URL}/teams`, { data: { name: 'Portfolio WUA D' } })).json()).team as { id: string };
	const project = await seedRunnableProject(request, 'Pf short D');
	await putModel(request, project.id, { ...project.model, cropAreas: project.model.cropAreas.map((c) => ({ ...c, areaM2: c.areaM2 * 50 })) });
	expect((await request.patch(`${API_URL}/projects/${project.id}`, { data: { teamId: team.id } })).status()).toBe(200);
	const runId = await createRun(request, project.id, 'Baseline');
	expect((await request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	const rows = (await (await request.get(`${API_URL}/teams/${team.id}/portfolio`)).json()).projects as { farmsShort7: number | null }[];
	expect(rows[0]!.farmsShort7).toBeGreaterThan(0);

	const panel = page.locator('#res-curtailment');
	const heading = panel.getByRole('heading', { name: 'Curtailment targets' });
	/** The panel's top sits in the upper half of the screen, below the cards and the chart that fill the first screen. */
	const landed = async () => {
		await expect(panel.getByTestId('curtailment-period')).toHaveText(/^Last 7 days: daily averages over /);
		await expect(heading).toBeFocused();
		await expect(panel).toBeInViewport();
		await expect.poll(async () => (await panel.boundingBox())!.y).toBeGreaterThanOrEqual(-1);
		expect((await panel.boundingBox())!.y).toBeLessThan(page.viewportSize()!.height / 2);
		expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
	};

	await page.goto(`/teams/${team.id}/portfolio`);
	await tableRow(page, 'Pf short D').getByRole('link', { name: /units? short in the week to 28 Jan 2022$/ }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=supply&run=${runId}&window=last7#res-curtailment$`));
	await expect(page.getByRole('heading', { level: 1, name: 'Hydrological units' })).toBeVisible();
	await landed();

	// Opened afresh (a bookmark, a new tab): the same.
	await page.reload();
	await landed();

	// A bookmark of the old link, to the Runs tab: sent on to the same panel, window kept, the old address replaced.
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}&window=last7#res-curtailment`);
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=supply&run=${runId}&window=last7#res-curtailment$`));
	await landed();
});

test('sorts by status (worst first) and by name, and keeps the sort in the address', async ({ page, owner }) => {
	void owner;
	const a = await arrange(page.request, 'B');
	const RANK = { red: 0, amber: 1, unknown: 2, green: 3 } as const;
	const worstFirst = [...a.rows]
		.sort((x, y) => RANK[x.ewr.status] - RANK[y.ewr.status] || (y.ewr.daysNotMet30 ?? 0) / (y.ewr.days30 || 1) - (x.ewr.daysNotMet30 ?? 0) / (x.ewr.days30 || 1) || x.name.localeCompare(y.name))
		.map((r) => r.name);

	await page.goto(`/teams/${a.team.id}/portfolio`);
	const heads = page.getByRole('table').getByRole('rowheader').getByRole('link');
	await expect(heads).toHaveText(worstFirst);
	// Every catchment with figures ends on 28 Jan 2022: the heading names it rather than "last 30 days".
	const statusHead = page.getByRole('columnheader', { name: /^EWR, 30 days to 28 Jan 2022/ });
	await expect(statusHead).toHaveAttribute('aria-sort', 'ascending');

	await page.getByRole('button', { name: /^Catchment/ }).click();
	await expect(page).toHaveURL(/[?&]sort=name/);
	await expect(heads).toHaveText(['Pf empty B', 'Pf published B', 'Pf run only B']);
	await expect(page.getByRole('columnheader', { name: /^Catchment/ })).toHaveAttribute('aria-sort', 'ascending');
	await page.getByRole('button', { name: /^Catchment/ }).click();
	await expect(page).toHaveURL(/[?&]dir=desc/);
	await expect(heads).toHaveText(['Pf run only B', 'Pf published B', 'Pf empty B']);

	// A reload keeps it; the status heading flips back to worst first.
	await page.reload();
	await expect(heads).toHaveText(['Pf run only B', 'Pf published B', 'Pf empty B']);
	await page.getByRole('button', { name: /^EWR, 30 days to 28 Jan 2022/ }).click();
	await expect(heads).toHaveText(worstFirst);
	await expect(page).not.toHaveURL(/sort=/);
});

test('a farmer on a team catchment is sent to their farm, never the portfolio', async ({ page, owner, signIn }) => {
	void owner;
	const a = await arrange(page.request, 'C');
	const farmer = await signIn('Portfolio farmer');
	const add = await page.request.post(`${API_URL}/projects/${a.published.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [a.farmId] } });
	expect(add.status(), await add.text()).toBe(201);
	expect((await farmer.page.request.get(`${API_URL}/teams/${a.team.id}/portfolio`)).status()).toBe(404);
	await farmer.page.goto(`/teams/${a.team.id}/portfolio`);
	await expect(farmer.page).toHaveURL(new RegExp(`/farm/${a.published.id}`));
});

test('the demo team shows its two examples, not the analyst’s own catchment', async ({ page }) => {
	test.setTimeout(120_000);
	await seedExamplesOnce(page.request);
	expect((await page.request.post(`${API_URL}/auth/login`, { data: DEMO })).status()).toBe(200);
	const teams = (await (await page.request.get(`${API_URL}/teams`)).json()).teams as { id: string; name: string }[];
	const demo = teams.find((t) => t.name === 'Demo Catchment Consultants')!;
	await page.goto('/');
	await page.getByRole('region', { name: 'Demo Catchment Consultants' }).getByRole('link', { name: 'Portfolio' }).click();
	await expect(page).toHaveURL(new RegExp(`/teams/${demo.id}/portfolio`));
	for (const name of [KLEINBERG, DROEVLEI]) {
		const row = tableRow(page, name.replace(/[()]/g, '\\$&'));
		await expect(row).toContainText(/(Red|Amber|Green): EWR (not met \d+ of 30 days|met all 30 days)|Unknown: /);
		await expect(row).toContainText('Published run');
	}
	await expect(page.getByRole('rowheader', { name: SANDSPRUIT })).toHaveCount(0);
});

// A dashboard (issue #17): on a wide screen the table takes the height left in
// the window and scrolls inside, header row stuck; the page itself doesn't scroll.
for (const viewport of [
	{ width: 1440, height: 960 },
	{ width: 1280, height: 800 }
]) {
	test.describe(`${viewport.width}×${viewport.height}`, () => {
		test.use({ viewport });

		test('the portfolio fits the window: no page scroll, the table reaching its bottom', async ({ page, owner }) => {
			void owner;
			const a = await arrange(page.request, `fit ${viewport.width}`);
			await page.goto(`/teams/${a.team.id}/portfolio`);
			await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(3);
			await expect(page.getByText(/^3 catchments: /)).toBeVisible();
			const wrap = page.locator('.fill .table-wrap');
			// Measured after layout settles: the box ends within the page's 1rem bottom margin.
			await expect.poll(async () => viewport.height - (await wrap.boundingBox())!.y - (await wrap.boundingBox())!.height).toBeLessThanOrEqual(20);
			const [scrollH, innerH] = await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight]);
			expect(scrollH).toBeLessThanOrEqual(innerH);
			expect(await wrap.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
			expect(await page.locator('table.portfolio thead').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
			// The phone cards stay out on a wide screen.
			await expect(page.getByRole('list', { name: /^Catchments of/ })).toBeHidden();
		});
	});
}

// axe on the portfolio in both themes, at desktop (the table) and phone width (the cards).
for (const colorScheme of ['light', 'dark'] as const) {
	for (const [sizeName, viewport] of [
		['desktop', { width: 1280, height: 800 }],
		['phone', PHONE]
	] as const) {
		test.describe(`${colorScheme}, ${sizeName}`, () => {
			test.use({ colorScheme, viewport });

			test('the portfolio has no WCAG 2.2 AA violations', async ({ page, owner }) => {
				void owner;
				const a = await arrange(page.request, `axe ${colorScheme} ${sizeName}`);
				await page.goto(`/teams/${a.team.id}/portfolio`);
				await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
				if (sizeName === 'phone') {
					const cards = page.getByRole('list', { name: /^Catchments of/ });
					await expect(cards.getByRole('listitem')).toHaveCount(3);
					await expect(page.getByRole('table')).toBeHidden();
					await expect(page.getByLabel('Sort by')).toBeVisible();
					const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
					expect(scroll).toBeLessThanOrEqual(inner);
				} else {
					await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(3);
				}
				await expectNoViolations(page);
			});
		});
	}
}
