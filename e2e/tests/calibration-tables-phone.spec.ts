// Calibration's EWR test and plausibility tables on a phone (issue #586 R4-K, docs/ui.md § Calibration): each row a
// block with its cells under their names (app.css `.table-stack`), not a nine-column table scrolling sideways in a
// 320 px box, which the page-level reflow check can't see (it skips a box that holds its own overflow). Columns again at
// 1440 and 1280. Light and dark. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, createRun, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

/** Three water years of gauge record with an EWR and one excluded water year: every table these panels draw but the double mass's. */
async function seed(page: Page): Promise<{ id: string; run: string }> {
	const project = await createProject(page.request, 'Calibration tables on a phone');
	await putModel(page.request, project.id, sampleModel());
	await updateSettings(page.request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000],
		calibrationExclusions: [{ waterYear: 2021, reason: 'Rain gauge moved' }]
	});
	const days = 1096;
	const rain = syntheticRain(days);
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: rain });
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2019-10-01', values: rain });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	return { id: project.id, run: await createRun(page.request, project.id, 'Baseline') };
}

const TABLES = '#res-ewr-agreement .table-wrap, #res-plausibility .table-wrap';

/** Each drawn table box's sideways overflow (scrollWidth − clientWidth), by its table's name. */
const overflow = (page: Page) =>
	page.locator(TABLES).evaluateAll((els) =>
		els
			.filter((e) => (e as HTMLElement).checkVisibility())
			.map((e) => {
				const t = e.querySelector('table')!;
				const name = t.getAttribute('aria-labelledby') ? document.getElementById(t.getAttribute('aria-labelledby')!)?.textContent : t.querySelector('caption')?.textContent;
				return [name?.trim().slice(0, 50), e.scrollWidth - e.clientWidth] as const;
			})
	);

async function openAll(page: Page) {
	for (const summary of await page.locator('#res-ewr-agreement summary, #res-plausibility summary').all()) {
		const details = summary.locator('xpath=..');
		if ((await details.getAttribute('open')) === null) await summary.click();
		await expect(details).toHaveAttribute('open', '');
	}
}

for (const colorScheme of ['light', 'dark'] as const) {
	test(`${colorScheme}: the EWR test and plausibility tables stack on a phone and stay columns at 1440 and 1280`, async ({ page, owner }) => {
		void owner;
		await page.emulateMedia({ colorScheme });
		const p = await seed(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`/projects/${p.id}?tab=calibration&run=${p.run}#res-ewr-agreement`);
		await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', p.run);
		const ewr = page.locator('#res-ewr-agreement');
		await expect(ewr.getByRole('table', { name: /: by month$/ })).toBeVisible();
		// The excluded days' sentence keeps its space after the full stop before it.
		await expect(ewr.getByText(/fitted\s+to\. 365 excluded days are left out\./)).toBeVisible();
		await page.locator('#res-plausibility').scrollIntoViewIfNeeded();
		await expect(page.getByRole('table', { name: /^Hydrological signatures/ })).toBeVisible();
		await openAll(page);

		// 390: no table box scrolls sideways; the column heads are hidden and each cell carries its name.
		const drawn = await overflow(page);
		expect(drawn.length, 'the matrix, by month, by water year, natural flow, rain source, Q table, signatures').toBeGreaterThanOrEqual(7);
		for (const [name, over] of drawn) expect(over, `${name} at 390`).toBeLessThanOrEqual(0);
		const months = ewr.getByRole('table', { name: /: by month$/ });
		await expect(months.locator('thead')).toBeHidden();
		const oct = months.locator('tbody tr').first();
		expect(await oct.evaluate((tr) => getComputedStyle(tr).display)).toBe('grid');
		expect(await oct.locator('td').nth(6).evaluate((td) => getComputedStyle(td, '::before').content)).toBe('"False-alarm ratio"');
		// Three cells to a line at 390, so a month takes three lines under its name, not four.
		const lefts = await oct.locator('td').evaluateAll((tds) => tds.map((td) => Math.round(td.getBoundingClientRect().left)));
		expect(new Set(lefts).size).toBe(3);
		// The rows are still rows, named by their header, with each cell's name before its value.
		const nat = page.getByRole('table', { name: /^Natural flow ≥ observed \+ net abstraction/ });
		await expect(nat.getByRole('row', { name: /^2019\/20 366 days Result (passes|fails|not judged) / })).toBeVisible();
		const sig = page.getByRole('table', { name: /^Hydrological signatures/ });
		expect(await sig.locator('tbody td').last().evaluate((td) => getComputedStyle(td, '::before').content)).toBe('"Result"');
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);

		// 1440 and 1280: the same tables as columns, their heads shown, still nothing sideways.
		for (const width of [1440, 1280]) {
			await resizeTo(page, { width, height: 900 });
			await expect(months.locator('thead'), `${width}`).toBeVisible();
			expect(await months.locator('tbody tr').first().evaluate((tr) => getComputedStyle(tr).display), `${width}`).toBe('table-row');
			for (const [name, over] of await overflow(page)) expect(over, `${name} at ${width}`).toBeLessThanOrEqual(0);
		}
		await expectNoViolations(page);
	});
}
