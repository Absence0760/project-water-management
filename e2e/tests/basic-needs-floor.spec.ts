// The basic-needs floor in the curtailment report (engine 1.44.0, issue #123,
// docs/model.md §2.7f and §2.11): a unit with a village of 20 000 people
// (25 l a person a day = 500 m³/day) under a Reserve that is short every
// day, so its EWR supply cut goes beyond its equitable share. The volume
// left never goes below the floor, and the curtailment table and the
// share-the-pain board say how much of the cut the floor keeps.
import type { Locator } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, putModel, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

/** Every row of a table as its cells' text (row header first), whitespace collapsed. */
async function rowsOf(table: Locator): Promise<string[][]> {
	return table.getByRole('row').evaluateAll((trs) =>
		trs.map((tr) => [...tr.querySelectorAll('th, td')].map((c) => (c.textContent ?? '').replace(/[ \t\r\n]+/g, ' ').trim()))
	);
}

/** A volume as the tables show it: at most one decimal, thousands with a narrow no-break space. */
const vol = (v: number) => {
	const r = Math.round(v * 10) / 10;
	return (Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};

test('the curtailment table and the board show what the basic-needs floor keeps of a unit’s cut', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Basic-needs floor');
	const upper = project.model.nodes[1] as { id: string };
	await putModel(page.request, project.id, {
		...project.model,
		// Orchards too big for the water, as in the share-the-pain spec.
		cropAreas: project.model.cropAreas.map((c) => ({ ...c, areaM2: c.areaM2 * 10 })),
		demandObjects: [
			{
				id: crypto.randomUUID(),
				nodeId: upper.id,
				name: 'Village',
				category: 'domestic',
				sizing: 'perUnit',
				count: 20_000,
				litresPerUnitDay: 230,
				priority: 'first',
				returnPct: 0
			}
		]
	} as never);
	// A Reserve high enough to be short every day: every unit's EWR charge takes all it can cut, and more than its share.
	await updateSettings(page.request, project.id, { reportStart: '2021-11-01', reportEnd: '2021-12-31', ewrPragmaticM3PerDay: new Array(12).fill(1_000_000) });
	const run = await createRun(page.request, project.id, 'Baseline');

	// The engine's own row for the unit: the floor holds part of the cut.
	const res = await page.request.get(`${API_URL}/projects/${project.id}/runs/${run}`);
	expect(res.status()).toBe(200);
	const { run: stored } = (await res.json()) as {
		run: { summary: { curtailment: { farms: { name: string; basicNeedsM3Day?: number; basicNeedsHeldM3Day?: number; volumeLeftM3Day: number }[] } } };
	};
	const row = stored.summary.curtailment.farms.find((f) => f.name === 'Upper farm')!;
	expect(row.basicNeedsM3Day).toBeCloseTo(500, 6);
	expect(row.basicNeedsHeldM3Day).toBeGreaterThan(0);
	expect(row.volumeLeftM3Day).toBeCloseTo(500, 6);
	// The unit without a village has no floor.
	expect(stored.summary.curtailment.farms.find((f) => f.name === 'Lower farm')!.basicNeedsM3Day).toBeUndefined();

	await page.goto(`/projects/${project.id}?tab=supply&run=${run}`);
	const panel = page.locator('#res-curtailment');
	const farms = panel.getByRole('table', { name: /^Curtailment targets per hydrological unit/ });
	await expect(farms).toBeVisible();
	const note = `basic needs keep ${vol(row.basicNeedsHeldM3Day!)} m³/day of the cut (floor 500 m³/day, 25 litres a person a day)`;
	// The badge sits in the unit's row header, and only there.
	await expect(farms.getByTestId('basic-needs-held')).toHaveCount(1);
	await expect(farms.getByRole('rowheader', { name: /^Upper farm/ }).getByTestId('basic-needs-held')).toHaveText(note);
	// Its volume left is the floor, not the 0 the EWR cut alone would leave.
	// (The row header spans both header rows, so a cell's index is its column in the second row + 1.)
	const left = await farms
		.locator('thead tr')
		.nth(1)
		.locator('th')
		.evaluateAll((ths) => ths.findIndex((th) => /^Volume left/.test((th.textContent ?? '').replace(/[ \t\r\n]+/g, ' '))) + 1);
	expect(left).toBeGreaterThan(0);
	const upperRow = (await rowsOf(farms)).find((r) => r[0]!.startsWith('Upper farm'))!;
	expect(upperRow[left]).toBe('500');

	// The board says the same under stage 2, and that stage 2 never goes below a floor.
	const board = panel.getByRole('region', { name: 'Share the pain' });
	await expect(board.getByText(note)).toBeVisible();
	await expect(board).toContainText("or below a hydrological unit's basic-needs floor");
	await expectNoViolations(page, { include: '#res-curtailment' });
});
