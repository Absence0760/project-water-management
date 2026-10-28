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

// The mock model's trigger words (backend/src/assistant/providers/mock.ts: "recommend" / "improve the fit"):
// it proposes GR4J X4 at 2 days (MOCK_PROPOSAL).
const RECOMMEND = 'Which settings would you recommend to improve the fit at the outlet?';

test('Apply puts a recommended change in the settings form, Save stores it, and History keeps the reason', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant recommend farm');
	await createRun(page.request, project.id, 'Baseline');
	const settingsNow = async () => ((await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { project: { settings: { gr4j?: { x4?: number } } } }).project.settings;
	const before = await settingsNow();
	expect(before).toBeDefined();
	expect(before.gr4j?.x4).not.toBe(2);

	await page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(page);
	const answer = await ask(sheet, RECOMMEND);
	const card = answer.getByTestId('assistant-proposal');
	await expect(card).toBeVisible();
	await expect(card.getByRole('heading', { name: 'Recommended change' })).toBeVisible();
	// The mock's one change, as the engine's input diff words it, with its reason.
	await expect(card.getByTestId('assistant-diff-line')).toHaveCount(1);
	await expect(card.getByTestId('assistant-diff-line').getByRole('rowheader')).toHaveText('GR4J unit hydrograph time base X4');
	await expect(card.getByTestId('assistant-diff-line').getByRole('cell').last()).toHaveText('2 days');
	await expect(card).toContainText('lengthen the GR4J unit hydrograph (X4 to 2 days)');
	await expect(card).toContainText('A longer unit hydrograph spreads each storm over more days, which the observed flow suggests.');
	await expect(answer.getByTestId('assistant-text')).toHaveText(
		'I have proposed one change: GR4J X4 (unit hydrograph time base) to 2 days. Review it below; nothing changes until you save it.'
	);
	await expect(answer.locator('[data-testid="assistant-tool"][data-tool="propose_settings"]').first()).toHaveAttribute('data-status', 'done');

	await card.getByRole('button', { name: 'Apply to the settings form' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('heading', { level: 1, name: 'Model settings' })).toBeVisible();
	await expect(settingsBar(page)).toBeVisible();
	const reason = settingsBar(page).getByRole('textbox', { name: 'Reason for this change (optional)' });
	await expect(reason).toHaveValue('Assistant suggestion: lengthen the GR4J unit hydrograph (X4 to 2 days)');
	const why = await reason.inputValue();
	// The assistant saved nothing: the project's settings are as they were until Save.
	expect(await settingsNow()).toEqual(before);

	await saveSettings(page);
	const after = await settingsNow();
	expect(after.gr4j?.x4).toBe(2);
	expect({ ...after, gr4j: before.gr4j }).toEqual(before);
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
