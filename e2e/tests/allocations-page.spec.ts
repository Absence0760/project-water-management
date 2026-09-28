// The Allocations page (?tab=allocations, issue #17 option A, docs/ui.md § Allocations): the section header counts
// the volumes and the units above registered and carries Download CSV, Import and + Add volume (side sheets,
// `import=1`, `volume=new|<id>`) and the run picker (`run=`); a list of each unit and source, the ones to look into
// first, beside the picked unit's water years (`unit=`), fitting the window from 1100 × 620 with the list scrolling
// in its card; below, the registered volumes and every unit's water years. A viewer sees volumes without names and
// nothing to change. On a phone it stacks, the lists capped until "Show all". Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { compareCard, openAllocations, seedManyAllocations, volumesCard } from '../support/allocations.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const header = (page: Page) => page.getByTestId('section-header');
const detail = (page: Page) => page.getByTestId('allocation-unit');
const units = (page: Page) => compareCard(page).getByRole('list', { name: 'Hydrological units, the ones to look into first' }).getByRole('listitem');
const RANK = { over: 0, unregistered: 1, under: 2, within: 3, none: 4 } as const;

test('many hydrological units: the ones to look into first, fitting the window; picking a hydrological unit is a link, and the sheets are too', async ({ page, owner, signIn }) => {
	test.setTimeout(120_000);
	void owner;
	const project = await seedManyAllocations(page.request, 'Allocations big');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openAllocations(page, project.id);

	// One title; the header counts the volumes, the unmatched ones and the units above registered, and has the actions.
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(header(page).getByTestId('section-context')).toHaveText(/^40 registered volumes · 4 not matched · \d+ hydrological units above registered$/);
	await expect(header(page).getByRole('link', { name: 'Download CSV', exact: true })).toHaveAttribute('href', /\/allocations\/export\.csv$/);
	await expect(header(page).getByRole('link', { name: 'Import', exact: true })).toBeVisible();
	await expect(header(page).getByRole('link', { name: '+ Add volume', exact: true })).toBeVisible();
	await expect(page.getByTestId('allocation-compare')).toContainText('modelled, not metered');

	// Every unit and source with use or a volume (30 surface + 6 groundwater), in the order to look into them.
	await expect(units(page)).toHaveCount(36);
	const statuses = (await units(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-status')))) as (keyof typeof RANK)[];
	expect(statuses[0]).toBe('over');
	expect(statuses.map((s) => RANK[s])).toEqual([...statuses.map((s) => RANK[s])].sort((a, b) => a - b));
	await expect(units(page).first()).toContainText(/Above registered in 3 of 3 whole years/);

	// The first block reaches the window's bottom, the list scrolling inside its card; the first unit is picked.
	const first = page.locator('.first');
	const box = (await first.boundingBox())!;
	expect(box.y + box.height).toBeLessThanOrEqual(960);
	expect(box.y + box.height).toBeGreaterThan(960 - 40);
	const list = compareCard(page).locator('ul.units');
	const scroll = await list.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
	expect(scroll.sh).toBeGreaterThan(scroll.ch);
	const firstName = (await units(page).first().getByRole('link').textContent())!.trim();
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText(firstName);
	await expect(detail(page)).toBeInViewport();
	await expectNoSidewaysScroll(page);

	// Pick the unit with groundwater too: its six water years, both sources, its two volumes; Back returns.
	const farm1 = project.units[0]!;
	await units(page).filter({ hasText: farm1.name }).first().getByRole('link', { name: farm1.name, exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]unit=${farm1.id}`));
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText(farm1.name);
	await expect(detail(page).getByTestId('allocation-unit-years').locator('tbody tr')).toHaveCount(6);
	await expect(detail(page).getByTestId('allocation-unit-bars').getByRole('listitem', { includeHidden: true })).toHaveCount(6);
	// The bars say what they are, and each carries its value: the table's modelled use for that year and source, row for row.
	await expect(detail(page).getByTestId('allocation-unit-bars-caption')).toHaveText('Modelled use per water year (October–September), m³');
	const barValues = await detail(page).getByTestId('allocation-unit-bars').locator('.yv').allInnerTexts();
	const tableModelled = await detail(page).getByTestId('allocation-unit-years').locator('tbody tr').evaluateAll((trs) =>
		trs.map((tr) => {
			const heads = [...tr.closest('table')!.querySelectorAll('thead th')].map((th) => th.textContent!.trim());
			const col = heads.findIndex((h) => h.startsWith('Modelled use'));
			return tr.children[col]!.textContent!.trim();
		})
	);
	expect(barValues.map((v) => v.replace(/\s*m³$/, ''))).toEqual(tableModelled);
	await expect(detail(page).getByText('SYN-G1000', { exact: false })).toBeVisible();
	await expect(detail(page)).toContainText('Invented Holdings 1');
	await expect(detail(page).getByRole('link', { name: `${farm1.name} on the Network` })).toHaveAttribute('href', `?tab=network&node=${farm1.id}`);
	await page.goBack();
	await expect(page).not.toHaveURL(/unit=/);
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText(firstName);

	// A shared link to a unit further down brings its row into view inside the list.
	await openAllocations(page, project.id, `&unit=${farm1.id}`);
	await expect(compareCard(page).locator('li.unit.picked').first()).toBeInViewport();
	expect(await page.evaluate(() => window.scrollY)).toBe(0);

	// + Add volume opens the sheet (`volume=new`); saving adds it and closes the sheet in place.
	await header(page).getByRole('link', { name: '+ Add volume', exact: true }).click();
	await expect(page).toHaveURL(/volume=new/);
	const sheet = page.getByRole('dialog', { name: 'Add a registered volume' });
	await sheet.getByLabel('Hydrological unit or water user').selectOption({ label: farm1.name });
	await sheet.getByLabel('Water source').selectOption('groundwater');
	await sheet.getByLabel('Volume (m³ per year)').fill('12000');
	await sheet.getByLabel('Registration or licence number').fill('SYN-NEW');
	await sheet.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(sheet).toBeHidden();
	await expect(page).not.toHaveURL(/volume=/);
	await expect(header(page).getByTestId('section-context')).toHaveText(/^41 registered volumes/);
	await expect(detail(page)).toContainText('SYN-NEW');

	// Change from the picked unit's list: the sheet holds the volume; Escape closes it, and Back doesn't reopen it.
	await detail(page).getByRole('button', { name: 'Change SYN-NEW', exact: true }).click();
	await expect(page).toHaveURL(/volume=/);
	const change = page.getByRole('dialog', { name: 'Change the registered volume' });
	await expect(change.getByLabel('Volume (m³ per year)')).toHaveValue('12000');
	await expectNoViolations(page);
	await page.keyboard.press('Escape');
	await expect(change).toBeHidden();
	await expect(page).not.toHaveURL(/volume=/);
	await page.goBack();
	await expect(change).toBeHidden();

	// Import opens its sheet from `import=1`, with the template link.
	await openAllocations(page, project.id, '&import=1');
	const imp = page.getByRole('dialog', { name: 'Import registered volumes' });
	await expect(imp.getByRole('link', { name: 'Download the CSV template' })).toBeVisible();
	await imp.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page).not.toHaveURL(/import=/);

	// Below the first screen: the volumes (unmatched first, as before) and every unit's water years.
	await expect(volumesCard(page).getByTestId('allocation-list').getByRole('row', { name: /^Not matched/ })).toHaveCount(4);
	await expect(page.getByTestId('allocation-compare-table').locator('tbody tr')).toHaveCount(36 * 3);
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'light' });

	// 1280 × 800: still fits, and the volumes table needs no sideways scroll.
	await page.setViewportSize({ width: 1280, height: 800 });
	const b2 = (await first.boundingBox())!;
	expect(b2.y + b2.height).toBeLessThanOrEqual(800);
	const wrap = await volumesCard(page).locator('.table-wrap').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
	expect(wrap.sw).toBeLessThanOrEqual(wrap.cw);
	await expectNoSidewaysScroll(page);

	// A phone: one column, the lists capped until "Show all", no sideways scroll.
	await page.setViewportSize({ width: 390, height: 844 });
	await openAllocations(page, project.id);
	await expect(units(page)).toHaveCount(6);
	await compareCard(page).getByRole('button', { name: 'Show all 36 hydrological units and sources' }).click();
	await expect(units(page)).toHaveCount(36);
	await expect(volumesCard(page).getByTestId('allocation-list').locator('tbody tr')).toHaveCount(8);
	await volumesCard(page).getByRole('button', { name: 'Show all 41 registered volumes' }).click();
	await expect(volumesCard(page).getByTestId('allocation-list').locator('tbody tr')).toHaveCount(41);
	await expect(page.getByTestId('allocation-compare-table').locator('thead')).toBeHidden();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);

	// A viewer: the volumes and the comparison, no names anywhere and nothing to change.
	const viewer = await signIn('Allocations page viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 960 });
	await openAllocations(v, project.id, `&unit=${farm1.id}`);
	await expect(header(v).getByRole('link', { name: 'Download CSV', exact: true })).toBeVisible();
	await expect(header(v).getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);
	await expect(header(v).getByRole('link', { name: '+ Add volume', exact: true })).toHaveCount(0);
	await expect(detail(v)).toContainText('SYN-G1000');
	await expect(detail(v)).not.toContainText('Invented Holdings');
	await expect(detail(v).getByRole('button')).toHaveCount(0);
	await expect(volumesCard(v)).not.toContainText('Invented Holdings');
	await expect(volumesCard(v).getByText('Names of registered users are shown to editors only.')).toBeVisible();
	// A sheet link doesn't open for a viewer.
	await openAllocations(v, project.id, '&volume=new');
	await expect(v.getByRole('dialog')).toHaveCount(0);
	await expectNoViolations(v);
});

test('the run is a link (`run=`), a deleted one falls back and says so; no run and nothing registered say what to do', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Allocations runs');

	// No run yet, nothing registered.
	await openAllocations(page, project.id);
	await expect(header(page).getByTestId('section-context')).toHaveText('No registered volumes yet');
	await expect(page.getByTestId('allocation-compare')).toContainText('Run the model to compare its use with the registered volumes.');
	await expect(page.getByTestId('allocations-empty')).toContainText('No registered volumes yet.');
	await expect(header(page).getByRole('link', { name: 'Download CSV' })).toHaveCount(0);

	const firstRun = await createRun(page.request, project.id, 'First');
	const second = await createRun(page.request, project.id, 'Second');
	await openAllocations(page, project.id);
	// Nothing registered, so each unit's use has no registered volume.
	await expect(units(page).first()).toContainText('No registered volume');
	await expect(units(page).first()).toContainText('Nothing registered');
	const picker = header(page).getByLabel('Run compared');
	await expect(picker).toHaveValue(second);
	await picker.selectOption(firstRun);
	await expect(page).toHaveURL(/[?&]run=/);
	await expect(page.getByTestId('allocation-compare')).toContainText('Run “First”');
	await page.goBack();
	await expect(page.getByTestId('allocation-compare')).toContainText('Run “Second”');

	await openAllocations(page, project.id, '&run=00000000-0000-0000-0000-000000000000');
	await expect(page.getByRole('note').filter({ hasText: 'That run no longer exists' })).toBeVisible();
	await expect(page.getByTestId('allocation-compare')).toContainText('Run “Second”');
	await expectNoViolations(page);
});
