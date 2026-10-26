// Low-flow periods (issue #557, docs/model.md §2.10h, ui.md § Settings): a
// date range in which only a record's low flows are valid. Added under the
// calibration exclusions; inside it a reading above the threshold is left
// out, the run's quality strip shows those days, and comparing runs lists the
// period. A viewer reads the list without editing it, and a calibration
// scored at a gauge inside the network says the periods aren't used there.
// Synthetic records only.
import { API_URL } from '../support/env.ts';
import { addMember, createProject, createRun, node, putModel, putSeries, seedRunnableProject, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { whatChanged } from '../support/compare.ts';
import { expect, test } from '../support/fixtures.ts';
import { anySaveBar, saveChanges, saveSettings } from '../support/settings.ts';

test('a low-flow period needs a reason and a source, leaves its high readings out and shows them on the hydrograph', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Low flows only');
	const before = await createRun(page.request, project.id, 'Before');
	await page.goto(`/projects/${project.id}?tab=calibration`);

	const group = page.getByRole('group', { name: /^Low flows only/ });
	await expect(group.getByText('None: every reading in the calibration window is scored at any flow.')).toBeVisible();
	// Adding a row and removing it again leaves nothing to save.
	await group.getByRole('button', { name: 'Use only low flows in a date range' }).click();
	await group.getByRole('button', { name: 'Remove low-flow period 1' }).click();
	await expect(anySaveBar(page)).toHaveCount(0);
	await group.getByRole('button', { name: 'Use only low flows in a date range' }).click();
	// No reason yet: saving is blocked.
	await expect(group.getByRole('alert')).toHaveText('Low-flow period 1: needs a reason.');
	await expect(saveChanges(page)).toBeDisabled();
	await expect(group.getByLabel('Record')).toHaveValue('flow_observed_m3s');
	await group.getByLabel('From', { exact: true }).fill('2021-10-01');
	await group.getByLabel('From', { exact: true }).press('Tab');
	await group.getByLabel('To', { exact: true }).fill('2021-12-31');
	await group.getByLabel('To', { exact: true }).press('Tab');
	await group.getByLabel(/^Valid up to/).fill('0.3');
	await group.getByLabel(/^Valid up to/).press('Tab');
	await group.getByLabel('Reason').fill('Logger over-reads floods');
	await expect(group.getByRole('alert')).toHaveText('Low-flow period 1: needs a source.');
	await group.getByLabel('Source').fill('Client site visit');
	await expect(group.getByRole('alert')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="low-flow-periods"]' });
	await saveSettings(page);
	await page.reload();
	await expect(page.getByRole('group', { name: /^Low flows only/ }).getByLabel('Reason')).toHaveValue('Logger over-reads floods');
	await expect(page.getByTestId('summary-record')).toContainText('low flows only in 1 period');

	// The synthetic record peaks at 0.35 m³/s every 9th day: 11 of those peaks fall in Oct–Dec 2021.
	const after = await createRun(page.request, project.id, 'After');
	await page.goto(`/projects/${project.id}?tab=calibration&run=${after}`);
	const hydro = page.locator('#res-hydrograph figure').first();
	await expect(hydro).toHaveAttribute('data-ready', 'true');
	await expect(hydro).toHaveAttribute('data-lanes', '1');
	await expect(hydro.locator('.lane-key').getByRole('listitem')).toHaveText(['Above a low-flow period’s threshold: 11 days; left out of Fit automatically and the run’s statistics']);
	// Solid, as the gauged-range strips: the double line is for doubtful readings (calibration/flowFlagColours.test.ts).
	await expect(hydro.locator('.lane-key li[data-doubled]')).toHaveCount(0);

	await page.goto(`/compare?a=${project.id}:${before}&b=${project.id}:${after}`);
	await expect(whatChanged(page).getByText('Low flows only: added gauge record 2021-10-01 – 2021-12-31 at or below 0.3 m³/s')).toBeVisible();
});

const PERIOD = { kind: 'flow_observed_m3s', start: '2021-10-01', end: '2021-12-31', maxM3s: 0.3, reason: 'Logger over-reads floods', source: 'Client site visit' };

test('a viewer reads the low-flow periods but can’t add, change or remove one', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Low flows viewer');
	await updateSettings(page.request, project.id, { qualityFlags: { lowFlowPeriods: [PERIOD] } });
	const viewer = await signIn('Low flows viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=calibration`);

	const group = viewer.page.getByRole('group', { name: /^Low flows only/ });
	await expect(group.getByTestId('low-flow-period')).toHaveCount(1);
	await expect(group.getByLabel('Reason')).toHaveValue('Logger over-reads floods');
	await expect(group.getByLabel('Source')).toHaveValue('Client site visit');
	await expect(group.getByLabel(/^Valid up to/)).toHaveValue('0.3');
	// Read only: no add or remove, every field locked, and nothing to save.
	await expect(group.getByRole('button', { name: 'Use only low flows in a date range' })).toHaveCount(0);
	await expect(group.getByRole('button', { name: /^Remove low-flow period/ })).toHaveCount(0);
	await expect(group.getByLabel('Record')).toBeDisabled();
	for (const label of ['From', 'To', 'Reason', 'Source']) await expect(group.getByLabel(label, { exact: true }), label).not.toBeEditable();
	await expect(group.getByLabel(/^Valid up to/)).not.toBeEditable();
	// Not scored at an inner gauge: no note.
	await expect(group.getByTestId('low-flow-site-note')).toHaveCount(0);
	await expect(anySaveBar(viewer.page)).toHaveCount(0);
	await expectNoViolations(viewer.page, { include: '[data-testid="low-flow-periods"]' });
});

test('scored at a gauge inside the network, Calibration says the low-flow periods are not used there', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Low flows at a weir');
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const upper = node('Upper farm', 'farm', weir.id, 3, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const model: Model = { nodes: [outlet, weir, upper], crops: [], cropAreas: [], transfers: [] };
	await putModel(page.request, project.id, model);
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(120) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Weir record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120) });
	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	const rec = list.find((s) => s.name === 'Weir record')!;
	expect((await page.request.patch(`${API_URL}/projects/${project.id}/series/${rec.id}`, { data: { siteNodeId: weir.id } })).status()).toBe(200);
	await updateSettings(page.request, project.id, { calibrationSiteNodeId: weir.id, qualityFlags: { lowFlowPeriods: [PERIOD] } });

	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(page.getByLabel('Scored at')).toHaveValue(weir.id);
	const group = page.getByRole('group', { name: /^Low flows only/ });
	await expect(group.getByTestId('low-flow-period')).toHaveCount(1);
	await expect(group.getByTestId('low-flow-site-note')).toHaveText(
		'These periods apply to the outlet’s records. Calibration is scored at Middle weir, so they are not used until it is scored at the outlet again.'
	);

	// Back to the outlet (unsaved): the note goes, since the periods apply there.
	await page.getByLabel('Scored at').selectOption({ label: 'The outlet' });
	await expect(group.getByTestId('low-flow-site-note')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="low-flow-periods"]' });
});
