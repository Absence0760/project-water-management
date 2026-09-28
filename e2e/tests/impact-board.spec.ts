// The impact report's licence-impact board (issue #53 R7, docs/ui.md
// § Report): one column per water-year class of the baseline's natural flow,
// the annual waterfall and the days (here: no Reserve rule table) below the
// requirement, baseline vs this run, and the verdict from those days.
// Synthetic catchment: sampleModel on nine water years whose rain differs by
// year, so the years fall into dry / normal / wet.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, createRun, putModel, putSeries, sampleModel, updateSettings, type Model } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const START = '2012-10-01';
/** Nine complete water years, 2012/13 … 2020/21. */
const DAYS = 3287;

/** Rain on every ninth day, scaled by the water year (× 0.4, 1, 1.8 in turn), so the years differ. Invented. */
function yearlyRain(days: number): number[] {
	const factors = [0.4, 1, 1.8];
	return Array.from({ length: days }, (_, i) => {
		const f = factors[Math.floor(i / 365.25) % 3]!;
		return i % 9 === 0 ? Math.round((18 + (i % 5)) * f * 10) / 10 : i % 4 === 0 ? Math.round(2.5 * f * 10) / 10 : 0;
	});
}

/** A project on sampleModel with `days` of that rain from START. */
async function seedProject(page: Page, name: string, days: number) {
	const project = await createProject(page.request, name);
	const model = sampleModel();
	await putModel(page.request, project.id, model);
	await updateSettings(page.request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: yearlyRain(days) });
	return { project, model };
}

async function seed(page: Page, name: string) {
	const { project, model } = await seedProject(page, name, DAYS);
	const baseline = await createRun(page.request, project.id, 'Baseline');
	const upper = model.nodes[1]!;
	const more: Model = { ...model, cropAreas: model.cropAreas.map((a) => (a.nodeId === upper.id ? { ...a, areaM2: a.areaM2 * 3 } : a)) };
	await putModel(page.request, project.id, more);
	const application = await createRun(page.request, project.id, 'Three times the orchard');
	return { id: project.id, baseline, application };
}

const board = (page: Page) => page.getByTestId('licence-impact-board');

test('the impact report opens with the board: a column per year class, the waterfall, the days below, the verdict', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Impact board valley');
	await page.goto(`/projects/${p.id}/report?run=${p.application}&against=${p.id}%3A${p.baseline}`);
	await expect(page.locator('main[data-report-ready]')).toBeVisible();

	const b = board(page);
	await expect(b.getByRole('heading', { name: 'Impact by year class' })).toBeVisible();
	await expect(b.getByText(/split into terciles \(9 years compared\)/)).toBeVisible();
	const table = b.getByRole('table', { name: 'Impact by year class: the annual waterfall, the requirement not met and the verdict, baseline and this run' });
	await expect(table.getByRole('columnheader')).toHaveText([/^Measure$/, /^Dry/, /^Normal/, /^Wet/]);
	await expect(table.getByRole('rowheader')).toHaveText([/^Annual waterfall/, 'Days below the pragmatic EWR at the outlet', 'Verdict']);

	for (const id of ['dry', 'normal', 'wet']) {
		await expect(b.getByTestId(`board-class-${id}`)).toContainText(/\d+ years?$/);
		// The waterfall from natural flow to what is left, each step in m³ a year.
		const w = b.getByTestId(`board-waterfall-${id}`);
		await expect(w.locator('dt')).toHaveText(['Natural flow', 'Existing use in the baseline “Baseline”', 'Proposed use (this run − baseline)', 'Other: dams, storage, groundwater, land cover', 'Flow left at the outlet']);
		await expect(w.locator('dd').first()).toHaveText(/^[\d ]+ m³$/);
		// The days below, baseline and this run, and the change.
		const below = b.getByTestId(`board-below-${id}`);
		await expect(below.locator('dt')).toHaveText(['Baseline', 'This run', 'Change']);
		await expect(below).toContainText(/of [\d ]+ days/);
		// The verdict from the days, reported as data, never advice.
		const v = b.getByTestId(`board-verdict-${id}`);
		await expect(v).toHaveAttribute('data-verdict', /^(moreBelow|fewerBelow|noChange)$/);
		await expect(v).toContainText(/The pragmatic EWR was (not met on \d+ (more|fewer) days? over \d+ \w+ years \(\d+ in the baseline “Baseline”, \d+ in this run\)|not met on \d+ days? over \d+ \w+ years in both runs|met on every day over \d+ \w+ years in both runs)\./);
	}
	// Existing use is the baseline's, said so, with what "authorised" would need.
	await expect(b.getByText(/^Existing use is the use in the baseline “Baseline” as that run modelled it/)).toBeVisible();
	await expect(b.getByText(/Existing authorised use needs a baseline run at every holder’s full registered volume/)).toBeVisible();
	await expect(b.getByText('Neither run has a Reserve rule table at the outlet, so the board counts days below the pragmatic EWR.')).toBeVisible();
	await expectNoViolations(page, { include: '[data-testid="licence-impact-board"]' });
});

test('a record too short for any class: every column says not enough years, no verdict', async ({ page, owner }) => {
	void owner;
	// Three water years: one per class.
	const { project } = await seedProject(page, 'Impact board short', 365 * 3);
	const baseline = await createRun(page.request, project.id, 'Baseline');
	const run = await createRun(page.request, project.id, 'Same again');
	await page.goto(`/projects/${project.id}/report?run=${run}&against=${project.id}%3A${baseline}`);
	await expect(page.locator('main[data-report-ready]')).toBeVisible();
	for (const id of ['dry', 'normal', 'wet']) {
		await expect(board(page).getByTestId(`board-waterfall-${id}`)).toHaveText('Not enough years');
		await expect(board(page).getByTestId(`board-below-${id}`)).toHaveText('Not enough years');
		await expect(board(page).getByTestId(`board-verdict-${id}`)).toHaveAttribute('data-verdict', 'notEnoughYears');
		await expect(board(page).getByTestId(`board-verdict-${id}`)).toContainText(/both runs cover: not enough years to judge\./);
	}
});
