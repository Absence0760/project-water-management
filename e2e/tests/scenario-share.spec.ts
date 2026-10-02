// A share link to one application, and public comments on it (WP-3.15,
// issue #71; docs/ui.md § Applications, § Share page): the assessor makes a
// read-only link to a submitted application from its Application panel; an
// NGO opens it signed out on a phone and reads the EWR per site first; they
// sign in from the page (no role in the project: a link participant,
// 166_public_participation), come back to the same application, read that a
// comment is not a written objection, and comment for public participation,
// giving their name and email for the applicant's register; the assessor sees the
// comment in the application's comments. axe on the Share dialog, the shared
// view (signed out and signed in) and the comments drawer. Invented names only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, PASSWORD, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const PHONE = { width: 360, height: 740 };
const NAME = 'Raise the Upper farm dam';
const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
const TABLE = {
	siteNodeId: null,
	source: 'Invented rule table for tests',
	component: 'total',
	unit: 'mcm',
	points: POINTS,
	ewr: Array.from({ length: 12 }, () => POINTS.map((_, i) => 0.05 - i * 0.004)),
	naturalSource: 'run',
	natural: null,
	scale: 1
};
const COMMENT = 'The wetland below the weir needs its winter flows. Please keep them.';
const NOTICE_ADDRESS = 'The Catchment Manager, Private Bag X1, Rooikloof';

/** A published baseline with an EWR rule table, an applicant linked to the Upper farm, and their run and submitted application. */
async function seed(page: Page, applicant: Page, applicantEmail: string, applicantId: string) {
	const project = await seedRunnableProject(page.request, 'Shared application');
	await updateSettings(page.request, project.id, { ewrRules: [TABLE] });
	const runId = await createRun(page.request, project.id, 'Baseline');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	await addMember(page.request, project.id, applicantEmail, 'contributor');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	expect((await page.request.put(`${API_URL}/projects/${project.id}/farmers/${applicantId}`, { data: { nodeIds: [upper] } })).status()).toBe(200);
	const at = `${API_URL}/projects/${project.id}/scenarios`;
	const created = await applicant.request.post(at, { data: { name: NAME, baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 200_000 }] } });
	expect(created.status(), await created.text()).toBe(201);
	const sid = ((await created.json()) as { scenario: { id: string } }).scenario.id;
	const ran = await applicant.request.post(`${at}/${sid}/runs`, { data: {} });
	expect(ran.status(), await ran.text()).toBe(201);
	// Where written objections go, as the notice gives them (166): printed beside the warning on the share page.
	const notice = await applicant.request.patch(`${at}/${sid}`, { data: { objectionAddress: NOTICE_ADDRESS, objectionClosingDate: '2026-12-01' } });
	expect(notice.status(), await notice.text()).toBe(200);
	expect((await applicant.request.post(`${at}/${sid}/submit`, { data: {} })).status()).toBe(200);
	return { projectId: project.id, sid };
}

test('an NGO opens an application’s link, reads the EWR per site, signs in and comments; the assessor sees it', async ({ page, owner, signIn, browser }) => {
	void owner;
	const applicant = await signIn('Share applicant');
	const ngo = await signIn('River Trust officer');
	const { projectId, sid } = await seed(page, applicant.page, applicant.user.email, applicant.user.id);
	// Not a member of the project: they comment through the link alone.

	// The assessor (the project owner) makes a link from the Application panel.
	await page.goto(`/projects/${projectId}?tab=scenarios&scenario=${sid}`);
	await page.getByTestId('scenario-share-open').click();
	const dialog = page.getByRole('dialog', { name: `Share “${NAME}” read-only` });
	await expect(dialog.getByTestId('scenario-share')).toContainText('the river’s ecological reserve at each EWR site');
	await dialog.getByLabel('Who it’s for').fill('River forum');
	await dialog.getByRole('button', { name: 'Make link' }).click();
	const url = await dialog.getByLabel('The new link').inputValue();
	expect(url).toMatch(/\/share#t=[A-Za-z0-9_-]{43}&k=scenario$/);
	await expect(dialog.getByRole('row', { name: /River forum/ })).toContainText('Live');
	await expectNoViolations(page);
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();

	// Signed out, on a phone: the application, the EWR per site first.
	const outside = await browser.newContext({ viewport: PHONE, locale: 'en-ZA', timezoneId: 'UTC' });
	const shared = await outside.newPage();
	await shared.goto(url);
	await expect(shared.getByRole('heading', { level: 1 })).toHaveText(NAME);
	await expect(shared).toHaveURL(/\/share$/);
	const ewr = shared.getByRole('region', { name: 'The river’s ecological reserve' });
	await expect(ewr.getByText('At the catchment outlet')).toBeVisible();
	await expect(ewr.getByText('With this application', { exact: true })).toBeVisible();
	await expect(ewr.getByRole('definition').first()).toContainText(/^Met in \d+ of \d+\smonths/);
	await expect(shared.getByTestId('share-scenario-status')).toContainText('awaiting a decision');
	// The other farm is never named; the applicant's own is.
	await expect(shared.getByText('Lower farm')).toHaveCount(0);
	await expect(shared.getByRole('region', { name: 'What the application changes' })).toContainText('Upper farm');
	await expectNoSidewaysScroll(shared);
	await expectNoViolations(shared);

	// They sign in from the page, and come back to the same application.
	await shared.getByTestId('share-sign-in').click();
	await expect(shared).toHaveURL(/\/login/);
	await shared.getByLabel('Email').fill(ngo.user.email);
	await shared.getByLabel('Password').fill(PASSWORD);
	await shared.getByRole('button', { name: 'Sign in' }).click();
	await expect(shared).toHaveURL(/\/share$/);
	await expect(shared.getByRole('heading', { level: 1 })).toHaveText(NAME);
	const comments = shared.getByRole('region', { name: 'Public comments' });
	await expect(comments.getByTestId('share-objection')).toContainText('A comment here is not a written objection.');
	await expect(comments.getByTestId('share-objection')).toContainText(NOTICE_ADDRESS);
	await expect(comments.getByTestId('share-objection')).toContainText('1 Dec 2026');
	await comments.getByLabel('Add a comment').fill(COMMENT);
	await comments.getByTestId('share-register-consent').check();
	await comments.getByRole('button', { name: 'Post comment' }).click();
	await expect(comments.getByRole('listitem').filter({ hasText: COMMENT })).toContainText('River Trust officer');
	await expectNoViolations(shared);
	await outside.close();

	// The assessor sees the comment on the application, marked public.
	await page.reload();
	await page.getByRole('button', { name: `Notes on “${NAME}” (1)` }).click();
	const drawer = page.getByRole('dialog', { name: `Comments on “${NAME}”` });
	const note = drawer.getByRole('listitem').filter({ hasText: COMMENT });
	await expect(note).toContainText('River Trust officer');
	await expect(note.getByTestId('note-audience-badge')).toHaveText('Public');
	await expect(drawer.getByTestId('note-audience')).toHaveValue('assessors');
	await expectNoViolations(page);

	// The applicant's public participation record (GN R267 reg 19): the comment, and the email the commenter agreed to give.
	await applicant.page.goto(`/projects/${projectId}/scenarios/${sid}/participation`);
	const record = applicant.page.getByTestId('participation-record');
	await expect(record.getByTestId('participation-comment').filter({ hasText: COMMENT })).toContainText(ngo.user.email);
	await expect(record.getByRole('region', { name: /Register of interested and affected parties/ })).toContainText(ngo.user.email);
	await expectNoViolations(applicant.page);
});
