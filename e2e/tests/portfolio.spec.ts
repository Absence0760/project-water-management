// A team's portfolio is the project list filtered to the team (issue #176,
// docs/ui.md § Project list; WP-2.14 built it as its own page): every catchment
// of the team with its EWR status in words, where the figures come from and
// how old they are, the restriction and the alerts firing, the rule the
// statuses were judged by and whose it is; sortable both ways; old
// `/teams/:id/portfolio` links land on it; a farmer never gets in. Layout at
// 1440 and 1280 with thirty catchments, axe in both themes at desktop and
// phone width.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { acceptInvites, createProject, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { plantFiringAlert } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { DEMO, DROEVLEI, KLEINBERG, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { outcomesReady, row } from '../support/projects.ts';

const PHONE = { width: 360, height: 740 };

interface Row {
	id: string;
	name: string;
	ewr: { status: 'green' | 'amber' | 'red' | 'unknown'; daysNotMet30: number | null; days30: number | null };
}

/**
 * A team of three catchments (published with a restriction and a firing alert, run only, empty),
 * `extra` more empty ones, and a personal project that must stay out.
 */
async function arrange(request: APIRequestContext, tag: string, extra = 0) {
	const team = (await (await request.post(`${API_URL}/teams`, { data: { name: `Portfolio WUA ${tag}` } })).json()).team as { id: string };
	const toTeam = async (id: string) => expect((await request.patch(`${API_URL}/projects/${id}`, { data: { teamId: team.id } })).status()).toBe(200);
	const published = await seedRunnableProject(request, `Pf published ${tag}`);
	await toTeam(published.id);
	const runId = await createRun(request, published.id, 'Baseline');
	const pub = await request.post(`${API_URL}/projects/${published.id}/publication`, { data: { runId, restriction: { level: 'advisory', pct: 15 } } });
	expect(pub.status(), await pub.text()).toBe(201);
	await plantFiringAlert(published.id);
	const runOnly = await seedRunnableProject(request, `Pf run only ${tag}`);
	await toTeam(runOnly.id);
	await createRun(request, runOnly.id, 'Draft');
	const empty = (await (await request.post(`${API_URL}/projects`, { data: { name: `Pf empty ${tag}`, teamId: team.id } })).json()).project as { id: string };
	await Promise.all(
		Array.from({ length: extra }, (_, i) =>
			request.post(`${API_URL}/projects`, { data: { name: `Pf scoping ${tag} ${String(i + 1).padStart(2, '0')}`, teamId: team.id } })
		)
	);
	await createProject(request, `Pf personal ${tag}`);
	const rows = (await (await request.get(`${API_URL}/teams/${team.id}/portfolio`)).json()).projects as Row[];
	return { team, published, runOnly, empty, rows, farmId: published.model.nodes.find((n) => n.kind === 'farm')!.id as string };
}

const LABEL = { red: 'Red', amber: 'Amber', green: 'Green' } as const;
/** What the page must say for a known status. */
const statusText = (r: Row) =>
	r.ewr.status === 'unknown' ? null : r.ewr.daysNotMet30 ? `${LABEL[r.ewr.status]}: EWR not met ${r.ewr.daysNotMet30} of ${r.ewr.days30} days` : `${LABEL[r.ewr.status]}: EWR met all ${r.ewr.days30} days`;

const teamUrl = (teamId: string) => new RegExp(`/\\?owner=team(%3A|:)${teamId}&sort=status$`);
const heads = (page: Page) => page.getByRole('table').getByRole('rowheader');
/** The rows' project names, in order (a row header also holds the figures folded under the name). */
const names = (page: Page) => page.locator('table.projects tbody th a.name');

test('a WUA sees every team catchment with its status, where the figures come from, how old they are, the restriction and the alerts', async ({ page, owner }) => {
	void owner;
	const a = await arrange(page.request, 'A');
	const pubRow = a.rows.find((r) => r.id === a.published.id)!;
	expect(pubRow.ewr.status).not.toBe('unknown');

	// From the team page: the project list, filtered to the team, worst EWR first.
	await page.goto(`/teams/${a.team.id}`);
	await page.getByRole('link', { name: 'Project list', exact: true }).click();
	await expect(page).toHaveURL(teamUrl(a.team.id));
	await outcomesReady(page);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects');
	await expect(page).toHaveTitle('Portfolio WUA A · Projects · Water Management');
	await expect(page.getByRole('navigation', { name: 'Filter by owner' }).getByRole('link', { name: /^Portfolio WUA A 3$/ })).toHaveAttribute('aria-current', 'true');
	await expect(heads(page)).toHaveCount(3);
	await expect(page.getByText('Pf personal A')).toHaveCount(0);
	// The tiles' counts in the header's one line: the statuses, the alert firing, the stale figures.
	await expect(page.getByTestId('projects-context')).toHaveText(/^\s*3 catchments · EWR, 30 days to 28 Jan 2022: .+ · 1 alert firing · 2 with stale figures\s*$/);

	// Published: the status in words, the source, the age, the restriction, the alerts, and the units link.
	const pr = row(page, 'Pf published A');
	await expect(pr.locator('td.c-ewr')).toContainText(statusText(pubRow)!);
	// The seeded rain ends on 28 Jan 2022: the one age wording, and dates, not "this week" (issue #162).
	await expect(pr.locator('td.c-ewr')).toContainText(/Published · to 28 Jan 2022 \(\d+ years ago\)/);
	await expect(pr.locator('td.c-dam')).toContainText('Restriction: Advisory · 15 %');
	await expect(pr.locator('td.c-units')).toContainText(/\d+ of \d+ hydrological units? short in the week to 28 Jan 2022/);
	await expect(pr.locator('td.c-units')).toContainText(/\d+ in the 30 days to 28 Jan 2022/);
	await expect(pr.locator('td.c-data')).toContainText(/Rain to 28 Jan 2022 \(\d+ years ago\)/);
	await expect(pr.locator('td.c-alerts')).toHaveText('1 firing');
	await expect(page.getByRole('columnheader', { name: /^EWR, 30 days to 28 Jan 2022/ })).toHaveAttribute('aria-sort', 'ascending');

	// Run only: the EWR from the run, units, dams and the restriction honestly not published.
	const rr = row(page, 'Pf run only A');
	await expect(rr.locator('td.c-ewr')).toContainText('Latest run · to 28 Jan 2022');
	await expect(rr.locator('td.c-units')).toHaveText('Not published');
	await expect(rr.locator('td.c-dam')).toHaveText('Not published');
	await expect(rr.locator('td.c-alerts')).toHaveText('None');

	// Nothing run: unknown, and why.
	const er = row(page, 'Pf empty A');
	await expect(er.locator('td.c-ewr')).toHaveText('Unknown: no run yet');
	await expect(er.locator('td.c-run')).toHaveText('Not run yet');
	await expect(er.locator('td.c-data')).toContainText('No rain yet');

	// The row opens the project.
	await pr.getByRole('link', { name: 'Pf published A', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${a.published.id}$`));
});

test('the team filter states which thresholds apply, and judges by the team’s once an admin sets them; a viewer is told who can', async ({ page, owner, signIn }) => {
	void owner;
	const a = await arrange(page.request, 'T');
	const pub = a.rows.find((r) => r.id === a.published.id)!;
	expect(pub.ewr.status).not.toBe('unknown');
	const d = pub.ewr.daysNotMet30!;
	const n = pub.ewr.days30!;

	await page.goto(`/?owner=team:${a.team.id}`);
	await outcomesReady(page);
	const note = page.getByTestId('team-thresholds');
	await expect(note).toContainText('green when it was not met on under 5 % of them, amber under 20 %, red otherwise');
	await expect(note).toContainText('These are the default thresholds: a provisional default, not yet confirmed by the catchment’s hydrologist.');
	await expect(row(page, 'Pf published T').locator('td.c-ewr')).toContainText(statusText(pub)!);

	// A team viewer reads the same rule, and who can change it.
	const viewer = await signIn('Portfolio viewer');
	expect((await page.request.post(`${API_URL}/teams/${a.team.id}/members`, { data: { email: viewer.user.email, role: 'viewer' } })).status()).toBe(201);
	await acceptInvites(viewer.user.email, a.team.id);
	await viewer.page.goto(`/teams/${a.team.id}/portfolio`);
	await expect(viewer.page).toHaveURL(teamUrl(a.team.id));
	await expect(viewer.page.getByTestId('team-thresholds')).toContainText('A team owner can change them on the team page.');
	await expect(viewer.page.getByRole('link', { name: 'Change them on the team page' })).toHaveCount(0);
	await expect(viewer.page.getByRole('table').getByRole('rowheader')).toHaveCount(3);

	// Thresholds that move the published row where they can: a default green becomes amber
	// under a 0 % green, anything short of every day becomes green under 99.9 %; a row that
	// missed every day is red under any thresholds.
	const t = d === n ? { green: 1, amber: 2 } : d * 100 < 5 * n ? { green: 0, amber: 100 } : { green: 99.9, amber: 100 };
	await note.getByRole('link', { name: 'Change them on the team page' }).click();
	const panel = page.getByRole('region', { name: 'EWR traffic lights' });
	await panel.getByLabel('Green below (%)').fill(String(t.green));
	await panel.getByLabel('Amber below (%)').fill(String(t.amber));
	await panel.getByRole('button', { name: 'Save thresholds' }).click();
	await expect(panel.getByRole('status')).toHaveText('Saved. The team’s projects are now judged by these thresholds.');

	const after = (await (await page.request.get(`${API_URL}/teams/${a.team.id}/portfolio`)).json()) as { thresholds: unknown; projects: Row[] };
	expect(after.thresholds).toEqual({ ...t, source: 'team' });
	const now = after.projects.find((r) => r.id === a.published.id)!;
	const expected = d * 100 < t.green * n ? 'green' : d * 100 < t.amber * n ? 'amber' : 'red';
	expect(now.ewr.status).toBe(expected);
	if (d < n) expect(now.ewr.status).not.toBe(pub.ewr.status);

	// The panel links back to the list, which judges by them now (GET /projects/outcomes reads the team's).
	await panel.getByRole('link', { name: 'project list' }).click();
	await expect(page).toHaveURL(teamUrl(a.team.id));
	await outcomesReady(page);
	await expect(note).toContainText(`green when it was not met on under ${String(t.green)} % of them, amber under ${String(t.amber)} %, red otherwise`);
	await expect(note).toContainText('These are the team’s own thresholds.');
	await expect(row(page, 'Pf published T').locator('td.c-ewr')).toContainText(statusText(now)!);
});

// The link lands on the table, not the top of Hydrological units (docs/followups.md;
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

	await page.goto(`/?owner=team:${team.id}`);
	await outcomesReady(page);
	await row(page, 'Pf short D').getByRole('link', { name: /units? short in the week to 28 Jan 2022$/ }).click();
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

test('an old portfolio link lands on the team filter, worst first; headings sort both ways and the sort stays in the address', async ({ page, owner }) => {
	void owner;
	const a = await arrange(page.request, 'B');
	const RANK = { red: 0, amber: 1, unknown: 2, green: 3 } as const;
	const worstFirst = [...a.rows]
		.sort((x, y) => RANK[x.ewr.status] - RANK[y.ewr.status] || (y.ewr.daysNotMet30 ?? 0) / (y.ewr.days30 || 1) - (x.ewr.daysNotMet30 ?? 0) / (x.ewr.days30 || 1) || x.name.localeCompare(y.name))
		.map((r) => r.name);

	// The old address is replaced, so Back doesn't bounce off it.
	await page.goto('/teams');
	await page.goto(`/teams/${a.team.id}/portfolio`);
	await expect(page).toHaveURL(teamUrl(a.team.id));
	await outcomesReady(page);
	await expect(names(page)).toHaveText(worstFirst);
	// Every catchment with figures ends on 28 Jan 2022: the heading names it rather than "last 30 days".
	const statusHead = page.getByRole('columnheader', { name: /^EWR, 30 days to 28 Jan 2022/ });
	await expect(statusHead).toHaveAttribute('aria-sort', 'ascending');
	await expect(page.getByLabel('Sort')).toHaveValue('status');

	await page.getByRole('button', { name: /^Catchment/ }).click();
	await expect(page).toHaveURL(/[?&]sort=name/);
	await expect(names(page)).toHaveText(['Pf empty B', 'Pf published B', 'Pf run only B']);
	await expect(page.getByRole('columnheader', { name: /^Catchment/ })).toHaveAttribute('aria-sort', 'ascending');
	await page.getByRole('button', { name: /^Catchment/ }).click();
	await expect(page).toHaveURL(/[?&]dir=desc/);
	await expect(names(page)).toHaveText(['Pf run only B', 'Pf published B', 'Pf empty B']);
	await expect(page.getByRole('columnheader', { name: /^Catchment/ })).toHaveAttribute('aria-sort', 'descending');

	// A reload keeps it; the status heading goes back to worst first; the Sort menu starts a key its own way round.
	await page.reload();
	await expect(names(page)).toHaveText(['Pf run only B', 'Pf published B', 'Pf empty B']);
	await page.getByRole('button', { name: /^EWR, 30 days to 28 Jan 2022/ }).click();
	await expect(names(page)).toHaveText(worstFirst);
	await expect(page).not.toHaveURL(/dir=/);
	// The Data heading sorts by the figures' age, oldest first, as the portfolio's did; never-run last.
	await page.getByRole('button', { name: /^Data/ }).click();
	await expect(page).toHaveURL(/[?&]sort=age/);
	await expect(heads(page).last()).toHaveAccessibleName('Pf empty B');

	// An old link with its sort and direction keeps them; Back goes to where the user was before it.
	await page.goto(`/teams/${a.team.id}/portfolio?sort=name&dir=desc`);
	await expect(page).toHaveURL(new RegExp(`owner=team(%3A|:)${a.team.id}&sort=name&dir=desc$`));
	await expect(names(page)).toHaveText(['Pf run only B', 'Pf published B', 'Pf empty B']);
	await page.goBack();
	await expect(page).not.toHaveURL(/\/portfolio/);
});

test('a farmer on a team catchment is sent to their farm, never the team’s list; a team that isn’t yours says so', async ({ page, owner, signIn }) => {
	void owner;
	const a = await arrange(page.request, 'C');
	const farmer = await signIn('Portfolio farmer');
	const add = await page.request.post(`${API_URL}/projects/${a.published.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [a.farmId] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, a.published.id);
	expect((await farmer.page.request.get(`${API_URL}/teams/${a.team.id}/portfolio`)).status()).toBe(404);
	await farmer.page.goto(`/teams/${a.team.id}/portfolio`);
	await expect(farmer.page).toHaveURL(new RegExp(`/farm/${a.published.id}`));

	// Someone with projects of their own, outside the team: not found, and the way back.
	const outsider = await signIn('Portfolio outsider');
	await createProject(outsider.page.request, 'Outsider catchment');
	await outsider.page.goto(`/teams/${a.team.id}/portfolio`);
	await expect(outsider.page).toHaveURL(teamUrl(a.team.id));
	await expect(outsider.page.getByRole('alert')).toHaveText("This team doesn't exist or you're not a member.");
	await expect(outsider.page.getByText('Pf published C')).toHaveCount(0);
	await outsider.page.getByRole('link', { name: 'All projects', exact: true }).click();
	await expect(outsider.page.getByRole('rowheader', { name: 'Outsider catchment' })).toBeVisible();
});

test('the demo team shows its two examples, not the analyst’s own catchment', async ({ page }) => {
	test.setTimeout(120_000);
	await seedExamplesOnce(page.request);
	expect((await page.request.post(`${API_URL}/auth/login`, { data: DEMO })).status()).toBe(200);
	const teams = (await (await page.request.get(`${API_URL}/teams`)).json()).teams as { id: string; name: string }[];
	const demo = teams.find((t) => t.name === 'Demo Catchment Consultants')!;
	await page.goto('/');
	await page.getByRole('region', { name: 'Demo Catchment Consultants' }).getByRole('link', { name: 'Only this team' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]owner=team(%3A|:)${demo.id}`));
	await outcomesReady(page);
	for (const name of [KLEINBERG, DROEVLEI]) {
		const r = row(page, name);
		await expect(r.locator('td.c-ewr')).toContainText(/(Red|Amber|Green): EWR (not met \d+ of 30 days|met all 30 days)|Unknown: /);
		await expect(r.locator('td.c-ewr')).toContainText('Published');
	}
	await expect(page.getByRole('rowheader', { name: SANDSPRUIT })).toHaveCount(0);
});

// A dashboard (issue #17): with thirty catchments the list's card takes the height left in the window and
// scrolls inside; the page doesn't. The columns the portfolio added fit beside the rest without crowding
// the name or running into each other.
for (const viewport of [
	{ width: 1440, height: 960 },
	{ width: 1280, height: 800 }
]) {
	test.describe(`${viewport.width}×${viewport.height}`, () => {
		test.use({ viewport });

		test('the team filter fits the window with thirty catchments: no page scroll, the list reaching its bottom, no heading overlapping another', async ({ page, owner }) => {
			void owner;
			test.setTimeout(90_000);
			const a = await arrange(page.request, `fit ${viewport.width}`, 27);
			await page.goto(`/?owner=team:${a.team.id}`);
			await outcomesReady(page);
			await expect(heads(page)).toHaveCount(30);
			await expect(page.getByTestId('team-thresholds')).toBeInViewport();
			await expect(page.getByRole('region', { name: 'Needs attention' })).toBeInViewport();
			const card = page.locator('.list-card');
			await expect.poll(async () => viewport.height - (await card.boundingBox())!.y - (await card.boundingBox())!.height).toBeLessThanOrEqual(24);
			const m = await page.evaluate(() => {
				const groups = document.querySelector('.groups')!;
				return { page: document.documentElement.scrollHeight - innerHeight, inner: groups.scrollHeight - groups.clientHeight };
			});
			expect(m.page).toBeLessThanOrEqual(0);
			expect(m.inner).toBeGreaterThan(0);
			// Column headings keep to their own column.
			const boxes = await page.locator('table.projects thead th').evaluateAll((ths) =>
				ths
					.filter((th) => th.checkVisibility())
					.map((th) => {
						const cell = th.getBoundingClientRect();
						const inner = th.firstElementChild?.getBoundingClientRect() ?? cell;
						return { cellRight: cell.right, innerRight: inner.right };
					})
			);
			for (const b of boxes) expect(b.innerRight).toBeLessThanOrEqual(b.cellRight + 0.5);
			const alerts = page.getByRole('columnheader', { name: 'Alerts' });
			if (viewport.width === 1440) {
				// Wide: every column, the name still a readable width.
				await expect(alerts).toBeVisible();
				await expect(page.getByRole('columnheader', { name: /^Lowest dam/ })).toBeVisible();
				expect((await page.getByRole('columnheader', { name: /^Catchment/ }).boundingBox())!.width).toBeGreaterThanOrEqual(200);
			} else {
				// Beside the sidebar at 1280 the table is narrower: dam, restriction, last run and alerts fold under the name.
				await expect(alerts).toBeHidden();
				const pr = row(page, `Pf published fit ${viewport.width}`);
				await expect(pr.locator('.meta-mid')).toContainText('Restriction: Advisory · 15 %');
				await expect(pr.locator('.meta-mid')).toContainText('1 alert firing');
			}
		});
	});
}

// axe on the team filter in both themes, at desktop (the table) and phone width (the stacked rows).
for (const colorScheme of ['light', 'dark'] as const) {
	for (const [sizeName, viewport] of [
		['desktop', { width: 1440, height: 900 }],
		['phone', PHONE]
	] as const) {
		test.describe(`${colorScheme}, ${sizeName}`, () => {
			test.use({ colorScheme, viewport });

			test('the team filter has no WCAG 2.2 AA violations', async ({ page, owner }) => {
				void owner;
				const a = await arrange(page.request, `axe ${colorScheme} ${sizeName}`);
				await page.goto(`/?owner=team:${a.team.id}`);
				await outcomesReady(page);
				await expect(heads(page)).toHaveCount(3);
				if (sizeName === 'phone') {
					// The figures stack under each name, the alert with them; the owner filter is a select.
					const pr = row(page, `Pf published axe ${colorScheme} ${sizeName}`);
					await expect(pr.locator('.meta-narrow').first()).toBeVisible();
					await expect(pr).toContainText('1 alert firing');
					await expect(pr).toContainText('Restriction: Advisory · 15 %');
					await expect(page.getByLabel('Show')).toHaveValue(`team:${a.team.id}`);
					const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
					expect(scroll).toBeLessThanOrEqual(inner);
				} else {
					await expect(row(page, `Pf published axe ${colorScheme} ${sizeName}`).locator('td.c-alerts')).toHaveText('1 firing');
				}
				await expectNoViolations(page);
			});
		});
	}
}
