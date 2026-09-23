import type { Page } from '@playwright/test';
import { addMember, createProject, putModel, register, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const row = (page: Page, name: string) =>
	page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });

async function createThroughDialog(page: Page, name: string, description = '') {
	await page.getByRole('button', { name: 'New project' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New project' });
	await dialog.getByLabel('Name').fill(name);
	if (description) await dialog.getByLabel(/Description/).fill(description);
	await dialog.getByRole('button', { name: 'Create' }).click();
	// Creating opens the new project's workspace.
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Projects' }).click();
	await expect(row(page, name)).toBeVisible();
}

test('several projects for one place: create, copy, delete', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await expect(page.getByText('You have no projects yet.')).toBeVisible();

	await createThroughDialog(page, 'Example Valley — baseline', 'Current dams and crops');
	await createThroughDialog(page, 'Example Valley — dam raise');
	await createThroughDialog(page, 'Example Valley — drought');
	await expect(page.getByRole('row')).toHaveCount(4); // header + 3

	// Copy A (with a model, so the copy is meaningful) as D.
	const href = await row(page, 'Example Valley — baseline').getByRole('link', { name: 'Open' }).getAttribute('href');
	const idA = href!.split('/').pop()!;
	const model = sampleModel();
	await putModel(page.request, idA, model);

	await row(page, 'Example Valley — baseline').getByRole('button', { name: 'Copy Example Valley — baseline' }).click();
	const dialog = page.getByRole('dialog', { name: 'Copy project' });
	await expect(dialog.getByLabel('Name of the copy')).toHaveValue('Example Valley — baseline (copy)');
	await dialog.getByLabel('Name of the copy').fill('Example Valley — new orchard');
	await dialog.getByRole('button', { name: 'Copy' }).click();
	await expect(dialog).toBeHidden();
	await expect(row(page, 'Example Valley — new orchard')).toBeVisible();
	await expect(page.getByRole('row')).toHaveCount(5);

	// The copy carries A's model but is its own project.
	await row(page, 'Example Valley — new orchard').getByRole('link', { name: 'Example Valley — new orchard' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Example Valley — new orchard' })).toBeVisible();
	await expect(page).not.toHaveURL(new RegExp(idA));
	const stat = (term: string) => page.getByRole('term').filter({ hasText: term }).locator('xpath=following-sibling::dd');
	await expect(stat('Outflow gauge')).toHaveText('Outflow gauge');
	await expect(stat('Farms')).toHaveText(/^2\s*\+ 1 gauge$/);
	await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Projects' }).click();

	// Delete one (confirm dialog accepted).
	page.once('dialog', (d) => void d.accept());
	await row(page, 'Example Valley — drought').getByRole('button', { name: 'Delete Example Valley — drought' }).click();
	await expect(row(page, 'Example Valley — drought')).toHaveCount(0);
	await expect(page.getByRole('row')).toHaveCount(4);

	// Still gone after a reload (really deleted, not just hidden).
	await page.reload();
	await expect(row(page, 'Example Valley — baseline')).toBeVisible();
	await expect(row(page, 'Example Valley — drought')).toHaveCount(0);
});

test('cancelling the delete confirmation keeps the project', async ({ page, owner }) => {
	void owner;
	await createProject(page.request, 'Keep me');
	await page.goto('/');
	page.once('dialog', (d) => void d.dismiss());
	await row(page, 'Keep me').getByRole('button', { name: 'Delete Keep me' }).click();
	await page.reload();
	await expect(row(page, 'Keep me')).toBeVisible();
});

test('the list shows the role the user has on each project', async ({ page, owner, playwright }) => {
	await createProject(page.request, 'My own catchment');

	const other = await playwright.request.newContext();
	await register(other, 'Colleague');
	const shared = await createProject(other, 'Colleague catchment');
	const readOnly = await createProject(other, 'Colleague reference');
	await addMember(other, shared.id, owner.email, 'editor');
	await addMember(other, readOnly.id, owner.email, 'viewer');
	await other.dispose();

	await page.goto('/');
	await expect(row(page, 'My own catchment').getByRole('cell').nth(1)).toHaveText('owner');
	await expect(row(page, 'Colleague catchment').getByRole('cell').nth(1)).toHaveText('editor');
	await expect(row(page, 'Colleague reference').getByRole('cell').nth(1)).toHaveText('viewer');

	// Only owners get a Delete button; anyone may copy.
	await expect(row(page, 'My own catchment').getByRole('button', { name: /^Delete/ })).toBeVisible();
	await expect(row(page, 'Colleague catchment').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await expect(row(page, 'Colleague reference').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await expect(row(page, 'Colleague reference').getByRole('button', { name: 'Copy Colleague reference' })).toBeVisible();
});
