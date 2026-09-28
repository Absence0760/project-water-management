// Server-side PDF reports (WP-2.15 Phase B, issue #26, docs/ui.md § Report):
// "Email me the PDF" on the report page queues a render; the background
// worker (support/jobs.ts, one tick) prints the SAME report route in its own
// headless Chromium, stores the PDF in MinIO and mails the link through
// Mailpit; the page follows the job's status to a download link; the PDF is
// A4 with a page per section; and the emailed link opens the download page
// for the signed-in member. Settings → Scheduled reports: an editor adds one,
// a viewer only reads.
//
// Needs MinIO and Mailpit (`pnpm dev:s3:up && pnpm dev:mail:up`; CI starts
// both). Locally, without them the spec is skipped and says why; in CI it
// never skips.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';

const S3 = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9002';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8026';
const reachable = (url: string) =>
	fetch(url, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);

// The report of the seeded catchment has these sections (report.spec.ts).
const SECTIONS = 7;

test.beforeAll(async () => {
	const up = (await reachable(`${S3}/minio/health/live`)) && (await reachable(`${MAILPIT}/api/v1/info`));
	test.skip(!up && !process.env.CI, 'needs MinIO and Mailpit: pnpm dev:s3:up && pnpm dev:mail:up');
});

async function seedRun(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	const runId = await createRun(page.request, project.id, 'Baseline');
	const res = await page.request.patch(`${API_URL}/projects/${project.id}/runs/${runId}`, { data: { notes: 'Baseline for the meeting.' } });
	expect(res.status()).toBe(200);
	return { projectId: project.id, runId };
}

/** The newest Mailpit message to `to`, as text. */
async function mailTo(to: string): Promise<{ subject: string; text: string }> {
	const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`)).json();
	expect(search.messages, `a mail to ${to} in Mailpit`).toHaveLength(1);
	const m = await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0].ID}`)).json();
	return { subject: m.Subject, text: m.Text };
}

test('Email me the PDF: the worker renders the report, the page offers the download, and the link arrives by email', async ({ page, owner }) => {
	const { projectId, runId } = await seedRun(page, 'Server report catchment');
	await page.goto(`/projects/${projectId}/report?run=${runId}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();

	const control = page.locator('.server-pdf');
	await page.getByRole('button', { name: 'Email me the PDF' }).click();
	await expect(control).toHaveAttribute('data-state', 'queued');
	await expect(page.getByRole('status').filter({ hasText: 'PDF queued: waiting for the background worker…' })).toBeVisible();

	// The background worker's tick: renders in its own Chromium, stores, mails.
	await runJobsTick();

	// The page follows the job's status (the API's, a real signal) to "done".
	await expect(control).toHaveAttribute('data-state', 'done');
	await expect(page.getByRole('status').filter({ hasText: /^PDF ready \(\d+ pages\)\. The link is on its way by email\.$/ })).toBeVisible();

	const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download the generated PDF' }).click()]);
	expect(download.suggestedFilename()).toMatch(/^server-report-catchment-report-\d{4}-\d{2}-\d{2}\.pdf$/);
	const pdf = await readFile((await download.path())!);
	expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
	const pages = pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
	// The cover, then a page per section (report.spec.ts), and the same pages
	// this browser prints from the same page: one implementation.
	expect(pages).toBeGreaterThanOrEqual(SECTIONS + 1);
	const printed = await page.pdf({ format: 'A4', printBackground: true });
	expect(printed.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length).toBe(pages);
	// A4 portrait: 595 × 842 points (Chromium writes 594.96 × 841.92).
	expect(pdf.toString('latin1')).toMatch(/\/MediaBox\s*\[\s*0 0 59[45](\.\d+)? 84[12](\.\d+)?\s*\]/);

	// The email: to the requester, with a link to the sign-in-gated download page.
	const mail = await mailTo(owner.email);
	expect(mail.subject).toBe('Catchment report: Server report catchment — Water Management');
	const link = mail.text.match(/Download the report: (\S+)/)?.[1];
	expect(link).toMatch(new RegExp(`/projects/${projectId}/reports/[0-9a-f-]{36}$`));
	await page.goto(link!);
	await expect(page.getByRole('heading', { level: 1, name: 'Catchment report PDF' })).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: /^PDF ready \(\d+ pages\)\.$/ })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Download the PDF' })).toBeVisible();
});

test('an impact report’s server PDF prints the impact against its baseline, the same pages as the browser', async ({ page, owner }) => {
	const { projectId, runId: baseline } = await seedRun(page, 'Server impact catchment');
	const whatIf = await createRun(page.request, projectId, 'What-if');
	await page.goto(`/projects/${projectId}/report?run=${whatIf}&against=${projectId}:${baseline}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByRole('region', { name: '1. Impact against the baseline' })).toBeVisible();

	const control = page.locator('.server-pdf');
	await page.getByRole('button', { name: 'Email me the PDF' }).click();
	await expect(control).toHaveAttribute('data-state', 'queued');
	await runJobsTick();
	await expect(control).toHaveAttribute('data-state', 'done');

	const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download the generated PDF' }).click()]);
	const pdf = await readFile((await download.path())!);
	expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
	const pages = pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
	// The cover, the impact section, then the report's own sections: the server printed this page, impact included.
	expect(pages).toBeGreaterThanOrEqual(SECTIONS + 2);
	const printed = await page.pdf({ format: 'A4', printBackground: true });
	expect(printed.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length).toBe(pages);

	const mail = await mailTo(owner.email);
	expect(mail.text).toContain(`${owner.displayName} made a PDF of the impact report for the run What-if`);
});

test('the emailed link opens nothing for someone outside the project', async ({ page, owner, signIn }) => {
	void owner;
	const { projectId } = await seedRun(page, 'Server report access');
	const res = await page.request.post(`${API_URL}/projects/${projectId}/reports`, { data: {} });
	expect(res.status()).toBe(202);
	const { jobId } = await res.json();
	const outsider = await signIn('Report link outsider');
	await outsider.page.goto(`/projects/${projectId}/reports/${jobId}`);
	await expect(outsider.page.locator('main').getByRole('alert')).toHaveText(/This report doesn't exist any more, or you don't have access to its project/);
	await expect(outsider.page.getByRole('link', { name: 'Download the PDF' })).toHaveCount(0);
});

test('Settings → Scheduled reports: an editor adds a weekly schedule; a viewer reads it without controls', async ({ page, owner, signIn }) => {
	const { projectId } = await seedRun(page, 'Scheduled report catchment');
	const viewer = await signIn('Schedule viewer');
	await addMember(page.request, projectId, viewer.user.email, 'viewer');

	await page.goto(`/projects/${projectId}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Scheduled reports' });
	await expect(panel.getByText('No scheduled reports.')).toBeVisible();
	await panel.getByRole('button', { name: 'Add a schedule' }).click();
	await panel.getByLabel('Every', { exact: true }).selectOption('weekly');
	await panel.getByLabel('On', { exact: true }).selectOption({ label: 'Monday' });
	await panel.getByLabel('At', { exact: true }).selectOption({ label: '07:00' });
	// The browser's zone (e2e pins UTC) is the default.
	await expect(panel.getByLabel('Time zone')).toHaveValue('UTC');
	await expect(panel.getByRole('checkbox', { name: new RegExp(owner.displayName) })).toBeChecked();
	await panel.getByRole('checkbox', { name: /Schedule viewer/ }).check();
	await panel.getByRole('button', { name: 'Add schedule' }).click();

	await expect(panel.getByRole('status').filter({ hasText: 'Schedule added: Every Monday at 07:00 (UTC).' })).toBeVisible();
	const item = panel.getByRole('list', { name: 'Scheduled reports' }).getByRole('listitem');
	await expect(item).toHaveCount(1);
	await expect(item).toContainText('Every Monday at 07:00 (UTC)');
	await expect(item).toContainText(`sends as ${owner.displayName}`);
	await expect(item).toContainText(/Next: /);

	await viewer.page.goto(`/projects/${projectId}?tab=settings`);
	const theirs = viewer.page.getByRole('region', { name: 'Scheduled reports' });
	await expect(theirs.getByRole('listitem')).toContainText('Every Monday at 07:00 (UTC)');
	await expect(theirs.getByRole('button', { name: 'Add a schedule' })).toHaveCount(0);
	await expect(theirs.getByRole('button', { name: /^Pause/ })).toHaveCount(0);

	// Pausing is the editor's.
	await item.getByRole('button', { name: /^Pause:/ }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Schedule paused.' })).toBeVisible();
	await expect(item).toContainText('Paused.');
});
