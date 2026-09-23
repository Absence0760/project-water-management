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
});
