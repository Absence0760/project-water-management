// Settings → EWR, Reserve rule tables, Drought restrictions and Reporting, regrouped (issue #521), and the
// registered-volumes comparison band moved to Allocations. Each panel's actions are on screen at 1440×900 once the
// side index lands on it; the folds open; the shared paste dialog fills the EWR's TAB flows and a rule table's grid;
// the drought levels are one table with chips for the dates; and the band saves from its own card with the same
// settings PATCH the Settings save bar sends. Synthetic data.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectAbove, expectNoSidewaysScroll, layoutSettled, squashedChecks } from '../support/reflow.ts';
import { isProjectPatch, openFold, saveSettings, settingsMenu, showExplanations } from '../support/settings.ts';

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
const TAB = [0.47, 0.31, 0.22, 0.12, 0.06, 0.09, 0.2, 0.55, 0.9, 1.2, 0.95, 0.66];

async function seed(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, {
		ewrDailySource: { method: 'tab', scaling: 'area', tableMarMm3: 12.3, tableAreaKm2: 123, tabM3s: TAB, naturalPctM3s: null, reservePctM3s: null },
		ewrRules: [
			{
				siteNodeId: null,
				source: 'Synthetic determination, table 4',
				component: 'total',
				unit: 'mcm',
				points: POINTS,
				ewr: MONTHS.map(() => POINTS.map(() => 1)),
				lowFlow: MONTHS.map(() => POINTS.map(() => 0.5)),
				naturalSource: 'run',
				natural: null,
				scale: 1
			}
		],
		droughtRestriction: {
			reviewDates: ['10-01', '01-01'],
			liftDates: ['05-01'],
			levels: [
				{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.2, domestic: 0.1 } },
				{ label: 'Level 2', belowPct: 0.4, cuts: { crops: 0.4, domestic: 0.2 } },
				{ label: 'Level 3', belowPct: 0.25, cuts: { crops: 0.6, domestic: 0.3 } }
			]
		}
	});
	return project;
}

/** Land on a panel through the side index, as a reader does. */
async function jump(page: Page, name: string, hash: string) {
	await settingsMenu(page).getByRole('link', { name, exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`${hash}$`));
	await layoutSettled(page);
}

const box = async (l: Locator) => (await l.boundingBox())!;
const fitsItsBox = (l: Locator) => l.evaluate((el) => el.scrollWidth <= el.clientWidth);

test.describe('at 1440×900', () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test('EWR: the source and "Fill from" share a line, the TAB flows fit without scrolling, Paste… fills them through the dialog, and the moved settings are pointed to', async ({ page, owner }) => {
		void owner;
		const project = await seed(page, 'EWR layout');
		await page.goto(`/projects/${project.id}?tab=settings`);
		await jump(page, 'EWR', '#set-ewr');
		const daily = page.getByRole('group', { name: /^The daily EWR at the outlet/ });
		const source = daily.getByLabel('Daily EWR from');
		const fill = daily.getByTestId('ewr-daily-fill');
		const paste = fill.getByRole('button', { name: 'Paste…' });
		await expect(paste).toBeInViewport({ ratio: 1 });
		await expect(fill.getByText('Load a DRM file (.rul / .tab)')).toBeInViewport({ ratio: 1 });
		// One line: the buttons sit within the select's height.
		const s = await box(source);
		const p = await box(paste);
		expect(p.x).toBeGreaterThan(s.x + s.width);
		expect(Math.abs(p.y + p.height / 2 - (s.y + s.height / 2))).toBeLessThan(s.height / 2);
		// All twelve TAB months fit in their box at 1440, nothing scrolls sideways.
		const tab = daily.getByRole('table', { name: /^TAB flows: total flows/ });
		await expect(tab.getByLabel('TAB flow, Sep, m³/s')).toBeInViewport({ ratio: 1 });
		expect(await fitsItsBox(tab.locator('xpath=..'))).toBe(true);
		// The source's explanation is behind the switch; the stated modelled area stays.
		await expect(daily.getByText(/^The outlet’s daily EWR, which is split/)).toBeHidden();
		await expect(daily.getByText(/^Modelled area 20(\.0)? km²\./)).toBeVisible();
		await showExplanations(page);
		await expect(daily.getByText(/^The outlet’s daily EWR, which is split/)).toBeVisible();

		// Paste… opens the shared dialog: the preview counts the values, Apply fills them, unsaved.
		await paste.click();
		const dialog = page.getByRole('dialog', { name: 'Paste the TAB flows' });
		await dialog.getByLabel('Cells copied from a spreadsheet').fill('0.5 0.31 0.22 0.12 0.06 0.09 0.2 0.55 0.9 1.2 0.95 0.7');
		await expect(dialog.getByTestId('paste-summary')).toHaveText('2 values change; 10 already have the pasted value.');
		await expectNoViolations(page, { include: '[role="dialog"]' });
		await dialog.getByRole('button', { name: 'Apply 2 changes' }).click();
		await expect(dialog).toBeHidden();
		await expect(daily.getByRole('status', { name: 'Paste result', exact: true })).toHaveText('Filled the 12 TAB flows.');
		await expect(daily.getByLabel('TAB flow, Oct, m³/s')).toHaveValue('0.5');
		await saveSettings(page);

		// The band moved to Allocations: a pointer line; the reporting window and threshold are their own panel now.
		const ewr = page.locator('#set-ewr');
		// It lands on the band's card, as Find a setting's link does (issue #586, C7; settings-after-form-layout.spec.ts).
		await expect(ewr.getByTestId('ewr-band-moved').getByRole('link', { name: 'Allocations' })).toHaveAttribute('href', '?tab=allocations#alloc-band');
		await expect(ewr.getByLabel(/^Comparison band/)).toHaveCount(0);
		await expect(ewr.getByLabel(/^Annual assurance threshold/)).toHaveCount(0);
		await expect(page.getByTestId('summary-ewr')).toHaveText('Daily EWR from the DRM TAB file');
		await expectNoViolations(page, { include: '#set-ewr' });
	});

	test('Reporting: its own panel after Drought restrictions, with its values in one line', async ({ page, owner }) => {
		void owner;
		const project = await seed(page, 'Reporting layout');
		await updateSettings(page.request, project.id, { reportStart: '2021-11-01', reportEnd: '2021-12-31', assuranceAnnualThreshold: 0.85 });
		await page.goto(`/projects/${project.id}?tab=settings`);
		await jump(page, 'Reporting', '#set-reporting');
		const panel = page.getByRole('region', { name: 'Reporting', exact: true });
		await expect(panel.getByTestId('summary-reporting')).toHaveText(/^Reporting .+ · a water year is met at 85 % of demand$/);
		await expect(panel.getByRole('group', { name: /^Curtailment reporting window/ }).getByLabel('From', { exact: true })).toHaveValue('1 Nov 2021');
		await expect(panel.getByLabel(/^Annual assurance threshold/)).toBeInViewport({ ratio: 1 });
		await expect(panel.getByLabel(/^Annual assurance threshold/)).toHaveValue('85');
		// Right after Drought restrictions on the page.
		await expectAbove(page.getByRole('region', { name: /^Drought restrictions/ }).getByTestId('drought-restriction'), panel.getByRole('heading', { name: 'Reporting' }));
		// A window that ends before it starts blocks Save from here, and the save bar links to it.
		await panel.getByLabel('To', { exact: true }).fill('2021-10-01');
		await expect(page.getByRole('link', { name: /^Reporting: The reporting window must start before it ends\./ })).toHaveAttribute('href', '#set-reporting');
		await expectNoViolations(page, { include: '#set-reporting' });
	});

	test('Reserve rule tables: each table a card with Load file…, Paste… and Remove in its head, its settings folded, the paste dialog fills the picked grid', async ({ page, owner }) => {
		void owner;
		const project = await seed(page, 'Reserve layout');
		await page.goto(`/projects/${project.id}?tab=settings`);
		await jump(page, 'Reserve rule tables', '#set-reserve');
		const table = page.getByRole('group', { name: 'Rule table at Outlet (Outflow gauge)' });
		for (const name of ['Paste… into the rule table at Outlet (Outflow gauge)', 'Remove the rule table at Outlet (Outflow gauge)']) {
			await expect(table.getByRole('button', { name })).toBeInViewport({ ratio: 1 });
		}
		await expect(table.getByText('Load file…')).toBeInViewport({ ratio: 1 });
		// Site, source, REC and what it covers first; the rest folded into one line of its values.
		const fold = table.getByTestId('rule-settings');
		await expect(fold).not.toHaveAttribute('open');
		await expect(table.getByTestId('rule-settings-summary')).toHaveText('Mm³/month · the run’s natural flow · × 1 · 10–99 % (10 points)');
		await expect(table.getByLabel('% points')).toBeHidden();
		await expectAbove(table.getByLabel('Recommended ecological category (REC)'), fold.locator('summary'));
		await openFold(table, 'rule-settings');
		await expect(table.getByLabel('% points')).toBeVisible();
		await expect(fold.locator('summary')).toContainText('Hide');
		// The low-flow checkbox is full size, as every checkbox on the page.
		await expect(table.getByRole('checkbox', { name: /^Also enter the low flows/ })).toBeChecked();
		expect(await squashedChecks(page)).toEqual([]);

		// Paste…: pick the low flows, preview, Apply.
		await table.getByRole('button', { name: 'Paste… into the rule table at Outlet (Outflow gauge)' }).click();
		const dialog = page.getByRole('dialog', { name: 'Paste into the rule table at Outlet (Outflow gauge)' });
		await expect(dialog.getByRole('radio', { name: 'The EWR values' })).toBeChecked();
		await dialog.getByRole('radio', { name: 'The low flows' }).check();
		const rows = MONTHS.map((m, r) => [m, ...POINTS.map(() => (r === 3 ? '0.75' : '0.5'))].join('\t')).join('\n');
		await dialog.getByLabel('Cells copied from a spreadsheet').fill(rows);
		await expect(dialog.getByTestId('paste-summary')).toHaveText('10 values change; 110 already have the pasted value.');
		await dialog.getByRole('button', { name: 'Apply 10 changes' }).click();
		await expect(dialog).toBeHidden();
		await expect(table.getByLabel('Low flows (maintenance to drought), Jan, 50 %, Mm³')).toHaveValue('0.75');
		await expect(table.getByLabel('EWR (total flow), Jan, 50 %, Mm³')).toHaveValue('1');
		await expectNoViolations(page, { include: '#set-reserve' });
	});

	test('Drought restrictions: the levels are one table with Add a deeper level above it, the dates are chips, and the rule reads in one line with its wording folded', async ({ page, owner }) => {
		void owner;
		const project = await seed(page, 'Drought layout');
		await page.goto(`/projects/${project.id}?tab=settings`);
		await jump(page, 'Drought restrictions', '#set-restrict');
		const section = page.getByRole('region', { name: /^Drought restrictions/ });
		const add = section.getByRole('button', { name: 'Add a deeper level' });
		await expect(add).toBeInViewport({ ratio: 1 });
		await expectAbove(add, section.getByLabel('Level 1: starts below, % of capacity'));
		// A column per level, level with each other; the row names said once.
		const levels = section.getByTestId('restriction-level');
		const [a, b, c] = await Promise.all([0, 1, 2].map((i) => box(levels.nth(i))));
		expect(Math.abs(a!.y - b!.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(b!.y - c!.y)).toBeLessThanOrEqual(1);
		expect(b!.x).toBeGreaterThan(a!.x);
		// Each part's cuts sit in one row across the levels.
		const crops = await Promise.all([1, 2, 3].map((i) => box(section.getByLabel(`Level ${i}: cut on Crops (irrigation of the crop areas), %`))));
		expect(Math.abs(crops[0]!.y - crops[2]!.y)).toBeLessThanOrEqual(1);
		await expect(levels.locator('legend')).toHaveText(['Level 1', 'Level 2', 'Level 3']);
		expect(await fitsItsBox(section.getByTestId('restriction-levels').locator('xpath=..'))).toBe(true);

		// The rule in one line; its full wording behind it.
		await expect(section.getByTestId('restriction-short')).toHaveText('3 levels, below 60 / 40 / 25 % · reviewed 1 Oct, 1 Jan · lifted 1 May');
		await expect(section.getByTestId('restriction-words')).toBeHidden();
		await openFold(section, 'restriction-rule-fold');
		await expect(section.getByTestId('restriction-words')).toBeVisible();
		await expect(section.getByTestId('restriction-words')).toContainText('Level 1 (below 60 %): crops 20 %');

		// The dates are chips, each remove button named for its date.
		const reviews = section.getByTestId('restriction-reviewDates');
		await expect(reviews.getByTestId('restriction-date')).toHaveCount(2);
		const remove = reviews.getByRole('button', { name: 'Remove review date 2, 1 Jan' });
		expect((await box(remove)).width).toBeGreaterThanOrEqual(24);
		await remove.click();
		await expect(reviews.getByTestId('restriction-date')).toHaveCount(1);
		// The last review date can't go: no remove button on it.
		await expect(reviews.getByRole('button', { name: /^Remove review date/ })).toHaveCount(0);
		await expect(section.getByTestId('restriction-short')).toHaveText('3 levels, below 60 / 40 / 25 % · reviewed 1 Oct · lifted 1 May');
		await expectNoViolations(page, { include: '#set-restrict' });
	});
});

test('on a phone the drought levels stack as cards and the EWR panel stacks, with nothing scrolling sideways', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await seed(page, 'Settings phone');
	await page.goto(`/projects/${project.id}?tab=settings#set-restrict`);
	const levels = page.getByTestId('restriction-level');
	await expect(levels).toHaveCount(3);
	const [a, b] = await Promise.all([box(levels.nth(0)), box(levels.nth(1))]);
	expect(b.y).toBeGreaterThan(a.y + a.height - 1);
	// The level buttons go under the title, laid out on purpose: on one line, or one under the other at the same width.
	const section = page.getByRole('region', { name: /^Drought restrictions/ });
	const title = await box(section.getByRole('heading', { name: 'Levels, mildest first' }));
	const [add, rm] = await Promise.all([box(section.getByRole('button', { name: 'Add a deeper level' })), box(section.getByRole('button', { name: 'Remove the deepest level' }))]);
	expect(add.y).toBeGreaterThanOrEqual(title.y + title.height);
	if (Math.abs(add.y - rm.y) > 1) expect(Math.abs(add.width - rm.width)).toBeLessThanOrEqual(1);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page, { include: '#set-restrict' });
	await expectNoViolations(page, { include: '#set-ewr' });
	await expectNoViolations(page, { include: '#set-reserve' });
});

test('the comparison band saves from its card on Allocations with the settings PATCH, Settings takes it in, and a viewer reads it', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Band on Allocations');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${project.id}?tab=allocations`);
	const card = page.getByRole('region', { name: 'Comparison band' });
	await expect(card.getByTestId('settings-allocation-mode')).toHaveText('Compare only');
	const band = card.getByLabel(/^Comparison band/);
	await expect(band).toHaveValue('10');
	// The read-only mode and the band sit on one line.
	const [mode, field] = await Promise.all([box(card.getByTestId('settings-allocation-mode')), box(band)]);
	expect(Math.abs(mode.y + mode.height / 2 - (field.y + field.height / 2))).toBeLessThanOrEqual(2);
	const save = card.getByRole('button', { name: 'Save', exact: true });
	await expect(save).toBeDisabled();
	await band.fill('15');
	await band.blur();
	const patch = page.waitForRequest((r) => isProjectPatch(r.method(), r.url()));
	await save.click();
	expect((await patch).postDataJSON()).toEqual({ settings: { allocationTolerance: 0.15 } });
	await expect(card.getByTestId('allocation-band-status')).toHaveText('Saved. The comparison reads with the new band.');
	await expect(save).toBeDisabled();
	await expectNoViolations(page, { include: '[data-testid="allocation-band"]' });

	// Stored as the project's setting; Settings saves on top of it without putting the old value back.
	const read = async () => ((await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { project: { settings: { allocationTolerance: number } } }).project.settings.allocationTolerance;
	expect(await read()).toBe(0.15);
	await page.getByRole('link', { name: 'Settings & calibration' }).first().click();
	const pragmatic = page.getByLabel('Pragmatic EWR, Oct, m³/day');
	await pragmatic.fill('2100');
	await pragmatic.blur();
	await saveSettings(page);
	expect(await read()).toBe(0.15);

	// A viewer reads the band, with no Save.
	const viewer = await signIn('Band viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=allocations`);
	const seen = viewer.page.getByRole('region', { name: 'Comparison band' });
	await expect(seen.getByLabel(/^Comparison band/)).toHaveValue('15');
	// Read-only, not disabled (NumberInput), so a keyboard viewer still reaches it.
	await expect(seen.getByLabel(/^Comparison band/)).toHaveAttribute('readonly', '');
	await expect(seen.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
});
