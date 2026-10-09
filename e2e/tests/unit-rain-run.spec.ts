// Rain for each hydrological unit, the whole path through the UI (issue #482;
// docs/ui.md § Data feeds, § Network, § Settings & calibration, § Runs &
// results; docs/model.md §2.4h). A synthetic catchment: an outflow gauge and
// three land units, each with a parcel inside the CHIRPS fixture's cover
// (21.0–25.4° E, 20.0–34.0° S), and a catchment gauge record with a 20-day
// gap. As the owner:
// - Settings → Data feeds → Rain for each unit creates the three unit feeds,
//   whose fetches run offline (a scoped worker tick, FEED_SOURCE=fixtures);
//   the panel then counts each unit's days.
// - Each unit's form takes its MAP and source; Settings switches rain for each
//   unit on with the gauge's MAP.
// - A run lists each unit on Catchment gauge × MAP ratio with the factor the
//   engine reports (unit MAP ÷ gauge MAP; the held one first, at 4), and the
//   gap's days from each unit's own CHIRPS.
// unit-rain.spec.ts covers the panels' details on a planted summary; this one
// is the run the engine makes from the fetched feeds.
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, node, putModel, putSeries, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { box } from '../support/map.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';
import { openSettings, saveSettings } from '../support/settings.ts';

const GAUGE_MAP = 640;
/** Unit MAPs: 800 ÷ 640 = 1.25, 480 ÷ 640 = 0.75, 3000 ÷ 640 ≈ 4.7, held at 4. Invented. */
const UNITS = [
	{ name: 'Unit North', mapMm: 800, lon: 21.24, lat: -33.765 },
	{ name: 'Unit Middle', mapMm: 480, lon: 21.34, lat: -33.665 },
	{ name: 'Unit South', mapMm: 3000, lon: 21.43, lat: -33.57 }
] as const;
const GAP_DAYS = 20;

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The catchment, its parcels and a gauge record of three years ending 10 days ago, with a gap inside the units' CHIRPS. */
async function seed(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	const gauge = node('Outflow gauge', 'gauge', null, 1, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const units = UNITS.map((u, i) => node(u.name, 'farm', gauge.id, i + 2, { areaKm2: 10 - 2 * i, pctRunoffToDam: 0 }));
	await putModel(request, project.id, { nodes: [gauge, ...units], crops: [], cropAreas: [], transfers: [] });
	await updateSettings(request, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	for (const [i, u] of UNITS.entries()) {
		const res = await request.post(`${API_URL}/projects/${project.id}/map/features`, {
			data: { kind: 'farm_parcel', name: `${u.name} parcel`, nodeId: units[i]!.id, geometry: { type: 'Polygon', coordinates: [box(u.lon, u.lat, 0.025)] } }
		});
		expect(res.status(), await res.text()).toBe(201);
	}
	const today = Date.parse(`${isoDay(Date.now())}T00:00:00Z`);
	const days = 3 * 365 - 9;
	const gapFrom = days - 60;
	const values = Array.from({ length: days }, (_, t) => (t >= gapFrom && t < gapFrom + GAP_DAYS ? null : t % 5 === 0 ? 12 + (t % 37) : t % 11 === 0 ? 3 : 0));
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: isoDay(today - 3 * 365 * DAY_MS), values });
	return { id: project.id, feedStart: isoDay(today - 110 * DAY_MS) };
}

/** Queue each unit feed's fetch and run the project's jobs until every feed has fetched (fixtures, no network). */
async function fetchFeeds(request: APIRequestContext, projectId: string) {
	const list = async () => ((await (await request.get(`${API_URL}/projects/${projectId}/feeds`)).json()) as { feeds: { id: string; lastDataDate: string | null; lastError: string | null }[] }).feeds;
	for (const f of await list()) expect((await request.post(`${API_URL}/projects/${projectId}/feeds/${f.id}/run-now`, { data: {} })).status()).toBe(202);
	// A fetch and its ingest are two jobs: a few scoped ticks run them, never another spec's (schedule off).
	for (let i = 0; i < 4 && (await list()).some((f) => !f.lastDataDate); i++) await runJobsTick({ projects: [projectId], schedule: false });
	const feeds = await list();
	expect(feeds).toHaveLength(UNITS.length);
	for (const f of feeds) expect(f).toMatchObject({ lastError: null, lastDataDate: expect.any(String) });
}

async function setUnitMap(page: Page, index: number) {
	const u = UNITS[index]!;
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: `${index + 2}. ${u.name} · hydrological unit` });
	const map = page.getByTestId('unit-map').getByLabel('MAP (mm)');
	await map.fill(String(u.mapMm));
	await map.blur();
	await page.getByLabel('Source of the MAP').fill('a synthetic MAP grid, 1991–2020');
}

test('unit feeds fetched offline, unit MAPs and a gauge MAP give a run on each unit’s own rain, with the factor the engine reports', async ({ page, owner }) => {
	void owner;
	const { id, feedStart } = await seed(page.request, 'Unit rain end to end');

	// Settings → Data feeds → Rain for each unit: the three parcels, one feed each.
	await page.goto(`/projects/${id}?tab=settings&rain=units`);
	const panel = page.getByTestId('unit-rain');
	const rows = panel.getByTestId('unit-rain-row');
	await expect(rows).toHaveCount(3);
	await expect(rows.getByRole('rowheader')).toHaveText(UNITS.map((u) => u.name));
	await panel.getByLabel(/^Start date/).fill(feedStart);
	await expect(panel.getByTestId('unit-rain-apply')).toHaveText('Create 3 feeds');
	await panel.getByTestId('unit-rain-apply').click();
	await expect(panel.getByTestId('unit-rain-done')).toHaveText(/^Created 3 feeds\./);

	await fetchFeeds(page.request, id);
	await page.reload();
	for (const u of UNITS) await expect(rows.filter({ hasText: u.name })).toContainText(/\d+ days so far\./);

	// Each unit's MAP, in its form; one save.
	await page.goto(`/projects/${id}?tab=network`);
	await openNodeForm(page);
	for (const i of UNITS.keys()) await setUnitMap(page, i);
	expect((await saveModelChanges(page)).status()).toBe(200);
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toHaveCount(0);

	// Settings: rain for each unit, with the gauge's MAP.
	await openSettings(page, id);
	const group = page.getByTestId('unit-rain-settings');
	await group.getByRole('checkbox', { name: 'Runoff from each unit’s own rain' }).check();
	await expect(group.getByTestId('unit-rain-coverage')).toContainText('3 of 3 units with land have a MAP.');
	await group.getByLabel(/^Rain gauge’s MAP/).fill(String(GAUGE_MAP));
	await group.getByLabel('Source of the gauge’s MAP').fill('the gauge’s synthetic record, 1991–2020');
	await saveSettings(page);

	// Run the model.
	await page.goto(`/projects/${id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Per unit');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Per unit' })).toBeVisible();

	const result = page.getByTestId('run-unit-rain');
	await expect(result).toContainText(`rain gauge’s MAP ${GAUGE_MAP} mm (the gauge’s synthetic record, 1991–2020).`);
	const units = result.getByTestId('run-unit-rain-row');
	// The held factor first; the others in the run's order (the engine's: by node id).
	await expect(units).toHaveCount(3);
	await expect(units.first().getByRole('rowheader')).toHaveText('Unit South');
	for (const [name, factor] of [
		['Unit South', /× 4, unit MAP ÷ gauge MAP held at the bound/],
		['Unit North', /× 1\.25, unit MAP ÷ gauge MAP/],
		['Unit Middle', /× 0\.75, unit MAP ÷ gauge MAP/]
	] as const) {
		const row = units.filter({ has: page.getByRole('rowheader', { name, exact: true }) });
		await expect(row).toHaveAttribute('data-rule', 'gaugeMap');
		await expect(row.getByRole('cell').first()).toHaveText(new RegExp(`^Catchment gauge × MAP ratio\\s*${factor.source}$`));
	}
	await expect(result.getByTestId('run-unit-rain-notes')).toContainText('Unit South: the factor was held at the 0.25–4 bound; check its MAP and the gauge’s.');
	// The gauge's gap came from each unit's own fetched CHIRPS.
	await result.getByText('Days by where the rain came from', { exact: true }).click();
	const days = result.getByRole('table', { name: 'Each unit’s run days by where the rain came from' });
	for (const u of UNITS) await expect(days.getByRole('row').filter({ has: page.getByRole('rowheader', { name: u.name }) }).getByRole('cell').nth(2)).toHaveText(String(GAP_DAYS));
});
