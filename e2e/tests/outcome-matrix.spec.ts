// The outcome matrix (issue #53 R4, docs/ui.md § Outcome matrix): an editor
// sets the water-year classes to terciles in Settings (the risk cut-offs stay
// the defaults, marked pending the hydrologist), starts a demand sweep
// (100 / 85 / 70 %) on a base run, the background worker runs it (one tick
// that queues nothing of its own), and the matrix appears once the sweep's
// own status says complete. The rendered cells are checked against the
// sweep's stored series, re-counted here by hand from the API (days below
// the EWR per class of year, the classes from the base run's natural flow),
// so the whole pipeline is pinned without copying model numbers into the
// spec. The project's own cut-offs then recolour the same sweep, and the
// pending badge goes. A viewer reads the same matrix, with no run button.
//
// Synthetic catchment (support/api.ts sampleModel): nine complete water
// years of made-up rain, each year scaled differently so the years differ.
import type { APIRequestContext } from '@playwright/test';
import { addMember, createProject, createRun, putModel, putSeries, sampleModel, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';

const START = '2010-10-01';
/** Rain multiplier per water year, 2010/11 … 2018/19 (invented). */
const YEAR_SCALE = [1.0, 0.3, 1.5, 0.6, 1.2, 0.2, 0.9, 1.4, 0.45];
const DAY = 86_400_000;
const dayIndex = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${START}T00:00:00Z`)) / DAY;
/** The water year (by the calendar year its 1 October falls in) of day t of the record. */
const waterYearOf = (t: number) => {
	const d = new Date(Date.parse(`${START}T00:00:00Z`) + t * DAY);
	return d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
	const res = await request.get(`${API_URL}${path}`);
	expect(res.status(), path).toBe(200);
	return (await res.json()) as T;
}

async function seedNineYears(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	await putModel(request, project.id, sampleModel());
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const days = dayIndex('2019-10-01');
	const rain = syntheticRain(days).map((v, t) => Math.round(v * YEAR_SCALE[waterYearOf(t) - 2010]! * 10) / 10);
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain });
	return project;
}

type Series = { key: string; nodeId: string | null; values: (number | null)[] };
type SweepBody = { sweep: { id: string; status: string; members: { name: string; status: string; startDate: string; series: Series[] }[] } };

/** What the matrix should say, counted from the API: classes by the base run's annual natural flow, days below the EWR per member. */
function expectedMatrix(natural: (number | null)[], members: SweepBody['sweep']['members'], cutoffs = { lower: 0.05, increasing: 0.2 }) {
	const totals = new Map<number, number>();
	natural.forEach((v, t) => totals.set(waterYearOf(t), (totals.get(waterYearOf(t)) ?? 0) + (v ?? Number.NaN)));
	const ranked = [...totals.entries()].sort((a, b) => a[1] - b[1]).map(([wy]) => wy);
	expect(ranked).toHaveLength(9);
	const classes = [
		{ label: 'Dry', years: ranked.slice(0, 3) },
		{ label: 'Normal', years: ranked.slice(3, 6) },
		{ label: 'Wet', years: ranked.slice(6) }
	];
	const rows = members.map((m) => {
		const shortfall = m.series.find((s) => s.nodeId === null && s.key === 'ewr_shortfall')!.values;
		const perYear = new Map<number, { days: number; below: number }>();
		shortfall.forEach((v, t) => {
			const y = perYear.get(waterYearOf(t)) ?? { days: 0, below: 0 };
			y.days++;
			if (v !== null && v < 0) y.below++;
			perYear.set(waterYearOf(t), y);
		});
		return classes.map((c) => {
			const ys = c.years.map((wy) => perYear.get(wy)!);
			const share = ys.reduce((s, y) => s + y.below, 0) / ys.reduce((s, y) => s + y.days, 0);
			const met = ys.filter((y) => y.below === 0).length;
			// The defaults, pending the hydrologist: ≤ 5 % lower risk, ≤ 20 % increasing, else high.
			const risk = share <= cutoffs.lower ? 'lower' : share <= cutoffs.increasing ? 'increasing' : 'high';
			const label = { lower: 'Lower risk', increasing: 'Increasing risk', high: 'High risk' }[risk];
			return { risk, text: `${label} EWR met on every day in ${met} of 3 ${c.label.toLowerCase()} years (below it on ${Math.round(share * 100)} % of days).` };
		});
	});
	return { classes, totals, rows };
}

test('an editor sets terciles, runs a demand sweep, and the matrix shows each level by class of year; a viewer reads it', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedNineYears(page.request, 'Outcome matrix');
	const runId = await createRun(page.request, project.id, 'Base');

	// Settings: the class method, with the cut-offs left at the defaults (pending the hydrologist).
	await page.goto(`/projects/${project.id}?tab=settings`);
	const section = page.getByTestId('outcome-settings');
	await expect(section.getByLabel('Water-year classes')).toHaveValue('auto');
	await expect(section.getByTestId('cutoffs-pending-reserveMonthsMet')).toHaveText('Defaults pending the hydrologist');
	await expect(section.getByTestId('cutoffs-pending-daysBelowEwr')).toHaveText('Defaults pending the hydrologist');
	await section.getByLabel('Water-year classes').selectOption('terciles');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByText('Settings saved.')).toBeVisible();
	const saved = await getJson<{ project: { settings: { outcomes: unknown } } }>(page.request, `/projects/${project.id}`);
	expect(saved.project.settings.outcomes).toEqual({ yearClassMethod: 'terciles', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null } });

	// The Runs tab: no sweep yet, then one, queued until the worker runs it.
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	const panel = page.getByTestId('outcome-matrix');
	await expect(panel).toHaveAttribute('data-state', 'empty');
	await expect(panel.getByTestId('outcome-empty')).toHaveText('No demand sweep on this run yet.');
	await expect(panel.getByLabel(/^Demand levels/)).toHaveValue('100, 85, 70');
	await panel.getByRole('button', { name: 'Run demand sweep' }).click();
	await expect(panel).toHaveAttribute('data-state', 'pending');
	await expect(panel.getByTestId('sweep-status')).toHaveText('Queued: waiting for the background worker.');
	await runJobsTick({ schedule: false });
	await expect(panel).toHaveAttribute('data-state', 'complete');

	// What it should say, from the stored sweep and the base run's natural flow.
	const { sweeps } = await getJson<{ sweeps: { id: string }[] }>(page.request, `/projects/${project.id}/sweeps?baseRunId=${runId}`);
	expect(sweeps).toHaveLength(1);
	const { sweep } = await getJson<SweepBody>(page.request, `/projects/${project.id}/sweeps/${sweeps[0]!.id}?series=true`);
	expect(sweep.status).toBe('complete');
	expect(sweep.members.map((m) => [m.name, m.status, m.startDate])).toEqual([
		['100 %', 'done', START],
		['85 %', 'done', START],
		['70 %', 'done', START]
	]);
	const natural = await getJson<{ values: (number | null)[] }>(page.request, `/projects/${project.id}/runs/${runId}/series?key=natural_flow`);
	const want = expectedMatrix(natural.values, sweep.members);

	await expect(panel.getByTestId('outcome-metric')).toHaveText('Measure: Days below the pragmatic EWR at the outlet');
	await expect(panel.getByText('Terciles of 9 complete water years')).toBeVisible();
	await expect(panel.getByTestId('cutoffs-pending')).toHaveText('Risk cut-offs pending the hydrologist');

	const table = panel.getByTestId('outcome-table');
	const heads = table.locator('thead th');
	await expect(heads).toHaveCount(4);
	await expect(heads.first()).toHaveText('Demand level');
	await expect(heads.nth(1)).toHaveText(/^Dry ≤ [\d,]+ m³ · 3 years$/);
	await expect(heads.nth(2)).toHaveText(/^Normal [\d,]+ – [\d,]+ m³ · 3 years$/);
	await expect(heads.nth(3)).toHaveText(/^Wet > [\d,]+ m³ · 3 years$/);
	// The bounds are the catchment's own: each falls between the classes' annual totals, and the columns share them.
	const num = (s: string) => Number(s.replace(/,/g, ''));
	const dryUpper = num((await heads.nth(1).innerText()).match(/≤ ([\d,]+)/)![1]!);
	const [normalLower, normalUpper] = (await heads.nth(2).innerText()).match(/([\d,]+) – ([\d,]+)/)!.slice(1).map(num);
	const wetLower = num((await heads.nth(3).innerText()).match(/> ([\d,]+)/)![1]!);
	expect(normalLower).toBe(dryUpper);
	expect(wetLower).toBe(normalUpper);
	const total = (wy: number) => want.totals.get(wy)!;
	expect(Math.max(...want.classes[0]!.years.map(total))).toBeLessThanOrEqual(dryUpper + 1);
	expect(Math.min(...want.classes[1]!.years.map(total))).toBeGreaterThan(dryUpper - 1);
	expect(Math.max(...want.classes[1]!.years.map(total))).toBeLessThanOrEqual(normalUpper! + 1);
	expect(Math.min(...want.classes[2]!.years.map(total))).toBeGreaterThan(normalUpper! - 1);

	// The fixture is built so the matrix isn't one colour: the check below means something.
	expect(new Set(want.rows.flat().map((c) => c.risk)).size).toBeGreaterThan(1);
	await expect(table.locator('tbody th')).toHaveText(['100 %', '85 %', '70 %']);
	for (const [i, row] of want.rows.entries()) {
		const cells = table.locator('tbody tr').nth(i).locator('td');
		await expect(cells).toHaveText(row.map((c) => c.text));
		for (const [j, c] of row.entries()) await expect(cells.nth(j)).toHaveAttribute('data-risk', c.risk);
	}
	await expect(panel.getByText(/^Lower risk: below the EWR on at most 5 % of days\. Increasing risk: at most 20 %\. High risk: more than that\./)).toBeVisible();
	await expect(panel.getByText(/recommend/i)).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="outcome-matrix"]' });

	// The project's own cut-offs for days below the EWR: the same sweep re-read, no new run, and no pending badge.
	await page.goto(`/projects/${project.id}?tab=settings`);
	const days = section.getByRole('group', { name: /^Days below the pragmatic EWR/ });
	await days.getByRole('checkbox', { name: 'Use the default cut-offs (5 % and 20 %)' }).uncheck();
	await expect(section.getByTestId('cutoffs-pending-daysBelowEwr')).toHaveCount(0);
	await section.getByLabel('Lower risk up to (%)').fill('15');
	await section.getByLabel('Increasing risk up to (%)').fill('40');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByText('Settings saved.')).toBeVisible();
	const custom = await getJson<{ project: { settings: { outcomes: unknown } } }>(page.request, `/projects/${project.id}`);
	expect(custom.project.settings.outcomes).toEqual({ yearClassMethod: 'terciles', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: { lower: 0.15, increasing: 0.4 } } });
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	await expect(panel).toHaveAttribute('data-state', 'complete');
	await expect(panel.getByTestId('cutoffs-pending')).toHaveCount(0);
	const recoloured = expectedMatrix(natural.values, sweep.members, { lower: 0.15, increasing: 0.4 });
	for (const [i, row] of recoloured.rows.entries()) {
		const cells = table.locator('tbody tr').nth(i).locator('td');
		await expect(cells).toHaveText(row.map((c) => c.text));
		for (const [j, c] of row.entries()) await expect(cells.nth(j)).toHaveAttribute('data-risk', c.risk);
	}
	await expect(panel.getByText(/^Lower risk: below the EWR on at most 15 % of days\. Increasing risk: at most 40 %\./)).toBeVisible();

	// A viewer: the same matrix, no run button.
	const viewer = await signIn('Outcome viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	const theirs = viewer.page.getByTestId('outcome-matrix');
	await expect(theirs).toHaveAttribute('data-state', 'complete');
	await expect(theirs.getByTestId('outcome-table').locator('tbody th')).toHaveText(['100 %', '85 %', '70 %']);
	await expect(theirs.getByTestId('outcome-table').locator('tbody tr').first().locator('td')).toHaveText(recoloured.rows[0]!.map((c) => c.text));
	await expect(theirs.getByRole('button', { name: /demand sweep/ })).toHaveCount(0);
});
