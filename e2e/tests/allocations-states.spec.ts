// The Allocations page's states between actions (docs/ui.md § Allocations, ux-hunt 2026-10-30): what the page shows
// while another run's comparison loads or after it failed, where the focus goes when a registered volume or an
// import is removed, and what the "What viewers see" switch shows when saving it failed,
// and a `unit=` link to a unit not on the run's list. Synthetic data only.
import type { Page, Route } from '@playwright/test';
import { addAllocation, compareCard, openAllocations, volumesCard } from '../support/allocations.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const header = (page: Page) => page.getByTestId('section-header');
const detail = (page: Page) => page.getByTestId('allocation-unit');
const failWith = (error: string) => (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error }) });

test('switching the run never shows the last run’s comparison under the new one’s name, and a failed one says so with Try again, to a viewer too', async ({ page, owner, signIn, fetchRoute }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Allocations run switch');
	const upper = project.model.nodes[1]!;
	await addAllocation(page.request, project.id, { nodeId: upper.id as string, registrationNo: 'SW-1', authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 40_000 });
	const first = await createRun(page.request, project.id, 'First');
	const second = await createRun(page.request, project.id, 'Second');
	await openAllocations(page, project.id, `&run=${second}`);
	await expect(compareCard(page)).toBeVisible();
	const compare = page.getByTestId('allocation-compare');

	// First's comparison is held: the page names First, so Second's units must not stay on screen meanwhile.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	const hold = await fetchRoute(page, `${API_URL}/projects/${project.id}/runs/${first}/allocations*`, async (route) => {
		await held;
		await route.fallback();
	});
	await header(page).getByLabel('Run compared').selectOption(first);
	await expect(compare).toContainText('Run “First”');
	await expect(compare.getByRole('status').filter({ hasText: 'Loading…' })).toBeVisible();
	await expect(compareCard(page)).toHaveCount(0);
	release();
	await expect(compareCard(page)).toBeVisible();
	await expect(page.getByTestId('allocations-page')).toHaveAttribute('aria-busy', 'false');
	await hold.unroute();

	// A viewer, who reads totals only (162, D3): a run whose comparison fails says so, with Try again, never nothing.
	const viewer = await signIn('Allocations run switch viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 960 });
	const fail = await fetchRoute(v, `${API_URL}/projects/${project.id}/runs/${first}/allocations*`, failWith('Comparison store unavailable'));
	await openAllocations(v, project.id, `&run=${first}`);
	const totals = v.getByTestId('allocation-totals');
	await expect(totals).toBeVisible();
	const alert = totals.getByRole('alert');
	await expect(alert).toContainText('Comparison store unavailable');
	await fail.unroute();
	await alert.getByRole('button', { name: 'Try again' }).click();
	await expect(totals.getByRole('alert')).toHaveCount(0);
	await expect(v.getByTestId('allocations-page')).toHaveAttribute('aria-busy', 'false');
});

test('deleting a registered volume or removing an import puts the focus on what took its place', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Allocations focus');
	const upper = project.model.nodes[1]!;
	for (const reg of ['FA-1', 'FA-2', 'FA-3'])
		await addAllocation(page.request, project.id, { nodeId: upper.id as string, registrationNo: reg, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 30_000 });
	const imported = await page.request.post(`${API_URL}/projects/${project.id}/allocations/import/commit`, {
		data: { kind: 'csv', fileName: 'focus-import.csv', reference: '', text: 'registration_no,farm,authorisation,water_source,volume_m3_year\nFL-1,Lower farm,licence,surface,50000\n', matches: {} }
	});
	expect(imported.status(), await imported.text()).toBe(201);
	await createRun(page.request, project.id, 'Baseline');
	await openAllocations(page, project.id, `&unit=${upper.id}`);
	const table = volumesCard(page).getByTestId('allocation-list');
	await expect(table.locator('tbody tr')).toHaveCount(4);

	// The list: FL-1 (Lower farm), FA-1, FA-2, FA-3. FA-2 goes; FA-3, now in its place, takes the focus on its Delete.
	await table.getByRole('button', { name: 'Delete FA-2' }).click();
	await answerConfirm(page, true, 'FA-2');
	await expect(table.getByRole('button', { name: 'Delete FA-2' })).toHaveCount(0);
	await expect(table.getByRole('button', { name: 'Delete FA-3' })).toBeFocused();

	// The picked unit's volumes: FA-1, FA-3. FA-3 (the last) goes; FA-1 takes the focus; then FA-1, and the unit's heading does.
	await detail(page).getByRole('button', { name: 'Delete FA-3' }).click();
	await answerConfirm(page, true, 'FA-3');
	await expect(detail(page).getByRole('button', { name: 'Delete FA-1' })).toBeFocused();
	await detail(page).getByRole('button', { name: 'Delete FA-1' }).click();
	await answerConfirm(page, true, 'FA-1');
	await expect(detail(page).getByText('None: the model abstracts here')).toBeVisible();
	await expect(detail(page).getByRole('heading', { level: 2 })).toBeFocused();

	// The one import goes with its row: the Registered volumes heading takes the focus.
	await volumesCard(page).getByRole('button', { name: 'Remove this import' }).click();
	await answerConfirm(page, true, 'focus-import.csv');
	await expect(page.getByTestId('allocations-empty')).toBeVisible();
	await expect(volumesCard(page).getByRole('heading', { name: 'Registered volumes' })).toBeFocused();
});

test('a failed "What viewers see" save says so as an error and leaves the switch as it is saved', async ({ page, owner, fetchRoute }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Allocations switch failure');
	await openAllocations(page, project.id);
	const sw = page.getByTestId('allocation-viewer-units').getByRole('checkbox', { name: 'Viewers see each farm’s registered volumes' });
	await expect(sw).not.toBeChecked();
	const fail = await fetchRoute(page, `${API_URL}/projects/${project.id}/allocations/viewer-units`, failWith('Settings store unavailable'));
	await sw.click();
	await expect(page.getByRole('alert').filter({ hasText: 'Settings store unavailable' })).toBeVisible();
	await expect(sw).not.toBeChecked();
	await fail.unroute();
	// Saved for real: the switch and the page say so, and the error is gone.
	await sw.check();
	await expect(page.getByRole('status').filter({ hasText: 'Viewers now see each farm’s registered volumes.' })).toBeVisible();
	await expect(page.getByRole('alert').filter({ hasText: 'Settings store unavailable' })).toHaveCount(0);
	await expect(sw).toBeChecked();
});

test('a unit link to a unit not on the run’s list says so, like a run link to a deleted run, and picking a unit clears it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Allocations stale unit');
	const upper = project.model.nodes[1]!;
	await addAllocation(page.request, project.id, { nodeId: upper.id as string, registrationNo: 'SU-1', authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 40_000 });
	await createRun(page.request, project.id, 'Stale unit');
	const note = page.getByRole('note').filter({ hasText: 'That hydrological unit isn’t in this run' });

	// Positive control: a link to a unit on the list picks it, with no note.
	await openAllocations(page, project.id, `&unit=${upper.id as string}`);
	await expect(compareCard(page)).toBeVisible();
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText(upper.name as string);
	await expect(note).toHaveCount(0);

	// A unit the run doesn't have: the first on the list is shown, and the note names it.
	await openAllocations(page, project.id, '&unit=00000000-0000-0000-0000-000000000000');
	await expect(compareCard(page)).toBeVisible();
	const first = compareCard(page).getByRole('listitem').first().getByRole('link');
	const firstName = (await first.textContent())!.trim();
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText(firstName);
	await expect(note).toHaveText(`That hydrological unit isn’t in this run, so this shows ${firstName}.`);
	await expect(page.getByTestId('allocation-compare')).toContainText('Run “Stale unit”');

	// Picking a unit replaces the dead id in the address, and the note goes.
	await first.click();
	await expect(page).not.toHaveURL(/unit=00000000-/);
	await expect(page).toHaveURL(/[?&]unit=[0-9a-f-]{36}/);
	await expect(note).toHaveCount(0);
});
