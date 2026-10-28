// The phone pass (issue #17, docs/ui.md § Section header, docs/design/ui-playbook.md § 2):
// every workspace section at 360 × 740, 390 × 844 and 320 × 640 on a big catchment (30
// units with dams, two runs, scenarios and registered volumes). The section header puts
// the tab's own controls in one More actions list at the end of the pills' row, with Add
// data and Run model (on Runs & results the run form) on the row that ends it, so the
// tab's content starts in the first half of a 360 × 740 screen (issue #521 round 5); the
// pill's list opens on screen; Compare runs has one title; and the sheets, dialogs and
// the Sections menu the per-page specs don't scan on a phone are scanned here.
// Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedManyAllocations } from '../support/allocations.ts';
import { addMember, createRun, putSeries, setAllocationViewerUnits, showAllSections, syntheticRain } from '../support/api.ts';
import { expectNoSidewaysScroll, layoutSettled } from '../support/reflow.ts';
import { headerControl } from '../support/sectionHeader.ts';
import { expect, test } from '../support/fixtures.ts';
import { createScenario } from '../support/scenarios.ts';

const header = (page: Page) => page.getByTestId('section-header');
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** A big catchment: 30 units with dams, two runs, three scenarios, 40 registered volumes. */
async function seedBig(page: Page, name: string) {
	const p = await seedManyAllocations(page.request, name);
	await createRun(page.request, p.id, 'Second run with a longer label');
	for (let i = 1; i <= 3; i++) await createScenario(page.request, p.id, { name: `What-if ${i}: upper dam raised`, baseRunId: p.runId, ops: [] });
	return p;
}

// The sections whose header has Add data (TAB_ADDS_DATA, issue #601; add-data-tabs.spec.ts pins them all).
const ADDS_DATA = new Set(['overview', 'crops', 'series', 'settings', 'calibration']);

// Each section and what shows in its header once it has loaded.
const SECTIONS: { tab: string; ready: string | RegExp }[] = [
	{ tab: 'overview', ready: 'Add data' },
	{ tab: 'network', ready: '+ Add hydrological unit' },
	{ tab: 'crops', ready: '+ Add crop' },
	{ tab: 'transfers', ready: '+ Add transfer' },
	// The fit's line and "Fit the parameters" are Calibration's header's since issue #586 round 3.
	{ tab: 'settings', ready: 'Add data' },
	{ tab: 'calibration', ready: 'Fit the parameters' },
	{ tab: 'series', ready: 'Preview all data' },
	{ tab: 'runs', ready: 'Run model' },
	{ tab: 'river', ready: 'Open in Runs & results' },
	{ tab: 'supply', ready: 'Open in Runs & results' },
	{ tab: 'dams', ready: 'Open in Runs & results' },
	// No actions of its own yet and no Add data (issue #601): the run button, which says Re-run model once the series load.
	{ tab: 'compare', ready: 'Re-run model' },
	{ tab: 'scenarios', ready: '+ New scenario' },
	{ tab: 'allocations', ready: '+ Add volume' },
	{ tab: 'project', ready: /^Download/ }
];

/** The header's boxes on a phone: the status row (pills, More actions), the main box's controls, the guide. */
async function phoneHeader(page: Page) {
	return header(page).evaluate((h) => {
		const box = (e: Element | null | undefined) => (e ? e.getBoundingClientRect() : null);
		const shown = (e: Element) => box(e)!.width > 1 && getComputedStyle(e).display !== 'none';
		const actions = box(h.querySelector('.actions'));
		const main = [...(h.querySelector('[data-testid="header-main"]')?.children ?? [])].flatMap((e) => (e.tagName === 'FORM' ? [...e.children] : [e])).filter(shown);
		return {
			bottom: box(h)!.bottom + scrollY,
			left: actions?.left ?? 0,
			right: actions?.right ?? 0,
			status: box(h.querySelector('[data-testid="header-status"]')),
			more: box(h.querySelector('[data-testid="header-more"]')),
			guide: box(h.querySelector('[data-testid="section-guide"]')),
			main: main.map((e) => ({ top: Math.round(box(e)!.top), left: box(e)!.left, right: box(e)!.right, text: (e as HTMLElement).innerText.trim() }))
		};
	});
}

// The phone sizes the header is checked at: the issue's 360 × 740 (the header ends in the screen's first half),
// the usual 390 × 844 and the narrowest, 320 × 640.
const PHONES = [
	{ width: 360, height: 740 },
	{ width: 390, height: 844 },
	{ width: 320, height: 640 }
];

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	for (const size of PHONES)
		test(`every section at ${size.width} px: the pills and More actions on one row, Add data (where the tab has it) and Run model last${size.width === 360 ? ', ending in the first half of the screen' : ''}`, async ({ page, owner }) => {
			test.setTimeout(180_000);
			void owner;
			await page.setViewportSize(size);
			const p = await seedBig(page, `Phone header ${size.width}`);
			// Data since the last run: the notice line shows, the worst case for the header's height.
			await putSeries(page.request, p.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(3 * 365 + 30) });
			for (const s of SECTIONS) {
				await page.goto(`/projects/${p.id}?tab=${s.tab}`);
				const h = header(page);
				await expect(h.getByRole('heading', { level: 1 })).toBeVisible();
				// In the closed More actions list on a phone, so attached rather than visible.
				await expect((typeof s.ready === 'string' ? h.getByText(s.ready, { exact: true }) : h.getByRole('button', { name: s.ready, includeHidden: true })).first()).toBeAttached();
				await layoutSettled(page);
				const at = `on ${s.tab} at ${size.width}`;
				// (A tab whose actions drew nothing yet, Compare with no report to export, has no ⋯; one that drew some
				// has it once the header has seen them.)
				const hasOwn = (await h.locator('[data-testid="header-own"] > .items > *').count()) > 0;
				if (hasOwn) await expect(h.getByTestId('header-more')).toBeVisible();
				await expectNoSidewaysScroll(page);
				const m = await phoneHeader(page);
				// Issue #521 round 5: the tab's content starts in the first half of a 360 × 740 screen (it was 429–579 px).
				if (size.width === 360) expect(m.bottom, at).toBeLessThanOrEqual(370);
				// How this page works: a "?" after the title, named in words, at least 36 px (its target 44).
				await expect(h.getByRole('link', { name: 'How this page works' })).toBeVisible();
				expect(m.guide!.height, at).toBeGreaterThanOrEqual(36);
				// The tab's own controls: one ⋯ at the end of the pills' row.
				if (hasOwn) {
					expect(m.more, at).not.toBeNull();
					expect(Math.abs(m.more!.top + m.more!.height / 2 - (m.status!.top + m.status!.height / 2)), at).toBeLessThan(4);
					expect(Math.abs(m.more!.right - m.right), at).toBeLessThan(2);
					expect(m.more!.width, at).toBeGreaterThanOrEqual(44);
				}
				// Add data (where the tab has it), then Run model, end the header, on one row that fills it (Runs: under
				// the run label's row).
				const adds = ADDS_DATA.has(s.tab);
				const last = m.main.filter((c) => c.top === m.main.at(-1)!.top);
				expect(last.length, `${at}: ${m.main.map((c) => c.text).join(' | ')}`).toBeGreaterThanOrEqual(adds ? 2 : 1);
				expect(Math.abs(last[0]!.left - m.left), at).toBeLessThan(2);
				expect(Math.abs(last.at(-1)!.right - m.right), at).toBeLessThan(2);
				if (adds) expect(last[0]!.text, at).toBe('Add data');
				else expect(m.main.map((c) => c.text), at).not.toContain('Add data');
				if (s.tab === 'runs') {
					expect(last.at(-1)!.text, at).toBe('Run model');
					// The label and its name fill the row above.
					const row = m.main.filter((c) => c.top < last[0]!.top);
					expect(row.length, at).toBe(2);
					expect(row[0]!.text, at).toMatch(/^Run label/);
					expect(Math.abs(row.at(-1)!.right - m.right), at).toBeLessThan(2);
				} else {
					// With data since the last run the button says Re-run model, and the notice line has no button of its own.
					expect(last.at(-1)!.text, at).toBe('Re-run model');
					await expect(h.getByTestId('notice-line').getByRole('button', { name: 'Re-run model' })).toBeHidden();
					await expect(h.getByTestId('notice-line')).toContainText('New data since the last run');
					expect((await h.getByTestId('header-run').boundingBox())!.height, at).toBeGreaterThanOrEqual(44);
				}
			}
		});

	test('More actions lists the tab’s controls by name, on the screen; a pick closes it and a dialog hands the focus back to it', async ({ page, owner }) => {
		test.setTimeout(90_000);
		void owner;
		await page.setViewportSize({ width: 360, height: 740 });
		const p = await seedBig(page, 'Phone more actions');
		await page.goto(`/projects/${p.id}?tab=allocations`);
		const h = header(page);
		const more = h.getByRole('button', { name: 'More actions' });
		await expect(more).toHaveAttribute('aria-expanded', 'false');
		const list = h.getByRole('group', { name: 'Allocations: more actions' });
		await expect(list).toBeHidden();
		await more.click();
		await expect(list).toBeVisible();
		// Every control, named, a full-width row of at least 44 px, inside the window; the picker named over its select.
		await expect(list.getByRole('combobox', { name: 'Run compared' })).toBeVisible();
		for (const name of ['Download CSV', 'Import', '+ Add volume']) {
			const b = (await list.getByRole('link', { name, exact: true }).boundingBox())!;
			expect(b.height, name).toBeGreaterThanOrEqual(44);
		}
		const lb = (await list.boundingBox())!;
		expect(lb.x).toBeGreaterThanOrEqual(0);
		expect(lb.x + lb.width).toBeLessThanOrEqual(360);
		await expect(list.getByText('Run compared', { exact: true })).toBeVisible();
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
		// Escape closes it and gives the focus back to More actions.
		await page.keyboard.press('Escape');
		await expect(list).toBeHidden();
		await expect(more).toBeFocused();
		// A pick that opens a sheet closes the list; the sheet's Escape returns to More actions.
		await more.click();
		await list.getByRole('link', { name: 'Import', exact: true }).click();
		const sheet = page.getByRole('dialog', { name: 'Import registered volumes' });
		await expect(sheet).toBeVisible();
		await expect(list).toBeHidden();
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
		await expect(more).toBeFocused();
		// A click elsewhere closes it.
		await more.click();
		await expect(list).toBeVisible();
		await h.getByRole('heading', { level: 1 }).click();
		await expect(list).toBeHidden();

		// A menu inside the list (Network's Tables ▾) opens in place under its button; its Escape closes it first.
		await page.goto(`/projects/${p.id}?tab=network`);
		await h.getByRole('button', { name: 'More actions' }).click();
		const netList = h.getByRole('group', { name: 'Network: more actions' });
		await netList.locator('summary', { hasText: 'Tables' }).click();
		const tables = netList.getByRole('group', { name: 'Open as a table' });
		await expect(tables).toBeVisible();
		const tb = (await tables.boundingBox())!;
		const nb = (await netList.boundingBox())!;
		expect(tb.y + tb.height).toBeLessThanOrEqual(nb.y + nb.height + 1);
		await page.keyboard.press('Escape');
		await expect(tables).toBeHidden();
		await expect(netList).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(netList).toBeHidden();
	});

	test('Compare runs has one title, the section header’s, with the comparison’s context under it', async ({ page, owner }) => {
		test.setTimeout(60_000);
		void owner;
		const p = await seedBig(page, 'Phone compare title');
		await page.goto(`/projects/${p.id}?tab=compare`);
		await expect(header(page).getByTestId('compare-context')).toHaveText(/^Baseline “Baseline” against one what-if · /);
		await expect(page.getByRole('heading', { name: 'Compare runs' })).toHaveCount(1);
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
		await expectNoViolations(page);
	});

	test('the rain pill’s list opens on the screen, and Escape closes it', async ({ page, owner }) => {
		test.setTimeout(60_000);
		void owner;
		const p = await seedBig(page, 'Phone rain pill');
		await page.goto(`/projects/${p.id}?tab=settings`);
		const pill = header(page).locator('summary', { hasText: 'Rain up to' });
		await pill.click();
		const pop = header(page).locator('.fresh-pop');
		await expect(pop.getByRole('table')).toBeVisible();
		const b = (await pop.boundingBox())!;
		expect(b.x).toBeGreaterThanOrEqual(0);
		expect(b.x + b.width).toBeLessThanOrEqual(390);
		await expectNoViolations(page);
		await page.keyboard.press('Escape');
		await expect(pop).toBeHidden();
		await expect(pill).toBeFocused();
	});

	test('the sheets and dialogs fill or fit the screen and have no violations; so does the Sections menu', async ({ page, owner }) => {
		test.setTimeout(120_000);
		void owner;
		const p = await seedBig(page, 'Phone overlays');
		// The Sections menu at its longest: every section, not the default that hides three.
		await showAllSections(page.request);
		const unit = p.units[0]!;
		const within = async (name: string | RegExp, full: boolean) => {
			const d = page.getByRole('dialog', { name });
			await expect(d).toBeVisible();
			const b = (await d.boundingBox())!;
			expect(b.x).toBeGreaterThanOrEqual(0);
			expect(b.x + b.width).toBeLessThanOrEqual(390);
			if (full) {
				// Edge to edge (the page's scrollbar gutter aside, app.css) and top to bottom.
				expect(b.x).toBe(0);
				expect(b.width).toBeGreaterThan(360);
				expect(b.height).toBeGreaterThan(840);
			}
			await expectNoViolations(page);
		};
		// A node's sheet and the node table: full screen.
		await page.goto(`/projects/${p.id}?tab=network&edit=${unit.id}`);
		await within(`Edit ${unit.name}`, true);
		await page.goto(`/projects/${p.id}?tab=network&grid=nodes`);
		await within('Hydrological unit table', true);
		// Allocations' two sheets: full screen.
		await page.goto(`/projects/${p.id}?tab=allocations&import=1`);
		await within('Import registered volumes', true);
		await page.goto(`/projects/${p.id}?tab=allocations&volume=new`);
		await within('Add a registered volume', true);
		// The small dialogs fit on the screen.
		await page.goto(`/projects/${p.id}?tab=scenarios&new=1`);
		await within('New scenario', false);
		await page.goto(`/projects/${p.id}`);
		await header(page).getByRole('button', { name: 'Add data' }).click();
		await within('Add data', false);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);

		// The Sections menu: every section, on the screen, no violations; picking one closes it.
		const toggle = page.getByRole('button', { name: /^Project sections:/ });
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		const nav = page.getByRole('navigation', { name: 'Project sections' });
		await expect(nav.getByRole('link', { name: 'Allocations' })).toBeVisible();
		expect(await noSideScroll(page)).toBe(true);
		await expectNoViolations(page);
		await nav.getByRole('link', { name: 'Allocations' }).click();
		await expect(header(page).getByRole('heading', { level: 1, name: 'Allocations' })).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	});

	test('a viewer: no Add data or Run model, the section’s controls under More actions, View only on one line', async ({ page, owner, signIn }) => {
		test.setTimeout(60_000);
		void owner;
		const p = await seedBig(page, 'Phone viewer header');
		const viewer = await signIn('Phone header viewer');
		await addMember(page.request, p.id, viewer.user.email, 'viewer');
		// Viewers read each volume (and get the CSV) only once an owner allows it (D3, 162), so the
		// section's full set of controls is there to lay out.
		await setAllocationViewerUnits(page.request, p.id, true);
		const v = viewer.page;
		for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
			await v.setViewportSize(size);
			await v.goto(`/projects/${p.id}?tab=allocations`);
			await expect(header(v).getByTestId('header-main')).toHaveCount(0);
			await expect(await headerControl(v, 'link', 'Download CSV')).toBeVisible();
			await v.keyboard.press('Escape');
			// View only: one line on a phone (the role badge in the bar says it too); the full sentence is still read.
			const note = header(v).getByRole('note');
			await expect(note.getByText('View only.', { exact: true })).toBeVisible();
			await expect(note.getByText('Ask the owner to edit.')).toBeVisible();
			expect((await note.boundingBox())!.height, `${size.width} px`).toBeLessThan(32);
			await expect(note).toContainText('You have view-only access to this project.');
			await expectNoSidewaysScroll(v);
			await expectNoViolations(v);
		}
		// A wide screen shows the whole sentence and no short one.
		await v.setViewportSize({ width: 1440, height: 960 });
		await expect(header(v).getByRole('note').getByText('You have view-only access to this project.', { exact: false })).toBeVisible();
		await expect(header(v).getByRole('note').getByText('Ask the owner to edit.')).toBeHidden();
	});
});

test.describe('desktop', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('the header controls stay one row, beside the title where they fit, Add data (where the tab has it) then Run model last', async ({ page, owner }) => {
		// The same budget as the phone tests on this seed: two runs of 30 units and 44 volumes added one by one
		// take most of the default 30 s on a busy machine before the page is opened.
		test.setTimeout(60_000);
		void owner;
		const p = await seedBig(page, 'Desktop header row');
		// Whether a tab's controls fit beside its title depends on its words (the seeded
		// Network's long context line comes within a few px at 1440): measure it rather than
		// guess, then check the header follows. Settings fits with room to spare, so the
		// beside layout is always exercised; Allocations' picker and three actions never do.
		for (const [tab, expected] of [['settings', true], ['network', null], ['allocations', false]] as const) {
			await page.goto(`/projects/${p.id}?tab=${tab}`);
			const h = header(page);
			const run = h.getByTestId('header-run');
			await expect(run).toBeVisible();
			// Measure the settled header, never a partial one: Run model is the page's own, but the rain pill
			// waits on the series' freshness, and each tab is a lazy component that fills the header's context
			// and controls only once it mounts (fillHeader). Measured before the Network's Map, Tables and
			// + Add buttons arrived, the row "fit" and then wrapped under the title once they did (CI, #602).
			await expect(h.locator('summary', { hasText: 'Rain up to' })).toBeVisible();
			if (tab === 'settings') await expect(h.getByTestId('settings-context')).toBeVisible();
			if (tab === 'network') {
				await expect(h.getByTestId('network-summary')).toBeVisible();
				await expect(h.getByRole('button', { name: '+ Add hydrological unit' })).toBeVisible();
			}
			// Allocations adds Download CSV once its volumes load, which moves the row.
			if (tab === 'allocations') await expect(h.getByRole('link', { name: 'Download CSV' })).toBeVisible();
			// The title and its context on one line, the gap, then every control on one line: does it fit the row?
			const fits = await h.evaluate((el) => {
				const row = el.querySelector('.row') as HTMLElement;
				const title = row.querySelector('.title') as HTMLElement;
				const actions = row.querySelector('.actions') as HTMLElement;
				title.style.flex = 'none';
				actions.style.flexWrap = 'nowrap';
				const need = title.getBoundingClientRect().width + parseFloat(getComputedStyle(row).columnGap) + actions.scrollWidth;
				title.style.flex = '';
				actions.style.flexWrap = '';
				return need <= row.getBoundingClientRect().width;
			});
			if (expected !== null) expect(fits, tab).toBe(expected);
			const beside = fits;
			const title = (await h.getByRole('heading', { level: 1 }).boundingBox())!;
			const pill = (await h.locator('summary', { hasText: 'Rain up to' }).boundingBox())!;
			const runBox = (await run.boundingBox())!;
			const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
			expect(Math.abs(mid(pill) - mid(runBox)), tab).toBeLessThan(4);
			if (beside) expect(pill.x, tab).toBeGreaterThan(title.x + title.width);
			else expect(pill.y, tab).toBeGreaterThan(title.y + title.height);
			const buttons = await h.getByTestId('header-main').getByRole('button').allTextContents();
			// Add data only on Model settings of the three (issue #601).
			expect(buttons.map((t) => t.trim()), tab).toEqual(tab === 'settings' ? ['Add data', 'Run model'] : ['Run model']);
		}
	});
});
