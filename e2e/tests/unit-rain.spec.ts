// Rain for each hydrological unit (issue #482; docs/ui.md § Data feeds, §
// Settings & calibration, § Network; docs/maps.md § Rain for each unit). On
// the sample model with an invented parcel linked to one unit:
// - Settings → Data feeds → Rain for each unit proposes that unit's CHIRPS
//   cells, names the unit without a parcel, checks the start date before
//   anything is sent, and the owner's Create makes one feed into the unit's
//   own rain series, whose card says it reads the unit's parcel; then nothing
//   is left to change. An editor sees the proposal with no button. The panel
//   passes axe.
// - A unit's form takes its MAP and asks for its source before Save.
// - Settings → Flow generation → Rain for each unit switches it on with the
//   gauge's MAP and its source, and keeps it after a reload; its link opens
//   the Data feeds panel (?rain=units). A viewer reads it, read-only.
// - Runs & results shows a run's Rain for each unit (a planted
//   summary.unitRain), the unit that fell back first, and passes axe at 390.
// No fetch runs here: the feed's fetch is the DB tests' (FEED_SOURCE=fixtures).
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { plantUnitRainSummary } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';
import { openSettings, saveChanges, saveSettings } from '../support/settings.ts';

/** The sample model, with a parcel on the map linked to Upper farm; Lower farm has none. */
async function seed(request: APIRequestContext, name: string) {
	const project = await seedRunnableProject(request, name);
	const [, upper] = project.model.nodes as { id: string; name: string }[];
	const res = await request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'farm_parcel', name: 'Upper parcel', nodeId: upper!.id, geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.03)] } }
	});
	expect(res.status(), await res.text()).toBe(201);
	return project.id;
}

const unitRain = (page: Page) => page.getByTestId('unit-rain');

async function openUnitRain(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=settings`);
	const feeds = page.getByRole('region', { name: 'Data feeds' });
	await feeds.getByRole('button', { name: 'Rain for each unit' }).click();
	await expect(unitRain(page).getByRole('heading', { name: 'Rain for each unit' })).toBeFocused();
	return feeds;
}

test('the owner sets up a CHIRPS feed for each unit with a parcel, and the feed reads the unit’s parcel', async ({ page, owner }) => {
	void owner;
	const id = await seed(page.request, 'Unit rain');
	const feeds = await openUnitRain(page, id);
	const panel = unitRain(page);

	const rows = panel.getByTestId('unit-rain-row');
	await expect(rows).toHaveCount(1);
	await expect(rows.first().getByRole('rowheader')).toHaveText('Upper farm');
	await expect(rows.first()).toContainText(/\d+ cells?, \d+ % of their area inside/);
	await expect(rows.first()).toContainText('No feed yet');
	await expect(panel.getByTestId('unit-rain-without')).toContainText('Without a parcel on the map (1 unit): Lower farm.');
	await expect(panel.getByRole('link', { name: 'Open the map' })).toHaveAttribute('href', '?tab=map');
	await panel.getByText('The cells', { exact: true }).click();
	await expect(panel.getByRole('table', { name: 'Each unit’s CHIRPS cells', exact: true }).locator('tbody tr').first()).toHaveText(/Upper farm\s*-33\.\d{3}\s*21\.\d{3}\s*[\d.]+ %\s*[\d.]+/);

	// rnl, from 1981, unless the owner picks the other; a start date before it is caught before anything is sent.
	await expect(panel.getByLabel('Daily product')).toHaveValue('rnl');
	await expect(panel.getByTestId('unit-rain-words')).toHaveText('Creates 1 CHIRPS feed, one into each unit’s own rain series.');
	await panel.getByLabel(/^Start date/).fill('1975-01-01');
	await panel.getByTestId('unit-rain-apply').click();
	await expect(panel.getByRole('alert')).toHaveText('CHIRPS begins on 1981-01-01.');
	await expect(panel.getByLabel(/^Start date/)).toBeFocused();
	await expect(panel.getByLabel(/^Start date/)).toHaveAttribute('aria-invalid', 'true');
	await panel.getByLabel(/^Start date/).fill('');
	await expectNoViolations(page, { include: '[data-testid="unit-rain"]' });

	await expect(panel.getByTestId('unit-rain-apply')).toHaveText('Create the feed');
	await panel.getByTestId('unit-rain-apply').click();
	await expect(panel.getByTestId('unit-rain-done')).toHaveText(/^Created 1 feed\. They run on the next schedule/);
	// The unit's row now shows its feed, and nothing is left to change.
	await expect(rows.first()).toContainText('Waiting');
	await expect(panel.getByTestId('unit-rain-apply')).toHaveCount(0);
	await expect(panel.getByTestId('unit-rain-words')).toHaveText('Every unit’s feed already reads its parcel with this product: nothing to change.');
	// The feed's card in the list says where it reads.
	const card = feeds.getByRole('list', { name: 'Data feeds' }).getByRole('listitem').filter({ hasText: 'of a unit’s parcel' });
	await expect(card).toHaveCount(1);
	await expect(card).toContainText(/\d+ cells? of a unit’s parcel \([\d.]+ km²\), area weighted · CHIRPS rnl v3\.0/);

	// Close gives the focus back to the button that opened it.
	await panel.getByRole('button', { name: 'Close' }).click();
	await expect(feeds.getByRole('button', { name: 'Rain for each unit' })).toBeFocused();
});

test('an editor sees the proposal but an owner creates the feeds', async ({ page, owner, signIn }) => {
	void owner;
	const id = await seed(page.request, 'Unit rain editor');
	const editor = await signIn('Unit rain editor');
	await addMember(page.request, id, editor.user.email, 'editor');
	await openUnitRain(editor.page, id);
	const panel = unitRain(editor.page);
	await expect(panel.getByTestId('unit-rain-row')).toHaveCount(1);
	await expect(panel.getByText('An owner of the project creates the feeds.')).toBeVisible();
	await expect(panel.getByTestId('unit-rain-apply')).toHaveCount(0);
	await expect(panel.getByLabel('Daily product')).toHaveCount(0);
});

test('a unit’s MAP takes its source before Save, and is kept', async ({ page, owner }) => {
	void owner;
	const id = await seed(page.request, 'Unit MAP');
	await page.goto(`/projects/${id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const field = page.getByTestId('unit-map');
	const map = field.getByLabel('MAP (mm)');
	await expect(map).toHaveValue('');
	await expect(page.getByLabel('Source of the MAP')).toHaveCount(0);
	await map.fill('820');
	await map.blur();
	const source = page.getByLabel('Source of the MAP');
	await expect(source).toHaveAttribute('aria-invalid', 'true');
	await expect(source).toHaveAccessibleDescription(/Say where its MAP comes from: the source is required \(the dataset or study, and its years\)\./);
	await source.fill('a synthetic MAP grid, 1991–2020');
	await expect(source).not.toHaveAttribute('aria-invalid', 'true');
	await expectNoViolations(page, { include: '[data-testid="unit-map"]' });
	expect((await saveModelChanges(page)).status()).toBe(200);
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	await expect(page.getByTestId('unit-map').getByLabel('MAP (mm)')).toHaveValue('820');
	await expect(page.getByLabel('Source of the MAP')).toHaveValue('a synthetic MAP grid, 1991–2020');
	// Clearing the MAP takes its source with it.
	await page.getByTestId('unit-map').getByLabel('MAP (mm)').fill('');
	await page.getByTestId('unit-map').getByLabel('MAP (mm)').blur();
	await expect(page.getByLabel('Source of the MAP')).toHaveCount(0);
	// A gauge has no land, so no MAP.
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '1. Outflow gauge · gauge' });
	await expect(page.getByTestId('unit-map')).toHaveCount(0);
});

test('Settings switches rain for each unit on, with the gauge’s MAP and its source, and keeps it', async ({ page, owner }) => {
	void owner;
	const id = await seed(page.request, 'Unit rain settings');
	await openSettings(page, id);
	const group = page.getByTestId('unit-rain-settings');
	const sw = group.getByRole('checkbox', { name: 'Runoff from each unit’s own rain' });
	await expect(sw).not.toBeChecked();
	await sw.check();
	await expect(group.getByTestId('unit-rain-coverage')).toContainText('0 of 2 units with land have a MAP.');
	await expect(group.getByLabel('First year')).toHaveValue('1991');
	await expect(group.getByLabel('Last year')).toHaveValue('2020');
	const gauge = group.getByLabel(/^Rain gauge’s MAP/);
	await gauge.fill('640');
	await gauge.blur();
	// A gauge MAP needs its source: Save is blocked, the message under the source.
	await expect(group.getByTestId('unit-rain-error')).toHaveText('Say where the rain gauge’s MAP comes from: the source is required (the record or study, and its years).');
	await expect(group.getByLabel('Source of the gauge’s MAP')).toHaveAttribute('aria-invalid', 'true');
	await expect(saveChanges(page)).toBeDisabled();
	await group.getByLabel('Source of the gauge’s MAP').fill('the gauge’s synthetic record, 1991–2020');
	await expect(group.getByTestId('unit-rain-error')).toHaveCount(0);
	await expect(saveChanges(page)).toBeEnabled();
	// Switched off and on again before saving, it comes back as it was.
	await sw.uncheck();
	await expect(group.getByLabel(/^Rain gauge’s MAP/)).toHaveCount(0);
	await sw.check();
	await expect(group.getByLabel(/^Rain gauge’s MAP/)).toHaveValue('640');
	await expect(group.getByLabel('Source of the gauge’s MAP')).toHaveValue('the gauge’s synthetic record, 1991–2020');
	// A short period notes, but saves.
	await group.getByLabel('First year').fill('2018');
	await group.getByLabel('First year').blur();
	await expect(group.getByTestId('unit-rain-period-note')).toContainText('3 years: the MAP factor wants at least 5 complete years');
	await expectNoViolations(page, { include: '[data-testid="unit-rain-settings"]' });
	await saveSettings(page);
	await expect(page.getByTestId('summary-flow')).toContainText('rain for each unit');

	await page.reload();
	await expect(group.getByRole('checkbox', { name: 'Runoff from each unit’s own rain' })).toBeChecked();
	await expect(group.getByLabel(/^Rain gauge’s MAP/)).toHaveValue('640');
	await expect(group.getByLabel('Source of the gauge’s MAP')).toHaveValue('the gauge’s synthetic record, 1991–2020');
	await expect(group.getByLabel('First year')).toHaveValue('2018');
	await expect(group.getByLabel('Last year')).toHaveValue('2020');
});

test('Settings’ link opens the Data feeds panel, and a viewer reads the group without changing it', async ({ page, owner, signIn }) => {
	void owner;
	const id = await seed(page.request, 'Unit rain link');
	await openSettings(page, id);
	const group = page.getByTestId('unit-rain-settings');
	await group.getByRole('checkbox', { name: 'Runoff from each unit’s own rain' }).check();
	await expect(group.getByTestId('unit-rain-without-map')).toContainText('Without a MAP: Upper farm, Lower farm.');
	await expect(group.getByRole('link', { name: 'Upper farm' })).toHaveAttribute('href', /^\?tab=network&edit=/);
	await saveSettings(page);
	await group.getByRole('link', { name: 'Data feeds → Rain for each unit' }).click();
	await expect(page).toHaveURL(/[?&]rain=units/);
	await expect(unitRain(page).getByTestId('unit-rain-row')).toHaveCount(1);

	const viewer = await signIn('Unit rain viewer');
	await addMember(page.request, id, viewer.user.email, 'viewer');
	await openSettings(viewer.page, id);
	const seen = viewer.page.getByTestId('unit-rain-settings');
	await expect(seen.getByRole('checkbox', { name: 'Runoff from each unit’s own rain' })).toBeChecked();
	await expect(seen.getByRole('checkbox', { name: 'Runoff from each unit’s own rain' })).toBeDisabled();
	// Data feeds' panel is for editors: a viewer has no button.
	await expect(viewer.page.getByRole('region', { name: 'Data feeds' }).getByRole('button', { name: 'Rain for each unit' })).toHaveCount(0);
});

test('a run with rain for each unit lists each unit’s rule and factor, the fallback first, and passes axe on a phone', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Unit rain run');
	const [, upper, lower] = project.model.nodes as { id: string; name: string }[];
	const runId = await createRun(page.request, project.id, 'Per unit');
	const days = { unitGauge: 0, gaugeMap: 0, unitChirps: 0, catchment: 0, forecast: 0, none: 0 };
	await plantUnitRainSummary(runId, {
		mode: 'perUnit',
		gaugeMapMm: 640,
		gaugeMapSource: 'a synthetic gauge record',
		mapPeriod: { start: '1991-01-01', end: '2020-12-31' },
		units: [
			{ nodeId: upper!.id, name: 'Upper farm', areaKm2: 12, mapMm: 800, mapSource: 'a synthetic MAP grid', rule: 'gaugeMap', rainKey: 'rain_catchment_mm', factor: 1.25, factorSource: 'gaugeMap', gaugeMapFactor: 1.25, gaugeMapOwnFactor: 1.25, gaugeMapClamped: false, chirps: null, days: { ...days, gaugeMap: 3000 }, rainMm: 9000, petMm: 12000, aetMm: 7000, flowMm: 1500, exchangeMm: 0, storageStartMm: 0, storageEndMm: 0, runoffM3: 18_000_000, runoffCoefficient: 0.167 },
			{ nodeId: lower!.id, name: 'Lower farm', areaKm2: 8, mapMm: null, mapSource: null, rule: 'catchment', rainKey: null, factor: null, factorSource: 'catchment', gaugeMapFactor: null, gaugeMapOwnFactor: null, gaugeMapClamped: false, chirps: null, days: { ...days, catchment: 3000 }, rainMm: 7000, petMm: 12000, aetMm: 6000, flowMm: 900, exchangeMm: 0, storageStartMm: 0, storageEndMm: 0, runoffM3: 7_200_000, runoffCoefficient: 0.129 }
		]
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	const panel = page.getByTestId('run-unit-rain');
	await expect(panel.getByRole('heading', { name: 'Rain for each unit' })).toBeVisible();
	await expect(panel).toContainText('MAP period 1991–2020; rain gauge’s MAP 640 mm (a synthetic gauge record).');
	await expect(panel.getByTestId('run-unit-rain-notes')).toContainText('Lower farm has no rain of its own');
	const rows = panel.getByTestId('run-unit-rain-row');
	await expect(rows).toHaveCount(2);
	await expect(rows.first()).toHaveAttribute('data-rule', 'catchment');
	await expect(rows.nth(1)).toContainText('Catchment gauge × MAP ratio');
	await expect(rows.nth(1)).toContainText('× 1.25, unit MAP ÷ gauge MAP');
	await expect(page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Unit rain' })).toHaveAttribute('href', '#res-unit-rain');
	await expectNoViolations(page, { include: '[data-testid="run-unit-rain"]' });
});
