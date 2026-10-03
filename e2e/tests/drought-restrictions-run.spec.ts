// Drought restrictions in use (engine 1.54.0, WP-3.8, docs/ui.md § Drought
// restrictions): a scenario sets a restriction rule through "Change a
// setting"; Settings starts a rule from the WUA's published notice, reads each
// unit's own dam and adds an EWR trigger; an editor replaces it with an
// outlook's review triggers (asked first; the panel then says it is the
// rule); a run under it shows the Units & supply tables (axe, and no sideways
// scroll at phone width), and the printable report shows them too.
//
// Synthetic catchment (support/api.ts sampleModel): twelve water years of
// made-up rain, each scaled differently. The outlook's levels are all below
// 100 %, so every band whose level met the rule cuts demand.
import type { APIRequestContext } from '@playwright/test';
import { createProject, createRun, putModel, putSeries, sampleModel, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveSettings } from '../support/settings.ts';
import { runJobsTick } from '../support/jobs.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { createScenario } from '../support/scenarios.ts';
import { answerConfirm } from '../support/confirm.ts';

const START = '2006-10-01';
const YEAR_SCALE = [1.0, 0.3, 1.5, 0.6, 1.2, 0.2, 0.9, 1.4, 0.45, 0.8, 1.1, 0.5];
const DAY = 86_400_000;

async function settingsOf(request: APIRequestContext, projectId: string): Promise<{ droughtRestriction?: { reviewDates: string[]; liftDates?: string[]; levels: unknown[] } | null }> {
	const res = await request.get(`${API_URL}/projects/${projectId}`);
	expect(res.status()).toBe(200);
	return ((await res.json()) as { project: { settings: never } }).project.settings;
}

test('a scenario sets a restriction rule; the outlook’s triggers become the project’s rule; a run under it shows its tables', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Restrictions in use');
	await putModel(page.request, project.id, sampleModel());
	await updateSettings(page.request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: new Array(12).fill(400)
	});
	const days = (Date.parse('2018-10-01T00:00:00Z') - Date.parse(`${START}T00:00:00Z`)) / DAY;
	const rain = syntheticRain(days).map((v, t) => Math.round(v * YEAR_SCALE[Math.floor(t / 365.25) % YEAR_SCALE.length]! * 10) / 10);
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain });
	const runId = await createRun(page.request, project.id, 'Base');

	// A scenario sets the rule through "Change a setting": the editor starts off, switches on from the template.
	const scenarioId = await createScenario(page.request, project.id, { name: 'Restricted', baseRunId: runId });
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Kind of change').selectOption({ label: 'Change a setting' });
	await form.getByLabel('Setting').selectOption({ label: 'Drought restriction rule' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: off');
	await form.getByLabel('Apply drought restrictions in runs').check();
	await expect(form.getByTestId('restriction-level')).toHaveCount(3);
	await form.getByRole('button', { name: 'Add change' }).click();
	const change = page.getByRole('list', { name: 'Changes in Restricted' }).getByRole('listitem');
	await expect(change).toHaveCount(1);
	await expect(change).toContainText('Drought restriction rule: off → reviewed 1 Oct, 1 Jan, lifted 1 May; Level 1 (below 60 %)');
	await expect(change).toContainText('Baseline assumption');

	// The WUA publishes a 25 % restriction notice; Settings starts a rule from it, reads each unit's own dam, and adds
	// an EWR trigger at the outlet.
	const pub = await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId, restriction: { level: 'restricted', pct: 25 } } });
	expect(pub.status()).toBe(201);
	await page.goto(`/projects/${project.id}?tab=settings`);
	const settings = page.getByRole('region', { name: /^Drought restrictions/ });
	await settings.getByRole('button', { name: 'Start from the published notice' }).click();
	await expect(settings.getByTestId('restriction-words')).toContainText('Published notice (below 100 %): crops 25 %');
	await settings.getByLabel('Storage the level reads').selectOption({ label: 'Each unit’s own dam' });
	await settings.getByLabel('Also restrict when the EWR wasn’t met the day before a review').check();
	await expect(settings.getByTestId('restriction-words')).toContainText("each unit's own dam; at least level 1 when the EWR at the outlet wasn't met the day before a review");
	await saveSettings(page);
	const fromNotice = (await settingsOf(page.request, project.id)).droughtRestriction as { basis?: string; ewrTrigger?: unknown; levels: { belowPct: number }[] };
	expect(fromNotice).toMatchObject({ basis: 'own', ewrTrigger: { siteNodeId: null, level: 1 }, levels: [{ belowPct: 1 }] });

	// The outlook at 70 / 40 %, and its review triggers saved as the project's rule, replacing that one.
	const made = await page.request.post(`${API_URL}/projects/${project.id}/outlooks`, {
		// A planning share of 70 %: on this record both levels meet the EWR in 8 of 11 analogue years, short of the default 80 %.
		data: { name: 'This season', baseRunId: runId, planningShare: 0.7, levels: [70, 40].map((p) => ({ label: `${p} %`, ops: [{ op: 'demand.scale', factor: p / 100 }] })) }
	});
	expect(made.status()).toBe(202);
	await runJobsTick({ projects: [project.id], schedule: false });
	await page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const panel = page.getByTestId('seasonal-outlook');
	await expect(panel).toHaveAttribute('data-state', 'complete');
	const asRule = panel.getByTestId('triggers-as-rule');
	await expect(asRule.getByTestId('triggers-rule-words')).toContainText(/^reviewed 1 Jan, lifted 1 May; /);
	// Cancelled: the rule stays the notice's.
	await asRule.getByRole('button', { name: 'Replace the drought restriction rule with this' }).click();
	await answerConfirm(page, false, 'Replace the drought restriction rule?');
	await expect(asRule.getByRole('button', { name: 'Replace the drought restriction rule with this' })).toBeVisible();
	expect((await settingsOf(page.request, project.id)).droughtRestriction).toEqual(fromNotice);
	await asRule.getByRole('button', { name: 'Replace the drought restriction rule with this' }).click();
	await answerConfirm(page, true, 'Replace the drought restriction rule?');
	await expect(asRule.getByTestId('triggers-rule-saved')).toHaveText('Saved to Settings → Drought restrictions. Runs from now on follow it.');
	await expect(asRule.getByTestId('triggers-rule-current')).toHaveText('This is the project’s drought restriction rule.');
	await expect(asRule.getByRole('button', { name: /drought restriction rule/ })).toHaveCount(0);
	const rule = (await settingsOf(page.request, project.id)).droughtRestriction!;
	expect(rule.reviewDates).toEqual(['01-01']);
	expect(rule.liftDates).toEqual(['05-01']);
	expect(rule.levels.length).toBeGreaterThan(0);

	// A run under the rule: its tables on Units & supply.
	const restrictedRun = await createRun(page.request, project.id, 'Restricted');
	await page.goto(`/projects/${project.id}?tab=supply&run=${restrictedRun}#res-restrictions`);
	const section = page.locator('#res-restrictions');
	await expect(section.getByRole('heading', { name: 'Drought restrictions' })).toBeVisible();
	await expect(section.getByTestId('restriction-rule')).toContainText('reviewed 1 Jan, lifted 1 May');
	await expect(section.getByTestId('restriction-days-table').locator('tbody tr').last()).toContainText('Whole run');
	await expect(section.getByTestId('restriction-units-table').locator('tbody tr')).toHaveCount(sampleModel().nodes.filter((n) => n.kind === 'farm').length);
	await expect(page.getByRole('navigation', { name: 'Hydrological units sections' }).getByRole('link', { name: 'Drought restrictions' })).toBeVisible();
	await expectNoViolations(page, { include: '#res-restrictions' });
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoSidewaysScroll(page);

	// The printable report carries the same tables for the restricted run, and none for the base run made without the rule.
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(`/projects/${project.id}/report?run=${restrictedRun}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.locator('#report-restrictions-h')).toHaveText('Drought restrictions');
	await expect(page.getByTestId('restriction-days-table').locator('tbody tr').last()).toContainText('Whole run');
	await page.goto(`/projects/${project.id}/report?run=${runId}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByTestId('restriction-days-table')).toHaveCount(0);
});
