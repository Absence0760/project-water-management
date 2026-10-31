// Cumulative impact (roadmap WP-3.11, docs/ui.md § Applications › Assess
// together): three submitted applications on one published baseline. The
// assessor opens "Assess together" from the Applications tab (`view=assess`,
// so Back returns to the list), checks a pair that changes the same dam and
// is shown the conflict with both changes side by side, then assesses a pair
// that combines: the job runs (a scoped worker tick) and the matrix shows the
// baseline, each application alone, all together and the interaction, with
// a CSV. Axe in light and dark. Then, with registered volumes on the
// baseline, the assessor also assesses a pair against existing authorised use
// (295): a full-allocation run of the same baseline picked as the background,
// shown as its own labelled table under the baseline's matrix, which stays as
// it was. Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { createRun } from '../support/api.ts';
import { openApplications, seedApplicantProject, submitApplication } from '../support/applications.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the assessor assesses applications together; a conflicting pair is refused with both changes named (${colorScheme})`, async ({ page, owner, signIn }) => {
		void owner;
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1440, height: 960 });
		const applicant = await signIn(`Cumulative applicant ${colorScheme}`);
		const { project, runId, upper } = await seedApplicantProject(page, `Assess together ${colorScheme}`, applicant.user);
		const req = applicant.context.request;
		await submitApplication(req, project.id, runId, upper, 'Raise the Upper dam', 200_000);
		await submitApplication(req, project.id, runId, upper, 'Lower the Upper dam', 120_000);
		// A second change to the same farm, of another field: it combines with the first.
		const pump = await req.post(`${API_URL}/projects/${project.id}/scenarios`, {
			data: { name: 'Bigger river pump', baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'divertCapacityM3Day', value: 9000 }] }
		});
		expect(pump.status(), await pump.text()).toBe(201);
		expect((await req.post(`${API_URL}/projects/${project.id}/scenarios/${(await pump.json()).scenario.id}/submit`, { data: {} })).status()).toBe(200);

		await openApplications(page, project.id);
		await page.getByTestId('section-header').getByRole('link', { name: 'Assess together', exact: true }).click();
		await expect(page).toHaveURL(/view=assess/);
		const panel = page.getByRole('region', { name: 'Assess together' });
		await expect(panel.getByText('No assessments yet.')).toBeVisible();

		// The two dam changes conflict: refused, both changes named, nothing run.
		const apps = panel.getByRole('group', { name: 'Applications' });
		await apps.getByRole('checkbox', { name: /^Raise the Upper dam/ }).check();
		await apps.getByRole('checkbox', { name: /^Lower the Upper dam/ }).check();
		await panel.getByRole('button', { name: 'Check they combine' }).click();
		const conflict = panel.getByTestId('assess-conflict');
		await expect(conflict).toHaveCount(1);
		await expect(conflict).toContainText('hydrological unit "Upper farm": damCapacityM3');
		await expect(conflict).toContainText('both change it');
		await expect(conflict).toContainText('Raise the Upper dam change 1: Upper farm');
		await expect(conflict).toContainText('Lower the Upper dam change 1: Upper farm');
		await panel.getByLabel('Name').fill('Both dam changes');
		await panel.getByRole('button', { name: 'Assess together' }).click();
		await expect(panel.getByTestId('assess-check')).toContainText('One conflict');
		await expect(panel.getByText('No assessments yet.')).toBeVisible();

		// A pair that combines.
		await apps.getByRole('checkbox', { name: /^Lower the Upper dam/ }).uncheck();
		await apps.getByRole('checkbox', { name: /^Bigger river pump/ }).check();
		await panel.getByRole('button', { name: 'Check they combine' }).click();
		await expect(panel.getByTestId('assess-check')).toHaveText('These applications combine: none changes what another changes or uses.');
		await panel.getByLabel('Name').fill('Dam and pump');
		await panel.getByRole('button', { name: 'Assess together' }).click();
		const result = panel.getByTestId('assess-result');
		await expect(result).toHaveAttribute('data-state', 'pending');
		await runJobsTick({ projects: [project.id], schedule: false });
		await expect(result).toHaveAttribute('data-state', 'complete');
		const matrix = result.getByRole('table');
		await expect(matrix.getByRole('columnheader')).toHaveText(['Measure', 'Site', 'Baseline', 'Raise the Upper dam alone', 'Bigger river pump alone', 'All together', 'Interaction']);
		await expect(matrix.getByRole('rowheader', { name: 'Days the EWR is not met' }).first()).toBeVisible();
		await expect(matrix.getByRole('rowheader', { name: 'Mean flow at the outlet' })).toBeVisible();
		await expect(panel.getByLabel('Assessment')).toContainText('Dam and pump');
		const download = page.waitForEvent('download');
		await result.getByRole('button', { name: 'Download CSV' }).click();
		expect((await download).suggestedFilename()).toBe('Dam and pump - cumulative impact.csv');
		await expectNoViolations(page);

		// Back returns to the list.
		await page.goBack();
		await expect(page).not.toHaveURL(/view=assess/);
		await expect(page.getByRole('region', { name: 'Submitted applications' })).toBeVisible();
	});
}

test('the assessor also assesses against existing authorised use: the full-allocation table sits beside the baseline’s matrix, never in its place', async ({ page, owner, signIn }) => {
	void owner;
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const applicant = await signIn('Background applicant');
	const { project, upper } = await seedApplicantProject(page, 'Assess against authorised use', applicant.user);
	const nodes = project.model.nodes as { id: string; name: string }[];
	// Registered volumes on both farms, then a baseline that carries them (compare only: they don't drive it).
	for (const [n, v] of [
		['Upper farm', 400_000],
		['Lower farm', 300_000]
	] as const) {
		const nodeId = nodes.find((x) => x.name === n)!.id;
		const res = await page.request.post(`${API_URL}/projects/${project.id}/allocations`, { data: { nodeId, holder: `Holder ${n}`, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: v } });
		expect(res.status(), await res.text()).toBe(201);
	}
	const runId = await createRun(page.request, project.id, 'Baseline with volumes');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	const req = applicant.context.request;
	await submitApplication(req, project.id, runId, upper, 'Raise the Upper dam', 200_000);
	const pump = await req.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: { name: 'Bigger river pump', baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'divertCapacityM3Day', value: 9000 }] }
	});
	expect(pump.status(), await pump.text()).toBe(201);
	expect((await req.post(`${API_URL}/projects/${project.id}/scenarios/${(await pump.json()).scenario.id}/submit`, { data: {} })).status()).toBe(200);
	// The assessor's own run of that baseline at full allocation.
	const full = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: { name: 'At full allocation', baseRunId: runId, ops: [{ op: 'settings.set', path: 'allocationMode', value: 'fullAllocation' }] }
	});
	expect(full.status(), await full.text()).toBe(201);
	const ran = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${(await full.json()).scenario.id}/runs`, { data: {} });
	expect(ran.status(), await ran.text()).toBe(201);

	await openApplications(page, project.id);
	await page.getByTestId('section-header').getByRole('link', { name: 'Assess together', exact: true }).click();
	const panel = page.getByRole('region', { name: 'Assess together' });
	const apps = panel.getByRole('group', { name: 'Applications' });
	await apps.getByRole('checkbox', { name: /^Raise the Upper dam/ }).check();
	await apps.getByRole('checkbox', { name: /^Bigger river pump/ }).check();
	const background = panel.getByLabel('Also against existing authorised use (optional)');
	await expect(background.getByRole('option')).toHaveCount(2);
	await expect(background.getByRole('option').nth(1)).toContainText('At full allocation');
	await background.selectOption({ index: 1 });
	await panel.getByLabel('Name').fill('Against authorised use');
	await panel.getByRole('button', { name: 'Assess together' }).click();
	const result = panel.getByTestId('assess-result');
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(result).toHaveAttribute('data-state', 'complete');
	// The baseline's matrix as without a background.
	const tables = result.getByRole('table');
	await expect(tables).toHaveCount(2);
	await expect(tables.first().getByRole('columnheader')).toHaveText(['Measure', 'Site', 'Baseline', 'Raise the Upper dam alone', 'Bigger river pump alone', 'All together', 'Interaction']);
	// The background: its own labelled table, the baseline beside it.
	const bg = result.getByRole('region', { name: 'Existing authorised use (full allocation)' });
	await expect(bg).toContainText('the table above stays the hydrologist’s baseline');
	await expect(bg.getByRole('columnheader')).toHaveText(['Measure', 'Site', 'Baseline', 'At full allocation', 'Raise the Upper dam alone', 'Bigger river pump alone', 'All together', 'Interaction']);
	await expect(bg.getByRole('rowheader', { name: 'Mean flow at the outlet' })).toBeVisible();
	await expectNoViolations(page);
});
