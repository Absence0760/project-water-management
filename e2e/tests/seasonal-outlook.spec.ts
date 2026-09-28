// The seasonal outlook (issue #53 R5, docs/ui.md § Seasonal outlook): an
// editor sets the planning share in Settings (the season stays the default,
// marked pending the client), starts an outlook on a base run at 100 / 85 /
// 70 % plus a monthly plan, the background worker runs it (one tick that
// queues nothing of its own), and the table appears once the outlook's own
// status says complete. The rendered figures are checked against the stored
// result's per-year values, re-summarised here by hand (percentiles, years
// met, the planning figure's level), so the pipeline is pinned without
// copying model numbers into the spec. A viewer reads the same outlook, with
// no run button.
//
// Synthetic catchment (support/api.ts sampleModel): twelve complete water
// years of made-up rain, each year scaled differently so the years differ,
// and a flat 400 m³/day pragmatic EWR, so some seasons meet it and some don't.
import type { APIRequestContext } from '@playwright/test';
import { addMember, createProject, createRun, putModel, putSeries, sampleModel, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { grouped } from '../support/format.ts';
import { runJobsTick } from '../support/jobs.ts';

const START = '2006-10-01';
/** Rain multiplier per water year, 2006/07 … 2017/18 (invented). */
const YEAR_SCALE = [1.0, 0.3, 1.5, 0.6, 1.2, 0.2, 0.9, 1.4, 0.45, 0.8, 1.1, 0.5];
const DAY = 86_400_000;
const dayIndex = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${START}T00:00:00Z`)) / DAY;
const waterYearOf = (t: number) => {
	const d = new Date(Date.parse(`${START}T00:00:00Z`) + t * DAY);
	return d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
	const res = await request.get(`${API_URL}${path}`);
	expect(res.status(), path).toBe(200);
	return (await res.json()) as T;
}

async function seedTwelveYears(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	await putModel(request, project.id, sampleModel());
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400]
	});
	const rain = syntheticRain(dayIndex('2018-10-01')).map((v, t) => Math.round(v * YEAR_SCALE[waterYearOf(t) - 2006]! * 10) / 10);
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain });
	return project;
}

type Year = { waterYear: number; label: string; seasonEndStorageM3: number | null; demandM3: number; userDemandM3: number; demandMet: number | null; ewrDays: { days: number; below: number } };
type Level = { id: string; label: string; problems: string[]; nYears: number; years: Year[] };
type OutlookBody = {
	outlook: {
		id: string;
		status: string;
		decisionDate: string;
		seasonEnd: string;
		planningShare: number | null;
		levels: { id: string; label: string; ops: unknown[] }[];
		result: { metric: string; nYears: number; days: number; levels: Level[]; analogues: { waterYear: number }[] };
	};
};

/** Linear (type 7) percentile of sorted values. */
function percentile(sorted: number[], p: number) {
	const h = (sorted.length - 1) * (p / 100);
	const lo = Math.floor(h);
	return lo + 1 < sorted.length ? sorted[lo]! + (h - lo) * (sorted[lo + 1]! - sorted[lo]!) : sorted[lo]!;
}
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
// The app groups thousands with a narrow no-break space (fmtNum), not a comma.
const m3 = (v: number) => `${grouped(v)} m³`;
const pct = (v: number) => `${whole.format(v * 100)} %`;
function stat(values: (number | null)[], f: (v: number) => string) {
	const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
	return { median: f(percentile(v, 50)), band: `10–90 %: ${f(percentile(v, 10))} – ${f(percentile(v, 90))}` };
}

test('an editor sets the planning share, runs an outlook with a monthly plan, and the table shows each level; a viewer reads it', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedTwelveYears(page.request, 'Seasonal outlook');
	const runId = await createRun(page.request, project.id, 'Base');

	// Settings: the defaults are marked pending the client; the project chooses a 55 % planning share and keeps the default season.
	await page.goto(`/projects/${project.id}?tab=settings`);
	const section = page.getByTestId('outlook-settings');
	await expect(section.getByTestId('season-pending')).toHaveText('Default pending the client');
	await expect(section.getByTestId('share-pending')).toHaveText('Default pending the client');
	await section.getByRole('checkbox', { name: 'Use the default planning share (80 %)' }).uncheck();
	await expect(section.getByTestId('share-pending')).toHaveCount(0);
	await section.getByLabel('Planning share (% of analogue years)').fill('55');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByText('Settings saved.')).toBeVisible();
	const saved = await getJson<{ project: { settings: { outlook: unknown } } }>(page.request, `/projects/${project.id}`);
	expect(saved.project.settings.outlook).toEqual({ season: null, planningShare: 0.55 });

	// River & reserve: no outlook yet, then one with a monthly plan (Oct–Dec at 100 %, Jan–Apr at 80 %), queued until the worker runs it.
	await page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const panel = page.getByTestId('seasonal-outlook');
	await expect(panel).toHaveAttribute('data-state', 'empty');
	await expect(panel.getByTestId('outlook-empty')).toHaveText('No seasonal outlook on this run yet.');
	await expect(panel.getByLabel(/^Demand levels/)).toHaveValue('100, 85, 70');
	await panel.getByRole('checkbox', { name: 'Add a monthly plan' }).check();
	await panel.getByLabel('Name', { exact: true }).fill('Taper');
	for (const m of ['Jan', 'Feb', 'Mar', 'Apr']) await panel.getByLabel(`${m} (%)`).fill('80');
	await panel.getByRole('button', { name: 'Run seasonal outlook' }).click();
	await expect(panel).toHaveAttribute('data-state', 'pending');
	await expect(panel.getByTestId('outlook-status')).toHaveText('Queued: waiting for the background worker.');
	await runJobsTick({ schedule: false });
	await expect(panel).toHaveAttribute('data-state', 'complete');

	// What it should say, re-summarised from the stored result's per-year values.
	const { outlooks } = await getJson<{ outlooks: { id: string }[] }>(page.request, `/projects/${project.id}/outlooks?baseRunId=${runId}`);
	expect(outlooks).toHaveLength(1);
	const { outlook } = await getJson<OutlookBody>(page.request, `/projects/${project.id}/outlooks/${outlooks[0]!.id}`);
	expect(outlook).toMatchObject({ status: 'complete', decisionDate: '2018-10-01', seasonEnd: '2019-04-30', planningShare: 0.55 });
	expect(outlook.levels.map((l) => [l.label, l.ops])).toEqual([
		['100 %', [{ op: 'demand.scale', factor: 1 }]],
		['85 %', [{ op: 'demand.scale', factor: 0.85 }]],
		['70 %', [{ op: 'demand.scale', factor: 0.7 }]],
		[
			'Taper',
			[
				{ op: 'demand.scale', factor: 1, months: [10, 11, 12] },
				{ op: 'demand.scale', factor: 0.8, months: [1, 2, 3, 4] }
			]
		]
	]);
	const r = outlook.result;
	expect(r.metric).toBe('daysBelowEwr');
	// Every water year whose 1 October – 30 April lies in the record: 2006/07 … 2017/18.
	expect(r.analogues.map((a) => a.waterYear)).toEqual([2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017]);
	const n = r.nYears;
	expect(n).toBe(12);

	await expect(panel.getByTestId('outlook-season')).toHaveText(`Season: 1 Oct 2018 – 30 Apr 2019 (${r.days} days)`);
	await expect(panel.getByTestId('outlook-season-pending')).toHaveText('Season pending the client');
	await expect(panel.getByTestId('outlook-share')).toHaveText('Planning share: 55 % of analogue years');
	await expect(panel.getByTestId('outlook-share-pending')).toHaveCount(0);
	await expect(panel.getByTestId('outlook-metric')).toHaveText('Measure: Days below the pragmatic EWR at the outlet');
	await expect(panel.getByTestId('outlook-years')).toHaveText('12 analogue years');

	const table = panel.getByTestId('outlook-table');
	await expect(table.locator('tbody th')).toHaveText(['100 %', '85 %', '70 %', 'Taper'].map((l) => new RegExp(`^${l}`)));
	for (const level of r.levels) {
		expect(level.problems).toEqual([]);
		expect(level.years).toHaveLength(n);
		const cells = table.locator(`tbody tr[data-level="${level.id}"] td`);
		const want = [
			stat(level.years.map((y) => y.seasonEndStorageM3), m3),
			stat(level.years.map((y) => y.demandMet), pct),
			stat(level.years.map((y) => y.ewrDays.below / y.ewrDays.days), pct)
		];
		for (const [i, w] of want.entries()) {
			await expect(cells.nth(i).locator('strong')).toHaveText(w.median);
			await expect(cells.nth(i).locator('.band')).toHaveText(w.band);
		}
		const met = level.years.filter((y) => y.ewrDays.below === 0).length;
		await expect(cells.nth(3)).toHaveText(`EWR met on every day in ${met} of ${n} years`);
	}
	// The planning figure: the highest level by mean season demand that met the EWR in full in at least 55 % of the years.
	const mean = (l: Level) => l.years.reduce((a, y) => a + y.demandM3 + y.userDemandM3, 0) / n;
	const ranked = [...r.levels].sort((a, b) => mean(b) - mean(a));
	const metIn = (l: Level) => l.years.filter((y) => y.ewrDays.below === 0).length;
	const pick = ranked.find((l) => metIn(l) >= 0.55 * n);
	// The fixture (a 400 m³/day EWR) is built so the check means something: some years meet it in full and some don't, and a level makes the planning figure.
	expect(metIn(r.levels[0]!)).toBeGreaterThan(0);
	expect(metIn(r.levels[0]!)).toBeLessThan(n);
	expect(pick).toBeDefined();
	const planning = panel.getByTestId('outlook-planning');
	await expect(planning).toHaveText(`${pick!.label}: met the EWR on every day of the season in ${metIn(pick!)} of ${n} analogue years, the highest demand level to do so in at least 55 % of them.`);
	await expect(table.locator(`tbody tr[data-level="${pick!.id}"]`).getByTestId('planning-level')).toHaveText('Planning figure');
	await expect(panel.getByTestId('planning-level')).toHaveCount(1);
	// Every analogue year, one row each.
	await panel.getByText('Every analogue year').click();
	await expect(panel.getByTestId('outlook-years-table').locator('tbody tr')).toHaveCount(n);
	await expect(panel.getByTestId('return-flow-note')).toContainText('taking less from the dam can leave the river lower on dry days');
	await expect(panel.getByTestId('outlook-disclaimer')).toContainText('They are not measurements or predictions of what will happen');
	await expect(panel.getByTestId('outlook-disclaimer')).toContainText('are not official restrictions or allocations');
	await expect(panel.getByText(/recommend|likely|should|best|optimal/i)).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="seasonal-outlook"]' });

	// A viewer: the same outlook, no run button.
	const viewer = await signIn('Outlook viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const theirs = viewer.page.getByTestId('seasonal-outlook');
	await expect(theirs).toHaveAttribute('data-state', 'complete');
	await expect(theirs.getByTestId('outlook-planning')).toHaveText((await planning.innerText()).trim());
	await expect(theirs.getByTestId('outlook-table').locator('tbody tr')).toHaveCount(4);
	await expect(theirs.getByRole('button', { name: /outlook/ })).toHaveCount(0);
});
