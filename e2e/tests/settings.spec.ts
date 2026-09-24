import { createProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('monthly A-pan and EWR values are saved and survive a reload', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const apan = (m: string) => page.getByLabel(`A-pan evaporation, ${m}, mm`);
	const ewr = (m: string) => page.getByLabel(`Pragmatic EWR, ${m}, m³/day`);
	const save = page.getByRole('button', { name: 'Save settings' });

	await expect(apan('Oct')).toHaveValue('0');
	await expect(save).toBeDisabled();

	await apan('Oct').fill('152');
	await apan('Jan').fill('231.5');
	await ewr('Oct').fill('1800');
	await ewr('Jul').fill('5400');
	await expect(page.getByText('Unsaved settings')).toBeVisible();
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await expect(save).toBeDisabled();

	await page.reload();
	await expect(apan('Oct')).toHaveValue('152');
	await expect(apan('Jan')).toHaveValue('231.5');
	await expect(apan('Nov')).toHaveValue('0');
	await expect(ewr('Oct')).toHaveValue('1800');
	await expect(ewr('Jul')).toHaveValue('5400');
	await expect(page.getByText('Unsaved settings')).toBeHidden();
});

test('discarding settings restores the saved values', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings discard');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const apan = page.getByLabel('A-pan evaporation, Mar, mm');

	await apan.fill('99');
	await page.getByRole('button', { name: 'Discard' }).click();
	await expect(apan).toHaveValue('0');
	await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
});

test('a simulation end before its start cannot be saved', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings dates');
	await page.goto(`/projects/${project.id}?tab=settings`);

	await page.getByLabel('Simulation start').fill('2022-06-01');
	await page.getByLabel('Simulation end').fill('2022-01-01');
	await expect(page.getByRole('alert')).toHaveText('Simulation start must be before the end.');
	await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();

	// The save bar says why Save is off and links to the group to fix; the menu flags it too.
	await page.evaluate(() => window.scrollTo(0, 0));
	const blockers = page.getByRole('status').filter({ hasText: 'to fix before saving' });
	await expect(blockers).toContainText('1 group has a problem to fix before saving:');
	await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: /^Simulation period\s*\(has a problem\)$/ })).toBeVisible();
	await blockers.getByRole('link', { name: 'Simulation period: Simulation start must be before the end.' }).click();
	await expect(page).toHaveURL(/#set-period$/);
	await expect(page.getByRole('heading', { name: 'Simulation period' })).toBeInViewport();

	await page.getByLabel('Simulation end').fill('2022-12-31');
	await expect(blockers).toBeHidden();
});

test('the On this page menu stays in view, jumps to each group below it and marks the one being read', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings menu');
	await page.setViewportSize({ width: 1600, height: 800 });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const menu = page.getByRole('navigation', { name: 'Settings sections' });
	await expect(menu.getByRole('link')).toHaveText([
		'Demand',
		'Flow calibration',
		'Fit automatically',
		'WR2012 check',
		'Flow share',
		'EWR',
		'Simulation period',
		'Data quality'
	]);
	await expect(menu.getByRole('link', { name: 'Demand' })).toHaveAttribute('aria-current', 'location');

	await menu.getByRole('link', { name: 'EWR' }).click();
	await expect(page).toHaveURL(/#set-ewr$/);
	const ewr = page.getByRole('heading', { name: 'Environmental water requirement (EWR)' });
	await expect(ewr).toBeInViewport();
	await expect(menu).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'EWR' })).toHaveAttribute('aria-current', 'location');
	await expect(menu.getByRole('link', { name: 'Demand' })).not.toHaveAttribute('aria-current', 'location');
	// The jumped-to heading sits below the sticky menu, not under it.
	const menuBox = (await menu.boundingBox())!;
	const headBox = (await ewr.boundingBox())!;
	expect(headBox.y).toBeGreaterThanOrEqual(menuBox.y + menuBox.height);

	// The EWR monthly row has the panel's full width: all twelve months fit without a sideways scroll.
	await expect(page.getByLabel('Pragmatic EWR, Sep, m³/day')).toBeInViewport();

	// Phone: the menu is one strip that scrolls inside itself, never the page.
	await page.setViewportSize({ width: 390, height: 900 });
	await menu.getByRole('link', { name: 'Data quality' }).click();
	await expect(page.getByRole('heading', { name: /^Data quality/ })).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Data quality' })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
