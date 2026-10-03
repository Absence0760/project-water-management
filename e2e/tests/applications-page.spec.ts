// The assessors' Applications page (?tab=applications, WP-3.3; issue #17 option A): the section header says how
// many applications there are, how many await a decision and for how long, and links the one waiting longest;
// the card filters by status (`status=` in the URL, Back steps through the filters) and sorts; from 1100 × 620
// it fills the window and the rows scroll inside it; on a phone each application is a card. The applicant's
// flow, the decision and sharing are in applications.spec.ts. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember } from '../support/api.ts';
import { applicationsCard, openApplications, seedApplicantProject, seedManyApplications, submitApplication } from '../support/applications.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const header = (page: Page) => page.getByTestId('section-header');
const rows = (page: Page) => applicationsCard(page).locator('tbody tr');
const filter = (page: Page, name: RegExp) => applicationsCard(page).getByRole('group', { name: 'Show applications' }).getByRole('link', { name });

test('thirty applications: the header counts the queue, the card fills the window and the rows scroll inside it', async ({ page, owner, signIn }) => {
	void owner;
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const applicant = await signIn('Queue applicant');
	const { project, runId, upper } = await seedApplicantProject(page, 'Applications page big', applicant.user);
	const seeded = await seedManyApplications(page.request, applicant.context.request, project.id, runId, upper, 30);
	const oldest = seeded[0]!;
	expect(oldest.status).toBe('submitted');
	await openApplications(page, project.id);

	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(header(page).getByTestId('section-context')).toHaveText('30 applications · 20 awaiting a decision, the longest for 30 days');
	const next = header(page).getByRole('link', { name: 'Decide the longest waiting', exact: true });
	await expect(next).toHaveAttribute('href', `?tab=scenarios&scenario=${oldest.id}`);
	await expect(rows(page)).toHaveCount(30);

	// Newest first; every status in words.
	const first = rows(page).first();
	await expect(first.getByRole('rowheader')).toHaveText(seeded[29]!.name);
	await expect(first).toContainText('Awaiting a decision');
	await expect(first).toContainText('waiting 1 day');
	const decided = rows(page).filter({ has: page.getByRole('rowheader', { name: seeded[27]!.name, exact: true }) });
	await expect(decided).toContainText('decided');
	await expect(decided.locator('.pill')).toHaveText(/^(Licence issued \(see its conditions\)|Licence refused|Application rejected \(formal requirements\))$/);
	await expect(rows(page).filter({ has: page.getByRole('rowheader', { name: seeded[20]!.name, exact: true }) }).locator('.pill')).toHaveText('Withdrawn');

	// The card reaches the window's bottom; the page doesn't scroll, the rows do, inside the card.
	const card = (await applicationsCard(page).boundingBox())!;
	expect(card.y + card.height).toBeLessThanOrEqual(960);
	expect(card.y + card.height).toBeGreaterThan(960 - 40);
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(960);
	const wrap = applicationsCard(page).locator('.table-wrap');
	expect(await wrap.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	await expectNoSidewaysScroll(page);

	// Sort by status: the queue first, the one waiting longest on top.
	await applicationsCard(page).getByLabel('Sort by').selectOption('status');
	await expect(rows(page).first().getByRole('rowheader')).toHaveText(oldest.name);
	await expect(rows(page).first()).toContainText('waiting 30 days');

	// Decide the longest waiting opens it in Scenarios, with the form recording the authority's decision.
	await next.click();
	await expect(page).toHaveURL(new RegExp(`tab=scenarios&scenario=${oldest.id}`));
	await expect(page.getByRole('form', { name: 'Record the authority’s decision' })).toBeVisible();
});

test('the status filter is in the URL: Back steps through it, a reload keeps it, and an empty one says so', async ({ page, owner, signIn }) => {
	void owner;
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 800 });
	const applicant = await signIn('Filter applicant');
	const { project, runId, upper } = await seedApplicantProject(page, 'Applications page filter', applicant.user);
	await seedManyApplications(page.request, applicant.context.request, project.id, runId, upper, 12);
	// 12: decided 3, 7, 11; withdrawn 6; the other 8 awaiting.
	await openApplications(page, project.id);
	await expect(filter(page, /^All 12$/)).toHaveAttribute('aria-current', 'true');

	await filter(page, /^Awaiting a decision 8$/).click();
	await expect(page).toHaveURL(/status=awaiting/);
	await expect(rows(page)).toHaveCount(8);
	await expect(rows(page).locator('.pill')).toHaveText(Array(8).fill('Awaiting a decision'));
	await expect(filter(page, /^Awaiting a decision/)).toHaveAttribute('aria-current', 'true');
	await filter(page, /^Decided 3$/).click();
	await expect(page).toHaveURL(/status=decided/);
	await expect(rows(page)).toHaveCount(3);

	await page.goBack();
	await expect(page).toHaveURL(/status=awaiting/);
	await expect(rows(page)).toHaveCount(8);
	await page.goBack();
	await expect(page).not.toHaveURL(/status=/);
	await expect(rows(page)).toHaveCount(12);
	await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();

	await openApplications(page, project.id, '&status=withdrawn');
	await expect(rows(page)).toHaveCount(1);
	await expect(header(page).getByTestId('section-context')).toHaveText('12 applications · 8 awaiting a decision, the longest for 12 days');
	await expect(applicationsCard(page).getByLabel('Sort by')).toBeVisible();

	// An unknown status shows them all.
	await openApplications(page, project.id, '&status=nonsense');
	await expect(rows(page)).toHaveCount(12);
	await expect(filter(page, /^All 12$/)).toHaveAttribute('aria-current', 'true');
});

test('nothing submitted: the header says so, with no Decide link; a filter with nothing in it offers all', async ({ page, owner, signIn }) => {
	void owner;
	const applicant = await signIn('Quiet applicant');
	const { project, runId, upper } = await seedApplicantProject(page, 'Applications page quiet', applicant.user);
	await openApplications(page, project.id);
	await expect(page.getByTestId('applications-empty')).toHaveText('No applications submitted.');
	await expect(header(page).getByTestId('section-context')).toHaveText('No applications submitted yet');
	// What an application is, for an assessor who has never met one: the card says so and its ⓘ opens the glossary entry.
	await expect(applicationsCard(page).getByTestId('applications-intro')).toContainText('Water-use licence applications');
	await applicationsCard(page).getByRole('button', { name: /Licence application/ }).click();
	await expect(page.getByText(/licence applicant’s proposed change/)).toBeVisible();
	await expect(header(page).getByRole('link', { name: 'Decide the longest waiting' })).toHaveCount(0);
	await expect(applicationsCard(page).getByRole('group', { name: 'Show applications' })).toHaveCount(0);
	// Where applications come from: applicants on the Project page, the baseline published in Runs & results.
	await expect(applicationsCard(page).getByRole('link', { name: 'Project page', exact: true })).toHaveAttribute('href', '?tab=project');
	await expect(applicationsCard(page).getByRole('link', { name: 'Runs & results', exact: true })).toHaveAttribute('href', '?tab=runs');
	await expectNoViolations(page);

	await submitApplication(applicant.context.request, project.id, runId, upper, 'The only one');
	await openApplications(page, project.id, '&status=withdrawn');
	await expect(page.getByTestId('applications-none')).toContainText('No application has been withdrawn.');
	await page.getByTestId('applications-none').getByRole('link', { name: 'Show all' }).click();
	await expect(rows(page)).toHaveCount(1);
	await expect(header(page).getByTestId('section-context')).toHaveText('1 application · 1 awaiting a decision, the longest for less than a day');
});

test('a viewer has no Applications section', async ({ page, owner, signIn }) => {
	void owner;
	const applicant = await signIn('Viewer-case applicant');
	const viewer = await signIn('Applications viewer');
	const { project } = await seedApplicantProject(page, 'Applications page viewer', applicant.user);
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.setViewportSize({ width: 1440, height: 960 });
	await viewer.page.goto(`/projects/${project.id}`);
	await expect(viewer.page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Project', exact: true })).toBeVisible();
	await expect(viewer.page.getByRole('link', { name: 'Applications', exact: true })).toHaveCount(0);

	// An old or shared Applications link lands on the Summary, not the tab's error.
	await viewer.page.goto(`/projects/${project.id}?tab=applications`);
	await expect(viewer.page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await expect(viewer.page.getByRole('alert')).toHaveCount(0);
});

test('on a phone each application is a card, with no sideways scroll', async ({ page, owner, signIn }) => {
	void owner;
	test.setTimeout(90_000);
	const applicant = await signIn('Phone applicant');
	const { project, runId, upper } = await seedApplicantProject(page, 'Applications page phone', applicant.user);
	await seedManyApplications(page.request, applicant.context.request, project.id, runId, upper, 8);
	await page.setViewportSize({ width: 390, height: 844 });
	await openApplications(page, project.id);
	await expect(rows(page)).toHaveCount(8);
	await expect(applicationsCard(page).locator('thead')).toBeHidden();
	await expect(rows(page).first()).toContainText('1 change');
	await expect(rows(page).first()).toContainText('0 runs');
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the Applications page with every status has no violations at 1440 × 960 (${colorScheme})`, async ({ page, owner, signIn }) => {
		void owner;
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1440, height: 960 });
		const applicant = await signIn(`Applications a11y ${colorScheme}`);
		const { project, runId, upper } = await seedApplicantProject(page, `Applications page a11y ${colorScheme}`, applicant.user);
		await seedManyApplications(page.request, applicant.context.request, project.id, runId, upper, 12);
		await openApplications(page, project.id);
		await expect(rows(page)).toHaveCount(12);
		await expectNoViolations(page);
		await filter(page, /^Decided/).click();
		await expect(rows(page)).toHaveCount(3);
		await expectNoViolations(page);
	});
}
