// Hydrologist plausibility checks (engine 0.25.0, docs/model.md §2.10d): a run
// on a synthetic catchment shows the six checks (five before engine 1.55.0, four before 1.19.0) in their own Runs & results
// panel, with the latest run of another runoff model overlaid on the
// dry-season low-flow curves: an old legacy run (engine < 1.0.0, planted, as the
// API can't make one any more). Names and numbers are invented.
import { createProject, createRun, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { plantLegacyRun } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';

test('a run shows the plausibility checks, with the other runoff model overlaid on the low-flow curves', async ({ page, owner }) => {
	void owner;
	// Three water years (Oct 2019 – Sep 2022): station rain for the first two, blank in the third, CHIRPS throughout.
	const project = await createProject(page.request, 'Plausibility checks');
	await putModel(page.request, project.id, sampleModel());
	await updateSettings(page.request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const days = 1096;
	const rain = syntheticRain(days);
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: rain.map((v, i) => (i < 731 ? v : null)) });
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2019-10-01', values: rain });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	const gr4j = await createRun(page.request, project.id, 'GR4J run');
	await plantLegacyRun(await createRun(page.request, project.id, 'Legacy run'));

	await page.goto(`/projects/${project.id}?tab=runs&run=${gr4j}`);
	await expect(page.getByRole('heading', { level: 2, name: 'GR4J run' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Plausibility', exact: true }).click();
	const panel = page.getByRole('region', { name: /^Plausibility checks/ });
	await expect(panel.getByText(/^Six checks a reviewing hydrologist makes by hand\..*Dry season: .*, the six months with the lowest mean flow in the gauge record\.$/)).toBeVisible();
	const results = panel.getByRole('list', { name: 'Check results' });
	// Six on a run from engine 1.55.0: the recession diagnostics (CR-13) are the fifth, the validation signatures (CR-16) the sixth.
	await expect(results.getByRole('listitem')).toHaveCount(6);
	await expect(results.getByRole('listitem').filter({ hasText: /^Recessions: / })).toHaveCount(1);
	await expect(results.getByRole('listitem').filter({ hasText: /^Validation signatures: / })).toHaveCount(1);
	// Three years is too few for the double-mass check.
	await expect(results.getByRole('listitem').filter({ hasText: 'Observed flow vs rain' })).toHaveText('Observed flow vs rain: not checked');

	// 1. One row per water year of the gauge record, each judged.
	const nat = panel.getByRole('table', { name: /^Natural flow ≥ observed \+ net abstraction/ });
	await expect(nat.getByRole('row')).toHaveCount(4);
	await expect(nat.getByRole('row', { name: /^2019\/20 366 / })).toBeVisible();
	await expect(nat.getByRole('row', { name: /^2021\/22 365 .* (passes|fails)$/ })).toBeVisible();

	// 2. The blank third year ran on CHIRPS: one fallback-rain year, two good-rain years.
	await expect(panel.getByText('of days EWR not met, 2 water years')).toBeVisible();
	await expect(panel.getByText('of days EWR not met, 1 water year', { exact: true })).toBeVisible();
	await panel.getByText(/^Rain source by water year/).click();
	await expect(panel.getByRole('row', { name: /^2021\/22 0 of 365 .* fallback \d+$/ })).toBeVisible();
	await expect(panel.getByRole('row', { name: /^2019\/20 366 of 366 .* good \d+$/ })).toBeVisible();

	// 3. Not enough years for the flow double-mass curve.
	await expect(panel.getByText(/^Not checked: needs an observed flow record, rain and a catchment area/)).toBeVisible();

	// 4. The curves: the gauge, this run's model and the legacy run's, in the chart legend and the Q table.
	await expect(panel.getByText('Simulated outflow (Legacy (workbook), Legacy run) (m³/s)')).toBeVisible();
	await expect(panel.getByText('Simulated outflow (GR4J, this run) (m³/s)')).toBeVisible();
	const q = panel.getByRole('table', { name: /^Dry-season Q70, Q90 and Q95/ });
	await expect(q.getByRole('row', { name: /^Gauge \(m³\/s\) / })).toBeVisible();
	await expect(q.getByRole('row', { name: /^Simulated outflow on the gauge's days \(m³\/s\) / })).toBeVisible();
	await expect(panel.getByRole('status').filter({ hasText: /^Q90 on the gauge's \d+ dry-season days: simulated/ })).toBeVisible();
	// Switching the model's curve to the gauge's days relabels it.
	await panel.getByLabel('Simulated outflow over').selectOption({ label: "the gauge's days only" });
	await expect(panel.getByText("Simulated outflow on the gauge's days (GR4J, this run) (m³/s)")).toBeVisible();

	// 5. Recession diagnostics (engine ≥ 1.19.0): the section is there, judged or not.
	await expect(panel.getByRole('heading', { level: 4, name: /^Recession diagnostics/ })).toBeVisible();

	// 6. Validation signatures (engine ≥ 1.55.0): three years of the outlet's gauge record against the model, one row per signature.
	await expect(panel.getByRole('heading', { level: 4, name: /^Validation signatures/ })).toBeVisible();
	// A regex getByText sees the text as written, source line breaks included: \s+ between words that wrap there.
	await expect(panel.getByText(/^On the gauge record at the outlet \(the record the calibration statistics score\), 1\u202f096 days, against the simulated\s+outflow/)).toBeVisible();
	await expect(panel.getByText(/The limits are provisional, for the hydrologist to confirm\./)).toBeVisible();
	// The verdict line (the synthetic record is deterministic: its low flows fall away faster than the model's
	// store drains, so the low-flow FDC is outside its limit), which the check list and the run's warnings agree with.
	await expect(panel.getByRole('status').filter({ hasText: 'A signature is outside its limit: see the run’s warnings.' })).toHaveCount(1);
	await expect(results.getByRole('listitem').filter({ hasText: /^Validation signatures: / })).toHaveText('Validation signatures: see below');
	await expect(page.getByRole('listitem').filter({ hasText: /^Validation signatures \(.*\): on the 1096 scored days of the observed gauge record, / })).toHaveCount(1);
	const sig = panel.getByRole('table', { name: /^Validation signatures/ });
	await expect(sig.getByRole('columnheader', { name: 'Provisional limit' })).toBeVisible();
	await expect(sig.getByRole('row')).toHaveCount(6);
	await expect(sig.getByRole('row', { name: /^Base-flow index, Hughes et al\. \(2003\) \d\.\d\d \d\.\d\d [+−]\d\.\d\d ±0\.15 (within|outside)$/ })).toBeVisible();
	await expect(sig.getByRole('row', { name: /^Base-flow index, Eckhardt \(2005\) \d\.\d\d \d\.\d\d / })).toBeVisible();
	await expect(sig.getByRole('row', { name: /^Low-flow FDC slope, Q70–Q95 [\d.]+ [\d.]+ [+−][\d\u202f]+ % ±50 % (within|outside)$/ })).toBeVisible();
	await expect(sig.getByRole('row', { name: /^Skill on held-out recessions / })).toBeVisible();
	await expect(panel.getByText(/^Held-out recessions: /)).toBeVisible();
	await expectNoViolations(page);
});
