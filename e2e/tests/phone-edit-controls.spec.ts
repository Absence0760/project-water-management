// The workspace's edit controls on a phone (issue #521 round 5, docs/ui.md, docs/design/ui-playbook.md § 2): the
// model-edit sheets' save row and the page's save bar are one row of buttons, the Project members are one row of
// two lines each with nothing cut off, the fields in grids and forms are at least 24 px and 44 px where they stand
// alone, a table that scrolls sideways keeps its row names at the left and shows that there is more, the fit record
// folds into its line on a phone. The 12 px floor for small text is text-floor.spec.ts's (every tab). Synthetic data only.
import type { Locator } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedManyAllocations } from '../support/allocations.ts';
import { addMember, createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, layoutSettled, resizeTo } from '../support/reflow.ts';
import { anySaveBar, openFold, saveSettings } from '../support/settings.ts';

const PHONES = [
	{ width: 390, height: 844 },
	{ width: 360, height: 740 },
	{ width: 320, height: 640 }
];

/** The heights of every visible field (not a tick box) in `scope`. */
const fieldHeights = (scope: Locator) =>
	scope.evaluate((el) =>
		[...el.querySelectorAll<HTMLElement>('input:not([type="checkbox"], [type="radio"], [type="hidden"]), select')]
			.filter((f) => f.getClientRects().length > 0 && f.checkVisibility())
			.map((f) => ({ name: f.getAttribute('aria-label') ?? f.id, h: f.getBoundingClientRect().height }))
	);

test.describe('the save row of a model-edit sheet', () => {
	for (const size of PHONES)
		test(`is one row of three buttons at ${size.width} px, with nothing above it until there is something to save`, async ({ page, owner }) => {
			void owner;
			const p = await seedRunnableProject(page.request, `Save row ${size.width}`);
			const unit = p.model.nodes.find((n) => n.kind === 'farm')!;
			await page.setViewportSize(size);
			await page.goto(`/projects/${p.id}?tab=network&edit=${unit.id}`);
			const sheet = page.getByRole('dialog', { name: `Edit ${unit.name}` });
			const row = sheet.locator('.save');
			const buttons = [row.getByRole('button', { name: 'Discard model changes' }), row.getByRole('button', { name: 'Done', exact: true }), row.getByRole('button', { name: 'Save changes' })];
			for (const b of buttons) await expect(b).toBeVisible();
			await layoutSettled(page);
			// Clean: about 60 px (it was three rows, 144 px); the status is there for a screen reader.
			expect((await row.boundingBox())!.height).toBeLessThanOrEqual(64);
			await expect(row.getByText('No unsaved changes')).toBeAttached();
			const tops = async () => Promise.all(buttons.map(async (b) => Math.round((await b.boundingBox())!.y)));
			expect(new Set(await tops()).size).toBe(1);
			for (const b of buttons) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
			// With a change: the status and the reason show, the buttons still one row.
			await sheet.getByLabel('Name', { exact: true }).fill(`${unit.name} renamed`);
			await expect(row.getByText('Unsaved changes to the model')).toBeVisible();
			await expect(row.getByPlaceholder('Reason for this change (optional)')).toBeVisible();
			expect(new Set(await tops()).size).toBe(1);
			expect((await row.boundingBox())!.height).toBeLessThanOrEqual(150);
			await expectNoSidewaysScroll(page);
			await expectNoViolations(page);
		});
});

test.describe('the page’s save bar on a phone', () => {
	for (const size of PHONES.slice(0, 2))
		test(`at ${size.width} px: the status as a word in the buttons’ row, the reason under it, the focused field clear of it`, async ({ page, owner }) => {
			void owner;
			const p = await seedRunnableProject(page.request, `Save bar ${size.width}`);
			await page.setViewportSize(size);
			await page.goto(`/projects/${p.id}?tab=settings`);
			await openFold(page, 'feb-advanced');
			await page.getByLabel('Days in February', { exact: true }).fill('28');
			await page.getByLabel('Days in February', { exact: true }).press('Tab');
			const bar = anySaveBar(page);
			await expect(bar).toBeVisible();
			await layoutSettled(page);
			const status = bar.getByText('Unsaved', { exact: true });
			const save = bar.getByRole('button', { name: 'Save changes' });
			await expect(status).toBeVisible();
			// The whole sentence is still the live region's text.
			await expect(bar).toContainText('Unsaved changes to the settings');
			const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
			expect(Math.abs(mid((await status.boundingBox())!) - mid((await save.boundingBox())!))).toBeLessThan(4);
			const reason = bar.getByPlaceholder('Reason for this change (optional)');
			expect((await reason.boundingBox())!.y).toBeGreaterThan((await save.boundingBox())!.y);
			// Two rows, not three (it was 143 px).
			const barBox = (await bar.boundingBox())!;
			expect(barBox.height).toBeLessThanOrEqual(120);
			// WCAG 2.4.11: a field focused from the keyboard is never under the bar.
			await page.getByLabel('Days in February', { exact: true }).focus();
			const f = (await page.getByLabel('Days in February', { exact: true }).boundingBox())!;
			expect(f.y + f.height).toBeLessThanOrEqual(barBox.y);
			await expectNoSidewaysScroll(page);
			await expectNoViolations(page);
			await saveSettings(page);
		});
});

test('the Project members are a row of two lines each: nothing cut off, the role picker and Leave or Remove at the tap size', async ({ page, owner, signIn }) => {
	test.setTimeout(60_000);
	void owner;
	const p = await seedRunnableProject(page.request, 'Members on a phone');
	for (const [name, role] of [['A colleague with a rather long name', 'editor'], ['Applying consultant', 'contributor'], ['Reader', 'viewer']] as const) {
		const u = await signIn(name);
		await addMember(page.request, p.id, u.user.email, role);
	}
	for (const size of [...PHONES, { width: 1440, height: 960 }]) {
		await page.setViewportSize(size);
		await page.goto(`/projects/${p.id}?tab=project`);
		const table = page.getByRole('table', { name: 'Members' });
		await expect(table.getByRole('row')).toHaveCount(5);
		await layoutSettled(page);
		const panel = (await page.getByRole('region', { name: 'Members' }).boundingBox())!;
		const at = `${size.width} px`;
		for (const b of await table.getByRole('button', { name: /^(?:Leave|Remove)$/ }).all()) {
			const box = (await b.boundingBox())!;
			expect(box.x + box.width, at).toBeLessThanOrEqual(panel.x + panel.width - 8);
			if (size.width < 640) expect(box.height, at).toBeGreaterThanOrEqual(44);
		}
		for (const s of await table.getByRole('combobox', { name: /^Role for / }).all()) {
			const box = (await s.boundingBox())!;
			expect(box.x + box.width, at).toBeLessThanOrEqual(panel.x + panel.width - 8);
			expect(box.height, at).toBeGreaterThanOrEqual(size.width < 640 ? 44 : 24);
		}
		await expect(table.getByRole('button', { name: 'Leave' })).toBeVisible();
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
	}
});

test('fields: the licence months at the tap size, the unit table’s and planted areas’ cards, and the pickers that stand alone', async ({ page, owner }) => {
	test.setTimeout(90_000);
	void owner;
	const p = await seedManyAllocations(page.request, 'Fields on a phone', { farms: 6 });
	const unit = p.units[0]!;
	for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
		await page.setViewportSize(size);
		const at = `${size.width} px`;
		// Add a registered volume: the shared month picker (it forked one with 21 px boxes).
		await page.goto(`/projects/${p.id}?tab=allocations&volume=new`);
		const sheet = page.getByRole('dialog', { name: 'Add a registered volume' });
		const months = sheet.getByRole('group', { name: 'Months water may be taken' });
		await expect(months.getByLabel('Oct', { exact: true })).toBeAttached();
		// Each toggle's box is its input (laid over the whole label, MonthPicker).
		for (const m of ['Oct', 'Jan', 'Sep']) expect((await months.getByLabel(m, { exact: true }).boundingBox())!.height, `${m} at ${at}`).toBeGreaterThanOrEqual(44);
		await months.getByLabel('Oct', { exact: true }).check();
		await months.getByLabel('Nov', { exact: true }).check();
		await expect(months.getByText('Oct–Nov')).toBeVisible();
		await expect(months.getByRole('button', { name: 'Months water may be taken: all months' })).toBeVisible();
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
		// The hydrological unit table: a card per unit, every field at the tap size.
		await page.goto(`/projects/${p.id}?tab=network&grid=nodes`);
		const grid = page.getByRole('dialog', { name: 'Hydrological unit table' });
		await expect(grid.getByRole('textbox').first()).toBeVisible();
		for (const f of await fieldHeights(grid.locator('table').first())) expect(f.h, `${f.name} at ${at}`).toBeGreaterThanOrEqual(44);
		await expectNoSidewaysScroll(page);
		// A unit's planted areas: a card per crop, the area and its system side by side, labelled.
		await page.goto(`/projects/${p.id}?tab=crops&farm=${unit.id}`);
		const drawer = page.getByRole('dialog', { name: `${unit.name}: planted areas` });
		const area = drawer.getByRole('spinbutton').first();
		await expect(area).toBeVisible();
		const system = drawer.getByRole('combobox', { name: /^Irrigation system of / }).first();
		expect(Math.abs((await area.boundingBox())!.y - (await system.boundingBox())!.y), at).toBeLessThan(2);
		for (const f of await fieldHeights(drawer.locator('table'))) expect(f.h, `${f.name} at ${at}`).toBeGreaterThanOrEqual(44);
		// Each field labelled on its card (the column heads are gone).
		expect(await area.evaluate((el) => getComputedStyle(el.closest('td')!, '::before').content)).toBe('"Area (ha)"');
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
		// The Network's Colour hydrological units by.
		await page.goto(`/projects/${p.id}?tab=network`);
		const colour = page.getByLabel('Colour hydrological units by');
		await expect(colour).toBeVisible();
		expect((await colour.boundingBox())!.height, at).toBeGreaterThanOrEqual(44);
	}
	// A wide screen: a field in a table cell is never under 24 px (WCAG 2.5.8; it was 21–25 px).
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto(`/projects/${p.id}?tab=network&grid=nodes`);
	const grid = page.getByRole('dialog', { name: 'Hydrological unit table' });
	await expect(grid.getByRole('textbox').first()).toBeVisible();
	for (const f of await fieldHeights(grid.locator('table').first())) expect(f.h, f.name).toBeGreaterThanOrEqual(24);
});

test('the transfer rates’ unit stands alone on a phone at the tap size', async ({ page, owner }) => {
	void owner;
	const p = await seedRunnableProject(page.request, 'Transfer unit on a phone');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${p.id}?tab=transfers`);
	const unit = page.getByRole('combobox', { name: 'Unit of transfer rates' });
	await expect(unit).toBeVisible();
	expect((await unit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expectNoSidewaysScroll(page);
});

test('a table that scrolls sideways keeps its row names at the left and shows there is more', async ({ page, owner }) => {
	test.setTimeout(60_000);
	void owner;
	const p = await seedRunnableProject(page.request, 'Scrolling tables');
	await createRun(page.request, p.id, 'Baseline');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${p.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();
	await layoutSettled(page);
	const wrap = page.locator('.table-wrap[data-scrolls-x]:has(table.data tbody th[scope="row"]:first-child)').first();
	await expect(wrap).toBeAttached();
	await wrap.scrollIntoViewIfNeeded();
	const name = wrap.locator('tbody th[scope="row"]').first();
	const before = (await name.boundingBox())!;
	const left = (await wrap.boundingBox())!.x;
	// The cue: the box's background carries the edge shadows (app.css).
	expect(await wrap.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('radial-gradient');
	await wrap.evaluate((el) => (el.scrollLeft = 200));
	await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
	const after = (await name.boundingBox())!;
	expect(Math.abs(after.x - left)).toBeLessThan(3);
	expect(Math.abs(after.x - before.x)).toBeLessThan(3);
	await expectNoViolations(page);
	// Wide, nothing scrolls, so nothing is fixed.
	await resizeTo(page, { width: 1440, height: 960 });
	expect(await name.evaluate((el) => getComputedStyle(el).position)).not.toBe('sticky');
});

test('the fit record folds into its line on a phone and stands open on a wide screen', async ({ page, owner }) => {
	test.setTimeout(120_000);
	void owner;
	const p = await seedRunnableProject(page.request, 'Fit record fold');
	await updateSettings(page.request, p.id, { runoffModel: 'gr4j' });
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto(`/projects/${p.id}?tab=settings`);
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await openFold(fit, 'fit-search');
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	const fold = page.getByTestId('fit-record-fold');
	await expect(fold).toHaveAttribute('open', '');
	await expect(fold.locator(':scope > summary')).toContainText(/Fit record: GR4J fit of \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2} UTC/);
	await saveSettings(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(fold).toBeAttached();
	await expect(fold).not.toHaveAttribute('open', '');
	await expect(page.getByRole('region', { name: /^Fit record of these parameters/ })).toBeHidden();
	await openFold(page, 'fit-record-fold');
	await expect(page.getByRole('region', { name: /^Fit record of these parameters/ })).toBeVisible();
	await expectNoSidewaysScroll(page);
});
