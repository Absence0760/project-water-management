// Calibrating at a gauge inside the network (engine 1.41.0; docs/ui.md §
// Settings, docs/model.md §2.10k). The outlet has no record; a record is
// attached to an inner gauge. Settings → Calibration record offers that gauge
// under "Scored at" (and no gauge without a record); a fit there scores the
// gauge's record, its fit record names the gauge, and the Data page says the
// record is the calibration site. Names and numbers are invented.
import { API_URL } from '../support/env.ts';
import { createProject, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const DAYS = 120;

test('a fit is scored at a gauge inside the network, and its record says where', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Calibration site');
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const bare = node('Bare gauge', 'gauge', outlet.id, 3, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const upper = node('Upper farm', 'farm', weir.id, 4, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const model: Model = { nodes: [outlet, weir, bare, upper], crops: [], cropAreas: [], transfers: [] };
	await putModel(page.request, project.id, model);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(DAYS) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Weir record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS) });
	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	const rec = list.find((s) => s.name === 'Weir record')!;
	expect((await page.request.patch(`${API_URL}/projects/${project.id}/series/${rec.id}`, { data: { siteNodeId: weir.id } })).status()).toBe(200);

	await page.goto(`/projects/${project.id}?tab=settings`);
	const scoredAt = page.getByLabel('Scored at');
	await expect(scoredAt).toHaveValue('');
	// The outlet and the gauge with a record; never the bare gauge.
	await expect(scoredAt.getByRole('option')).toHaveText(['The outlet', 'Middle weir']);
	await scoredAt.selectOption({ label: 'Middle weir' });
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings;
	expect(stored.calibrationSiteNodeId).toBe(weir.id);
	await expectNoViolations(page);

	// A short fit: the outlet has no record, so only the site makes it possible.
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByLabel('Starts').fill('1');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	await expect(fit.getByText('Scored at the gauge "Middle weir"', { exact: false })).toBeVisible();
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	const record = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(record.getByTestId('fit-record-to')).toContainText('at the gauge “Middle weir”');
	await expect(record.getByText(/calibration site has changed since the fit/)).toHaveCount(0);
	// Back to the outlet: the fit no longer describes where the form scores.
	await scoredAt.selectOption({ label: 'The outlet' });
	await expect(record.getByText('The calibration site has changed since the fit, so it was fitted to another gauge’s record.')).toBeVisible();
	await scoredAt.selectOption({ label: 'Middle weir' });

	// The Data page says the weir's record is the calibration site.
	await page.goto(`/projects/${project.id}?tab=series`);
	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Weir record' });
	await expect(row).toContainText('Gauge record (calibration site)');
});
