// The workspace's save bar (frontend lib/components/model/SaveBar.svelte; docs/ui.md
// § Project workspace, the save bar): it names the areas with unsaved edits, lists
// the problems that block a save as links to where they are fixed (even from a page
// the problem isn't on, and with that page hidden from the sidebar), asks before
// Discard, and says "Changes saved" / "Changes discarded" with the focus on the
// page's title once it goes. The header's Run model saves unsaved edits first.
// Synthetic data only.
import type { Page } from '@playwright/test';
import { createProject, putModel, sampleModel, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { answerConfirm, confirmBox } from '../support/confirm.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTransfers, ruleCard } from '../support/transfers.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const title = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });

test('the bar names the areas changed; Discard asks, Cancel keeps the edits, and Discard changes says so', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Bar discard');
	await putModel(page.request, project.id, sampleModel());
	await openTransfers(page, project.id);
	await page.getByLabel('Daily cap of transfer 1, m³', { exact: true }).fill('500');
	await page.getByLabel('Daily cap of transfer 1, m³', { exact: true }).blur();
	// Only the area that changed is named.
	await expect(saveBar(page)).toContainText('Unsaved changes to the model (transfers)');

	await saveBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
	await answerConfirm(page, false, 'Your unsaved changes to transfers will be lost.');
	await expect(page.getByLabel('Daily cap of transfer 1, m³', { exact: true })).toHaveValue('500');
	await expect(saveBar(page)).toBeVisible();

	await saveBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
	await expect(confirmBox(page).getByTestId('confirm-ok')).toHaveText('Discard changes');
	await answerConfirm(page, true);
	await expect(saveBar(page)).toBeHidden();
	await expect(page.getByLabel('Daily cap of transfer 1, m³', { exact: true })).toHaveValue('');
	// The button that had the focus is gone: the page's title takes it, and the change is announced.
	await expect(title(page, 'Transfers')).toBeFocused();
	await expect(page.getByTestId('savebar-announcement')).toHaveText('Changes discarded.');
});

test('after Save changes the focus is on the page title and "Changes saved" is announced', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Bar saved');
	await putModel(page.request, project.id, sampleModel());
	await openTransfers(page, project.id);
	await page.getByLabel('Priority of transfer 1 (lower moves first)', { exact: true }).fill('3');
	await page.getByLabel('Priority of transfer 1 (lower moves first)', { exact: true }).blur();
	await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
	await expect(saveBar(page)).toBeHidden();
	await expect(title(page, 'Transfers')).toBeFocused();
	await expect(page.getByTestId('savebar-announcement')).toHaveText('Changes saved.');
});

test('a rule with a problem is marked, and the bar links to it from another page, with Transfers hidden', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Bar problems');
	await putModel(page.request, project.id, sampleModel());
	expect((await page.request.patch(`${API_URL}/auth/me`, { data: { preferences: { hiddenTabs: ['transfers'] } } })).status()).toBe(200);
	await openTransfers(page, project.id);
	// The open page shows in the strip though hidden.
	await page.getByLabel('To, transfer 1', { exact: true }).selectOption({ label: 'Upper farm' });
	const card = ruleCard(page, 1);
	await expect(card).toContainText('Source and destination are the same node.');
	// Its edge in the danger colour.
	const edge = await card.evaluate((el) => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--danger)';
		el.append(probe);
		const danger = getComputedStyle(probe).color;
		probe.remove();
		return { danger, edge: getComputedStyle(el).borderLeftColor };
	});
	expect(edge.edge).toBe(edge.danger);

	// Another page: the hidden Transfers stays in the sidebar while it has a problem, with its dot.
	await sections(page).getByRole('link', { name: 'Summary', exact: true }).click();
	await expect(title(page, 'Summary')).toBeVisible();
	await expect(sections(page).getByRole('link', { name: /^Transfers/ })).toContainText('(has problems)');
	await expect(saveBar(page)).toContainText('1 problem to fix before saving');
	const save = saveBar(page).getByRole('button', { name: 'Save changes' });
	await expect(save).toBeDisabled();
	await expect(save).toHaveAccessibleDescription(/Transfer 1: source and destination are the same node\./);
	// The link lands on the rule, its heading focused.
	await saveBar(page).getByRole('link', { name: 'Transfer 1: source and destination are the same node.' }).click();
	await expect(title(page, 'Transfers')).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1', exact: true })).toBeFocused();
	await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1', exact: true })).toBeInViewport();
});

test('Run model with unsaved edits asks to save first, then runs the saved edits; a problem stops it with the reason', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Bar run');
	await openTransfers(page, project.id);
	const run = page.getByTestId('section-header').getByRole('button', { name: 'Run model', exact: true });

	// A problem: the run is refused, saying why, and Show the problem goes to it.
	await page.getByLabel('To, transfer 1', { exact: true }).selectOption({ label: 'Upper farm' });
	await run.click();
	await answerConfirm(page, false, 'A run uses the saved model, and your unsaved model edits can’t be saved yet');
	await expect(page).toHaveURL(/tab=transfers/);
	await page.getByLabel('To, transfer 1', { exact: true }).selectOption({ label: 'Lower farm' });

	// A real edit: Cancel runs nothing; Save and run saves it, then runs.
	await page.getByLabel('Daily cap of transfer 1, m³', { exact: true }).fill('500');
	await page.getByLabel('Daily cap of transfer 1, m³', { exact: true }).blur();
	await expect(run).toHaveAccessibleDescription(/your unsaved model edits are saved first/);
	await run.click();
	await answerConfirm(page, false, 'Save your changes and run?');
	await expect(saveBar(page)).toBeVisible();
	const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/projects/${project.id}/model`));
	const ran = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/projects/${project.id}/runs`));
	await run.click();
	await expect(confirmBox(page).getByTestId('confirm-ok')).toHaveText('Save and run');
	await answerConfirm(page, true, 'A run uses the saved model. Your unsaved model edits aren’t in it yet');
	expect((await saved).status()).toBe(200);
	expect((await ran).status()).toBeLessThan(300);
	await expect(page).toHaveURL(/tab=runs&run=/);
	await expect(saveBar(page)).toBeHidden();
	const model = await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json();
	expect(model.transfers[0].dailyCapM3).toBe(500);
});

test('a number that needs fixing counts as unsaved: the bar lists it, and leaving asks', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Bar invalid number');
	await putModel(page.request, project.id, sampleModel());
	await openTransfers(page, project.id);
	await page.getByLabel('Takes from, transfer 1', { exact: true }).selectOption('dam');
	const storage = page.getByLabel('Min source storage of transfer 1, %', { exact: true });
	await storage.fill('120');
	await storage.blur();
	await expect(saveBar(page)).toContainText('1 problem to fix before saving');
	await expect(saveBar(page).getByRole('link', { name: /^Min source storage of transfer 1, %/ })).toBeVisible();
	await expect(saveBar(page).getByRole('button', { name: 'Save changes' })).toBeDisabled();

	// Another page drops the field (it unmounts): asked first; Stay keeps the text.
	await sections(page).getByRole('link', { name: 'Summary', exact: true }).click();
	await answerConfirm(page, false, 'numbers that need fixing');
	await expect(storage).toHaveValue('120');
	// Its link puts the cursor back in it.
	await saveBar(page).getByRole('link', { name: /^Min source storage of transfer 1, %/ }).click();
	await expect(storage).toBeFocused();
	// Discard puts the stored value back, and nothing asks any more.
	await saveBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
	await answerConfirm(page, true, 'the number that needs fixing');
	await expect(storage).toHaveValue('20');
	await sections(page).getByRole('link', { name: 'Summary', exact: true }).click();
	await expect(title(page, 'Summary')).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
});
