// The pages around the workspace that issue #17 didn't redesign (docs/ui.md §
// Report, § Compare runs): the printable report, the emailed report link's
// page (/projects/:id/reports/:jobId) and the standalone /compare page. In
// the app frame on screen, never on paper; no sideways scroll on a phone; the
// report link's page says which catchment and run the PDF is of and where it
// stands; a11y at desktop and phone. Names and numbers are invented.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { seedWhatIfs } from '../support/compare.ts';
import { failReport, holdReportJob } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { seedSupplyProject } from '../support/supply.ts';

const DESKTOP = { width: 1440, height: 960 };
const PHONE = { width: 390, height: 844 };
const reportReady = (page: Page) => expect(page.locator('main[data-report-ready="true"]')).toBeVisible();

/** A queued report PDF of `runId`, held so no worker tick renders it. */
async function queueReport(page: Page, projectId: string, runId: string): Promise<string> {
	const res = await page.request.post(`${API_URL}/projects/${projectId}/reports`, { data: { runId } });
	expect(res.status()).toBe(202);
	const { jobId } = (await res.json()) as { jobId: string };
	await holdReportJob(jobId);
	return jobId;
}

test.describe('the printable report', () => {
	for (const [label, viewport] of [
		['desktop', DESKTOP],
		['phone', PHONE]
	] as const) {
		test(`prints without the app frame (${label})`, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize(viewport);
			const project = await seedRunnableProject(page.request, `Report frame ${label}`);
			const runId = await createRun(page.request, project.id, 'Baseline');
			await page.goto(`/projects/${project.id}/report?run=${runId}`);
			await reportReady(page);
			// On screen: the frame (the sidebar from 900 px, the phone bar below).
			const frame = page.locator(label === 'desktop' ? '.app-sidebar' : '.phone-bar');
			await expect(frame).toBeVisible();
			// On paper (the browser's print and the server PDF, which prints this page): the report only.
			await page.emulateMedia({ media: 'print' });
			await expect(frame).toBeHidden();
			await expect(page.getByRole('heading', { level: 1, name: `Report frame ${label}` })).toBeVisible();
			const left = await page.locator('main.report').evaluate((el) => el.getBoundingClientRect().left);
			expect(left).toBeLessThan(40);
		});
	}

	test('a 30-unit catchment on a phone: no sideways scroll, and the hydrological unit names have room on screen', async ({ page, owner }) => {
		void owner;
		test.slow();
		const project = await seedSupplyProject(page.request, 'Report thirty units', 28, 365 * 2);
		const runId = await createRun(page.request, project.id, 'Baseline');
		await page.setViewportSize(DESKTOP);
		await page.goto(`/projects/${project.id}/report?run=${runId}`);
		await reportReady(page);
		// The curtailment table's unit column: each name and verdict in a readable column, not a word a line.
		const unit = page.locator('#rep-curtailment tbody th[scope="row"]').first();
		expect((await unit.boundingBox())!.width).toBeGreaterThanOrEqual(150);
		await page.setViewportSize(PHONE);
		await expectNoSidewaysScroll(page);
	});

	test('passes axe on a phone', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize(PHONE);
		const project = await seedRunnableProject(page.request, 'Report phone a11y');
		const runId = await createRun(page.request, project.id, 'Baseline');
		await page.goto(`/projects/${project.id}/report?run=${runId}`);
		await reportReady(page);
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
	});
});

test.describe('the emailed report link', () => {
	test('a queued PDF: which catchment and run, its state in words, and the way to the report and the run', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize(DESKTOP);
		const project = await seedRunnableProject(page.request, 'Report link catchment');
		const runId = await createRun(page.request, project.id, 'Dry-year baseline');
		const jobId = await queueReport(page, project.id, runId);
		await page.goto(`/projects/${project.id}/reports/${jobId}`);
		await expect(page.getByRole('heading', { level: 1, name: 'Catchment report PDF' })).toBeVisible();
		await expect(page.getByTestId('report-job-context')).toHaveText('Report link catchment · Run “Dry-year baseline”');
		const card = page.locator('section.job');
		await expect(card).toHaveAttribute('data-state', 'queued');
		await expect(card.locator('.pill')).toHaveText('Queued');
		await expect(page.getByRole('status')).toHaveText('PDF queued: waiting for the background worker…');
		await expect(card).toContainText('This page checks again every few seconds.');
		await expect(page.getByRole('link', { name: 'Download the PDF' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Open the report in the app' })).toHaveAttribute('href', `/projects/${project.id}/report?run=${runId}`);
		await expect(page.getByRole('link', { name: 'Go to the run' })).toHaveAttribute('href', `/projects/${project.id}?tab=runs&run=${runId}`);
		// One title, and the page fits the window.
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
		expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);

		await page.getByRole('link', { name: 'Go to the run' }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=runs&run=${runId}$`));
		await page.goBack();
		await expect(page.getByTestId('report-job-context')).toBeVisible();
	});

	test('a failed PDF says why and points back to the report; a viewer sees the same page', async ({ page, owner, signIn }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Report link failed');
		const runId = await createRun(page.request, project.id, 'Baseline');
		const jobId = await queueReport(page, project.id, runId);
		await failReport(jobId, 'the renderer did not answer');
		const viewer = await signIn('Report link viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		for (const p of [page, viewer.page]) {
			await p.goto(`/projects/${project.id}/reports/${jobId}`);
			const card = p.locator('section.job');
			await expect(card).toHaveAttribute('data-state', 'failed');
			await expect(card.locator('.pill')).toHaveText('Failed');
			await expect(p.getByRole('status')).toHaveText('The PDF could not be made: the renderer did not answer.');
			await expect(card).toContainText('Open the report to make the PDF again, or print it from your browser.');
			await expect(card).not.toContainText('checks again');
			await expect(p.getByRole('link', { name: 'Open the report in the app' })).toBeVisible();
		}
	});

	test('a link to a PDF that is gone says so, in the frame', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Report link gone');
		await page.goto(`/projects/${project.id}/reports/00000000-0000-4000-8000-000000000000`);
		await expect(page.locator('main').getByRole('alert')).toHaveText(/This report doesn't exist any more, or you don't have access to its project\. PDFs are kept for 7 days\./);
		await expect(page.getByTestId('report-job-context')).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
	});

	for (const colorScheme of ['light', 'dark'] as const) {
		for (const [label, viewport] of [
			['desktop', DESKTOP],
			['phone', PHONE]
		] as const) {
			test(`passes axe (${colorScheme}, ${label})`, async ({ page, owner }) => {
				void owner;
				await page.emulateMedia({ colorScheme });
				await page.setViewportSize(viewport);
				const project = await seedRunnableProject(page.request, `Report link a11y ${colorScheme} ${label}`);
				const runId = await createRun(page.request, project.id, 'Baseline');
				const jobId = await queueReport(page, project.id, runId);
				await page.goto(`/projects/${project.id}/reports/${jobId}`);
				await expect(page.getByTestId('report-job-context')).toBeVisible();
				await expectNoSidewaysScroll(page);
				await expectNoViolations(page);
			});
		}
	}
});

test.describe('the standalone /compare page', () => {
	test('one title, in the frame under Projects, with its way back to the runs', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize(DESKTOP);
		const w = await seedWhatIfs(page.request, 'Compare standalone');
		await page.goto(`/compare?a=${w.id}:${w.baseline}&b=${w.id}:${w.whatIf1}`);
		await expect(page.getByRole('heading', { name: 'What changes' })).toBeVisible();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Compare runs']);
		await expect(page.getByRole('link', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
		await expect(page.getByRole('link', { name: 'Back to runs' })).toHaveAttribute('href', `/projects/${w.id}?tab=runs`);
	});

	test('three runs on a phone: no sideways scroll, no violations; nor in the workspace tab', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize(PHONE);
		const w = await seedWhatIfs(page.request, 'Compare phone');
		await page.goto(`/compare?a=${w.id}:${w.baseline}&b=${w.id}:${w.whatIf1}&c=${w.id}:${w.whatIf2}`);
		await expect(page.getByRole('heading', { name: 'What changes' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Headline results' })).toBeVisible();
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
		// The same view inside the workspace (its table-wrap rule is app-wide now).
		await page.goto(`/projects/${w.id}?tab=compare&a=${w.id}:${w.baseline}&b=${w.id}:${w.whatIf1}&c=${w.id}:${w.whatIf2}`);
		await expect(page.getByRole('heading', { name: 'Headline results' })).toBeVisible();
		await expectNoSidewaysScroll(page);
	});
});
