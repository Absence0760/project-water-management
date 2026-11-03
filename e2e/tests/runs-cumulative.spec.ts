// Cumulative flow at each unit (Runs & results, #res-cumulative; docs/ui.md § Runs & results): one line per
// hydrological unit and the catchment outlet, the pick-list, the chart's zoom, and "Count from the first day in view"
// restarting every line at the view's first day. Read through the panel's data-* attributes and its numbers table,
// never pixels.
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
/** A table cell's Mm³ ("1.234", thousands with narrow spaces, U+2212 minus). */
const mm3 = (text: string | null) => Number((text ?? '').replace(/[\s ]/g, '').replace('−', '-'));

test('the cumulative flow chart draws one line per unit, zooms, and counts from the first day in view when asked', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Cumulative flows');
	const runId = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);

	const panel = page.getByRole('region', { name: 'Cumulative flow at each unit' });
	await panel.scrollIntoViewIfNeeded();
	const cum = panel.getByTestId('cumulative-flows');
	const fig = panel.locator('figure.chart');
	// The outlet and both units (the gauge isn't a unit), each named in the chart's accessible name, in Mm³ over the run.
	await expect(cum).toHaveAttribute('data-lines', '3');
	await expect(cum).toHaveAttribute('data-ready', 'true');
	await expect(panel.getByRole('img', { name: 'Cumulative flow at each unit: line chart of Catchment outlet (simulated outflow), Upper farm, Lower farm, in Mm³, 1 Oct 2021 to 28 Jan 2022' })).toBeVisible();
	await expect(cum).toHaveAttribute('data-count-from', '2021-10-01');
	await expect(cum).toHaveAttribute('data-count-to', '2022-01-28');

	// The pick-list hides and shows a line.
	const lower = panel.getByRole('checkbox', { name: 'Lower farm' });
	await lower.uncheck();
	await expect(cum).toHaveAttribute('data-lines', '2');
	await expect(panel.getByRole('group', { name: /^Lines shown/ })).toContainText('(2 of 3)');
	await lower.check();
	await expect(cum).toHaveAttribute('data-lines', '3');

	// The numbers: each line's total over the run.
	await panel.getByText('Show the numbers').click();
	const upper = panel.locator('details.numbers tr[data-line]').filter({ hasText: 'Upper farm' }).locator('td');
	await expect(panel.getByRole('columnheader', { name: '1 Oct 2021 to 28 Jan 2022 (Mm³)' })).toBeVisible();
	const whole = mm3(await upper.textContent());
	expect(whole).toBeGreaterThan(0);

	// Zoom into the later part of the run with a drag box: the totals still count from the run's first day.
	const over = fig.locator('.u-over');
	await over.scrollIntoViewIfNeeded();
	const box = (await over.boundingBox())!;
	const y = box.y + box.height / 2;
	await page.mouse.move(box.x + box.width * 0.5, y);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.9, y, { steps: 5 });
	await page.mouse.up();
	await expect(fig).not.toHaveAttribute('data-view-start', '2021-10-01');
	const viewStart = (await fig.getAttribute('data-view-start'))!;
	await expect(cum).toHaveAttribute('data-count-from', '2021-10-01');
	const viewEnd = (await cum.getAttribute('data-count-to'))!;
	expect(daysBetween(viewEnd, '2022-01-28')).toBeGreaterThan(0);
	const toViewEnd = mm3(await upper.textContent());

	// Count from the first day in view: every line restarts there (the view's first whole day), over the same days.
	const toggle = panel.getByRole('button', { name: 'Count from the first day in view' });
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(cum).toHaveAttribute('data-from-view', 'true');
	await expect(cum).not.toHaveAttribute('data-count-from', '2021-10-01');
	const from = (await cum.getAttribute('data-count-from'))!;
	expect(daysBetween(viewStart, from)).toBeGreaterThanOrEqual(0);
	expect(daysBetween(viewStart, from)).toBeLessThanOrEqual(1);
	await expect(cum).toHaveAttribute('data-count-to', viewEnd);
	await expect(cum).toHaveAttribute('data-ready', 'true');
	const inView = mm3(await upper.textContent());
	expect(inView).toBeLessThan(toViewEnd);
	expect(inView).toBeGreaterThanOrEqual(0);

	// Earlier moves the view and the day the lines count from with it.
	await fig.getByRole('button', { name: /Earlier/ }).click();
	await expect(cum).not.toHaveAttribute('data-count-from', from);
	expect(daysBetween((await cum.getAttribute('data-count-from'))!, from)).toBeGreaterThan(0);

	// Off again: back to the run's first day.
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(cum).toHaveAttribute('data-count-from', '2021-10-01');

	// Hydrological units links here for the run shown.
	await page.goto(`/projects/${project.id}?tab=supply&run=${runId}`);
	await expect(page.getByRole('link', { name: /^Cumulative flow at each unit/ })).toHaveAttribute('href', `?tab=runs&run=${runId}#res-cumulative`);
});
