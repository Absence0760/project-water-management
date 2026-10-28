// The assistant's past chats, kept only in this browser (issue #610, docs/ui.md
// § Assistant → Past chats): a chat asked on a project is in Past chats after
// a reload; reopened, its recommended change is read-only (ask again for a
// fresh one), and asking continues the same chat. Signing out deletes them:
// another person signing in on the same browser sees none, with the control
// that the first person saw theirs before signing out. Against the e2e API's
// scripted mock model. Invented data only.
import { request as apiRequest } from '@playwright/test';
import { addMember, createRun, PASSWORD, register, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { ask, openAssistant } from '../support/assistant.ts';
import { expect, test } from '../support/fixtures.ts';

// The mock model's trigger words (backend/src/assistant/providers/mock.ts): a recalibration it proposes.
const RECOMMEND = 'Which settings would you recommend to improve the fit at the outlet?';
const FOLLOW_UP = 'Why does the simulated flow at gauge Outflow gauge not respond to rainfall?';

test('a chat is kept in this browser: after a reload it is in Past chats, reopens read-only and continues', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant history farm');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	let sheet = await openAssistant(page);
	// A new project: Past chats is there, empty, and says where chats are kept.
	await expect(sheet.getByTestId('assistant-kept-note')).toHaveText('Chats are kept only in this browser, and deleted when you sign out.');
	const toggle = sheet.getByTestId('assistant-past-toggle');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(sheet.getByRole('heading', { name: 'Past chats on this project' })).toBeFocused();
	await expect(sheet.getByTestId('assistant-past-empty')).toBeVisible();
	await toggle.click();

	const first = await ask(sheet, RECOMMEND);
	await expect(first.getByRole('button', { name: 'Apply to the settings form' })).toBeVisible();
	await expect(toggle).toHaveText(/Past chats\s*1/);

	await page.reload();
	sheet = await openAssistant(page);
	await expect(sheet.getByTestId('assistant-answer')).toHaveCount(0);
	await sheet.getByTestId('assistant-past-toggle').click();
	const rows = sheet.getByTestId('assistant-past-chat');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText(RECOMMEND);
	await expect(rows.first()).toContainText(/\d{2}:\d{2}/);
	await expectNoViolations(page);

	await rows.first().click();
	// Each question reads "You: …" to a screen reader (a visually hidden prefix), hence contain, with the count.
	await expect(sheet.getByTestId('assistant-question')).toHaveCount(1);
	await expect(sheet.getByTestId('assistant-question')).toContainText([RECOMMEND]);
	await expect(sheet.getByRole('textbox', { name: 'Your question' })).toBeFocused();
	await expect(sheet.getByRole('status')).toHaveText(`Opened the past chat “${RECOMMEND}”.`);
	// The reopened change is shown as it was, but can't be applied: the project may have changed since.
	const old = sheet.getByTestId('assistant-proposal').first();
	await expect(old.getByTestId('assistant-proposal-title')).toHaveText('Recalibration: GR4J unit hydrograph time base X4');
	await expect(old.getByTestId('assistant-proposal-stale')).toContainText('From a past chat, so it can’t be applied');
	await expect(old.getByRole('button')).toHaveCount(0);

	// Continuing: the next answer comes on the same chat, and Past chats still lists one.
	const next = await ask(sheet, FOLLOW_UP);
	await expect(sheet.getByTestId('assistant-question')).toHaveCount(2);
	await expect(sheet.getByTestId('assistant-question')).toContainText([RECOMMEND, FOLLOW_UP]);
	await expect(next.getByTestId('assistant-text')).toContainText('Outflow gauge');
	await expect(sheet.getByTestId('assistant-past-toggle')).toHaveText(/Past chats\s*1/);

	// Asking again gets a fresh change, which applies.
	const fresh = await ask(sheet, RECOMMEND);
	await expect(fresh.getByRole('button', { name: 'Apply to the settings form' })).toBeVisible();

	// Delete it: the list is empty, and the open conversation goes with it.
	await sheet.getByTestId('assistant-past-toggle').click();
	await sheet.getByRole('button', { name: `Delete the chat “${RECOMMEND}”` }).click();
	await page.getByRole('alertdialog').getByTestId('confirm-ok').click();
	await expect(sheet.getByTestId('assistant-past-empty')).toBeVisible();
	await expect(sheet.getByRole('heading', { name: 'Past chats on this project' })).toBeFocused();
	await sheet.getByTestId('assistant-past-toggle').click();
	await expect(sheet.getByTestId('assistant-answer')).toHaveCount(0);
});

test('signing out deletes the past chats: the next person on this browser sees none (control: the first saw theirs)', async ({ page, owner }) => {
	const project = await seedRunnableProject(page.request, 'Assistant shared browser farm');
	await createRun(page.request, project.id, 'Baseline');
	// A second person, registered in a context of their own so this page stays the owner's.
	const other = await apiRequest.newContext();
	const second = await register(other, 'Second Person');
	await other.dispose();
	await addMember(page.request, project.id, second.email, 'editor');

	await page.goto(`/projects/${project.id}`);
	let sheet = await openAssistant(page);
	await ask(sheet, RECOMMEND);
	await page.reload();
	sheet = await openAssistant(page);
	await sheet.getByTestId('assistant-past-toggle').click();
	await expect(sheet.getByTestId('assistant-past-chat')).toHaveCount(1);
	await sheet.getByRole('button', { name: 'Close dialog' }).click();

	await page.getByRole('button', { name: `Account menu for ${owner.displayName}` }).click();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL('/login');
	// Nothing of the chat is left in this browser's storage.
	await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain('wm-assistant-history');

	await page.getByLabel('Email').fill(second.email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await page.goto(`/projects/${project.id}`);
	sheet = await openAssistant(page);
	await sheet.getByTestId('assistant-past-toggle').click();
	await expect(sheet.getByTestId('assistant-past-empty')).toBeVisible();
	await expect(sheet.getByTestId('assistant-past-chat')).toHaveCount(0);
});
