// The per-farm planted-areas drawer (issue #17, option A step 4): one farm's
// crops over any workspace tab, `farm=<nodeId>` in the URL, editing the same
// model as the Crops tab and saving through the page's save.
import type { Page } from '@playwright/test';
import { addMember, putModel, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const drawer = (page: Page, farm: string) => page.getByRole('dialog', { name: `${farm}: planted areas` });

async function savedArea(page: Page, projectId: string, farm: string): Promise<number> {
	const res = await page.request.get(`${API_URL}/projects/${projectId}/model`);
	const model = (await res.json()) as { nodes: { id: string; name: string }[]; cropAreas: { nodeId: string; areaM2: number }[] };
	const id = model.nodes.find((n) => n.name === farm)!.id;
	return model.cropAreas.filter((a) => a.nodeId === id).reduce((s, a) => s + a.areaM2, 0);
}

test('from a farm on the Network: edit its planted areas, see them on Crops & demand, save, close', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Farm drawer');
	await page.goto(`/projects/${project.id}?tab=network`);

	// On the map, picking the farm in the node list shows its card, whose irrigated area opens the drawer.
	await page.getByRole('list', { name: 'All nodes' }).getByRole('button', { name: /^Upper farm/ }).click();
	const card = page.getByTestId('node-card');
	await expect(card.getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await card.getByRole('link', { name: '20.00 ha, 1 crop' }).click();
	await expect(page).toHaveURL(/\?tab=network&farm=/);
	const d = drawer(page, 'Upper farm');
	await expect(d).toBeVisible();
	await expect(d.getByLabel('Orchard on Upper farm, ha')).toHaveValue('20');
	await expect(d.getByTestId('farm-demand')).toContainText('m³/day on average');
	await expect(d).toContainText('No unsaved changes');
	await expectNoViolations(page);

	await d.getByLabel('Orchard on Upper farm, ha').fill('35');
	await d.getByLabel('Orchard on Upper farm, ha').press('Tab');
	await expect(d.getByTestId('farm-total')).toHaveText('35.00 ha');
	await expect(d).toContainText('Unsaved changes to the model');

	// Done keeps the edit (unsaved), closes the drawer and drops it from the URL; Crops & demand shows it.
	await d.getByRole('button', { name: 'Done' }).click();
	await expect(d).toHaveCount(0);
	await expect(page).toHaveURL(/\?tab=network$/);
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toBeVisible();
	const nav = page.getByRole('navigation', { name: 'Project sections' });
	await nav.getByRole('link', { name: 'Crops & demand' }).click();
	// Its bar on Crops & demand follows the unsaved edit.
	await expect(page.getByRole('img', { name: 'Upper farm: 35 ha, Orchard 35 ha' })).toBeVisible();

	// Reopened from the card, now with the unsaved 35 ha, it saves through the page's save, with the reason.
	await nav.getByRole('link', { name: 'Network' }).click();
	await page.getByRole('list', { name: 'All nodes' }).getByRole('button', { name: /^Upper farm/ }).click();
	await card.getByRole('link', { name: '35.00 ha, 1 crop' }).click();
	const again = drawer(page, 'Upper farm');
	await expect(again.getByLabel('Orchard on Upper farm, ha')).toHaveValue('35');
	await again.getByRole('textbox', { name: 'Reason for this change (optional)' }).fill('New block planted');
	await again.getByRole('button', { name: 'Save changes' }).click();
	await expect(again).toContainText('No unsaved changes');
	expect(await savedArea(page, project.id, 'Upper farm')).toBe(350_000);
	await page.keyboard.press('Escape');
	await expect(again).toHaveCount(0);
	await expect(page).toHaveURL(/\?tab=network$/);
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toHaveCount(0);
});

test('from the Summary: a farm with nothing planted links straight to its planted areas', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Farm drawer summary');
	const model = { ...project.model, cropAreas: project.model.cropAreas.filter((a) => a.nodeId !== project.model.nodes[2]!.id) };
	await putModel(page.request, project.id, model);
	await page.goto(`/projects/${project.id}`);

	const item = page.getByRole('region', { name: 'Needs attention', exact: true }).locator('[data-attention="unplanted"]');
	await expect(item).toContainText('Lower farm has no planted area');
	await item.getByRole('link', { name: 'Set its planted areas' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?farm=${project.model.nodes[2]!.id}$`));
	const d = drawer(page, 'Lower farm');
	await expect(d).toContainText('Nothing planted, so this hydrological unit draws no irrigation water.');
	await d.getByLabel('Orchard on Lower farm, ha').fill('5');
	await d.getByLabel('Orchard on Lower farm, ha').press('Tab');
	await d.getByRole('button', { name: 'Done' }).click();
	// The Summary is still the page underneath, and the attention item has gone with the edit.
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
	await expect(item).toHaveCount(0);
});

test('a viewer sees a farm’s planted areas read-only, and a farm that is gone says so', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Farm drawer viewer');
	const viewer = await signIn('Farm drawer viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;

	await v.goto(`/projects/${project.id}?farm=${project.model.nodes[1]!.id}`);
	const d = drawer(v, 'Upper farm');
	await expect(d.getByLabel('Orchard on Upper farm, ha')).toHaveValue('20');
	await expect(d.getByLabel('Orchard on Upper farm, ha')).not.toBeEditable();
	await expect(d.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
	await d.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(v).not.toHaveURL(/farm=/);

	await v.goto(`/projects/${project.id}?farm=not-a-farm`);
	await expect(v.getByRole('dialog', { name: 'Hydrological unit not found' })).toContainText("This hydrological unit isn't in the model any more.");
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the drawer fills the screen and has no violations', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Farm drawer phone');
		await page.goto(`/projects/${project.id}?farm=${project.model.nodes[1]!.id}`);
		const d = drawer(page, 'Upper farm');
		await expect(d.getByLabel('Orchard on Upper farm, ha')).toBeVisible();
		const box = (await d.boundingBox())!;
		// Edge to edge (the page's scrollbar gutter aside), and the first area has focus.
		expect(box.x).toBe(0);
		expect(box.width).toBeGreaterThan(360);
		await expect(d.getByLabel('Orchard on Upper farm, ha')).toBeFocused();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		// Check the drawer whole: the land-cover panel at its foot loaded (its map link is a phone target too).
		await expect(d.getByTestId('cropland-body')).toHaveAttribute('data-ready', 'true');
		await expect(d.getByTestId('cropland-catchment').getByRole('link')).toBeVisible();
		await expectNoViolations(page);
	});
});
