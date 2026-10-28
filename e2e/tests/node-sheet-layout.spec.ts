// The node sheet's folded form (issue #521): each section a card whose heading
// carries a line of its values, only the one the section menu points at open,
// the rarely changed fields under "More … settings", the fields the method
// doesn't use behind one "Not used …" line, and the explanations behind the
// "Explain each setting under its field" switch (still each field's
// description). Checked on the Showcase's Vleiplaas, whose sheet was 5,768 px
// of form before (72 fields, 48 help paragraphs): Save stays pinned on screen,
// a section opens from the menu, and the whole form is a couple of screens.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, openNodeSection } from '../support/network.ts';
import { expectFoldsNamed } from '../support/settings.ts';
import { seedShowcaseModel } from '../support/showcase.ts';

const sheetOf = (page: Page) => page.getByRole('dialog', { name: /^(?:Edit .*|.*: details)$/ });
const card = (sheet: Locator, title: string) => sheet.locator('details.sec').filter({ has: sheet.page().locator('summary > .sec-title', { hasText: new RegExp(`^${title}$`) }) });
/** The section cards open now, by their headings. */
const expectOpen = (sheet: Locator, titles: string[]) => expect(sheet.locator('details.sec[open] > summary > .sec-title')).toHaveText(titles);
/** The sheet's own scroll box: its height in px, and whether it scrolls sideways. */
const box = (sheet: Locator) => sheet.locator('.body').evaluate((el) => ({ height: el.scrollHeight, sideways: el.scrollWidth > el.clientWidth + 1 }));
/** In the window, top to bottom. */
async function inWindow(page: Page, el: Locator) {
	const r = (await el.boundingBox())!;
	const h = page.viewportSize()!.height;
	expect(r.y).toBeGreaterThanOrEqual(0);
	expect(r.y + r.height).toBeLessThanOrEqual(h);
}

test.describe.configure({ timeout: 120_000 });

test('a unit’s sheet folds to its sections, opens the one the menu points at, and keeps Save on screen', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const showcase = await seedShowcaseModel(page.request, 'Node sheet layout');
	await page.goto(`/projects/${showcase.id}?tab=network&edit=${showcase.nodeId('Vleiplaas')}`);
	const sheet = sheetOf(page);
	await expect(sheet).toBeVisible();

	// Folded: the first section open, every other one a line of its values; Save pinned in the window.
	await expectOpen(sheet, ['Catchment area']);
	await expect(card(sheet, 'Dam').getByTestId('node-section-summary')).toHaveText(/^300[\s ]000 m³ · starts 60 % · min 15 % · seepage 0 %\/day$/);
	await expect(card(sheet, 'Supply').getByTestId('node-section-summary')).not.toBeEmpty();
	await inWindow(page, sheet.getByRole('button', { name: 'Save changes' }));
	const folded = await box(sheet);
	expect(folded.sideways).toBe(false);
	// Was 5,768 px of form: now about two windows, with the dam, supply and every other section reachable from it.
	expect(folded.height).toBeLessThan(1_600);

	// The Catchment area section holds the area alone: the High-MAP and Low-MAP areas went with the flow-share methods
	// (engine 1.105.0, issue #616), so nothing there is "Not used" (a unit without a dam's dam fields still are).
	const area = card(sheet, 'Catchment area');
	await expect(area.getByLabel('Area (km²)')).toBeVisible();
	await expect(area.getByLabel('High-MAP (km²)')).toHaveCount(0);
	await expect(area.getByLabel('Low-MAP (km²)')).toHaveCount(0);
	await expect(area.locator('details.unused')).toHaveCount(0);

	// The section menu opens the Dam and folds the others, its heading focused and its first fields in the window.
	await sheet.getByRole('navigation', { name: 'Sections of the form' }).getByRole('link', { name: 'Dam', exact: true }).click();
	await expectOpen(sheet, ['Dam']);
	const dam = card(sheet, 'Dam');
	await expect(dam.locator(':scope > summary')).toBeFocused();
	const capacity = dam.getByLabel('Capacity (m³)');
	await inWindow(page, capacity);
	await inWindow(page, sheet.getByRole('button', { name: 'Save changes' }));

	// The help is the field's ⓘ and its description, under it only with the switch on.
	const help = dam.getByText(/^Full supply capacity of the hydrological unit’s dam\./);
	await expect(help).toBeHidden();
	await expect(capacity).toHaveAccessibleDescription(/^Full supply capacity of the hydrological unit’s dam\./);
	const explain = sheet.getByRole('checkbox', { name: 'Explain each setting under its field' });
	await explain.check();
	await expect(help).toBeVisible();
	await explain.uncheck();
	await expect(help).toBeHidden();

	// The rarely changed dam fields, folded into one line of their values.
	const more = dam.locator('details.more');
	await expect(more.locator('summary')).toContainText('More dam settings:');
	await expect(more.locator('summary')).toContainText('Area exponent 0.7');
	const seepage = dam.getByLabel('Seepage (%/day)');
	await expect(seepage).toBeHidden();
	await more.locator('summary').click();
	await expect(seepage).toBeVisible();
	await expect(seepage).toBeEditable();
	// Every fold in the sheet is the app's one fold: its values, the chevron and a named action (common/Fold.svelte).
	expect(await expectFoldsNamed(sheet)).toBeGreaterThan(0);

	// A closed card never hides a problem: an initial storage that isn't a number marks the Dam's heading.
	await expect(dam.locator(':scope > summary').getByText('needs fixing')).toBeHidden();
	// Its error line grows the field downward and moves nothing beside it (issue #521, round 6): the capacity, in
	// the same row, keeps its place.
	const capacityBefore = (await capacity.boundingBox())!;
	expect(Math.round(capacityBefore.y)).toBe(Math.round((await dam.getByLabel('Initial (%)').boundingBox())!.y));
	await dam.getByLabel('Initial (%)').fill('abc');
	await dam.getByLabel('Initial (%)').blur();
	await expect(dam.getByLabel('Initial (%)')).toHaveAttribute('aria-invalid', 'true');
	await expect(dam.locator('.num-err')).toBeVisible();
	expect((await capacity.boundingBox())!.y).toBeCloseTo(capacityBefore.y, 0);
	await dam.locator(':scope > summary').click();
	await expect(dam).not.toHaveAttribute('open', '');
	await expect(dam.locator(':scope > summary').getByText('needs fixing')).toBeVisible();
	await sheet.getByRole('button', { name: 'Discard model changes' }).click();
	await answerConfirm(page, true);
	await expect(dam.locator(':scope > summary').getByText('needs fixing')).toBeHidden();

	// A sheet opened on a node with a problem lands on the section that has it (the save bar's links name only the node).
	const supply = await openNodeSection(sheet, 'Supply');
	await supply.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'Run of river' });
	await expect(supply.getByRole('alert').first()).toBeVisible();
	await sheet.getByRole('navigation', { name: 'Sections of the form' }).getByRole('link', { name: 'Dam', exact: true }).click();
	await expectOpen(sheet, ['Dam']);
	await expect(card(sheet, 'Supply').locator(':scope > summary').getByText('needs fixing')).toBeVisible();
	await sheet.getByRole('button', { name: 'Done' }).click();
	await expect(sheet).toHaveCount(0);
	await openNodeForm(page, 'Vleiplaas', { folded: true });
	await expectOpen(sheet, ['Supply']);
	await sheet.getByRole('button', { name: 'Discard model changes' }).click();
	await answerConfirm(page, true);

	// A link that names a section (the Dams page's Edit dam, the node table's River to dam by month) opens on it.
	await page.goto(`/projects/${showcase.id}?tab=network&edit=${showcase.nodeId('Vleiplaas')}&section=routing`);
	await expectOpen(sheet, ['Routing']);
	await expect(card(sheet, 'Routing').locator(':scope > summary')).toBeInViewport();

	// ‹ › to the next unit keeps the section open: its dam.
	await openNodeSection(sheet, 'Dam');
	await sheet.getByRole('button', { name: 'Next hydrological unit' }).click();
	await expect(sheet).toHaveAccessibleName(/^Edit (?!Vleiplaas)/);
	await expect(card(sheet, 'Dam')).toHaveAttribute('open', '');

	// Show every field opens every section and fold, and is remembered on reload.
	await sheet.getByRole('button', { name: 'Show every field' }).click();
	await expect(sheet.locator('details.sec:not([open])')).toHaveCount(0);
	await expect(sheet.locator('details.fold:not([open])')).toHaveCount(0);
	await page.reload();
	await expect(sheetOf(page).getByRole('button', { name: 'Show every field' })).toHaveAttribute('aria-pressed', 'true');
	await expect(sheetOf(page).locator('details.sec:not([open])')).toHaveCount(0);
	await sheetOf(page).getByRole('button', { name: 'Show every field' }).click();
	await expect(sheetOf(page).locator('details.sec[open]')).not.toHaveCount(0);

	await expectNoViolations(page, { include: 'dialog[open]' });
});

test('on a phone the folded sheet stacks with no sideways scroll; an other water user’s sheet keeps its own card open', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const showcase = await seedShowcaseModel(page.request, 'Node sheet phone');
	await page.goto(`/projects/${showcase.id}?tab=network&edit=${showcase.nodeId('Vleiplaas')}`);
	const sheet = sheetOf(page);
	await expect(card(sheet, 'Dam')).toBeVisible();
	expect((await box(sheet)).sideways).toBe(false);
	await inWindow(page, sheet.getByRole('button', { name: 'Save changes' }));
	await expectNoViolations(page, { include: 'dialog[open]' });

	// The town: its user card always open, its boreholes and bed losses folded to their lines.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${showcase.id}?tab=network&edit=${showcase.nodeId('Dorp water works')}`);
	await expect(sheet.getByRole('group', { name: 'Other water user' }).getByLabel('Share returned (%)')).toBeVisible();
	await expectOpen(sheet, ['Combined boreholes (one capacity)']);
	await expect(card(sheet, 'Individual boreholes').getByTestId('node-section-summary')).toHaveText('None');
	expect((await box(sheet)).height).toBeLessThan(1_200);
});

test('a viewer reads the folded sheet: the summaries and folds open, every field read-only', async ({ page, owner, signIn }) => {
	void owner;
	const showcase = await seedShowcaseModel(page.request, 'Node sheet viewer');
	const viewer = await signIn('Node sheet viewer');
	await addMember(page.request, showcase.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 900 });
	await v.goto(`/projects/${showcase.id}?tab=network&edit=${showcase.nodeId('Vleiplaas')}`);
	const sheet = v.getByRole('dialog', { name: 'Vleiplaas: details' });
	await expect(card(sheet, 'Dam').getByTestId('node-section-summary')).toHaveText(/^300[\s ]000 m³/);
	const dam = await openNodeSection(sheet, 'Dam');
	await expect(dam.getByLabel('Capacity (m³)')).not.toBeEditable();
	await dam.locator('details.more > summary').click();
	await expect(dam.getByLabel('Seepage (%/day)')).not.toBeEditable();
	await expect(sheet.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});
