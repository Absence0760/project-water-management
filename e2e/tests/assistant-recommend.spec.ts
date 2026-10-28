// A recommended settings change from the assistant (issue #610, docs/ui.md §
// Assistant → Apply): the mock model proposes a fixed patch; the sheet shows
// the engine's diff lines and why; Apply puts it in the settings form, unsaved,
// on Model settings with the save reason filled in; the normal Save stores it
// and History keeps the reason. Nothing is saved before Save. A viewer sees the
// same diff and no Apply. Invented data only.
import { acceptInvites, addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { ask, openAssistant } from '../support/assistant.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { historyEntries, openHistory } from '../support/history.ts';
import { saveSettings, settingsBar } from '../support/settings.ts';

// TODO(#610 merge): the mock's trigger words (backend/src/assistant/providers/mock.ts: "recommend" / "improve the fit").
const RECOMMEND = 'Which settings would you recommend to improve the fit at the outlet?';

test('Apply puts a recommended change in the settings form, Save stores it, and History keeps the reason', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant recommend farm');
	await createRun(page.request, project.id, 'Baseline');
	const settingsNow = async () => ((await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { settings: unknown }).settings;
	const before = await settingsNow();

	await page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(page);
	const answer = await ask(sheet, RECOMMEND);
	const card = answer.getByTestId('assistant-proposal');
	await expect(card).toBeVisible();
	await expect(card.getByRole('heading', { name: 'Recommended change' })).toBeVisible();
	// TODO(#610 merge): pin the mock's fixed patch's diff lines and reason.
	await expect(card.getByTestId('assistant-diff-line').first()).toBeVisible();
	await expect(answer.locator('[data-testid="assistant-tool"][data-tool="propose_settings"]').first()).toHaveAttribute('data-status', 'done');

	await card.getByRole('button', { name: 'Apply to the settings form' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('heading', { level: 1, name: 'Model settings' })).toBeVisible();
	await expect(settingsBar(page)).toBeVisible();
	const reason = settingsBar(page).getByRole('textbox', { name: 'Reason for this change (optional)' });
	await expect(reason).toHaveValue(/^Assistant suggestion: \S/);
	const why = await reason.inputValue();
	// The assistant saved nothing: the project's settings are as they were until Save.
	expect(await settingsNow()).toEqual(before);

	await saveSettings(page);
	expect(await settingsNow()).not.toEqual(before);
	await openHistory(page, project.id);
	await expect(historyEntries(page).first()).toContainText(why);
});

test('a viewer sees the recommended change but no Apply', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant viewer farm');
	await createRun(page.request, project.id, 'Baseline');
	const viewer = await signIn('Assistant viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await acceptInvites(viewer.user.email, project.id);

	await viewer.page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(viewer.page);
	const answer = await ask(sheet, RECOMMEND);
	const card = answer.getByTestId('assistant-proposal');
	await expect(card.getByTestId('assistant-diff-line').first()).toBeVisible();
	await expect(card.getByRole('button', { name: 'Apply to the settings form' })).toHaveCount(0);
	await expect(card).toContainText('An editor can apply this change.');
});
