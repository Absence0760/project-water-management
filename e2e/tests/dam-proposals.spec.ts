// Dams → "Proposed from the register and the map" (issue #326 B-dams; docs/ui.md
// § Dams, docs/maps.md § Dams from the register and the map). A unit's dam on
// the map proposes its capacity from the registered dams within 1 km (the
// committed synthetic register, region Z) and its full-supply area from its
// polygon, each row with its source; Use asks first and saves that one value,
// and History names the source. A viewer reads the proposals but can't use
// them. The table is read, never the map's pixels. Invented data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { loadSyntheticDamRegister } from '../support/damRegister.ts';
import { API_URL } from '../support/env.ts';
import { DEMO, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('dam-proposals');
const rowOf = (page: Page, key: string) => panel(page).locator(`tr[data-key="${key}"]`);

/** The Dams page with the proposals for `unit` loaded. */
async function openProposals(page: Page, projectId: string, unit: string) {
	await page.goto(`/projects/${projectId}?tab=dams`);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
	await panel(page).getByLabel('Dam of').selectOption({ label: unit });
	await expect(panel(page).getByTestId('dam-proposals-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel(page).locator('caption')).toHaveText(`Values proposed for ${unit}’s dam, beside the saved model’s`);
}

test.beforeAll(async () => {
	await loadSyntheticDamRegister();
});

test('the seeded Sandspruit: a dam’s registered capacity and its polygon’s area are proposed, each with its source, to its viewer without Use', async ({ page }) => {
	test.setTimeout(120_000);
	await seedExamplesOnce(page.request);
	await page.goto('/login');
	await page.getByLabel('Email').fill(DEMO.email);
	await page.getByLabel('Password').fill(DEMO.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	const { projects } = (await (await page.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; name: string }[] };
	const id = projects.find((p) => p.name === SANDSPRUIT)!.id;

	await openProposals(page, id, 'Grootdraai');
	await expect(panel(page)).toContainText('Searched from “Grootdraai dam” (its polygon’s centre');
	await expect(panel(page).getByTestId('dam-proposals-synthetic')).toContainText('Synthetic test data.');
	const cap = rowOf(page, 'Z100/01');
	await expect(cap.getByRole('rowheader')).toContainText(/^Capacity: Grootdraai Dam \(Z100\/01\)\d+ m from the dam on the map · wall 9[.,]5 m · completed 1978/);
	await expect(cap.getByTestId('dam-proposal-source')).toHaveText('The register of dams, “synthetic”: SYNTHETIC test data, invented for this repository (not the DWS List of Registered Dams): Z100/01');
	await expect(cap.getByRole('cell').nth(1)).toHaveText(/^820\D000 m³$/);
	// demo@ is a viewer on Sandspruit (the analyst owns it): the values and sources, no Use.
	await expect(panel(page).getByRole('button', { name: /^Use / })).toHaveCount(0);
	await expect(panel(page)).toContainText('Only an editor can use a value.');
	const area = rowOf(page, 'area');
	await expect(area.getByRole('rowheader')).toContainText('Full-supply area: “Grootdraai dam”');
	await expect(area.getByTestId('dam-proposal-source')).toHaveText(/^The map: the dam polygon’s area, computed on the server/);
	// Only the dams within 1 km: Grootdraai's register entry, not its neighbours'.
	await expect(panel(page).getByTestId('dam-proposal-source')).toHaveCount(2);

	// Bosrand's registered dam is 1.5 km off: none proposed, the polygon's area still is.
	await panel(page).getByLabel('Dam of').selectOption({ label: 'Bosrand' });
	await expect(panel(page).locator('caption')).toHaveText('Values proposed for Bosrand’s dam, beside the saved model’s');
	await expect(panel(page).getByTestId('dam-proposals-none')).toHaveText('No registered dam within 1 km of the dam on the map.');
	await expect(panel(page).locator('tbody tr')).toHaveCount(1);
	await expectNoViolations(page, { include: '[data-testid="dam-proposals"]' });
});

test('an editor uses the map’s area, then the register’s capacity, one at a time; History names each source; a viewer can’t', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	// Upper farm's dam on the map, ~250 m from the synthetic register's Z100/07 (Bo-dam, 140 000 m³).
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'dam', name: 'Upper dam', nodeId: upper.id, geometry: { type: 'Polygon', coordinates: [box(21.32, -33.68, 0.004)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	const areaM2 = ((await made.json()) as { feature: { areaM2: number } }).feature.areaM2;

	await openProposals(page, project.id, 'Upper farm');
	const area = rowOf(page, 'area');
	await expect(area.getByRole('cell').nth(0)).toHaveText('Not set (estimated from capacity)');
	await area.getByRole('button', { name: 'Use the map’s area' }).click();
	// Cancel changes nothing.
	await answerConfirm(page, false, 'Set Upper farm’s full-supply area from the map?');
	await expect(area.getByRole('cell').nth(0)).toHaveText('Not set (estimated from capacity)');
	await area.getByRole('button', { name: 'Use the map’s area' }).click();
	await answerConfirm(page, true, /Set Upper farm’s full-supply area from the map\?\s*Upper farm’s dam has no area when full set/);
	await expect(panel(page).getByTestId('dam-proposals-notice')).toHaveText(/^Upper farm’s full-supply area is now [\d\s,.]+ m² \([\d,.]+ ha\), from the map\. Run the model to see its effect\.$/);
	await expect(area.getByRole('cell').last()).toHaveText('Saved');
	// The Use button is gone: the keyboard lands on what happened (ProposalPanel's notice), not the top of the page.
	await expect(panel(page).getByTestId('dam-proposals-notice')).toBeFocused();
	// Only that value changed.
	const model = async () => ((await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { nodes: { id: string; damAreaFullM2: number | null; damCapacityM3: number }[] }).nodes.find((n) => n.id === upper.id)!;
	expect((await model()).damAreaFullM2).toBeCloseTo(areaM2, 6);
	expect((await model()).damCapacityM3).toBe(150_000);

	const cap = rowOf(page, 'Z100/07');
	await expect(cap.getByTestId('dam-proposal-source')).toContainText('The register of dams, “synthetic”: SYNTHETIC');
	await cap.getByRole('button', { name: 'Use the capacity of Z100/07' }).click();
	await answerConfirm(page, true, /Set Upper farm’s dam capacity from the register\?\s*Upper farm’s dam capacity changes from 150\D000 m³ to 140\D000 m³/);
	await expect(panel(page).getByTestId('dam-proposals-notice')).toHaveText(/^Upper farm’s dam capacity is now 140\D000 m³, from the register of dams \(Z100\/07\)\./);
	await expect(cap.getByRole('cell').last()).toHaveText('Saved');
	expect((await model()).damCapacityM3).toBe(140_000);
	await expectNoViolations(page, { include: '[data-testid="dam-proposals"]' });

	// History names each source, newest first.
	await page.goto(`/projects/${project.id}?tab=history`);
	const entries = page.getByTestId('history-entry');
	await expect(entries.nth(0)).toContainText(/Dam capacity of Upper farm from the register of dams: Bo-dam \(Z100\/07, 140000 m³, \d+ m from “Upper dam”; SYNTHETIC/);
	await expect(entries.nth(1)).toContainText(/Dam full-supply area of Upper farm from the map: “Upper dam” \(\d+ m², computed from its polygon\)/);

	// A viewer reads the proposals, with their sources, and has no Use; on a phone nothing scrolls sideways.
	const viewer = await signIn('Dam proposals viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 390, height: 844 });
	await openProposals(v, project.id, 'Upper farm');
	await expect(rowOf(v, 'Z100/07').getByTestId('dam-proposal-source')).toContainText('SYNTHETIC');
	await expect(panel(v).getByRole('button', { name: /^Use / })).toHaveCount(0);
	await expect(panel(v)).toContainText('Only an editor can use a value.');
	await expectNoSidewaysScroll(v);
});

test('the box follows the picked dam: a card click or its Proposals link shows that dam’s proposals, as a fresh load of the URL does', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals follow');
	await createRun(page.request, project.id, 'Baseline');
	const lowerId = project.model.nodes.find((n) => n.name === 'Lower farm')!.id as string;
	await page.goto(`/projects/${project.id}?tab=dams`);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
	const card = (name: string) => page.getByRole('list', { name: 'Dams' }).getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
	const unit = panel(page).getByLabel('Dam of');

	// Picking a card moves the box to that dam.
	await card('Lower farm').locator('a.name').click();
	await expect(page).toHaveURL(new RegExp(`[?&]dam=${lowerId}$`));
	await expect(unit).toHaveValue(lowerId);
	await expect(panel(page).getByTestId('dam-proposals-no-dam')).toContainText('No dam on the map is linked to Lower farm.');

	// Dam of still picks any unit; the next pick moves it again.
	await unit.selectOption({ label: 'Upper farm' });
	await expect(panel(page).getByTestId('dam-proposals-no-dam')).toContainText('linked to Upper farm');
	await card('Upper farm').locator('a.name').click();
	await card('Lower farm').getByRole('link', { name: 'Lower farm: proposed from the register and the map' }).click();
	await expect(unit).toHaveValue(lowerId);
	// The link brings the box into view, the keyboard on its picker, without scrolling past every card by hand.
	await expect(panel(page).getByRole('heading', { name: 'Proposed from the register and the map' })).toBeInViewport();
	await expect(unit).toBeFocused();

	// A fresh load of the same URL agrees.
	await page.reload();
	await expect(unit).toHaveValue(lowerId);
});

test('the dam’s place is written in degrees with a hemisphere', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals place');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'dam', name: 'Upper dam', nodeId: upper.id, geometry: { type: 'Point', coordinates: [21.32, -33.68] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await openProposals(page, project.id, 'Upper farm');
	await expect(panel(page)).toContainText('Searched from “Upper dam” (a point, 33.6800° S, 21.3200° E)');
});
