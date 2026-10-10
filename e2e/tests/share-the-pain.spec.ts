// The share-the-pain board (issue #53 R3, docs/ui.md § Share the pain) on a
// synthetic catchment: two farms whose orchards are too big for the water, a
// farm with a dam but no crops, a priority town and a non-priority mill, and a
// Reserve that is short every day. The board leads the curtailment panel with
// two stages per group (today, EWR met) and states the equitable share once,
// in its intro (issue #177: it is today's total %), shows the same
// figures as the per-farm and other-users tables under it, never a negative
// demand, lists the users on their own rows, and follows the reporting-window
// picker.
import type { Locator } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, putModel, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

/** Every row of a table as its cells' text (row header first), whitespace collapsed. */
async function rowsOf(table: Locator): Promise<string[][]> {
	return table.getByRole('row').evaluateAll((trs) =>
		trs.map((tr) => [...tr.querySelectorAll('th, td')].map((c) => (c.textContent ?? '').replace(/[ \t\r\n]+/g, ' ').trim()))
	);
}

/** One row of a table by its row header's start: its cells' text. */
async function rowOf(table: Locator, name: string): Promise<string[]> {
	const hit = (await rowsOf(table)).find((r) => r[0]!.startsWith(name));
	if (!hit) throw new Error(`no row ${name}`);
	return hit;
}

/** A stage cell's "% volume m³/day" split: ['19%', '1 376.8'] (a narrow no-break space in the figure, so split on plain spaces only). */
const stage = (cell: string): [pct: string, volume: string] => {
	const m = /^(\S+%|no demand|—) ([^ ]+) m³\/day/.exec(cell);
	if (!m) throw new Error(`not a stage cell: ${cell}`);
	return [m[1]!, m[2]!];
};

test('the curtailment panel leads with the share-the-pain board: two stages, the equal share in the intro, bounded, users as their own rows', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Share the pain');
	const [gauge, upper, lower] = project.model.nodes as { id: string }[];
	const extra = (name: string, sortOrder: number, over: Record<string, unknown>) => ({
		...project.model.nodes[1]!,
		id: crypto.randomUUID(),
		name,
		downstreamNodeId: gauge!.id,
		sortOrder,
		...over
	});
	// The users take from the river below the farms: the town below the upper farm, the mill below the lower one.
	const user = { kind: 'user', areaKm2: 0, damCapacityM3: 0 };
	const town = extra('Town', 5, { ...user, userDemandM3Day: new Array(12).fill(400), userReturnPct: 0.4, userPriority: 'senior' });
	const mill = extra('Mill', 6, { ...user, userDemandM3Day: new Array(12).fill(150), userReturnPct: 0.1, userPriority: 'junior' });
	await putModel(page.request, project.id, {
		...project.model,
		nodes: [
			gauge!,
			{ ...upper!, downstreamNodeId: town.id },
			{ ...lower!, downstreamNodeId: mill.id },
			// A dam but no crops: no irrigation demand, so the EWR charge it carries is to store less / pass inflow.
			extra('Dam only', 4, { areaKm2: 6, damCapacityM3: 60_000 }),
			town,
			mill
		],
		// Orchards too big for the water: the farms go short and the equal share is well below 100 %.
		cropAreas: project.model.cropAreas.map((c) => ({ ...c, areaM2: c.areaM2 * 10 }))
	});
	// A Reserve high enough to be short every day, so every group carries an EWR charge.
	await updateSettings(page.request, project.id, { reportStart: '2021-11-01', reportEnd: '2021-12-31', ewrPragmaticM3PerDay: new Array(12).fill(1_000_000) });
	const run = await createRun(page.request, project.id, 'Baseline');

	// On Hydrological units since issue #17, with the rest of the curtailment panel.
	await page.goto(`/projects/${project.id}?tab=supply&run=${run}`);
	const panel = page.locator('#res-curtailment');
	const board = panel.getByRole('region', { name: 'Share the pain' });
	const table = board.getByRole('table', { name: /^Share the pain, Project window, 2021-11-01 to 2021-12-31:/ });
	await expect(table).toBeVisible();
	// The panel still opens on its own heading (the portfolio's "farms short this week" link lands there), the board under it.
	await expect(panel.getByRole('heading').first()).toHaveText('Curtailment targets');
	await expect(panel.getByRole('heading', { name: 'Per hydrological unit' })).toBeVisible();

	// The board, as rendered: its groups and stages in order, the users on their own rows and marked.
	const rows = await rowsOf(table);
	expect(rows.map((r) => r[0])).toEqual([
		'Group',
		'Upper farm',
		'Lower farm',
		'Dam only',
		'All hydrological units',
		'Other water users (outside the equitable share)',
		'Town priority, not curtailed',
		'Mill non-priority, curtailed',
		'All other users'
	]);
	expect(rows[0]).toEqual([
		'Group',
		'Demandm³/day',
		'1. Todaysupplied, % of demand',
		'2. EWR metleft after the EWR charge, % of demand'
	]);
	// No figure on the board is negative.
	for (const r of rows) for (const c of r) expect(c).not.toMatch(/(^|\s)[-−]\d/);

	// The equal share is one sentence in the intro, not a stage: its % is today's total for the farms.
	const todayPct = stage(rows[4]![2]!)[0];
	expect(parseInt(todayPct, 10)).toBeGreaterThan(0);
	expect(parseInt(todayPct, 10)).toBeLessThan(100);
	await expect(board.getByTestId('share-intro')).toContainText(
		`At the equitable share every hydrological unit would get the same ${todayPct} of its demand*: the same water in total as today, shared equally.`
	);
	const cards = board.getByRole('list', { name: 'The two stages, all hydrological units' });
	await expect(cards.getByRole('listitem')).toHaveCount(2);
	await expect(cards.getByTestId('stage-today')).toHaveText(todayPct);
	await expect(cards.getByTestId('stage-ewr')).toHaveText(stage(rows[4]![3]!)[0]);

	// The farm with no demand: "no demand" at every stage, never a negative demand; its charge is to store less.
	const dry = rows.find((r) => r[0] === 'Dam only')!;
	expect(dry.slice(1, 3)).toEqual(['0', 'no demand 0 m³/day']);
	expect(dry[3]).toMatch(/^no demand 0 m³\/day store less \/ pass inflow [\d\u202f.]+ m³\/day$/);

	// Priority town: not curtailed, all it takes is left and its charge stands. Non-priority mill: cut for its charge.
	const townRow = rows.find((r) => r[0]!.startsWith('Town'))!;
	expect(townRow).toHaveLength(4);
	expect(stage(townRow[3]!)).toEqual(stage(townRow[2]!));
	expect(townRow[3]).toMatch(/not curtailed: its EWR charge of [\d\u202f.]+ m³\/day stands$/);
	const millRow = rows.find((r) => r[0]!.startsWith('Mill'))!;
	expect(millRow).toHaveLength(4);

	// The board's figures are the tables' under it: supplied, volume left and demand left %.
	const farms = panel.getByRole('table', { name: /^Curtailment targets per hydrological unit/ });
	const col = async (header: RegExp) =>
		farms.locator('thead tr').nth(1).locator('th').evaluateAll((ths, src) => ths.findIndex((th) => new RegExp(src).test((th.textContent ?? '').replace(/[ \t\r\n]+/g, ' '))) + 1, header.source);
	const [supplied, left, leftPct] = await Promise.all([col(/^Supplied\s*m³\/day/), col(/^Volume left/), col(/^Demand left/)]);
	for (const name of ['Upper farm', 'Lower farm', 'Dam only']) {
		const b = rows.find((r) => r[0] === name)!;
		const t = await rowOf(farms, name);
		expect(stage(b[2]!)[1]).toBe(t[supplied]);
		expect(stage(b[3]!)[1]).toBe(t[left]);
		expect(stage(b[3]!)[0]).toBe(t[leftPct]);
	}
	const users = panel.getByRole('table', { name: 'Other water users' });
	expect(stage(townRow[2]!)[1]).toBe((await rowOf(users, 'Town'))[3]);
	expect(stage(millRow[2]!)[1]).toBe((await rowOf(users, 'Mill'))[3]);
	await expect(users.getByRole('row', { name: /^Town/ })).toContainText('Priority (not curtailed)');
	await expect(users.getByRole('row', { name: /^Mill/ })).toContainText('Non-priority (curtailed)');

	// The footnote: the fairness benchmark, never an allocation.
	await expect(board.locator('#share-board-footnote')).toContainText('Fairness benchmark only:');
	await expect(board.locator('#share-board-footnote')).toContainText('Not an allocation or licence condition.');

	// It follows the reporting window: the last 7 days, worked out in the browser.
	await panel.getByLabel('Reporting window').selectOption({ label: 'Last 7 days' });
	const week = board.getByRole('table', { name: /^Share the pain, Last 7 days, 2022-01-22 to 2022-01-28:/ });
	await expect(week).toBeVisible();
	const weekRows = await rowsOf(week);
	expect(weekRows.map((r) => r[0])).toEqual(rows.map((r) => r[0]));
	expect(weekRows).not.toEqual(rows);
	const weekFarm = await rowOf(farms, 'Upper farm');
	expect(stage(weekRows[1]![2]!)[1]).toBe(weekFarm[supplied]);

	// Accessible in both themes and on a phone, with no sideways page scroll.
	await expectNoViolations(page, { include: '#res-curtailment' });
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page, { include: '#res-curtailment' });
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoViolations(page, { include: '#res-curtailment' });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
