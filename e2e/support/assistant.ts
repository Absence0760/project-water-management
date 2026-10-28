// The project's assistant (issue #610, docs/ui.md § Assistant): the Assistant
// button on the section header's title line and its side sheet, for assistant.spec.ts and
// assistant-recommend.spec.ts. The e2e API runs it with the scripted mock
// model (ASSISTANT_PROVIDER=mock, playwright.config.ts).
import { expect, type Locator, type Page } from '@playwright/test';
import { sectionHeader } from './sectionHeader.ts';

export const assistantSheet = (page: Page) => page.getByRole('dialog', { name: 'Assistant' });

/** The Assistant button: after How this page works on the title's line, at every width (never in More actions). */
export const assistantButton = (page: Page) => sectionHeader(page).getByTestId('header-assist').getByRole('button', { name: 'Assistant', exact: true });

/** Opens the sheet from the header's Assistant button. */
export async function openAssistant(page: Page): Promise<Locator> {
	await assistantButton(page).click();
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
