// The share-the-pain board (issue #53 R3, docs/ui.md § Share the pain) on a
// synthetic catchment: two farms whose orchards are too big for the water, a
// farm with a dam but no crops, a priority town and a non-priority mill, and a
// Reserve that is short every day. The board leads the curtailment panel with
// three cards and three stages per group (today; the equitable share: its
// volume, the change from today and the %; EWR met: the charge, the total
// change and what is left), states the equitable share's % once in its intro
// (it is today's total %, issue #177), shows the same figures as the per-farm
// and other-users tables under it, never a negative demand or supply, lists
// the users on their own rows, keys its supply bands in words, and follows
// the reporting-window picker. The second test is the big case: 30 units.
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

/** A signed change cell without its arrow: "↓−25" → "−25". */
const signed = (cell: string) => cell.replace(/^[↓↑]\s*/, '');

/** A stage cell's "% volume m³/day" split: ['19%', '1 376.8'] (a narrow no-break space in the figure, so split on plain spaces only). */
const stage = (cell: string): [pct: string, volume: string] => {
	const m = /^(\S+%|no demand|—) ([^ ]+) m³\/day/.exec(cell);
	if (!m) throw new Error(`not a stage cell: ${cell}`);
	return [m[1]!, m[2]!];
};

test('the curtailment panel leads with the share-the-pain board: three stages and their cards, the equal share in the intro, bounded, users as their own rows', async ({ page, owner }) => {
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
	const table = board.getByRole('table', { name: /^Share the pain, Project window, 1 Nov 2021 to 31 Dec 2021:/ });
	await expect(table).toBeVisible();
	// The panel still opens on its own heading (the portfolio's "farms short this week" link lands there), the board under it.
	await expect(panel.getByRole('heading').first()).toHaveText('Curtailment targets');
	await expect(panel.getByRole('heading', { name: 'Per hydrological unit' })).toBeVisible();

	// The board, as rendered: its groups and stages in order, the users on their own rows and marked.
	const rows = await rowsOf(table);
	expect(rows.map((r) => r[0])).toEqual([
		'Group',
		'Supplied% of demand, m³/day',
		'Upper farm',
		'Lower farm',
		'Dam only',
		'All hydrological units',
		'Other water users (outside the equitable share)',
		'Town priority, not curtailed',
		'Mill non-priority, curtailed',
		'All other users'
	]);
	// clock-free: “today” here is fixed wording (a stage, a level’s description), not a day from a clock.
	expect(rows[0]).toEqual(['Group', 'Demandm³/day', '1. Today', '2. Equitable share (hydrological units, ex EWR)', '3. EWR met']);
	expect(rows[1]).toEqual([
		'Supplied% of demand, m³/day',
		'Equitable share volumem³/day',
		'Change from todaym³/day',
		'Share% of demand',
		'EWR chargem³/day charged',
		'Total changefrom today, m³/day',
		'Left% of demand, m³/day'
	]);
	const byName = (name: string) => rows.find((r) => r[0]!.startsWith(name))!;
	// No demand, supply or volume left on the board is negative; only a change is signed.
	for (const r of rows.slice(2)) for (const [i, c] of r.entries()) if (![4, 7].includes(i) && !(r.length === 7 && i === 5)) expect(c).not.toMatch(/(^|\s)[-−]\d/);

	// The equal share's % is once in the intro and at stage 2 of every farm with demand: today's total % for the farms.
	const total = byName('All hydrological units');
	const todayPct = stage(total[2]!)[0];
	expect(parseInt(todayPct, 10)).toBeGreaterThan(0);
	expect(parseInt(todayPct, 10)).toBeLessThan(100);
	await expect(board.getByTestId('share-intro')).toContainText(
		`At the equitable share every hydrological unit would get the same ${todayPct} of its demand*: the same water in total as today, shared equally.`
	);
	for (const name of ['Upper farm', 'Lower farm', 'All hydrological units']) expect(byName(name)[5]).toBe(todayPct);
	// Stage 2 moves water between the farms: its total change is 0.
	expect(signed(total[4]!)).toBe('0');
	const cards = board.getByRole('list', { name: 'The three stages, every group' });
	await expect(cards.getByRole('listitem')).toHaveCount(3);
	await expect(cards.getByTestId('stage-today')).toHaveText(todayPct);
	await expect(cards.getByTestId('stage-share')).toHaveText(todayPct);
	await expect(cards.getByTestId('stage-ewr')).toHaveText(stage(total[8]!)[0]);
	await expect(cards.getByTestId('card-deficit')).toContainText(/Short of demand [\d\u202f.]+ m³\/day/);
	await expect(cards.getByTestId('card-share')).toContainText(/Moved between hydrological units [\d\u202f.]+ m³\/day/);
	await expect(cards.getByTestId('card-ewr')).toContainText(/Further cut for the EWR [\d\u202f.]+ m³\/day/);
	// The bands in words, and each bar's band beside its %.
	await expect(board.getByTestId('share-legend')).toHaveText(/95 % of demand or more.*70–95 %.*Under 70 %.*− reduce supply.*\+ below the equitable share/s);
	const band = (p: string) => (parseInt(p, 10) >= 95 ? 'met' : parseInt(p, 10) >= 70 ? 'short' : 'low');
	await expect(table.getByRole('row', { name: /^All hydrological units/ }).locator('[data-band]').first()).toHaveAttribute('data-band', band(todayPct));

	// The farm with no demand: "no demand" at every stage, never a negative demand; its charge is to store less.
	const dry = byName('Dam only');
	expect(dry.slice(1, 3)).toEqual(['0', 'no demand 0 m³/day']);
	expect(dry[5]).toBe('no demand');
	expect(dry[8]).toMatch(/^no demand 0 m³\/day store less \/ pass inflow [\d\u202f.]+ m³\/day$/);

	// Priority town: not curtailed, all it takes is left and its charge stands. Non-priority mill: cut for its charge.
	const townRow = byName('Town');
	expect(townRow).toHaveLength(7);
	expect(townRow[3]).toBe('outside the share');
	expect(stage(townRow[6]!)).toEqual(stage(townRow[2]!));
	expect(signed(townRow[5]!)).toBe('0');
	expect(townRow[6]).toMatch(/not curtailed: its EWR charge of [\d\u202f.]+ m³\/day stands$/);
	const millRow = byName('Mill');
	expect(millRow).toHaveLength(7);

	// The board's figures are the tables' under it: supplied, the equitable share and its change, the total change, volume left and demand left %.
	const farms = panel.getByRole('table', { name: /^Curtailment targets per hydrological unit/ });
	const col = async (header: RegExp) =>
		farms.locator('thead tr').nth(1).locator('th').evaluateAll((ths, src) => ths.findIndex((th) => new RegExp(src).test((th.textContent ?? '').replace(/[ \t\r\n]+/g, ' '))) + 1, header.source);
	const [supplied, target, reduce, totalChange, left, leftPct] = await Promise.all([
		col(/^Supplied\s*m³\/day/),
		col(/^Equitable share volume/),
		col(/^Above \(−\) \/ below \(\+\) equitable share\s*m³\/day/),
		col(/^Total change\s*m³\/day/),
		col(/^Volume left/),
		col(/^Demand left/)
	]);
	for (const name of ['Upper farm', 'Lower farm', 'Dam only']) {
		const b = byName(name);
		const t = await rowOf(farms, name);
		expect(stage(b[2]!)[1]).toBe(t[supplied]);
		expect(b[3]).toBe(t[target]);
		expect(signed(b[4]!)).toBe(t[reduce]);
		expect(signed(b[7]!)).toBe(t[totalChange]);
		expect(stage(b[8]!)[1]).toBe(t[left]);
		expect(stage(b[8]!)[0]).toBe(t[leftPct]);
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
	const week = board.getByRole('table', { name: /^Share the pain, Last 7 days, 22 Jan 2022 to 28 Jan 2022:/ });
	await expect(week).toBeVisible();
	const weekRows = await rowsOf(week);
	expect(weekRows.map((r) => r[0])).toEqual(rows.map((r) => r[0]));
	expect(weekRows).not.toEqual(rows);
	const weekFarm = await rowOf(farms, 'Upper farm');
	expect(stage(weekRows[2]![2]!)[1]).toBe(weekFarm[supplied]);

	// Accessible in both themes and on a phone, with no sideways page scroll.
	await expectNoViolations(page, { include: '#res-curtailment' });
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page, { include: '#res-curtailment' });
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoViolations(page, { include: '#res-curtailment' });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the big case: 30 hydrological units, every one a row, no sideways page scroll on a phone', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Share the pain, 30 units');
	const gauge = project.model.nodes[0] as { id: string };
	const crop = project.model.crops[0] as { id: string };
	const units = Array.from({ length: 30 }, (_, i) => ({
		...project.model.nodes[1]!,
		id: crypto.randomUUID(),
		name: `Unit ${String(i + 1).padStart(2, '0')} with a longer name`,
		downstreamNodeId: gauge.id,
		sortOrder: i + 2,
		damCapacityM3: (i % 4) * 30_000
	}));
	await putModel(page.request, project.id, {
		...project.model,
		nodes: [project.model.nodes[0]!, ...units],
		transfers: [],
		cropAreas: units.map((u, i) => ({ nodeId: u.id, cropId: crop.id, areaM2: 50_000 + (i % 7) * 120_000 }))
	});
	await updateSettings(page.request, project.id, { reportStart: '2021-11-01', reportEnd: '2021-12-31', ewrPragmaticM3PerDay: new Array(12).fill(20_000) });
	const run = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=supply&run=${run}`);
	const board = page.locator('#res-curtailment').getByRole('region', { name: 'Share the pain' });
	const table = board.getByRole('table', { name: /^Share the pain,/ });
	await expect(table.locator('tbody tr[data-node]')).toHaveCount(30);
	// The table scrolls inside its own box at 1440, not the page.
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(table.locator('tbody tr[data-node]').first()).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page, { include: '#res-curtailment' });
});
