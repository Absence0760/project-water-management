// Labels on the app's diagrams (docs/design/ui-playbook.md § 3, "Labels on
// diagrams"): on the Network schematic (the map, the report on screen and on
// paper) and on the help diagrams, no label overlaps another, no line or
// symbol runs through a label, no label is cut by a box's edge, and the
// smallest text is drawn big enough to read. Checked on the three example
// catchments, on an invented 22-node network with four transfers and long
// names, and on every help diagram, at desktop and phone widths.
import type { Page } from '@playwright/test';
import { createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { checkDiagramLabels, waitForMapFit } from '../support/diagrams.ts';
import { resizeTo } from '../support/reflow.ts';
import { DEMO, DROEVLEI, KLEINBERG, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';

/** The schematic's labels: a name and its figure per `g.node`, its rivers and transfers, its node symbols. */
const SCHEMATIC = { group: 'g.node', lines: 'path.river, path.transfer', symbols: 'circle.farm, rect.farm, path.gauge, path.user' };
const SIZES = [
	{ width: 1440, height: 960 },
	{ width: 1280, height: 800 },
	{ width: 390, height: 844 }
];

async function expectCleanSchematic(page: Page, what: string, nth = 0) {
	const r = await checkDiagramLabels(page.locator('svg.schematic').nth(nth), SCHEMATIC);
	expect(r.problems, what).toEqual([]);
	expect(r.labels, what).toBeGreaterThan(0);
	return r;
}

/**
 * An invented catchment of 22 nodes: a mid-catchment weir and the outflow
 * gauge, three tributaries of units with side units, long names that share
 * their first 17 characters, dams on every third unit, and four transfers
 * between far-apart dams (one switched off). No arc between those dams
 * clears every name, so the transfers have to be routed round them.
 */
function bigNetwork() {
	const gauge = { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 };
	const out = node('Outflow gauge at the lower bridge', 'gauge', null, 0, { ...gauge, areaKm2: 5 });
	const mid = node('Middle weir gauge', 'gauge', out.id, 1, { ...gauge, areaKm2: 3 });
	const nodes = [out, mid];
	const words = ['Rooikrans Upper Orchards', 'Blinkwater Citrus', 'Sandvlakte', 'Kliprivier Estate North', 'Doornbos', 'Waterval Lucerne Pivots', 'Klein Kloof', 'Hoekplaas'];
	let k = 2;
	const tributary = (into: string, side: string, n: number) => {
		let down = into;
		for (let i = 0; i < n; i++) {
			const unit = node(`${side} ${words[(k + i) % words.length]} ${k}`, 'farm', down, k++, { areaKm2: 4 + (k % 7) * 3, damCapacityM3: k % 3 === 0 ? 1_250_000 + k * 1000 : 0 });
			nodes.push(unit);
			if (i % 2 === 0) nodes.push(node(`${words[k % words.length]} side ${k}`, 'farm', unit.id, k++, { areaKm2: 6, damCapacityM3: k % 2 ? 90_000 : 0 }));
			down = unit.id;
		}
	};
	tributary(mid.id, 'North', 4);
	tributary(mid.id, 'East', 4);
	tributary(out.id, 'South', 5);
	const dams = nodes.filter((n) => n.damCapacityM3 > 0);
	const pairs: [(typeof nodes)[number], (typeof nodes)[number]][] = [
		[dams[0]!, dams[3]!],
		[dams[1]!, dams[5]!],
		[dams[2]!, dams.at(-1)!],
		[dams[4]!, dams[6]!]
	];
	const transfers = pairs.map(([from, to], i) => ({
		id: crypto.randomUUID(),
		fromNodeId: from.id,
		toNodeId: to.id,
		months: [11, 12, 1, 2],
		maxRateM3s: 0.01,
		dailyCapM3: null,
		minStoragePct: 0.2,
		enabled: i !== 3,
		priority: 0
	}));
	return { nodes, crops: [], cropAreas: [], transfers };
}

test.describe('the example catchments', () => {
	test.describe.configure({ mode: 'serial' });
	test.beforeAll(async ({ playwright }) => {
		test.setTimeout(90_000);
		const api = await playwright.request.newContext();
		await seedExamplesOnce(api);
		await api.dispose();
	});

	test('every label on the map stands clear, at desktop and phone widths, and the top row is never cut off', async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/login');
		await page.getByLabel('Email').fill(DEMO.email);
		await page.getByLabel('Password').fill(DEMO.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
		for (const example of [SANDSPRUIT, KLEINBERG, DROEVLEI]) {
			await page.setViewportSize(SIZES[0]!);
			await page.goto('/');
			await page.locator('table.projects').getByRole('link', { name: example, exact: true }).click();
			await expect(page.getByTestId('project-name').filter({ hasText: example })).toBeVisible();
			// The demo user only views Sandspruit: its model inputs are behind "Show model inputs".
			if (example === SANDSPRUIT) await page.getByLabel('Show model inputs').check();
			const id = /\/projects\/([^/?#]+)/.exec(page.url())![1];
			await page.goto(`/projects/${id}?tab=network`);
			for (const size of SIZES) {
				await page.setViewportSize(size);
				await expect(page.locator('svg.schematic g.node').first()).toBeVisible();
				// Measured only once the map is re-laid out for this width (issue #138).
				await waitForMapFit(page);
				const r = await expectCleanSchematic(page, `${example} at ${size.width}`);
				expect(r.smallestPx, `${example} at ${size.width}`).toBeGreaterThanOrEqual(10.99);
				// Sandspruit is taller than its card at 1440 × 960: it scrolls in the card rather than centring
				// its top row above the card's edge, where nothing could scroll to it.
				const box = (await page.locator('.map-card .scroller').boundingBox())!;
				const top = await page.locator('svg.schematic text.label').evaluateAll((ts) => Math.min(...ts.map((t) => t.getBoundingClientRect().top)));
				expect(top, `${example} at ${size.width}: the top row's names`).toBeGreaterThanOrEqual(box.y);
			}
		}
	});
});

test('a 22-node network with four transfers: labels clear on the map, the report and paper; names distinct; the map refits after a resize', async ({ page, owner }) => {
	void owner;
	test.setTimeout(120_000);
	const model = bigNetwork();
	const project = await createProject(page.request, 'Diagram labels, big network');
	await putModel(page.request, project.id, model);
	await updateSettings(page.request, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(60) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(60) });
	const runId = await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=network`);
	await expect(page.locator('svg.schematic g.node')).toHaveCount(model.nodes.length);
	// No two different names drawn alike: "North Sandvlakte 2" and "… 7" keep their endings.
	const drawn = await page.locator('svg.schematic text.label').allTextContents();
	expect(new Set(drawn).size).toBe(model.nodes.length);
	expect(drawn).toContain('North Sandvlak… 2');
	for (const size of SIZES) {
		await page.setViewportSize(size);
		// Each colouring changes the figure under every name (the width of the labels).
		for (const colourBy of ['supply', 'dam', 'none']) {
			await page.getByLabel('Colour hydrological units by').selectOption(colourBy);
			await waitForMapFit(page);
			await expectCleanSchematic(page, `map at ${size.width}, coloured by ${colourBy}`);
		}
		// The node list: what a node drains into never squeezes its name, and nothing runs past the card.
		const list = page.getByRole('list', { name: 'All hydrological units' });
		// settled: the layout is final after waitForMapFit; whether the list shows depends only on the viewport size.
		if (await list.isVisible()) expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
	}

	// Shrunk on a phone and widened again, the map fills the window once more (it used to keep the phone's height).
	await page.setViewportSize(SIZES[0]!);
	await expect
		.poll(async () => {
			const b = (await page.locator('.map-layout').boundingBox())!;
			return Math.round(SIZES[0]!.height - (b.y + b.height));
		})
		.toBeLessThanOrEqual(40);

	// The report draws it twice: on screen, and in page-high bands for paper.
	await page.goto(`/projects/${project.id}/report?run=${runId}`);
	await expect(page.locator('svg.schematic').first()).toBeVisible();
	await expectCleanSchematic(page, 'report on screen');
	await page.emulateMedia({ media: 'print' });
	const svgs = page.locator('svg.schematic');
	let printed = 0;
	for (let i = 0; i < (await svgs.count()); i++) {
		// settled: emulateMedia has applied the print styles, which alone decide which drawings show.
		if (!(await svgs.nth(i).isVisible())) continue;
		await expectCleanSchematic(page, `report on paper, drawing ${i}`, i);
		printed++;
	}
	expect(printed).toBeGreaterThan(1); // taller than a page: in bands
});

// Every guide with a diagram; together they must show every diagram there is.
const GUIDES = ['the-whole-process', 'build-the-network', 'how-the-model-works', 'a-day-on-a-farm', 'how-gr4j-works', 'how-calibration-works', 'rain-gap-filling'];
const ALL_DIAGRAMS = ['workflow', 'network', 'pipeline', 'farm-day', 'gr4j', 'calibration-loop', 'validation', 'rain-sources'];

test('every help diagram: labels clear of each other, lines and box edges, never drawn smaller than 9.5 px, and whole from 1280 px', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	const seen = new Set<string>();
	for (const guide of GUIDES) {
		await page.goto(`/help/guides/${guide}`);
		await expect(page.locator('figure.diagram').first()).toBeVisible();
		for (const { width, height } of SIZES) {
			await resizeTo(page, { width, height });
			const figures = page.locator('figure.diagram');
			for (let i = 0; i < (await figures.count()); i++) {
				const fig = figures.nth(i);
				const id = (await fig.getAttribute('data-diagram'))!;
				seen.add(id);
				// Sized from the drawing once it is on the page.
				await expect(fig.locator('.scroll')).toHaveAttribute('style', /--diagram-min-w/);
				const r = await checkDiagramLabels(fig.locator('svg'), { boxes: 'rect.box' });
				expect(r.problems, `${id} at ${width}`).toEqual([]);
				expect(r.smallestPx, `${id} at ${width}`).toBeGreaterThanOrEqual(9.49);
				// Every diagram fits the guide's column whole from 1280 px: none scrolls sideways (five did until they
				// were redrawn 660 wide; the text floor above still holds). On a phone they scroll, as they must.
				if (width >= 1280) expect(await fig.locator('.scroll').evaluate((el) => el.scrollWidth - el.clientWidth), `${id} at ${width}`).toBeLessThanOrEqual(0);
			}
		}
	}
	expect([...seen].sort()).toEqual([...ALL_DIAGRAMS].sort());

	// The help picture's numbered markers never sit on one another.
	await page.goto('/help');
	for (const width of [1440, 390]) {
		await resizeTo(page, { width, height: width === 390 ? 844 : 960 });
		const markers = page.locator('.tour .picture').first().locator('.marker');
		await expect(markers.first()).toBeVisible();
		const boxes = await markers.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom })));
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i]!;
				const b = boxes[j]!;
				const overlaps = Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
				expect(overlaps, `markers ${i + 1} and ${j + 1} at ${width}`).toBe(false);
			}
	}
});
