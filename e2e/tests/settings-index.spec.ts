// Settings & calibration's side index, find box and explanations (issue #468): from 1440 px the in-page
// menu is a sticky column grouped by task (common/SectionNav's rail), with a find box that narrows it to
// the panels and the settings inside them and jumps to the setting itself; narrower, the bar's Find button
// opens the same box. Each panel says its current values under its heading, and the explanations under
// the fields wait behind a switch. Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, putSeries, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { openSettings, settingsBar, settingsMenu } from '../support/settings.ts';

const findBox = (page: import('@playwright/test').Page) => page.getByRole('searchbox', { name: 'Find a setting' });

test('the find box narrows the index to the settings that match, and a match jumps to its field, opening what folds it away', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings find');
	await openSettings(page, project.id);
	const menu = settingsMenu(page);
	const box = findBox(page);
	await expect(box).toBeVisible();

	// A section's name lists the section; a setting's lists the setting and the panel it is in.
	await box.fill('february');
	const matches = menu.getByRole('list', { name: 'Matches' });
	await expect(matches.getByRole('button')).toHaveText(['Days in February, in Demand']);
	await expect(menu.getByRole('status')).toHaveText('1 match');
	// The groups make way for the matches.
	await expect(menu.getByRole('list', { name: 'Data & rain' })).toHaveCount(0);

	// The field sits in a closed Advanced disclosure: the jump opens it and focuses the field.
	await expect(page.getByTestId('feb-advanced')).not.toHaveAttribute('open', '');
	await matches.getByRole('button').click();
	const feb = page.getByLabel('Days in February', { exact: true });
	await expect(feb).toBeFocused();
	await expect(feb).toBeInViewport();
	await expect(page.getByTestId('feb-advanced')).toHaveAttribute('open', '');

	// From the keyboard: Enter takes the first match; Down walks the list.
	await box.fill('pan coef');
	// In page order: the PE choice's radio comes before the preset under it.
	await expect(matches.getByRole('button').first()).toHaveAccessibleName(/^Pan coefficient × A-pan ?, in Flow calibration$/);
	await box.press('ArrowDown');
	await expect(matches.getByRole('button').first()).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(matches.getByRole('button').nth(1)).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('ArrowUp');
	await expect(box).toBeFocused();
	await box.press('Enter');
	await expect(page.getByRole('radio', { name: 'Pan coefficient × A-pan' })).toBeFocused();

	// A section's own name links to it.
	await box.fill('reserve rule');
	await matches.getByRole('link', { name: 'Reserve rule tables' }).click();
	await expect(page).toHaveURL(/#set-reserve$/);

	// Nothing matches: it says so. Escape clears the box and the groups come back.
	await box.fill('zzzz');
	await expect(menu.getByRole('status')).toHaveText('No setting matches “zzzz”');
	await box.press('Escape');
	await expect(box).toHaveValue('');
	await expect(menu.getByRole('list', { name: 'Data & rain' })).toBeVisible();
	await box.fill('evaporation');
	await expectNoViolations(page);
});

test('the index moves with the arrow keys, and a panel with a Save blocker is marked in it and linked from the save bar', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings index keys');
	await openSettings(page, project.id);
	const menu = settingsMenu(page);
	const first = menu.getByRole('link', { name: 'Simulation period', exact: true });
	await first.focus();
	await page.keyboard.press('ArrowDown');
	await expect(menu.getByRole('link', { name: 'Rain gaps', exact: true })).toBeFocused();
	await page.keyboard.press('End');
	await expect(menu.getByRole('link', { name: 'Scheduled reports', exact: true })).toBeFocused();
	await page.keyboard.press('Home');
	await expect(first).toBeFocused();
	// Up from the first link goes back to the find box, never out of the page.
	await page.keyboard.press('ArrowUp');
	await expect(findBox(page)).toBeFocused();

	// A problem: the end before the start.
	await page.getByLabel('Simulation start').fill('2023-01-01');
	await page.getByLabel('Simulation end').fill('2022-01-01');
	await page.getByLabel('Simulation end').blur();
	await expect(menu.getByRole('link', { name: /^Simulation period\s*\(has a problem\)$/ })).toBeVisible();
	// Scrolled away, the save bar's link brings it back, beside the index.
	await menu.getByRole('link', { name: 'Automatic runs', exact: true }).click();
	await settingsBar(page).getByRole('link', { name: 'Simulation period: Simulation start must be before the end.' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Simulation period' })).toBeInViewport();
	await expect(menu).toBeInViewport();
});

test('each panel says its current values under its heading; the explanations show with the switch, and stay the fields’ descriptions', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings summaries');
	await updateSettings(page.request, project.id, { simulationStart: '2015-10-01', simulationEnd: '2020-09-30', apanMm: [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130] });
	await openSettings(page, project.id);
	await expect(page.getByTestId('summary-period')).toHaveText('1 Oct 2015 – 30 Sep 2020');
	await expect(page.getByTestId('summary-demand')).toContainText(/A-pan 1\s?995 mm a year/);
	await expect(page.getByTestId('summary-auto')).toHaveText('Off: runs only when someone runs the model');
	// The summaries follow the form before it is saved.
	await page.getByLabel('Re-run the model after new data').check();
	await expect(page.getByTestId('summary-auto')).toHaveText('On: 15 minutes after new data, never publishes');

	// Off by default: the field's explanation is hidden, yet still describes it.
	const erf = page.getByLabel('Effective rainfall (%)');
	const hint = page.locator('#st-erf-h');
	await expect(hint).toBeHidden();
	await expect(erf).toHaveAccessibleDescription(/Share of each day's rain on the cropped area/);
	const sw = page.getByRole('checkbox', { name: 'Explain each setting under its field' });
	await sw.check();
	await expect(hint).toBeVisible();
	// Remembered on this device.
	await page.reload();
	await expect(page.locator('#st-erf-h')).toBeVisible();
	await page.getByRole('checkbox', { name: 'Explain each setting under its field' }).uncheck();
	await expect(page.locator('#st-erf-h')).toBeHidden();
});

test('the Scored at choice says where a gauge’s record is placed, with a link to it on the Data tab', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings scored at');
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2020-01-01', values: [1.2, 1.1, 1.0] });
	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()) as { series: { id: string; kind: string }[] };
	const series = list.series.find((x) => x.kind === 'flow_observed_m3s')!;
	await openSettings(page, project.id);
	const how = page.getByTestId('calibration-site-how');
	await expect(how).toContainText(
		"To score at a gauge inside the network, set its flow record's Measured at in Series details on the Data tab (the gauge has to be in the network, above the outlet)."
	);
	await how.getByRole('link', { name: 'Data tab' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=series&series=${series.id}#data-chart$`));
	// The link lands on the chart, whose Series details the hint names (issue #464).
	await expect(page.getByRole('group', { name: 'Series details' })).toBeVisible();
});

test('below the rail’s width the bar’s Find opens the same box; on a phone it opens under the strip', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings find bar');
	for (const [width, height] of [
		[1280, 800],
		[390, 844]
	] as const) {
		await page.setViewportSize({ width, height });
		await openSettings(page, project.id);
		const menu = settingsMenu(page);
		const find = menu.getByRole('button', { name: 'Find a setting' });
		await expect(find).toHaveAttribute('aria-expanded', 'false');
		await find.click();
		await expect(find).toHaveAttribute('aria-expanded', 'true');
		await expect(findBox(page)).toBeFocused();
		await findBox(page).fill('warm-up');
		const match = menu.getByRole('list', { name: 'Matches' }).getByRole('button', { name: /^Warm-up/ });
		const pop = (await menu.getByRole('list', { name: 'Matches' }).boundingBox())!;
		expect(pop.y).toBeGreaterThan(0);
		expect(pop.x + pop.width).toBeLessThanOrEqual(width);
		if (width === 390) {
			await expectNoSidewaysScroll(page);
			await expectNoViolations(page);
		}
		await match.click();
		await expect(page.getByLabel(/^Warm-up/)).toBeFocused();
		await expect(find).toHaveAttribute('aria-expanded', 'false');
		// Escape closes it with the focus back on Find.
		await find.click();
		await page.keyboard.press('Escape');
		await expect(find).toHaveAttribute('aria-expanded', 'false');
		await expect(find).toBeFocused();
	}
});
