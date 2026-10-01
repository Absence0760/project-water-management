// A pump capacity on an other water user (engine 1.58.0, roadmap WP-3.8,
// issue #54 item 2b, docs/model.md §2.7c): a town the lower farm drains into
// gets a pump from 1 pump × 10 m³/h (240 m³/day) in the Other water users
// panel; save, reload and read it back (blank is no limit); run, and see what
// its pump took and left unmet in Other uses on Units & supply, the
// curtailment table staying the users' one list.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { node, putModel, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeTable, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('a town’s pump of 1 × 10 m³/h saves 240 m³/day, and the run shows what it pumped and left unmet', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Town with a pump');
	// The town sits in-line below the lower farm, so the river reaches it (a senior user wanting 800 m³/day).
	const model = structuredClone(project.model);
	const gauge = model.nodes.find((n) => n.kind === 'gauge')! as { id: string };
	const town = node('Town', 'farm', gauge.id, 4, { kind: 'user', areaKm2: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, pctRunoffToDam: 0, userDemandM3Day: new Array(12).fill(800) });
	model.nodes.find((n) => n.name === 'Lower farm')!.downstreamNodeId = town.id;
	model.nodes.push(town);
	await putModel(page.request, project.id, model);
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeTable(page);
	const users = page.getByRole('region', { name: /^Other water users/ });
	await expect(users.getByLabel('Demand of Town in Oct, m³/day')).toHaveValue('800');

	// The default: no limit.
	const pump = users.getByTestId(/^user-pump-/).first();
	await expect(pump.getByLabel('Pump capacity (m³/day)')).toHaveValue('');
	await expect(pump.getByTestId('user-pump-note')).toHaveText('Blank is no limit: it takes its demand from whatever reaches it.');
	// The calculator fills the one stored number.
	await pump.getByLabel('Number of pumps').fill('1');
	await pump.getByLabel('m³/h per pump').fill('10');
	await expect(pump.getByTestId('user-pump-note')).toHaveText('1 × 10 m³/h × 24 h = 240 m³/day.');
	await expect(pump.getByLabel('Pump capacity (m³/day)')).toHaveValue('240');
	await expectNoViolations(page, { include: '[data-testid^="user-pump-"]' });

	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);
	await page.reload();
	await openNodeTable(page);
	const again = page.getByRole('region', { name: /^Other water users/ }).getByTestId(/^user-pump-/).first();
	await expect(again.getByLabel('Pump capacity (m³/day)')).toHaveValue('240');
	// A senior user (the default): the units upstream pass no more than the pump takes.
	await expect(again.getByTestId('user-pump-note')).toHaveText('It takes at most 240 m³/day from the river; units upstream pass no more than that for it. Or enter the pumps and their rate to work it out.');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Town pump');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Town pump' })).toBeVisible();
	// The Summary links to Other uses, where the pumps table is.
	const link = page.getByTestId('other-uses-link');
	await expect(link).toHaveText('Other water users’ pumps: Other uses on Units & supply.');
	await link.getByRole('link').click();
	await expect(page).toHaveURL(/[?&]tab=supply\b.*#res-other-uses$/);
	const pumps = page.getByRole('table', { name: 'Other water users’ pumps' });
	const row = pumps.getByRole('row', { name: /^Town/ });
	await expect(row.getByRole('cell').nth(0)).toHaveText('800');
	// It never pumps more than 240 m³/day, so its mean is at most that, and the pump leaves most of the 800 unmet.
	const pumped = Number((await row.getByRole('cell').nth(1).innerText()).replace(/[\s ,]/g, ''));
	expect(pumped).toBeGreaterThan(0);
	expect(pumped).toBeLessThanOrEqual(240);
	await expect(row.getByRole('cell').nth(2)).not.toHaveText('0');
	// The curtailment table stays the users' one list; the users table isn't drawn beside it.
	await expect(page.getByRole('table', { name: 'Other water users', exact: true })).toHaveCount(1);
	await expect(page.locator('table.users')).toHaveCount(0);
});
