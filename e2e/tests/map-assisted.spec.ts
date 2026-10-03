// Assisted drawing on the catchment map (issue #326 C2; docs/maps.md §
// Assisted drawing, docs/ui.md § Map). Snapping, with the mouse and with the
// keys: the map framed on a boundary whose middle is a parcel's corner, a
// click a few pixels off it lands on the corner (the live region says so,
// read back, never the pixels), Alt+click and Snap to features off place it
// where it is, and Enter at the crosshair snaps too. Splitting, by pasting
// the cut (the non-pointer way): a line that misses is refused with its
// reason, the boundary is split into two named areas and stays whole, and a
// parcel split keeps its name on the first part. Tracing a dam against the
// committed synthetic water raster (WATER_URL, support/water.ts), from typed
// coordinates: dry land is refused, the dam's outline comes back as a
// drawing that says where it came from, and saving it records the method.
// Axe on the split preview and the traced drawing, light and dark.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box, openMap, showTab } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { WATER_DAM, WATER_DRY } from '../support/water.ts';

const list = (page: Page) => page.getByTestId('map-feature-list');
const card = (page: Page) => page.getByTestId('map-feature-card');
const bar = (page: Page) => page.getByTestId('map-draw-bar');
const said = (page: Page) => page.getByTestId('map-draw-said');
/** Every regular-expression metacharacter escaped, backslash included, so a name is matched literally. */
const literal = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const row = (page: Page, name: string) => list(page).getByRole('button', { name: new RegExp(`^${literal(name)}(\\b|\\s)`) });
const canvas = (page: Page) => page.getByTestId('catchment-map').locator('canvas');

/** Features made through the API (the drawing tools are what's under test, not the upload). */
async function place(page: Page, projectId: string, data: Record<string, unknown>) {
	const r = await page.request.post(`${API_URL}/projects/${projectId}/map/features`, { data });
	expect(r.status()).toBe(201);
	return (await r.json()).feature as { id: string; name: string };
}
const boundary = { kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [box(21.3, -33.7, 0.1)] } };

async function features(page: Page, projectId: string) {
	return (await (await page.request.get(`${API_URL}/projects/${projectId}/map/features`)).json()).features as { id: string; kind: string; name: string; areaM2: number | null; properties: Record<string, string> }[];
}

async function paste(page: Page, text: string) {
	await bar(page).getByRole('button', { name: 'Paste a shape' }).click();
	const sheet = page.getByRole('dialog', { name: 'Paste a shape' });
	await sheet.getByLabel('GeoJSON or WKT').fill(text);
	await sheet.getByRole('button', { name: 'Use this shape' }).click();
	await expect(sheet).toBeHidden();
}

test('snapping: a click near a parcel’s corner lands on it; Alt, and Snap to features off, place it exactly; Enter snaps too', async ({ page, owner }) => {
	void owner;
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Map snap');
	await place(page, project.id, boundary);
	// Its north-east corner is the boundary's middle, where Show everything centres the map.
	await place(page, project.id, { kind: 'farm_parcel', name: 'Upper farm', geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.04)] } });
	await openMap(page, project.id);
	await expect(page.locator('.map-wrap[data-status="ready"]')).toBeVisible();
	await page.getByTestId('map-show-everything').click();

	// The draw bar takes room above the map, which keeps its middle: measure the canvas once it is there.
	await page.getByTestId('map-tools').getByRole('button', { name: 'Draw a shape', exact: true }).click();
	await expect(bar(page).getByLabel('Snap to features')).toBeChecked();
	const b = (await canvas(page).boundingBox())!;
	const near = { x: b.x + b.width / 2 + 5, y: b.y + b.height / 2 - 4 };
	await page.mouse.click(near.x, near.y);
	await expect(said(page)).toHaveText('Corner 1 at 33.6500° S, 21.3500° E, on “Upper farm”’s corner.');

	// Alt with the click: exactly where it is, no snap.
	await bar(page).getByRole('button', { name: 'Undo' }).click();
	await canvas(page).click({ position: { x: near.x - b.x, y: near.y - b.y }, modifiers: ['Alt'] });
	await expect(said(page)).toHaveText(/^Corner 1 at [\d.]+° S, [\d.]+° E\.$/);
	await expect(said(page)).not.toHaveText(/33\.6500° S, 21\.3500° E/);

	// Snap to features off: the same.
	await bar(page).getByRole('button', { name: 'Undo' }).click();
	await bar(page).getByLabel('Snap to features').uncheck();
	await page.mouse.click(near.x, near.y);
	await expect(said(page)).not.toContainText('Upper farm');
	// The choice lasts while the tab is open: on again for the next drawing.
	await bar(page).getByLabel('Snap to features').check();
	await bar(page).getByRole('button', { name: 'Cancel' }).click();

	// By keyboard: the crosshair at the map's middle is the corner; Enter places it there, on the corner.
	await page.mouse.move(b.x + b.width + 50, b.y + b.height / 2);
	await page.getByTestId('map-tools').getByRole('button', { name: 'Draw a shape', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(canvas(page)).toBeFocused();
	await expect(page.getByTestId('map-crosshair')).toBeVisible();
	await expect(canvas(page)).toHaveAttribute('aria-label', /Alt\+Enter places it exactly/);
	await page.keyboard.press('Enter');
	await expect(said(page)).toHaveText(/, on “Upper farm”’s corner\.$/);
	await page.keyboard.press('Escape');
	await expect(bar(page)).toHaveCount(0);
});

test('splitting: the boundary into two named areas (it stays whole), a parcel in two; a line that misses is refused', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map split');
	await place(page, project.id, boundary);
	const parcel = await place(page, project.id, { kind: 'farm_parcel', name: 'Upper farm', geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.04)] } });
	await openMap(page, project.id);

	await showTab(page, 'features');
	await row(page, 'Synthetic catchment').click();
	await card(page).getByRole('button', { name: 'Split along a line' }).click();
	await expect(bar(page).getByRole('heading', { name: 'Splitting “Synthetic catchment”' })).toBeVisible();

	// A line inside the shape cuts nothing: the bar says why and Split… waits.
	await paste(page, 'LINESTRING(21.32 -33.65, 21.33 -33.65)');
	await expect(page.getByTestId('map-draw-problem')).toContainText('Draw the line right across the shape');
	await expect(bar(page).getByRole('button', { name: 'Split…' })).toBeDisabled();

	// Right across it, north to south down the middle.
	await paste(page, 'LINESTRING(21.35 -33.75, 21.35 -33.55)');
	// Which part is which, in words: where each lies and its area (also said in the live region).
	await expect(page.getByTestId('map-split-parts')).toHaveText(/^Cut in two: part 1, the (western|eastern), about 5\d\.\d+ km², and part 2, the (western|eastern), about 5\d\.\d+ km²\.$/);
	await expect(said(page)).toHaveText(/^Cut in two: part 1, the /);
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	await bar(page).getByRole('button', { name: 'Split…' }).click();
	const sheet = page.getByRole('dialog', { name: 'Split the shape' });
	await expect(sheet.getByLabel('The parts are')).toHaveValue('other');
	await expect(sheet.getByLabel(/^Part 1/)).toHaveValue('Synthetic catchment part 1');
	await expect(sheet.getByText(/^Part 1 \(the (western|eastern) part, about/)).toBeVisible();
	await sheet.getByLabel(/^Part 1/).fill('West unit');
	await sheet.getByLabel(/^Part 2/).fill('East unit');
	await sheet.getByTestId('split-submit').click();
	await expect(sheet).toBeHidden();
	await expect(bar(page)).toHaveCount(0);
	await expect(page.getByTestId('map-notice')).toHaveText(/Split Synthetic catchment in two: “West unit” and “East unit”\./);
	await showTab(page, 'features');
	await expect(row(page, 'West unit')).toContainText('km²');
	await expect(row(page, 'Synthetic catchment')).toBeVisible();

	let all = await features(page, project.id);
	const whole = all.find((f) => f.kind === 'catchment_boundary')!.areaM2!;
	const halves = all.filter((f) => f.name === 'West unit' || f.name === 'East unit');
	expect(halves.map((f) => f.kind)).toEqual(['other', 'other']);
	expect(Math.abs(halves[0]!.areaM2! + halves[1]!.areaM2! - whole) / whole).toBeLessThan(0.001);
	expect(halves[0]!.properties.description).toBe('Split from “Synthetic catchment” along a drawn line.');

	// A parcel: it keeps its name and id on the first part.
	await showTab(page, 'features');
	await row(page, 'Upper farm').click();
	await card(page).getByRole('button', { name: 'Split along a line' }).click();
	await paste(page, 'LINESTRING(21.30 -33.67, 21.36 -33.67)');
	await bar(page).getByRole('button', { name: 'Split…' }).click();
	await expect(page.getByRole('dialog', { name: 'Split the shape' }).getByLabel('The parts are')).toHaveCount(0);
	await page.getByTestId('split-submit').click();
	await showTab(page, 'features');
	await expect(row(page, 'Upper farm (part 2)')).toBeVisible();
	all = await features(page, project.id);
	expect(all.filter((f) => f.kind === 'farm_parcel').map((f) => f.name).sort()).toEqual(['Upper farm', 'Upper farm (part 2)']);
	expect(all.find((f) => f.name === 'Upper farm')!.id).toBe(parcel.id);
});

test('tracing a dam from typed coordinates: dry land is refused; the outline comes back to adjust and is saved with its method', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map trace');
	await place(page, project.id, boundary);
	await openMap(page, project.id);

	await page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true }).click();
	await expect(bar(page).getByRole('heading', { name: 'Tracing a dam' })).toBeVisible();
	// No snapping while placing a trace's point: it would pull a click in the water onto a shoreline.
	await expect(bar(page).getByLabel('Snap to features')).toHaveCount(0);
	await page.getByTestId('map-enter-coordinates').click();
	const sheet = page.getByRole('dialog', { name: 'Trace a dam' });
	await expect(page).toHaveURL(/[?&]trace=1(&|$)/);
	await sheet.getByLabel('Latitude').fill(String(WATER_DRY[1]));
	await sheet.getByLabel('Longitude').fill(String(WATER_DRY[0]));
	await sheet.getByTestId('trace-submit').click();
	await expect(sheet.getByTestId('trace-error')).toContainText('No water is mapped there (in at least 25 % of the observations)');

	await sheet.getByLabel('Latitude').fill(String(WATER_DAM[1]));
	await sheet.getByLabel('Longitude').fill(String(WATER_DAM[0]));
	await sheet.getByLabel('Count a cell as water if it was water in at least').selectOption('50');
	await sheet.getByTestId('trace-submit').click();
	await expect(sheet).toBeHidden();
	await expect(bar(page)).toHaveAttribute('data-phase', 'review');
	await expect(bar(page).getByLabel('Drawing')).toHaveValue('dam');
	await expect(page.getByTestId('map-trace-source')).toContainText('Traced from Synthetic water occurrence');
	// The sheet's Trace went with the sheet: the next step, Save…, has the focus; the URL lost trace=1.
	await expect(bar(page).getByRole('button', { name: 'Save…' })).toBeFocused();
	await expect(page).not.toHaveURL(/[?&]trace=/);
	await expect(page.getByTestId('map-trace-source')).toContainText('water in at least 50 % of the observations');
	await expect(said(page)).toHaveText(/^Traced a dam outline with \d+ corners\./);
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });

	await bar(page).getByRole('button', { name: 'Save…' }).click();
	const save = page.getByRole('dialog', { name: 'Save the drawing' });
	await expect(save.getByLabel('This shape is')).toHaveValue('dam');
	await expect(save.getByTestId('map-draft-traced')).toBeVisible();
	await save.getByLabel('Name (optional)').fill('Traced dam');
	await save.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(save).toBeHidden();
	await showTab(page, 'features');
	await expect(row(page, 'Traced dam')).toContainText('ha');
	const dam = (await features(page, project.id)).find((f) => f.name === 'Traced dam')!;
	expect(dam.kind).toBe('dam');
	expect(dam.properties.description).toMatch(/^Traced from Synthetic water occurrence .*water in at least 50 % of the observations/);
});

test('one placing mode at a time: Trace a dam, then Place a point or Delineate, leaves tracing', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map trace modes');
	await place(page, project.id, boundary);
	await openMap(page, project.id);
	await page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true }).click();
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.getByTestId('map-tools').getByRole('button', { name: 'Place a point', exact: true }).click();
	await expect(bar(page).getByLabel('Placing a point')).toBeVisible();
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true })).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Place a point', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.getByTestId('map-enter-coordinates').click();
	await expect(page.getByRole('dialog', { name: 'Place a point' })).toBeVisible();
	await page.getByRole('dialog', { name: 'Place a point' }).getByRole('button', { name: 'Close' }).last().click();
	await page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true }).click();
	await page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true }).click();
	await expect(bar(page).getByRole('heading', { name: 'Delineating a catchment' })).toBeVisible();
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true })).toHaveAttribute('aria-pressed', 'false');
	await bar(page).getByRole('button', { name: 'Cancel' }).click();

	// A traced outline drawn as something else is no longer the trace, and says so.
	await page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true }).click();
	await page.getByTestId('map-enter-coordinates').click();
	const sheet = page.getByRole('dialog', { name: 'Trace a dam' });
	await sheet.getByLabel('Latitude').fill(String(WATER_DAM[1]));
	await sheet.getByLabel('Longitude').fill(String(WATER_DAM[0]));
	await sheet.getByTestId('trace-submit').click();
	await expect(page.getByTestId('map-trace-source')).toBeVisible();
	await bar(page).getByLabel('Drawing').selectOption('farm_parcel');
	await expect(page.getByTestId('map-trace-source')).toHaveCount(0);
	await expect(said(page)).toHaveText('No longer a traced dam outline: it saves as a drawing.');
	await bar(page).getByRole('button', { name: 'Save…' }).click();
	await expect(page.getByRole('dialog', { name: 'Save the drawing' }).getByLabel('This shape is')).toHaveValue('farm_parcel');
});

test('on a phone the assisted tools fit and pass axe; a viewer gets neither Trace a dam nor Split along a line', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map assisted phone');
	await place(page, project.id, boundary);
	await page.setViewportSize({ width: 390, height: 844 });
	await openMap(page, project.id);
	await showTab(page, 'features');
	await row(page, 'Synthetic catchment').click();
	await card(page).getByRole('button', { name: 'Split along a line' }).click();
	await paste(page, 'LINESTRING(21.35 -33.75, 21.35 -33.55)');
	await expect(page.getByTestId('map-split-parts')).toBeVisible();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
	await bar(page).getByRole('button', { name: 'Cancel' }).click();
	await page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true }).click();
	await expect(bar(page).getByRole('combobox', { name: /^Water in at least\b/ })).toHaveValue('25');
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);

	const viewer = await signIn('Assisted viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await openMap(viewer.page, project.id);
	await expect(viewer.page.getByTestId('map-tools').getByRole('button', { name: 'Draw a shape', exact: true })).toHaveCount(0);
	await expect(viewer.page.getByTestId('map-tools').getByRole('button', { name: 'Trace a dam', exact: true })).toHaveCount(0);
	await showTab(viewer.page, 'features');
	await row(viewer.page, 'Synthetic catchment').click();
	await expect(card(viewer.page).getByRole('heading', { name: 'Synthetic catchment' })).toBeVisible();
	await expect(card(viewer.page).getByRole('button', { name: 'Split along a line' })).toHaveCount(0);
});
