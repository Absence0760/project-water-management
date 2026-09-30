// The owner's inventory of every public link (docs/ui.md § Project, Share
// links; docs/followups.md § Applicants): the Project page's Share links list
// shows the baseline links the owner made and the links an applicant made to
// their application from its Share dialog, each with what it opens and who
// made it. The owner withdraws the applicant's link from there, behind a
// confirm: that link is dead for whoever holds it, the baseline link still
// opens. axe and no sideways scroll at desktop and on a phone. Invented names.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const PHONE = { width: 360, height: 740 };
const NAME = 'Raise the Upper farm dam';

/** A published baseline, and an applicant's submitted application on the Upper farm. */
async function seed(page: Page, applicant: Page, applicantEmail: string, applicantId: string) {
	const project = await seedRunnableProject(page.request, 'Inventory catchment');
	const runId = await createRun(page.request, project.id, 'Baseline');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	await addMember(page.request, project.id, applicantEmail, 'contributor');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	expect((await page.request.put(`${API_URL}/projects/${project.id}/farmers/${applicantId}`, { data: { nodeIds: [upper] } })).status()).toBe(200);
	const at = `${API_URL}/projects/${project.id}/scenarios`;
	const created = await applicant.request.post(at, { data: { name: NAME, baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 200_000 }] } });
	expect(created.status(), await created.text()).toBe(201);
	const sid = ((await created.json()) as { scenario: { id: string } }).scenario.id;
	expect((await applicant.request.post(`${at}/${sid}/runs`, { data: {} })).status()).toBe(201);
	expect((await applicant.request.post(`${at}/${sid}/submit`, { data: {} })).status()).toBe(200);
	return { projectId: project.id, sid };
}

async function makeLink(page: Page, projectId: string, label: string, target?: string): Promise<string> {
	const res = await page.request.post(`${API_URL}/projects/${projectId}/share-links`, {
		data: { label, expiresInDays: 30, ...(target ? { targetKind: 'scenario', targetId: target } : {}) }
	});
	expect(res.status(), await res.text()).toBe(201);
	return ((await res.json()) as { link: { url: string } }).link.url;
}

test('the owner sees every public link with its target, and withdraws an applicant’s link from the Project page', async ({ page, owner, signIn, browser }) => {
	void owner;
	const applicant = await signIn('Inventory applicant');
	const { projectId, sid } = await seed(page, applicant.page, applicant.user.email, applicant.user.id);
	const baselineUrl = await makeLink(page, projectId, 'Catchment forum');
	const appUrl = await makeLink(applicant.page, projectId, 'River Trust', sid);

	await page.goto(`/projects/${projectId}?tab=project`);
	const panel = page.getByRole('region', { name: 'Share links' });
	await expect(panel.getByTestId('share-inventory-note')).toContainText('every public link in this project');
	const baseline = panel.getByRole('row', { name: /Catchment forum/ });
	const app = panel.getByRole('row', { name: /River Trust/ });
	await expect(baseline.getByRole('rowheader')).toContainText('The published baseline');
	await expect(baseline).toContainText('Live');
	await expect(app.getByRole('rowheader')).toContainText(`Application “${NAME}”`);
	await expect(app).toContainText('Live');
	await expect(app).toContainText('by Inventory applicant');
	await expectNoViolations(page);
	await expectNoSidewaysScroll(page);

	// Cancel keeps it; Withdraw kills it.
	await app.getByRole('button', { name: 'Withdraw River Trust' }).click();
	await answerConfirm(page, false, `Withdraw the link “River Trust” (application “${NAME}”)?`);
	await expect(app).toContainText('Live');
	await app.getByRole('button', { name: 'Withdraw River Trust' }).click();
	await answerConfirm(page, true);
	await expect(app).toContainText('Withdrawn');
	await expect(app).toContainText(/Withdrawn \d{4}-\d{2}-\d{2} by Owner/);
	await expect(app.getByRole('button', { name: /^Withdraw/ })).toHaveCount(0);
	// The baseline link is untouched.
	await expect(baseline.getByRole('button', { name: 'Withdraw Catchment forum' })).toBeVisible();

	// Signed out: the withdrawn link is dead, the baseline link still opens.
	const outside = await browser.newContext({ viewport: PHONE, locale: 'en-ZA', timezoneId: 'UTC' });
	const shared = await outside.newPage();
	await shared.goto(appUrl);
	await expect(shared.getByRole('alert')).toHaveText('This link has expired or was withdrawn. Ask whoever sent it for a new one.');
	await shared.goto(baselineUrl);
	await expect(shared.getByRole('heading', { level: 1 })).toHaveText('Inventory catchment');
	await outside.close();

	// The list on a phone.
	await page.setViewportSize(PHONE);
	await expect(app.getByRole('rowheader')).toContainText(`Application “${NAME}”`);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
});
