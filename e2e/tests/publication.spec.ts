// Publishing a run (WP-2.3, docs/ui.md § Publishing a run): an editor
// publishes the shown run from the Runs tab through a confirm dialog that
// says what changes for stakeholders and warns about dams with no stop
// level; the run gets a "Published" badge and loses its delete button; the
// notice changes without re-publishing; and a farmer linked to a farm then
// reads the published figures and the notice through the farm API.
import { API_URL } from '../support/env.ts';
import { createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('an editor publishes a run with a notice, then changes the notice; a farmer reads it', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Publish a run');
	// One farm dam with no stop level, for the dialog's warning.
	const model = { ...project.model, nodes: project.model.nodes.map((n) => (n.name === 'Lower farm' ? { ...n, damMinPct: 0 } : n)) };
	await putModel(page.request, project.id, model);
	await createRun(page.request, project.id, 'Scratch');
	await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=runs`);
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	const row = (label: string) => list.getByRole('listitem').filter({ has: page.getByRole('button', { name: new RegExp(`^${label}`) }) });
	await expect(row('Baseline').getByRole('button', { name: /^Delete run/ })).toBeVisible();
	const panel = page.getByRole('region', { name: /^Publication/ });
	await expect(panel).toContainText('Nothing is published yet');

	await panel.getByRole('button', { name: 'Publish this run' }).click();
	const dialog = page.getByRole('dialog', { name: 'Publish this run?' });
	await expect(dialog).toContainText('it becomes the first published baseline');
	await expect(dialog.getByRole('status')).toHaveText(/^1 hydrological unit’s dam has no stop level/);
	await dialog.getByLabel('Level').selectOption('advisory');
	await dialog.getByLabel(/^Cut/).fill('10');
	// One field per language of the table, English first, each marked with its language.
	await expect(dialog.getByRole('textbox', { name: /^Notice in / })).toHaveCount(2);
	await expect(dialog.getByRole('textbox', { name: /^Notice in / }).first()).toHaveAccessibleName(/^Notice in English/);
	await expect(dialog.getByLabel('Notice in English')).toHaveAttribute('lang', 'en');
	await expect(dialog.getByLabel('Notice in Afrikaans')).toHaveAttribute('lang', 'af');
	await dialog.getByLabel('Notice in English').fill('The river is low. Please irrigate at night.');
	await dialog.getByLabel(/^Next update expected/).fill('2022-02-15');
	await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
	await expect(dialog).toBeHidden();

	await expect(panel.getByRole('status')).toHaveText('Published. 2 farmer views updated.');
	await expect(panel.getByRole('heading', { name: /Publication/ }).getByText('Published', { exact: true })).toBeVisible();
	await expect(panel.getByRole('definition').first()).toHaveText('Advisory · 10 %');
	// The next update is a calendar day, shown as one (never shifted through a timezone).
	await expect(panel.getByRole('definition').last()).toHaveText('15 Feb 2022');
	await expect(row('Baseline').getByText('Published', { exact: true })).toBeVisible();
	await expect(row('Scratch').getByText('Published', { exact: true })).toHaveCount(0);
	// A published run is kept: no delete button.
	await expect(row('Baseline').getByRole('button', { name: /^Delete run/ })).toHaveCount(0);
	await expect(row('Scratch').getByRole('button', { name: /^Delete run/ })).toBeVisible();

	// The notice changes without re-publishing.
	await panel.getByRole('button', { name: 'Edit notice' }).click();
	const form = panel.getByRole('form', { name: 'Edit the notice' });
	await form.getByLabel('Level').selectOption('restricted');
	await form.getByLabel(/^Cut/).fill('25');
	await form.getByRole('button', { name: 'Save notice' }).click();
	await expect(panel.getByRole('status')).toHaveText('Notice saved.');
	await expect(panel.getByRole('definition').first()).toHaveText('Restricted · 25 %');

	// Another run of the project isn't the published one.
	await row('Scratch').getByRole('button', { name: /^Scratch/ }).click();
	await expect(panel).toContainText('This run is not published.');
	await expect(panel.getByRole('button', { name: 'Publish this run' })).toBeVisible();

	// A farmer linked to the upper farm reads the published figures and the notice (the farm page itself is WP-2.6's).
	const farmer = await signIn('Publication farmer');
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	const add = await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper] } });
	expect(add.status()).toBe(201);
	const view = await farmer.page.request.get(`${API_URL}/projects/${project.id}/farm/${upper}`);
	expect(view.status()).toBe(200);
	const body = await view.json();
	expect(body.farm.name).toBe('Upper farm');
	expect(body.publication.restriction).toEqual({ level: 'restricted', pct: 25, notice: { en: 'The river is low. Please irrigate at night.' } });
	expect(body.publication.nextExpectedOn).toBe('2022-02-15');
	expect(JSON.stringify(body)).not.toContain('Lower farm');
});
