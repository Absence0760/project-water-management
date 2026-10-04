// Registered volumes in the Demands grid (docs/ui.md § Demands grid,
// docs/allocations.md): each unit's or user's registered volume in force,
// once per node beside the sum of its demands, flagged in words when the
// demands are above it; a viewer reads a note instead while the owners keep
// per-unit volumes from viewers, and a project with none says so.
// Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addAllocation } from '../support/allocations.ts';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const grid = (page: Page) => page.getByTestId('demands-grid');

/** The sample (no A-pan, so the crops ask nothing), a 100 m³/day town and 200 head of cattle on Upper farm, and a 40 m³/day quarry. */
function model() {
	const m = sampleModel();
	const [gauge, upper] = m.nodes as { id: string }[];
	const base = { count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0, destination: 'internal', enabled: true, note: '' };
	const quarry = {
		...(m.nodes[1] as object),
		id: crypto.randomUUID(),
		name: 'Quarry',
		kind: 'user',
		downstreamNodeId: gauge!.id,
		sortOrder: 4,
		damCapacityM3: 0,
		userDemandM3Day: new Array(12).fill(40),
		userReturnPct: 0,
		userPriority: 'senior'
	};
	return {
		...m,
		nodes: [...m.nodes, quarry],
		demandObjects: [
			{ ...base, id: crypto.randomUUID(), nodeId: upper!.id, name: 'Town', category: 'municipal', sizing: 'monthly', monthlyM3Day: new Array(12).fill(100), priority: 'first' },
			{ ...base, id: crypto.randomUUID(), nodeId: upper!.id, name: 'Cattle', category: 'livestock', sizing: 'perUnit', monthlyM3Day: null, count: 200, litresPerUnitDay: 50, priority: 'last' }
		]
	};
}

test('registered volumes beside the demands: once per unit, flagged above, never a viewer’s unless allowed', async ({ page, owner, signIn }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Demands registered');
	const m = model();
	await putModel(page.request, project.id, m);
	const [, upper, lower, quarry] = m.nodes as { id: string }[];

	// None yet: the grid says so, and has no column.
	await page.goto(`/projects/${project.id}?tab=network&grid=demands`);
	await expect(grid(page).getByTestId('demands-registered-note')).toHaveText(/No registered volumes in this project yet/);
	await expect(grid(page).getByRole('columnheader', { name: /Registered/ })).toHaveCount(0);

	// Upper farm: 30 000 + 5 000 groundwater against ~40 178 m³ a year of demand (town 36 525, cattle 3 652.5): above the ±10 % band.
	// A dam's storage-only row and a lapsed licence don't count. The quarry: 15 000 against 14 610, within it.
	await addAllocation(page.request, project.id, { nodeId: upper!.id, authorisation: 'registration', waterSource: 'surface', volumeM3PerYear: 30_000 });
	await addAllocation(page.request, project.id, { nodeId: upper!.id, authorisation: 'registration', waterSource: 'groundwater', volumeM3PerYear: 5_000 });
	await addAllocation(page.request, project.id, { nodeId: upper!.id, authorisation: 'registration', waterSource: 'surface', volumeM3PerYear: 0, storageM3: 150_000, waterUse: '21b' });
	await addAllocation(page.request, project.id, { nodeId: upper!.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 900_000, validTo: '2020-09-30' });
	await addAllocation(page.request, project.id, { nodeId: quarry!.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 15_000 });
	await page.reload();

	await expect(grid(page).getByRole('columnheader', { name: /Registered/ })).toBeVisible();
	// One cell for Upper farm, spanning its three rows, on its first.
	const upperCell = grid(page).locator(`[data-registered="${upper!.id}"]`);
	await expect(upperCell).toHaveCount(1);
	await expect(upperCell).toHaveAttribute('rowspan', '3');
	await expect(upperCell).toHaveAttribute('data-status', 'over');
	await expect(upperCell).toContainText('0.035');
	await expect(upperCell).toContainText('Above registered: 0.040 for the unit');
	const quarryCell = grid(page).locator(`[data-registered="${quarry!.id}"]`);
	await expect(quarryCell).toHaveAttribute('data-status', 'within');
	await expect(quarryCell).toContainText('Within band');
	// Lower farm's crops ask nothing (no A-pan) and it has nothing registered: a dash, no flag.
	await expect(grid(page).locator(`[data-registered="${lower!.id}"]`)).toHaveText('–');
	await expect(grid(page).getByTestId('demands-registered-note')).toContainText('1 is above registered.');
	await expectNoViolations(page, { include: '[data-testid="demands-grid"]' });

	// A viewer: no per-unit volumes while the owners haven't allowed them (D3), only a note.
	const viewer = await signIn('Demands registered viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=network&grid=demands`);
	await expect(grid(viewer.page).getByTestId('demands-registered-note')).toHaveText(/aren't shown to viewers/);
	await expect(grid(viewer.page).getByRole('columnheader', { name: /Registered/ })).toHaveCount(0);
	await expect(grid(viewer.page)).not.toContainText('0.035');
});
