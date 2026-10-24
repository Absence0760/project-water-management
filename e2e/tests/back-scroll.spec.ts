// Back after an in-page pick returns to where the reader was (ui-playbook § URL
// state: a pick pushes, "so Back returns to the pick before"). The picks are
// `goto(…, { reset: false })`: they keep the scroll and focus where they are,
// and the page then scrolls the picked item's detail into view on a phone.
// SvelteKit 2 restored the window's scroll on Back whatever the step's options;
// SvelteKit 3 skips its restore when the step it leaves kept the scroll
// (reset: false), so Back left the reader at the detail. Synthetic data only.
import type { Locator, Page } from '@playwright/test';
import { compareCard, openAllocations, seedManyAllocations } from '../support/allocations.ts';
import { createRun, putModel, seedRunnableProject, type Model } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openSupply, seedSupplyProject, unitCards, unitChart } from '../support/supply.ts';

const PHONE = { width: 390, height: 844 };
const scrollY = (page: Page) => page.evaluate(() => Math.round(document.scrollingElement!.scrollTop));
/** Where an element sits in the window, in px from its top: what the reader sees of their place. */
const topInWindow = async (l: Locator) => Math.round((await l.boundingBox())!.y);

/** The seeded catchment with `extra` more farm dams, so the Dams list runs well below the fold. */
async function seedManyDams(page: Page, name: string, extra: number): Promise<{ id: string; model: Model }> {
	const project = await seedRunnableProject(page.request, name);
	const model = project.model;
	const template = model.nodes[2]!;
	for (let i = 0; i < extra; i++) {
		const id = crypto.randomUUID();
		model.nodes.push({ ...template, id, name: `Farm dam ${i + 1} on the long tributary`, sortOrder: 4 + i, areaKm2: 2 + (i % 5), damCapacityM3: 20_000 + i * 5_000 });
		model.cropAreas.push({ nodeId: id, cropId: model.crops[0]!.id, areaM2: 100_000 + i * 10_000 });
	}
	await putModel(page.request, project.id, model);
	return project;
}

test('Dams, on a phone: pick a dam low in the list, the chart comes into view, Back returns to the list where it was', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize(PHONE);
	const project = await seedManyDams(page, 'Back scroll dams', 12);
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=dams`);
	const chart = page.getByRole('region', { name: /^Storage/ });
	await expect(chart.locator('figure.chart')).toHaveAttribute('data-ready', 'true');
	const cards = page.getByRole('list', { name: 'Dams' }).getByRole('listitem');
	await expect(cards).toHaveCount(14);

	const low = cards.nth(12).locator('a.name');
	await low.scrollIntoViewIfNeeded();
	expect(await scrollY(page), 'the list runs below the fold').toBeGreaterThan(0);
	const atList = await topInWindow(low);
	await low.click();
	await expect(page).toHaveURL(/[?&]dam=/);
	await expect(chart).toBeInViewport();
	await expect.poll(() => topInWindow(low), 'the pick scrolled to the chart').not.toBe(atList);

	await page.goBack();
	await expect(page).not.toHaveURL(/[?&]dam=/);
	await expect.poll(() => topInWindow(low)).toBe(atList);
	await expect(low).toBeInViewport();
});

test('Hydrological units, on a phone: pick a unit low in the list, its detail comes into view, Back returns to the list where it was', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize(PHONE);
	const project = await seedSupplyProject(page.request, 'Back scroll units', 12);
	await createRun(page.request, project.id, 'Baseline');
	await openSupply(page, project.id);
	const showAll = page.getByRole('button', { name: /^Show all \d+ hydrological units$/ });
	if (await showAll.count()) await showAll.click();
	await expect(unitCards(page)).toHaveCount(14);

	const low = unitCards(page).last().locator('a.name');
	await low.scrollIntoViewIfNeeded();
	expect(await scrollY(page), 'the list runs below the fold').toBeGreaterThan(0);
	const atList = await topInWindow(low);
	await low.click();
	await expect(page).toHaveURL(/[?&]unit=/);
	await expect(unitChart(page)).toBeInViewport();
	await expect.poll(() => topInWindow(low), 'the pick scrolled to the detail').not.toBe(atList);

	await page.goBack();
	await expect(page).not.toHaveURL(/[?&]unit=/);
	await expect.poll(() => topInWindow(low)).toBe(atList);
	await expect(low).toBeInViewport();
});

test('Allocations, on a phone: pick a unit far down the opened list, its comparison comes into view, Back returns to the list where it was', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	await page.setViewportSize(PHONE);
	const project = await seedManyAllocations(page.request, 'Back scroll allocations', { farms: 12, unmatched: 0 });
	await openAllocations(page, project.id);
	await compareCard(page).getByRole('button', { name: /^Show all \d+ hydrological units and sources$/ }).click();
	const rows = compareCard(page).getByRole('list', { name: 'Hydrological units, the ones to look into first' }).getByRole('listitem');
	await expect(rows.last()).toBeAttached();

	const low = rows.last().getByRole('link').first();
	await low.scrollIntoViewIfNeeded();
	expect(await scrollY(page), 'the list runs below the fold').toBeGreaterThan(0);
	const atList = await topInWindow(low);
	await low.click();
	await expect(page).toHaveURL(/[?&]unit=/);
	await expect.poll(() => topInWindow(low), 'the pick scrolled to the comparison').not.toBe(atList);

	await page.goBack();
	await expect(page).not.toHaveURL(/[?&]unit=/);
	await expect.poll(() => topInWindow(low)).toBe(atList);
	await expect(low).toBeInViewport();
});

// Back lands while the lazily loaded section is still being built: restored once, the
// place drifted as the rest arrived (to 231 of 471 on SvelteKit 2; not restored at all on 3).
test('the section strip’s arrow keys: Back to the section returns to where the page was scrolled', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await seedManyDams(page, 'Back scroll tabs', 12);
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=dams`);
	await expect(page.getByRole('list', { name: 'Dams' }).getByRole('listitem')).toHaveCount(14);
	await expect(page.getByRole('region', { name: /^Storage/ }).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => scrollTo(0, 600));
	const tabLink = page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Dams', exact: true });
	await tabLink.evaluate((a: HTMLElement) => a.focus({ preventScroll: true }));
	const atDams = await scrollY(page);
	expect(atDams, 'the Dams page is scrolled').toBeGreaterThan(0);

	await page.keyboard.press('ArrowDown');
	await expect(page).not.toHaveURL(/[?&]tab=dams/);
	await page.evaluate(() => scrollTo(0, 0));

	await page.goBack();
	await expect(page).toHaveURL(/[?&]tab=dams/);
	await expect(page.getByRole('list', { name: 'Dams' }).getByRole('listitem')).toHaveCount(14);
	await expect.poll(() => scrollY(page)).toBe(atDams);
});
