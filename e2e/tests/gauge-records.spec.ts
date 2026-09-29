// An observed record at a gauge inside the network (084_gauge_records, engine
// 1.4.0, issue #64; docs/ui.md § Data, § Runs & results, run-comparison.md §
// Plausibility checks). On the Data page a flow record is moved from the
// outlet to a gauge; a run then checks it there (the Plausibility checks
// panel's gauge table), and comparing a run whose gauge record is 3× too big
// with one where it is not shows the checks side by side. Names and numbers
// are invented.
import { API_URL } from '../support/env.ts';
import { createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const DAYS = 1096; // three water years from 2019-10-01

test('a flow record attached to a gauge is checked there, and the comparison shows its checks side by side', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Gauge records');
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const upper = node('Upper farm', 'farm', weir.id, 3, { damCapacityM3: 150_000 });
	const lower = node('Lower farm', 'farm', outlet.id, 4, { areaKm2: 8 });
	const model: Model = { nodes: [outlet, weir, upper, lower], crops: [], cropAreas: [], transfers: [] };
	await putModel(page.request, project.id, model);
	await updateSettings(page.request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(DAYS) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(DAYS) });
	// The weir's record: its name sorts first, so until it has a site it would be the outlet's.
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'A weir record', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(DAYS) });

	// Data: the record starts at the outlet; move it to the weir.
	await page.goto(`/projects/${project.id}?tab=series`);
	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'A weir record' });
	const site = row.getByLabel('Where A weir record was measured');
	await expect(site).toHaveValue('');
	const moved = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/series\/[^/]+$/.test(r.url()));
	await site.selectOption({ label: 'At gauge Middle weir' });
	expect((await moved).status()).toBe(200);
	await expect(row).toContainText('Gauge record (checks only)');
	// The outlet's own record is now the one calibration reads.
	const outletRow = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasNotText: 'A weir record' }).filter({ hasText: 'Flow — observed gauge' });
	await expect(outletRow).toContainText('Calibration target');
	await expectNoViolations(page);
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { name: string; siteNodeId: string | null }[];
	expect(stored.find((s) => s.name === 'A weir record')!.siteNodeId).toBe(weir.id);

	// A record that agrees with the model at the weir: its simulated flow there. Run A: 3× too big,
	// which fails both checks at the weir. Run B: the agreeing record. A replace keeps the site.
	const probe = await createRun(page.request, project.id, 'Probe');
	const at = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs/${probe}/series?key=outflow&nodeId=${weir.id}`)).json()) as { startDate: string; values: number[] };
	const weirFlow = at.values.map((v) => v / 86_400);
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'A weir record', unit: 'm³/s', startDate: at.startDate, values: weirFlow.map((v) => v * 3) });
	const runA = await createRun(page.request, project.id, 'Weir record too big');
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'A weir record', unit: 'm³/s', startDate: at.startDate, values: weirFlow });
	const runB = await createRun(page.request, project.id, 'Weir record fixed');
	expect((await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series.find((x: { name: string }) => x.name === 'A weir record').siteNodeId).toBe(weir.id);

	await page.goto(`/projects/${project.id}?tab=runs&run=${runA}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Weir record too big' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Plausibility', exact: true }).click();
	const panel = page.getByRole('region', { name: /^Plausibility checks/ });
	await expect(panel.getByRole('list', { name: 'Check results' }).getByRole('listitem').filter({ hasText: 'At gauges in the network' })).toHaveText(
		'At gauges in the network: see below'
	);
	const gauges = panel.getByRole('table', { name: 'At gauges in the network' });
	await expect(gauges.getByRole('row', { name: /^Middle weir Gauge .* fails 2019\/20, 2020\/21, 2021\/22 \(3 of 3\)/ })).toBeVisible();
	await expectNoViolations(page);

	await page.goto(`/compare?a=${project.id}:${runA}&b=${project.id}:${runB}`);
	const cmp = page.getByRole('region', { name: 'Plausibility checks' });
	const table = cmp.getByTestId('plausibility-compare');
	const weirNat = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Middle weir' }) }).filter({ hasText: 'Natural ≥ observed + abstraction' });
	await expect(weirNat.getByRole('cell').nth(1)).toHaveText('fails 2019/20, 2020/21, 2021/22: 3 of 3 (gauge)');
	await expect(weirNat.getByRole('cell').nth(3)).toHaveText('now passes 2019/20, 2020/21, 2021/22');
	const weirQ90 = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Middle weir' }) }).filter({ hasText: 'Dry-season Q90' });
	await expect(weirQ90.getByRole('cell').nth(1)).toHaveText(/outside the factor of 2\)$/);
	await expect(table.getByRole('rowheader', { name: 'Outlet' }).first()).toBeVisible();
	await expectNoViolations(page);
});
