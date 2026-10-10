// "Change a setting → Daily EWR at the outlet" (settings.set ewrDailySource,
// engine ≥ 1.77.0, issue #460; docs/scenarios.md § Op catalogue): a
// scenario judges the base by the DRM TAB file instead of the pragmatic EWR,
// without copying the project. The base keeps its TAB flows under the
// pragmatic EWR (entered, not used); the form reuses the Settings tab's
// editor, starting from that source, refuses a source the run couldn't use
// in the engine's words, and the list reads the change as a baseline
// assumption. After a run the full comparison's Inputs that differ lists the
// switch, and the catchment's own settings still use the pragmatic EWR.
// Synthetic catchment (support/api.ts).
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const NAME = 'Judged by the TAB file';
const TAB_M3S = [0.47, 0.4, 0.3, 0.2, 0.06, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4];
const CHANGE = 'Daily EWR at the outlet: the pragmatic EWR → the DRM TAB file, scaled by MAR (table 49.8 Mm³/a)';

test('a scenario switches the daily EWR at the outlet to the TAB file the base keeps, refusing a source the run could not use', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario daily EWR source');
	// The TAB flows entered but not used: the base runs the pragmatic EWR.
	await updateSettings(page.request, project.id, {
		ewrDailySource: { method: 'pragmatic', scaling: 'mar', tableMarMm3: 49.8, tableAreaKm2: null, tabM3s: TAB_M3S, naturalPctM3s: null, reservePctM3s: null }
	});
	const baseRun = await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=scenarios&new=1`);
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await expect(create.getByLabel('Base run')).toHaveValue(baseRun);
	await create.getByLabel('Name', { exact: true }).fill(NAME);
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: NAME })).toBeVisible();

	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Kind of change').selectOption({ label: 'Change a setting' });
	await form.getByLabel('Setting', { exact: true }).selectOption({ label: 'Daily EWR at the outlet' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: the pragmatic EWR');

	// The Settings tab's editor, starting from the base's source, tables and all.
	const daily = form.getByTestId('op-ewr-daily');
	const method = daily.getByLabel('Daily EWR from');
	await expect(method).toHaveValue('pragmatic');
	await method.selectOption('tab');
	await expect(daily.getByLabel('TAB flow, Oct, m³/s')).toHaveValue(/^0\.47/);
	await expect(daily.getByLabel('Table MAR (Mm³/a)')).toHaveValue('49.8');

	// The area ratio without the table's area: refused, not left for the run to drop back to the pragmatic EWR.
	await daily.getByLabel('Scale the tables by').selectOption('area');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(form.getByRole('alert')).toHaveText('Daily EWR at the outlet: scaling by area needs the table’s catchment area (km²)');
	await daily.getByLabel('Scale the tables by').selectOption('mar');
	await expectNoViolations(page);
	await form.getByRole('button', { name: 'Add change' }).click();

	const changes = page.getByRole('list', { name: `Changes in ${NAME}` }).getByRole('listitem');
	await expect(changes).toHaveCount(1);
	await expect(changes).toContainText(CHANGE);
	await expect(changes).toContainText('Baseline assumption');
	await page.reload();
	await expect(changes).toHaveCount(1);
	await expect(changes).toContainText(CHANGE);

	await page.getByRole('button', { name: 'Run scenario' }).click();
	const compare = page.getByRole('region', { name: 'Scenario against its base' });
	await expect(compare.getByRole('region', { name: 'Headline results' })).toBeVisible();
	await page.getByRole('link', { name: 'Open the full comparison' }).click();
	await expect(page.getByRole('region', { name: 'Inputs that differ' })).toContainText('Daily EWR at the outlet: the pragmatic EWR → the DRM TAB file');

	// The catchment's own settings still run the pragmatic EWR.
	const res = await page.request.get(`${API_URL}/projects/${project.id}`);
	expect(res.status()).toBe(200);
	expect(((await res.json()) as { project: { settings: { ewrDailySource?: { method: string } } } }).project.settings.ewrDailySource?.method).toBe('pragmatic');
});
