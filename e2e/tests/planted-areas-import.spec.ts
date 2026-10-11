// Import plantings (issue #477; docs/ui.md § Import plantings): a CSV of
// farm, crop and planted area, uploaded on Crops & demand. The preview
// counts what matches, what is added and what can't be read (by its line);
// an unknown crop becomes a crop type that needs its factors, an unknown farm
// a new hydrological unit, flagged as needing placing, when asked; Apply is
// an unsaved edit the save bar saves. The File formats help page gathers
// every Expected format, this one too. Synthetic names and values only.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveModelChanges } from '../support/network.ts';

type SavedModel = {
	nodes: { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number }[];
	crops: { id: string; name: string; cropFactor: number[]; irrigationSystemId?: string | null }[];
	cropAreas: { nodeId: string; cropId: string; areaM2: number; irrigationSystemId?: string }[];
	irrigationSystems?: { id: string; name: string }[];
};

async function savedModel(page: Page, projectId: string): Promise<SavedModel> {
	return (await (await page.request.get(`${API_URL}/projects/${projectId}/model`)).json()) as SavedModel;
}

const csv = (text: string) => ({ name: 'plantings.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });

test('upload a list: the preview, a new crop and a new unit, apply, then save', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Import plantings');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.getByRole('button', { name: 'Import plantings…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Import plantings' });

	// The Expected format, its template (read back through the box below) and the link to every format.
	const help = dialog.getByTestId('format-help');
	await help.getByText(/^Expected format/).click();
	await expect(help.getByTestId('format-accepts')).toHaveText(/^A CSV file \(\.csv, comma- or semicolon-separated\)/);
	await expect(help.getByTestId('format-all-link')).toHaveAttribute('href', /\/help\/formats#plantings$/);
	const [download] = await Promise.all([page.waitForEvent('download'), help.getByRole('link', { name: 'Download the template' }).click()]);
	expect(download.suggestedFilename()).toBe('plantings-template.csv');
	const template = await readFile((await download.path())!, 'utf8');
	await dialog.getByTestId('plantings-file').setInputFiles(csv(template));
	await expect(dialog.getByTestId('plantings-summary')).toHaveText('5 rows read, 4 planted areas change, adds 3 crop types, 1 farm not in the project.');
	await expectNoViolations(page, { include: 'dialog[open]' });

	// The list to import: names in other capitals and spacing, a new crop, a farm the network lacks and a bad row.
	await dialog
		.getByTestId('plantings-file')
		.setInputFiles(csv('Farm,Crop,Area (ha),Irrigation system\r\nupper  FARM,orchard,25,\r\nLower farm,Pecans,12.5,Micro-sprinkler\r\nLower farm,Orchard,abc,\r\nHill farm,Orchard,4,\r\n'));
	const summary = dialog.getByTestId('plantings-summary');
	await expect(summary).toHaveText('4 rows read, 2 planted areas change, adds 1 crop type, 1 farm not in the project, 1 row with a problem.');
	await expect(dialog.getByTestId('plantings-errors')).toHaveText('Line 4: Lower farm, Orchard: “abc” isn’t a number of hectares.');
	await expect(dialog.getByTestId('plantings-new-crops')).toContainText('Pecans');
	await expect(dialog.getByTestId('plantings-new-crops')).toContainText('needs crop factors');
	const farms = dialog.getByTestId('plantings-new-farms');
	await expect(farms).toContainText('Hill farm');
	await expect(farms).toContainText('Left unticked, their rows are left out');
	const changes = dialog.getByTestId('plantings-changes').getByRole('row');
	await expect(changes).toHaveText([/^Farm\s*Crop/, /^Upper farm\s*Orchard\s*20\s*25/, /^Lower farm\s*Pecans\s*new\s*–\s*12\.5\s*Micro-sprinkler, 82 %$/]);

	// Asked to, the farm becomes a new unit that needs placing.
	await farms.getByLabel('Add it as new hydrological units').check();
	await expect(summary).toHaveText('4 rows read, 3 planted areas change, adds 1 crop type, adds 1 hydrological unit, 1 row with a problem.');
	await expect(farms).toContainText('needs placing');
	await expectNoViolations(page, { include: 'dialog[open]' });
	await dialog.getByRole('button', { name: 'Apply 3 changes' }).click();
	await expect(dialog).toBeHidden();

	// The edit is unsaved: the crop list shows the new crop as needing its factors, and the save bar saves it.
	const pecans = page.getByTestId('crop-row').filter({ hasText: 'Pecans' });
	await expect(pecans).toContainText('12.5 ha · needs crop factors');
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toBeVisible();
	const before = await savedModel(page, project.id);
	expect(before.crops.map((c) => c.name)).toEqual(['Orchard']);
	expect((await saveModelChanges(page)).ok()).toBe(true);

	const m = await savedModel(page, project.id);
	const byName = (n: string) => m.nodes.find((x) => x.name === n)!;
	const crop = m.crops.find((c) => c.name === 'Pecans')!;
	expect(crop.cropFactor).toEqual(new Array(12).fill(0));
	// On the system its rows named (a saved model keeps its own table of systems, each with its own id).
	expect(m.irrigationSystems?.find((x) => x.id === crop.irrigationSystemId)?.name).toBe('Micro-sprinkler');
	const hill = byName('Hill farm');
	expect([hill.kind, hill.downstreamNodeId, hill.areaKm2]).toEqual(['farm', byName('Outflow gauge').id, 0]);
	const orchard = m.crops.find((c) => c.name === 'Orchard')!.id;
	const area = (node: string, cropId: string) => m.cropAreas.find((a) => a.nodeId === byName(node).id && a.cropId === cropId)?.areaM2;
	expect([area('Upper farm', orchard), area('Lower farm', orchard), area('Lower farm', crop.id), area('Hill farm', orchard)]).toEqual([250_000, 120_000, 125_000, 40_000]);

	// On the Network page the new unit says it needs placing.
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByRole('list', { name: 'All hydrological units' }).getByRole('button', { name: /^Hill farm/ }).click();
	await expect(page.getByTestId('node-card').getByTestId('node-needs-placing')).toHaveText('Needs placing: no catchment area yet. Set its area and where it drains with Edit.');
});

test('paste rows from a spreadsheet; a list without its heading row is refused with the layout to use', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Import plantings paste');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.getByRole('button', { name: 'Import plantings…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Import plantings' });
	const box = dialog.getByLabel('…or paste the rows, with their heading row');
	await box.fill('Upper farm\tOrchard\t30');
	await expect(dialog.getByTestId('plantings-summary')).toHaveText(/^The first row must be the heading row, with Farm, Crop, Area \(ha\) columns/);
	await expect(dialog.getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();
	// As Excel copies them: tab-separated, a decimal comma.
	await box.fill('Farm\tCrop\tArea (ha)\nUpper farm\tOrchard\t30,5');
	await expect(dialog.getByTestId('plantings-summary')).toHaveText('1 row read, 1 planted area changes.');
	await dialog.getByRole('button', { name: 'Apply 1 change' }).click();
	await expect(page.getByTestId('crop-row').filter({ hasText: 'Orchard' })).toContainText('42.5 ha');
});

test('the File formats help page lists every format, this one with its template', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/formats#plantings');
	await expect(page.getByRole('heading', { level: 1, name: 'File formats' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('listitem')).toHaveText(['Help', 'Reference', 'File formats']);
	const plantings = page.locator('article#plantings');
	await expect(plantings.getByRole('heading', { level: 3 })).toHaveText('Planted areas, a row per planting');
	await expect(plantings).toContainText('Where: Crops & demand → Import plantings');
	await expect(plantings.getByRole('link', { name: 'Download the template' })).toHaveAttribute('download', 'plantings-template.csv');
	// Every format, each with an anchor its note links to.
	expect(await page.getByTestId('file-format').count()).toBeGreaterThan(15);
	await expect(page.locator('article#map-geojson')).toContainText('Shapefiles and KML aren’t read');
	await expect(page.getByRole('navigation', { name: 'Help' }).getByRole('link', { name: 'File formats' })).toHaveAttribute('aria-current', 'page');
	await expectNoViolations(page);
});
