// Pins the rendered result of the shared utility classes (`.small`, `.u`, the
// `.seg` segmented control) on the screens that use them most, in light and
// dark and at a desktop and a phone width. Each class was a scoped rule copied
// into dozens of components until issue #9 moved the copies into app.css
// (docs/architecture.md § Shared CSS). A scoped rule carries the component's
// hash class and a global one doesn't, so the move could change which rule
// wins: these are the computed styles the components rendered with their own
// copies, and they must stay so.
import type { Locator, Page } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeTable } from '../support/network.ts';

const COMBOS = [
	{ colorScheme: 'light', width: 1280, height: 900 },
	{ colorScheme: 'dark', width: 1280, height: 900 },
	{ colorScheme: 'light', width: 390, height: 844 },
	{ colorScheme: 'dark', width: 390, height: 844 }
] as const;

// html and body are 14px, so 0.8rem is 11.2px.
const SMALL = '11.2px';

/** Runs `check` once per theme × viewport, on the page as it is (no reload). */
async function eachCombo(page: Page, check: (label: string) => Promise<void>) {
	for (const c of COMBOS) {
		await page.emulateMedia({ colorScheme: c.colorScheme });
		await page.setViewportSize({ width: c.width, height: c.height });
		await check(`${c.colorScheme} ${c.width}px`);
	}
}

/** A design token's colour as the browser computes it in the current theme. */
function token(page: Page, name: string): Promise<string> {
	return page.evaluate((n) => {
		const probe = document.createElement('span');
		probe.style.color = `var(${n})`;
		document.body.append(probe);
		const c = getComputedStyle(probe).color;
		probe.remove();
		return c;
	}, name);
}

function styleOf(loc: Locator, props: string[]): Promise<Record<string, string>> {
	return loc.evaluate((el, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])), props);
}

const TYPE = ['font-size', 'font-weight', 'color'];
const SEG = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'margin-left'];
const radius = (tl: number, tr: number, br: number, bl: number, ml: number) => ({
	'border-top-left-radius': `${tl}px`,
	'border-top-right-radius': `${tr}px`,
	'border-bottom-right-radius': `${br}px`,
	'border-bottom-left-radius': `${bl}px`,
	'margin-left': `${ml}px`
});
// A segmented control's buttons: the outer corners rounded (--radius-sm, 4px), the joins square, each button after the first overlapping its neighbour's border.
const FIRST = radius(4, 0, 0, 4, 0);
const MIDDLE = radius(0, 0, 0, 0, -1);
const LAST = radius(0, 4, 4, 0, -1);

test('Network tab: a small hint, and the node table’s units', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Shared CSS network');
	await page.goto(`/projects/${project.id}?tab=network`);
	const hint = page.getByText('Select a node on the map or in the list to see it here.');
	await expect(hint).toBeVisible();
	await eachCombo(page, async (at) => {
		expect(await styleOf(hint, TYPE), at).toEqual({ 'font-size': SMALL, 'font-weight': '400', color: await token(page, '--text-muted') });
	});

	const table = await openNodeTable(page);
	await eachCombo(page, async (at) => {
		// A column header's unit; on a phone the headers are gone and each node's card labels its
		// fields ("Area km²", node-table.spec.ts), the unit at the label's 0.75rem.
		const phone = at.endsWith(' 390px');
		const unit = table.locator(phone ? 'td .cell-label .u' : 'th .u').filter({ hasText: /^km²$/ }).first();
		await expect(unit, at).toBeVisible();
		expect(await styleOf(unit, TYPE), at).toEqual({ 'font-size': phone ? '10.5px' : SMALL, 'font-weight': '400', color: await token(page, '--text-muted') });
	});
});

test('scenario override mode: the three-button “Part of the model” switch', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Shared CSS override');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const res = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, { data: { name: 'Pins', baseRunId: runId, ops: [] } });
	expect(res.status()).toBe(201);
	const { scenario } = (await res.json()) as { scenario: { id: string } };
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenario.id}`);
	await page.getByRole('button', { name: 'Edit in the model tables' }).click();
	const part = page.getByRole('group', { name: 'Part of the model' });
	await expect(part).toBeVisible();

	await eachCombo(page, async (at) => {
		expect(await styleOf(part, ['display']), at).toEqual({ display: 'inline-flex' });
		expect(await styleOf(part.getByRole('button', { name: 'Network', exact: true }), SEG), at).toEqual(FIRST);
		expect(await styleOf(part.getByRole('button', { name: 'Crops', exact: true }), SEG), at).toEqual(MIDDLE);
		expect(await styleOf(part.getByRole('button', { name: 'Transfers', exact: true }), SEG), at).toEqual(LAST);
	});
});

test('Crops grids: units in the table heads and the small captions', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Shared CSS crops');
	// The crop grids open in the grid modal over the Crops page (issue #17).
	await page.goto(`/projects/${project.id}?tab=crops&grid=planted-areas`);
	const grid = page.getByRole('dialog', { name: 'Planted areas' });
	const caption = grid.getByText('Irrigated area per farm and crop, hectares · rows follow the network order');
	await expect(caption).toBeVisible();
	const unit = grid.locator('thead th .u').filter({ hasText: /^ha$/ }).first();
	await expect(unit).toBeVisible();

	await eachCombo(page, async (at) => {
		const muted = await token(page, '--text-muted');
		expect(await styleOf(caption, TYPE), at).toEqual({ 'font-size': SMALL, 'font-weight': '400', color: muted });
		expect(await styleOf(unit, TYPE), at).toEqual({ 'font-size': SMALL, 'font-weight': '400', color: muted });
	});
});

test('Runs tab: the flow-unit switch and a small link; Units & supply: units in a table head', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Shared CSS runs');
	await createRun(page.request, project.id, 'Baseline');
	// Two runs, so the Runs list offers "Compare runs".
	const runId = await createRun(page.request, project.id, 'Second');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	const units = page.getByRole('group', { name: 'Flow units' }).first();
	await expect(units).toBeVisible();
	// The Runs list's own link (a.small), not the tab bar's Compare tab.
	const compare = page.locator('a.small').filter({ hasText: 'Compare runs' });
	await expect(compare).toBeVisible();
	// RunInputsPanel had `class="muted small"` but no rule for .small until it became global: it now renders small like every other hint.
	const restoreHint = page.getByText(/^Puts back the settings and model this run used/);
	await expect(restoreHint).toBeVisible();

	await eachCombo(page, async (at) => {
		expect(await styleOf(restoreHint, TYPE), at).toEqual({ 'font-size': SMALL, 'font-weight': '400', color: await token(page, '--text-muted') });
		expect(await styleOf(units.getByRole('button', { name: 'm³/s' }), SEG), at).toEqual(FIRST);
		expect(await styleOf(units.getByRole('button', { name: 'm³/day' }), SEG), at).toEqual(LAST);
		expect(await styleOf(compare, ['font-size', 'color']), at).toEqual({ 'font-size': SMALL, color: await token(page, '--accent') });
	});

	// The unit results table (and its "% of demand" head) moved from Runs & results to Units & supply.
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto(`/projects/${project.id}?tab=supply&run=${runId}`);
	const unit = page.locator('th .u').filter({ hasText: /^% of demand$/ }).first();
	await expect(unit).toBeVisible();
	await eachCombo(page, async (at) => {
		expect(await styleOf(unit, TYPE), at).toEqual({ 'font-size': SMALL, 'font-weight': '400', color: await token(page, '--text-muted') });
	});
});

test('the report: units and small notes, on screen and in print', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Shared CSS report');
	const runId = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}/report?run=${runId}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	const unit = page.locator('th .u').filter({ hasText: /^Mm³$/ }).first();
	const note = page.getByText(/^Ratings from Moriasi et al\. \(2007\)/);
	await expect(unit).toBeVisible();
	await expect(note).toBeVisible();

	await eachCombo(page, async (at) => {
		const muted = await token(page, '--text-muted');
		expect(await styleOf(unit, TYPE), at).toEqual({ 'font-size': SMALL, 'font-weight': '400', color: muted });
		expect(await styleOf(note, ['font-size']), at).toEqual({ 'font-size': SMALL });
	});

	// Print sets its own root size (the report's print styles), so .small is 0.8 of that; the unit takes its th's size.
	await page.emulateMedia({ media: 'print', colorScheme: 'light' });
	const rootPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
	expect(await styleOf(unit, ['font-weight', 'color']), 'print').toEqual({ 'font-weight': '400', color: await token(page, '--text-muted') });
	expect(parseFloat((await styleOf(note, ['font-size']))['font-size'] ?? ''), 'print').toBeCloseTo(0.8 * rootPx, 2);
});
