// The printable catchment report (WP-2.15 Phase A, issue #19, docs/ui.md §
// Report): opened from the Runs tab, ready when every section has loaded and
// every chart has drawn (data-report-ready), printed to an A4 PDF, visible to
// a viewer and to nobody outside the project, and printed light whatever the
// screen theme.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

// The seeded catchment has a network, farms (so curtailment) and, with the
// notes below, every section the report has without a Reserve rule table.
// Every report closes with the validation statement, the sign-off and the
// disclaimer (WP-3.13; signoff.spec.ts covers them).
const SECTIONS = [
	'1. Network',
	'2. Inputs',
	'3. Calibration',
	'4. Shortfalls and curtailment',
	'5. EWR compliance',
	'6. Units, warnings and checks',
	'7. Notes',
	'8. Validation statement',
	'9. Professional sign-off',
	'10. Disclaimer'
];

async function seedRun(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	const runId = await createRun(page.request, project.id, 'Baseline');
	const res = await page.request.patch(`${API_URL}/projects/${project.id}/runs/${runId}`, { data: { notes: 'Baseline for the meeting.\nObserved record is short.' } });
	expect(res.status()).toBe(200);
	return { projectId: project.id, runId };
}

const ready = (page: Page) => expect(page.locator('main[data-report-ready="true"]')).toBeVisible();

test('the Runs tab opens the report of the shown run, which prints to an A4 PDF', async ({ page, owner }) => {
	void owner;
	const { projectId, runId } = await seedRun(page, 'Report catchment');
	await page.goto(`/projects/${projectId}?tab=runs`);
	await page.getByRole('link', { name: 'Report', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/report\\?run=${runId}$`));
	// Preparing until every section has loaded and both charts have drawn.
	await ready(page);
	await expect(page.getByRole('status').filter({ hasText: 'Save as PDF' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Download PDF' })).toBeEnabled();

	await expect(page.getByRole('heading', { level: 1, name: 'Report catchment' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2 })).toHaveText(SECTIONS);
	for (const chart of await page.locator('figure.chart').all()) await expect(chart).toHaveAttribute('data-ready', 'true');
	await expect(page.locator('figure.chart canvas')).toHaveCount(2);
	// Every farm's EWR grid is printed, not only the outlet's behind a picker.
	await expect(page.getByRole('heading', { name: /^EWR compliance by month: / })).toHaveText([
		'EWR compliance by month: outlet (Outflow gauge)',
		'EWR compliance by month: Upper farm (EWR charge)',
		'EWR compliance by month: Lower farm (EWR charge)'
	]);
	await expect(page.getByText('Baseline for the meeting.')).toBeVisible();

	// Headless Chromium prints the page as a browser does: A4, a page per section.
	const pdf = await page.pdf({ format: 'A4' });
	expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
	const pages = pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
	expect(pages).toBeGreaterThanOrEqual(SECTIONS.length + 1);
});

test('without ?run= the report is of the latest run', async ({ page, owner }) => {
	void owner;
	const { projectId } = await seedRun(page, 'Report latest');
	await createRun(page.request, projectId, 'Second run');
	await page.goto(`/projects/${projectId}/report`);
	await ready(page);
	await expect(page.getByText('Second run', { exact: true })).toBeVisible();
});

test('an outsider gets no report; a viewer of the project does', async ({ page, owner, signIn }) => {
	void owner;
	const { projectId, runId } = await seedRun(page, 'Report access');
	const url = `/projects/${projectId}/report?run=${runId}`;

	const outsider = await signIn('Report outsider');
	await outsider.page.goto(url);
	await expect(outsider.page.getByRole('alert')).toHaveText(/This project doesn't exist or you don't have access to it/);
	await expect(outsider.page.getByRole('heading', { level: 2 })).toHaveCount(0);
	await expect(outsider.page.locator('main[data-report-ready]')).toHaveCount(0);

	// Positive control: the same link works for a member with the lowest role.
	const viewer = await signIn('Report viewer');
	await addMember(page.request, projectId, viewer.user.email, 'viewer');
	await viewer.page.goto(url);
	await ready(viewer.page);
	await expect(viewer.page.getByRole('heading', { level: 2 })).toHaveText(SECTIONS);
});

test('printing switches a dark screen to the light theme and back', async ({ page, owner }) => {
	void owner;
	await page.emulateMedia({ colorScheme: 'dark' });
	const { projectId, runId } = await seedRun(page, 'Report dark');
	await page.goto(`/projects/${projectId}/report?run=${runId}`);
	await ready(page);
	const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
	expect(await theme()).toBeNull();
	await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
	expect(await theme()).toBe('light');
	// The charts redrew in the light theme before the print, not after it.
	await expect(page.locator('figure.chart[data-ready="true"]')).toHaveCount(2);
	await page.evaluate(() => dispatchEvent(new Event('afterprint')));
	expect(await theme()).toBeNull();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} theme`, () => {
		test.use({ colorScheme });

		test('the report has no WCAG 2.2 AA violations on screen', async ({ page, owner }) => {
			void owner;
			const { projectId, runId } = await seedRun(page, `Report a11y ${colorScheme}`);
			await page.goto(`/projects/${projectId}/report?run=${runId}`);
			await ready(page);
			await expectNoViolations(page);
		});
	});
}
