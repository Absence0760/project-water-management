// The Settings & calibration page (?tab=settings, issue #17 option A). A reading page: the long form scrolls,
// under the section header, which says where the GR4J parameters came from (the fit's day and in-sample score,
// or that there is no fit record) and carries "Fit the parameters", a jump to Fit automatically. The sticky menu
// is grouped (model inputs · how results are read · runs, feeds and reports) and also links API keys (owners)
// and Scheduled reports, which save on their own, as a line above them says. Synthetic data, plus the invented
// example catchments for a real fit record.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, updateSettings } from '../support/api.ts';
import { DEMO, KLEINBERG, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { fitSummary, header, openSettings, settingsMenu } from '../support/settings.ts';

const AFTER_FORM = 'Data feeds, API keys and scheduled reports save as you change them, not with Save settings.';

test('the header says there is no fit record and jumps to Fit automatically; the menu is grouped and reaches the panels after the form', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Settings page');
	await openSettings(page, project.id);

	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(fitSummary(page)).toHaveText('GR4J · no fit record: the parameters were set by hand or imported');
	const jump = header(page).getByRole('link', { name: 'Fit the parameters', exact: true });
	await expect(jump).toHaveAttribute('href', '#set-fit');
	await expect(header(page).getByRole('button', { name: 'Run model', exact: true })).toBeVisible();
	// The old intro paragraph is gone: the header and the menu's groups say it.
	await expect(page.getByText(/^Grouped by what each setting drives/)).toHaveCount(0);

	// The menu's three groups, each a list named for screen readers, in page order.
	const menu = settingsMenu(page);
	for (const [name, first, last] of [
		['Model inputs', 'Demand', 'Data quality'],
		['How results are read', 'Outcome matrix', 'Evidence'],
		['Automation & access', 'Automation & access', 'Automation & access']
	] as const) {
		const links = menu.getByRole('list', { name, exact: true }).getByRole('link');
		await expect(links.first()).toHaveText(first);
		await expect(links.last()).toHaveText(last);
	}
	// Automatic runs, Data feeds, API keys and Scheduled reports behind one link, so the bar fits two rows at 1280 px.
	await expect(menu.getByRole('list', { name: 'Automation & access' }).getByRole('link')).toHaveText(['Automation & access']);

	// The jump lands on the fit panel, below the sticky menu, and the menu marks it.
	await jump.click();
	await expect(page).toHaveURL(/\?tab=settings#set-fit$/);
	const fit = page.locator('#set-fit');
	await expect(fit.getByRole('heading', { name: 'Fit automatically' })).toBeInViewport();
	expect((await fit.boundingBox())!.y).toBeGreaterThanOrEqual((await menu.boundingBox())!.y + (await menu.boundingBox())!.height - 1);
	await expect(menu.getByRole('link', { name: 'Fit automatically' })).toHaveAttribute('aria-current', 'location');

	// The panels after the form: the line says they save on their own; the menu's group link lands on the first of them.
	await expect(page.getByText(AFTER_FORM, { exact: true })).toBeVisible();
	const automation = menu.getByRole('link', { name: 'Automation & access' });
	await automation.click();
	await expect(page).toHaveURL(/#set-auto$/);
	await expect(page.getByRole('heading', { level: 2, name: 'Automatic runs' })).toBeInViewport();
	await expect(automation).toHaveAttribute('aria-current', 'location');

	// Back returns to the fragment before, on the same page.
	await page.goBack();
	await expect(page).toHaveURL(/#set-fit$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Settings & calibration' })).toBeVisible();

	// Each panel keeps its own anchor, so a link to it still lands, with the group's link marked. Data feeds is a
	// lazy chunk: its anchor is on a wrapper that is always there.
	for (const [id, name] of [
		['set-report-schedules', 'Scheduled reports'],
		['set-api-keys', 'API keys'],
		['set-feeds', 'Data feeds']
	] as const) {
		await page.goto(`/projects/${project.id}?tab=settings#${id}`);
		await expect(page.locator(`#${id}`).getByRole('heading', { level: 2, name, exact: true })).toBeInViewport();
		await expect(automation).toHaveAttribute('aria-current', 'location');
	}
});

test('a link into a group (?tab=calibration, a note’s #set- link) opens the page on that group, below the menu', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await createProject(page.request, 'Settings links');
	await page.goto(`/projects/${project.id}?tab=calibration#set-ewr`);
	await expect(page.getByRole('heading', { level: 1, name: 'Settings & calibration' })).toBeVisible();
	const ewr = page.getByRole('heading', { name: 'Environmental water requirement (EWR)' });
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
	const preset = page.getByLabel('Dam evaporation preset');
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
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

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
	await expect(settingsMenu(v).getByRole('list', { name: 'Automation & access' }).getByRole('link')).toHaveText(['Automation & access']);
	await expect(v.locator('#set-api-keys')).toHaveCount(0);
	await expect(v.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
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
		await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeInViewport();

		// A fit writes nine decimals; the field shows three and keeps the value (nothing to save).
		const x1 = page.getByLabel(/^Production store capacity X1/);
		await expect(x1).toHaveValue(/^\d+(\.\d{1,3})?$/);
		await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();

		// Editing a fitted parameter by hand: the line says the fit no longer describes the form, until discarded.
		await x1.fill('500');
		await expect(fitSummary(page)).toHaveText(/ · changed since the fit$/);
		await page.getByRole('button', { name: 'Discard' }).click();
		await expect(fitSummary(page)).toHaveText(fitted);
		await expectNoViolations(page);
	});
});
