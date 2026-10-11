// Settings → Rain gaps, Data quality and the WR2012 check (issue #521 sections 4, 8 and 9): a group that is at its
// defaults is one line of its values that opens to edit them (common/Fold.svelte with `atDefaults`, ui-playbook.md § 2);
// Rain gaps is two cards with each list's add actions in its own head row, under their own names; the CHIRPS check
// heads its own group; WR2012's "Propose from the map" is in the panel's head and its judging folds. Synthetic data.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, layoutSettled, squashedChecks } from '../support/reflow.ts';
import { openFold, showExplanations } from '../support/settings.ts';

const box = async (l: Locator) => (await l.boundingBox())!;

async function openAt(page: Page, projectId: string, id: string) {
	await page.goto(`/projects/${projectId}?tab=settings#${id}`);
	await expect(page.locator(`#${id}`).getByRole('heading', { level: 2 }).first()).toBeInViewport();
	await layoutSettled(page);
}

test.describe('at 1440×900', () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test('Rain gaps at its defaults is one line; opened, two cards whose actions sit in their heads, every add button named for its list', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Rain gaps layout');
		await openAt(page, project.id, 'set-rain');
		const panel = page.locator('#set-rain');
		const fold = panel.getByTestId('rain-defaults');
		await expect(fold).not.toHaveAttribute('open');
		await expect(fold.locator('summary')).toHaveText(/^All defaults:\s*bias-corrected per month, whole record, zero runs missing, accumulations spread\s*needs fixing\s*Change$/);
		await expect(fold.locator('summary')).toBeInViewport({ ratio: 1 });
		await expect(panel.getByLabel('CHIRPS bias correction', { exact: true })).toBeHidden();

		await openFold(page, 'rain-defaults');
		const chirps = panel.getByTestId('chirps-fit-period');
		const flagged = panel.getByTestId('flagged-rain-card');
		await expect(chirps.getByRole('heading', { level: 3, name: 'CHIRPS gap filling' })).toBeVisible();
		await expect(flagged.getByRole('heading', { level: 3, name: 'Flagged rain' })).toBeVisible();
		// The proposal's button in the CHIRPS card's head, level with its title, on the first screen.
		const propose = chirps.getByRole('button', { name: 'Propose from the double-mass breaks' });
		await expect(propose).toBeInViewport({ ratio: 1 });
		const title = await box(chirps.getByRole('heading', { name: 'CHIRPS gap filling' }));
		const btn = await box(propose);
		expect(Math.abs(btn.y + btn.height / 2 - (title.y + title.height / 2))).toBeLessThan(12);
		// The bias correction comes before the fit period, in the same card.
		expect((await box(chirps.getByLabel('CHIRPS bias correction', { exact: true }))).y).toBeLessThan((await box(chirps.getByLabel('CHIRPS fit period', { exact: true }))).y);

		// Each list's add buttons in its head row, beside its name; no two buttons in the panel share a name.
		for (const [list, year, range] of [
			['Keep dry', 'Keep a water year dry', 'Keep a date range dry'],
			['Also treat as missing', 'Add a missing water year', 'Add a missing date range'],
			['Keep as recorded', "Keep a water year's readings", "Keep a date range's readings"],
			['Also spread', 'Spread a water year', 'Spread a date range']
		] as const) {
			const group = flagged.getByRole('group', { name: new RegExp(`^${list}`) });
			const name = await box(group.getByText(list, { exact: true }));
			for (const label of [year, range]) {
				const b = await box(group.getByRole('button', { name: label, exact: true }));
				expect(Math.abs(b.y + b.height / 2 - (name.y + name.height / 2)), `${label} beside ${list}`).toBeLessThan(12);
			}
		}
		const rs = await box(flagged.getByRole('heading', { level: 4, name: 'Rain source periods' }));
		const add = await box(flagged.getByRole('button', { name: 'Add a rain-source period' }));
		expect(Math.abs(add.y + add.height / 2 - (rs.y + rs.height / 2))).toBeLessThan(12);
		const names = await panel.getByRole('button').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim() ?? ''));
		expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);

		// A change leaves the defaults: the line says what is set, and the fold stays open.
		await flagged.getByLabel('Flagged zero runs').selectOption('asRecorded');
		await expect(fold.locator('summary')).toHaveText(/^Now:\s*bias-corrected per month, whole record, zero runs as recorded, accumulations spread/);
		await expect(fold).toHaveAttribute('open', '');
		await expectNoViolations(page);
	});

	test('a closed Rain gaps line says when something inside needs fixing', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Rain gaps problem');
		await openAt(page, project.id, 'set-rain');
		await openFold(page, 'rain-defaults');
		const missing = page.getByRole('group', { name: /^Also treat as missing/ });
		await missing.getByRole('button', { name: 'Add a missing water year' }).click();
		const fold = page.getByTestId('rain-defaults');
		await fold.locator('summary').click();
		await expect(fold).not.toHaveAttribute('open');
		await expect(fold.locator('.fold-problem')).toBeVisible();
	});

	test('Data quality at its defaults is one line; Change the limits opens the groups, and the CHIRPS check heads its own', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Data quality layout');
		await openAt(page, project.id, 'set-quality');
		const panel = page.getByTestId('data-quality-settings');
		const fold = panel.getByTestId('quality-limits');
		await expect(fold).not.toHaveAttribute('open');
		await expect(fold.locator('summary')).toHaveText(
			/^Default limits:\s*gauge\/logger 66\.7–150 % · outliers × 5 \/ × 10 · flat stretches 5–90 days · zero runs 60 wet-season days · low vs CHIRPS below 50 %\s*needs fixing\s*Change the limits$/
		);
		await expect(fold.getByText('Change the limits')).toBeInViewport({ ratio: 1 });
		await expect(panel.getByLabel('Lowest gauge/logger ratio (%)')).toBeHidden();

		await openFold(panel, 'quality-limits');
		await expect(fold.locator('.fold-change')).toHaveText('Hide');
		await expect(panel.getByLabel('Lowest gauge/logger ratio (%)')).toBeInViewport();
		// The CHIRPS check is a group of its own, named by its box; what it decides is indented under its words.
		await showExplanations(page);
		const gate = panel.getByRole('group', { name: 'Check each zero-rain run against CHIRPS' });
		const check = gate.getByRole('checkbox', { name: 'Check each zero-rain run against CHIRPS' });
		await expect(check).not.toBeChecked();
		const hint = await box(gate.getByText(/^When CHIRPS read at least half its usual rain/));
		expect(hint.x).toBeGreaterThan((await box(check)).x + 10);
		// The low-vs-CHIRPS limits don't depend on it: outside its group.
		await expect(gate.getByLabel(/^Low vs CHIRPS/)).toHaveCount(0);
		await expect(panel.getByLabel(/^Low vs CHIRPS/)).toBeVisible();
		await expectNoViolations(page);
	});

	test('WR2012: Propose from the map is in the head, the judging is one line that opens, and the MAR penalty has moved', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'WR2012 layout');
		await openAt(page, project.id, 'set-wr2012');
		const section = page.getByRole('region', { name: /^WR2012 check/ });
		await section.getByLabel('Compare runs with WR2012 naturalised flow').check();
		const head = section.locator('.panel-head');
		await expect(head.getByRole('button', { name: 'Propose from the map' })).toBeInViewport({ ratio: 1 });
		// The quaternary's fields come first, the judging after the monthly table, folded.
		const fold = section.getByTestId('wr2012-judging');
		await expect(fold).not.toHaveAttribute('open');
		await expect(fold.locator('summary')).toHaveText(/^How the check judges:\s*area ratio · dry season from each run · note 10 % \/ query 25 % \(15 % wetter\) \/ unusable 50 %\s*needs fixing\s*Change$/);
		expect((await box(fold)).y).toBeGreaterThan((await box(section.getByLabel('WR2012 monthly mean, Sep, Mm³'))).y);
		await expect(section.getByLabel('Scale the reference by')).toBeHidden();
		await openFold(section, 'wr2012-judging');
		await expect(section.getByLabel('Scale the reference by')).toBeVisible();
		await expect(section.getByLabel(/^Note it/)).toBeVisible();
		// The help line under the MAP is an explanation: the grid's row stays even with the switch off.
		await expect(section.getByText(/^Mean annual precipitation\. Enables the rainfall scaling/)).toBeHidden();
		await expect(section.getByLabel(/^Quaternary MAP/)).toHaveAccessibleDescription(/^Mean annual precipitation\./);
		// The soft MAR penalty is switched on in Fit the parameters: here only an explanation says so.
		await expect(section.getByLabel('Add a soft penalty on the MAR when fitting automatically')).toHaveCount(0);
		await showExplanations(page);
		await expect(section.getByTestId('wr2012-penalty-moved').getByRole('link', { name: 'Fit the parameters' })).toBeVisible();
		await expectNoViolations(page);
	});
});

test('a viewer opens the folds and reads the values, with no add buttons', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Defaults viewer');
	const viewer = await signIn('Defaults viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 900 });
	await openAt(v, project.id, 'set-rain');
	await openFold(v, 'rain-defaults');
	await expect(v.getByLabel('Flagged zero runs')).toBeDisabled();
	for (const name of ['Propose from the double-mass breaks', 'Keep a water year dry', 'Add a missing water year', "Keep a water year's readings", 'Spread a water year', 'Add a rain-source period'])
		await expect(v.locator('#set-rain').getByRole('button', { name, exact: true })).toHaveCount(0);
	await openFold(v, 'quality-limits');
	// A NumberInput is read-only for a viewer (kept focusable), not disabled.
	await expect(v.getByLabel('Lowest gauge/logger ratio (%)')).not.toBeEditable();
});

test('on a phone the folds open with no sideways scroll and no a11y violations', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await createProject(page.request, 'Defaults phone');
	await openAt(page, project.id, 'set-rain');
	await openFold(page, 'rain-defaults');
	await openFold(page, 'quality-limits');
	await expectNoSidewaysScroll(page);
	expect(await squashedChecks(page)).toEqual([]);
	await expectNoViolations(page);
});
