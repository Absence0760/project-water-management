// Settings → Flow calibration and Calibration record, regrouped (issue #521). Flow calibration: three cards (GR4J
// parameters with "Fit the parameters" in its head and the warm-up folded into one line, Rain into GR4J, Potential
// evaporation with the row's fill tools folded) and Evaporation from the map as a card of its own; the rain threshold
// for demand now under Demand. Calibration record: the window, Compare with and the exclusions first, "Exclude…" in the
// list's header row, then one line of the quality-flag values that opens the gauged ranges (a table), the day rules,
// the river-stop months and gap filling. Synthetic data.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, layoutSettled, resizeTo, squashedChecks } from '../support/reflow.ts';
import { openFold, settingsMenu, showExplanations } from '../support/settings.ts';

const flow = (page: Page) => page.locator('#set-flow');
const record = (page: Page) => page.locator('#set-record');
const box = async (l: Locator) => (await l.boundingBox())!;

async function openProject(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, {
		runoffModel: 'gr4j',
		calibrationExclusions: [{ waterYear: 2015, reason: 'Rain gauge moved' }]
	});
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(flow(page).getByTestId('flow-gr4j-card')).toBeVisible();
	return project;
}

async function jump(page: Page, name: string, hash: string) {
	await settingsMenu(page).getByRole('link', { name, exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`#${hash}$`));
	await layoutSettled(page);
}

test('at 1440×900 Flow calibration opens on its parameters with the jump to the fit in the card’s head, and its folds open in place', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	await openProject(page, 'Flow layout');
	await jump(page, 'Flow calibration', 'set-flow');
	const gr4j = flow(page).getByTestId('flow-gr4j-card');
	// The card's head: its name and its action on one row; the three parameters and the warm-up line on the first screen.
	const link = gr4j.getByTestId('flow-fit-link');
	await expect(link).toBeInViewport({ ratio: 1 });
	const title = await box(gr4j.getByRole('heading', { name: 'GR4J parameters' }));
	expect(Math.abs((await box(link)).y + (await box(link)).height / 2 - (title.y + title.height / 2))).toBeLessThan(12);
	for (const l of [/^Production store capacity X1/, /^Routing store capacity X3/, /^Unit hydrograph time base X4/]) await expect(gr4j.getByLabel(l)).toBeInViewport();
	await expect(gr4j.getByTestId('flow-more').locator('summary')).toBeInViewport({ ratio: 1 });

	// The warm-up folds into its value; opened, the field is there, and the line follows it.
	await expect(gr4j.getByTestId('flow-more-summary')).toHaveText('warm-up 365 days');
	await expect(gr4j.getByLabel(/^Warm-up/)).toBeHidden();
	await openFold(gr4j, 'flow-more');
	await gr4j.getByLabel(/^Warm-up/).fill('730');
	await expect(gr4j.getByTestId('flow-more-summary')).toHaveText('warm-up 730 days');

	// The rain threshold for demand lives under Demand now (issue #521).
	await expect(flow(page).getByLabel(/^Rain threshold for demand/)).toHaveCount(0);
	await expect(page.locator('#set-demand').getByLabel(/^Rain threshold for demand/)).toHaveValue('2');

	// The pan row stays in view; its fill tools fold under one line that names the source.
	const pe = flow(page).getByTestId('flow-pe-card');
	await expect(pe.getByLabel('Pan coefficient, Oct')).toBeVisible();
	await expect(pe.getByLabel('Pan-coefficient preset', { exact: true })).toBeHidden();
	await openFold(pe, 'pan-tools');
	await expect(pe.getByLabel('Pan-coefficient preset', { exact: true })).toBeVisible();
	await expect(pe.getByRole('button', { name: 'Paste from a spreadsheet…' })).toBeVisible();

	// The cards in order, each with its heading.
	await expect(flow(page).locator(':scope > .sub-card')).toHaveCount(4);
	await expect(flow(page).getByTestId('flow-rain-card').getByRole('heading', { level: 3 })).toHaveText('Rain into GR4J');
	await expect(flow(page).getByTestId('flow-evaporation-card').getByRole('heading', { name: 'Evaporation from the map' })).toBeVisible();
	expect(await squashedChecks(page)).toEqual([]);
});

test('with the explanations on, the rain-for-each-unit explanation sits on its own line under its switch', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	await openProject(page, 'Flow explain');
	await showExplanations(page);
	const unitRain = flow(page).getByTestId('unit-rain-settings');
	const label = await box(unitRain.locator('label.check'));
	const hint = await box(unitRain.locator('.hint.explain').first());
	expect(hint.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
	expect(Math.abs(hint.x - label.x)).toBeLessThanOrEqual(1);
});

test('at 1440×900 the Calibration record opens on the window and the exclusions, with Exclude… in the list’s header row', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	await openProject(page, 'Record layout');
	await jump(page, 'Calibration record', 'set-record');
	const rec = record(page);
	const excl = rec.getByRole('group', { name: /^Calibration exclusions/ });
	const add = excl.getByRole('button', { name: 'Exclude a water year' });
	await expect(add).toBeInViewport({ ratio: 1 });
	await expect(excl.getByRole('button', { name: 'Exclude a date range' })).toBeInViewport({ ratio: 1 });
	// Beside the legend, above the rows, not under them.
	const legend = await box(excl.locator('.head .legend'));
	const button = await box(add);
	expect(button.y).toBeLessThan(legend.y + legend.height);
	expect(button.y + button.height).toBeGreaterThan(legend.y);
	expect(button.y).toBeLessThan((await box(excl.getByLabel('Reason'))).y);
	await expect(rec.getByLabel('Compare with')).toBeInViewport();

	// The quality flags fold into one line of their values, on the same screen.
	const flags = rec.getByTestId('record-flags');
	await expect(flags.locator('summary')).toBeInViewport({ ratio: 1 });
	await expect(rec.getByTestId('record-flags-summary')).toHaveText(
		'gauged range not known · above-range days censored · below-range, suspect and infilled days left out · no river-stop months · flow gaps not filled'
	);
	await expect(rec.getByLabel('Suspect days')).toBeHidden();
	await openFold(rec, 'record-flags');

	// The gauged ranges: one row per record under named columns.
	const ranges = rec.getByRole('table', { name: 'Gauged range of each record' });
	await expect(ranges.getByRole('columnheader')).toHaveText(['Record', /^Highest gauging/, /^Lowest gauging/, 'Source']);
	await expect(ranges.getByRole('rowheader')).toHaveText(['Gauge record']);

	// The longest day rule shows whole, not cut ("Censor: only ask the model tc").
	const censor = rec.getByLabel('Days above the highest gauging');
	const fits = await censor.evaluate((el: HTMLSelectElement) => {
		const c = document.createElement('canvas').getContext('2d')!;
		const cs = getComputedStyle(el);
		c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
		const text = c.measureText(el.options[el.selectedIndex]!.text).width;
		// The text, its left padding and the drop-down arrow's room.
		return text + parseFloat(cs.paddingLeft) + 20 <= el.clientWidth;
	});
	expect(fits).toBe(true);

	// The river-stop months: named toggles with All months straight after them, as Allocations' months.
	const months = rec.getByRole('group', { name: 'Months the river stops' });
	const sep = await box(months.getByRole('checkbox', { name: 'Sep', exact: true }));
	const all = await box(months.getByRole('button', { name: 'Months the river stops: all months' }));
	expect(Math.abs(all.y + all.height / 2 - (sep.y + sep.height / 2))).toBeLessThan(6);
	expect(all.x - (sep.x + sep.width)).toBeLessThan(40);
	await months.getByRole('button', { name: 'Months the river stops: all months' }).click();
	await expect(rec.getByTestId('record-flags-summary')).toContainText('river stops Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec');

	// A field inside that needs fixing shows on the line, also once folded.
	await rec.getByLabel(/^Gauge record: highest gauging/).fill('0.3');
	await expect(flags.getByText('needs fixing')).toBeVisible();
	await flags.locator('summary').click();
	await expect(flags).not.toHaveAttribute('open');
	await expect(flags.getByText('needs fixing')).toBeVisible();
	expect(await squashedChecks(page)).toEqual([]);
});

test('Find a setting reaches a folded field in both panels: it opens the fold and focuses the field', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	await openProject(page, 'Flow record find');
	const find = page.getByRole('searchbox', { name: 'Find a setting' });
	await find.fill('Infilled days');
	await find.press('Enter');
	await expect(record(page).getByTestId('record-flags')).toHaveAttribute('open', '');
	await expect(record(page).getByLabel('Infilled days')).toBeFocused();
});

test('Fit automatically holds the WR2012 MAR penalty beside its choices, and the rules’ run sits in the rules’ head', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	await openProject(page, 'Fit penalty layout');
	const card = page.getByTestId('fit-now-card');
	// No WR2012 reference yet: the penalty says what it needs, with a link to it.
	await expect(card.getByTestId('mar-penalty-off')).toContainText('Needs a WR2012 reference MAR');
	await expect(card.getByTestId('mar-penalty-off').getByRole('link', { name: 'WR2012 check' })).toHaveAttribute('href', '#set-wr2012');
	// The search fields show their digits grouped, as the line does.
	await openFold(card, 'fit-search');
	await expect(card.getByLabel('Model runs per fit')).toHaveValue(/^1\s500$/);
	// Typed into, the whole number is replaced, not appended to the plain digits the field swaps in to edit.
	await card.getByLabel('Model runs per fit').fill('2000');
	await card.getByLabel('Model runs per fit').blur();
	await expect(card.getByLabel('Model runs per fit')).toHaveValue(/^2\s000$/);
	await expect(card.getByTestId('fit-search-summary')).toHaveText(/^Wide bounds · 2\s000 runs × 5 starts · seed 1$/);
	// The rules' run in the head, with the state and the sign-off, above the rules' groups.
	const head = page.getByTestId('rules-head');
	const run = head.getByRole('button', { name: 'Run the calibration rules' });
	await expect(run).toBeVisible();
	expect((await box(run)).y).toBeLessThan((await box(page.getByTestId('rules-try'))).y);
});

test('a viewer sees no Exclude… or Use buttons, and can open the folds to read the values', async ({ page, owner, signIn }) => {
	void owner;
	const project = await openProject(page, 'Flow record viewer');
	const viewer = await signIn('Flow record viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.setViewportSize({ width: 1440, height: 900 });
	await viewer.page.goto(`/projects/${project.id}?tab=settings`);
	await expect(record(viewer.page).getByRole('button', { name: 'Exclude a water year' })).toHaveCount(0);
	await expect(viewer.page.getByRole('button', { name: 'Run the calibration rules' })).toHaveCount(0);
	await openFold(record(viewer.page), 'record-flags');
	await expect(record(viewer.page).getByLabel('Suspect days')).toBeDisabled();
	await openFold(flow(viewer.page), 'flow-more');
	await expect(flow(viewer.page).getByLabel(/^Warm-up/)).not.toBeEditable();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(colorScheme, () => {
		test.use({ colorScheme });
		test(`both panels with their folds open have no violations, at 1440 and on a phone (${colorScheme})`, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize({ width: 1440, height: 900 });
			await openProject(page, `Flow record a11y ${colorScheme}`);
			await openFold(flow(page), 'flow-more');
			await openFold(flow(page), 'pan-tools');
			await openFold(record(page), 'record-flags');
			await expectNoViolations(page, { include: '#set-flow' });
			await expectNoViolations(page, { include: '#set-record' });

			await resizeTo(page, { width: 390, height: 844 });
			await expectNoSidewaysScroll(page);
			expect(await squashedChecks(page)).toEqual([]);
			// Stacked: the exclusions' buttons still come before the rows.
			const excl = record(page).getByRole('group', { name: /^Calibration exclusions/ });
			expect((await box(excl.getByRole('button', { name: 'Exclude a date range' }))).y).toBeLessThan((await box(excl.getByLabel('Reason'))).y);
			await expectNoViolations(page, { include: '#set-flow' });
			await expectNoViolations(page, { include: '#set-record' });
		});
	});
}
