// Applications (WP-3.3; the assessors' ?tab=applications, issue #17 option A):
// a published project with an applicant, locators, and a big synthetic queue.
// Invented names only.
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { addMember, createRun, seedRunnableProject, type TestUser } from './api.ts';
import { backdateApplication } from './db.ts';
import { API_URL } from './env.ts';

export const applicationsCard = (page: Page) => page.getByRole('region', { name: 'Submitted applications' });

export async function openApplications(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=applications${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();
}

/** A published run, and an applicant (a contributor) linked to the Upper farm. */
export async function seedApplicantProject(page: Page, name: string, applicant: TestUser) {
	const project = await seedRunnableProject(page.request, name);
	const runId = await createRun(page.request, project.id, 'Baseline');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	await addMember(page.request, project.id, applicant.email, 'contributor');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	expect((await page.request.put(`${API_URL}/projects/${project.id}/farmers/${applicant.id}`, { data: { nodeIds: [upper] } })).status()).toBe(200);
	return { project, runId, upper };
}

/** Creates and submits one application as `applicant` (their request context); its id. */
export async function submitApplication(applicant: APIRequestContext, projectId: string, runId: string, upper: string, name: string, dam = 200_000): Promise<string> {
	const created = await applicant.post(`${API_URL}/projects/${projectId}/scenarios`, {
		data: { name, baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: dam }] }
	});
	expect(created.status(), await created.text()).toBe(201);
	const sid = ((await created.json()) as { scenario: { id: string } }).scenario.id;
	expect((await applicant.post(`${API_URL}/projects/${projectId}/scenarios/${sid}/submit`, { data: {} })).status()).toBe(200);
	return sid;
}

const LONG = [
	'Raise the Upper farm dam wall by two metres for winter storage',
	'New off-channel storage dam on the Upper farm',
	'Extend the macadamia block onto the old lands',
	'Pipeline from the river weir to the Upper farm dam',
	'Convert flood irrigation to drip on the citrus'
];

/**
 * `n` applications from one applicant, submitted `i + 1` days apart (the first the oldest): every fourth is
 * decided by `assessor` (approved, with conditions or refused in turn), every seventh withdrawn, the rest
 * awaiting a decision. Their ids, oldest first.
 */
export async function seedManyApplications(
	assessor: APIRequestContext,
	applicant: APIRequestContext,
	projectId: string,
	runId: string,
	upper: string,
	n = 30
): Promise<{ id: string; name: string; status: 'submitted' | 'decided' | 'withdrawn'; days: number }[]> {
	const out: { id: string; name: string; status: 'submitted' | 'decided' | 'withdrawn'; days: number }[] = [];
	const outcomes = ['approved', 'approved_with_conditions', 'refused'] as const;
	for (let i = 0; i < n; i++) {
		const name = `${LONG[i % LONG.length]} (${i + 1})`;
		const id = await submitApplication(applicant, projectId, runId, upper, name, 160_000 + i * 1000);
		let status: 'submitted' | 'decided' | 'withdrawn' = 'submitted';
		if (i % 4 === 3) {
			const res = await assessor.post(`${API_URL}/projects/${projectId}/scenarios/${id}/decide`, { data: { outcome: outcomes[(i >> 2) % 3], note: 'Synthetic decision.' } });
			expect(res.status(), await res.text()).toBe(200);
			status = 'decided';
		} else if (i % 7 === 6) {
			expect((await applicant.post(`${API_URL}/projects/${projectId}/scenarios/${id}/withdraw`, { data: {} })).status()).toBe(200);
			status = 'withdrawn';
		}
		const days = n - i;
		await backdateApplication(id, days);
		out.push({ id, name, status, days });
	}
	return out;
}
