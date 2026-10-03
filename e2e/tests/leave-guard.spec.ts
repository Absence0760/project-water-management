// The leave guard (issue #162 items 11, 12, 13; docs/ui.md § Leaving with
// unsaved changes): leaving the project with unsaved work asks first, in the
// app's own dialog that names what is unsaved and where the link goes; Stay
// keeps it, Leave goes. Model edits, the project details (on the page's save
// bar) and a half-filled scenario change all count. Synthetic data only.
import type { Page } from '@playwright/test';
import { createProject, createRun, putModel, sampleModel, seedRunnableProject } from '../support/api.ts';
import { answerConfirm, confirmBox } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal } from '../support/network.ts';
import { createScenario, openScenarios } from '../support/scenarios.ts';

const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const projectsLink = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' });
const projectsHeading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Projects' });

test('unsaved model edits: a tab change keeps them without asking; leaving asks, and Stay keeps the page', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Guard tabs');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	await page.getByLabel('Area of Upper farm, km²', { exact: true }).fill('99');
	await closeModal(page);

	// Another section of the same project: no question, the edit goes along.
	await sections(page).getByRole('link', { name: 'Crops & demand', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Crops & demand' })).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toBeVisible();

	// The projects list: the app asks; Stay keeps the project and its URL.
	await projectsLink(page).click();
	await answerConfirm(page, false, 'Leave and go to All projects?');
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=crops`));
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toBeVisible();

	// Discarded: nothing asks any more.
	await page.getByRole('region', { name: 'Unsaved model changes' }).getByRole('button', { name: 'Discard' }).click();
	await answerConfirm(page, true, 'Your unsaved changes to the network will be lost.');
	await projectsLink(page).click();
	await expect(projectsHeading(page)).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
});

test('unsaved settings: another section keeps them without asking; another page asks, and Stay keeps the form', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Guard settings');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const apan = page.getByLabel('A-pan evaporation, Oct, mm');
	await apan.fill('152');
	await apan.blur();

	// Another section: no question; the page holds the settings, so they are there on the way back.
	await sections(page).getByRole('link', { name: 'Network', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Network' })).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	await expect(page.getByRole('region', { name: 'Unsaved settings' })).toContainText('Unsaved changes to the settings');
	await expect(page.getByTestId('section-header').getByText('Unsaved changes', { exact: true })).toBeVisible();
	await sections(page).getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(apan).toHaveValue('152');

	// The projects list: asked, naming the settings; Stay keeps the form.
	await projectsLink(page).click();
	await answerConfirm(page, false, 'You have unsaved changes (settings). Leave and go to All projects?');
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=settings`));
	await expect(apan).toHaveValue('152');
	// Leave: gone, and nothing was saved.
	await projectsLink(page).click();
	await answerConfirm(page, true);
	await expect(projectsHeading(page)).toBeVisible();
	const res = await page.request.get(`${API_URL}/projects/${project.id}`);
	expect(((await res.json()) as { project: { settings: { apanMm: number[] } } }).project.settings.apanMm[0]).toBe(0);
});

test('Back with unsaved project details asks; Leave takes the step back', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Guard details');
	await page.goto('/');
	await page.getByRole('link', { name: 'Guard details', exact: true }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: 'Guard details' })).toBeVisible();
	await sections(page).getByRole('link', { name: 'Project', exact: true }).click();
	await page.getByLabel('Description').fill('Not saved yet');

	// Another section keeps the edit (the page holds it), and the header says it is unsaved.
	await sections(page).getByRole('link', { name: 'Summary', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Unsaved project details' })).toContainText('Unsaved changes to the project details');
	await expect(page.getByTestId('section-header').getByText('Unsaved changes', { exact: true })).toBeVisible();
	await sections(page).getByRole('link', { name: 'Project', exact: true }).click();
	await expect(page.getByLabel('Description')).toHaveValue('Not saved yet');

	// Back through the sections asks nothing; the step back to the projects list asks (in the app, not the browser's box).
	await page.goBack();
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole('heading', { level: 1, name: 'Project', exact: true })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	await page.goBack();
	await answerConfirm(page, false, 'You have unsaved changes (project details). Leave and go to All projects?');
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));
	await page.goBack();
	await answerConfirm(page, true);
	await expect(projectsHeading(page)).toBeVisible();
	// Nothing was saved.
	await page.getByRole('link', { name: 'Guard details', exact: true }).click();
	await sections(page).getByRole('link', { name: 'Project', exact: true }).click();
	await expect(page.getByLabel('Description')).toHaveValue('');
});

test('a just-created scenario with a half-filled change asks before leaving the scenario, not before a chart setting', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Guard scenario');
	const runId = await createRun(page.request, project.id, 'Baseline');
	await createScenario(page.request, project.id, { name: 'Older what-if', baseRunId: runId });
	await openScenarios(page, project.id);

	// Made here, just now; a change half filled in.
	await page.getByTestId('section-header').getByRole('link', { name: '+ New scenario', exact: true }).click();
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await create.getByLabel('Name', { exact: true }).fill('Just made');
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Just made' })).toBeVisible();
	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });

	// Another section: asked, naming it; Stay keeps the form as it was.
	await sections(page).getByRole('link', { name: 'Summary', exact: true }).click();
	await answerConfirm(page, false, 'You have unsaved changes (a change not yet added to the scenario). Leave and go to the Summary page?');
	await expect(form.getByLabel('Node')).toHaveValue(/.+/);
	await expect(page.getByRole('heading', { level: 2, name: 'Just made' })).toBeVisible();

	// Another scenario in the list: asked too; Leave opens it.
	await page.getByRole('region', { name: 'All scenarios' }).getByRole('button', { name: /^Older what-if/ }).click();
	await answerConfirm(page, true, 'Leave and go to another scenario?');
	await expect(page.getByRole('heading', { level: 2, name: 'Older what-if' })).toBeVisible();
});
