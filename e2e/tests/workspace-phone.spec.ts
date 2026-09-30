// The phone pass (issue #17, docs/ui.md § Section header, docs/design/ui-playbook.md § 2):
// every workspace section at 390 × 844 on a big catchment (30 units with dams, two
// runs, scenarios and registered volumes). The section header lays its actions out
// in full rows under the rain pill, a picker a row of its own, with Add data and
// Run model always ending it side by side; the pill's list opens on screen; Compare
// runs has one title; and the sheets, dialogs and the Sections menu the per-page
// specs don't scan on a phone are scanned here. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedManyAllocations } from '../support/allocations.ts';
import { addMember, createRun, showAllSections } from '../support/api.ts';
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

/**
 * The header's controls, row by row (grouped by top edge): the tab's own
 * (`header-own`, direct children) and the page's pair (`header-main`), with
 * the actions box they sit in.
 */
async function headerRows(page: Page) {
	return header(page).evaluate((h) => {
		const box = (e: Element) => e.getBoundingClientRect();
		const shown = (e: Element) => {
			const s = getComputedStyle(e);
			return box(e).width > 1 && s.position !== 'absolute' && s.position !== 'fixed';
		};
		const actions = box(h.querySelector('.actions')!);
		const pick = (id: string) => [...(h.querySelector(`[data-testid="${id}"]`)?.children ?? [])].filter(shown);
		const own = pick('header-own');
		const main = pick('header-main');
		const rows = new Map<number, { left: number; right: number; top: number; texts: string[] }[]>();
		for (const e of [...own, ...main]) {
			const r = box(e);
			const top = Math.round(r.top / 8); // a row's controls may differ in height by a pixel or two
			rows.set(top, [...(rows.get(top) ?? []), { left: r.left, right: r.right, top, texts: [(e.textContent ?? '').replace(/\s+/g, ' ').trim()] }]);
		}
		const status = h.querySelector('[data-testid="header-status"]');
		return {
			left: actions.left,
			right: actions.right,
			statusBottom: status ? box(status).bottom : null,
			firstControlTop: Math.min(...[...own, ...main].map((e) => box(e).top)),
			rows: [...rows.values()].sort((a, b) => a[0]!.top - b[0]!.top),
			selects: [...h.querySelectorAll('[data-testid="header-own"] select')].map((s) => box(s).width),
			// How far each picker's select sits below the top of its control: 0 unless a visible label takes a line above it.
			pickerDrops: own.filter((e) => e.querySelector('select')).map((e) => box(e.querySelector('select')!).top - box(e).top)
		};
	});
}

// Each section, what shows in its header once it has loaded, and whether Run model is there.
const SECTIONS: { tab: string; ready: string | RegExp; run: boolean }[] = [
	{ tab: 'overview', ready: 'Run model', run: true },
	{ tab: 'network', ready: '+ Add node', run: true },
	{ tab: 'crops', ready: '+ Add crop', run: true },
	{ tab: 'transfers', ready: '+ Add transfer', run: true },
	{ tab: 'settings', ready: 'Fit the parameters', run: true },
	{ tab: 'series', ready: 'Preview all data', run: false },
	{ tab: 'runs', ready: 'Run model', run: false },
	{ tab: 'river', ready: 'Open in Runs & results', run: false },
	{ tab: 'supply', ready: 'Open in Runs', run: false },
	{ tab: 'dams', ready: 'Open in Runs', run: false },
	{ tab: 'compare', ready: 'Add data', run: false },
	{ tab: 'scenarios', ready: '+ New scenario', run: false },
	{ tab: 'allocations', ready: '+ Add volume', run: false },
	{ tab: 'project', ready: /^Download/, run: false }
];

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('every section: the pill, then the controls in full rows, pickers full width, Add data and Run model last and side by side', async ({ page, owner }) => {
		test.setTimeout(120_000);
		void owner;
		const p = await seedBig(page, 'Phone header big catchment');
		for (const s of SECTIONS) {
			await page.goto(`/projects/${p.id}?tab=${s.tab}`);
			const h = header(page);
			await expect(h.getByRole('heading', { level: 1 })).toBeVisible();
			await expect((typeof s.ready === 'string' ? h.getByText(s.ready, { exact: true }) : h.getByRole('button', { name: s.ready })).first()).toBeVisible();
			const at = `on ${s.tab}`;
			expect(await noSideScroll(page), at).toBe(true);
			const m = await headerRows(page);
			// The pill is a line of its own, above every control.
			expect(m.statusBottom, at).not.toBeNull();
			expect(m.firstControlTop, at).toBeGreaterThan(m.statusBottom!);
			// Every row of controls fills the header's width: no ragged gap at its end.
			for (const row of m.rows) {
				expect(Math.abs(row[0]!.left - m.left), `${at}: ${row.map((c) => c.texts).join(' | ')}`).toBeLessThan(2);
				expect(Math.abs(row.at(-1)!.right - m.right), `${at}: ${row.map((c) => c.texts).join(' | ')}`).toBeLessThan(2);
			}
			// A run picker is the full width.
			for (const w of m.selects) expect(w, at).toBeGreaterThan(m.right - m.left - 2);
			// ...with no "Run" line of its own above it (River & reserve's had one): the word is for screen readers.
			for (const d of m.pickerDrops) expect(d, at).toBeLessThan(2);
			// Add data and Run model: one row, in that order, ending the header.
			const add = (await h.getByRole('button', { name: 'Add data' }).boundingBox())!;
			const last = m.rows.at(-1)!;
			if (s.run) {
				const run = (await h.getByRole('button', { name: 'Run model' }).boundingBox())!;
				expect(Math.round(run.y), at).toBe(Math.round(add.y));
				expect(run.x, at).toBeGreaterThan(add.x);
				expect(Math.abs(run.x + run.width - m.right), at).toBeLessThan(2);
				expect(last.at(-1)!.texts[0], at).toBe('Run model');
			} else if (s.tab === 'runs') {
				// Runs' run form (label, name, Run model) is the last row, under Add data.
				const form = (await h.locator('form.run-form').boundingBox())!;
				expect(form.y, at).toBeGreaterThan(add.y + add.height - 1);
			} else {
				expect(last.at(-1)!.texts[0], at).toBe('Add data');
			}
		}
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
		await within('Node table', true);
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

	test('a viewer: no Add data or Run model, the section’s own controls still fill their rows', async ({ page, owner, signIn }) => {
		test.setTimeout(60_000);
		void owner;
		const p = await seedBig(page, 'Phone viewer header');
		const viewer = await signIn('Phone header viewer');
		await addMember(page.request, p.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 390, height: 844 });
		await v.goto(`/projects/${p.id}?tab=allocations`);
		await expect(header(v).getByRole('link', { name: 'Download CSV' })).toBeVisible();
		await expect(header(v).getByTestId('header-main')).toHaveCount(0);
		const m = await headerRows(v);
		for (const row of m.rows) expect(Math.abs(row.at(-1)!.right - m.right)).toBeLessThan(2);
		expect(await noSideScroll(v)).toBe(true);
		await expectNoViolations(v);
	});
});

test.describe('desktop', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('the header controls stay one row, beside the title where they fit, the pair last', async ({ page, owner }) => {
		void owner;
		const p = await seedBig(page, 'Desktop header row');
		// Whether a tab's controls fit beside its title depends on its words (the seeded
		// Network's long context line comes within a few px at 1440): measure it rather than
		// guess, then check the header follows. Settings fits with room to spare, so the
		// beside layout is always exercised; Allocations' picker and three actions never do.
		for (const [tab, expected] of [['settings', true], ['network', null], ['allocations', false]] as const) {
			await page.goto(`/projects/${p.id}?tab=${tab}`);
			const h = header(page);
			await expect(h.getByRole('button', { name: 'Add data' })).toBeVisible();
			// Allocations adds Download CSV once its volumes load, which moves the row: measure the settled header.
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
			const add = (await h.getByRole('button', { name: 'Add data' }).boundingBox())!;
			const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
			expect(Math.abs(mid(pill) - mid(add)), tab).toBeLessThan(4);
			if (beside) expect(pill.x, tab).toBeGreaterThan(title.x + title.width);
			else expect(pill.y, tab).toBeGreaterThan(title.y + title.height);
			if (tab !== 'allocations') {
				const run = (await h.getByRole('button', { name: 'Run model' }).boundingBox())!;
				expect(Math.abs(mid(run) - mid(add)), tab).toBeLessThan(4);
				expect(run.x, tab).toBeGreaterThan(add.x);
			}
		}
	});
});
