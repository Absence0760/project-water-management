// EWR → On the map (docs/ui.md § EWR, docs/model.md §2.11c): folded until Show the map (`ewrMap=1`), then each
// hydrological unit's area on the Map tab shaded by how the flow passing it compares with the EWR required at it over
// the run (RunSummary.unitEwr), each unit carrying its % as a button, a key naming every band in words with how many
// units are in it, every unit's figures in a table and the units with no area listed. Shade by picks the measure
// (`ewrMapMeasure=ratio`): Requirement met (Σ MIN(U, Z) ÷ Σ Z) or Flow ÷ requirement (Σ U ÷ Σ Z). A unit with no EWR
// share reads "No EWR share". The expected bands are worked here from the run's own figures with the client's edges, so
// the spec holds whatever the engine's numbers are. Synthetic data only.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { openRiver } from '../support/river.ts';

const card = (page: Page) => page.getByTestId('ewr-unit-map');

/** The units: one with no catchment area (so no EWR share at or above it), one with no area on the map. */
const UNITS = [
	{ name: 'Kloof top', areaKm2: 14, damCapacityM3: 400_000, mapped: true },
	{ name: 'Middle vlei', areaKm2: 9, damCapacityM3: 60_000, mapped: true },
	{ name: 'Dry ridge', areaKm2: 6, damCapacityM3: 250_000, mapped: true },
	{ name: 'Rock face', areaKm2: 0, damCapacityM3: 0, mapped: true },
	{ name: 'Mapless hoek', areaKm2: 5, damCapacityM3: 30_000, mapped: false }
] as const;

type UnitEwr = { nodeId: string; name: string; requiredM3: number; metM3: number; outflowM3: number };

async function seed(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	const gauge = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const farms = UNITS.map((u, i) => node(u.name, 'farm', gauge.id, i + 2, { areaKm2: u.areaKm2, damCapacityM3: u.damCapacityM3, pctUpstreamToDam: 1 }));
	const crop = { id: crypto.randomUUID(), name: 'Orchard', cropFactor: [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6] };
	await putModel(request, project.id, {
		nodes: [gauge, ...farms],
		crops: [crop],
		cropAreas: farms.map((f, i) => ({ nodeId: f.id, cropId: crop.id, areaM2: 60_000 * (i + 1) })),
		transfers: []
	});
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const days = 3 * 365 + 1;
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	const runId = await createRun(request, project.id, 'Baseline');
	const poly = (nm: string, ring: [number, number][]) => ({ type: 'Feature', properties: { name: nm }, geometry: { type: 'Polygon', coordinates: [ring] } });
	const imp = await request.post(`${API_URL}/projects/${project.id}/map/import`, {
		data: {
			fileName: 'ewr-units.geojson',
			kind: 'farm_parcel',
			text: JSON.stringify({ type: 'FeatureCollection', features: UNITS.filter((u) => u.mapped).map((u, i) => poly(u.name, box(21.02 + i * 0.05, -33.98, 0.04))) })
		}
	});
	expect(imp.status(), await imp.text()).toBe(201);
	const res = await request.get(`${API_URL}/projects/${project.id}/runs/${runId}`);
	const units = ((await res.json()) as { run: { summary: { unitEwr: UnitEwr[] } } }).run.summary.unitEwr;
	expect(units.map((u) => u.name)).toEqual(UNITS.map((u) => u.name));
	return { id: project.id, runId, units };
}

/** The client's bands, worked from the figures (each band holds its lower edge; the label is the whole % rounded down). */
function expected(u: UnitEwr, measure: 'met' | 'ratio') {
	if (!(u.requiredM3 > 1e-6)) return { band: 'none', label: 'No EWR share' };
	const r = measure === 'met' ? Math.min(1, u.metM3 / u.requiredM3) : u.outflowM3 / u.requiredM3;
	const band = r >= 1 - 1e-9 ? 'met' : r >= 0.9 - 1e-9 ? 'within' : r >= 0.5 - 1e-9 ? 'short' : 'half';
	return { band, label: `${new Intl.NumberFormat('en-US').format(Math.floor(r * 100 + 1e-7)).replace(/,/g, ' ')} %` };
}

const n = (k: number) => (k ? `${k} unit${k === 1 ? '' : 's'}` : 'none');

test('the EWR map shades each unit by its share of the EWR required at it, labels its %, keys every band with its count, and switches the measure', async ({ page, owner }) => {
	test.setTimeout(120_000);
	void owner;
	const project = await seed(page.request, 'EWR map');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openRiver(page, project.id);

	// Folded until asked for: no map, nothing fetched; the card says what it shows and that it is modelled.
	await expect(card(page).getByRole('heading', { level: 2, name: 'On the map' })).toBeVisible();
	await expect(card(page)).toContainText('its own share of the EWR plus the shares of the units above it');
	await expect(card(page)).toContainText('Modelled, not measured.');
	await expect(card(page)).toContainText('“No EWR share”');
	await expect(page.getByTestId('allocation-map')).toHaveCount(0);
	await expect(page.getByRole('navigation', { name: 'EWR sections' }).getByRole('link', { name: 'On the map' }).first()).toHaveAttribute('href', /#res-ewr-map$/);
	const show = card(page).getByRole('link', { name: 'Show the map' });
	await expect(show).toHaveAttribute('aria-expanded', 'false');
	await show.click();
	await expect(page).toHaveURL(/[?&]ewrMap=1(&|$)/);
	await expect(card(page).getByRole('button', { name: 'Hide the map' })).toHaveAttribute('aria-expanded', 'true');
	// A link, so Back folds it and Forward opens it again.
	await page.goBack();
	await expect(page.getByTestId('ewr-map-legend')).toHaveCount(0);
	await page.goForward();
	await expect(page).toHaveURL(/[?&]ewrMap=1(&|$)/);

	const key = card(page).getByTestId('ewr-map-legend');
	const figures = card(page).getByTestId('ewr-map-figures');
	const map = page.getByTestId('allocation-map');
	const shadeBy = (name: string) => card(page).getByRole('radio', { name });
	const rock = project.units.find((u) => u.name === 'Rock face')!;
	expect(rock.requiredM3, 'a unit with no catchment area and nothing above it has no EWR share').toBe(0);

	for (const measure of ['met', 'ratio'] as const) {
		if (measure === 'ratio') {
			await shadeBy('Flow ÷ requirement').check();
			await expect(page).toHaveURL(/[?&]ewrMapMeasure=ratio(&|$)/);
		}
		await expect(shadeBy(measure === 'met' ? 'Requirement met' : 'Flow ÷ requirement')).toBeChecked();
		await expect(key.getByRole('heading')).toHaveText(measure === 'met' ? 'Key: EWR met ÷ EWR required at the unit, over the run' : 'Key: flow passing the unit ÷ EWR required at it, over the run');
		await expect(figures).toHaveAttribute('data-measure', measure);

		// The key: every band in words with how many units on the map are in it, and the units with no area; they add up to every unit.
		const counts: Record<string, number> = { met: 0, within: 0, short: 0, half: 0, none: 0, unplaced: 0 };
		for (const [i, u] of project.units.entries()) counts[UNITS[i]!.mapped ? expected(u, measure).band : 'unplaced']!++;
		for (const [band, words] of [
			['met', 'Met or exceeded (100 % or more)'],
			['within', 'Within 10 % (90–100 %)'],
			['short', '10–50 % short (50–90 %)'],
			['half', 'Half or more short (under 50 %)'],
			['none', 'No EWR share (outline only)'],
			['unplaced', 'No area on the map (listed below)']
		] as const) {
			const row = key.locator(`li[data-band="${band}"]`);
			await expect(row).toContainText(words);
			await expect(row).toContainText(n(counts[band]!));
		}

		// Every unit's figures, with its % and band.
		await expect(figures.locator('tbody tr')).toHaveCount(UNITS.length);
		for (const u of project.units) {
			const e = expected(u, measure);
			const row = figures.locator(`tbody tr[data-node="${u.nodeId}"]`);
			await expect(row, u.name).toHaveAttribute('data-band', e.band);
			await expect(row.getByRole('cell').nth(2), u.name).toHaveText(e.label);
		}
		await expect(figures.locator(`tbody tr[data-node="${rock.nodeId}"]`).getByRole('cell')).toHaveText([/^0 m³$/, '–', 'No EWR share', /No EWR share/]);

		// The unit with no area is listed under the map with its % and band.
		const mapless = project.units.find((u) => u.name === 'Mapless hoek')!;
		const listed = card(page).getByTestId('ewr-map-unplaced').getByRole('listitem');
		await expect(listed).toHaveCount(1);
		await expect(listed.first()).toContainText('Mapless hoek');
		await expect(listed.first()).toContainText(expected(mapless, measure).label);
		await expect(listed.first()).toHaveAttribute('data-band', expected(mapless, measure).band);

		// The map: each unit with an area carries its % as a button named with its figures, where the browser can draw it.
		await expect(map).toHaveAttribute('data-status', /^(ready|failed)$/);
		if ((await map.getAttribute('data-status')) === 'ready') {
			const label = (name: string) => map.getByRole('button', { name: new RegExp(`^${name}: `) });
			for (const [i, u] of project.units.entries()) {
				if (!UNITS[i]!.mapped) continue;
				const e = expected(u, measure);
				await expect(label(u.name), u.name).toHaveText(e.label);
				await expect(label(u.name), u.name).toHaveAttribute('data-band', e.band);
			}
			await expect(label('Rock face')).toHaveAccessibleName('Rock face: No EWR share, no EWR is required at this unit.');
			await expect(label('Kloof top')).toHaveAccessibleName(
				measure === 'met' ? /^Kloof top: \d[\d ]* % of the EWR required met, .* m³ of .* m³ over the run\. .+\.$/ : /^Kloof top: \d[\d ]* %, flow of .* m³ against .* m³ of EWR required over the run\. .+\.$/
			);
		} else {
			await expect(page.getByTestId('allocation-map-unavailable')).toBeVisible();
		}
		await expectNoViolations(page);
	}

	// The measure is in the URL: a reload keeps it, and Back returns to the one before (the default leaves the URL).
	await page.reload();
	await expect(shadeBy('Flow ÷ requirement')).toBeChecked();
	await page.goBack();
	await expect(shadeBy('Requirement met')).toBeChecked();
	await expect(page).not.toHaveURL(/[?&]ewrMapMeasure=/);

	// A unit's name opens it on Hydrological units for this run.
	await figures.getByRole('link', { name: 'Middle vlei' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]tab=supply&run=${project.runId}&unit=${project.units.find((u) => u.name === 'Middle vlei')!.nodeId}#res-farm$`));
	await page.goBack();

	// Hide the map folds it in place, and its measure goes with it.
	await shadeBy('Flow ÷ requirement').check();
	await card(page).getByRole('button', { name: 'Hide the map' }).click();
	await expect(page).not.toHaveURL(/[?&]ewrMap/);
	await expect(page.getByTestId('ewr-map-legend')).toHaveCount(0);

	// On a phone it fits the width.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=river&ewrMap=1`);
	await expect(card(page).getByTestId('ewr-map-legend')).toBeVisible();
	await expectNoSidewaysScroll(page);
});
