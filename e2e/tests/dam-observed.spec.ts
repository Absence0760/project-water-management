// Dams seen from space (issue #604 R5-B; docs/ui.md § Dams and § Farmer view).
// A unit's dam outline on the map with satellite views loaded the way the
// worker loads them (249's functions, e2e/support/db.ts): the Dams tab's
// "Seen from space" fold under the picked dam's storage chart says how many
// clear views were compared and how many disagree; opened, it says the
// Waterbodies polygon is merged with a neighbour, draws the run's surface
// area beside the views with the flags as lanes, and lists every view, with
// the credit. A dam with no outline says so. The farmer's dam page says when
// a satellite last saw the dam clearly, against its area when full, with the
// credit. The chart's figures are read from its labels and table, never its
// pixels. Invented data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { acceptInvites, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { plantDamObservations } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const FULL_M2 = 50_000;
/** Inside the run (1 Oct 2021, 120 days): seen full, seen empty, a plain view, and one under 90 % clear. */
const VIEWS = [
	{ date: '2021-10-20', wetAreaM2: FULL_M2, pctObserved: 100 },
	{ date: '2021-11-15', wetAreaM2: 0, pctObserved: 100 },
	{ date: '2021-12-10', wetAreaM2: 20_000, pctObserved: 97 },
	{ date: '2021-12-20', wetAreaM2: 5_000, pctObserved: 40 }
];

const box1 = (page: Page) => page.getByTestId('dam-observed');

/** A project whose Upper farm has a 50 000 m² dam outline with the satellite views loaded, and a run. */
async function seed(page: Page, name: string) {
	const req = page.context().request;
	const project = await seedRunnableProject(req, name);
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')! as { id: string; damAreaFullM2?: number | null };
	upper.damAreaFullM2 = FULL_M2;
	await putModel(req, project.id, project.model);
	const runId = await createRun(req, project.id, 'Baseline');
	const made = await req.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'dam', name: 'Upper dam', nodeId: upper.id, geometry: { type: 'Polygon', coordinates: [box(21.32, -33.68, 0.002)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await plantDamObservations(((await made.json()) as { feature: { id: string } }).feature.id, { status: 'merged' }, VIEWS);
	return { project, upper, runId, lower: project.model.nodes.find((n) => n.name === 'Lower farm')! as { id: string } };
}

test('the Dams tab compares the picked dam’s run area with what the satellite saw, flags spill, empty and disagreement, and credits the data', async ({ page, owner }) => {
	void owner;
	const { project, upper, runId, lower } = await seed(page, 'Dams seen from space');
	const api = (await (await page.request.get(`${API_URL}/projects/${project.id}/dams/observations?run=${runId}`)).json()) as {
		dams: { nodeId: string; summary: { compared: number; mismatches: number; seenFull: number; seenEmpty: number } }[];
	};
	const s = api.dams.find((d) => d.nodeId === upper.id)!.summary;
	// The flags the views alone decide: 50 000 m² of a 50 000 m² dam is full, 0 m² is empty.
	expect(s).toMatchObject({ compared: 3, seenFull: 1, seenEmpty: 1 });

	await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await expect(box1(page).getByRole('heading', { level: 3, name: 'Seen from space' })).toBeVisible();
	const disagree = s.mismatches === 0 ? 'none disagree' : `${s.mismatches} disagree${s.mismatches === 1 ? 's' : ''}`;
	await expect(box1(page).getByTestId('dam-observed-line')).toHaveText(new RegExp(`^3 clear views compared · ${disagree} · \\d+% within ±10%$`));

	await box1(page).locator('details.fold > summary').click();
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await expect(box1(page).getByTestId('dam-observed-match')).toHaveText('“Upper dam” is merged with a neighbouring water body in DE Africa Waterbodies, so only WOfS views of its own outline are compared.');
	await expect(box1(page).getByTestId('dam-observed-summary')).toContainText(/^Full area 5\.00 ha, as entered\. 3 clear views from 20 Oct 2021 to 10 Dec 2021: /);
	await expect(box1(page).getByTestId('dam-observed-summary')).toContainText('Seen full 1 time, seen empty 1 time.');

	// The chart: its title, its points and line, the flags as lanes in its key.
	const chart = box1(page).locator('figure.chart');
	await expect(chart.locator('figcaption .ttl')).toHaveText('Upper farm: surface area, modelled and seen from space');
	await expect(chart).toHaveAttribute('data-ready', 'true');
	// One strip per flag there is: seen full, seen empty, and disagree when the run disagrees somewhere.
	await expect(chart).toHaveAttribute('data-lanes', String(s.mismatches ? 3 : 2));
	const lanes = chart.locator('.lane-key li');
	await expect(lanes.filter({ hasText: 'the satellite saw the dam at its full area or more (likely spilling)' })).toHaveAttribute('data-color', '--accent');
	await expect(lanes.filter({ hasText: 'the satellite saw almost no water' })).toHaveAttribute('data-color', '--warning');
	await expect(lanes.filter({ hasText: 'the model and the satellite disagree' })).toHaveCount(s.mismatches ? 1 : 0);

	// Every view, newest first, with why the cloudy one wasn't compared.
	await box1(page).getByText('Show the 4 views').click();
	const rows = box1(page).getByTestId('dam-observed-views').locator('tbody tr');
	await expect(rows).toHaveCount(4);
	await expect(rows.nth(0)).toContainText('20 Dec 2021');
	await expect(rows.nth(0)).toContainText('Not compared: partly seen (cloud or shadow)');
	await expect(rows.nth(2)).toContainText(/seen empty/);
	await expect(rows.nth(3)).toContainText(/seen full/);
	await expect(box1(page).getByTestId('dam-observed-credit')).toHaveText('Satellite views: Digital Earth Africa, CC BY 4.0 (Waterbodies and WOfS, from Landsat).');
	await expectNoViolations(page, { include: '[data-testid="dam-observed"]' });

	// A dam with no outline on the map says so, with the way to draw one.
	await page.goto(`/projects/${project.id}?tab=dams&dam=${lower.id}`);
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await expect(box1(page).getByTestId('dam-observed-line')).toHaveText('no outline of this dam on the map');

	// On a phone the open fold and its table fit the width.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=dams&dam=${upper.id}`);
	await expect(box1(page)).toHaveAttribute('data-ready', 'true');
	await box1(page).locator('details.fold > summary').click();
	await box1(page).getByText('Show the 4 views').click();
	await expect(box1(page).getByTestId('dam-observed-views')).toBeVisible();
	await expectNoSidewaysScroll(page);
	const wrap = box1(page).locator('.table-wrap');
	const fit = await wrap.evaluate((w) => ({ scroll: w.scrollWidth, client: w.clientWidth }));
	expect(fit.scroll, `the views table scrolls sideways: ${fit.scroll} px in ${fit.client}`).toBeLessThanOrEqual(fit.client);
	await expectNoViolations(page, { include: '[data-testid="dam-observed"]' });
});

test('the farmer’s dam page says when a satellite last saw the dam clearly, against its area when full, with the credit', async ({ page, owner, signIn }) => {
	void owner;
	const req = page.context().request;
	const { project, upper, runId } = await seed(page, 'Farm dam seen from space');
	const pub = await req.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId, restriction: { level: 'none' } } });
	expect(pub.status(), await pub.text()).toBe(201);
	const farmer = await signIn('Seen from space farmer');
	const add = await req.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper.id] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);

	const fp = farmer.page;
	await fp.setViewportSize({ width: 360, height: 740 });
	await fp.goto(`/farm/${project.id}/dam`);
	const card = fp.getByRole('region', { name: 'Your dam, seen from space' });
	// The newest view under 90 % clear (20 Dec) doesn't count: 10 Dec's 2.0 ha of 5.0 ha is.
	await expect(card.getByTestId('farm-dam-observed-line')).toHaveText(/^On 10 Dec 2021 a satellite saw water over 2[.,]0\sha of your dam, about 40\s%\sof the area it covers when full\.$/);
	await expect(card.getByTestId('farm-dam-observed-credit')).toHaveText('Satellite views: Digital Earth Africa, CC BY 4.0.');
	await expectNoSidewaysScroll(fp);
	await expectNoViolations(fp);
});
