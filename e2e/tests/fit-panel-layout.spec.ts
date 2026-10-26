// Calibration → Fit the parameters (2026-10-10; on Settings until issue #586 round 3): two cards, each with its main action where it is seen.
// Fit automatically: the choices that decide the fit (objective, parameters, validation), the search folded
// into one line of its values, and the button straight under them, on the first screen once the section is
// open, and the fit record at the card's foot. Calibration rules: the revision, sign-off state, fit count, the
// sign-off and the run in the card's head, the
// fields in four named groups, its search budget folded the same way. Synthetic data.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, layoutSettled, resizeTo, squashedChecks } from '../support/reflow.ts';
import { header, openFold, settingsBar } from '../support/settings.ts';

const fitCard = (page: Page) => page.getByRole('region', { name: /^Fit automatically/ });
const rulesCard = (page: Page) => page.getByTestId('calibration-rules');
const fitButton = (page: Page) => fitCard(page).getByRole('button', { name: 'Fit automatically', exact: true });

async function openFitSection(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(rulesCard(page).getByTestId('rules-status')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Run the calibration rules' })).toBeVisible();
	return project;
}

const box = async (l: Locator) => (await l.boundingBox())!;

for (const size of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 }
]) {
	test(`at ${size.width}×${size.height} the header's jump shows Fit automatically's button, and the rules' head and fields fit one window`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize(size);
		await openFitSection(page, `Fit layout ${size.width}`);
		await header(page).getByRole('link', { name: 'Fit the parameters', exact: true }).click();
		await expect(page).toHaveURL(/#set-fit$/);
		await layoutSettled(page);
		// The button is on the first screen of the section, straight under the choices and the search line,
		// at the card's content edge (the action-row rule).
		await expect(fitButton(page)).toBeInViewport({ ratio: 1 });
		const objective = await box(fitCard(page).getByLabel('Objective'));
		const validate = await box(fitCard(page).getByRole('checkbox', { name: /^Validate/ }));
		const search = await box(fitCard(page).getByTestId('fit-search'));
		const button = await box(fitButton(page));
		expect(Math.abs(button.x - objective.x)).toBeLessThanOrEqual(1);
		expect(search.y).toBeGreaterThan(validate.y);
		expect(button.y).toBeGreaterThanOrEqual(search.y + search.height);
		expect(button.y - (search.y + search.height)).toBeLessThan(24);
		await expect(fitCard(page).getByTestId('fit-runs')).toHaveText(/runs in all\.$/);

		// The rules' head holds the state and the sign-off; with the head at the top of the window, the whole
		// editor (its last line is the search budget) is on screen too, so the sign-off is never far away.
		const rules = rulesCard(page);
		await rules.getByTestId('rules-head').evaluate((el) => el.scrollIntoView({ block: 'start' }));
		await layoutSettled(page);
		await expect(rules.getByRole('button', { name: 'Sign off these rules' })).toBeInViewport({ ratio: 1 });
		// The rules' run is the card's main action, in its head beside the sign-off (issue #521, Fit follow-up 2).
		await expect(rules.getByTestId('rules-run').getByRole('button', { name: 'Run the calibration rules' })).toBeInViewport({ ratio: 1 });
		await expect(rules.getByTestId('rules-fits')).toBeInViewport({ ratio: 1 });
		await expect(rules.getByTestId('rules-search').locator('summary')).toBeInViewport({ ratio: 1 });
		// The four groups, in order, each named.
		await expect(rules.locator(':scope > .groups > fieldset > legend')).toHaveText(['What to try', 'Which fit to keep', 'When data arrives']);
		// The fourth, folded: a closed <details> keeps its fields out of the accessibility tree, not out of the page.
		await expect(rules.getByTestId('rules-search').locator('legend')).toHaveText('Search budget');
		expect(await squashedChecks(page)).toEqual([]);
	});
}

test('the search folds into its values: the line follows the fields, opens in place, and says when a field inside needs fixing', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	await openFitSection(page, 'Fit fold');
	const fit = fitCard(page);
	const fold = fit.getByTestId('fit-search');
	const line = fit.getByTestId('fit-search-summary');
	await expect(line).toHaveText(/^Wide bounds · 1\s500 runs × 5 starts · seed 1$/);
	await expect(fold).not.toHaveAttribute('open');
	await expect(fit.getByLabel('Seed')).toBeHidden();
	const summary = fold.locator('summary');
	await summary.click();
	await expect(fit.getByLabel('Seed')).toBeVisible();
	await fit.getByLabel('Starts').fill('2');
	await fit.getByLabel('Bounds', { exact: true }).selectOption('typical');
	await expect(line).toHaveText(/^Typical \(Perrin et al\. 80 %\) bounds · .+ runs × 2 starts · seed 1$/);
	// A seed it can't take: the line says so, also once folded, until it is fixed.
	await fit.getByLabel('Seed').fill('abc');
	await fit.getByLabel('Seed').blur();
	await expect(fold.getByText('needs fixing')).toBeVisible();
	await summary.click();
	await expect(fold).not.toHaveAttribute('open');
	await expect(fold.getByText('needs fixing')).toBeVisible();
	await summary.click();
	await fit.getByLabel('Seed').fill('3');
	await fit.getByLabel('Seed').blur();
	await expect(fold.getByText('needs fixing')).toBeHidden();
	await expect(line).toHaveText(/ · seed 3$/);
	await expect(fitButton(page)).toBeEnabled();
	// The fit's choices are the session's, never the form's: no save bar.
	await expect(settingsBar(page)).toHaveCount(0);

	// The rules' search budget the same way; a change there is a rule change, saved with the form.
	const rules = rulesCard(page);
	const budget = rules.getByTestId('rules-search-summary');
	await expect(budget).toHaveText(/^.+ runs × 5 starts · seed 1$/);
	await expect(rules.getByLabel('Starts per fit')).toBeHidden();
	await openFold(rules, 'rules-search');
	await rules.getByLabel('Starts per fit').fill('1');
	await expect(budget).toHaveText(/^.+ runs × 1 start · seed 1$/);
	await expect(rules.getByTestId('rules-search-note')).toHaveText(
		'The seed, starts and model runs are rules too: trying another seed after a result is a rule change, with its own revision.'
	);
	await expect(settingsBar(page)).toBeVisible();
});

// Find a setting is Model settings' (the Calibration page has no find box since the fit's panels moved there, issue
// #586 round 3), so its reach into a folded field is checked on a fold that stayed: Demand's days in February.
test('Find a setting reaches a folded field: it opens the fold and focuses the field', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await openFitSection(page, 'Fit find');
	await expect(page.getByRole('searchbox', { name: 'Find a setting' })).toHaveCount(0);
	await page.goto(`/projects/${project.id}?tab=settings`);
	const feb = page.getByTestId('feb-advanced');
	await expect(feb).not.toHaveAttribute('open');
	const find = page.getByRole('searchbox', { name: 'Find a setting' });
	await find.fill('Days in February');
	await find.press('Enter');
	await expect(feb).toHaveAttribute('open', '');
	await expect(page.getByRole('spinbutton', { name: 'Days in February' })).toBeFocused();
});

test('a viewer sees the rules’ state in the head with no sign-off, and can open the folds to read the search', async ({ page, owner, signIn }) => {
	void owner;
	const project = await openFitSection(page, 'Fit viewer layout');
	const viewer = await signIn('Fit layout viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.setViewportSize({ width: 1440, height: 900 });
	await viewer.page.goto(`/projects/${project.id}?tab=calibration`);
	const rules = rulesCard(viewer.page);
	await expect(rules.getByTestId('rules-status')).toContainText('Revision 1 · draft');
	await expect(rules.getByTestId('rules-sign-off')).toHaveCount(0);
	await openFold(rules, 'rules-search');
	// A NumberInput a viewer can't change is read-only.
	await expect(rules.getByLabel('Seed')).not.toBeEditable();
	await openFold(fitCard(viewer.page), 'fit-search');
	await expect(fitCard(viewer.page).getByLabel('Seed')).toBeEditable();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(colorScheme, () => {
		test.use({ colorScheme });
		test(`both cards with their folds open have no violations, at 1440 and on a phone (${colorScheme})`, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize({ width: 1440, height: 900 });
			await openFitSection(page, `Fit a11y ${colorScheme}`);
			await openFold(fitCard(page), 'fit-search');
			await openFold(rulesCard(page), 'rules-search');
			await expectNoViolations(page, { include: '#set-fit' });

			await resizeTo(page, { width: 390, height: 844 });
			await expectNoSidewaysScroll(page);
			expect(await squashedChecks(page)).toEqual([]);
			// Stacked: the button still follows the search line, the sign-off follows the state.
			const search = await box(fitCard(page).getByTestId('fit-search'));
			expect((await box(fitButton(page))).y).toBeGreaterThan(search.y + search.height - 1);
			const status = await box(rulesCard(page).getByTestId('rules-status'));
			expect((await box(rulesCard(page).getByRole('button', { name: 'Sign off these rules' }))).y).toBeGreaterThan(status.y);
			await expectNoViolations(page, { include: '#set-fit' });
		});
	});
}
