// How much irrigation can the catchment support? (issue #53, docs/ui.md
// § Irrigation the catchment supports, docs/model.md §2.14b): the board beside
// the outcome matrix on EWR reads the matrix's demand sweep. With no sweep it is
// one row whose Run… opens the matrix's form; after the worker runs the sweep,
// each level's marker sits at the wettest water year that failed, re-counted
// here from the API (each year's natural flow at the outlet from the base run,
// each member's days below the EWR), so no model number is copied into the
// spec. The hectares are the base run's planted area × the level. A viewer
// reads the same board with no Run… (a sweep seeded through the API, so each
// test stays well inside its budget); the page's menu lists it; a11y at
// desktop and phone, and the phone stacks with no sideways scroll.
//
// Synthetic catchment (support/api.ts sampleModel): nine complete water years
// of made-up rain, each year scaled differently so the years differ.
import type { APIRequestContext } from '@playwright/test';
import { addMember, createProject, createRun, putModel, putSeries, sampleModel, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const START = '2010-10-01';
/** Rain multiplier per water year, 2010/11 … 2018/19 (invented). */
const YEAR_SCALE = [1.0, 0.3, 1.5, 0.6, 1.2, 0.2, 0.9, 1.4, 0.45];
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

async function seedNineYears(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	await putModel(request, project.id, sampleModel());
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const rain = syntheticRain(dayIndex('2019-10-01')).map((v, t) => Math.round(v * YEAR_SCALE[waterYearOf(t) - 2010]! * 10) / 10);
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain });
	return project;
}

type Series = { key: string; nodeId: string | null; values: (number | null)[] };
type SweepBody = { sweep: { id: string; members: { name: string; status: string; series: Series[] }[] } };

/** Per member: where breaches start (the wettest failing year's natural total, if some wetter year met), from the API. */
function expectedBoard(natural: (number | null)[], members: SweepBody['sweep']['members']) {
	const totals = new Map<number, number>();
	natural.forEach((v, t) => totals.set(waterYearOf(t), (totals.get(waterYearOf(t)) ?? 0) + (v ?? Number.NaN)));
	return members.map((m) => {
		const shortfall = m.series.find((s) => s.nodeId === null && s.key === 'ewr_shortfall')!.values;
		const failed = new Set<number>();
		shortfall.forEach((v, t) => v !== null && v < 0 && failed.add(waterYearOf(t)));
		const years = [...totals.entries()].map(([wy, total]) => ({ wy, total, met: !failed.has(wy) }));
		const failing = years.filter((y) => !y.met);
		if (!failing.length) return { kind: 'neverFailed', threshold: null, failed: 0 };
		const hi = Math.max(...failing.map((y) => y.total));
		if (!years.some((y) => y.total > hi)) return { kind: 'wettestFailed', threshold: null, failed: failing.length };
		return { kind: 'threshold', threshold: hi, failed: failing.length };
	});
}

test('the board reads the outcome matrix’s sweep: Run… opens the matrix’s form, then a marker per level at the wettest year that failed', async ({ page, owner }) => {
	void owner;
	const project = await seedNineYears(page.request, 'Irrigation support');
	const runId = await createRun(page.request, project.id, 'Base');

	await page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const board = page.getByTestId('irrigation-support');
	const matrix = page.getByTestId('outcome-matrix');
	await expect(board).toHaveAttribute('data-state', 'empty');
	// One row beside the matrix's, in the page's menu under the run-it-yourself tools.
	await expect(board.getByTestId('tool-row').getByRole('heading', { level: 3 })).toHaveText(/^How much irrigation can the catchment support\?/);
	await expect(page.getByRole('navigation', { name: 'EWR sections' }).getByRole('link', { name: 'How much irrigation can the catchment support?' })).toHaveAttribute('href', /#res-irrigation$/);
	// Its Run… is the matrix's: the form opens there, focus on the levels.
	await board.getByRole('button', { name: 'Run…' }).click();
	await expect(matrix.getByLabel(/^Demand levels/)).toBeFocused();
	await matrix.getByRole('button', { name: 'Run demand sweep' }).click();
	await expect(board).toHaveAttribute('data-state', 'pending');
	await expect(board.getByText('Waiting for the demand sweep…')).toBeVisible();
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(board).toHaveAttribute('data-state', 'complete');

	// What it should say, from the stored sweep and the base run's natural flow.
	const { sweeps } = await getJson<{ sweeps: { id: string }[] }>(page.request, `/projects/${project.id}/sweeps?baseRunId=${runId}`);
	const { sweep } = await getJson<SweepBody>(page.request, `/projects/${project.id}/sweeps/${sweeps[0]!.id}?series=true`);
	const natural = await getJson<{ values: (number | null)[] }>(page.request, `/projects/${project.id}/runs/${runId}/series?key=natural_flow`);
	const want = expectedBoard(natural.values, sweep.members);
	const { run } = await getJson<{ run: { model: { cropAreas: { areaM2: number }[] } } }>(page.request, `/projects/${project.id}/runs/${runId}`);
	const plantedHa = run.model.cropAreas.reduce((s, a) => s + a.areaM2, 0) / 10_000;
	expect(plantedHa).toBeGreaterThan(0);

	const levels = board.getByTestId('irr-level');
	await expect(levels).toHaveCount(3);
	await expect(levels.locator('.who strong')).toHaveText(['Today’s irrigation', '15 % less irrigation', '30 % less irrigation']); // clock-free: “Today’s irrigation” names the 100 % level, not a day.
	for (const [i, pct] of [100, 85, 70].entries()) {
		const row = levels.nth(i);
		await expect(row).toHaveAttribute('data-level', String(pct));
		await expect(row).toHaveAttribute('data-kind', want[i]!.kind);
		await expect(row.locator('.count')).toHaveText(`Not met in ${want[i]!.failed} of 9 years`);
		await expect(row.locator('.ha')).toHaveText(`≈ ${new Intl.NumberFormat('en-US', { maximumFractionDigits: plantedHa * (pct / 100) >= 100 ? 0 : 1 }).format(plantedHa * (pct / 100)).replace(/,/g, ' ')} ha`);
		if (want[i]!.threshold !== null) {
			expect(Number(await row.getAttribute('data-threshold-m3'))).toBeCloseTo(want[i]!.threshold!, 0);
			await expect(row.locator('.mark-label')).toHaveText(/^Breaches start at about [\d.]+ million m³$/);
			await expect(row.locator('.marker')).toHaveCount(1);
		} else {
			await expect(row.locator('.marker')).toHaveCount(0);
		}
		// Every year is a mark on the bar, and the sentence carries it in words.
		await expect(row.locator('.yr')).toHaveCount(9);
		await expect(row.locator('.yr.failed')).toHaveCount(want[i]!.failed);
	}
	// The fixture is meant to show a marker somewhere, so the check above means something.
	expect(want.some((w) => w.kind === 'threshold')).toBe(true);
	await expect(board.getByTestId('irr-key')).toContainText(/^Key message\s*At today’s irrigation demand \(≈ [\d .]+ ha planted\), the river’s requirement /); // clock-free: the 100 % level’s name.
	await expect(board.getByText(/recommend/i)).toHaveCount(0);

	// Show the numbers: a row per level.
	await board.getByText('Show the numbers').click();
	await expect(board.getByTestId('irr-table').locator('tbody th')).toHaveText(['Today’s irrigation', '15 % less irrigation', '30 % less irrigation']); // clock-free: the 100 % level’s name.
	await expectNoViolations(page, { include: '[data-testid="irrigation-support"]' });
});

test('a viewer reads a sweep’s board with no Run…; on a phone each level’s name sits over its bar, nothing sideways', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedNineYears(page.request, 'Irrigation support viewer');
	const runId = await createRun(page.request, project.id, 'Base');
	// The sweep the matrix's form starts (outcomes/matrix.ts demandSweepRequest), through the API: the test above starts one from the page.
	const res = await page.request.post(`${API_URL}/projects/${project.id}/sweeps`, {
		data: { name: 'Demand levels 100 % / 85 % / 70 %', baseRunId: runId, members: [100, 85, 70].map((p) => ({ name: `${p} %`, ops: [{ op: 'demand.scale', factor: p / 100 }] })) }
	});
	expect(res.ok()).toBe(true);
	await runJobsTick({ projects: [project.id], schedule: false });

	const viewer = await signIn('Irrigation viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.setViewportSize({ width: 390, height: 844 });
	await viewer.page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const board = viewer.page.getByTestId('irrigation-support');
	await expect(board).toHaveAttribute('data-state', 'complete');
	const levels = board.getByTestId('irr-level');
	await expect(levels).toHaveCount(3);
	await expect(board.getByRole('button', { name: 'Run…' })).toHaveCount(0);
	const who = (await levels.first().locator('.who').boundingBox())!;
	const track = (await levels.first().locator('.track').boundingBox())!;
	expect(track.y).toBeGreaterThan(who.y + who.height - 1);
	await board.getByText('Show the numbers').click();
	await expectNoSidewaysScroll(viewer.page);
	await expectNoViolations(viewer.page, { include: '[data-testid="irrigation-support"]' });
});

test('a viewer with no sweep reads one line saying an editor can run one; an old link lands on the board', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedNineYears(page.request, 'Irrigation support empty');
	const runId = await createRun(page.request, project.id, 'Base');
	const viewer = await signIn('Irrigation empty viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=river&run=${runId}#res-irrigation`);
	const board = viewer.page.getByTestId('irrigation-support');
	await expect(board).toHaveAttribute('data-state', 'empty');
	await expect(board.getByTestId('tool-row')).toContainText('Not run yet: an editor can run a demand sweep.');
	await expect(board.getByRole('button')).toHaveCount(1);
	await expect(board.getByRole('button', { name: 'About Irrigation the catchment supports' })).toBeVisible();
	await expect(viewer.page.locator('#irr-h')).toBeInViewport();
});
