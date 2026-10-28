// The project's assistant (issue #610, docs/ui.md § Assistant), against the
// e2e API's scripted mock model (ASSISTANT_PROVIDER=mock). The gauge question
// from the issue: the answer streams in with a line for each tool it read the
// project with (the network, the series, the gauge's fit) and names the gauge;
// the disclaimer and the budget sit under the box; the sheet passes axe. With
// the assistant off (the second e2e API, which leaves it at its default) the
// header has no Assistant button. The button sits in one place on every
// section, after How this page works on the title's line, at every width.
// Invented data only.
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { ask, assistantButton, assistantSheet, openAssistant } from '../support/assistant.ts';
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
	// A line for each tool the mock reads the project with, in order, each finished
	// (backend/src/assistant/providers/mock.ts: the network, the runoff of the dam above
	// the gauge, the gauge's outflow, its fit).
	const tools = answer.getByTestId('assistant-tool');
	await expect(tools).toHaveText([/^Reading the network/, /^Reading a series/, /^Reading a series/, /^Checking a gauge's fit/]);
	for (const [i, tool] of ['get_network', 'get_series', 'get_series', 'get_gauge_fit'].entries()) {
		await expect(tools.nth(i)).toHaveAttribute('data-tool', tool);
		await expect(tools.nth(i)).toHaveAttribute('data-status', 'done');
	}
	// The mock's answer, its four lines from what the tools read: the seed's two dams drain
	// straight into Outflow gauge (get_network lists Lower farm first), the series' means and
	// the outlet's calibration statistics (the run's, numbers that depend on the engine).
	const N = '-?\\d+\\.\\d{2}';
	await expect(answer.getByTestId('assistant-text')).toHaveText(
		new RegExp(
			[
				'^Gauge Outflow gauge has 2 dam\\(s\\) upstream: Lower farm, Upper farm\\.',
				`Runoff at Lower farm averages ${N} and the gauge’s outflow ${N} in the series read\\.`,
				`The fit at the gauge: NSE ${N}, KGE ${N}, PBIAS ${N}\\.`,
				'The dams upstream fill before they spill, so rain above them reaches the gauge only once they are full: check their capacity and starting level before changing GR4J\\.$'
			].join('\\s*')
		)
	);
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
	await expect(assistantButton(page)).toBeVisible();

	// The second e2e API leaves ASSISTANT_PROVIDER at its default, off: GET …/assistant answers { available: false }.
	await viaMfaApi(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await expect(sectionHeader(page).getByTestId('assistant-open')).toHaveCount(0);
	await expect(assistantSheet(page)).toHaveCount(0);
});

test('the Assistant button is in one place on every section: after the guide on the title’s line, never in More actions', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant place farm');
	await createRun(page.request, project.id, 'Baseline');
	for (const size of [
		{ width: 1440, height: 900 },
		{ width: 360, height: 740 }
	]) {
		await page.setViewportSize(size);
		for (const tab of ['overview', 'network', 'settings', 'runs']) {
			await page.goto(`/projects/${project.id}?tab=${tab}`);
			const at = `${tab} at ${size.width}`;
			const h = sectionHeader(page);
			const button = assistantButton(page);
			await expect(button, at).toBeVisible();
			// Not one of the tab's actions (on a phone those fold into More actions).
			await expect(h.getByTestId('header-own').getByTestId('assistant-open'), at).toHaveCount(0);
			const guide = (await h.getByTestId('section-guide').boundingBox())!;
			const box = (await button.boundingBox())!;
			// Right after the guide, centred on its line.
			expect(box.x, at).toBeGreaterThan(guide.x + guide.width);
			expect(Math.abs(box.y + box.height / 2 - (guide.y + guide.height / 2)), at).toBeLessThan(4);
			// Its word on a wide screen; on a phone the icon alone, a 36 px circle, still named Assistant.
			if (size.width === 1440) await expect(button, at).toHaveText('Assistant');
			else expect(box.height, at).toBeGreaterThanOrEqual(36);
		}
	}
	await expectNoViolations(page);
});
