// Divide a model that has nodes from the map (#326 C3's follow-up;
// docs/design/start-from-map.md § Dividing a model that has nodes, docs/ui.md
// § Map), against the committed synthetic DEM the e2e API reads (DEM_URL,
// support/dem.ts). The units follow the user's boundaries (start-16, #523
// C1): a typed model of the valley (the outflow weir, an upper and a lower
// unit, a hillside unit with no boundary) and on the map each unit's boundary
// linked to it, a dam and a pump inside the upper one linked to nothing, and
// an unlinked gauge. The editor opens Divide the model, each boundary
// standing for its unit, the dam and the pump left out (they never divide)
// and the gauge offered as a new gauge node, has the division proposed, sees
// each value beside the node's value now and the dam and pump joining the
// upper unit, can't apply an order into a gauge not being added, ticks, gives
// the rest of the catchment to the hillside unit and applies: only the ticked
// values change, and the dam and pump are linked to their unit. Axe-scanned
// on the review, light and dark, and on a phone. A viewer is offered none of
// it.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, node, putModel } from '../support/api.ts';
import { FIXTURE_DAM, FIXTURE_LOWER_UNIT, FIXTURE_MID_GAUGE, FIXTURE_OUTLET, FIXTURE_UPPER, FIXTURE_UPPER_UNIT } from '../support/dem.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap } from '../support/map.ts';

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Divide the model from the map' });
type ApiNode = { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number; pctRunoffToDam: number; damCapacityM3: number };
const area = (ring: [number, number][]) => ({ type: 'Polygon', coordinates: [ring] });

/** The valley typed in, and on the map each unit's boundary linked to it, the outlet gauge to the weir; the dam, the pump and the mid gauge linked to nothing. */
async function valley(page: Page, name: string) {
	const project = await createProject(page.request, name);
	const weir = node('Valley weir', 'gauge', null, 0);
	const upper = node('Upper unit', 'farm', weir.id, 1, { damCapacityM3: 200_000, areaKm2: 400 });
	const lower = node('Lower unit', 'farm', weir.id, 2, { areaKm2: 12 });
	const hill = node('Hillside', 'farm', weir.id, 3, { areaKm2: 20 });
	await putModel(page.request, project.id, { nodes: [weir, upper, lower, hill], crops: [], cropAreas: [], transfers: [] });
	const post = async (data: Record<string, unknown>) => {
		const r = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, { data });
		expect(r.status()).toBe(201);
		return ((await r.json()) as { feature: { id: string } }).feature.id;
	};
	await post({ kind: 'gauge', name: 'Weir', lon: FIXTURE_OUTLET[0], lat: FIXTURE_OUTLET[1], nodeId: weir.id });
	await post({ kind: 'other', name: 'Upper boundary', geometry: area(FIXTURE_UPPER_UNIT), nodeId: upper.id });
	await post({ kind: 'other', name: 'Lower boundary', geometry: area(FIXTURE_LOWER_UNIT), nodeId: lower.id });
	const dam = await post({ kind: 'dam', name: 'Dam wall', lon: FIXTURE_DAM[0], lat: FIXTURE_DAM[1] });
	const pump = await post({ kind: 'other', name: 'Pump', lon: FIXTURE_UPPER[0], lat: FIXTURE_UPPER[1] });
	await post({ kind: 'gauge', name: 'Mid weir', lon: FIXTURE_MID_GAUGE[0], lat: FIXTURE_MID_GAUGE[1] });
	return { id: project.id, weir, upper, lower, hill, f: { dam, pump } };
}

test('an editor divides a typed model from the map, value by value, beside the values now', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	const v = await valley(page, 'Divide from the map');
	await openMap(page, v.id);
	await page.getByTestId('map-divide-open').click();
	await expect(page).toHaveURL(/[?&]divide=1(&|$)/);
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'points');

	// Each boundary stands for its unit, the unlinked gauge a new gauge node; the weir is the outlet. A dam or a point
	// never stands for a unit: they are left out, offered only for an other water user (none here).
	await expect(sheet(page).getByLabel(/^Upper boundary/)).toHaveValue(v.upper.id);
	await expect(sheet(page).getByLabel(/^Lower boundary/)).toHaveValue(v.lower.id);
	await expect(sheet(page).getByLabel(/^Dam wall/)).toHaveValue('none');
	await expect(sheet(page).getByLabel(/^Dam wall/).locator('option')).toHaveText(['Not in the division']);
	await expect(sheet(page).getByLabel(/^Mid weir/)).toHaveValue('new-gauge');
	await expect(sheet(page).getByTestId('divide-outlet')).toHaveValue(/.+/);
	await expect(sheet(page).getByTestId('divide-count')).toHaveText('3 points in the division.');
	// Two boundaries can't stand for one node.
	await sheet(page).getByLabel(/^Lower boundary/).selectOption(v.upper.id);
	await expect(sheet(page).getByRole('alert')).toHaveText('Two points stand for Upper unit: each hydrological unit takes one point.');
	await expect(sheet(page).getByTestId('divide-propose')).toBeDisabled();
	await sheet(page).getByLabel(/^Lower boundary/).selectOption(v.lower.id);
	await sheet(page).getByTestId('divide-propose').click();

	// The review: upstream first, each value unticked, beside the node's value now.
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'review');
	const review = page.getByTestId('divide-review');
	const cards = review.getByTestId('divide-unit');
	await expect(cards).toHaveCount(3);
	const [up, mid, low] = [cards.nth(0), cards.nth(1), cards.nth(2)];
	await expect(up).toContainText('Upper unit');
	await expect(up).toContainText(/Area 3\d\d\.\d\d km², its boundary on the map \(the elevation model gives 3\d\d\.\d\d km² draining to its outflow\)\. Now:\s+400\.00 km², typed/);
	await expect(up).toContainText('Drains into Mid weir. Now: Valley weir');
	await expect(up.getByTestId('divide-composite-dam')).toContainText('Joins its composite dam: Dam wall.');
	await expect(up.getByTestId('divide-river-pump')).toContainText('Joins its river pump: Pump.');
	await expect(up.getByTestId('divide-tick-dam')).toHaveCount(0);
	await expect(mid).toContainText('A new gauge');
	await expect(low).toContainText('Drains into Valley weir. Now: Valley weir (the same)');
	await expect(review.getByTestId('divide-warnings')).toContainText('No point stands for Hillside: it keeps its values.');
	// The typed areas (400 + 12 + 20 km²) are within the catchment: nothing counts twice yet (round 4).
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

	// On the map: a number per unit (the gauge's beside its point), each card's the same; the rest has no outline beside the
	// boundaries. Closed, the page says what they are, and a number opens its card.
	await expect(page.getByTestId('catchment-map').locator('xpath=..')).toHaveAttribute('data-status', 'ready');
	await expect(page.locator('.piece-badge')).toHaveText(['1', '2', '3']);
	await expect(cards.nth(2).getByTestId('piece-badge')).toHaveText('Piece 3: 3');
	await up.getByTestId('divide-tick-area').focus();
	await expect(page.locator('.piece-badge[data-lit="true"]')).toHaveText('1');
	await sheet(page).getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByTestId('map-pieces-pending')).toContainText('A proposed division of the model is drawn on the map piece by piece');
	await page.locator('.piece-badge').filter({ hasText: '3' }).click();
	await expect(page).toHaveURL(/[?&]divide=1(&|$)/);
	await expect(low.getByTestId('divide-tick-area')).toBeFocused();

	// The upper unit's order into the new gauge needs the gauge added.
	await up.getByTestId('divide-tick-drains').check();
	await expect(review.getByTestId('divide-problem')).toHaveText('Upper unit would drain into the new gauge Mid weir, which isn’t being added: tick Add it too.');
	await expect(sheet(page).getByTestId('divide-apply')).toBeDisabled();
	await mid.getByTestId('divide-tick-add').check();
	await expect(review.getByTestId('divide-problem')).toHaveCount(0);
	await mid.getByLabel('Its name').fill('Halfway weir');
	await expect(up).toContainText('Drains into Halfway weir');
	// The lower unit's area; the gauge's order; the upper unit's area stays as typed (unticked).
	await low.getByTestId('divide-tick-area').check();
	await mid.getByTestId('divide-tick-drains').check();
	await review.getByTestId('divide-rest-to').selectOption(v.hill.id);
	// The upper unit keeps its typed 400 km², more than its boundary: the units would outgrow the catchment, said at the top
	// and beside the choice, naming the upper unit and not Hillside.
	await expect(review.getByTestId('divide-overlap')).toContainText('After Apply the units would add up to');
	await expect(review.getByTestId('divide-overlap')).not.toContainText('Hillside');
	await expect(review.getByTestId('divide-overlap-rest')).toContainText('Upper unit keeps its typed 400.00 km²: tick its area to take the proposed one.');
	await sheet(page).getByTestId('divide-apply').click();
	const confirm = page.getByRole('alertdialog', { name: 'Apply the ticked values?' });
	await expect(confirm).toContainText('The model takes 2 areas (a unit’s is its boundary on the map) and 2 drains-into, and 1 new gauge.');
	// The confirmation repeats the overlap, so land counted twice is never applied unseen.
	await expect(confirm).toContainText('more than the');
	await confirm.getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Divided the model from the map.');
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'points');

	const model = (await (await page.request.get(`${API_URL}/projects/${v.id}/model`)).json()) as { nodes: ApiNode[] };
	const by = Object.fromEntries(model.nodes.map((n) => [n.name, n]));
	expect(by['Halfway weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: v.lower.id });
	// The composite dam as typed: nothing filled from the map.
	expect(by['Upper unit']).toMatchObject({ downstreamNodeId: by['Halfway weir']!.id, areaKm2: 400, damCapacityM3: 200_000, pctRunoffToDam: 0.5 });
	expect(by['Lower unit']!.areaKm2).not.toBe(12);
	expect(by['Lower unit']!.downstreamNodeId).toBe(v.weir.id);
	// The dam and the pump stand for the upper unit now.
	const listed = await (await page.request.get(`${API_URL}/projects/${v.id}/map/features`)).json();
	const linked = Object.fromEntries(listed.features.map((f: { id: string; nodeId: string | null }) => [f.id, f.nodeId]));
	expect([linked[v.f.dam], linked[v.f.pump]]).toEqual([v.upper.id, v.upper.id]);
});

test('the rest of the catchment holding a pan asks which area it takes: gross until changed, the effective one applied as chosen (195)', async ({ page, owner }) => {
	void owner;
	const v = await valley(page, 'Divide effective area');
	await openMap(page, v.id, '&divide=1');
	// Only the new gauge: no boundary in the division, so the rest is the whole catchment, the valley's pan in it.
	await sheet(page).getByLabel(/^Upper boundary/).selectOption('none');
	await sheet(page).getByLabel(/^Lower boundary/).selectOption('none');
	await sheet(page).getByTestId('divide-propose').click();
	await expect(page.getByTestId('divide-sheet')).toHaveAttribute('data-step', 'review');
	const review = page.getByTestId('divide-review');
	await expect(review.getByTestId('divide-rest-area-basis')).toHaveCount(0);
	await review.getByTestId('divide-rest-to').selectOption(v.hill.id);
	const basis = review.getByTestId('divide-rest-area-basis');
	await expect(basis.getByRole('radio', { name: /^Gross, 5[34]\d\.\d\d km²/ })).toBeChecked();
	await basis.getByRole('radio', { name: /^Effective, \d+\.\d\d km² \(without the \d+\.\d\d km² draining into pans\)$/ }).check();
	await expectNoViolations(page);
	await sheet(page).getByTestId('divide-apply').click();
	const confirm = page.getByRole('alertdialog', { name: 'Apply the ticked values?' });
	await expect(confirm).toContainText('The model takes 1 area (a unit’s is its boundary on the map; 1 without what drains into pans) and 0 drains-into.');
	await confirm.getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Divided the model from the map.');

	const listed = await (await page.request.get(`${API_URL}/projects/${v.id}/map/features`)).json();
	const by = Object.fromEntries(listed.nodes.map((n: { id: string; areaBasis: string | null; areaKm2: number; areaFeatureId: string }) => [n.id, n]));
	expect(by[v.hill.id].areaBasis).toBe('effective');
	const parcel = listed.features.find((f: { id: string }) => f.id === by[v.hill.id].areaFeatureId);
	expect(parcel.nonContributingM2).toBeGreaterThan(0);
	expect(by[v.hill.id].areaKm2).toBeCloseTo((parcel.areaM2 - parcel.nonContributingM2) / 1e6, 6);
	// The unit's card on the map says its area is the effective one.
	await page.goto(`/projects/${v.id}?tab=map&feature=${parcel.id}`);
	await expect(page.getByTestId('map-card-area-source')).toContainText(/Hillside: [\d.]+ km² \(effective, without pans\) · From the map this farm parcel/);
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
		['Upper unit', 400],
		['Lower unit', 12],
		['Hillside', 20]
	]);
	// Nothing was linked either: the dam and the pump stand for nothing yet.
	const listed = await (await page.request.get(`${API_URL}/projects/${v.id}/map/features`)).json();
	expect(listed.features.filter((f: { id: string; nodeId: string | null }) => [v.f.dam, v.f.pump].includes(f.id)).map((f: { nodeId: string | null }) => f.nodeId)).toEqual([null, null]);

	const viewer = await signIn('Divide viewer');
	await addMember(page.request, v.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${v.id}?tab=map&divide=1`);
	await expect(viewer.page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(viewer.page).not.toHaveURL(/divide=/);
	await expect(viewer.page.getByRole('dialog')).toHaveCount(0);
	await expect(viewer.page.getByTestId('map-divide-open')).toHaveCount(0);
});
