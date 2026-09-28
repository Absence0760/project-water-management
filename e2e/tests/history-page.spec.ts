// The History page (?tab=history, WP-2.4; issue #17 option A): the section header says what changed last, by
// whom and when; the unit and kind filters are in the URL (`unit=`, `kind=`, Back steps through them); in a wide
// column the timeline is a list of rows beside the picked change (`entry=`, else the newest) with its
// differences from the saved inputs now, and from 1100 × 620 the card fills the window with the list scrolling
// inside it; on a phone each entry shows whole. The restore flows themselves are in history.spec.ts.
// Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { spreadHistoryOverDays } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';
import { historyCard, historyContext, historyDetail, historyEntries, LONG_REASON, openHistory, seedLongHistory } from '../support/history.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const rowLink = (page: Page, n: number) => historyEntries(page).nth(n).getByRole('link');
const list = (page: Page) => historyCard(page).locator('.list');

test('forty changes over ten days: the header names the latest, the card fills the window, the rows scroll inside it', async ({ page, owner }) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const p = await seedLongHistory(page.request, 'History page big', 40);
	await spreadHistoryOverDays(p.id, 4);
	await openHistory(page, p.id);

	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
	// The seeding's 4 entries (model, settings, two series) and 40 more, the newest a dam capacity save (step 39, the cycle's fourth).
	await expect(historyEntries(page)).toHaveCount(44);
	await expect(historyContext(page)).toHaveText(new RegExp(`^Latest change today \\d\\d:\\d\\d by ${owner.displayName}: Model changed · recorded since \\d+ \\w{3} \\d{4}$`));
	// Four a day: eleven days, newest first.
	const dated = /^\d+ \w{3} \d{4}$/;
	await expect(historyCard(page).locator('.list').getByRole('heading', { level: 3 })).toHaveText(['Today', 'Yesterday', ...Array<RegExp>(9).fill(dated)]);

	// With nothing in the URL the newest is picked, and the URL stays as it was (Back leaves the section).
	await expect(rowLink(page, 0)).toHaveAttribute('aria-current', 'true');
	await expect(page).not.toHaveURL(/entry=/);
	await expect(historyDetail(page).getByRole('heading', { level: 2 })).toHaveText('Model changed');
	await expect(historyDetail(page)).toContainText('Upper farm: dam capacity 242\u202f500 m³ → 250\u202f000 m³');
	await expect(historyDetail(page)).toContainText('Reason: Back to the licence figure');
	await expect(historyDetail(page).getByTestId('history-differences')).toContainText('None: the saved inputs match this version.');

	// A row says who, what, the first line and the reason, in one line each.
	const withReason = historyEntries(page).filter({ hasText: LONG_REASON }).first();
	await expect(withReason).toContainText(owner.displayName);
	await expect(withReason).toContainText('Upper farm: dam capacity');

	// The card reaches the window's bottom; the page doesn't scroll, the list does, inside the card.
	const card = (await historyCard(page).boundingBox())!;
	expect(card.y + card.height).toBeLessThanOrEqual(960);
	expect(card.y + card.height).toBeGreaterThan(960 - 40);
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(960);
	expect(await list(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	await expect(historyDetail(page)).toBeInViewport();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page);
});

test('the picked change is in the URL: Back returns, a reload keeps it, Newer and Older step, a deep link scrolls its row into view', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 800 });
	const p = await seedLongHistory(page.request, 'History page pick', 30);
	await openHistory(page, p.id);

	// The third entry (change 27 of 30, newest first: area, series, then this): a dam capacity save.
	const third = historyEntries(page).nth(2);
	await expect(third).toContainText('Upper farm: dam capacity');
	await rowLink(page, 2).click();
	await expect(page).toHaveURL(/entry=revision\d+/);
	const picked = new URL(page.url()).searchParams.get('entry')!;
	await expect(rowLink(page, 2)).toHaveAttribute('aria-current', 'true');
	await expect(historyDetail(page).getByRole('heading', { level: 2 })).toHaveText('Model changed');
	await expect(historyDetail(page)).toContainText('Upper farm: dam capacity');
	// Its differences from now: what restoring it would change, in words.
	const diffs = historyDetail(page).getByTestId('history-differences');
	await expect(diffs.getByRole('heading', { name: 'Differences from now' })).toBeVisible();
	await expect(diffs).toContainText('what restoring it would change');
	await expect(diffs.getByRole('listitem').first()).toContainText('Changed');

	await page.reload();
	await expect(rowLink(page, 2)).toHaveAttribute('aria-current', 'true');
	await page.goBack();
	await expect(page).not.toHaveURL(/entry=/);
	await expect(rowLink(page, 0)).toHaveAttribute('aria-current', 'true');
	await page.goForward();
	await expect(page).toHaveURL(new RegExp(`entry=${picked}`));

	await historyDetail(page).getByRole('link', { name: 'Older', exact: true }).click();
	await expect(rowLink(page, 3)).toHaveAttribute('aria-current', 'true');
	await historyDetail(page).getByRole('link', { name: 'Newer', exact: true }).click();
	await historyDetail(page).getByRole('link', { name: 'Newer', exact: true }).click();
	await historyDetail(page).getByRole('link', { name: 'Newer', exact: true }).click();
	await expect(rowLink(page, 0)).toHaveAttribute('aria-current', 'true');
	await expect(historyDetail(page).getByRole('link', { name: 'Newer', exact: true })).toHaveCount(0);

	// A link to an old change: its row is brought into view inside the list, and the page isn't scrolled.
	const last = await historyEntries(page).last().getByRole('link').getAttribute('href');
	const key = new URLSearchParams(last!).get('entry')!;
	await openHistory(page, p.id, `&entry=${key}`);
	await expect(historyEntries(page).last().getByRole('link')).toHaveAttribute('aria-current', 'true');
	await expect(historyEntries(page).last()).toBeInViewport();
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
	await expect(historyDetail(page).getByRole('link', { name: 'Older', exact: true })).toHaveCount(0);

	// An entry that isn't there any more shows the newest.
	await openHistory(page, p.id, '&entry=revision0');
	await expect(rowLink(page, 0)).toHaveAttribute('aria-current', 'true');
});

test('the filters are in the URL: Back steps through them, the parameter filter narrows, and an empty filter says so', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 800 });
	const p = await seedLongHistory(page.request, 'History page filters', 12);
	await openHistory(page, p.id);
	const context = await historyContext(page).textContent();
	const filters = historyCard(page).getByRole('group', { name: 'Filter the history' });

	// 4 seeded and 12 changes: the rain series replaced twice (steps 4, 10), and 2 created by the seeding.
	await filters.getByLabel('Kind of change').selectOption({ label: 'Data series' });
	await expect(page).toHaveURL(/kind=series/);
	await expect(historyEntries(page)).toHaveCount(4);
	await expect(historyEntries(page).first()).toContainText('Replaced the Rainfall — catchment series');
	await expect(historyDetail(page).getByRole('heading', { level: 2 })).toHaveText('Data series');
	// The header still names the latest change of all.
	await expect(historyContext(page)).toHaveText(context!);

	await filters.getByLabel('Kind of change').selectOption({ label: 'Model and settings' });
	await filters.getByLabel('Unit').selectOption({ label: 'Upper farm' });
	await expect(page).toHaveURL(new RegExp(`kind=revision.*unit=${p.upper}|unit=${p.upper}.*kind=revision`));
	await expect(historyEntries(page).filter({ hasText: 'Lower farm: irrigation efficiency' })).toHaveCount(0);
	await expect(historyEntries(page).filter({ hasText: 'Upper farm: dam capacity' })).toHaveCount(4);

	await page.goBack();
	await expect(page).not.toHaveURL(/unit=/);
	await expect(filters.getByLabel('Unit')).toHaveValue('');
	await expect(filters.getByLabel('Kind of change')).toHaveValue('revision');
	await page.goBack();
	await expect(page).toHaveURL(/kind=series/);
	await page.goBack();
	await expect(page).not.toHaveURL(/kind=/);
	await expect(historyEntries(page)).toHaveCount(16);

	await filters.getByLabel('Parameter').fill('irrigation efficiency');
	await expect(historyEntries(page)).toHaveCount(2);
	await filters.getByLabel('Parameter').fill('no such thing');
	await expect(page.getByTestId('history-empty')).toHaveText('Nothing matches these filters.');
	await expect(historyDetail(page)).toHaveCount(0);

	// An unknown kind, or a unit that isn't in the model, is no filter.
	await openHistory(page, p.id, '&kind=nonsense&unit=00000000-0000-0000-0000-000000000000');
	await expect(historyEntries(page)).toHaveCount(16);
	await expect(filters.getByLabel('Kind of change')).toHaveValue('');
});

test('a restore from the detail picks the restore itself; nothing recorded says since when', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const p = await seedLongHistory(page.request, 'History page restore', 3);
	await openHistory(page, p.id, '');
	await rowLink(page, 2).click();
	await expect(historyDetail(page).getByTestId('history-differences').getByRole('listitem')).not.toHaveCount(0);
	await historyDetail(page).getByRole('button', { name: 'Restore this version' }).click();
	const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
	await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'Restored the version of' })).toBeVisible();
	await expect(page).not.toHaveURL(/entry=/);
	await expect(historyDetail(page).getByRole('heading', { level: 2 })).toHaveText('Earlier version restored');
	await expect(historyContext(page)).toContainText(': Earlier version restored');
	await expect(historyDetail(page).getByTestId('history-differences')).toContainText('None: the saved inputs match this version.');

	const empty = await createProject(page.request, 'History page empty');
	await openHistory(page, empty.id);
	await expect(page.getByTestId('history-empty')).toHaveText(/^No changes recorded yet\. History starts from \d+ \w{3} \d{4}\.$/);
	await expect(historyContext(page)).toHaveText(/^No changes recorded yet · recorded since \d+ \w{3} \d{4}$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expectNoViolations(page);
});

test('a viewer reads the picked change and its differences, with no restore buttons', async ({ page, owner, signIn }) => {
	void owner;
	const p = await seedLongHistory(page.request, 'History page viewer', 6);
	const viewer = await signIn('History page viewer');
	await addMember(page.request, p.id, viewer.user.email, 'viewer');
	await viewer.page.setViewportSize({ width: 1440, height: 960 });
	// The inputs sections are behind "Show model inputs" for a viewer, but a History link still opens it.
	await openHistory(viewer.page, p.id);
	await expect(historyEntries(viewer.page).first()).toContainText('Added History page viewer as viewer');
	await rowLink(viewer.page, 1).click();
	const diffs = historyDetail(viewer.page).getByTestId('history-differences');
	await expect(diffs).toContainText('From the saved inputs now to this version.');
	await expect(diffs).not.toContainText('restoring');
	await expect(viewer.page.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
	await expect(historyCard(viewer.page)).not.toContainText('Restoring a version');
	await expectNoViolations(viewer.page);
});

test('on a phone each entry shows whole, with its restore button, and nothing scrolls sideways', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const p = await seedLongHistory(page.request, 'History page phone', 8);
	await openHistory(page, p.id);
	await expect(historyDetail(page)).toHaveCount(0);
	const newest = historyEntries(page).first();
	await expect(newest).toContainText('Model changed');
	await expect(newest.getByRole('button', { name: 'Restore this version' })).toBeVisible();
	const box = (await newest.getByRole('button', { name: 'Restore this version' }).boundingBox())!;
	expect(box.height).toBeGreaterThanOrEqual(44);
	// The two selects share a row; the parameter box has its own.
	const filters = historyCard(page).getByRole('group', { name: 'Filter the history' });
	const unit = (await filters.getByLabel('Unit').boundingBox())!;
	const kind = (await filters.getByLabel('Kind of change').boundingBox())!;
	expect(Math.abs(unit.y - kind.y)).toBeLessThan(2);
	await filters.getByLabel('Kind of change').selectOption({ label: 'Data series' });
	await expect(page).toHaveURL(/kind=series/);
	await expect(historyEntries(page).first()).toContainText('Replaced the Rainfall — catchment series');
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
});

test('past fifty changes, Show older changes at the foot of the list loads the rest', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const p = await seedLongHistory(page.request, 'History page older', 52);
	await openHistory(page, p.id);
	// A page is 50 items; each of these changes is one.
	await expect(historyEntries(page)).toHaveCount(50);
	const more = historyCard(page).getByRole('button', { name: 'Show older changes' });
	await more.scrollIntoViewIfNeeded();
	await more.click();
	await expect(historyEntries(page)).toHaveCount(56);
	await expect(more).toHaveCount(0);
	// The pick stays put while the list grows.
	await expect(rowLink(page, 0)).toHaveAttribute('aria-current', 'true');
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('the old ?tab=changes link opens History', async ({ page, owner }) => {
	void owner;
	const p = await seedLongHistory(page.request, 'History page alias', 1);
	await page.goto(`/projects/${p.id}?tab=changes`);
	await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
	await expect(historyEntries(page).first()).toBeVisible();
});
