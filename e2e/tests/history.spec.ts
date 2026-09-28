// The History tab (WP-2.4, docs/ui.md § History): a change saved with a
// reason shows up with who, when and why, and "Restore this version" puts the
// earlier value back. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, putModel, putSeries, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { historyDetail } from '../support/history.ts';
import { closeModal, openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const entries = (page: Page) => page.getByTestId('history-entry');

async function openCapacity(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · unit' });
	return page.getByLabel('Capacity (m³)');
}

test('edit a dam capacity with a reason, see it in History, restore the earlier version', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'History round trip');

	const capacity = await openCapacity(page, project.id);
	await expect(capacity).toHaveValue('150\u202f000');
	// Editing starts from the plain number once the field has focus.
	await capacity.focus();
	await expect(capacity).toHaveValue('150000');
	await capacity.fill('200000');
	await capacity.blur();
	await page.locator('dialog[open]').getByLabel('Reason for this change (optional)').fill('Surveyed in August');
	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();
	await closeModal(page);

	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'History' }).click();
	await expect(page).toHaveURL(/tab=history/);
	const newest = entries(page).first();
	await expect(newest).toContainText('Model changed');
	await expect(newest).toContainText('Upper farm: dam capacity 150\u202f000 m³ → 200\u202f000 m³');
	await expect(newest).toContainText('Reason: Surveyed in August');
	await expect(page.getByRole('heading', { level: 3, name: 'Today' })).toBeVisible();

	// The parameter filter narrows to the matching line.
	await page.getByLabel('Parameter').fill('dam capacity');
	await expect(entries(page)).toHaveCount(1);
	await page.getByLabel('Parameter').fill('');

	// The version before the save: the seeding's settings change, the next entry that has a version to restore.
	// On a wide page the restore buttons are in the picked change's detail, beside the list.
	const before = entries(page).filter({ hasText: 'Settings changed' }).first();
	await before.getByRole('link').click();
	await historyDetail(page).getByRole('button', { name: 'Restore this version' }).click();
	const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Upper farm: dam capacity 200\u202f000 m³ → 150\u202f000 m³');
	await expectNoViolations(page);
	await dialog.getByLabel('Reason for restoring (optional)').fill('Back to the licence figure');
	await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'Restored the version of' })).toBeVisible();
	await expect(entries(page).first()).toContainText('Earlier version restored');
	await expect(entries(page).first()).toContainText('Reason: Back to the licence figure');

	await expect(await openCapacity(page, project.id)).toHaveValue('150\u202f000');
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
	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();

	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	const since = page.getByRole('region', { name: 'Changes since this run' });
	await since.getByText('Changes since this run').click();
	// The net difference, then the change recorded since the run.
	await expect(since.getByRole('listitem').filter({ hasText: /^Changed Upper farm: dam capacity 150 000 m³ → 175 000 m³$/ })).toBeVisible();
	await expect(since.getByRole('listitem').filter({ hasText: 'Model changed: Upper farm: dam capacity 150\u202f000 m³ → 175\u202f000 m³' })).toBeVisible();
	await page.getByRole('button', { name: 'Restore these inputs' }).click();
	const dialog = page.getByRole('dialog', { name: 'Restore this run’s inputs?' });
	await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText('This run’s inputs are restored.')).toBeVisible();
	await expect(since.getByText('The saved inputs are the ones this run used.')).toBeVisible();
	await expect(await openCapacity(page, project.id)).toHaveValue('150\u202f000');
});

test('the compare page and the Project page say who changed an input between two runs, and when (issue #42)', async ({ page, owner, signIn }) => {
	const project = await seedRunnableProject(page.request, 'History attribution');
	const baseline = await createRun(page.request, project.id, 'Baseline');
	// Another member raises the dam, with a reason.
	const editor = await signIn('Dam editor');
	await addMember(page.request, project.id, editor.user.email, 'editor');
	const raised = { ...project.model, nodes: project.model.nodes.map((n) => (n.name === 'Upper farm' ? { ...n, damCapacityM3: 180_000 } : n)) };
	await putModel(editor.page.request, project.id, { ...raised, reason: 'Licence application' } as typeof raised);
	const after = await createRun(page.request, project.id, 'Raised');

	await page.goto(`/compare?a=${project.id}:${baseline}&b=${project.id}:${after}`);
	const changes = page.getByRole('region', { name: 'What changed' });
	await expect(changes.getByTestId('changes-attribution')).toHaveText(/1 saved change to the model or settings between the runs, by Dam editor\./);
	const line = changes.getByRole('listitem').filter({ hasText: 'Upper farm: dam capacity 150\u202f000 m³ → 180\u202f000 m³' });
	await expect(line).toContainText(/Changed by Dam editor on \d{4}-\d{2}-\d{2} \d{2}:\d{2} · “Licence application”/);
	await expectNoViolations(page);

	await page.goto(`/projects/${project.id}?tab=project`);
	const recent = page.getByRole('region', { name: 'Recent changes' });
	await expect(recent.getByRole('listitem').first()).toContainText('Model changed: Upper farm: dam capacity 150\u202f000 m³ → 180\u202f000 m³');
	await expect(recent.getByRole('listitem').first()).toContainText('Dam editor ·');
	await expect(recent.getByRole('listitem').first()).toContainText('“Licence application”');
	void owner;
});

test("a series merge in History restores the series' earlier values, and the restore can be undone", async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'History series restore');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3] });
	const merged = await page.request.post(`${API_URL}/projects/${project.id}/series/merge`, {
		data: { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-03', values: [30, 4] }
	});
	expect(merged.status()).toBe(200);
	const stored = async () => {
		const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string }[];
		return (await (await page.request.get(`${API_URL}/projects/${project.id}/series/${list[0]!.id}`)).json()).values as number[];
	};
	expect(await stored()).toEqual([1, 2, 30, 4]);

	await page.goto(`/projects/${project.id}?tab=history`);
	const entry = entries(page).filter({ hasText: 'Merged days into the Rainfall — catchment series' });
	await entry.getByRole('link').click();
	await historyDetail(page).getByRole('button', { name: 'Restore the earlier values' }).click();
	const dialog = page.getByRole('dialog', { name: 'Restore the earlier values?' });
	await expect(dialog).toContainText('The Rainfall — catchment series goes back to the values it held before the change of');
	await dialog.getByRole('button', { name: 'Restore values' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'Put back the values of the Rainfall — catchment series' })).toBeVisible();
	expect(await stored()).toEqual([1, 2, 3]);

	// The restore is an entry of its own, and it kept the values it replaced.
	const restore = entries(page).filter({ hasText: 'Restored earlier values of the Rainfall — catchment series' });
	// The restore is the newest entry, picked once the page reloads its list.
	await expect(restore.getByRole('link')).toHaveAttribute('aria-current', 'true');
	await historyDetail(page).getByRole('button', { name: 'Restore the earlier values' }).click();
	await dialog.getByRole('button', { name: 'Restore values' }).click();
	await expect(dialog).toBeHidden();
	expect(await stored()).toEqual([1, 2, 30, 4]);
});

test('a viewer sees series changes in History but no restore button', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'History series viewer');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [2] });
	// Positive control: the owner has the button.
	await page.goto(`/projects/${project.id}?tab=history`);
	const replaced = entries(page).filter({ hasText: 'Replaced the Rainfall — catchment series' });
	await replaced.getByRole('link').click();
	await expect(historyDetail(page).getByRole('button', { name: 'Restore the earlier values' })).toBeVisible();
	const viewer = await signIn('History series viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=history`);
	const seen = viewer.page.getByTestId('history-entry').filter({ hasText: 'Replaced the Rainfall — catchment series' });
	await seen.getByRole('link').click();
	await expect(historyDetail(viewer.page)).toContainText('Replaced the Rainfall — catchment series');
	await expect(viewer.page.getByRole('button', { name: 'Restore the earlier values' })).toHaveCount(0);
});

test('a field says how often it changed, and links to History filtered to it (WP-2.4)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Field history');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	const capacity = await openCapacity(page, project.id);
	const line = page.locator('dialog[open] .field').filter({ has: capacity }).getByTestId('field-history');
	// Set when the unit was added, never changed since: no line.
	await expect(capacity).toHaveValue('150\u202f000');
	await expect(line).toHaveCount(0);

	for (const [was, v] of [['150000', '200000'], ['200000', '250000']] as const) {
		// Editing starts from the plain number once the field has focus.
		await capacity.focus();
		await expect(capacity).toHaveValue(was);
		await capacity.fill(v);
		await capacity.blur();
		await saveModelChanges(page);
		await expect(saveBar(page)).toBeHidden();
	}
	// The sheet stays open after a save; the line follows the saves.
	await expect(line).toHaveText(/^Changed 2× · last by .+, \d{1,2} \w{3} \d{4}: 200\u202f000 m³ → 250\u202f000 m³$/);
	await expectNoViolations(page);

	await line.click();
	await expect(page).toHaveURL(/tab=history/);
	const url = new URL(page.url());
	expect(url.searchParams.get('kind')).toBe('revision');
	expect(url.searchParams.get('unit')).toBe(upper.id);
	expect(url.searchParams.get('q')).toBe('Upper farm: dam capacity');
	await expect(page.getByLabel('Parameter')).toHaveValue('Upper farm: dam capacity');
	await expect(entries(page)).toHaveCount(2);
	await expect(entries(page).first()).toContainText('Upper farm: dam capacity 200\u202f000 m³ → 250\u202f000 m³');
	await expect(entries(page).last()).toContainText('Upper farm: dam capacity 150\u202f000 m³ → 200\u202f000 m³');
});
