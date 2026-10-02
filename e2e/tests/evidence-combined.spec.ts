// The evidence report's row over the other applications (evidence-11,
// finding C26, docs/evidence-pack.md § The other applications together): two
// submitted applications on the nominated baseline that combine (a dam and a
// river pump on one farm), assessed together (a scoped worker tick); the
// report of the dam's run reads that assessment on page 1 and in § 4's
// combined table, each alone, the sum, all together and the interaction.
// evidence-report.spec.ts has the conflicting pair (not assessed, the
// conflict named). Synthetic catchment, invented names.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';

const ready = (page: Page) => expect(page.locator('main[data-report-ready="true"]')).toBeVisible();

async function submitted(page: Page, projectId: string, baseRunId: string, name: string, op: Record<string, unknown>): Promise<string> {
	const res = await page.request.post(`${API_URL}/projects/${projectId}/scenarios`, { data: { name, baseRunId, ops: [op] } });
	expect(res.status(), await res.text()).toBe(201);
	const id = ((await res.json()) as { scenario: { id: string } }).scenario.id;
	expect((await page.request.post(`${API_URL}/projects/${projectId}/scenarios/${id}/submit`, { data: {} })).status()).toBe(200);
	return id;
}

test('the evidence report reads the applications on its baseline together from their assessment', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	const project = await seedRunnableProject(page.request, 'Evidence combined row');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Calibrated baseline for the combined row');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const dam = await submitted(page, project.id, baseline, 'Raise the Upper dam', { op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 200_000 });
	const pump = await submitted(page, project.id, baseline, 'Bigger river pump', { op: 'node.set', nodeId: upper, field: 'divertCapacityM3Day', value: 9000 });

	const assessed = await page.request.post(`${API_URL}/projects/${project.id}/assessments`, { data: { name: 'Dam and pump', scenarioIds: [dam, pump] } });
	expect(assessed.status(), await assessed.text()).toBe(202);
	await runJobsTick({ projects: [project.id], schedule: false });
	const ran = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${dam}/runs`, { data: {} });
	expect(ran.status(), await ran.text()).toBe(201);
	const app = ((await ran.json()) as { run: { id: string } }).run.id;

	await page.goto(`/projects/${project.id}/report?run=${app}&evidence`);
	await ready(page);
	const row = page.getByTestId('evidence-change-table').getByRole('row', { name: /^This and the other applications on this baseline, together/ });
	await expect(row).toContainText('2 applications together: “Raise the Upper dam” (this one), “Bigger river pump”.');
	await expect(row).toContainText('Assessment “Dam and pump”');
	await expect(row).toContainText('no band: one combined run, not an ensemble');

	const combined = page.getByTestId('evidence-combined');
	await expect(combined.getByRole('rowheader', { name: /^“Raise the Upper dam”/ })).toBeVisible();
	await expect(combined.getByRole('rowheader', { name: '“Bigger river pump”' })).toBeVisible();
	for (const total of ['Sum of each alone', 'All together']) await expect(combined.getByRole('rowheader', { name: total, exact: true })).toBeVisible();
	await expect(combined.getByRole('rowheader', { name: /^Interaction/ })).toBeVisible();
	await expect(combined.getByRole('row', { name: /^All together/ }).getByRole('cell').nth(1)).toHaveText(/^([+−]\d+|0) days$/);
	await expect(page.getByTestId('evidence-combined-source')).toContainText('From the cumulative assessment “Dam and pump”');
	await expect(page.getByTestId('evidence-combined-na')).toHaveCount(0);
	await expectNoViolations(page);
});
