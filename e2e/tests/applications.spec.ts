// Applications (WP-3.3, docs/ui.md § Applications, docs/scenarios.md
// § Applications): an applicant (the contributor role), linked to the Upper
// farm, opens the project and gets the Applicant view; starts an application
// on the published baseline, sees their own farm in full and the other farm
// only as "Farm 1", raises their dam, runs it, sees their own view of the
// results (their farm, nothing downstream, no catchment flows below five farm
// holders), queues a yield of their own dam and submits it. The assessor (the
// project's owner, marked as acting for the responsible authority) finds it
// in the Applications tab and records the authority's decision; an
// application whose run was changed behind the API (its server stamp no
// longer matches, docs/security.md § Run stamps) shows the assessor a
// warning and can't be decided. Axe on
// both views, light and dark. Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember } from '../support/api.ts';
import { AUTHORITY, seedApplicantProject, submitApplication } from '../support/applications.ts';
import { tamperRunSummary } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { answerConfirm } from '../support/confirm.ts';

const NAME = 'Raise the Upper farm dam';

test('an applicant submits an application on the published baseline, and the assessor decides it', async ({ page, owner, signIn }) => {
	void owner;
	const applicant = await signIn('Applicant');
	const { project } = await seedApplicantProject(page, 'Applications golden path', applicant.user);
	const a = applicant.page;

	// The workspace shows an applicant their own view, not the tabs.
	await a.goto(`/projects/${project.id}`);
	await expect(a.getByTestId('applicant-view')).toHaveText('Applicant view');
	await expect(a.getByRole('navigation', { name: 'Project sections' })).toHaveCount(0);
	// One section header, like every workspace section: the title, and the catchment, the baseline and their farm on its context line.
	const header = a.getByTestId('section-header');
	await expect(a.getByRole('heading', { level: 1 })).toHaveText(['Applications']);
	await expect(header.getByTestId('applicant-project')).toHaveText('Applications golden path');
	await expect(header.getByTestId('applicant-baseline')).toContainText('Baseline published');
	await expect(header.getByRole('link', { name: 'Upper farm' })).toBeVisible();
	await expect(a.getByTestId('scenarios-empty')).toContainText('No applications yet.');

	// A new application starts on the published baseline: New application, the header's action, opens the dialog.
	await header.getByRole('link', { name: 'New application', exact: true }).click();
	const create = a.getByRole('dialog', { name: 'New application' });
	await expect(create.getByLabel('Base run')).toHaveCount(0);
	await create.getByLabel('Name', { exact: true }).fill(NAME);
	await create.getByRole('button', { name: 'Create application' }).click();
	await expect(a.getByRole('heading', { level: 2, name: NAME })).toBeVisible();
	await expect(a.getByTestId('scenario-base')).toContainText('Based on run Baseline');

	// Their own farm with its values; the other farm only as "Farm 1", with none.
	const form = a.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Dam capacity' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: 150\u202f000 m³');
	await expect(form.getByLabel('Node').getByRole('option', { name: 'Farm 1' })).toHaveCount(1);
	await expect(a.getByText('Lower farm')).toHaveCount(0);
	await form.getByLabel('Dam capacity (m³)').fill('200000');
	await form.getByRole('button', { name: 'Add change' }).click();
	const changes = a.getByRole('list', { name: `Changes in ${NAME}` });
	await expect(changes.getByRole('listitem')).toContainText('Proposal');

	// Run it: their own view of the results (the assessors compare it in full), then submit it.
	await expect(a.getByTestId('applicant-results-empty')).toBeVisible();
	await a.getByRole('button', { name: 'Run scenario' }).click();
	const results = a.getByTestId('applicant-results');
	await expect(results.getByTestId('applicant-units').getByRole('rowheader', { name: 'Upper farm' })).toBeVisible();
	// Both farms drain to the gauge: nothing lies below theirs. Two farm holders: no catchment flows.
	await expect(results.getByTestId('applicant-downstream-empty')).toHaveText('No other farm or water user lies downstream of your units.');
	await expect(results.getByTestId('applicant-catchment-withheld')).toContainText('five or more farm holders');
	// The river shows at any holder count (164): natural flow, never the outflow.
	const catchment = results.getByTestId('applicant-catchment');
	await expect(catchment.getByRole('rowheader', { name: 'Natural flow' })).toBeVisible();
	await expect(catchment.getByRole('rowheader', { name: 'Flow at the outlet' })).toHaveCount(0);
	await expect(results.getByTestId('applicant-results-stale')).toHaveCount(0);
	await expect(a.getByText('Lower farm')).toHaveCount(0);
	// The Yield panel offers their own farm only, and they may queue a yield (096_contributor_yield): cancelled before a worker runs it.
	const dam = a.getByLabel('Dam', { exact: true });
	await expect(dam.getByRole('option', { name: 'Farm 1' })).toHaveCount(0);
	await dam.selectOption({ label: 'Upper farm' });
	const yieldPanel = a.getByRole('region', { name: 'Yield of Upper farm' });
	await yieldPanel.getByRole('button', { name: 'Work out the yield' }).click();
	await expect(yieldPanel.getByTestId('yield-status')).toHaveText('Queued: waiting for the background worker.');
	await yieldPanel.getByRole('button', { name: 'Cancel' }).click();
	await expect(yieldPanel.getByTestId('yield-status')).toHaveText('Cancelled.');
	await a.getByRole('button', { name: 'Submit to the assessors' }).click();
	await answerConfirm(a, true, `Submit “${NAME}” to the assessors?`);
	await expect(a.getByTestId('application-panel')).toContainText('Submitted: the assessors can see it');
	await expect(a.getByRole('form', { name: 'Add a change' })).toHaveCount(0);
	await expect(a.getByText('Lower farm')).toHaveCount(0);

	// The assessor's Applications tab lists it; they open and decide it.
	await page.goto(`/projects/${project.id}?tab=applications`);
	const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: NAME }) });
	await expect(row).toContainText('Applicant');
	await expect(row).toContainText('Awaiting a decision');
	await row.getByRole('link', { name: NAME }).click();
	await expect(page).toHaveURL(/tab=scenarios&scenario=/);
	const decide = page.getByRole('form', { name: 'Record the authority’s decision' });
	// Its run is the one the model run stored: no stamp warning (the control for the test below).
	await expect(decide).toBeVisible();
	await expect(page.getByTestId('application-unverified')).toHaveCount(0);
	// The Act's words (163_licensing_authority): the authority decides, the app records its letter.
	const record = decide.getByRole('button', { name: 'Record the authority’s decision' });
	await decide.getByLabel(/Licence issued \(see its conditions\)/).check();
	await expect(record).toBeDisabled();
	await decide.getByLabel('Date of the decision letter').fill('2026-09-30');
	await decide.getByLabel('Licence or file reference').fill('WU-SYN-001');
	await decide.getByRole('group', { name: 'Written reasons received?' }).getByLabel('Yes').check();
	await decide.getByLabel('Note: the authority’s reasons and conditions').fill('Release 5 % of inflow in dry months.');
	await record.click();
	const decision = page.getByTestId('application-decision');
	await expect(decision).toContainText('Licence issued (see its conditions): the decision of Synthetic catchment management agency, dated 30 Sep 2026.');
	await expect(decision).toContainText('Reference WU-SYN-001. Written reasons received.');
	await expect(decision).toContainText('Release 5 % of inflow in dry months.');

	// The applicant sees the decision.
	await a.reload();
	await a.getByRole('button', { name: new RegExp(`^${NAME}`) }).click();
	await expect(a.getByTestId('application-decision')).toContainText('Licence issued (see its conditions)');
});

test('an application whose run was changed behind the API shows the assessor a warning and waits for its decision', async ({ page, owner, signIn }) => {
	void owner;
	const applicant = await signIn('Stamped applicant');
	const { project, runId, upper } = await seedApplicantProject(page, 'Applications unverified', applicant.user);
	const P = `${API_URL}/projects/${project.id}`;
	const req = applicant.context.request;
	const made = await req.post(`${P}/scenarios`, {
		data: { name: NAME, baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 200_000 }] }
	});
	expect(made.status()).toBe(201);
	const sid = (await made.json()).scenario.id as string;
	const ran = await req.post(`${P}/scenarios/${sid}/runs`, { data: {} });
	expect(ran.status()).toBe(201);
	expect((await req.post(`${P}/scenarios/${sid}/submit`, { data: {} })).status()).toBe(200);
	await tamperRunSummary((await ran.json()).run.id);

	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${sid}`);
	await expect(page.getByTestId('application-unverified')).toHaveText(
		'1 run of this application wasn’t stored by the model run itself: the server’s stamp is missing or no longer matches the results, so it can’t be signed off, and the application can’t be decided until it is deleted (Runs tab).'
	);
	const decide = page.getByRole('form', { name: 'Record the authority’s decision' });
	await decide.getByLabel(/Licence issued/).check();
	await decide.getByLabel('Date of the decision letter').fill('2026-09-30');
	await decide.getByRole('group', { name: 'Written reasons received?' }).getByLabel('No').check();
	await expect(decide.getByRole('button', { name: 'Record the authority’s decision' })).toBeDisabled();
});

test('the Applications tab says so when nothing is submitted, and a draft stays with its applicant', async ({ page, owner, signIn }) => {
	void owner;
	const applicant = await signIn('Drafting applicant');
	const { project, runId } = await seedApplicantProject(page, 'Applications empty', applicant.user);
	const res = await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios`, { data: { name: 'A draft', baseRunId: runId } });
	expect(res.status()).toBe(201);
	await page.goto(`/projects/${project.id}?tab=applications`);
	await expect(page.getByTestId('applications-empty')).toHaveText('No applications submitted.');
	await page.goto(`/projects/${project.id}?tab=scenarios`);
	await expect(page.getByRole('button', { name: /^A draft/ })).toHaveCount(0);
});

test('the owner puts an applicant and their consultant in one party, and the applicant shares from that list', async ({ page, owner, signIn }) => {
	void owner;
	const applicant = await signIn('Party applicant');
	const consultant = await signIn('Party consultant');
	const rival = await signIn('Rival applicant');
	const { project, runId } = await seedApplicantProject(page, 'Applications sharing', applicant.user);
	for (const u of [consultant.user, rival.user]) await addMember(page.request, project.id, u.email, 'contributor');
	const created = await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios`, { data: { name: NAME, baseRunId: runId } });
	const sid = ((await created.json()) as { scenario: { id: string } }).scenario.id;
	const a = applicant.page;

	// Before any party: nobody to share with, and no address box to probe.
	await a.goto(`/projects/${project.id}?scenario=${sid}`);
	await expect(a.getByTestId('share-none')).toContainText('Nobody to share it with yet');
	await expect(a.getByRole('textbox', { name: /email/i })).toHaveCount(0);

	// The owner groups the applicant and the consultant in the Members panel.
	await page.goto(`/projects/${project.id}?tab=project`);
	const members = page.getByRole('region', { name: 'Members' });
	for (const u of [applicant.user, consultant.user]) {
		const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/members/${u.id}`));
		const party = members.getByLabel(`Applying party for ${u.displayName}`);
		await party.fill('Upper farm trust');
		await party.press('Enter');
		expect((await saved).status()).toBe(200);
	}

	// The applicant picks the consultant; the rival is never offered.
	await a.reload();
	const who = a.getByLabel('Share with');
	await expect(who.getByRole('option')).toHaveText(['Choose someone…', 'Party consultant']);
	await who.selectOption({ label: 'Party consultant' });
	await a.getByRole('button', { name: 'Share', exact: true }).click();
	await expect(a.getByTestId('application-panel').getByRole('listitem')).toContainText('Party consultant');
	await expect(a.getByTestId('share-none')).toHaveText('Everyone you can share it with already reads it.');

	// The consultant now reads the draft.
	await consultant.page.goto(`/projects/${project.id}?scenario=${sid}`);
	await expect(consultant.page.getByRole('heading', { level: 2, name: NAME })).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the Applicant view and the Applications tab have no violations (${colorScheme})`, async ({ page, owner, signIn }) => {
		void owner;
		const applicant = await signIn(`Applicant a11y ${colorScheme}`);
		await applicant.page.emulateMedia({ colorScheme });
		await page.emulateMedia({ colorScheme });
		const { project, runId, upper } = await seedApplicantProject(page, `Applications a11y ${colorScheme}`, applicant.user);
		const created = await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
			data: { name: NAME, baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 200_000 }] }
		});
		const sid = ((await created.json()) as { scenario: { id: string } }).scenario.id;
		// Run, so their view of the results is on the page axe checks.
		expect((await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios/${sid}/runs`, { data: {} })).status()).toBe(201);
		expect((await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios/${sid}/submit`, { data: {} })).status()).toBe(200);

		await applicant.page.goto(`/projects/${project.id}?scenario=${sid}`);
		await expect(applicant.page.getByTestId('application-panel')).toBeVisible();
		await expect(applicant.page.getByTestId('applicant-units')).toBeVisible();
		await expectNoViolations(applicant.page);

		await page.goto(`/projects/${project.id}?tab=applications`);
		await expect(page.getByRole('rowheader', { name: NAME })).toBeVisible();
		await expectNoViolations(page);
		await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${sid}`);
		await expect(page.getByRole('form', { name: 'Record the authority’s decision' })).toBeVisible();
		await expectNoViolations(page);
	});
}

test('the owner names the responsible authority and marks who acts for it: only they record its decision and endorse the baseline', async ({ page, owner, signIn }) => {
	void owner;
	const applicant = await signIn('Authority applicant');
	const editor = await signIn('Authority editor');
	const { project, runId, upper } = await seedApplicantProject(page, 'Applications authority', applicant.user);
	await addMember(page.request, project.id, editor.user.email, 'editor');
	const sid = await submitApplication(applicant.context.request, project.id, runId, upper, NAME);

	// An editor nobody marked reads the application but gets no decision form (163_licensing_authority).
	const e = editor.page;
	await e.goto(`/projects/${project.id}?tab=scenarios&scenario=${sid}`);
	await expect(e.getByTestId('application-decide-who')).toContainText('Only a member the project’s owner marks as acting for the responsible authority');
	await expect(e.getByRole('form', { name: 'Record the authority’s decision' })).toHaveCount(0);

	// The owner's Project page: the authority as named, and the tick box on the editor's row.
	await page.goto(`/projects/${project.id}?tab=project`);
	await expect(page.getByRole('region', { name: 'Responsible authority' }).getByLabel('Authority name')).toHaveValue(AUTHORITY.name);
	const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/members/${editor.user.id}`));
	await page.getByRole('region', { name: 'Members' }).getByRole('row', { name: new RegExp(editor.user.displayName) }).getByLabel('Acts for the responsible authority').check();
	expect((await saved).status()).toBe(200);

	// Marked, the editor gets the form; and endorses the published baseline, once.
	await e.reload();
	await expect(e.getByRole('form', { name: 'Record the authority’s decision' })).toBeVisible();
	await e.goto(`/projects/${project.id}?tab=runs`);
	const panel = e.getByRole('region', { name: /^Publication/ });
	await expect(panel.getByTestId('publication-endorsement')).toContainText('Not endorsed by the responsible authority.');
	const endorse = panel.getByRole('form', { name: 'Endorse this baseline' });
	await endorse.getByLabel(/^Endorsement note/).fill('Accepted as the baseline for this season.');
	await endorse.getByRole('button', { name: 'Endorse as the responsible authority' }).click();
	await expect(panel.getByTestId('publication-endorsement')).toContainText('Endorsed for the responsible authority');
	await expect(panel.getByTestId('publication-endorsement')).toContainText('by Authority editor');
	await expect(endorse).toHaveCount(0);
});
