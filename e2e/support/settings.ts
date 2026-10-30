// The Model settings page (?tab=settings, issue #17 option A; Settings & calibration until issue #586 round 3) and the Calibration page's settings panels: locators
// the specs share. Invented data only.
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const header = (page: Page) => page.getByTestId('section-header');
export const settingsMenu = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });
/** The header's line: where the GR4J parameters came from. */
export const fitSummary = (page: Page) => header(page).getByTestId('fit-summary');

export async function openSettings(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=settings`);
	await expect(page.getByRole('heading', { level: 1, name: 'Model settings' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeVisible();
}

/**
 * Opens the Calibration page (?tab=calibration), whose "Set up the fit" holds Flow calibration, Calibration record,
 * Fit the parameters and the WR2012 check (issue #586 round 3; they were on Settings until then), and waits for them.
 */
export async function openCalibration(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=calibration`);
	await expect(page.getByRole('heading', { level: 1, name: 'Calibration', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Fit the parameters' })).toBeVisible();
}

/**
 * The workspace's one save bar (frontend model/SaveBar.svelte), named for
 * what is unsaved: "Unsaved settings" with only the settings, "Unsaved model
 * changes" once the model has edits too, "Unsaved changes" with only a number
 * that needs fixing. Neither settings page has a save bar of its own (docs/ui.md §
 * Model settings).
 */
export const settingsBar = (page: Page) => page.getByRole('region', { name: 'Unsaved settings' });
export const anySaveBar = (page: Page) => page.getByRole('region', { name: /^Unsaved / });
/** The save bar's Save changes. */
export const saveChanges = (page: Page) => anySaveBar(page).getByRole('button', { name: 'Save changes' });

/** A PATCH of the project (the settings' save), as `page.waitForRequest`/`page.on('request')` see it. */
export const isProjectPatch = (method: string, url: string) => method === 'PATCH' && /\/projects\/[^/]+$/.test(new URL(url).pathname);

/**
 * Clicks the save bar's Save changes and waits until the settings are saved:
 * the project's PATCH answered 200 and the bar said "Changes saved.".
 */
export async function saveSettings(page: Page) {
	const saved = page.waitForResponse((r) => isProjectPatch(r.request().method(), r.url()));
	await saveChanges(page).click();
	expect((await saved).status()).toBe(200);
	await expect(page.getByTestId('savebar-announcement')).toHaveText('Changes saved.');
	await expect(anySaveBar(page)).toHaveCount(0);
}

/**
 * Turns on Settings' "Explain each setting under its field" (issue #468): the explanations under the
 * fields are hidden until it is on (it is remembered in the browser's storage, so a fresh context starts off).
 */
export async function showExplanations(page: Page) {
	const sw = page.getByRole('checkbox', { name: 'Explain each setting under its field' });
	await sw.check();
	await expect(sw).toBeChecked();
}

/**
 * Opens a fold of rarely changed settings (a `<details>` whose summary line shows their values, ui-playbook.md
 * § 2): Fit automatically's search (`fit-search`), the calibration rules' search budget (`rules-search`), Flow
 * calibration's warm-up (`flow-more`) and the pan row's fill tools (`pan-tools`), the Calibration record's quality
 * flags (`record-flags`), a Reserve rule table's settings (`rule-settings`), the drought restriction rule's wording
 * (`restriction-rule-fold`), or a group that starts closed while it is at its defaults (`atDefaults`): Rain gaps'
 * two cards (`rain-defaults`), Data quality's limits (`quality-limits`) and the WR2012 check's judging
 * (`wr2012-judging`), and Parameters from's units (`unit-params-fold`, issue #659). Every one is `common/Fold.svelte`.
 * Does nothing when it is already open.
 */
export type FoldId =
	| 'fit-search'
	| 'rules-search'
	| 'flow-more'
	| 'pan-tools'
	| 'record-flags'
	| 'rule-settings'
	| 'restriction-rule-fold'
	| 'rain-defaults'
	| 'quality-limits'
	| 'wr2012-judging'
	| 'feb-advanced'
	| 'ewr-scaled'
	| 'pan-coefficient-helper'
	| 'fit-record-fold'
	| 'ewr-tab-file'
	| 'rule-grids-repeat'
	| 'unit-params-fold';
export async function openFold(scope: Page | Locator, testId: FoldId) {
	const fold = scope.getByTestId(testId);
	// Its own summary: a fold can hold another <details> (the pan row's tools hold the FAO-56 helper).
	const summary = fold.locator(':scope > summary');
	await expect(summary).toBeVisible();
	if ((await fold.getAttribute('open')) === null) await summary.click();
	await expect(fold).toHaveAttribute('open', '');
}

/**
 * Every fold in `scope` keeps the playbook's line (ui-playbook.md § 2, "Rarely changed settings fold into their
 * values"; common/Fold.svelte): a visible summary that names its values (a non-empty line after the group's
 * name), the app's one chevron before it, and a visible named action after it ("Hide" while open). Returns how
 * many it checked, so a caller can say it found some.
 */
export async function expectFoldsNamed(scope: Page | Locator): Promise<number> {
	const folds = await scope.locator('details.fold:visible').all();
	for (const fold of folds) {
		const summary = fold.locator(':scope > summary');
		const parts = await summary.evaluate((el) => {
			const spans = [...el.children].filter((c) => !c.matches('.fold-name, .fold-problem, .fold-change, .visually-hidden'));
			return {
				line: spans.map((c) => c.textContent?.trim() ?? '').join(' ').trim(),
				marker: getComputedStyle(el, '::before').borderRightWidth,
				action: (el.querySelector(':scope > .fold-change') as HTMLElement | null)?.innerText.trim() ?? ''
			};
		});
		const id = (await fold.getAttribute('data-testid')) ?? (await summary.innerText());
		expect(parts.line, `${id}: the line of its values`).not.toBe('');
		expect(parts.marker, `${id}: the fold chevron`).toBe('2px');
		expect(parts.action, `${id}: its named action`).not.toBe('');
		if ((await fold.getAttribute('open')) !== null) expect(parts.action, `${id}: open, it says Hide`).toBe('Hide');
	}
	return folds.length;
}

/**
 * A closed fold's name, values and action share one row: the values may wrap inside their own box, but they start
 * on the name's row and the action sits beside them, not orphaned on a row of its own (issue #586, C14).
 */
export async function expectFoldOnOneRow(fold: Locator) {
	const summary = fold.locator(':scope > summary');
	const [name, line, action] = await Promise.all(
		['.fold-name', '.fold-line', '.fold-change'].map(async (sel) => (await summary.locator(`:scope > ${sel}`).boundingBox())!)
	);
	const overlaps = (a: { y: number; height: number }, b: { y: number; height: number }) => a.y < b.y + b.height && b.y < a.y + a.height;
	expect(overlaps(name!, line!), 'the values start on the name’s row').toBe(true);
	expect(overlaps(action!, line!), 'the action is beside the values').toBe(true);
	expect(action!.x, 'the action after the values').toBeGreaterThanOrEqual(line!.x + line!.width - 1);
}

/** The accessible names that two or more visible buttons in `scope` share (none, by the playbook's head-row rule). */
export async function sharedButtonNames(scope: Locator): Promise<string[]> {
	const names = await scope.getByRole('button').evaluateAll((els) =>
		els
			.filter((e) => (e as HTMLElement).checkVisibility?.() ?? !!(e as HTMLElement).offsetParent)
			.map((e) => {
				const by = e.getAttribute('aria-labelledby');
				const named = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ') : null;
				return (named ?? e.getAttribute('aria-label') ?? e.textContent ?? '').replace(/\s+/g, ' ').trim();
			})
	);
	return [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
}
