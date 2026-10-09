// The Settings & calibration page (?tab=settings, issue #17 option A). A reading page: the long form scrolls,
// under the section header, which says where the GR4J parameters came from (the fit's day and in-sample score,
// or that there is no fit record) and carries "Fit the parameters", a jump to Fit automatically. The sticky menu
// is grouped (model inputs · how results are read · runs, feeds and reports) and also links API keys (owners)
// and Scheduled reports, which save on their own, as a line above them says. Synthetic data, plus the invented
// example catchments for a real fit record.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, sampleModel, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { DEMO, KLEINBERG, seedExamplesOnce } from '../support/examples.ts';
import { loadSyntheticQuaternaries } from '../support/map.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { answerConfirm } from '../support/confirm.ts';
import { anySaveBar, fitSummary, header, isProjectPatch, openSettings, saveChanges, saveSettings, settingsBar, settingsMenu } from '../support/settings.ts';

/** The side index at 1440 px (issue #468): every panel's heading, under its task. */
const SETTINGS_INDEX: [string, string[]][] = [
	['Data & rain', ['Simulation period', 'Rain gaps', 'Data quality']],
	['Demand & supply', ['Demand', 'Flow share', 'Drought restrictions']],
	['Runoff & calibration', ['Flow calibration', 'Calibration record', 'Fit the parameters', 'WR2012 check']],
	['EWR & Reserve', ['EWR', 'Reserve rule tables']],
	['Reading results', ['Outcome matrix', 'Seasonal outlook', 'Evidence']],
	['Automation & access', ['Automatic runs', 'Data feeds', 'API keys', 'Scheduled reports']]
];
const AFTER_FORM = 'Data feeds, API keys and scheduled reports save as you change them, not with the save bar’s Save changes.';

test('the header says there is no fit record and jumps to Fit the parameters; the side index is grouped by task and reaches the panels after the form', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings page');
	await openSettings(page, project.id);

	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(fitSummary(page)).toHaveText('GR4J · no fit record: the parameters were set by hand or imported');
	const jump = header(page).getByRole('link', { name: 'Fit the parameters', exact: true });
	await expect(jump).toHaveAttribute('href', '#set-fit');
	// The header's Run model opens a form to name the run (the one on every section but Runs & results).
	await expect(header(page).getByTestId('header-run')).toHaveAttribute('aria-expanded', 'false');
	// The old intro paragraph is gone: the header and the menu's groups say it.
	await expect(page.getByText(/^Grouped by what each setting drives/)).toHaveCount(0);

	// The index's groups, each a named list, in page order; each link is its panel's heading, word for word.
	const menu = settingsMenu(page);
	for (const [name, links] of SETTINGS_INDEX) {
		await expect(menu.getByRole('list', { name, exact: true }).getByRole('link')).toHaveText(links);
	}
	for (const [, links] of SETTINGS_INDEX) {
		for (const name of links) {
			const id = (await menu.getByRole('link', { name, exact: true }).getAttribute('href'))!.slice(1);
			await expect(page.locator(`#${id}`).getByRole('heading', { level: 2 }).first()).toHaveText(new RegExp(`^${name}`));
		}
	}

	// The jump lands on the fit panel, at the top of the window beside the index, and the index marks it.
	await jump.click();
	await expect(page).toHaveURL(/\?tab=settings#set-fit$/);
	const fit = page.locator('#set-fit');
	await expect(fit.getByRole('heading', { name: 'Fit automatically' })).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Fit the parameters' })).toHaveAttribute('aria-current', 'location');
	await expect(menu).toBeInViewport();

	// The panels after the form: the line says they save on their own; each has its own link.
	await expect(page.getByText(AFTER_FORM, { exact: true })).toBeVisible();
	await menu.getByRole('link', { name: 'Automatic runs' }).click();
	await expect(page).toHaveURL(/#set-auto$/);
	await expect(page.getByRole('heading', { level: 2, name: 'Automatic runs' })).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Automatic runs' })).toHaveAttribute('aria-current', 'location');

	// Back returns to the fragment before, on the same page.
	await page.goBack();
	await expect(page).toHaveURL(/#set-fit$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Settings & calibration' })).toBeVisible();

	// Each panel keeps its own anchor, so a link to it still lands, with its link marked. Data feeds is a lazy
	// chunk: its anchor is on a wrapper that is always there.
	for (const [id, name] of [
		['set-report-schedules', 'Scheduled reports'],
		['set-api-keys', 'API keys'],
		['set-feeds', 'Data feeds']
	] as const) {
		await page.goto(`/projects/${project.id}?tab=settings#${id}`);
		// Not exact: a panel's heading may carry its ⓘ tip ("API keys About API keys"); the id scopes it.
		await expect(page.locator(`#${id}`).getByRole('heading', { level: 2, name })).toBeInViewport();
		await expect(menu.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'location');
	}
	// The index sticks beside the last panel too.
	await expect(menu).toBeInViewport();
});

test('a link into a group (?tab=calibration, a note’s #set- link) opens the page on that group, below the menu', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await createProject(page.request, 'Settings links');
	await page.goto(`/projects/${project.id}?tab=calibration#set-ewr`);
	await expect(page.getByRole('heading', { level: 1, name: 'Settings & calibration' })).toBeVisible();
	const ewr = page.getByRole('heading', { name: 'EWR', exact: true });
	await expect(ewr).toBeInViewport();
	await expect(ewr).toBeFocused();
	const menu = (await settingsMenu(page).boundingBox())!;
	expect((await ewr.boundingBox())!.y).toBeGreaterThanOrEqual(menu.y + menu.height);

	// A note on a settings group links to it from the Project page's recent notes (client-side navigation).
	await page.getByRole('button', { name: 'Add a note on Data quality' }).click();
	const dialog = page.getByRole('dialog', { name: 'Notes on Data quality' });
	await dialog.getByLabel('Add a note').fill('Thresholds agreed with the gauge owner');
	await dialog.getByRole('button', { name: 'Add note' }).click();
	await expect(dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toContainText('Thresholds agreed');
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await page.goto(`/projects/${project.id}?tab=project`);
	const link = page.getByRole('region', { name: 'Recent notes' }).getByRole('link', { name: 'Data quality' });
	await expect(link).toHaveAttribute('href', '?tab=settings#set-quality');
	await link.click();
	const quality = page.getByRole('heading', { level: 2, name: /^Data quality/ });
	await expect(quality).toBeInViewport();
	await expect(quality).toBeFocused();
});

test('Vary it by month sits beside its box, and the page reflows at 1280 and on a phone with no a11y violations', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings layout');
	await page.setViewportSize({ width: 1280, height: 800 });
	await openSettings(page, project.id);
	const vary = page.getByRole('checkbox', { name: 'Vary it by month' });
	const box = (await vary.boundingBox())!;
	const text = (await page.locator('label.check', { has: vary }).getByText('Vary it by month').boundingBox())!;
	// The box was stretched across its field, leaving the words half a field away.
	expect(box.width).toBeLessThan(30);
	expect(text.x - (box.x + box.width)).toBeLessThan(16);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);

	await page.setViewportSize({ width: 390, height: 844 });
	await openSettings(page, project.id);
	await expect(header(page).getByRole('link', { name: 'Fit the parameters', exact: true })).toBeVisible();
	await expect(fitSummary(page)).toBeVisible();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
});

test('a dam evaporation preset fills the monthly factors and their source, needs the A-pan first, and says when the A-pan moves on', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Lake preset');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openSettings(page, project.id);
	const preset = page.getByLabel('Dam evaporation preset', { exact: true });
	const source = page.getByLabel('Dam evaporation factor source');
	// A new project has no A-pan: a WR90 preset can't convert its S-pan factors, and says so.
	await preset.selectOption({ label: 'WR90 lake factors, WR90 pan conversion' });
	await expect(page.getByTestId('lake-preset-error')).toContainText('enter the monthly A-pan first');
	await expect(page.getByTestId('lake-factor-row')).toHaveCount(0);

	// Oct–Sep A-pan (mm/month), a Western Cape-like year.
	await updateSettings(page.request, project.id, { apanMm: [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130] });
	await openSettings(page, project.id);
	await preset.selectOption({ label: 'WR90 lake factors, WR90 pan conversion' });
	await expect(page.getByTestId('lake-preset-error')).toHaveCount(0);
	// January: 0.84 × (0.8793 × 285 − 16.2354) ÷ 285 = 0.691; June: 0.517.
	const row = page.getByTestId('lake-factor-row');
	await expect(row.getByLabel('Dam evaporation factor, Jan, × A-pan')).toHaveValue('0.691');
	await expect(row.getByLabel('Dam evaporation factor, Jun, × A-pan')).toHaveValue('0.517');
	await expect(page.getByRole('checkbox', { name: 'Vary it by month' })).toBeChecked();
	await expect(source).toHaveValue(/^WR90 lake factors, WR90 pan conversion preset: .*Midgley.*0\.8793/);
	// The picker resets: it is an action, not a setting.
	await expect(preset).toHaveValue('');
	await saveSettings(page);

	// Saved, and the note still matches the values.
	await openSettings(page, project.id);
	await expect(row.getByLabel('Dam evaporation factor, Jan, × A-pan')).toHaveValue('0.691');
	await expect(source).toHaveValue(/^WR90 lake factors, WR90 pan conversion preset:/);
	await expect(page.getByTestId('lake-preset-stale')).toHaveCount(0);
	// Changing the A-pan leaves the factors behind the preset the note names.
	await page.getByLabel('A-pan evaporation, Jan, mm').fill('300');
	await expect(page.getByTestId('lake-preset-stale')).toContainText('“WR90 lake factors, WR90 pan conversion”');
	// Filling again brings them back in step.
	await preset.selectOption({ label: 'WR90 lake factors, WR90 pan conversion' });
	await expect(page.getByTestId('lake-preset-stale')).toHaveCount(0);
	await expect(source).toHaveValue(/mm: 180 230 270 300 /);
	await expectNoViolations(page);
});

test('a viewer reads where the parameters came from, with nothing to fit and no save-as-you-go line', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Settings viewer');
	const viewer = await signIn('Settings viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 960 });
	await openSettings(v, project.id);
	await expect(fitSummary(v)).toHaveText('GR4J · no fit record: the parameters were set by hand or imported');
	// No fit record to show and nothing to fit: the header has no jump.
	await expect(header(v).getByRole('link', { name: /^Fit (the parameters|record)$/ })).toHaveCount(0);
	await expect(v.getByText(/save as you change them/)).toHaveCount(0);
	// The same one group link (API keys, an owner's panel, isn't on the page for a viewer).
	await expect(settingsMenu(v).getByRole('list', { name: 'Automation & access' }).getByRole('link')).toHaveText(['Automatic runs', 'Data feeds', 'Scheduled reports']);
	await expect(v.locator('#set-api-keys')).toHaveCount(0);
	await expect(anySaveBar(v)).toHaveCount(0);
});

test.describe('with a fitted example catchment', () => {
	test.describe.configure({ mode: 'serial' });
	test.beforeAll(async ({ playwright }) => {
		test.setTimeout(90_000);
		const api = await playwright.request.newContext();
		await seedExamplesOnce(api);
		await api.dispose();
	});

	async function openKleinberg(page: Page) {
		await page.goto('/login');
		await page.getByLabel('Email').fill(DEMO.email);
		await page.getByLabel('Password').fill(DEMO.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await page.locator('table.projects').getByRole('link', { name: KLEINBERG, exact: true }).click();
		await expect(page.getByTestId('section-header')).toBeVisible();
		await page.goto(`${page.url().split('?')[0]}?tab=settings`);
		await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeVisible();
	}

	test('the header names the fit and its score, and says when an edit leaves the fit behind; parameters show three decimals', async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 960 });
		await openKleinberg(page);
		const fitted = /^GR4J · fitted \d{1,2} [A-Z][a-z]{2} \d{4} · KGE′ \d\.\d\d in calibration$/;
		await expect(fitSummary(page)).toHaveText(fitted);
		// The header, the menu and the first panel are on the first screen.
		await expect(page.getByRole('heading', { level: 2, name: 'Simulation period' })).toBeInViewport();

		// A fit writes nine decimals; the field shows three and keeps the value (nothing to save).
		const x1 = page.getByLabel(/^Production store capacity X1/);
		await expect(x1).toHaveValue(/^\d+(\.\d{1,3})?$/);
		await expect(anySaveBar(page)).toHaveCount(0);

		// Editing a fitted parameter by hand: the line says the fit no longer describes the form, until discarded.
		await x1.fill('500');
		await expect(fitSummary(page)).toHaveText(/ · changed since the fit$/);
		await settingsBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
		await answerConfirm(page, true);
		await expect(fitSummary(page)).toHaveText(fitted);
		await expectNoViolations(page);
	});
});

test('a note or a quaternary lookup doesn’t save the settings: their forms aren’t nested in a settings form', async ({ page, owner }) => {
	void owner;
	await loadSyntheticQuaternaries();
	const project = await createProject(page.request, 'Settings nested forms');
	await openSettings(page, project.id);
	const patches: string[] = [];
	page.on('request', (r) => {
		if (isProjectPatch(r.method(), r.url())) patches.push(r.url());
	});
	await expect(page.locator('form form')).toHaveCount(0);
	await page.getByLabel('A-pan evaporation, Oct, mm').fill('150');
	await page.getByLabel('A-pan evaporation, Oct, mm').blur();
	await expect(settingsBar(page)).toBeVisible();

	// A note on Demand, added with its own form's Add note.
	await page.getByRole('button', { name: 'Add a note on Demand' }).click();
	const dialog = page.getByRole('dialog', { name: 'Notes on Demand' });
	await dialog.getByLabel('Add a note').fill('Trying the WR90 A-pan for this quaternary');
	await dialog.getByRole('button', { name: 'Add note' }).click();
	await expect(dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toContainText('Trying the WR90 A-pan');
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();

	// The quaternary lookup, submitted with Enter in its coordinates.
	const wr = page.getByRole('region', { name: /^WR2012 check/ });
	await wr.getByLabel('Compare runs with WR2012 naturalised flow').check();
	await wr.getByRole('button', { name: 'Propose from the map' }).click();
	await wr.getByLabel('Look up at').selectOption('typed');
	await wr.getByLabel('Latitude').fill('-33.61');
	await wr.getByLabel('Longitude').fill('21.34');
	await wr.getByLabel('Longitude').press('Enter');
	// Answered (a proposal, none, or an error): the lookup ran on its own.
	await expect(wr.getByTestId('quaternary-proposal').locator('[role="status"], [role="alert"]').first()).toBeVisible();

	// Neither saved the settings: they are still unsaved, and the A-pan is as stored.
	expect(patches).toEqual([]);
	await expect(settingsBar(page)).toBeVisible();
	await expect(page.getByLabel('A-pan evaporation, Oct, mm')).toHaveValue('150');
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings.apanMm[0];
	expect(stored).toBe(0);
});

test('with model and settings edits there is one save bar, one Discard, one reason field, and the reason is kept with the settings', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings one bar');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=transfers`);
	await page.getByLabel('Priority of transfer 1 (lower moves first)', { exact: true }).fill('3');
	await page.getByLabel('Priority of transfer 1 (lower moves first)', { exact: true }).blur();
	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeVisible();
	await page.getByLabel('A-pan evaporation, Oct, mm').fill('150');
	await page.getByLabel('A-pan evaporation, Oct, mm').blur();

	await expect(page.getByRole('region', { name: /^Unsaved / })).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(1);
	await expect(page.getByRole('button', { name: /^Save (changes|settings)$/ })).toHaveCount(1);
	await expect(page.getByRole('textbox', { name: 'Reason for this change (optional)' })).toHaveCount(1);
	await expect(anySaveBar(page)).toContainText('Unsaved changes to the model and the settings');
	// The header's badge counts the settings too.
	await expect(header(page).getByText('Unsaved changes', { exact: true })).toBeVisible();

	await page.getByRole('textbox', { name: 'Reason for this change (optional)' }).fill('WR90 A-pan for the quaternary');
	await saveSettings(page);
	const settings = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings;
	expect(settings.apanMm[0]).toBe(150);
	const model = await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json();
	expect(model.transfers[0].priority).toBe(3);
	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByText('WR90 A-pan for the quaternary').first()).toBeVisible();
});

test('a failed save says so in the save bar, beside Save, in view', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings save fails');
	await openSettings(page, project.id);
	await page.route(
		(url) => url.pathname.endsWith(`/projects/${project.id}`),
		(route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { error: 'The server is down for maintenance.' } }) : route.continue())
	);
	// Deep in the form: the automatic runs at the bottom.
	const wait = page.getByLabel('Wait after the latest new data (minutes)');
	await page.getByLabel('Re-run the model after new data').check();
	await wait.fill('30');
	await wait.blur();
	await saveChanges(page).click();
	const failed = settingsBar(page).getByText(/^Save failed: /);
	await expect(failed).toBeInViewport();
	await expect(saveChanges(page)).toBeInViewport();
	// Still unsaved, nothing lost.
	await expect(wait).toHaveValue('30');
});

test('on a phone the save bar keeps Discard and Save on one row, and stays short', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await createProject(page.request, 'Settings phone bar');
	await openSettings(page, project.id);
	await page.getByLabel('A-pan evaporation, Oct, mm').fill('150');
	await page.getByLabel('A-pan evaporation, Oct, mm').blur();
	const bar = settingsBar(page);
	const height = (await bar.boundingBox())!.height;
	expect(height).toBeLessThanOrEqual(200);
	const discard = (await bar.getByRole('button', { name: 'Discard', exact: true }).boundingBox())!;
	const save = (await bar.getByRole('button', { name: 'Save changes' }).boundingBox())!;
	expect(Math.abs(discard.y - save.y)).toBeLessThan(2);
	await expectNoSidewaysScroll(page);
});

test('on a phone a monthly row’s label takes a narrow column, so the months get the room', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await createProject(page.request, 'Settings phone months');
	await openSettings(page, project.id);
	const row = page.getByRole('row', { name: /^A-pan evaporation/ });
	const label = (await row.locator('th.sticky').boundingBox())!;
	const wrap = (await row.locator('xpath=ancestor::div[contains(@class, "table-wrap")][1]').boundingBox())!;
	expect(label.width).toBeLessThanOrEqual(wrap.width * 0.4);
	await expectNoSidewaysScroll(page);
});

test('the long panels’ sub-groups are headings, in the order shown, and Fit the parameters lands on its own heading', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings headings');
	await openSettings(page, project.id);
	// The headings on the page: a closed notes drawer's title (a dialog, in the DOM while shut) is not one.
	const names = (id: string) =>
		page
			.locator(`#${id}`)
			.locator('h2, h3')
			.evaluateAll((els) => els.filter((e) => !e.closest('dialog:not([open])')).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
	// The lazy panels first: Evaporation from the map, the quality flags and the flow gaps.
	await expect(page.locator('#set-flow').getByRole('heading', { name: 'Evaporation from the map' })).toBeVisible();
	await expect(page.locator('#set-record').getByRole('heading', { name: 'Flow gaps' })).toBeVisible();
	await expect(page.locator('#set-record').getByRole('heading', { name: /^Quality flags for Fit automatically/ })).toBeVisible();
	expect((await names('set-flow')).slice(0, 4)).toEqual([
		'Flow calibration',
		'Areal rainfall correction',
		'GR4J potential evaporation',
		'Evaporation from the map'
	]);
	expect(await names('set-rain')).toEqual([
		'Rain gaps',
		'CHIRPS bias correction and quantile map',
		'CHIRPS fit period',
		'Zero-rain runs in the catchment rain',
		'Multi-day accumulations',
		'Rain source periods'
	]);
	const record = await names('set-record');
	expect(record[0]).toBe('Calibration record');
	expect(record).toContain('Quality flags for Fit automatically');
	expect(record).toContain('Flow gaps');
	const fit = await names('set-fit');
	expect(fit[0]).toBe('Fit the parameters');
	expect(fit[1]).toBe('Fit automatically');

	// A link from elsewhere (a fresh load: from this same page, a goto would only move to the fragment).
	await page.goto('about:blank');
	await page.goto(`/projects/${project.id}?tab=settings#set-fit`);
	await expect(page.locator('#set-fit').getByRole('heading', { level: 2, name: 'Fit the parameters' })).toBeFocused();
});

test('every help tip on the page has its own name, and the annual assurance threshold isn’t part of the reporting window', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings tip names');
	await openSettings(page, project.id);
	await expect(page.getByRole('button', { name: /^About / }).first()).toBeVisible();
	const tips = await page.getByRole('button', { name: /^About / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
	const dupes = tips.filter((t, i) => tips.indexOf(t) !== i);
	expect(dupes).toEqual([]);
	const window = page.getByRole('group', { name: /^Curtailment reporting window/ });
	await expect(window.getByLabel(/^Annual assurance threshold/)).toHaveCount(0);
	await expect(page.getByLabel(/^Annual assurance threshold/)).toBeVisible();
});
