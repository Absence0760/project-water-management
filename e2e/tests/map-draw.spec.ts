// Drawing on the catchment map (issue #326 C1, D1, D4; docs/ui.md § Map,
// docs/maps.md § Drawing). The non-pointer ways first: the empty state's Draw
// the boundary, a pasted WKT boundary saved through its sheet, a pasted line
// refused for a polygon and a bow tie refused; a parcel drawn with the keys
// (the crosshair, Enter, Backspace, Escape: at once with one corner, asking
// with three, Keep drawing and Discard drawing); a parcel reshaped from the card
// by pasting. Then one deterministic pointer case (fixed viewport, the map
// framed on the boundary): a polygon clicked corner by corner and a point
// placed by a click, each read back from the list, never from pixels. A
// phone's Use my location fills the Place sheet. Axe while drawing, light and
// dark.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, openMap, parcelsGeoJson, uploadThroughSheet } from '../support/map.ts';

const header = (page: Page) => page.getByTestId('section-header');
const list = (page: Page) => page.getByTestId('map-feature-list');
const card = (page: Page) => page.getByTestId('map-feature-card');
const bar = (page: Page) => page.getByTestId('map-draw-bar');
const row = (page: Page, name: string) => list(page).getByRole('button', { name: new RegExp(`^${name}\\b`) });
const canvas = (page: Page) => page.getByTestId('catchment-map').locator('canvas');
/** The map drew (WebGL): clicks and keys on it work. */
const mapReady = (page: Page) => expect(page.locator('.map-wrap[data-status="ready"]')).toBeVisible();

async function paste(page: Page, text: string) {
	await bar(page).getByRole('button', { name: 'Paste a shape' }).click();
	const sheet = page.getByRole('dialog', { name: 'Paste a shape' });
	await sheet.getByLabel('GeoJSON or WKT').fill(text);
	await sheet.getByRole('button', { name: 'Use this shape' }).click();
	return sheet;
}

test('the empty state draws the boundary: a pasted WKT outline, refused shapes first, saved through its sheet', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map draw paste');
	await openMap(page, project.id);

	await page.getByTestId('map-no-boundary').getByRole('button', { name: 'Draw the boundary' }).click();
	await expect(bar(page)).toBeVisible();
	await expect(header(page).getByRole('button', { name: 'Draw a shape' })).toHaveAttribute('aria-pressed', 'true');
	await expect(bar(page).getByLabel('Drawing')).toHaveValue('catchment_boundary');
	await expect(bar(page).getByRole('button', { name: 'Finish' })).toBeDisabled();
	await expect(bar(page).getByRole('button', { name: 'Undo' })).toBeDisabled();

	// A line isn't a polygon, and an outline that crosses itself isn't a shape: each says so, and the sheet stays.
	let sheet = await paste(page, 'LINESTRING(21.3 -33.6, 21.4 -33.7)');
	await expect(sheet.getByTestId('map-paste-error')).toHaveText('That’s a line, and this drawing is a polygon. Pick River or Other line in the draw bar first, or paste a polygon.');
	await sheet.getByLabel('GeoJSON or WKT').fill('POLYGON((21.3 -33.7, 21.4 -33.6, 21.4 -33.7, 21.3 -33.6))');
	await sheet.getByRole('button', { name: 'Use this shape' }).click();
	await expect(sheet.getByTestId('map-paste-error')).toHaveText('Its outline crosses itself: move or remove a corner so the edges don’t cross.');
	await expectNoViolations(page);

	// An open outline is closed for it; the drawing is ready to adjust and save.
	await sheet.getByLabel('GeoJSON or WKT').fill('POLYGON((21.30 -33.70, 21.40 -33.70, 21.40 -33.60, 21.30 -33.60))');
	await sheet.getByRole('button', { name: 'Use this shape' }).click();
	await expect(sheet).toBeHidden();
	await expect(bar(page)).toHaveAttribute('data-phase', 'review');
	await expect(page.getByTestId('map-draw-said')).toHaveText('Pasted: 4 corners.');

	// Nothing is saved until the sheet's Save: Back to the map keeps the drawing.
	await bar(page).getByRole('button', { name: 'Save…' }).click();
	sheet = page.getByRole('dialog', { name: 'Save the drawing' });
	await expect(sheet.getByLabel('This shape is')).toHaveValue('catchment_boundary');
	await sheet.getByRole('button', { name: 'Back to the map' }).click();
	await expect(bar(page)).toBeVisible();
	await expect(page.getByTestId('map-summary')).toHaveText('Nothing on the map yet');
	await bar(page).getByRole('button', { name: 'Save…' }).click();
	await sheet.getByLabel('Name (optional)').fill('Drawn catchment');
	await sheet.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(sheet).toBeHidden();
	await expect(bar(page)).toHaveCount(0);
	await expect(page.getByTestId('map-notice')).toHaveText(/Saved catchment boundary “Drawn catchment” on the map\./);
	await expect(card(page).getByRole('heading', { name: 'Drawn catchment' })).toBeVisible();
	await expect(row(page, 'Drawn catchment')).toContainText('km²');
	await expect(page.getByTestId('map-summary')).toContainText('1 feature · boundary');
});

test('a parcel drawn with the keyboard: the crosshair, Enter adds a corner, Backspace removes it, Escape cancels (asking once there is work to lose)', async ({ page, owner }) => {
	void owner;
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Map draw keyboard');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await mapReady(page);

	// From the keyboard: the button, then the map has the focus and the crosshair; with a boundary, a parcel is drawn.
	await header(page).getByRole('button', { name: 'Draw a shape' }).focus();
	await page.keyboard.press('Enter');
	await expect(bar(page).getByLabel('Drawing')).toHaveValue('farm_parcel');
	await expect(canvas(page)).toBeFocused();
	await expect(page.getByTestId('map-crosshair')).toBeVisible();
	await expect(canvas(page)).toHaveAttribute('aria-label', /drawing: the arrow keys move the map under the crosshair, Enter adds a corner there/);

	// Escape cancels; drawing again starts empty.
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('map-draw-said')).toHaveText(/^Corner 1 at \d+\.\d{4}° S, \d+\.\d{4}° E\.$/);
	await page.keyboard.press('Escape');
	await expect(bar(page)).toHaveCount(0);
	await header(page).getByRole('button', { name: 'Draw a shape' }).focus();
	await page.keyboard.press('Enter');
	await expect(canvas(page)).toBeFocused();

	// With three corners Escape asks first; Discard drawing drops them.
	await expect(canvas(page)).toHaveAttribute('aria-label', /Escape cancels \(asking first once two are placed\)/);
	for (const key of ['Enter', 'ArrowRight', 'Enter', 'ArrowDown', 'Enter']) await page.keyboard.press(key);
	await expect(page.getByTestId('map-draw-said')).toHaveText(/^Corner 3 at /);
	await page.keyboard.press('Escape');
	let ask = page.getByRole('alertdialog', { name: 'Discard this drawing?' });
	await expect(ask.getByTestId('confirm-message')).toHaveText('The shape you drew hasn’t been saved.');
	await ask.getByRole('button', { name: 'Discard drawing' }).click();
	await expect(ask).toBeHidden();
	await expect(bar(page)).toHaveCount(0);
	await header(page).getByRole('button', { name: 'Draw a shape' }).focus();
	await page.keyboard.press('Enter');
	await expect(canvas(page)).toBeFocused();
	await expect(bar(page).getByRole('button', { name: 'Undo' })).toBeDisabled();

	// Corners at the crosshair, the map panned between them (reduced motion: the pan is instant).
	await page.keyboard.press('Enter');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('map-draw-said')).toHaveText(/^Corner 2 at /);
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('map-draw-said')).toHaveText(/^Corner 3 at /);
	await page.keyboard.press('Backspace');
	await expect(page.getByTestId('map-draw-said')).toHaveText('Undone; 2 corners.');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('map-draw-said')).toHaveText(/^Corner 3 at /);

	// Escape again: Keep drawing (Escape in the question answers the same) keeps all three corners and the focus.
	await page.keyboard.press('Escape');
	ask = page.getByRole('alertdialog', { name: 'Discard this drawing?' });
	await ask.getByRole('button', { name: 'Keep drawing' }).click();
	await expect(ask).toBeHidden();
	await expect(bar(page)).toHaveAttribute('data-phase', 'drawing');
	await expect(page.getByTestId('map-draw-said')).toHaveText(/^Corner 3 at /);
	await expect(canvas(page)).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(ask).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(ask).toBeHidden();
	await expect(bar(page)).toBeVisible();

	await bar(page).getByRole('button', { name: 'Finish' }).click();
	await expect(page.getByTestId('map-draw-said')).toHaveText('Shape closed with 3 corners. Drag a corner to adjust it, then save.');
	await bar(page).getByRole('button', { name: 'Save…' }).click();
	const sheet = page.getByRole('dialog', { name: 'Save the drawing' });
	await sheet.getByLabel('Name (optional)').fill('Keyboard parcel');
	await sheet.getByLabel('Stands for (optional)').selectOption({ label: 'Upper farm' });
	await sheet.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(sheet).toBeHidden();
	await expect(row(page, 'Keyboard parcel')).toContainText('Upper farm');
	await expect(card(page).getByRole('heading', { name: 'Keyboard parcel' })).toBeVisible();
	await expect(card(page)).toContainText('Farm parcel');
});

test('a parcel reshaped from its card by pasting, saved at once', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map draw edit');
	await openMap(page, project.id);
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	await row(page, 'Upper farm').click();
	const before = await row(page, 'Upper farm').textContent();

	await card(page).getByRole('button', { name: 'Edit the shape' }).click();
	await expect(bar(page).getByRole('heading', { name: 'Editing “Upper farm”' })).toBeVisible();
	await paste(page, '{"type":"Polygon","coordinates":[[[21.30,-33.70],[21.32,-33.70],[21.32,-33.68],[21.30,-33.68],[21.30,-33.70]]]}');
	await bar(page).getByRole('button', { name: 'Save the shape' }).click();
	await expect(page.getByTestId('map-notice')).toHaveText(/Saved the new shape of Upper farm\./);
	await expect(bar(page)).toHaveCount(0);
	await expect(row(page, 'Upper farm')).not.toHaveText(before ?? '');
});

test('with the mouse: a polygon clicked corner by corner and a point placed by a click, read back from the list', async ({ page, owner }) => {
	void owner;
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Map draw mouse');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await mapReady(page);
	await header(page).getByRole('button', { name: 'Show everything' }).click();

	const b = (await canvas(page).boundingBox())!;
	const at = (fx: number, fy: number) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
	await header(page).getByRole('button', { name: 'Draw a shape' }).click();
	await expect(page.getByTestId('map-crosshair')).toHaveCount(0);
	for (const [fx, fy] of [
		[0.4, 0.4],
		[0.6, 0.4],
		[0.5, 0.6]
	] as const) {
		const p = at(fx, fy);
		await page.mouse.click(p.x, p.y);
	}
	await expect(page.getByTestId('map-draw-said')).toHaveText(/^Corner 3 at /);
	// The first corner closes the shape.
	const first = at(0.4, 0.4);
	await page.mouse.click(first.x, first.y);
	await expect(bar(page)).toHaveAttribute('data-phase', 'review');
	await bar(page).getByRole('button', { name: 'Save…' }).click();
	const sheet = page.getByRole('dialog', { name: 'Save the drawing' });
	await sheet.getByLabel('Name (optional)').fill('Clicked parcel');
	await sheet.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(row(page, 'Clicked parcel')).toBeVisible();
	await expect(row(page, 'Clicked parcel')).toContainText(/km²|ha/);

	// A point: click to place, the coordinates behind Enter coordinates, filled in from the click.
	await header(page).getByRole('button', { name: 'Place a point' }).click();
	await bar(page).getByLabel('Placing a point').selectOption('dam');
	const p = at(0.3, 0.7);
	await page.mouse.click(p.x, p.y);
	await expect(page.getByTestId('map-draw-said')).toHaveText(/^Point at /);
	await bar(page).getByRole('button', { name: 'Save…' }).click();
	const place = page.getByRole('dialog', { name: 'Place a point' });
	await expect(place.getByTestId('map-place-at')).toContainText('Put on the map at');
	await expect(place.locator('details')).not.toHaveAttribute('open', '');
	await expect(place.getByLabel('Kind')).toHaveValue('dam');
	await place.getByText('Enter coordinates').click();
	await expect(place.getByLabel('Latitude')).toHaveValue(/^-33\.\d+$/);
	await place.getByLabel('Name (optional)').fill('Clicked dam');
	await place.getByRole('button', { name: 'Place the point' }).click();
	await expect(place).toBeHidden();
	await expect(bar(page)).toHaveCount(0);
	await expect(row(page, 'Clicked dam')).toContainText('° S');
});

test('on a phone, Use my location places the point there, asked only on the tap', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	await page.context().grantPermissions(['geolocation']);
	await page.context().setGeolocation({ latitude: -33.65, longitude: 21.35 });
	const project = await seedRunnableProject(page.request, 'Map draw locate');
	await openMap(page, project.id);
	await header(page).getByRole('button', { name: 'Place a point' }).click();
	await bar(page).getByRole('button', { name: 'Use my location' }).click();
	await expect(page.getByTestId('map-draw-said')).toHaveText('Point at 33.6500° S, 21.3500° E.');
	await bar(page).getByRole('button', { name: 'Save…' }).click();
	const place = page.getByRole('dialog', { name: 'Place a point' });
	await expect(place.getByTestId('map-place-at')).toContainText('33.6500° S, 21.3500° E');
	await place.getByRole('button', { name: 'Place the point' }).click();
	await expect(row(page, 'Gauge')).toContainText('33.6500° S, 21.3500° E');
});

for (const scheme of ['light', 'dark'] as const) {
	test(`drawing has no axe violations, ${scheme}`, async ({ page, owner }) => {
		void owner;
		await page.emulateMedia({ colorScheme: scheme });
		const project = await seedRunnableProject(page.request, `Map draw axe ${scheme}`);
		await openMap(page, project.id);
		await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
		await header(page).getByRole('button', { name: 'Draw a shape' }).click();
		await expect(bar(page)).toBeVisible();
		await expectNoViolations(page);
		await paste(page, 'POLYGON((21.31 -33.69, 21.33 -33.69, 21.33 -33.67, 21.31 -33.69))');
		await bar(page).getByRole('button', { name: 'Save…' }).click();
		await expect(page.getByRole('dialog', { name: 'Save the drawing' })).toBeVisible();
		await expectNoViolations(page);
	});
}
