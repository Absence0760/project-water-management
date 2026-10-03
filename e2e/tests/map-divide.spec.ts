// Divide a model that has nodes from the map (#326 C3's follow-up;
// docs/design/start-from-map.md § Dividing a model that has nodes, docs/ui.md
// § Map), against the committed synthetic DEM the e2e API reads (DEM_URL,
// support/dem.ts). A typed model of the valley (the outflow weir, the dam's
// unit, a pump's unit up the river, a hillside unit with no point) and its
// points on the map: the editor opens Divide the model, each point already
// standing for its node and the unlinked gauge offered as a new gauge node,
// has the division proposed, sees each value beside the node's value now,
// can't apply an order into a gauge not being added, ticks, gives the rest
// of the catchment to the hillside unit and applies: only the ticked values
// change. Axe-scanned on the review, light and dark, and on a phone. A viewer
// is offered none of it.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, node, putModel } from '../support/api.ts';
import { FIXTURE_DAM, FIXTURE_MID_GAUGE, FIXTURE_OUTLET, FIXTURE_UPPER } from '../support/dem.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap } from '../support/map.ts';

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Divide the model from the map' });
type ApiNode = { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number; pctRunoffToDam: number };

/** The valley typed in, and its points on the map (the dam's and the pump's linked to their units, the outlet's to the weir). */
async function valley(page: Page, name: string) {
	const project = await createProject(page.request, name);
	const weir = node('Valley weir', 'gauge', null, 0);
	const dam = node('Valley dam', 'farm', weir.id, 1, { damCapacityM3: 200_000, areaKm2: 300 });
	const pump = node('Top pump', 'farm', weir.id, 2, { areaKm2: 12 });
	const hill = node('Hillside', 'farm', weir.id, 3, { areaKm2: 20 });
	await putModel(page.request, project.id, { nodes: [weir, dam, pump, hill], crops: [], cropAreas: [], transfers: [] });
	const post = async (data: Record<string, unknown>) => {
		const r = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, { data });
		expect(r.status()).toBe(201);
	};
	await post({ kind: 'gauge', name: 'Weir', lon: FIXTURE_OUTLET[0], lat: FIXTURE_OUTLET[1], nodeId: weir.id });
	await post({ kind: 'dam', name: 'Dam wall', lon: FIXTURE_DAM[0], lat: FIXTURE_DAM[1], nodeId: dam.id });
	await post({ kind: 'other', name: 'Pump', lon: FIXTURE_UPPER[0], lat: FIXTURE_UPPER[1], nodeId: pump.id });
	await post({ kind: 'gauge', name: 'Mid weir', lon: FIXTURE_MID_GAUGE[0], lat: FIXTURE_MID_GAUGE[1] });
	return { id: project.id, weir, dam, pump, hill };
}

test('an editor divides a typed model from the map, value by value, beside the values now', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	const v = await valley(page, 'Divide from the map');
	await openMap(page, v.id);
	await page.getByTestId('map-divide-open').click();
	await expect(page).toHaveURL(/[?&]divide=1(&|$)/);
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'points');

	// The points: each linked one stands for its node, the unlinked gauge a new gauge node; the weir is the outlet.
	await expect(sheet(page).getByLabel(/^Dam wall/)).toHaveValue(v.dam.id);
	await expect(sheet(page).getByLabel(/^Pump/)).toHaveValue(v.pump.id);
	await expect(sheet(page).getByLabel(/^Mid weir/)).toHaveValue('new-gauge');
	await expect(sheet(page).getByTestId('divide-outlet')).toHaveValue(/.+/);
	await expect(sheet(page).getByTestId('divide-count')).toHaveText('3 points in the division.');
	// Two points can't stand for one node.
	await sheet(page).getByLabel(/^Pump/).selectOption(v.dam.id);
	await expect(sheet(page).getByRole('alert')).toHaveText('Two points stand for Valley dam: each node takes one point.');
	await expect(sheet(page).getByTestId('divide-propose')).toBeDisabled();
	await sheet(page).getByLabel(/^Pump/).selectOption(v.pump.id);
	await sheet(page).getByTestId('divide-propose').click();

	// The review: upstream first, each value unticked, beside the node's value now.
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'review');
	const review = page.getByTestId('divide-review');
	const cards = review.getByTestId('divide-unit');
	await expect(cards).toHaveCount(3);
	const [pump, dam, mid] = [cards.nth(0), cards.nth(1), cards.nth(2)];
	await expect(pump).toContainText('Top pump');
	await expect(pump).toContainText('Now: 12.00 km², typed');
	await expect(pump).toContainText('Drains into Valley dam. Now: Valley weir');
	await expect(dam).toContainText('Drains into Mid weir. Now: Valley weir');
	await expect(dam).toContainText('All of its own runoff reaches the dam');
	await expect(mid).toContainText('A new gauge');
	await expect(review.getByTestId('divide-warnings')).toContainText('No point stands for Hillside: it keeps its values.');
	// The typed areas (12 + 300 + 20 km²) are within the catchment: nothing counts twice yet (round 4).
	await expect(review.getByTestId('divide-overlap')).toHaveCount(0);
	for (const box of await review.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	await page.setViewportSize({ width: 390, height: 844 });
	await sheet(page).getByTestId('divide-apply').scrollIntoViewIfNeeded();
	await expect(sheet(page).getByTestId('divide-apply')).toBeInViewport();
	await expectNoViolations(page);
	await page.setViewportSize({ width: 1440, height: 960 });

	// On the map: a number per piece (the gauge's beside its point), each card's the same; closed, the page says what they are, and a number opens its card.
	await expect(page.getByTestId('catchment-map').locator('xpath=..')).toHaveAttribute('data-status', 'ready');
	await expect(page.locator('.piece-badge')).toHaveText(['1', '2', '3', 'R']);
	await expect(cards.nth(2).getByTestId('piece-badge')).toHaveText('Piece 3: 3');
	await pump.getByTestId('divide-tick-area').focus();
	await expect(page.locator('.piece-badge[data-lit="true"]')).toHaveText('1');
	await sheet(page).getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByTestId('map-pieces-pending')).toContainText('A proposed division of the model is drawn on the map piece by piece');
	await page.locator('.piece-badge').filter({ hasText: '2' }).click();
	await expect(page).toHaveURL(/[?&]divide=1(&|$)/);
	await expect(dam.getByTestId('divide-tick-area')).toBeFocused();

	// The dam's order into the new gauge needs the gauge added.
	await dam.getByTestId('divide-tick-drains').check();
	await expect(review.getByTestId('divide-problem')).toHaveText('Valley dam would drain into the new gauge Mid weir, which isn’t being added: tick Add it too.');
	await expect(sheet(page).getByTestId('divide-apply')).toBeDisabled();
	await mid.getByTestId('divide-tick-add').check();
	await expect(review.getByTestId('divide-problem')).toHaveCount(0);
	await mid.getByLabel('Its name').fill('Halfway weir');
	await expect(dam).toContainText('Drains into Halfway weir');
	// The pump's area and order; the dam's area stays as typed (unticked).
	await pump.getByTestId('divide-tick-area').check();
	await pump.getByTestId('divide-tick-drains').check();
	await mid.getByTestId('divide-tick-drains').check();
	await review.getByTestId('divide-rest-to').selectOption(v.hill.id);
	// Hillside takes the rest while the dam keeps its typed 300 km², more than its 276.81 km² piece: the units would
	// outgrow the catchment, said at the top and beside the choice, naming the dam and not Hillside.
	await expect(review.getByTestId('divide-overlap')).toContainText('After Apply the units would add up to');
	await expect(review.getByTestId('divide-overlap')).not.toContainText('Hillside');
	await expect(review.getByTestId('divide-overlap-rest')).toContainText('Valley dam keeps its typed 300.00 km²: tick its area to take its piece.');
	await sheet(page).getByTestId('divide-apply').click();
	const confirm = page.getByRole('alertdialog', { name: 'Apply the ticked values?' });
	await expect(confirm).toContainText('The model takes 2 areas (each saved as its unit’s parcel), 3 drains-into and 0 runoffs to the dam, and 1 new gauge.');
	// The confirmation repeats the overlap, so land counted twice is never applied unseen.
	await expect(confirm).toContainText('more than the');
	await confirm.getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Divided the model from the map.');
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'points');

	const model = (await (await page.request.get(`${API_URL}/projects/${v.id}/model`)).json()) as { nodes: ApiNode[] };
	const by = Object.fromEntries(model.nodes.map((n) => [n.name, n]));
	expect(by['Halfway weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: v.weir.id });
	expect(by['Top pump']!.downstreamNodeId).toBe(v.dam.id);
	expect(by['Top pump']!.areaKm2).not.toBe(12);
	expect(by['Valley dam']).toMatchObject({ downstreamNodeId: by['Halfway weir']!.id, areaKm2: 300, pctRunoffToDam: 0.5 });
	expect(by['Hillside']!.areaKm2).not.toBe(20);
});

test('a piece holding a pan asks which area its tick takes: gross until changed, the effective one applied as chosen (195)', async ({ page, owner }) => {
	void owner;
	const v = await valley(page, 'Divide effective area');
	await openMap(page, v.id, '&divide=1');
	await sheet(page).getByTestId('divide-propose').click();
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'review');
	const cards = page.getByTestId('divide-review').getByTestId('divide-unit');
	const [pump, dam] = [cards.nth(0), cards.nth(1)];
	// The pump's piece holds no pan: its tick asks nothing. The dam's holds the valley's: the choice shows once ticked.
	await pump.getByTestId('divide-tick-area').check();
	await expect(pump.getByTestId('divide-area-basis')).toHaveCount(0);
	await expect(dam.getByTestId('divide-area-basis')).toHaveCount(0);
	await dam.getByTestId('divide-tick-area').check();
	const basis = dam.getByTestId('divide-area-basis');
	await expect(basis.getByRole('radio', { name: /^Gross, 27\d\.\d\d km²/ })).toBeChecked();
	await basis.getByRole('radio', { name: /^Effective, \d+\.\d\d km² \(without the \d+\.\d\d km² draining into pans\)$/ }).check();
	await expectNoViolations(page);
	await sheet(page).getByTestId('divide-apply').click();
	const confirm = page.getByRole('alertdialog', { name: 'Apply the ticked values?' });
	await expect(confirm).toContainText('The model takes 2 areas (each saved as its unit’s parcel; 1 without what drains into pans)');
	await confirm.getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Divided the model from the map.');

	const listed = await (await page.request.get(`${API_URL}/projects/${v.id}/map/features`)).json();
	const by = Object.fromEntries(listed.nodes.map((n: { id: string; areaBasis: string | null; areaKm2: number; areaFeatureId: string }) => [n.id, n]));
	expect(by[v.pump.id].areaBasis).toBe('gross');
	expect(by[v.dam.id].areaBasis).toBe('effective');
	const parcel = listed.features.find((f: { id: string }) => f.id === by[v.dam.id].areaFeatureId);
	expect(parcel.nonContributingM2).toBeGreaterThan(0);
	expect(by[v.dam.id].areaKm2).toBeCloseTo((parcel.areaM2 - parcel.nonContributingM2) / 1e6, 6);
	// The unit's card on the map says its area is the effective one.
	await page.goto(`/projects/${v.id}?tab=map&feature=${parcel.id}`);
	await expect(page.getByTestId('map-card-area-source')).toContainText(/Valley dam: [\d.]+ km² \(effective, without pans\) · From the map this farm parcel/);
});

test('Discard changes nothing; a viewer is offered no division, and a link to it does nothing', async ({ page, owner, signIn }) => {
	void owner;
	const v = await valley(page, 'Divide discard');
	await openMap(page, v.id, '&divide=1');
	await sheet(page).getByTestId('divide-propose').click();
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'review');
	await expect(page.getByTestId('map-divide-open')).toHaveCount(0);
	await sheet(page).getByTestId('divide-discard').click();
	await page.getByRole('alertdialog', { name: 'Discard the proposed division?' }).getByRole('button', { name: 'Discard' }).click();
	await expect(page.getByTestId('map-notice')).toHaveText(/Discarded the proposed division; nothing in the model changed\./);
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'points');
	const model = (await (await page.request.get(`${API_URL}/projects/${v.id}/model`)).json()) as { nodes: ApiNode[] };
	expect(model.nodes.map((n) => [n.name, n.areaKm2])).toEqual([
		['Valley weir', 12],
		['Valley dam', 300],
		['Top pump', 12],
		['Hillside', 20]
	]);

	const viewer = await signIn('Divide viewer');
	await addMember(page.request, v.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${v.id}?tab=map&divide=1`);
	await expect(viewer.page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(viewer.page).not.toHaveURL(/divide=/);
	await expect(viewer.page.getByRole('dialog')).toHaveCount(0);
	await expect(viewer.page.getByTestId('map-divide-open')).toHaveCount(0);
});
