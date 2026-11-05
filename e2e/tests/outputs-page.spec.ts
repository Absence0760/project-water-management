// The Outputs page (`?tab=outputs`, docs/ui.md § Outputs): the five planning
// outputs of issue #53 on one page for one run, each a section with an
// `#out-…` anchor under a short index. Its sidebar row sits after EWR; the
// index links land on each section; each output renders where the seed has
// what it needs (a demand sweep and an outlook on the base run, a scenario run
// on it for the licence impact), and says why in one line where it doesn't
// (a run with no sweep or outlook; a run of the model for the licence impact;
// a scenario's run for the matrix and the outlook). A viewer reads every
// section without the editors' controls, on a phone too, sections stacked.
// The outputs' own figures are pinned by their own specs (irrigation-support,
// share-the-pain, outcome-matrix, seasonal-outlook, impact-board); this one
// pins the page that gathers them.
//
// Synthetic catchment (support/api.ts sampleModel): twelve complete water
// years of made-up rain, each year scaled differently so the years differ,
// and a flat 400 m³/day pragmatic EWR, as seasonal-outlook.spec.ts seeds it.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, putModel, putSeries, sampleModel, syntheticRain, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { createScenario } from '../support/scenarios.ts';

const START = '2006-10-01';
/** Rain multiplier per water year, 2006/07 … 2017/18 (invented). */
const YEAR_SCALE = [1.0, 0.3, 1.5, 0.6, 1.2, 0.2, 0.9, 1.4, 0.45, 0.8, 1.1, 0.5];
const DAY = 86_400_000;
const dayIndex = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${START}T00:00:00Z`)) / DAY;
const waterYearOf = (t: number) => {
	const d = new Date(Date.parse(`${START}T00:00:00Z`) + t * DAY);
	return d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};
/** The index, in the page's order: each section's heading and anchor. */
const INDEX = [
	['How much irrigation can the catchment support?', 'out-irrigation'],
	['Share the pain', 'out-share'],
	['Outcome matrix', 'out-matrix'],
	['Seasonal outlook', 'out-outlook'],
	['Impact by year class', 'out-licence']
] as const;
const LEVELS = [100, 85, 70];

async function seedTwelveYears(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	await putModel(request, project.id, sampleModel());
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: new Array(12).fill(400)
	});
	const rain = syntheticRain(dayIndex('2018-10-01')).map((v, t) => Math.round(v * YEAR_SCALE[waterYearOf(t) - 2006]! * 10) / 10);
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain });
	return project;
}

/** A base run with everything each output reads: a demand sweep and an outlook on it, and a scenario's run on it. */
async function seedEverything(request: APIRequestContext, name: string) {
	const project = await seedTwelveYears(request, name);
	const base = await createRun(request, project.id, 'Base');
	const sweep = await request.post(`${API_URL}/projects/${project.id}/sweeps`, {
		data: { name: 'Demand levels 100 % / 85 % / 70 %', baseRunId: base, members: LEVELS.map((p) => ({ name: `${p} %`, ops: [{ op: 'demand.scale', factor: p / 100 }] })) }
	});
	expect(sweep.ok()).toBe(true);
	const outlook = await request.post(`${API_URL}/projects/${project.id}/outlooks`, {
		data: { name: 'This season', baseRunId: base, levels: LEVELS.map((p) => ({ label: `${p} %`, ops: [{ op: 'demand.scale', factor: p / 100 }] })) }
	});
	expect(outlook.status()).toBe(202);
	const scenarioId = await createScenario(request, project.id, { name: 'Bigger orchards', baseRunId: base, ops: [{ op: 'demand.scale', factor: 1.4 }] });
	const ran = await request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	expect(ran.ok()).toBe(true);
	const scenarioRun = ((await ran.json()) as { run: { id: string } }).run.id;
	await runJobsTick({ projects: [project.id], schedule: false });
	return { id: project.id, base, scenarioRun };
}

const header = (page: Page) => page.getByTestId('section-header');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const index = (page: Page) => page.getByRole('navigation', { name: 'Outputs sections' });

async function openOutputs(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=outputs${query}`);
	await expect(header(page).getByRole('heading', { level: 1, name: 'Outputs' })).toBeVisible();
}

test('the Outputs row follows EWR; its index lands on each output, and each renders from the base run’s sweep, outlook and scenario run', async ({ page, owner }) => {
	test.setTimeout(120_000);
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const p = await seedEverything(page.request, 'Outputs page');

	await page.goto(`/projects/${p.id}`);
	await expect(sidebar(page).getByRole('link', { name: 'Outputs', exact: true })).toBeVisible();
	// Its row is right after EWR's (Data's link may carry its "behind" count).
	const names = (await sidebar(page).getByRole('link').allInnerTexts()).map((t) => t.replace(/\s*\d+$/, '').trim());
	expect(names.indexOf('Outputs')).toBe(names.indexOf('EWR') + 1);
	await expect(sidebar(page).getByRole('link', { name: 'Outputs', exact: true })).toHaveAttribute('href', '?tab=outputs');
	await sidebar(page).getByRole('link', { name: 'Outputs', exact: true }).click();
	await expect(header(page).getByRole('heading', { level: 1, name: 'Outputs' })).toBeVisible();
	await expect(page).toHaveURL(/[?&]tab=outputs/);
	await expect(page.getByTestId('outputs-body')).toHaveAttribute('data-run', p.scenarioRun);

	// The newest run is the scenario's: pick the base run, as on EWR.
	await header(page).getByRole('combobox', { name: 'Run' }).selectOption(p.base);
	await expect(page.getByTestId('outputs-body')).toHaveAttribute('data-run', p.base);
	await expect(page.getByTestId('outputs-body')).toHaveAttribute('aria-busy', 'false');

	// The index names each section by its heading, in the page's order.
	await expect(index(page).getByRole('link')).toHaveText(INDEX.map(([label]) => label));
	for (const [label, id] of INDEX) await expect(index(page).getByRole('link', { name: label, exact: true })).toHaveAttribute('href', `#${id}`);

	// Each output from the base run's own data (positive controls).
	const irrigation = page.getByTestId('irrigation-support');
	await expect(irrigation).toHaveAttribute('data-state', 'complete');
	await expect(irrigation.getByTestId('irr-level')).toHaveCount(LEVELS.length);
	await expect(page.locator('#out-share').getByRole('region', { name: 'Share the pain' })).toBeVisible();
	await expect(page.locator('#out-share').getByRole('heading', { level: 3, name: /^Share the pain/ })).toBeVisible();
	await expect(page.locator('#out-share').getByRole('link', { name: 'table per hydrological unit' })).toHaveAttribute('href', `?tab=supply&run=${p.base}#res-curtailment`);
	await expect(page.getByTestId('outcome-matrix')).toHaveAttribute('data-state', 'complete');
	await expect(page.getByTestId('seasonal-outlook')).toHaveAttribute('data-state', 'complete');
	// On a run of the model the licence impact offers the scenario's run on it rather than choosing one.
	const licence = page.getByTestId('out-licence');
	await expect(licence).toHaveAttribute('data-state', 'base');
	await expect(licence.getByTestId('out-licence-empty')).toHaveText(/^The board compares a scenario’s run with the run it is based on, and this is a run of the model\. Pick a scenario’s run:$/);
	await expect(licence.getByRole('link', { name: 'Bigger orchards' })).toHaveAttribute('href', `?tab=outputs&run=${encodeURIComponent(p.scenarioRun)}#out-licence`);
	// The editor's controls are here, as on EWR.
	await expect(page.getByTestId('outcome-matrix').getByRole('button', { name: 'Run a new demand sweep' })).toBeVisible();

	// Every index link lands on its section.
	for (const [label, id] of INDEX) {
		await index(page).getByRole('link', { name: label, exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`#${id}$`));
		await expect(page.locator(`#${id}`)).toBeInViewport();
	}
	await expectNoViolations(page);

	// The scenario's run: its licence impact against the base its scenario names; the sweep and the outlook need an ordinary run.
	await licence.getByRole('link', { name: 'Bigger orchards' }).click();
	await expect(page.getByTestId('outputs-body')).toHaveAttribute('data-run', p.scenarioRun);
	await expect(page.getByTestId('out-licence')).toHaveAttribute('data-state', 'complete');
	const board = page.getByTestId('licence-impact-board');
	await expect(board.getByRole('heading', { level: 3, name: 'Impact by year class' })).toBeVisible();
	await expect(board.getByTestId('board-summary').getByRole('rowheader')).toHaveText(['Baseline', 'This run', 'Proposed use, mean a year', 'Years compared', 'Requirement']);
	await expect(board.getByTestId('board-summary').getByRole('row', { name: /^Baseline/ })).toContainText('“Base”');
	const pair = page.getByTestId('out-licence-pair');
	await expect(pair).toContainText('The run of the scenario Bigger orchards against its base run “Base”');
	await expect(pair.getByRole('link', { name: 'Impact report' })).toHaveAttribute('href', new RegExp(`/projects/${p.id}/report\\?run=${p.scenarioRun}&against=${p.id}%3A${p.base}$`));
	await expect(page.getByTestId('outcome-matrix').getByTestId('tool-row')).toContainText('Needs an ordinary run, not a scenario or forecast.');
	await expect(page.getByTestId('seasonal-outlook').getByTestId('tool-row')).toBeVisible();
	await expect(page.getByTestId('irrigation-support')).not.toHaveAttribute('data-state', 'complete');
	await expectNoViolations(page);
});

test('a loaded #out-… link lands on its section once the run is in', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedTwelveYears(page.request, 'Outputs anchor');
	const run = await createRun(page.request, project.id, 'Base');
	await openOutputs(page, project.id, `&run=${run}#out-outlook`);
	await expect(page.locator('#outlook-h')).toBeFocused();
	await expect(page.locator('#out-outlook')).toBeInViewport();
});

test('a viewer reads every section with no editor controls, each saying why it is empty; on a phone they stack', async ({ page, owner, signIn }) => {
	test.setTimeout(90_000);
	void owner;
	const project = await seedTwelveYears(page.request, 'Outputs viewer');
	const run = await createRun(page.request, project.id, 'Base');
	const viewer = await signIn('Outputs viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 390, height: 844 });
	await openOutputs(v, project.id);
	await expect(v.getByTestId('outputs-body')).toHaveAttribute('data-run', run);

	// No sweep, no outlook: one line each, saying an editor can run one, and no Run….
	await expect(v.getByTestId('irrigation-support')).toHaveAttribute('data-state', 'empty');
	await expect(v.getByTestId('irrigation-support').getByTestId('tool-row')).toContainText('Not run yet: an editor can run a demand sweep.');
	await expect(v.getByTestId('outcome-matrix').getByTestId('tool-row')).toContainText('Not run yet: an editor can run one.');
	await expect(v.getByTestId('seasonal-outlook')).toHaveAttribute('data-state', 'empty');
	await expect(v.getByTestId('seasonal-outlook').getByTestId('tool-row')).toBeVisible();
	await expect(v.getByTestId('outputs-body').getByRole('button', { name: /^Run/ })).toHaveCount(0);
	await expect(v.getByLabel(/^Demand levels/)).toHaveCount(0);
	// Share the pain needs only the run (positive control for a viewer).
	await expect(v.locator('#out-share').getByRole('region', { name: 'Share the pain' })).toBeVisible();
	// No scenario on this run: the licence impact says so, with where to make one.
	const licence = v.getByTestId('out-licence');
	await expect(licence).toHaveAttribute('data-state', 'base');
	await expect(licence.getByTestId('out-licence-empty')).toContainText('No scenario based on this run has been run yet: open Scenarios.');
	await expect(licence.getByRole('link', { name: 'open Scenarios' })).toHaveAttribute('href', '?tab=scenarios');

	// On a phone the sections stack: one column, each as wide as the next, nothing sideways.
	const boxes = await Promise.all(INDEX.map(([, id]) => v.locator(`#${id}`).boundingBox()));
	for (const [i, b] of boxes.entries()) {
		expect(b, INDEX[i]![1]).not.toBeNull();
		expect(b!.x).toBeCloseTo(boxes[0]!.x, 0);
		expect(b!.width).toBeCloseTo(boxes[0]!.width, 0);
		if (i) expect(b!.y).toBeGreaterThan(boxes[i - 1]!.y + boxes[i - 1]!.height - 1);
	}
	await expectNoSidewaysScroll(v);
	await expectNoViolations(v);
});

test('with no run yet the page is one empty state, and an editor gets Run the model', async ({ page, owner }) => {
	void owner;
	const project = await seedTwelveYears(page.request, 'Outputs no run');
	await openOutputs(page, project.id);
	const empty = page.getByTestId('outputs-empty');
	await expect(empty.getByRole('heading', { level: 2, name: 'No run yet' })).toBeVisible();
	await expect(empty.getByRole('link', { name: 'Run the model' })).toHaveAttribute('href', '?tab=runs');
	await expect(page.getByRole('navigation', { name: 'Outputs sections' })).toHaveCount(0);
	await expectNoViolations(page);
});
