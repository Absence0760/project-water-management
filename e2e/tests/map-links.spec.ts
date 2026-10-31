// "Show on map" links into the Map tab (issue #326 A2; docs/ui.md § Network,
// § Hydrological units, § Dams): the Network's selected-node card and node
// sheet, and each card on the Hydrological units and Dams pages, link to
// `?tab=map&node=<nodeId>` for a node a map feature is linked to, and to
// nothing for one without. A viewer gets the links too. The links only:
// what the Map tab selects from `node=` is catchment-map.spec.ts's.
// The same read carries a linked dam outline's Siting, which the node sheet
// shows beside Upstream inflow to dam, warning when the share contradicts it.
// Synthetic data only: the sample model and an invented parcel.
import type { APIRequestContext } from '@playwright/test';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box, showTab } from '../support/map.ts';
import { openNodeForm } from '../support/network.ts';

/** A parcel linked to one unit, and a boundary linked to none. */
async function seedMap(request: APIRequestContext, projectId: string, nodeId: string): Promise<void> {
	const post = (data: Record<string, unknown>) => request.post(`${API_URL}/projects/${projectId}/map/features`, { data });
	expect((await post({ kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [box(21.3, -33.7, 0.1)] } })).status()).toBe(201);
	expect((await post({ kind: 'farm_parcel', name: 'Upper parcel', nodeId, geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.03)] } })).status()).toBe(201);
}

async function seed(request: APIRequestContext, name: string) {
	const project = await seedRunnableProject(request, name);
	const [, upper, lower] = project.model.nodes as { id: string; name: string }[];
	await seedMap(request, project.id, upper!.id);
	await createRun(request, project.id, 'Baseline');
	return { id: project.id, upper: upper!.id, lower: lower!.id };
}

test('a unit with a parcel links to it on the map from the Network, Hydrological units and Dams; one without has no link', async ({ page, owner }) => {
	void owner;
	const p = await seed(page.request, 'Map links');
	const href = `?tab=map&node=${p.upper}`;

	// The Network: the selected node's card, then a node with nothing on the map (after the first link showed, so the list has loaded).
	await page.goto(`/projects/${p.id}?tab=network&node=${p.upper}`);
	const card = page.getByTestId('node-card');
	await expect(card.getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await expect(card.getByTestId('node-card-map')).toHaveAttribute('href', href);
	await expect(card.getByTestId('node-card-map')).toHaveAccessibleName('Show on map (Upper farm)');
	await page.getByRole('button', { name: /^Lower farm/ }).click();
	await expect(card.getByRole('heading', { name: 'Lower farm' })).toBeVisible();
	await expect(card.getByTestId('node-card-map')).toHaveCount(0);

	// The node sheet says it too.
	await page.goto(`/projects/${p.id}?tab=network&edit=${p.upper}`);
	await expect(page.getByTestId('node-detail-map')).toHaveAttribute('href', href);
	await page.getByLabel('Hydrological unit to edit').selectOption(p.lower);
	await expect(page).toHaveURL(new RegExp(`edit=${p.lower}`));
	await expect(page.getByRole('dialog')).toContainText('Lower farm');
	await expect(page.getByTestId('node-detail-map')).toHaveCount(0);

	// Hydrological units: a link on the unit's card, none on the other's.
	await page.goto(`/projects/${p.id}?tab=supply`);
	const units = page.getByRole('list', { name: 'Hydrological units' });
	await expect(units.getByRole('link', { name: 'Show on map (Upper farm)' })).toHaveAttribute('href', href);
	await expect(units.locator(`[data-unit="${p.lower}"]`).getByRole('link', { name: 'Lower farm on the Network' })).toBeVisible();
	await expect(units.getByTestId('unit-map-link')).toHaveCount(1);

	// Dams: the same, per dam.
	await page.goto(`/projects/${p.id}?tab=dams`);
	const dams = page.getByRole('list', { name: 'Dams' });
	await expect(dams.getByRole('link', { name: 'Show on map (Upper farm)' })).toHaveAttribute('href', href);
	await expect(dams.locator(`[data-dam="${p.lower}"]`).getByRole('link', { name: 'Lower farm on the Network' })).toBeVisible();
	await expect(dams.getByTestId('dam-map-link')).toHaveCount(1);

	// Following it opens the Map tab on that node.
	await dams.getByRole('link', { name: 'Show on map (Upper farm)' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=map&node=${p.upper}$`));
	await expect(page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Map', exact: true })).toHaveAttribute('aria-current', 'page');
	// … with that unit's parcel picked: its Details shown, and pressed in the list.
	await expect(page.getByTestId('map-feature-card').getByRole('heading', { name: 'Upper parcel' })).toBeVisible();
	await showTab(page, 'features');
	await expect(page.getByTestId('map-feature-list').getByRole('button', { name: /^Upper parcel/ })).toHaveAttribute('aria-pressed', 'true');
});

test('a viewer gets the links too', async ({ page, owner, signIn }) => {
	void owner;
	const p = await seed(page.request, 'Map links viewer');
	const viewer = await signIn('Map links viewer');
	await addMember(page.request, p.id, viewer.user.email, 'viewer');

	await viewer.page.goto(`/projects/${p.id}?tab=supply`);
	await expect(viewer.page.getByRole('list', { name: 'Hydrological units' }).getByRole('link', { name: 'Show on map (Upper farm)' })).toHaveAttribute('href', `?tab=map&node=${p.upper}`);
	await viewer.page.goto(`/projects/${p.id}?tab=network&node=${p.upper}`);
	await expect(viewer.page.getByTestId('node-card-map')).toHaveAttribute('href', `?tab=map&node=${p.upper}`);
});

test('the node sheet shows a linked dam’s Siting beside Upstream inflow to dam, and warns when the share contradicts it', async ({ page, owner }) => {
	void owner;
	const p = await seed(page.request, 'Dam siting hint');
	// Upper farm's dam (150 000 m³, Upstream inflow to dam 0 % in the sample) drawn as its outline and marked on the river.
	const post = await page.request.post(`${API_URL}/projects/${p.id}/map/features`, {
		data: { kind: 'dam', name: 'Upper weir pool', nodeId: p.upper, geometry: { type: 'Polygon', coordinates: [box(21.32, -33.68, 0.004)] } }
	});
	expect(post.status()).toBe(201);
	const damId = ((await post.json()) as { feature: { id: string } }).feature.id;
	expect((await page.request.patch(`${API_URL}/projects/${p.id}/map/features/${damId}`, { data: { damPosition: 'on_channel' } })).status()).toBe(200);

	await page.goto(`/projects/${p.id}?tab=network&edit=${p.upper}`);
	const sheet = await openNodeForm(page);
	const routing = sheet.getByRole('group', { name: 'Routing', exact: true });
	const share = routing.getByLabel('Upstream inflow to dam (%)', { exact: true });
	await expect(routing.getByTestId('node-dam-siting')).toHaveText('On the map, its dam “Upper weir pool” is marked on the river.');
	// On the river at 0 %: a warning, in the field's description, and the field stays editable (never a block).
	const warning = routing.getByTestId('node-dam-siting-warning');
	await expect(warning).toHaveText(/^The map marks this dam on the river, but Upstream inflow to dam is 0 %/);
	await expect(share).toHaveAccessibleDescription(/marked on the river\. The map marks this dam on the river/);
	await expect(share).toBeEditable();
	// Typed to 100 %, as the Siting says: the warning goes, the Siting stays.
	await share.fill('100');
	await expect(warning).toHaveCount(0);
	await expect(routing.getByTestId('node-dam-siting')).toBeVisible();
	// Lower farm has no dam on the map: no Siting line.
	await page.getByLabel('Hydrological unit to edit').selectOption(p.lower);
	await expect(page).toHaveURL(new RegExp(`edit=${p.lower}`));
	await expect(page.getByRole('dialog')).toContainText('Lower farm');
	await expect(page.getByTestId('node-dam-siting')).toHaveCount(0);
});
