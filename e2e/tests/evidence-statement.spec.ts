// Appendix C's fixed prompts (issue #71 follow-up; docs/ui.md § Scenarios,
// "Applicant's statement", and § Evidence report; 129_scenario_statement):
// the modeller answers purpose and need and monitoring on the scenario, leaves
// mitigation blank, and the evidence report's Appendix C prints each answer
// verbatim under its prompt and "Not given." for the blank one, with the
// description after them. Synthetic catchment.
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

test('the prompts answered on the scenario print in Appendix C, a blank one as “Not given”', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evidence statement');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Baseline for the statement test');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const made = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: {
			name: 'Upper farm dam',
			description: 'A 300 000 m³ dam on Upper farm.',
			baseRunId: baseline,
			ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 300_000 }],
			ownedNodeIds: [upper]
		}
	});
	expect(made.status()).toBe(201);
	const scenarioId = ((await made.json()) as { scenario: { id: string } }).scenario.id;
	const ran = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	expect(ran.status()).toBe(201);
	const runId = ((await ran.json()) as { run: { id: string } }).run.id;

	// On the scenario: nothing answered yet, each prompt "Not given".
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	const statement = page.getByTestId('scenario-statement');
	await expect(statement.getByRole('heading', { name: 'Applicant’s statement' })).toBeVisible();
	await expect(statement.getByTestId('statement-count')).toHaveText('0 of 3 answered');
	for (const id of ['purposeAndNeed', 'mitigation', 'monitoring']) await expect(statement.getByTestId(`statement-${id}`)).toContainText('Not given');

	// Answer two of the three; each box is described by its question.
	await statement.getByRole('button', { name: 'Answer the prompts' }).click();
	const purpose = statement.getByRole('textbox', { name: 'Purpose and need' });
	await expect(purpose).toHaveAccessibleDescription(/^What is the change for, and why is this water needed/);
	await purpose.fill('Winter storage for 60 ha of citrus.\nThe river runs too low in summer to pump from.');
	await statement.getByRole('textbox', { name: 'Monitoring' }).fill('  A V-notch weir below the dam, read weekly by the farm manager.  ');
	await expectNoViolations(page);
	await statement.getByRole('button', { name: 'Save statement' }).click();
	await expect(statement.getByTestId('statement-count')).toHaveText('2 of 3 answered');
	await expect(statement.getByTestId('statement-purposeAndNeed')).toContainText('The river runs too low in summer to pump from.');
	await expect(statement.getByTestId('statement-mitigation')).toContainText('Not given');
	// Stored trimmed.
	await expect(statement.getByTestId('statement-monitoring').locator('dd')).toHaveText('A V-notch weir below the dam, read weekly by the farm manager.');
	await expectNoViolations(page);

	// The evidence report's Appendix C: every prompt, in order, answered or "Not given.", then the description.
	await page.goto(`/projects/${project.id}/report?run=${runId}&evidence`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	const appendix = page.locator('#ev-applicantStatement');
	await expect(appendix.getByRole('heading', { level: 2, name: 'Appendix C. Applicant’s statement' })).toBeVisible();
	const prompts = appendix.getByTestId('evidence-prompts');
	await expect(prompts.getByRole('heading', { level: 3 })).toHaveText(['Purpose and need', 'Mitigation', 'Monitoring']);
	await expect(prompts.getByTestId('evidence-prompt-purposeAndNeed').locator('.verbatim')).toHaveText(
		'Winter storage for 60 ha of citrus.\nThe river runs too low in summer to pump from.'
	);
	await expect(prompts.getByTestId('evidence-prompt-mitigation')).toContainText('Not given.');
	await expect(prompts.getByTestId('evidence-prompt-monitoring').locator('.verbatim')).toHaveText('A V-notch weir below the dam, read weekly by the farm manager.');
	await expect(appendix).toContainText('A 300 000 m³ dam on Upper farm.');
	// The applicant's words stay out of page 1 (G13).
	await expect(page.locator('#ev-summary')).not.toContainText('Winter storage');
	await expectNoViolations(page);
});
