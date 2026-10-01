// "Ask the assessors why" (164_applicant_visibility; docs/ui.md
// § Applications, docs/scenarios.md § Applications): an applicant's change
// breaks a rule that depends on a farm they can't see (the catchment's flow
// shares, set by hand, pass 100 % only with the other farm's share), which
// they read only as "doesn't apply to the catchment as modelled". They ask
// the assessors why; the assessor (the project's owner) reads the rule in
// its own words on the Applications tab and answers; the applicant reads the
// answer. Axe on both panels, light and dark. Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { putModel, updateSettings } from '../support/api.ts';
import { openApplications, seedApplicantProject } from '../support/applications.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const NAME = 'Upper farm takes a bigger share';

for (const colorScheme of ['light', 'dark'] as const) {
	test(`an applicant asks the assessors why a hidden rule refuses their change, and reads the answer (${colorScheme})`, async ({ page, owner, signIn }) => {
		void owner;
		await page.emulateMedia({ colorScheme });
		const applicant = await signIn(`Asker ${colorScheme}`);
		await applicant.page.emulateMedia({ colorScheme });
		const { project, upper } = await seedApplicantProject(page, `Ask the assessors ${colorScheme}`, applicant.user);
		// Flow shares by hand: Upper 5 %, Lower (hidden from the applicant) 90 %. A new baseline run, published.
		const model = project.model as { nodes: { id: string; name: string; flowShareManual?: number | null }[] };
		for (const n of model.nodes) n.flowShareManual = n.name === 'Upper farm' ? 0.05 : n.name === 'Lower farm' ? 0.9 : null;
		await putModel(page.request, project.id, project.model);
		await updateSettings(page.request, project.id, { flowShareMethod: 'manual' });
		const run = await page.request.post(`${API_URL}/projects/${project.id}/runs`, { data: { label: 'Shares by hand' } });
		expect(run.status(), await run.text()).toBe(201);
		const runId = ((await run.json()) as { run: { id: string } }).run.id;
		expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
		const created = await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
			data: { name: NAME, baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'flowShareManual', value: 0.3 }] }
		});
		expect(created.status(), await created.text()).toBe(201);
		const sid = ((await created.json()) as { scenario: { id: string } }).scenario.id;

		// The applicant: the rule in the masked words, and the question sent.
		const a = applicant.page;
		await a.goto(`/projects/${project.id}?scenario=${sid}`);
		const ask = a.getByRole('region', { name: 'Rules you can’t see' });
		await expect(ask).toContainText("doesn't apply to the catchment as modelled");
		await expect(ask).toContainText('change 1: flow shares');
		await expect(a.getByText('Lower farm')).toHaveCount(0);
		await ask.getByRole('button', { name: 'Ask the assessors why' }).click();
		await expect(ask.getByTestId('asked')).toContainText('waiting for the assessors’ answer');
		await expect(ask.getByRole('button', { name: 'Ask the assessors why' })).toHaveCount(0);
		await expectNoViolations(a);

		// The assessor: the question with the rule in its own words, on the Applications tab (the draft stays the applicant's).
		await openApplications(page, project.id);
		const queue = page.getByRole('region', { name: 'Applicants’ questions' });
		await expect(queue).toContainText(`“${NAME}”`);
		await expect(queue).toContainText('1 waiting for an answer');
		await expect(queue).toContainText('In its own words:');
		await expect(queue).toContainText('flow shares');
		await expectNoViolations(page);
		await queue.getByLabel('Your answer').fill('The other units hold 90 % of the flow between them; keep your share at 10 % or less.');
		await queue.getByRole('button', { name: 'Send the answer' }).click();
		await expect(queue).toContainText('All answered');
		await expect(queue.getByLabel('Your answer')).toHaveCount(0);

		// The applicant reads the answer, and may ask again.
		await a.reload();
		await expect(ask).toContainText('keep your share at 10 % or less');
		await expect(ask.getByRole('button', { name: 'Ask again' })).toBeVisible();
	});
}
