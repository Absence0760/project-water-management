// "Ask the assessors why" (164_applicant_visibility; docs/ui.md
// § Applications, docs/scenarios.md § Applications): an applicant's change
// breaks a rule that depends on a farm they can't see (the catchment has no
// land left once their farm's goes, because the other farm has none), which
// they read only as "doesn't apply to the catchment as modelled", with a note
// that this is the app's check, not a refusal under s42 (issue #523 G7). They ask
// the assessors why; the assessor (the project's owner) reads the rule in
// its own words on the Applications tab and answers; the applicant reads the
// answer. Axe on both panels, light and dark. Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { putModel } from '../support/api.ts';
import { openApplications, seedApplicantProject } from '../support/applications.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const NAME = 'Upper farm gives up its land';

for (const colorScheme of ['light', 'dark'] as const) {
	test(`an applicant asks the assessors why a hidden rule refuses their change, and reads the answer (${colorScheme})`, async ({ page, owner, signIn }) => {
		void owner;
		await page.emulateMedia({ colorScheme });
		const applicant = await signIn(`Asker ${colorScheme}`);
		await applicant.page.emulateMedia({ colorScheme });
		const { project, upper } = await seedApplicantProject(page, `Ask the assessors ${colorScheme}`, applicant.user);
		// Lower farm (hidden from the applicant) has no land, so the Upper farm holds the catchment's. A new baseline run, published.
		// (A flow-share rule was the hidden one until engine 1.105.0 retired the specific shares, issue #616.)
		const model = project.model as unknown as { nodes: { id: string; name: string; areaKm2: number }[] };
		for (const n of model.nodes) if (n.name === 'Lower farm') n.areaKm2 = 0;
		await putModel(page.request, project.id, project.model);
		const run = await page.request.post(`${API_URL}/projects/${project.id}/runs`, { data: { label: 'Land on the Upper farm only' } });
		expect(run.status(), await run.text()).toBe(201);
		const runId = ((await run.json()) as { run: { id: string } }).run.id;
		expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
		const created = await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
			data: { name: NAME, baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'areaKm2', value: 0 }] }
		});
		expect(created.status(), await created.text()).toBe(201);
		const sid = ((await created.json()) as { scenario: { id: string } }).scenario.id;

		// The applicant: the rule in the masked words, and the question sent.
		const a = applicant.page;
		await a.goto(`/projects/${project.id}?scenario=${sid}`);
		const ask = a.getByRole('region', { name: 'Rules you can’t see' });
		await expect(ask).toContainText("doesn't apply to the catchment as modelled");
		await expect(ask).toContainText('change 1: catchment area');
		// Issue #523 G7: an app check, not a refusal under s42; DWS is still open to them.
		await expect(ask.getByTestId('ask-in-app-check')).toContainText('It is not a refusal of a water use licence under section 42 of the National Water Act');
		await expect(ask.getByTestId('ask-in-app-check')).toContainText('(e-WULAAS)');
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
		await expect(queue).toContainText('the catchment has no area left');
		await expectNoViolations(page);
		await queue.getByLabel('Your answer').fill('The other units have no land of their own; keep some of yours in the model.');
		await queue.getByRole('button', { name: 'Send the answer' }).click();
		await expect(queue).toContainText('All answered');
		await expect(queue.getByLabel('Your answer')).toHaveCount(0);

		// The applicant reads the answer, and may ask again.
		await a.reload();
		await expect(ask).toContainText('keep some of yours in the model');
		await expect(ask.getByRole('button', { name: 'Ask again' })).toBeVisible();
	});
}
