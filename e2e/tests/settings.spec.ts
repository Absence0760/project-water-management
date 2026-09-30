import type { Page } from '@playwright/test';
import { createProject, putSeries } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

test('monthly A-pan and EWR values are saved and survive a reload', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const apan = (m: string) => page.getByLabel(`A-pan evaporation, ${m}, mm`);
	const ewr = (m: string) => page.getByLabel(`Pragmatic EWR, ${m}, m³/day`);
	const save = page.getByRole('button', { name: 'Save settings' });

	await expect(apan('Oct')).toHaveValue('0');
	await expect(save).toBeDisabled();

	await apan('Oct').fill('152');
	await apan('Jan').fill('231.5');
	await ewr('Oct').fill('1800');
	await ewr('Jul').fill('5400');
	await expect(page.getByText('Unsaved settings')).toBeVisible();
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await expect(save).toBeDisabled();

	await page.reload();
	// Under the EWR row, its annual total (1800 × 31 + 5400 × 31 m³ = 0.223 Mm³); no chart redraws the row (issue #174).
	await expect(page.getByTestId('ewr-annual')).toHaveText(/^0\.223 Mm³\/a in total · mean 0\.0071 m³\/s$/);
	await expect(page.locator('#set-ewr svg[role="img"]')).toHaveCount(0);
	await expect(apan('Oct')).toHaveValue('152');
	await expect(apan('Jan')).toHaveValue('231.5');
	await expect(apan('Nov')).toHaveValue('0');
	await expect(ewr('Oct')).toHaveValue('1800');
	await expect(ewr('Jul')).toHaveValue('5400');
	await expect(page.getByText('Unsaved settings')).toBeHidden();
});

test('the high/low MAP split shows only while that flow-share method is chosen', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings hi/lo');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const method = page.getByLabel('Method', { exact: true });
	const split = page.getByRole('group', { name: /^High\/low MAP split/ });

	// By area (the default) and manual shares don't read the split: no dead control, no amber Sum.
	await expect(method.locator('option:checked')).toHaveText('By catchment area');
	await expect(split).toHaveCount(0);
	await method.selectOption('hiLo');
	await expect(split.getByLabel('High (%)')).toHaveValue('50');
	await expect(split.getByLabel('Low (%)')).toHaveValue('50');
	await expect(split).toContainText('Should add up to 100 %. Default 50 / 50');
	await split.getByLabel('High (%)').fill('81');
	await split.getByLabel('High (%)').press('Tab');
	await expect(split.locator('.sum')).toHaveClass(/warn/);
	await method.selectOption('manual');
	await expect(split).toHaveCount(0);
	// Back on high/low, the typed value is still there.
	await method.selectOption('hiLo');
	await expect(split.getByLabel('High (%)')).toHaveValue('81');
});

test('days in February is behind an advanced disclosure whose summary names its value, and says when it isn’t the default', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings February');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const advanced = page.getByTestId('feb-advanced');
	const summary = advanced.locator('summary');
	const feb = page.getByLabel('Days in February', { exact: true });

	await expect(summary).toHaveText('Advanced: days in February, 28.25');
	await expect(feb).toBeHidden();
	await summary.click();
	await feb.fill('28');
	await feb.press('Tab');
	await expect(summary).toHaveText('Advanced: days in February, 28 (not the default 28.25)');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	// Closed after a reload, the changed value still shows in the summary; opened, it is editable.
	await page.reload();
	await expect(summary).toHaveText('Advanced: days in February, 28 (not the default 28.25)');
	await expect(feb).toBeHidden();
	await summary.click();
	await expect(feb).toHaveValue('28');
	await expect(feb).toBeEditable();
});

test('discarding settings restores the saved values', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings discard');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const apan = page.getByLabel('A-pan evaporation, Mar, mm');

	await apan.fill('99');
	await page.getByRole('button', { name: 'Discard' }).click();
	await expect(apan).toHaveValue('0');
	await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
});

test('a simulation end before its start cannot be saved', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings dates');
	await page.goto(`/projects/${project.id}?tab=settings`);

	await page.getByLabel('Simulation start').fill('2022-06-01');
	await page.getByLabel('Simulation end').fill('2022-01-01');
	await expect(page.getByRole('alert')).toHaveText('Simulation start must be before the end.');
	await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();

	// The save bar says why Save is off and links to the group to fix; the menu flags it too.
	await page.evaluate(() => window.scrollTo(0, 0));
	const blockers = page.getByRole('status').filter({ hasText: 'to fix before saving' });
	await expect(blockers).toContainText('1 group has a problem to fix before saving:');
	await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: /^Simulation period\s*\(has a problem\)$/ })).toBeVisible();
	await blockers.getByRole('link', { name: 'Simulation period: Simulation start must be before the end.' }).click();
	await expect(page).toHaveURL(/#set-period$/);
	await expect(page.getByRole('heading', { name: 'Simulation period' })).toBeInViewport();

	await page.getByLabel('Simulation end').fill('2022-12-31');
	await expect(blockers).toBeHidden();
});

test('the On this page menu stays in view, jumps to each group below it and marks the one being read', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings menu');
	await page.setViewportSize({ width: 1600, height: 800 });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const menu = page.getByRole('navigation', { name: 'Settings sections' });
	await expect(menu.getByRole('link')).toHaveText([
		'Demand',
		'Flow calibration',
		'Rain gaps',
		'Calibration record',
		'Fit automatically',
		'WR2012 check',
		'Flow share',
		'EWR',
		'Reserve rules',
		'Drought restrictions',
		'Simulation period',
		'Data quality',
		'Outcome matrix',
		'Seasonal outlook',
		'Evidence',
		// Automatic runs, Data feeds, API keys and Scheduled reports behind one link.
		'Automation & access'
	]);
	await expect(menu.getByRole('link', { name: 'Demand' })).toHaveAttribute('aria-current', 'location');

	await menu.getByRole('link', { name: 'EWR' }).click();
	await expect(page).toHaveURL(/#set-ewr$/);
	const ewr = page.getByRole('heading', { name: 'Environmental water requirement (EWR)' });
	await expect(ewr).toBeInViewport();
	await expect(menu).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'EWR' })).toHaveAttribute('aria-current', 'location');
	await expect(menu.getByRole('link', { name: 'Demand' })).not.toHaveAttribute('aria-current', 'location');
	// The jumped-to heading sits below the sticky menu, not under it.
	const menuBox = (await menu.boundingBox())!;
	const headBox = (await ewr.boundingBox())!;
	expect(headBox.y).toBeGreaterThanOrEqual(menuBox.y + menuBox.height);

	// The EWR monthly row has the panel's full width: all twelve months fit without a sideways scroll.
	await expect(page.getByLabel('Pragmatic EWR, Sep, m³/day')).toBeInViewport();

	// Phone: the menu is one strip that scrolls inside itself, never the page.
	await page.setViewportSize({ width: 390, height: 900 });
	await menu.getByRole('link', { name: 'Data quality' }).click();
	await expect(page.getByRole('heading', { name: /^Data quality/ })).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Data quality' })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('the data-quality ratios read as a short percentage, not the stored two thirds to nine places', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings ratio display');
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(page.getByLabel('Lowest gauge/logger ratio (%)')).toHaveValue('66.7');
	await expect(page.getByLabel('Highest gauge/logger ratio (%)')).toHaveValue('150');
	// Showing it rounded doesn't change the stored value: nothing to save.
	await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
});

test('the monthly rows fit a 1280px screen without sideways scrolling, six-digit values included', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 900 });
	const project = await createProject(page.request, 'Settings monthly fit');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const jun = page.getByLabel('Pragmatic EWR, Jun, m³/day');
	await jun.fill('170800');
	const tables = page.locator('table.monthly');
	await expect(tables.first()).toBeVisible();
	for (const t of await tables.all()) {
		expect(await t.evaluate((el) => el.parentElement!.scrollWidth - el.parentElement!.clientWidth)).toBeLessThanOrEqual(0);
	}
	// The value shows in full, not clipped by its box.
	expect(await jun.evaluate((i: HTMLInputElement) => i.scrollWidth - i.clientWidth)).toBeLessThanOrEqual(0);
	await expect(page.getByLabel('Pragmatic EWR, Sep, m³/day')).toBeInViewport();
});

test('flow calibration is split into its own groups, and a bad exclusion points Save at the calibration record', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings groups');
	await page.goto(`/projects/${project.id}?tab=settings`);

	// Each part of calibration is its own panel with its own heading.
	const rain = page.getByRole('region', { name: 'Rain gaps and CHIRPS' });
	await expect(rain.getByLabel('CHIRPS bias correction', { exact: true })).toBeVisible();
	await expect(rain.getByLabel('Flagged zero runs', { exact: true })).toBeVisible();
	const record = page.getByRole('region', { name: 'Calibration record' });
	await expect(record.getByRole('group', { name: /^Calibration exclusions/ })).toBeVisible();
	await expect(page.getByRole('region', { name: /^Fit automatically/ })).toBeVisible();
	const flow = page.getByRole('region', { name: 'Flow calibration (rain → natural flow)' });
	await expect(flow.getByTestId('runoff-model')).toHaveText('GR4J (Perrin et al. 2003)');
	await expect(flow.getByLabel('CHIRPS bias correction', { exact: true })).toHaveCount(0);

	// An exclusion with no reason blocks Save, and the save bar sends you to the calibration record.
	await record.getByRole('button', { name: 'Exclude a water year' }).click();
	const blockers = page.getByRole('status').filter({ hasText: 'to fix before saving' });
	await expect(blockers.getByRole('link', { name: /^Calibration record: / })).toBeVisible();
	await blockers.getByRole('link', { name: /^Calibration record: / }).click();
	await expect(page).toHaveURL(/#set-record$/);
	await expect(page.getByRole('heading', { name: 'Calibration record' })).toBeInViewport();
});

// CHIRPS fit period (engine ≥ 0.29.0, issue #40). Synthetic records only.
test.describe('CHIRPS fit period', () => {
	const fit = (page: Page) => page.getByTestId('chirps-fit-period');
	const saved = (page: Page) => expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	test('listed water-year ranges: add and remove, a missing reason or an overlap blocks Save, and the list survives a reload', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Settings fit period');
		await page.goto(`/projects/${project.id}?tab=settings`);
		const section = fit(page);
		const save = page.getByRole('button', { name: 'Save settings' });
		const mode = section.getByLabel('CHIRPS fit period', { exact: true });
		await expect(mode).toHaveValue('all');

		await mode.selectOption('ranges');
		// A new range has no reason yet: Save is blocked and the section says why.
		await expect(section.getByRole('alert')).toHaveText('Fit range 1: needs a reason.');
		await expect(save).toBeDisabled();
		await section.getByLabel('From water year').first().fill('1990');
		await section.getByLabel('To water year').first().fill('2004');
		await section.getByLabel('Reason').first().fill('old gauge network');
		await expect(section.getByRole('alert')).toBeHidden();

		// A second range, overlapping the first.
		await section.getByRole('button', { name: 'Add a range' }).click();
		await section.getByLabel('From water year').nth(1).fill('2000');
		await section.getByLabel('To water year').nth(1).fill('2019');
		await section.getByLabel('Reason').nth(1).fill('new gauge network');
		await expect(section.getByRole('alert')).toHaveText('Fit ranges overlap: 2000/01–2019/20 overlaps 1990/91–2004/05.');
		await expect(save).toBeDisabled();
		await section.getByLabel('From water year').nth(1).fill('2005');
		await expect(section.getByRole('alert')).toBeHidden();
		await expect(save).toBeEnabled();

		await save.click();
		await saved(page);
		await page.reload();
		await expect(mode).toHaveValue('ranges');
		await expect(section.getByLabel('From water year')).toHaveCount(2);
		await expect(section.getByLabel('From water year').nth(1)).toHaveValue('2005');
		await expect(section.getByLabel('Reason').nth(1)).toHaveValue('new gauge network');

		// Remove one, save, reload: one left.
		await section.getByRole('button', { name: 'Remove fit range 2' }).click();
		await save.click();
		await saved(page);
		await page.reload();
		await expect(section.getByLabel('From water year')).toHaveCount(1);
		await expect(section.getByLabel('Reason')).toHaveValue('old gauge network');
	});

	test('an invalid list stays visible and fixable after turning bias correction off', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Settings fit period off');
		await page.goto(`/projects/${project.id}?tab=settings`);
		const section = fit(page);
		const save = page.getByRole('button', { name: 'Save settings' });
		await section.getByLabel('CHIRPS fit period', { exact: true }).selectOption('ranges');
		await expect(section.getByRole('alert')).toHaveText('Fit range 1: needs a reason.');
		await page.getByLabel('CHIRPS bias correction', { exact: true }).selectOption('none');
		// Still shown, marked as unused, and still what blocks Save, so it can be fixed.
		await expect(section.getByTestId('chirps-fit-inactive')).toBeVisible();
		await expect(section.getByRole('alert')).toHaveText('Fit range 1: needs a reason.');
		await expect(save).toBeDisabled();
		await section.getByLabel('Reason').fill('station history');
		await expect(save).toBeEnabled();
	});

	test('proposes ranges from the double-mass breaks, stored only on Save', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Settings fit proposal');
		// 20 water years from 1990: CHIRPS every third day, catchment 2 × CHIRPS to 1999/00 and 1.2 × after.
		const base = [0, 2, 2, 4, 6, 10, 12, 12, 10, 6, 4, 3, 2];
		const catchment: number[] = [];
		const chirps: number[] = [];
		for (let t = Date.UTC(1990, 9, 1), i = 0; t < Date.UTC(2010, 9, 1); t += 86_400_000, i++) {
			const d = new Date(t);
			const month = d.getUTCMonth() + 1;
			const wy = d.getUTCFullYear() - (month >= 10 ? 0 : 1);
			const v = i % 3 === 0 ? base[month]! * (0.8 + 0.1 * (wy % 5)) : 0;
			chirps.push(v);
			catchment.push(v * (wy < 2000 ? 2 : 1.2));
		}
		await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '1990-10-01', values: catchment });
		await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '1990-10-01', values: chirps });

		await page.goto(`/projects/${project.id}?tab=settings`);
		const section = fit(page);
		const propose = section.getByRole('button', { name: 'Propose from the double-mass breaks' });
		await propose.click();
		await expect(section.getByTestId('chirps-fit-proposal')).toContainText('Proposed 2 ranges from the double-mass breaks');
		await expect(section.getByLabel('CHIRPS fit period', { exact: true })).toHaveValue('ranges');
		await expect(section.getByLabel('From water year').nth(0)).toHaveValue('1990');
		await expect(section.getByLabel('To water year').nth(0)).toHaveValue('1999');
		await expect(section.getByLabel('From water year').nth(1)).toHaveValue('2000');
		await expect(section.getByLabel('Reason').nth(1)).toHaveValue(/^proposed from the double-mass check \(catchment \/ CHIRPS 1\.20\)/);

		// Nothing is stored until Save.
		await page.reload();
		await expect(section.getByLabel('CHIRPS fit period', { exact: true })).toHaveValue('all');
		await propose.click();
		await expect(section.getByLabel('From water year')).toHaveCount(2);
		await page.getByRole('button', { name: 'Save settings' }).click();
		await saved(page);
		await page.reload();
		await expect(section.getByLabel('From water year').nth(1)).toHaveValue('2000');
	});

	test('says why there is nothing to propose', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Settings fit no proposal');
		await page.goto(`/projects/${project.id}?tab=settings`);
		await fit(page).getByRole('button', { name: 'Propose from the double-mass breaks' }).click();
		await expect(fit(page).getByTestId('chirps-fit-proposal')).toHaveText(/needs a catchment rain series and a CHIRPS series/);
		await expect(fit(page).getByLabel('CHIRPS fit period', { exact: true })).toHaveValue('all');
	});
});

// Rain-source periods (engine ≥ 0.30.0, issue #40 (b)). Synthetic records only.
test('rain-source periods: a reason, fixed factors’ provenance and a non-CHIRPS fallback for a gauge in CHIRPS block Save until given; the list survives a reload', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings rain source');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const section = page.getByTestId('rain-source');
	const save = page.getByRole('button', { name: 'Save settings' });
	await expect(section.getByTestId('rain-source-none')).toBeVisible();

	await section.getByRole('button', { name: 'Add a rain-source period' }).click();
	const period = section.getByTestId('rain-source-period');
	await expect(section.getByRole('alert')).toHaveText(/^Rain-source period 1 needs a reason/);
	await expect(save).toBeDisabled();
	await period.getByLabel('From', { exact: true }).fill('2012-10-01');
	await period.getByLabel('To', { exact: true }).fill('2019-09-30');
	await period.getByLabel('Reason').fill('gauges closed; automatic station from 2012');
	// The default is a fit against the reanalysis, which needs nothing else.
	await expect(period.getByLabel('Factors')).toHaveValue('fit');
	await expect(section.getByRole('alert')).toBeHidden();

	// Fixed factors need their provenance.
	await period.getByLabel('Factors').selectOption('fixed');
	await expect(section.getByRole('alert')).toHaveText(/provenance needs a source and a method/);
	await period.getByLabel('Factor, Oct, period 1').fill('1.3');
	await period.getByLabel('Fitted by').fill('hydrologist');
	await period.getByLabel('Method').fill('catchment ÷ ERA5 over the reference era, by month');
	await expect(section.getByRole('alert')).toBeHidden();

	// A gauge CHIRPS ingests can't fall through to CHIRPS: name the reanalysis.
	await period.getByLabel(/CHIRPS ingests this gauge/).check();
	await expect(section.getByRole('alert')).toHaveText(/need a fallback that isn’t CHIRPS/);
	await expect(save).toBeDisabled();
	await period.getByLabel('Gaps from').selectOption('rain_reanalysis_mm');
	await expect(section.getByRole('alert')).toBeHidden();

	// The quantile map (engine ≥ 1.21.0) is opt-in, at 1 mm; a wet-day threshold outside 0.1–10 mm isn't taken.
	await period.getByLabel(/Quantile-map its wet days/).check();
	await expect(period.getByLabel('Wet day from (mm)')).toHaveValue('1');
	await period.getByLabel('Mapped onto water years from').fill('2001');
	await period.getByLabel('Wet day from (mm)').fill('0');
	await expect(period.getByLabel('Wet day from (mm)')).toHaveAttribute('aria-invalid', 'true');
	await period.getByLabel('Wet day from (mm)').fill('2.5');
	await expect(period.getByLabel('Wet day from (mm)')).not.toHaveAttribute('aria-invalid');
	await expect(section.getByRole('alert')).toBeHidden();
	await expect(save).toBeEnabled();
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	await page.reload();
	await expect(period.getByLabel('Reason')).toHaveValue('gauges closed; automatic station from 2012');
	await expect(period.getByLabel('Factors')).toHaveValue('fixed');
	await expect(period.getByLabel('Factor, Oct, period 1')).toHaveValue('1.3');
	await expect(period.getByLabel('Gaps from')).toHaveValue('rain_reanalysis_mm');
	await expect(period.getByLabel(/CHIRPS ingests this gauge/)).toBeChecked();
	await expect(period.getByLabel(/Quantile-map its wet days/)).toBeChecked();
	await expect(period.getByLabel('Wet day from (mm)')).toHaveValue('2.5');
	const settings = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings;
	expect(settings.rainSource).toEqual([
		expect.objectContaining({
			start: '2012-10-01',
			end: '2019-09-30',
			series: 'rain_catchment_alt_mm',
			gaugeInChirps: true,
			fallback: expect.objectContaining({ series: 'rain_reanalysis_mm' }),
			quantileMap: expect.objectContaining({ fromWaterYear: 2001, wetDayMm: 2.5 })
		})
	]);

	// Remove it: none again.
	await section.getByRole('button', { name: 'Remove rain-source period 1' }).click();
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await page.reload();
	await expect(section.getByTestId('rain-source-none')).toBeVisible();
});
