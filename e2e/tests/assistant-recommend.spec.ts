// A recommended change from the assistant (issues #610, #640, docs/ui.md §
// Assistant → Apply). A recalibration: the mock model proposes a fixed patch;
// the sheet shows a title built from the change, its engine diff line and why;
// Apply puts it in the settings form, unsaved, on Model settings with the save
// reason filled in; the normal Save stores it and History keeps the reason.
// Nothing is saved before Save. A viewer sees the same change and no Apply.
// An outcome (the EWR): the mock first tries a calibrated parameter, which the
// server refuses, then management levers; the card names exactly those, and
// Try it as a scenario makes a scenario on the run and opens it. Invented data
// only.
import { acceptInvites, addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { ask, openAssistant } from '../support/assistant.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { historyEntries, openHistory } from '../support/history.ts';
import { saveSettings, settingsBar } from '../support/settings.ts';

// The mock model's trigger words (backend/src/assistant/providers/mock.ts: "recommend" / "improve the fit"):
// it proposes GR4J X4 at 2 days as a recalibration (MOCK_PROPOSAL).
const RECOMMEND = 'Which settings would you recommend to improve the fit at the outlet?';
// "ewr": the incident's question (issue #640); the mock answers with management levers (mockEwrProposal).
const EWR = 'Which unit has the worst EWR performance in dry years, and what would you change to improve it?';
const X4_TITLE = 'Recalibration: GR4J unit hydrograph time base X4';

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
	// The title is the server's, from the one change it accepted; the change as the engine's input diff words it, with its reason.
	await expect(card.getByTestId('assistant-proposal-title')).toHaveText(X4_TITLE);
	await expect(card.getByTestId('assistant-diff-line')).toHaveCount(1);
	await expect(card.getByTestId('assistant-diff-line')).toHaveText(/^GR4J unit hydrograph time base X4: .* → 2 days$/);
	await expect(card.getByTestId('assistant-change')).toContainText('A longer unit hydrograph spreads each storm over more days, which the observed flow suggests.');
	await expect(answer.getByTestId('assistant-text')).toHaveText(
		'I have proposed one change: GR4J X4 (unit hydrograph time base) to 2 days. Review it below; nothing changes until you save it.'
	);
	await expect(answer.locator('[data-testid="assistant-tool"][data-tool="propose_settings"]').first()).toHaveAttribute('data-status', 'done');

	await card.getByRole('button', { name: 'Apply to the settings form' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('heading', { level: 1, name: 'Model settings' })).toBeVisible();
	await expect(settingsBar(page)).toBeVisible();
	const reason = settingsBar(page).getByRole('textbox', { name: 'Reason for this change (optional)' });
	await expect(reason).toHaveValue(`Assistant suggestion: ${X4_TITLE}`);
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

test('an EWR question gets management levers only, and Try it as a scenario makes a scenario on the run (issue #640)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant EWR farm');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const projectNow = async () => (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { project: { settings: unknown } };
	const settingsBefore = (await projectNow()).project.settings;

	await page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(page);
	const answer = await ask(sheet, EWR);
	// The calibrated-parameter attempt was refused, the management one accepted.
	const proposeLines = answer.locator('[data-testid="assistant-tool"][data-tool="propose_settings"]');
	await expect(proposeLines).toHaveCount(2);
	await expect(proposeLines.first()).toHaveAttribute('data-status', 'error');
	await expect(proposeLines.last()).toHaveAttribute('data-status', 'done');

	const card = answer.getByTestId('assistant-proposal');
	await expect(card).toHaveCount(1);
	await expect(card).toHaveAttribute('data-goal', 'outcome');
	const title = 'Management change: Upper farm: own runoff to dam; transfer Upper farm → Lower farm: minimum dam storage to transfer';
	await expect(card.getByTestId('assistant-proposal-title')).toHaveText(title);
	await expect(card.getByTestId('assistant-change')).toHaveCount(2);
	await expect(card.getByTestId('assistant-diff-line').first()).toHaveText('Upper farm: own runoff to dam 50% → 25%');
	await expect(card).not.toContainText('X1');
	await expect(answer.getByTestId('assistant-text')).toHaveText(
		`I have proposed a management change to try as a scenario: ${title}. GR4J X1 is calibrated to the observed flow, so I have not changed it to improve the EWR.`
	);

	await card.getByRole('button', { name: 'Try it as a scenario' }).click();
	await expect(sheet).toBeHidden();
	await expect(page).toHaveURL(/[?&]tab=scenarios&scenario=[0-9a-f-]{36}/);
	const sid = new URL(page.url()).searchParams.get('scenario');
	const res = await page.request.get(`${API_URL}/projects/${project.id}/scenarios/${sid}`);
	expect(res.status()).toBe(200);
	const scenario = (await res.json()) as { scenario: { name: string; baseRunId: string; ops: { op: string; field: string; value: unknown }[] }; check: { problems: string[] } };
	expect(scenario.scenario.name).toBe(`Assistant: ${title}`);
	expect(scenario.scenario.baseRunId).toBe(runId);
	expect(scenario.scenario.ops.map((o) => [o.op, o.field, o.value])).toEqual([
		['node.set', 'pctRunoffToDam', 0.25],
		['transfer.set', 'minStoragePct', 0.5]
	]);
	expect(scenario.check.problems).toEqual([]);
	// The scenario opens on Scenarios, and the project's own settings are unchanged.
	await expect(page.getByText(`Assistant: ${title}`).first()).toBeVisible();
	expect((await projectNow()).project.settings).toEqual(settingsBefore);
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
