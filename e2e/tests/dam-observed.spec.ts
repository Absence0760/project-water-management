// Dams seen from space (issue #604 R5-B; docs/ui.md § Dams and § Farmer view).
// A unit's dam outline on the map with satellite views loaded the way the
// worker loads them (261's functions, e2e/support/damObserved.ts): the Dams
// tab's "Seen from space" fold under the picked dam's storage chart says how
// many clear views were compared and how many disagree; opened, it says the
// Waterbodies polygon is merged with a neighbour, draws the run's surface
// area beside the views with the flags as lanes (the axis making room for
// them under 0 ha), and lists the newest views, with the credit. A dam with
// no outline says so, and a viewer is told an editor draws one. A long record
// shows its newest ten views. The farmer's dam page says when a satellite last
// saw the dam clearly, its area against its area when full, or that there is
// no clear view yet, and shows nothing for a dam with no outline. The chart's
// figures are read from its labels and table, never its pixels. Sentinel
// views (issue #624): the sharpest clear source wins a day, radar is shown as
// radar (its own doubled strip, never a flag), and Copernicus is credited for
// their year, on the panel and the farm card. Invented data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { acceptInvites, addMember } from '../support/api.ts';
import { manyViews, seedObservedDam, SENTINEL_VIEWS } from '../support/damObserved.ts';
import { API_URL, WEB_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const box1 = (page: Page) => page.getByTestId('dam-observed');
const openBox = async (page: Page) => {
	await box1(page).locator('details.fold > summary').click();
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
};

test('the Dams tab compares the picked dam’s run area with what the satellite saw, flags spill, empty and disagreement, and credits the data', async ({ page, owner }) => {
	void owner;
	const { project, upper, runId, lower } = await seed(page);
	const api = (await (await page.request.get(`${API_URL}/projects/${project.id}/dams/observations?run=${runId}`)).json()) as {
		dams: { nodeId: string; summary: Record<string, unknown> }[];
	};
	// The flags the views alone decide (50 000 m² of a 50 000 m² dam is full, 0 m² empty), and against this run's
	// surface area (about 3.5 ha all season) both disagree, and none of the three is within ±10 % of the full area.
	expect(api.dams.find((d) => d.nodeId === upper.id)!.summary).toMatchObject({ compared: 3, seenFull: 1, seenEmpty: 1, mismatches: 2, withinShare: 0 });

	await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	// One line, named by the fold itself (no heading of its own): the views compared, the disagreements, the share within ±10 %.
	await expect(box1(page)).toHaveAccessibleName('Upper farm seen from space');
	await expect(box1(page).locator('h3')).toHaveCount(0);
	await expect(box1(page).locator('details.fold > summary')).toContainText('Seen from space:');
	await expect(box1(page).getByTestId('dam-observed-line')).toHaveText('3 clear views compared · 2 disagree · 0% within ±10%');

	await openBox(page);
	await expect(box1(page).getByTestId('dam-observed-match')).toHaveText('“Upper dam” is merged with a neighbouring water body in DE Africa Waterbodies, so only views of its own outline (WOfS and Sentinel) are compared.');
	await expect(box1(page).getByTestId('dam-observed-summary')).toContainText(/^Full area 5\.00 ha, as entered\. 3 clear views from 20 Oct 2021 to 10 Dec 2021: /);
	await expect(box1(page).getByTestId('dam-observed-summary')).toContainText('Seen full 1 time, seen empty 1 time.');

	// The chart: its title, its points and line, the flags as lanes in its key, with room under 0 ha for them.
	const chart = box1(page).locator('figure.chart');
	await expect(chart.locator('figcaption .ttl')).toHaveText('Upper farm: surface area, modelled and seen from space');
	await expect(chart).toHaveAttribute('data-ready', 'true');
	await expect(chart).toHaveAttribute('data-lanes-room', 'true');
	await expect(chart).toHaveAttribute('data-lanes', '3');
	const lanes = chart.locator('.lane-key li');
	await expect(lanes.filter({ hasText: 'the satellite saw the dam at its full area or more (likely spilling)' })).toHaveAttribute('data-color', '--lane-seen-full');
	await expect(lanes.filter({ hasText: 'the satellite saw almost no water' })).toHaveAttribute('data-color', '--lane-seen-empty');
	await expect(lanes.filter({ hasText: 'the model and the satellite disagree' })).toHaveAttribute('data-color', '--lane-disagree');

	// Every view, newest first, with why the cloudy one wasn't compared.
	await box1(page).getByText('The 4 views, newest first').click();
	const rows = box1(page).getByTestId('dam-observed-views').locator('tbody tr');
	await expect(rows).toHaveCount(4);
	await expect(rows.nth(0)).toContainText('20 Dec 2021');
	await expect(rows.nth(0)).toContainText('Not compared: partly seen (cloud or shadow)');
	await expect(rows.nth(2)).toContainText(/seen empty/);
	await expect(rows.nth(3)).toContainText(/seen full/);
	// Four views fold nothing away.
	await expect(box1(page).getByRole('button', { name: /^Show all/ })).toHaveCount(0);
	await expect(box1(page).getByTestId('dam-observed-credit')).toHaveText('Satellite views: Digital Earth Africa, CC BY 4.0 (Waterbodies and WOfS, from Landsat).');
	await expectNoViolations(page, { include: '[data-testid="dam-observed"]' });

	// A dam with no outline on the map says so, with the way to draw one.
	await page.goto(`/projects/${project.id}?tab=dams&dam=${lower.id}`);
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await expect(box1(page).getByTestId('dam-observed-line')).toHaveText('no outline of this dam on the map');
	await openBox(page);
	await expect(box1(page).getByTestId('dam-observed-no-outline')).toContainText('draw its water surface as a polygon on the Map and link it to Lower farm.');

	// On a phone the open fold and its table fit the width.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await openBox(page);
	await box1(page).getByText('The 4 views, newest first').click();
	await expect(box1(page).getByTestId('dam-observed-views')).toBeVisible();
	await expectNoSidewaysScroll(page);
	const wrap = box1(page).locator('.table-wrap');
	const fit = await wrap.evaluate((w) => ({ scroll: w.scrollWidth, client: w.clientWidth }));
	expect(fit.scroll, `the views table scrolls sideways: ${fit.scroll} px in ${fit.client}`).toBeLessThanOrEqual(fit.client);
	await expectNoViolations(page, { include: '[data-testid="dam-observed"]' });
});


test('Sentinel views: the sharpest clear source wins the day, radar is shown as radar and never flagged, and Copernicus is credited', async ({ page, owner }) => {
	void owner;
	const { project, upper, runId } = await seed(page, 'Dams seen from Sentinel', SENTINEL_VIEWS);
	const api = (await (await page.request.get(`${API_URL}/projects/${project.id}/dams/observations?run=${runId}`)).json()) as {
		sentinelCredit: string | null;
		dams: { nodeId: string; summary: Record<string, unknown>; points: { date: string; source: string; skip: string | null; seenFull: boolean; mismatch: string | null }[] }[];
	};
	const d = api.dams.find((x) => x.nodeId === upper.id)!;
	// Sentinel-2's full view wins 20 Oct over WOfS's; the two radar views are compared but flag nothing.
	expect(d.summary).toMatchObject({ compared: 4, radar: 2, seenFull: 1, seenEmpty: 1, mismatches: 2 });
	// Beside it, the two optical views' own figures, so radar's pull on the average shows.
	expect(d.summary.optical).toMatchObject({ compared: 2 });
	expect(d.points.map((p) => [p.date, p.source, p.skip])).toEqual([
		['2021-10-20', 's2', null],
		['2021-10-20', 'wofs', 'other-source'],
		['2021-11-15', 'wofs', null],
		['2021-12-10', 's1', null],
		['2021-12-20', 's1', null],
		['2021-12-20', 'wofs', 'partly-seen']
	]);
	expect(api.sentinelCredit).toBe('Contains modified Copernicus Sentinel data 2021, processed by Digital Earth Africa');

	await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await expect(box1(page).getByTestId('dam-observed-line')).toHaveText(/^4 clear views compared \(2 radar\) · 2 disagree · \d+% within ±10%$/);
	await openBox(page);
	await expect(box1(page).getByTestId('dam-observed-summary')).toContainText('2 of the 4 views are radar (Sentinel-1, through cloud), never called full or empty on their own.');
	await expect(box1(page).getByTestId('dam-observed-summary')).toContainText(/ Without radar \(2 clear views\): .+; within ±10% on \d+% of them\.$/);
	await expect(box1(page).getByTestId('dam-observed-sources')).toHaveText(
		'Views by source: 1 Sentinel-2, 3 WOfS, 2 Sentinel-1 radar. A day more than one saw clearly is compared with the most trusted: Sentinel-2, then WOfS, then Waterbodies, then radar.'
	);
	// The radar days are a doubled strip of their own under the three flags, its look said in the key.
	const chart = box1(page).locator('figure.chart');
	await expect(chart).toHaveAttribute('data-ready', 'true');
	await expect(chart).toHaveAttribute('data-lanes', '4');
	const radarLane = chart.locator('.lane-key li').filter({ hasText: 'a radar view (Sentinel-1)' });
	await expect(radarLane).toHaveAttribute('data-color', '--lane-radar');
	await expect(radarLane).toHaveAttribute('data-doubled', 'true');
	await expect(chart.locator('.lane-key')).toContainText('Flags and radar days');
	await expect(chart.locator('.lane-key')).toContainText('solid: a flag; double line: a radar view');
	await expect(chart).toContainText('rings: radar');

	await box1(page).getByText('The 6 views, newest first').click();
	const rows = box1(page).getByTestId('dam-observed-views').locator('tbody tr');
	await expect(rows).toHaveCount(6);
	// The cloudy Landsat winter view isn't compared; radar's view of the same day is, as radar.
	await expect(rows.nth(0)).toContainText('Not compared: partly seen (cloud or shadow)');
	await expect(rows.nth(1).locator('td[data-label="Source"]')).toHaveText('Sentinel-1 radar, inside the dam’s outline');
	await expect(rows.nth(1)).toContainText('radar, never called full or empty on its own');
	await expect(rows.nth(4)).toContainText('Not compared: Sentinel-2 saw it clearly the same day');
	await expect(rows.nth(5).locator('td[data-label="Source"]')).toHaveText('Sentinel-2, inside the dam’s outline');
	await expect(rows.nth(5)).toContainText('seen full');
	await expect(box1(page).getByTestId('dam-observed-credit')).toHaveText(
		'Satellite views: Digital Earth Africa, CC BY 4.0 (Waterbodies and WOfS, from Landsat). Contains modified Copernicus Sentinel data 2021, processed by Digital Earth Africa.'
	);
	await expectNoViolations(page, { include: '[data-testid="dam-observed"]' });

	// On a phone: the sources line, four strips and their long key fit the width.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await openBox(page);
	await expect(box1(page).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
	await box1(page).getByText('The 6 views, newest first').click();
	await expect(box1(page).getByTestId('dam-observed-views')).toBeVisible();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page, { include: '[data-testid="dam-observed"]' });
	await page.setViewportSize({ width: 1280, height: 800 });

	// The credit's full wording, on the public Data sources page.
	await page.goto('/data-sources');
	await expect(page.locator('#copernicus-sentinel + p')).toBeVisible();
	await expect(page.locator('blockquote.credit').filter({ hasText: 'Contains modified Copernicus Sentinel data [year], processed by Digital Earth Africa' })).toHaveCount(1);
});

test.describe('dark theme', () => {
	test.use({ colorScheme: 'dark' });

	test('the open box, its chart, lanes and table pass axe in the dark theme', async ({ page, owner }) => {
		void owner;
		const { project, upper } = await seed(page, 'Dams seen from space dark');
		await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
		await expect(box1(page)).toHaveAttribute('data-ready', 'true');
		await openBox(page);
		await expect(box1(page).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
		await box1(page).getByText('The 4 views, newest first').click();
		await expect(box1(page).getByTestId('dam-observed-views')).toBeVisible();
		await expectNoViolations(page, { include: '[data-testid="dam-observed"]' });
	});

	test('the Sentinel views, the radar rings and strip, and the sources line pass axe in the dark theme', async ({ page, owner }) => {
		void owner;
		const { project, upper } = await seed(page, 'Dams seen from Sentinel dark', SENTINEL_VIEWS);
		await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
		await expect(box1(page)).toHaveAttribute('data-ready', 'true');
		await openBox(page);
		await expect(box1(page).locator('figure.chart')).toHaveAttribute('data-lanes', '4');
		await expect(box1(page).getByTestId('dam-observed-sources')).toBeVisible();
		await expectNoViolations(page, { include: '[data-testid="dam-observed"]' });
	});
});

test('a viewer is told an editor draws the outline, not to draw it', async ({ page, owner, signIn }) => {
	void owner;
	const { project, lower } = await seed(page, 'Dams seen from space viewer');
	const viewer = await signIn('Seen from space viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const vp = viewer.page;
	await vp.goto(`/projects/${project.id}?tab=dams&dam=${lower.id}`);
	await expect(box1(vp)).toHaveAttribute('data-ready', 'true');
	await expect(box1(vp).locator('details.fold > summary .fold-change')).toHaveText('Show');
	await openBox(vp);
	await expect(box1(vp).getByTestId('dam-observed-no-outline')).toHaveText('No outline of Lower farm’s dam on the map. Satellites are compared inside the dam’s outline, which an editor draws on the Map. Open the Map');
	await expect(box1(vp).getByTestId('dam-observed-no-outline')).not.toContainText('draw its water surface');
});

test('a long record shows its newest ten views, and Show all opens the rest in place, on a phone with no inner scroll', async ({ page, owner }) => {
	void owner;
	const views = manyViews(44);
	const { project, upper } = await seed(page, 'Dams seen from space long record', views);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await expect(box1(page).getByTestId('dam-observed-line')).toHaveText(/^44 clear views compared · none disagree · \d+% within ±10%$/);
	await openBox(page);
	await box1(page).getByText('The 44 views, newest first').click();
	const rows = box1(page).getByTestId('dam-observed-views').locator('tbody tr');
	await expect(rows).toHaveCount(10);
	// Newest first: the last of the 44 (every second day from 1 Oct 2021) is 26 Dec 2021.
	await expect(rows.first().locator('th')).toHaveText('26 Dec 2021');
	const more = box1(page).getByRole('button', { name: 'Show all 44 views' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await more.click();
	await expect(rows).toHaveCount(44);
	await expect(rows.last().locator('th')).toHaveText('1 Oct 2021');
	const back = box1(page).getByRole('button', { name: 'Show the newest 10 views' });
	await expect(back).toHaveAttribute('aria-expanded', 'true');
	// The list grows the page; nothing inside it scrolls (a 20rem box showed two views at a time on a phone).
	const wrap = await box1(page).locator('.table-wrap').evaluate((w) => ({ scroll: w.scrollHeight, client: w.clientHeight, overflow: getComputedStyle(w).overflowY }));
	expect(wrap.scroll, `the views scroll inside their box: ${wrap.scroll} px in ${wrap.client}`).toBeLessThanOrEqual(wrap.client + 1);
	await expectNoSidewaysScroll(page);
	await back.click();
	await expect(rows).toHaveCount(10);
});

test.describe('the farmer’s dam page', () => {
	async function farmerOf(page: Page, signIn: (n: string) => Promise<{ page: Page; user: { email: string } }>, projectId: string, runId: string, nodeId: string) {
		const req = page.context().request;
		const pub = await req.post(`${API_URL}/projects/${projectId}/publication`, { data: { runId, restriction: { level: 'none' } } });
		expect(pub.status(), await pub.text()).toBe(201);
		const farmer = await signIn('Seen from space farmer');
		const add = await req.post(`${API_URL}/projects/${projectId}/farmers`, { data: { email: farmer.user.email, nodeIds: [nodeId] } });
		expect(add.status(), await add.text()).toBe(201);
		await acceptInvites(farmer.user.email, projectId);
		return farmer.page;
	}

	test('says when a satellite last saw the dam clearly, its area against its area when full, after the forecast, with the credit', async ({ page, owner, signIn }) => {
		void owner;
		const { project, upper, runId } = await seed(page, 'Farm dam seen from space');
		const fp = await farmerOf(page, signIn, project.id, runId, upper.id);
		await fp.setViewportSize({ width: 360, height: 740 });
		await fp.goto(`/farm/${project.id}/dam`);
		const card = fp.getByRole('region', { name: 'Your dam, seen from space' });
		// The newest view under 90 % clear (20 Dec) doesn't count: 10 Dec's 2.0 ha of 5.0 ha is. Area with area, no percentage.
		await expect(card.getByTestId('farm-dam-observed-line')).toHaveText(/^On 10 Dec 2021 a satellite saw water over 2[.,]0\sha of the 5[.,]0\sha your dam covers when full\.$/);
		await expect(card.getByTestId('farm-dam-observed-credit')).toHaveText('Satellite views: Digital Earth Africa, CC BY 4.0.');
		// Just before "Where these figures come from": a check on the model, after the model's own figures.
		const order = await fp.locator('main h2').allTextContents();
		expect(order.indexOf('Your dam, seen from space'), order.join(' | ')).toBe(order.indexOf('Where these figures come from') - 1);
		await expectNoSidewaysScroll(fp);
		await expectNoViolations(fp);
	});

	test('says there is no clear view yet when every view was cloudy, and shows nothing once the dam has no outline', async ({ page, owner, signIn }) => {
		void owner;
		const { project, upper, runId, featureId } = await seed(page, 'Farm dam cloudy', [
			{ date: '2021-11-01', wetAreaM2: 20_000, pctObserved: 40 },
			{ date: '2021-11-17', wetAreaM2: 22_000, pctObserved: 60 }
		]);
		const fp = await farmerOf(page, signIn, project.id, runId, upper.id);
		await fp.goto(`/farm/${project.id}/dam`);
		const card = fp.getByRole('region', { name: 'Your dam, seen from space' });
		await expect(card.getByTestId('farm-dam-observed-line')).toHaveText('No clear view of your dam from space yet. Clouds often hide it; the next clear view will show here.');
		await expectNoViolations(fp);

		// The outline removed from the map: its views go with it, and the page shows no card at all.
		const del = await page.request.delete(`${API_URL}/projects/${project.id}/map/features/${featureId}`, { headers: { Origin: WEB_URL } });
		expect(del.status(), await del.text()).toBeLessThan(300);
		// Wait for the card's own answer (its real signal), then for the page's last card, before saying it drew nothing.
		const answered = fp.waitForResponse((r) => r.url().endsWith(`/farm/${upper.id}/dam-observed`));
		await fp.reload();
		const r = await answered;
		expect(r.status()).toBe(200);
		expect(((await r.json()) as { outlines: number }).outlines).toBe(0);
		await expect(fp.getByRole('heading', { level: 2, name: 'Where these figures come from' })).toBeVisible();
		await expect(fp.getByRole('region', { name: 'Your dam, seen from space' })).toHaveCount(0);
		await expect(fp.getByTestId('farm-dam-observed-failed')).toHaveCount(0);
	});
});

test('the farmer’s dam page says a winter radar view is radar, gives its area “about” and credits Copernicus', async ({ page, owner, signIn }) => {
	void owner;
	const { project, upper, runId } = await seed(page, 'Farm dam radar', SENTINEL_VIEWS);
	const req = page.context().request;
	const pub = await req.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId, restriction: { level: 'none' } } });
	expect(pub.status(), await pub.text()).toBe(201);
	const farmer = await signIn('Radar farmer');
	const add = await req.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper.id] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);
	const fp = farmer.page;
	await fp.setViewportSize({ width: 360, height: 740 });
	await fp.goto(`/farm/${project.id}/dam`);
	const card = fp.getByRole('region', { name: 'Your dam, seen from space' });
	// 20 Dec: Landsat clouded (40 % seen), radar saw through. Radar's area is "about", and it is called radar.
	await expect(card.getByTestId('farm-dam-observed-line')).toHaveText(/^On 20 Dec 2021 a radar satellite, which sees through cloud, saw water over about 0[.,]6\sha of the 5[.,]0\sha your dam covers when full\.$/);
	await expect(card.getByTestId('farm-dam-observed-credit')).toHaveText('Satellite views: Digital Earth Africa, CC BY 4.0. Contains modified Copernicus Sentinel data 2021, processed by Digital Earth Africa.');
	await expectNoSidewaysScroll(fp);
	await expectNoViolations(fp);
});

const seed = (page: Page, name = 'Dams seen from space', views?: Parameters<typeof seedObservedDam>[2]) => seedObservedDam(page.context().request, name, views);
