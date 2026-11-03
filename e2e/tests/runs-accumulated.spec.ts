// Accumulated flow at each unit (Runs & results, #res-cumulative; docs/ui.md § Runs & results): one daily line per
// hydrological unit and the catchment outlet, each the flow accumulated down the network, under four choices of
// "Flow shown", in the page's flow unit, with the chart's zoom. Read through the panel's data-* attributes and its
// numbers table, never pixels. The sample network is a branch: both farms drain straight into the outflow gauge.
import { API_URL } from '../support/env.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('the accumulated flow chart draws a daily line per unit, adds up the runoff down the network, and switches what it shows', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Accumulated flows');
	const runId = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);

	const panel = page.getByRole('region', { name: 'Accumulated flow at each unit' });
	await panel.scrollIntoViewIfNeeded();
	const acc = panel.getByTestId('accumulated-flows');
	const fig = panel.locator('figure.chart');
	const flow = panel.getByLabel('Flow shown');

	// Natural, accumulated by default: the outlet and both units (the gauge isn't a unit), daily, in m³/s.
	await expect(flow).toHaveValue('natural');
	await expect(acc).toHaveAttribute('data-flow', 'natural');
	await expect(acc).toHaveAttribute('data-lines', '3');
	await expect(acc).toHaveAttribute('data-ready', 'true');
	await expect(panel.getByRole('img', { name: 'Accumulated flow at each unit · Natural, accumulated: line chart of Catchment outlet, Upper farm, Lower farm, in m³/s, 1 Oct 2021 to 28 Jan 2022' })).toBeVisible();

	// The numbers: on a branch the outlet carries both units' runoff, and that is the catchment's natural flow.
	await panel.getByText('Show the numbers').click();
	const mean = async (line: string) => Number(await panel.locator(`tr[data-line="${line}"] td[data-mean]`).getAttribute('data-mean'));
	const nodeId = (name: string) => String(project.model.nodes.find((n) => n.name === name)!.id);
	const upper = nodeId('Upper farm');
	const lower = nodeId('Lower farm');
	const outlet = await mean('__outlet');
	expect(outlet).toBeCloseTo((await mean(upper)) + (await mean(lower)), 9);
	const natural = await page.request.get(`${API_URL}/projects/${project.id}/runs/${runId}/series?key=natural_flow`);
	expect(natural.ok()).toBe(true);
	const values = ((await natural.json()) as { values: number[] }).values;
	const naturalMeanM3s = values.reduce((a, v) => a + v, 0) / values.length / 86_400;
	expect(outlet).toBeCloseTo(naturalMeanM3s, 6);
	// Each unit is all its own runoff here (nothing drains into either).
	await expect(panel.locator(`tr[data-line="${upper}"] td`).last()).toHaveText('100.0%');

	// The page's flow unit switch reaches this chart too.
	await fig.getByRole('button', { name: 'm³/day', exact: true }).click();
	await expect(panel.getByRole('img', { name: /: line chart of Catchment outlet, Upper farm, Lower farm, in m³\/day,/ })).toBeVisible();
	expect(await mean('__outlet')).toBeCloseTo(outlet * 86_400, 3);
	await fig.getByRole('button', { name: 'm³/s', exact: true }).click();

	// The pick-list hides and shows a line.
	const lowerBox = panel.getByRole('checkbox', { name: 'Lower farm' });
	await lowerBox.uncheck();
	await expect(acc).toHaveAttribute('data-lines', '2');
	await lowerBox.check();
	await expect(acc).toHaveAttribute('data-lines', '3');

	// The modelled flows: the outlet is the simulated outflow; incremental only has no outlet line.
	await flow.selectOption({ label: 'Modelled, leaving the unit' });
	await expect(acc).toHaveAttribute('data-flow', 'leaving');
	await expect(acc).toHaveAttribute('data-lines', '3');
	await expect(acc).toHaveAttribute('data-ready', 'true');
	await flow.selectOption({ label: 'Modelled, arriving at the unit' });
	await expect(acc).toHaveAttribute('data-flow', 'arriving');
	await expect(acc).toHaveAttribute('data-lines', '3');
	await flow.selectOption({ label: 'Incremental only' });
	await expect(acc).toHaveAttribute('data-lines', '2');
	await expect(panel.getByRole('img', { name: /: line chart of Upper farm, Lower farm, in m³\/s,/ })).toBeVisible();

	// Zoom into the later part of the run with a drag box: the numbers cover the days in view.
	await expect(acc).toHaveAttribute('data-view-from', '2021-10-01');
	const over = fig.locator('.u-over');
	await over.scrollIntoViewIfNeeded();
	const box = (await over.boundingBox())!;
	const y = box.y + box.height / 2;
	await page.mouse.move(box.x + box.width * 0.5, y);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.9, y, { steps: 5 });
	await page.mouse.up();
	await expect(acc).not.toHaveAttribute('data-view-from', '2021-10-01');
	await expect(panel.locator('details.numbers caption')).toContainText('Incremental only, ');
	await expect(panel.locator('details.numbers caption')).not.toContainText('1 Oct 2021 to');

	// Hydrological units links here for the run shown.
	await page.goto(`/projects/${project.id}?tab=supply&run=${runId}`);
	await expect(page.getByRole('link', { name: /^Accumulated flow at each unit/ })).toHaveAttribute('href', `?tab=runs&run=${runId}#res-cumulative`);
});
