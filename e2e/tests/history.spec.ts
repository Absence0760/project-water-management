// The History tab (WP-2.4, docs/ui.md § History): a change saved with a
// reason shows up with who, when and why, and "Restore this version" puts the
// earlier value back. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const entries = (page: Page) => page.getByTestId('history-entry');

async function openCapacity(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=network`);
	await page.getByRole('button', { name: 'One node' }).click();
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · farm' });
	return page.getByLabel('Capacity (m³)');
}

test('edit a dam capacity with a reason, see it in History, restore the earlier version', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'History round trip');

	const capacity = await openCapacity(page, project.id);
	await expect(capacity).toHaveValue('150,000');
	// Editing starts from the plain number once the field has focus.
	await capacity.focus();
	await expect(capacity).toHaveValue('150000');
	await capacity.fill('200000');
	await capacity.blur();
	await saveBar(page).getByLabel('Reason for this change (optional)').fill('Surveyed in August');
	await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
	await expect(saveBar(page)).toBeHidden();

	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'History' }).click();
	await expect(page).toHaveURL(/tab=history/);
	const newest = entries(page).first();
	await expect(newest).toContainText('Model changed');
	await expect(newest).toContainText('Upper farm: dam capacity 150,000 m³ → 200,000 m³');
	await expect(newest).toContainText('Reason: Surveyed in August');
	await expect(page.getByRole('heading', { level: 3, name: 'Today' })).toBeVisible();

	// The parameter filter narrows to the matching line.
	await page.getByLabel('Parameter').fill('dam capacity');
	await expect(entries(page)).toHaveCount(1);
	await page.getByLabel('Parameter').fill('');

	// The version before the save: the seeding's settings change, the next entry that has a version to restore.
	const before = entries(page).filter({ hasText: 'Settings changed' }).first();
	await before.getByRole('button', { name: 'Restore this version' }).click();
	const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Upper farm: dam capacity 200,000 m³ → 150,000 m³');
	await expectNoViolations(page);
	await dialog.getByLabel('Reason for restoring (optional)').fill('Back to the licence figure');
	await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'Restored the version of' })).toBeVisible();
	await expect(entries(page).first()).toContainText('Earlier version restored');
	await expect(entries(page).first()).toContainText('Reason: Back to the licence figure');

	await expect(await openCapacity(page, project.id)).toHaveValue('150,000');
});

test('a viewer reads the history but has no restore button', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'History viewer');
	const viewer = await signIn('History viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=history`);
	await expect(entries(viewer.page).first()).toBeVisible();
	await expect(viewer.page.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
	await expectNoViolations(viewer.page);
});

test('a run shows the changes since it, and restores its inputs', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'History run inputs');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const capacity = await openCapacity(page, project.id);
	await capacity.focus();
	await expect(capacity).toHaveValue('150000');
	await capacity.fill('175000');
	await capacity.blur();
	await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
	await expect(saveBar(page)).toBeHidden();

	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	const since = page.getByRole('region', { name: 'Changes since this run' });
	await since.getByText('Changes since this run').click();
	// The net difference, then the change recorded since the run.
	await expect(since.getByRole('listitem').filter({ hasText: /^Changed Upper farm: dam capacity 150,000 m³ → 175,000 m³$/ })).toBeVisible();
	await expect(since.getByRole('listitem').filter({ hasText: 'Model changed: Upper farm: dam capacity 150,000 m³ → 175,000 m³' })).toBeVisible();
	await page.getByRole('button', { name: 'Restore these inputs' }).click();
	const dialog = page.getByRole('dialog', { name: 'Restore this run’s inputs?' });
	await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText('This run’s inputs are restored.')).toBeVisible();
	await expect(since.getByText('The saved inputs are the ones this run used.')).toBeVisible();
	await expect(await openCapacity(page, project.id)).toHaveValue('150,000');
});
