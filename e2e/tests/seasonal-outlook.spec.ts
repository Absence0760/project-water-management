// The seasonal outlook (issue #53 R5, docs/ui.md § Seasonal outlook): an
// editor sets the planning share in Settings (the season stays the default,
// confirmed by the client, issue #90, so nothing is marked pending), starts an outlook on a base run at 100 / 85 /
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
import { acceptInvites, acknowledgeFarmNotice, addMember, createProject, createRun, putModel, putSeries, sampleModel, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { grouped } from '../support/format.ts';
import { runJobsTick } from '../support/jobs.ts';
import { words as siteWords } from '../support/lang.ts';
import { clippedText, expectNoSidewaysScroll } from '../support/reflow.ts';

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

	// Settings: the defaults are confirmed (issue #90), so no pending badge; the project chooses a 55 % planning share and keeps the default season.
	await page.goto(`/projects/${project.id}?tab=settings`);
	const section = page.getByTestId('outlook-settings');
	await expect(section.getByRole('checkbox', { name: 'Use the default season (1 Oct – 30 Apr)' })).toBeChecked();
	// The review date's default, the engine's for that season (1 January, O3, issue #53 R6).
	await expect(section.getByRole('checkbox', { name: 'Use the default review date (1 Jan)' })).toBeChecked();
	await expect(section.getByTestId('season-pending')).toHaveCount(0);
	await expect(section.getByTestId('share-pending')).toHaveCount(0);
	await section.getByRole('checkbox', { name: 'Use the default planning share (80 %)' }).uncheck();
	await section.getByLabel('Planning share (% of analogue years)').fill('55');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByText('Settings saved.')).toBeVisible();
	const saved = await getJson<{ project: { settings: { outlook: unknown } } }>(page.request, `/projects/${project.id}`);
	expect(saved.project.settings.outlook).toEqual({ season: null, planningShare: 0.55, review: null });

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
	await expect(panel.getByTestId('outlook-season-pending')).toHaveCount(0);
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

/**
 * The review triggers (R6) and publishing to farmers (R5, E3). Publishing
 * refuses a season that has ended, so this catchment's record runs up to the
 * current season's decision date: twelve water years to 30 September of the
 * year whose 1 October – 30 April season hasn't ended yet (from the clock of
 * the machine running the spec).
 */
test('the review triggers show for the review date, and a level published to farmers reaches a linked farmer’s page until it is withdrawn', async ({ page, owner, signIn }) => {
	void owner;
	const now = new Date();
	const Y = now.getUTCMonth() >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
	const start = `${Y - 12}-10-01`;
	const days = (Date.parse(`${Y}-10-01T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY;
	const project = await createProject(page.request, 'Outlook to farmers');
	const model = sampleModel();
	await putModel(page.request, project.id, model);
	await updateSettings(page.request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400]
	});
	const rain = syntheticRain(days).map((v, t) => Math.round(v * YEAR_SCALE[Math.floor(t / 365.25) % YEAR_SCALE.length]! * 10) / 10);
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: start, values: rain });
	const runId = await createRun(page.request, project.id, 'Base');
	const made = await page.request.post(`${API_URL}/projects/${project.id}/outlooks`, {
		data: { name: 'This season', baseRunId: runId, levels: [100, 85, 70].map((p) => ({ label: `${p} %`, ops: [{ op: 'demand.scale', factor: p / 100 }] })) }
	});
	expect(made.status()).toBe(202);
	await runJobsTick({ schedule: false });

	type Stat = { p10: number; p50: number; p90: number };
	type Full = {
		outlook: {
			id: string;
			decisionDate: string;
			reviewDate: string;
			result: { nYears: number; levels: { id: string; demandMetByFarm: { nodeId: string; stat: Stat | null }[]; storageByDam: { nodeId: string; capacityM3: number; stat: Stat | null }[] }[] };
			triggers: { reviewDate: string; table: { reviewDate: string; rows: { level: { label: string } | null; metYears: number | null; nYears: number }[] } };
		};
	};
	const { outlooks } = await getJson<{ outlooks: { id: string }[] }>(page.request, `/projects/${project.id}/outlooks`);
	const { outlook } = await getJson<Full>(page.request, `/projects/${project.id}/outlooks/${outlooks[0]!.id}`);
	// The season from the run's newest state, its review date the default (1 January, O3), and the table drawn on the record's latest 1 January.
	expect(outlook).toMatchObject({ decisionDate: `${Y}-10-01`, reviewDate: `${Y + 1}-01-01` });
	expect(outlook.triggers.table.reviewDate).toBe(`${Y}-01-01`);

	await page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	const panel = page.getByTestId('seasonal-outlook');
	await expect(panel).toHaveAttribute('data-state', 'complete');
	const triggers = panel.getByTestId('outlook-triggers');
	await expect(triggers.getByTestId('triggers-review-date')).toHaveText(`1 Jan ${Y + 1}`);
	await expect(triggers.getByTestId('triggers-ran-on')).toHaveText(`1 Jan ${Y}`);
	const rows = outlook.triggers.table.rows;
	await expect(triggers.getByTestId('triggers-table').locator('tbody tr')).toHaveCount(rows.length);
	for (const [i, r] of rows.entries()) {
		const cells = triggers.getByTestId('triggers-table').locator('tbody tr').nth(i).locator('td');
		await expect(cells.nth(0)).toHaveText(r.level?.label ?? 'No level');
		await expect(cells.nth(1)).toHaveText(r.metYears === null ? '–' : `${r.metYears} of ${r.nYears} years`);
	}
	await expect(triggers.getByTestId('triggers-words').locator('li')).toHaveCount(rows.length);
	await expect(triggers.getByText(/recommend|likely|should|best|optimal/i)).toHaveCount(0);

	// Nothing published yet; the editor publishes 85 %.
	const publish = panel.getByTestId('outlook-publish');
	await expect(publish.getByTestId('outlook-not-published')).toHaveText('No outlook is published to farmers.');
	await publish.getByLabel('Level the WUA has set').selectOption({ label: '85 %' });
	await publish.getByRole('button', { name: 'Publish to farmers' }).click();
	await expect(publish.getByTestId('outlook-published')).toContainText('Published to farmers: 85 %');
	await expect(publish.getByTestId('outlook-published')).toHaveAttribute('data-here', 'true');
	await expectNoViolations(page, { include: '[data-testid="seasonal-outlook"]' });

	// A farmer linked to the upper farm, with the run published: the card, in their farm's own figures.
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!;
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	const farmer = await signIn('Outlook farmer');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper.id] } })).status()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);
	await acknowledgeFarmNotice(farmer.page.request);
	await farmer.page.goto(`/farm/${project.id}`);
	const card = farmer.page.getByTestId('farm-outlook');
	await expect(card.getByRole('heading', { name: 'This season' })).toBeVisible();
	const level = outlook.result.levels[1]!;
	const own = level.demandMetByFarm.find((f) => f.nodeId === upper.id)!.stat!;
	const dam = level.storageByDam.find((d) => d.nodeId === upper.id)!;
	const fp = (v: number) => {
		const p = Math.round(v * 100);
		return v <= 0 ? '0 %' : v >= 1 ? '100 %' : p < 1 ? '<1 %' : p > 99 ? '>99 %' : `${p} %`;
	};
	const flat = async (i: number) => (await card.locator('p').nth(i).innerText()).replace(/[\u00a0\u202f]/g, ' ');
	expect(await flat(1)).toBe('Your WUA set irrigation at 85 % for 1 Oct to 30 Apr.');
	expect(await flat(2)).toBe(`In ${outlook.result.nYears} past years’ weather, at this level you got about ${fp(own.p50)} of the water you needed, and between ${fp(own.p10)} and ${fp(own.p90)} in most of them.`);
	const share = (v: number) => fp(v / dam.capacityM3);
	expect(await flat(3)).toBe(`Your dam ended the season about ${share(dam.stat!.p50)} full, and between ${share(dam.stat!.p10)} and ${share(dam.stat!.p90)} in most of those years.`);
	expect(await flat(4)).toBe('Your WUA reviews the level on 1 Jan.');
	await expectNoViolations(farmer.page, { include: '[data-testid="farm-outlook"]' });

	// On a phone in Afrikaans (issue #122): the card in the farmer's language, nothing cut off or scrolling
	// sideways, clean in light and dark, and its help link lands on the words page's entry.
	const af = await siteWords('af');
	await farmer.page.setViewportSize({ width: 360, height: 740 });
	await farmer.page.getByRole('group', { name: 'Language' }).first().getByRole('button', { name: 'Afrikaans' }).click();
	await expect(farmer.page.locator('html')).toHaveAttribute('lang', 'af');
	await expect(card.getByRole('heading', { name: af('This season') })).toBeVisible();
	await expect(card.getByText(af('Season outlook'), { exact: true })).toBeVisible();
	expect(await flat(1)).toContain('85 %');
	expect(await flat(5)).toBe(af('Worked out by the model from past years’ weather: not a forecast, and not a promise. Only a notice from your WUA or from DWS is a restriction.'));
	for (const scheme of ['light', 'dark'] as const) {
		await farmer.page.emulateMedia({ colorScheme: scheme });
		await expectNoSidewaysScroll(farmer.page);
		expect(await clippedText(farmer.page), 'text cut off in its box').toEqual([]);
		await expectNoViolations(farmer.page, { include: '[data-testid="farm-outlook"]' });
	}
	await farmer.page.emulateMedia({ colorScheme: 'light' });
	await card.getByRole('link', { name: af('What is the season outlook?') }).click();
	await expect(farmer.page).toHaveURL(/\/farm\/words#farm-season-outlook$/);
	await expect(farmer.page.locator('#farm-season-outlook')).toBeVisible();
	await farmer.page.goBack();

	// Withdrawn: the farm page drops the card.
	await publish.getByRole('button', { name: 'Withdraw' }).click();
	await expect(publish.getByTestId('outlook-not-published')).toBeVisible();
	await farmer.page.reload();
	await expect(farmer.page.locator('h1')).toHaveText('Upper farm');
	await expect(farmer.page.getByTestId('farm-outlook')).toHaveCount(0);
});

