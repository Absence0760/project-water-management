// "Set an EWR site's rule table" (ewrRule.set, engine ≥ 1.6.0, WP-3.7;
// docs/scenarios.md § Op catalogue, docs/ui.md § Scenarios): an editor gives
// the outlet a desktop-estimate Reserve rule table through the "Add a change"
// form, which reuses the Settings tab's table editor. The form refuses a
// table Settings wouldn't save, in the same words; the list reads the table
// with its confidence line and classes it a baseline assumption even with
// every node the proposer's; after a run the full comparison's Scenario
// overrides show it the same way, and Inputs that differ lists the table. The
// catchment's own settings are never touched. Synthetic catchment
// (support/api.ts).
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const NAME = 'Desktop Reserve at the outlet';
const TABLE = 'Reserve rule table at the outlet (Outflow gauge): none → “Invented desktop estimate” (Desktop estimate, low confidence), total flow, 10 % points';

test('an editor sets the outlet’s Reserve rule table in a scenario, always a baseline assumption', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario EWR rule table');
	const baseRun = await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=scenarios&new=1`);
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await expect(create.getByLabel('Base run')).toHaveValue(baseRun);
	await create.getByLabel('Name', { exact: true }).fill(NAME);
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: NAME })).toBeVisible();

	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Kind of change').selectOption({ label: "Set an EWR site's rule table" });
	await expect(form.getByTestId('op-ewr-baseline')).toContainText('Always a baseline assumption');
	await form.getByLabel('EWR site', { exact: true }).first().selectOption({ label: 'Outlet (Outflow gauge)' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: no rule table');

	// The Settings tab's editor, at this site only; a table without a source is refused in its words.
	const table = form.getByRole('group', { name: 'Rule table at Outlet (Outflow gauge)' });
	await expect(table).toBeVisible();
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(form.getByRole('alert')).toHaveText('Say where the table comes from (Reserve determination, gazette notice, table).');

	await table.getByLabel('Source', { exact: true }).fill('Invented desktop estimate');
	await table.getByLabel('Kind of source').selectOption('desktop');
	await expectNoViolations(page);
	await form.getByRole('button', { name: 'Add change' }).click();
	const changes = page.getByRole('list', { name: `Changes in ${NAME}` }).getByRole('listitem');
	await expect(changes).toHaveCount(1);
	await expect(changes).toContainText(TABLE);
	await expect(changes).toContainText('Baseline assumption');
	await expect(page.getByTestId('baseline-callout')).toContainText('Baseline assumptions changed');

	// Still a baseline assumption with every hydrological unit the proposer's: the Reserve is never the proposal.
	// (The gauge isn't listed: a gauge proposes nothing.)
	const proposer = page.getByRole('group', { name: "The proposer's hydrological units" });
	await expect(proposer.getByLabel('Outflow gauge')).toHaveCount(0);
	for (const n of ['Upper farm', 'Lower farm']) await proposer.getByLabel(n).check();
	await page.reload();
	await expect(changes).toHaveCount(1);
	await expect(changes).toContainText('Baseline assumption');

	await page.getByRole('button', { name: 'Run scenario' }).click();
	const compare = page.getByRole('region', { name: 'Scenario against its base' });
	await expect(compare.getByRole('region', { name: 'Headline results' })).toBeVisible();
	await page.getByRole('link', { name: 'Open the full comparison' }).click();
	const overrides = page.getByRole('region', { name: 'Scenario overrides' });
	const recorded = overrides.getByRole('list', { name: `Changes in scenario ${NAME} (run B)` }).getByRole('listitem');
	await expect(recorded).toHaveCount(1);
	await expect(recorded).toContainText(TABLE);
	await expect(recorded).toContainText('Baseline assumption');
	await expect(overrides.getByTestId('baseline-callout')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Inputs that differ' })).toContainText('EWR rule table at');

	// The catchment's own settings keep no rule table.
	const res = await page.request.get(`${API_URL}/projects/${project.id}`);
	expect(res.status()).toBe(200);
	expect(((await res.json()) as { project: { settings: { ewrRules?: unknown[] } } }).project.settings.ewrRules ?? []).toEqual([]);
});
