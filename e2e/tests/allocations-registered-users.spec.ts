// Registered users by hydrological unit (docs/allocations.md § Registered users by hydrological unit, § Demo
// registered users, § The map; docs/ui.md § Allocations): an editor loads invented demo registered users onto a
// synthetic project that has never run, through the app; the table lists each user per farm (Farm no., Registered
// user, Hydrological unit and the three registered figures), grouped by unit with a subtotal that adds up its rows,
// and a catchment total that adds up the subtotals. The map shades the units by what is registered, with no run,
// and keys the scale. A viewer (once What viewers see is on) reads the rows without names; at a phone's width the
// table stacks instead of scrolling. Remove demo users takes them away again. Synthetic data only.
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { openAllocations } from '../support/allocations.ts';
import { addMember, createProject, node, putModel, setAllocationViewerUnits } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('allocation-registered-users-panel');
const table = (page: Page) => page.getByTestId('allocation-registered-users');
const mapSection = (page: Page) => page.getByTestId('allocation-use-map');

const UNITS = ['Kloof farm', 'Vlei farm', 'Mapless farm'] as const;

/** A project that has never run: three farms with crops (one with a dam), the first two with an area on the Map tab. */
async function seedProject(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	const gauge = node('Outflow gauge', 'gauge', null, 1);
	const farms = UNITS.map((n, i) => node(n, 'farm', gauge.id, i + 2, i === 0 ? { damCapacityM3: 150_000 } : {}));
	const crop = { id: crypto.randomUUID(), name: 'Orchard', cropFactor: [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6] };
	await putModel(request, project.id, {
		nodes: [gauge, ...farms],
		crops: [crop],
		cropAreas: farms.map((f, i) => ({ nodeId: f.id, cropId: crop.id, areaM2: 100_000 * (i + 1) })),
		transfers: []
	});
	const poly = (nm: string, ring: [number, number][]) => ({ type: 'Feature', properties: { name: nm }, geometry: { type: 'Polygon', coordinates: [ring] } });
	const imp = await request.post(`${API_URL}/projects/${project.id}/map/import`, {
		data: {
			fileName: 'units.geojson',
			kind: 'farm_parcel',
			text: JSON.stringify({ type: 'FeatureCollection', features: UNITS.slice(0, 2).map((n, i) => poly(n, box(21.02 + i * 0.05, -33.98, 0.04))) })
		}
	});
	expect(imp.status(), await imp.text()).toBe(201);
	return { id: project.id, units: Object.fromEntries(UNITS.map((n, i) => [n, farms[i]!.id])) as Record<(typeof UNITS)[number], string> };
}

/** A table cell's figure ("12 500", "40.5"), or null for "–". */
const figure = async (cell: Locator): Promise<number | null> => {
	const t = (await cell.innerText()).trim();
	return t === '–' ? null : Number(t.replace(/[^\d.]/g, ''));
};
/** The three figures of a row: its last three cells (area, dam, use). */
const figures = async (row: Locator) => {
	const cells = row.getByRole('cell');
	const n = await cells.count();
	return Promise.all([n - 3, n - 2, n - 1].map((i) => figure(cells.nth(i))));
};
const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

/** Every group's rows add up to its subtotal, and the subtotals to the catchment total (to the hundredth: areas are 0.1 ha). */
async function expectSumsAddUp(page: Page) {
	const groups = table(page).getByTestId('allocation-registered-group');
	const subtotals: (number | null)[][] = [];
	for (const g of await groups.all()) {
		const rows = g.getByTestId('allocation-registered-user');
		expect(await rows.count()).toBeGreaterThanOrEqual(2);
		let sum: (number | null)[] = [null, null, null];
		for (const r of await rows.all()) {
			const f = await figures(r);
			sum = sum.map((s, i) => add(s, f[i]!));
		}
		const sub = await figures(g.getByTestId('allocation-registered-subtotal'));
		sub.forEach((v, i) => (v === null ? expect(sum[i]).toBeNull() : expect(v).toBeCloseTo(sum[i]!, 1)));
		subtotals.push(sub);
	}
	const total = await figures(table(page).getByTestId('allocation-registered-total'));
	const sum = subtotals.reduce((acc, s) => acc.map((a, i) => add(a, s[i]!)), [null, null, null] as (number | null)[]);
	total.forEach((v, i) => (v === null ? expect(sum[i]).toBeNull() : expect(v).toBeCloseTo(sum[i]!, 1)));
	return { subtotals, total };
}

test('an editor loads demo registered users; the table groups them by unit with subtotals and a catchment total that add up, the map shades them with no run, and Remove demo users takes them away', async ({ page, owner, signIn }) => {
	test.setTimeout(120_000);
	void owner;
	const project = await seedProject(page.request, 'Registered users');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openAllocations(page, project.id);

	// Nothing registered yet, and no run: the panel says so and offers the demo.
	await expect(panel(page).getByRole('heading', { name: 'Registered users by hydrological unit' })).toBeVisible();
	await expect(page.getByTestId('allocation-registered-users-empty')).toContainText('No registered users yet.');
	await panel(page).getByRole('button', { name: 'Load demo registered users' }).click();
	await answerConfirm(page, true, /invented.*for display only/);
	const notice = page.getByTestId('allocation-demo-notice');
	await expect(notice).toContainText('Demo registered users (invented) are shown');
	await expect(panel(page).getByRole('button', { name: 'Load demo registered users' })).toHaveCount(0);

	// The columns, in the operator's order.
	await expect(table(page).locator('thead th')).toHaveText([
		'Farm no.',
		'Registered user',
		'Hydrological unit',
		'Registered irrigated area (ha)',
		'Registered farm dam capacity (m³)',
		'Registered water use (m³/a)'
	]);
	// One group per unit, by the unit's name (the list's order), each user an invented name on a farm number like 123/456.
	const groups = table(page).getByTestId('allocation-registered-group');
	await expect(groups).toHaveCount(3);
	for (const [i, n] of ['Kloof farm', 'Mapless farm', 'Vlei farm'].entries()) {
		const g = groups.nth(i);
		await expect(g.locator('tr.group th')).toContainText(n);
		const rows = g.getByTestId('allocation-registered-user');
		for (const r of await rows.all()) {
			await expect(r.getByRole('rowheader')).toHaveText(/^\d{3}\/\d{1,3}$/);
			await expect(r.getByRole('cell').nth(0)).toHaveText(/\(invented\)$/);
			await expect(r.getByRole('cell').nth(1)).toHaveText(n);
		}
		await expect(g.getByTestId('allocation-registered-subtotal').getByRole('rowheader')).toHaveText(`Subtotal, ${n}`);
	}
	const { subtotals, total } = await expectSumsAddUp(page);
	// Each farm registers an area and a volume; only the farm with a dam registers a dam capacity.
	for (const s of subtotals) {
		expect(s[0]).toBeGreaterThan(0);
		expect(s[2]).toBeGreaterThan(0);
	}
	expect(subtotals[0]![1]).toBeGreaterThan(100_000);
	expect(subtotals[1]![1]).toBeNull();
	expect(subtotals[2]![1]).toBeNull();
	expect(total[1]).toBe(subtotals[0]![1]);
	await expect(table(page).getByTestId('allocation-registered-total').getByRole('rowheader')).toContainText('Catchment total');

	// The map: what is registered, no run needed (so no choice of the run's bands), keyed on a scale.
	await mapSection(page).getByRole('link', { name: 'Show the map' }).click();
	await expect(page).toHaveURL(/[?&]map=1/);
	await expect(mapSection(page).getByRole('radio', { name: 'Against the run' })).toHaveCount(0);
	const key = mapSection(page).getByTestId('allocation-map-legend');
	await expect(key).toHaveAttribute('data-view', 'registered');
	await expect(key.getByRole('heading')).toHaveText('Key: registered water use, m³ a year, in force today'); // clock-free: fixed wording (the key names what it counts), not a day from a clock.
	await expect(key.locator('li')).toHaveCount(6);
	await expect(key.locator('li[data-band="s1"]')).toContainText('Up to');
	await expect(key.locator('li[data-band="none"]')).toContainText('Nothing registered');
	// The largest unit is in the darker steps; each unit is counted once.
	const counted = await key.locator('li').evaluateAll((lis) => lis.map((li) => Number(/(\d+) units?/.exec(li.textContent ?? '')?.[1] ?? 0)).reduce((a, n) => a + n, 0));
	expect(counted).toBe(3);
	// The unit with no area is listed under the map with its figure.
	const unplaced = mapSection(page).getByTestId('allocation-map-unplaced').getByRole('listitem');
	await expect(unplaced).toHaveCount(1);
	await expect(unplaced.first()).toContainText('Mapless farm');
	await expect(unplaced.first()).toContainText('m³/a');
	const map = page.getByTestId('allocation-map');
	await expect(map).toHaveAttribute('data-status', /^(ready|failed)$/);
	if ((await map.getAttribute('data-status')) === 'ready') {
		const label = map.getByRole('button', { name: /^Kloof farm: / });
		await expect(label).toHaveText(/m³\/a$/);
		await expect(label).toHaveAttribute('data-band', /^s[1-5]$/);
		await expect(label).toHaveAccessibleName(/^Kloof farm: .* m³\/a registered water use, in force today\.$/); // clock-free: fixed wording (the key names what it counts), not a day from a clock.
		// A unit picked on the map shows its registered users in the table.
		await label.click();
		await expect(table(page).locator(`tbody[data-group="${project.units['Kloof farm']}"]`)).toBeInViewport();
	} else {
		await expect(page.getByTestId('allocation-map-unavailable')).toBeVisible();
	}
	// Shade by the dam: only the farm with one registers any.
	await mapSection(page).getByRole('radio', { name: 'Dam capacity' }).check();
	await expect(key.getByRole('heading')).toHaveText('Key: registered farm dam capacity, m³, in force today'); // clock-free: fixed wording (the key names what it counts), not a day from a clock.
	await expect(key.locator('li[data-band="none"]')).toContainText('2 units');
	await expectNoViolations(page);

	// A viewer: totals only until an owner lets viewers see each volume; then the rows, with no name anywhere.
	const viewer = await signIn('Registered users viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await openAllocations(v, project.id);
	await expect(v.getByTestId('allocation-totals')).toBeVisible();
	await expect(panel(v)).toHaveCount(0);
	await setAllocationViewerUnits(page.request, project.id, true);
	await openAllocations(v, project.id, '&map=1');
	await expect(table(v).locator('thead th')).toHaveText(['Farm no.', 'Hydrological unit', 'Registered irrigated area (ha)', 'Registered farm dam capacity (m³)', 'Registered water use (m³/a)']);
	await expect(table(v)).not.toContainText('(invented)');
	await expect(panel(v)).toContainText('Names of registered users are shown to editors only.');
	await expect(panel(v).getByRole('button', { name: 'Load demo registered users' })).toHaveCount(0);
	await expect(panel(v).getByRole('button', { name: 'Remove demo users' })).toHaveCount(0);
	await expect(v.getByTestId('allocation-demo-notice')).toBeVisible();
	await expectSumsAddUp(v);
	await expect(mapSection(v).getByTestId('allocation-map-legend')).toBeVisible();
	await expectNoViolations(v);

	// A phone: the table stacks rather than scrolls sideways, and the page doesn't either.
	await page.setViewportSize({ width: 390, height: 844 });
	await openAllocations(page, project.id);
	await expect(table(page)).toBeVisible();
	await expectNoSidewaysScroll(page);
	expect(await panel(page).locator('.table-wrap').evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
	await expect(table(page).locator('thead')).toBeHidden();
	await expectNoViolations(page);

	// Remove demo users: the rows go, the notice with them, and the demo can be loaded again.
	await panel(page).getByRole('button', { name: 'Remove demo users' }).click();
	await answerConfirm(page, true, 'Volumes entered by hand or imported stay');
	await expect(page.getByTestId('allocation-demo-notice')).toHaveCount(0);
	await expect(page.getByTestId('allocation-registered-users-empty')).toBeVisible();
	await expect(panel(page).getByRole('button', { name: 'Load demo registered users' })).toBeVisible();
});
