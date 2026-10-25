// Runs & results' layout as it stands before issue #586 splits it (docs/ui.md
// § Runs & results; runs/sections.ts): the panels in page order under their
// group headings, the side index's groups and entries, every #res-* anchor
// landing on its panel's heading, the run picker (?run=, the default, Back and
// Forward), and the anchors movedHref sends to EWR and Hydrological units.
// Later rounds move Model quality to a Calibration page; these pins make each
// move a deliberate edit here rather than a silent loss. runs-page.spec.ts
// covers the page's layout and a11y, runs.spec.ts the results themselves.
// Names and numbers are invented.
import type { APIRequestContext, Page } from '@playwright/test';
import { createRun, node, putModel, putSeries, seedRunnableProject, syntheticFlow, updateSettings } from '../support/api.ts';
import { plantUnitRainSummary } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openRuns, runsList } from '../support/runs.ts';

const VIEW = { width: 1440, height: 960 };

/**
 * seedRunnableProject with every optional Model quality panel: a gauge inside the network with its own
 * record that the run doesn't score (Flow at gauges, issue #554), a WR2012 reference (an invented
 * quaternary), forecast rain past the record and a forecast run (WP-2.12), and a planted
 * summary.unitRain (Rain for each unit, issue #482; as unit-rain.spec.ts plants it).
 */
async function seedEveryPanel(request: APIRequestContext, name: string): Promise<{ id: string; runId: string }> {
	const project = await seedRunnableProject(request, name);
	const [outlet, upper, lower] = project.model.nodes as { id: string; downstreamNodeId: string | null }[];
	const weir = node('Upper weir', 'gauge', outlet!.id, 4, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	upper!.downstreamNodeId = weir.id;
	await putModel(request, project.id, { ...project.model, nodes: [...project.model.nodes, weir] });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: 'Upper weir record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120) });
	const list = (await (await request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	const record = list.find((s) => s.name === 'Upper weir record')!.id;
	expect((await request.patch(`${API_URL}/projects/${project.id}/series/${record}`, { data: { siteNodeId: weir.id } })).status()).toBe(200);
	await updateSettings(request, project.id, {
		wr2012: { reference: { quaternary: 'Z99A', areaKm2: 60, marMm3: 6, monthlyMm3: new Array(12).fill(0.5), periodStart: 1990, periodEnd: 2025, mapMm: null, source: 'Synthetic' } }
	});
	// seedRunnableProject records rain 2021-10-01 … 2022-01-28; the forecast follows it.
	await putSeries(request, project.id, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2022-01-29', values: Array.from({ length: 14 }, (_, i) => (i % 4 === 0 ? 9 : 0)) });
	const res = await request.post(`${API_URL}/projects/${project.id}/runs`, { data: { label: 'Every panel', forecast: true } });
	expect(res.status(), await res.text()).toBe(201);
	const runId = ((await res.json()) as { run: { id: string } }).run.id;
	const days = { unitGauge: 0, gaugeMap: 0, unitChirps: 0, catchment: 0, forecast: 0, none: 0 };
	const unit = { areaKm2: 12, gaugeMapClamped: false, chirps: null, petMm: 1200, exchangeMm: 0, storageStartMm: 0, storageEndMm: 0 };
	await plantUnitRainSummary(runId, {
		mode: 'perUnit',
		gaugeMapMm: 640,
		gaugeMapSource: 'a synthetic gauge record',
		mapPeriod: { start: '1991-01-01', end: '2020-12-31' },
		units: [
			{ ...unit, nodeId: upper!.id, name: 'Upper farm', mapMm: 800, mapSource: 'a synthetic MAP grid', rule: 'gaugeMap', rainKey: 'rain_catchment_mm', factor: 1.25, factorSource: 'gaugeMap', gaugeMapFactor: 1.25, gaugeMapOwnFactor: 1.25, days: { ...days, gaugeMap: 120 }, rainMm: 900, aetMm: 700, flowMm: 150, runoffM3: 1_800_000, runoffCoefficient: 0.167 },
			{ ...unit, nodeId: lower!.id, name: 'Lower farm', areaKm2: 8, mapMm: null, mapSource: null, rule: 'catchment', rainKey: null, factor: null, factorSource: 'catchment', gaugeMapFactor: null, gaugeMapOwnFactor: null, days: { ...days, catchment: 120 }, rainMm: 700, aetMm: 600, flowMm: 90, runoffM3: 720_000, runoffCoefficient: 0.129 }
		]
	});
	return { id: project.id, runId };
}

/** The page's group headings and #res-* panels in DOM order: `## group`, then `id: its first heading`. */
const panelOrder = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('.detail h2.group-h, .detail [id^="res-"]:not(#res-h)')].map((el) =>
			el.matches('h2') ? `## ${el.textContent!.trim()}` : `${el.id}: ${el.querySelector('h2, h3, h4')?.textContent?.trim() ?? ''}`
		)
	);

/** The side index (the rail at 1440 px): `## group`, then `link text → href` (the run's id written RUN). */
const railEntries = (page: Page, runId: string) =>
	page.getByRole('navigation', { name: 'Result sections' }).evaluate(
		(nav, id) => [...nav.querySelectorAll('p.rail-h, a')].map((el) => (el.matches('p') ? `## ${el.textContent!.trim()}` : `${el.textContent!.trim()} → ${el.getAttribute('href')!.replaceAll(id, 'RUN')}`)),
		runId
	);

/** Opens the run and waits for the groups below the flow charts, which render after the hydrograph (RunCharts). */
async function openAll(page: Page, projectId: string, runId: string) {
	await openRuns(page, projectId, `&run=${runId}`);
	await expect(page.locator('#res-explore')).toBeAttached();
}

/** The panel's top within the window once the anchor's scroll has settled (the last panels, at the page's end, sit lower). */
const expectTopInView = (panel: ReturnType<Page['locator']>, message: string) =>
	expect.poll(async () => { const y = (await panel.boundingBox())!.y; return y >= 0 && y < VIEW.height; }, { message }).toBe(true);

const RECORD_AND_DEEPER = [
	'## Record',
	'res-notes: Run notes',
	'res-evidence: Evidence',
	'res-reproduce: Reproduction',
	'res-validation: Validation statement',
	'res-publication: Publication',
	'## Dig deeper',
	'res-checks: Self-checks',
	'res-explore: Explore any output'
];

const RAIL_RECORD_AND_AFTER = [
	'## Record',
	'Run notes → #res-notes',
	'Evidence → #res-evidence',
	'Reproduction → #res-reproduce',
	'Validation statement → #res-validation',
	'Publication → #res-publication',
	'## Dig deeper',
	'Self-checks → #res-checks',
	'Explore any output → #res-explore',
	'## On EWR',
	'Reserve rules met, by month↗ → ?tab=river&run=RUN#res-reserve',
	'Days below the EWR, by month↗ → ?tab=river&run=RUN#res-ewr-grid',
	'Water account↗ → ?tab=river&run=RUN#res-water-account',
	'## On Hydrological units',
	'Curtailment targets↗ → ?tab=supply&run=RUN#res-curtailment',
	'Assurance of supply↗ → ?tab=supply&run=RUN#res-assurance'
];

test('a plain run: its panels in page order under Model quality, Record and Dig deeper, and the side index lists them so', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize(VIEW);
	const project = await seedRunnableProject(page.request, 'Pins plain');
	const runId = await createRun(page.request, project.id, 'Plain');
	await openAll(page, project.id, runId);

	expect(await panelOrder(page)).toEqual([
		// The opening group has no heading: the run summary (its first heading is the Catchment card's).
		'res-summary: Summary',
		'## Model quality',
		'res-hydrograph: Hydrograph',
		'res-fdc: Flow-duration curve',
		'res-calibration: Calibration against observed flow',
		'res-water-balance: Water balance by water year',
		'res-runoff: Runoff model: GR4J',
		'res-ewr-agreement: EWR test: model against observed flow',
		'res-plausibility: Plausibility checks',
		...RECORD_AND_DEEPER
	]);
	expect(await railEntries(page, runId)).toEqual([
		'Summary → #res-summary',
		'## Model quality',
		'Hydrograph → #res-hydrograph',
		'Flow-duration curve → #res-fdc',
		'Calibration against observed flow → #res-calibration',
		'Water balance by water year → #res-water-balance',
		'Runoff model: GR4J → #res-runoff',
		'EWR test: model against observed flow → #res-ewr-agreement',
		'Plausibility checks → #res-plausibility',
		...RAIL_RECORD_AND_AFTER
	]);
	// The other pages' entries name their page to a screen reader.
	const rail = page.getByRole('navigation', { name: 'Result sections' });
	await expect(rail.getByRole('link', { name: 'Water account, on EWR', exact: true })).toBeVisible();
	await expect(rail.getByRole('link', { name: 'Assurance of supply, on Hydrological units', exact: true })).toBeVisible();
});

test('a run with every optional panel: Forecast beside the Summary, and checks-only gauges, unit rain and WR2012 in Model quality', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize(VIEW);
	const { id, runId } = await seedEveryPanel(page.request, 'Pins every panel');
	await openAll(page, id, runId);

	expect(await panelOrder(page)).toEqual([
		'res-summary: Summary',
		'res-forecast: Forecast',
		'## Model quality',
		'res-hydrograph: Hydrograph',
		'res-fdc: Flow-duration curve',
		'res-gauges: Flow at gauges in the network (checks only)',
		'res-calibration: Calibration against observed flow',
		'res-water-balance: Water balance by water year',
		'res-runoff: Runoff model: GR4J',
		'res-unit-rain: Rain for each unit',
		'res-wr2012: WR2012 check: Z99A',
		'res-ewr-agreement: EWR test: model against observed flow',
		'res-plausibility: Plausibility checks',
		...RECORD_AND_DEEPER
	]);
	expect(await railEntries(page, runId)).toEqual([
		'Summary → #res-summary',
		'Forecast → #res-forecast',
		'## Model quality',
		'Hydrograph → #res-hydrograph',
		'Flow-duration curve → #res-fdc',
		'Flow at gauges in the network (checks only) → #res-gauges',
		'Calibration against observed flow → #res-calibration',
		'Water balance by water year → #res-water-balance',
		'Runoff model: GR4J → #res-runoff',
		'Rain for each unit → #res-unit-rain',
		'WR2012 check: Z99A → #res-wr2012',
		'EWR test: model against observed flow → #res-ewr-agreement',
		'Plausibility checks → #res-plausibility',
		...RAIL_RECORD_AND_AFTER
	]);

	// Beside the results: the runs rail on the left, the run form (with Run forecast) in the section header.
	const rail = page.getByRole('region', { name: 'Runs & results' }).getByRole('complementary');
	await expect(rail.getByRole('region', { name: 'Runs', exact: true })).toBeVisible();
	const railBox = (await rail.boundingBox())!;
	expect((await page.locator('#res-h').boundingBox())!.x).toBeGreaterThan(railBox.x + railBox.width);
	const header = page.getByTestId('section-header');
	await expect(header.getByLabel(/^Run label/)).toBeVisible();
	await expect(header.getByRole('button', { name: 'Run forecast' })).toBeVisible();
	await expect(header.getByRole('button', { name: 'Run model' })).toBeVisible();
});

test('every #res-* anchor on the page lands on its panel, in view, with the focus on its heading', async ({ page, owner }) => {
	void owner;
	test.setTimeout(120_000); // twenty-one fresh page loads
	await page.setViewportSize(VIEW);
	const { id, runId } = await seedEveryPanel(page.request, 'Pins anchors');
	// Each anchor and the heading it lands on (the panel's first h2–h4; #res-h is the run's own heading).
	const anchors: [string, string][] = [
		['res-h', 'Every panel'],
		['res-summary', 'Summary'],
		['res-forecast', 'Forecast'],
		['res-hydrograph', 'Hydrograph'],
		['res-fdc', 'Flow-duration curve'],
		['res-gauges', 'Flow at gauges in the network (checks only)'],
		['res-calibration', 'Calibration against observed flow'],
		['res-water-balance', 'Water balance by water year'],
		['res-runoff', 'Runoff model: GR4J'],
		['res-unit-rain', 'Rain for each unit'],
		['res-wr2012', 'WR2012 check: Z99A'],
		['res-ewr-agreement', 'EWR test: model against observed flow'],
		['res-plausibility', 'Plausibility checks'],
		['res-notes', 'Run notes'],
		['res-evidence', 'Evidence'],
		['res-reproduce', 'Reproduction'],
		['res-validation', 'Validation statement'],
		['res-publication', 'Publication'],
		['res-checks', 'Self-checks'],
		['res-explore', 'Explore any output']
	];
	// The pins cover every #res-* id the page renders.
	await openAll(page, id, runId);
	expect(await page.evaluate(() => [...document.querySelectorAll('[id^="res-"]')].map((e) => e.id))).toEqual(anchors.map(([a]) => a));

	for (const [anchor, heading] of anchors) {
		// From another tab, so each is a fresh load and RunsTab's fragment handling runs.
		await page.goto(`/projects/${id}?tab=overview`);
		await page.goto(`/projects/${id}?tab=runs&run=${runId}#${anchor}`);
		await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${runId}#${anchor}$`));
		const panel = page.locator(`#${anchor}`);
		const h = anchor === 'res-h' ? panel : panel.locator('h2, h3, h4').first();
		await expect(h, anchor).toHaveText(heading);
		if (anchor === 'res-hydrograph' || anchor === 'res-fdc') {
			// Shown, word for word the side index's, so the focus ring the link puts on it can be seen (issue #586:
			// both were visually hidden, which Playwright's toBeVisible still passes).
			expect(await h.evaluate((e) => !e.closest('.visually-hidden') && e.getBoundingClientRect().width > 1), anchor).toBe(true);
		}
		// Lazy panels (Forecast, Rain for each unit, WR2012) included: the page waits for the panel, then its heading (issue #586).
		await expect(h, anchor).toBeFocused();
		await expectTopInView(panel, anchor);
	}
});

test('a link to a panel this run doesn’t have says what the panel needs, with the focus on it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize(VIEW);
	const project = await seedRunnableProject(page.request, 'Pins missing panels');
	const runId = await createRun(page.request, project.id, 'Plain');
	// A plain run has no WR2012 check, no checks-only gauge, no forecast and no rain for each unit (issue #586).
	for (const [anchor, needs, href] of [
		['res-wr2012', 'It needs a WR2012 reference for the catchment', '?tab=settings#set-wr2012'],
		['res-gauges', 'It needs a flow record at a gauge that is not the calibration site', '?tab=series'],
		['res-forecast', 'A forecast run needs forecast rain', '?tab=settings#set-feeds'],
		['res-unit-rain', 'It needs Per unit flow generation', '?tab=settings#set-share']
	] as const) {
		await page.goto(`/projects/${project.id}?tab=overview`);
		await page.goto(`/projects/${project.id}?tab=runs&run=${runId}#${anchor}`);
		const line = page.getByTestId('missing-panel');
		await expect(line, anchor).toContainText(needs);
		await expect(line, anchor).toHaveAttribute('data-for', anchor);
		await expect(line.getByRole('link'), anchor).toHaveAttribute('href', href);
		await expect(line, anchor).toBeFocused();
		await expect(line, anchor).toBeInViewport();
	}
	// Another run picked: the line was about the linked run, and goes.
	const other = await createRun(page.request, project.id, 'Another');
	await page.goto(`/projects/${project.id}?tab=overview`);
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}#res-wr2012`);
	await expect(page.getByTestId('missing-panel')).toBeVisible();
	await runsList(page).getByRole('button', { name: /^Another/ }).click();
	await expect(page).toHaveURL(new RegExp(`run=${other}`));
	await expect(page.getByTestId('missing-panel')).toHaveCount(0);
});

test('following a side-index link puts the focus on its panel’s heading, again when it is the fragment already', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize(VIEW);
	const project = await seedRunnableProject(page.request, 'Pins index focus');
	const runId = await createRun(page.request, project.id, 'Plain');
	await openAll(page, project.id, runId);
	const rail = page.getByRole('navigation', { name: 'Result sections' });
	for (const [name, anchor] of [
		['Calibration against observed flow', 'res-calibration'],
		['Publication', 'res-publication'],
		['Explore any output', 'res-explore']
	] as const) {
		await rail.getByRole('link', { name, exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`#${anchor}$`));
		const h = page.locator(`#${anchor}`).locator('h2, h3, h4').first();
		await expect(h, anchor).toBeFocused();
		await expect(h, anchor).toBeInViewport();
	}
	// The same link again (no hashchange): the heading still takes the focus.
	await rail.getByRole('link', { name: 'Explore any output', exact: true }).click();
	await expect(page.locator('#res-explore').locator('h2, h3, h4').first()).toBeFocused();
});

test('the sidebar keeps a picked run: Runs → Settings → Runs and Runs → EWR stay on it, and the new page’s title has the focus', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize(VIEW);
	const project = await seedRunnableProject(page.request, 'Pins sidebar run');
	const older = await createRun(page.request, project.id, 'Older');
	const newest = await createRun(page.request, project.id, 'Newest');
	const sidebar = page.getByRole('navigation', { name: 'Project sections' });
	const title = (name: string) => page.getByRole('heading', { level: 1, name, exact: true });

	await openRuns(page, project.id, `&run=${older}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Older', exact: true })).toBeVisible();
	await sidebar.getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(page).toHaveURL(/\?tab=settings$/);
	await expect(title('Settings & calibration')).toBeFocused();
	await sidebar.getByRole('link', { name: 'Runs & results', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${older}$`));
	await expect(page.getByRole('heading', { level: 2, name: 'Older', exact: true })).toBeVisible();
	await expect(title('Runs & results')).toBeFocused();

	await sidebar.getByRole('link', { name: 'EWR', exact: true }).press('Enter');
	await expect(page).toHaveURL(new RegExp(`\\?tab=river&run=${older}$`));
	await expect(title('EWR')).toBeFocused();

	// Back on the newest (the default), the links carry no run: a run made since still opens first.
	await page.goto(`/projects/${project.id}?tab=runs&run=${newest}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Newest', exact: true })).toBeVisible();
	await expect(sidebar.getByRole('link', { name: 'EWR', exact: true })).toHaveAttribute('href', '?tab=river');
});

test('the run picker: the newest by default, ?run= picks one, a pick is a step Back and Forward retrace', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize(VIEW);
	const project = await seedRunnableProject(page.request, 'Pins picker');
	const oldest = await createRun(page.request, project.id, 'Oldest');
	const middle = await createRun(page.request, project.id, 'Middle');
	const newest = await createRun(page.request, project.id, 'Newest');
	const shown = (label: string) => expect(page.getByRole('heading', { level: 2, name: label, exact: true })).toBeVisible();
	const current = (label: string) => expect(runsList(page).getByRole('button', { name: new RegExp(`^${label}`) })).toHaveAttribute('aria-current', 'true');

	// No ?run=: the newest, written into the URL in place, so Back skips the default.
	await page.goto(`/projects/${project.id}?tab=overview`);
	await openRuns(page, project.id);
	await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${newest}$`));
	await shown('Newest');
	await current('Newest');
	await expect(runsList(page).getByRole('button', { name: /^Newest/ })).toContainText('latest');
	await expect(runsList(page).locator('[aria-current="true"]')).toHaveCount(1);
	await page.goBack();
	await expect(page).toHaveURL(/\?tab=overview$/);

	// ?run= picks that run; the header offers the way back to the latest.
	await openRuns(page, project.id, `&run=${oldest}`);
	await shown('Oldest');
	await current('Oldest');
	await expect(page.getByRole('button', { name: 'go to latest' })).toBeVisible();

	// A pick in the list, and go to latest, are each a new history entry.
	await runsList(page).getByRole('button', { name: /^Middle/ }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${middle}$`));
	await shown('Middle');
	await current('Middle');
	await page.getByRole('button', { name: 'go to latest' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${newest}$`));
	await shown('Newest');
	await expect(page.getByRole('button', { name: 'go to latest' })).toHaveCount(0);

	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${middle}$`));
	await shown('Middle');
	await current('Middle');
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${oldest}$`));
	await shown('Oldest');
	await current('Oldest');
	await page.goForward();
	await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${middle}$`));
	await shown('Middle');
	await current('Middle');
});

test('each anchor movedHref sends on lands on its new home’s panel heading, for the same run, Back skipping the old address', async ({ page, owner }) => {
	void owner;
	test.setTimeout(120_000); // nineteen forwarded loads and their Backs
	await page.setViewportSize(VIEW);
	const project = await seedRunnableProject(page.request, 'Pins moved');
	const runId = await createRun(page.request, project.id, 'Moved');
	// The forwarded anchors, from the source (runs/sections.ts movedHref reads these lists).
	const base = new URL('../../frontend/src/lib/components/', import.meta.url);
	const river = (await import(new URL('river/links.ts', base).href)) as { RIVER_ANCHORS: readonly string[]; RIVER_STRIP_ANCHOR: string };
	const supply = (await import(new URL('supply/links.ts', base).href)) as { SUPPLY_ANCHORS: readonly string[] };
	// Where each lands: the heading there, or null for a panel this project's run doesn't have (a drought
	// restriction rule's tables, the other uses of water), where only the forwarding is pinned.
	const landing: Record<string, string | null> = {
		'res-ewr': 'Flow vs reserve',
		'res-reserve-years': 'Days below the reserve, each water year',
		'res-reserve': 'Reserve rules met, by month',
		'res-ewr-grid': 'Days below the EWR, by month',
		'res-water-account': 'Water account',
		'res-uncertainty': 'Uncertainty bands',
		'res-sensitivity': 'Sensitivity runs',
		'res-outcomes': 'Outcome matrix',
		'res-outlook': 'Seasonal outlook',
		'res-reserve-strip': 'Days below the reserve',
		'res-farm': 'Hydrological unit detail: Lower farm',
		'res-farms': 'Hydrological unit results',
		'res-curtailment': 'Curtailment targets',
		'res-assurance': 'Assurance of supply',
		'res-restrictions': null,
		'res-other-uses': null
	};
	const riverAnchors = [...river.RIVER_ANCHORS, river.RIVER_STRIP_ANCHOR];
	// A new forwarded anchor needs its landing pinned here.
	expect([...riverAnchors, ...supply.SUPPLY_ANCHORS].sort()).toEqual(Object.keys(landing).sort());

	type Case = { from: string; query?: string; to: RegExp; anchor: string | null };
	const cases: Case[] = [
		// The link rows those groups left here: the page itself, for the same run.
		{ from: 'res-river', to: new RegExp(`\\?tab=river&run=${runId}$`), anchor: null },
		{ from: 'res-units', to: new RegExp(`\\?tab=supply&run=${runId}$`), anchor: null },
		...riverAnchors.map((a) => ({ from: a, to: new RegExp(`\\?tab=river&run=${runId}#${a}$`), anchor: a })),
		...supply.SUPPLY_ANCHORS.map((a) => ({ from: a, to: new RegExp(`\\?tab=supply&run=${runId}#${a}$`), anchor: a })),
		// The curtailment's reporting window goes with it.
		{ from: 'res-curtailment', query: '&window=last7', to: new RegExp(`\\?tab=supply&run=${runId}&window=last7#res-curtailment$`), anchor: 'res-curtailment' }
	];
	for (const c of cases) {
		await page.goto(`/projects/${project.id}?tab=overview`);
		await page.goto(`/projects/${project.id}?tab=runs&run=${runId}${c.query ?? ''}#${c.from}`);
		await expect(page, c.from).toHaveURL(c.to);
		const heading = c.anchor ? landing[c.anchor] : null;
		if (c.anchor && heading) {
			const panel = page.locator(`#${c.anchor}`);
			const h = panel.locator('h2, h3, h4').first();
			await expect(h, c.from).toHaveText(heading);
			await expect(h, c.from).toBeFocused();
			await expectTopInView(panel, c.from);
		} else if (c.anchor) {
			// Forwarded, but this run has no such panel: the page shows the run without it.
			await expect(page.getByTestId('supply-summary'), c.from).toContainText('run “Moved”');
			await expect(page.locator(`#${c.anchor}`)).toHaveCount(0);
		} else if (c.from === 'res-river') {
			await expect(page.getByTestId('river-context')).toContainText('Moved');
		} else {
			await expect(page.getByTestId('supply-summary')).toContainText('run “Moved”');
		}
		// The forwarding replaced the Runs & results entry: Back returns to where the link was followed from.
		await page.goBack();
		await expect(page, c.from).toHaveURL(/\?tab=overview$/);
	}
});
