import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// Long data tables (.table-wrap, app.css) scroll inside their own box, capped
// at 70 % of the window, so the header row stays in view while you read down
// them. The network table has a two-row header (groups over column names):
// the whole <thead> sticks, so the rows stay stacked instead of overlapping.

test('a long table keeps both header rows in view while it scrolls in its box', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Long network');
	const model = sampleModel();
	const [gauge, farm] = model.nodes as [Record<string, unknown>, Record<string, unknown>];
	const farms = Array.from({ length: 40 }, (_, i) => ({ ...farm, id: crypto.randomUUID(), name: `Farm ${String(i + 1).padStart(2, '0')}`, sortOrder: i + 2 }));
	await putModel(page.request, project.id, { nodes: [gauge, ...farms], crops: model.crops, cropAreas: [], transfers: [] });
	await page.setViewportSize({ width: 1600, height: 700 });
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);

	const table = page.locator('table.net');
	await expect(table.getByRole('textbox', { name: 'Name' })).toHaveCount(41); // the gauge + 40 farms
	const wrap = page.locator('.table-wrap', { has: table });
	const [clientH, scrollH] = await wrap.evaluate((el) => [el.clientHeight, el.scrollHeight]);
	expect(clientH).toBeLessThanOrEqual(700 * 0.7 + 1); // capped, so it scrolls
	expect(scrollH).toBeGreaterThan(clientH);

	const headerRows = table.locator('thead tr');
	await expect(headerRows).toHaveCount(2);
	await wrap.evaluate((el) => el.scrollTo(0, 600));
	await expect.poll(() => wrap.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);

	const wrapTop = (await wrap.boundingBox())!.y;
	const groups = (await headerRows.nth(0).boundingBox())!;
	const names = (await headerRows.nth(1).boundingBox())!;
	// Both header rows sit at the top of the box, the column names under the groups.
	expect(Math.abs(groups.y - wrapTop)).toBeLessThan(2);
	expect(Math.abs(names.y - (groups.y + groups.height))).toBeLessThan(2);
	// A row scrolled up under them is covered by the header, which stays on top.
	const topHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('thead') !== null, {
		x: names.x + names.width / 2,
		y: names.y + names.height / 2
	});
	expect(topHit).toBe(true);
});
