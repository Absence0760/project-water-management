// The project's assistant (issue #610, docs/ui.md § Assistant), against the
// e2e API's scripted mock model (ASSISTANT_PROVIDER=mock). The gauge question
// from the issue: the answer streams in with a line for each tool it read the
// project with (the network, the series, the gauge's fit) and names the gauge;
// the disclaimer and the budget sit under the box; the sheet passes axe. With
// the assistant off (the second e2e API, which leaves it at its default) the
// header has no Assistant button. Invented data only.
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { ask, assistantSheet, openAssistant } from '../support/assistant.ts';
import { expect, test } from '../support/fixtures.ts';
import { viaMfaApi } from '../support/mfaApi.ts';
import { sectionHeader } from '../support/sectionHeader.ts';

test('answers why the simulated flow at a gauge doesn’t respond to rainfall, from the project’s own data', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant gauge farm');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(page);
	await expect(sheet.getByTestId('assistant-disclaimer')).not.toBeEmpty();
	await expect(sheet.getByTestId('assistant-budget')).toContainText('of this month’s budget left');

	const answer = await ask(sheet, 'Why does the simulated flow at gauge Outflow gauge not respond to rainfall?');
	await expect(sheet.getByTestId('assistant-question')).toHaveText(/Outflow gauge not respond to rainfall/);
	// A line for each tool the mock reads the project with, each finished.
	// TODO(#610 merge): pin the labels once backend/src/assistant/tools/*.ts set them.
	for (const tool of ['get_network', 'get_series', 'get_gauge_fit']) {
		await expect(answer.locator(`[data-testid="assistant-tool"][data-tool="${tool}"]`).first()).toHaveAttribute('data-status', 'done');
	}
	// TODO(#610 merge): the mock's exact answer (backend/src/assistant/providers/mock.ts); for now it names the gauge.
	await expect(answer.getByTestId('assistant-text')).toContainText('Outflow gauge');
	await expect(sheet.getByRole('status')).toHaveText('The assistant answered.');
	await expectNoViolations(page);

	// Closing keeps the conversation (it lives in the page); New conversation starts over.
	await sheet.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(sheet).toBeHidden();
	await openAssistant(page);
	await expect(sheet.getByTestId('assistant-answer')).toHaveCount(1);
	await sheet.getByRole('button', { name: 'New conversation' }).click();
	await expect(sheet.getByTestId('assistant-answer')).toHaveCount(0);
});

test('with the assistant off the header has no Assistant button (control: on, it has)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant off farm');
	await page.goto(`/projects/${project.id}`);
	await expect(sectionHeader(page).getByRole('button', { name: 'Assistant', exact: true })).toBeVisible();

	// The second e2e API leaves ASSISTANT_PROVIDER at its default, off: GET …/assistant answers { available: false }.
	await viaMfaApi(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await expect(sectionHeader(page).getByTestId('assistant-open')).toHaveCount(0);
	await expect(assistantSheet(page)).toHaveCount(0);
});
