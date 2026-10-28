// The project's assistant (issue #610, docs/ui.md § Assistant): the section
// header's Assistant button and its side sheet, for assistant.spec.ts and
// assistant-recommend.spec.ts. The e2e API runs it with the scripted mock
// model (ASSISTANT_PROVIDER=mock, playwright.config.ts).
import { expect, type Locator, type Page } from '@playwright/test';
import { headerControl } from './sectionHeader.ts';

export const assistantSheet = (page: Page) => page.getByRole('dialog', { name: 'Assistant' });

/** Opens the sheet from the header (on a phone, through More actions). */
export async function openAssistant(page: Page): Promise<Locator> {
	await (await headerControl(page, 'button', 'Assistant')).click();
	const sheet = assistantSheet(page);
	await expect(sheet).toBeVisible();
	return sheet;
}

/** Asks `question` and waits for the answer to finish (its `done`); returns the answer. */
export async function ask(sheet: Locator, question: string): Promise<Locator> {
	const before = await sheet.getByTestId('assistant-answer').count();
	await sheet.getByRole('textbox', { name: 'Your question' }).fill(question);
	await sheet.getByRole('button', { name: 'Send' }).click();
	const answer = sheet.getByTestId('assistant-answer').nth(before);
	await expect(answer).toHaveAttribute('data-done', 'true');
	return answer;
}
