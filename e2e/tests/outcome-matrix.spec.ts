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
// The second test picks the Reserve site: a gauge above the outlet with a
// rule table (the outlet has none, so there the matrix counts days below the
// pragmatic EWR). The gauge's cells are re-counted from each member's stored
// summary (its Reserve months at that gauge), the choice is a project
// setting a viewer sees, and a gauge that loses its table falls back to the
// outlet, saying so.
//
// Synthetic catchment (support/api.ts sampleModel): nine complete water
// years of made-up rain, each year scaled differently so the years differ.
import type { APIRequestContext } from '@playwright/test';
import { addMember, createProject, createRun, putModel, putSeries, sampleModel, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveSettings } from '../support/settings.ts';
import { runJobsTick } from '../support/jobs.ts';
import { ungroup } from '../support/format.ts';

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

async function seedNineYears(request: APIRequestContext, name: string, model = sampleModel()) {
	const project = await createProject(request, name);
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const days = dayIndex('2019-10-01');
	const rain = syntheticRain(days).map((v, t) => Math.round(v * YEAR_SCALE[waterYearOf(t) - 2010]! * 10) / 10);
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain });
	return project;
}

/** The terciles of the base run's water years by annual natural flow, driest first (the matrix's columns). */
function tercilesOf(natural: (number | null)[]) {
	const totals = new Map<number, number>();
	natural.forEach((v, t) => totals.set(waterYearOf(t), (totals.get(waterYearOf(t)) ?? 0) + (v ?? Number.NaN)));
	const ranked = [...totals.entries()].sort((a, b) => a[1] - b[1]).map(([wy]) => wy);
	expect(ranked).toHaveLength(9);
	return [
		{ label: 'Dry', years: ranked.slice(0, 3) },
		{ label: 'Normal', years: ranked.slice(3, 6) },
		{ label: 'Wet', years: ranked.slice(6) }
	];
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
	await expect(section.getByTestId('cutoffs-pending-reserveMonthsMet')).toHaveText('Provisional defaults, not yet confirmed by the catchment’s hydrologist');
	await expect(section.getByTestId('cutoffs-pending-daysBelowEwr')).toHaveText('Provisional defaults, not yet confirmed by the catchment’s hydrologist');
	await section.getByLabel('Water-year classes').selectOption('terciles');
	await saveSettings(page);
	const saved = await getJson<{ project: { settings: { outcomes: unknown } } }>(page.request, `/projects/${project.id}`);
	expect(saved.project.settings.outcomes).toEqual({ yearClassMethod: 'terciles', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null }, siteNodeId: null });

	// River & reserve: no sweep yet, then one, queued until the worker runs it.
	await page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const panel = page.getByTestId('outcome-matrix');
	await expect(panel).toHaveAttribute('data-state', 'empty');
	// Not run: one row until the editor opens the form, focus on the levels (issue #465).
	await expect(panel.getByLabel(/^Demand levels/)).toHaveCount(0);
	await panel.getByRole('button', { name: 'Run…' }).click();
	await expect(panel.getByLabel(/^Demand levels/)).toBeFocused();
	await expect(panel.getByTestId('outcome-empty')).toHaveText('No demand sweep on this run yet.');
	await expect(panel.getByLabel(/^Demand levels/)).toHaveValue('100, 85, 70');
	// The button is in an action row under the levels box and its hint, at the box's left edge (ui-playbook.md, action rows).
	const box = (await panel.getByLabel(/^Demand levels/).boundingBox())!;
	const btn = (await panel.getByRole('button', { name: 'Run demand sweep' }).boundingBox())!;
	expect(btn.y).toBeGreaterThan(box.y + box.height);
	expect(Math.abs(btn.x - box.x)).toBeLessThan(2);
	await panel.getByRole('button', { name: 'Run demand sweep' }).click();
	await expect(panel).toHaveAttribute('data-state', 'pending');
	await expect(panel.getByTestId('sweep-status')).toHaveText('Queued: waiting for the background worker.');
	await runJobsTick({ projects: [project.id], schedule: false });
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
	await expect(panel.getByTestId('cutoffs-pending')).toHaveText('Provisional risk cut-offs, not yet confirmed by the catchment’s hydrologist');

	const table = panel.getByTestId('outcome-table');
	const heads = table.locator('thead th');
	await expect(heads).toHaveCount(4);
	await expect(heads.first()).toHaveText('Demand level');
	await expect(heads.nth(1)).toHaveText(/^Dry ≤ [\d\u202f]+ m³ · 3 years$/);
	await expect(heads.nth(2)).toHaveText(/^Normal [\d\u202f]+ – [\d\u202f]+ m³ · 3 years$/);
	await expect(heads.nth(3)).toHaveText(/^Wet > [\d\u202f]+ m³ · 3 years$/);
	// The bounds are the catchment's own: each falls between the classes' annual totals, and the columns share them.
	const num = ungroup;
	const dryUpper = num((await heads.nth(1).innerText()).match(/≤ ([\d\u202f]+)/)![1]!);
	const [normalLower, normalUpper] = (await heads.nth(2).innerText()).match(/([\d\u202f]+) – ([\d\u202f]+)/)!.slice(1).map(num);
	const wetLower = num((await heads.nth(3).innerText()).match(/> ([\d\u202f]+)/)![1]!);
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
	await saveSettings(page);
	const custom = await getJson<{ project: { settings: { outcomes: unknown } } }>(page.request, `/projects/${project.id}`);
	expect(custom.project.settings.outcomes).toEqual({
		yearClassMethod: 'terciles',
		riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: { lower: 0.15, increasing: 0.4 } },
		siteNodeId: null
	});
	await page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
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
	await viewer.page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const theirs = viewer.page.getByTestId('outcome-matrix');
	await expect(theirs).toHaveAttribute('data-state', 'complete');
	await expect(theirs.getByTestId('outcome-table').locator('tbody th')).toHaveText(['100 %', '85 %', '70 %']);
	await expect(theirs.getByTestId('outcome-table').locator('tbody tr').first().locator('td')).toHaveText(recoloured.rows[0]!.map((c) => c.text));
	await expect(theirs.getByRole('button', { name: /demand sweep/ })).toHaveCount(0);
});

type AssuranceMonth = { waterYear: number; actual: number; met: boolean };
type Assurance = { nodeId: string | null; months: AssuranceMonth[] }[];
type SiteSweepBody = { sweep: { id: string; members: { name: string; status: string; summary: { ewrAssurance?: Assurance } }[] } };

const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
/** A synthetic Reserve rule table at a site asking for `mm3` Mm³ in every month at every point. */
const flatTable = (siteNodeId: string, mm3: number) => ({
	siteNodeId,
	source: 'Synthetic rule table for tests',
	component: 'total',
	unit: 'mcm',
	points: POINTS,
	ewr: Array.from({ length: 12 }, () => POINTS.map(() => mm3)),
	naturalSource: 'run',
	natural: null,
	scale: 1
});

test('the matrix reads the Reserve rule table at a chosen gauge, saved for the project; a gauge that loses its table falls back to the outlet', async ({ page, owner, signIn }) => {
	void owner;
	// The sample catchment with a gauge between the upper farm and the outlet.
	const model = sampleModel();
	const outlet = model.nodes[0]!;
	const gauge = { ...outlet, id: crypto.randomUUID(), name: 'Upper gauge', downstreamNodeId: outlet.id, sortOrder: 4 };
	model.nodes[1]!.downstreamNodeId = gauge.id;
	model.nodes.push(gauge);
	const project = await seedNineYears(page.request, 'Outcome matrix site', model);
	await updateSettings(page.request, project.id, { outcomes: { yearClassMethod: 'terciles' } });

	// A probe run with a table that asks for nothing gives the gauge's monthly flows; the real table asks for their
	// median every month, so wetter years meet more months and the classes differ.
	await updateSettings(page.request, project.id, { ewrRules: [flatTable(gauge.id, 0)] });
	const probeId = await createRun(page.request, project.id, 'Probe');
	const probe = await getJson<{ run: { summary: { ewrAssurance: Assurance } } }>(page.request, `/projects/${project.id}/runs/${probeId}`);
	const flows = probe.run.summary.ewrAssurance
		.find((a) => a.nodeId === gauge.id)!
		.months.map((m) => m.actual)
		.sort((a, b) => a - b);
	expect(flows.length).toBeGreaterThan(100);
	await updateSettings(page.request, project.id, { ewrRules: [flatTable(gauge.id, flows[Math.floor(flows.length / 2)]!)] });
	const runId = await createRun(page.request, project.id, 'Base');

	await page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const panel = page.getByTestId('outcome-matrix');
	await expect(panel).toHaveAttribute('data-state', 'empty');
	await panel.getByRole('button', { name: 'Run…' }).click();
	const site = panel.getByLabel('Reserve site');
	await expect(site.locator('option')).toHaveText(['Outlet (Outflow gauge)', 'Gauge: Upper gauge']);
	await expect(site.locator('option:checked')).toHaveText('Outlet (Outflow gauge)');
	await panel.getByRole('button', { name: 'Run demand sweep' }).click();
	await expect(panel).toHaveAttribute('data-state', 'pending');
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(panel).toHaveAttribute('data-state', 'complete');
	// The outlet has no rule table: days below the pragmatic EWR.
	await expect(panel.getByTestId('outcome-metric')).toHaveText('Measure: Days below the pragmatic EWR at the outlet');

	// The gauge: saved for the project at once.
	const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/projects/${project.id}`));
	await site.selectOption({ label: 'Gauge: Upper gauge' });
	expect((await saved).status()).toBe(200);
	const stored = await getJson<{ project: { settings: { outcomes: { siteNodeId: string | null } } } }>(page.request, `/projects/${project.id}`);
	expect(stored.project.settings.outcomes.siteNodeId).toBe(gauge.id);
	await expect(panel.getByTestId('outcome-metric')).toHaveText('Measure: Reserve months met (the rule table at gauge Upper gauge)');

	// What it should say, counted from the stored sweep: each member's Reserve months at the gauge, by class of year.
	const { sweeps } = await getJson<{ sweeps: { id: string }[] }>(page.request, `/projects/${project.id}/sweeps?baseRunId=${runId}`);
	const { sweep } = await getJson<SiteSweepBody>(page.request, `/projects/${project.id}/sweeps/${sweeps[0]!.id}`);
	const natural = await getJson<{ values: (number | null)[] }>(page.request, `/projects/${project.id}/runs/${runId}/series?key=natural_flow`);
	const classes = tercilesOf(natural.values);
	const want = sweep.members.map((m) => {
		expect(m.status).toBe('done');
		const months = m.summary.ewrAssurance!.find((a) => a.nodeId === gauge.id)!.months;
		return classes.map((c) => {
			const ys = c.years.map((wy) => months.filter((x) => x.waterYear === wy));
			const all = ys.flat();
			const share = all.filter((x) => x.met).length / all.length;
			const full = ys.filter((y) => y.length > 0 && y.every((x) => x.met)).length;
			// The defaults, pending the hydrologist: at least 90 % lower risk, 75 % increasing, else high.
			const risk = share >= 0.9 ? 'lower' : share >= 0.75 ? 'increasing' : 'high';
			const label = { lower: 'Lower risk', increasing: 'Increasing risk', high: 'High risk' }[risk];
			return { risk, text: `${label} Reserve met in every month in ${full} of 3 ${c.label.toLowerCase()} years (${Math.round(share * 100)} % of months met).` };
		});
	});
	// The fixture is built so the matrix isn't one colour: the check below means something.
	expect(new Set(want.flat().map((c) => c.risk)).size).toBeGreaterThan(1);
	const table = panel.getByTestId('outcome-table');
	await expect(table.locator('tbody th')).toHaveText(['100 %', '85 %', '70 %']);
	for (const [i, row] of want.entries()) {
		const cells = table.locator('tbody tr').nth(i).locator('td');
		await expect(cells).toHaveText(row.map((c) => c.text));
		for (const [j, c] of row.entries()) await expect(cells.nth(j)).toHaveAttribute('data-risk', c.risk);
	}
	await expect(panel.getByText(/^Lower risk: at least 90 % of months met\. Increasing risk: at least 75 %\. High risk: below that\./)).toBeVisible();
	await expectNoViolations(page, { include: '[data-testid="outcome-matrix"]' });

	// A viewer reads the same site and matrix, and can't change the site.
	const viewer = await signIn('Outcome site viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const theirs = viewer.page.getByTestId('outcome-matrix');
	await expect(theirs).toHaveAttribute('data-state', 'complete');
	await expect(theirs.getByLabel('Reserve site').locator('option:checked')).toHaveText('Gauge: Upper gauge');
	await expect(theirs.getByLabel('Reserve site')).toBeDisabled();
	await expect(theirs.getByTestId('outcome-metric')).toHaveText('Measure: Reserve months met (the rule table at gauge Upper gauge)');
	await expect(theirs.getByTestId('outcome-table').locator('tbody tr').first().locator('td')).toHaveText(want[0]!.map((c) => c.text));

	// The gauge's table removed: the site stays stored, but the matrix reads the outlet and says why.
	await updateSettings(page.request, project.id, { ewrRules: [] });
	await page.reload();
	await expect(panel).toHaveAttribute('data-state', 'complete');
	await expect(panel.getByLabel('Reserve site')).toHaveCount(0);
	await expect(panel.getByTestId('outcome-site-notice')).toHaveText(
		'The Reserve site chosen for this matrix no longer has a rule table (or is no longer in the network), so the matrix reads the outlet.'
	);
	await expect(panel.getByTestId('outcome-metric')).toHaveText('Measure: Days below the pragmatic EWR at the outlet');
});
