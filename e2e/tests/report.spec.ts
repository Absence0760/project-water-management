// The printable catchment report (WP-2.15 Phase A, issue #19, docs/ui.md §
// Report): opened from the Runs tab, ready when every section has loaded and
// every chart has drawn (data-report-ready), printed to an A4 PDF with the
// running footer on every page, visible to a viewer and to nobody outside the
// project (a farmer is sent to their farm page), and printed light whatever
// the screen theme. A published run (issue #70), opened from the Overview's
// published card, names who published it and its notice on the cover, and
// lists the changes since the publication before it.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { acceptInvites, addMember, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

// The seeded catchment has a network, farms (so curtailment and the assurance
// of supply) and, with the notes below, every section the report has without a
// Reserve rule table or a publication.
// Every report closes with the validation statement, the sign-off and the
// disclaimer (WP-3.13; signoff.spec.ts covers them).
const SECTIONS = [
	'1. Network',
	'2. Inputs',
	'3. Calibration',
	'4. Shortfalls and curtailment',
	'5. EWR compliance',
	'6. Assurance of supply',
	'7. Hydrological units, warnings and checks',
	'8. Notes',
	'9. Validation statement',
	'10. Professional sign-off',
	'11. Disclaimer'
];

const hasPdftotext = (() => {
	try {
		execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

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

	// Every unit's and user's stress classes are printed, not only the network's behind a picker.
	await expect(page.locator('#rep-assurance').getByRole('heading', { name: /^Stress classes by month: / })).toHaveText([
		'Stress classes by month: All hydrological units and users',
		'Stress classes by month: Upper farm',
		'Stress classes by month: Lower farm'
	]);
	await expect(page.locator('#rep-assurance').getByRole('combobox')).toHaveCount(0);

	// Headless Chromium prints the page as a browser does: A4, a page per section.
	const pdf = await page.pdf({ format: 'A4' });
	expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
	const pages = pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
	expect(pages).toBeGreaterThanOrEqual(SECTIONS.length + 1);
});

test('every printed page carries the running footer: the disclaimer’s key point and “Page X of Y”', async ({ page, owner }, testInfo) => {
	void owner;
	test.skip(!hasPdftotext && !process.env.CI, 'needs pdftotext (poppler-utils)');
	const { projectId, runId } = await seedRun(page, 'Report footer');
	await page.goto(`/projects/${projectId}/report?run=${runId}`);
	await ready(page);
	const footer = (await page.locator('main').getAttribute('data-report-footer'))!;
	const path = testInfo.outputPath('report.pdf');
	writeFileSync(path, await page.pdf({ format: 'A4' }));
	// One text per page, split on form feeds; pdftotext joins the footer's wrapped lines with a newline.
	const texts = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' }).split('\f').filter((t) => t.trim());
	expect(texts.length).toBeGreaterThanOrEqual(SECTIONS.length + 1);
	texts.forEach((t, i) => {
		const flat = t.replace(/\s+/g, ' ');
		expect(flat).toContain(footer.split(' · ')[0]);
		expect(flat).toContain('Model estimates; see the Disclaimer');
		expect(flat).toContain(`Page ${i + 1} of ${texts.length}.`);
	});
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

test('a farmer of the project gets no report, and is sent to their farm page', async ({ page, owner, signIn }) => {
	const { projectId, runId } = await seedRun(page, 'Report farmer');
	const url = `/projects/${projectId}/report?run=${runId}`;
	const model = await (await page.request.get(`${API_URL}/projects/${projectId}/model`)).json();
	const upper = (model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const farmer = await signIn('Report farmer');
	const add = await page.request.post(`${API_URL}/projects/${projectId}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper] } });
	expect(add.status()).toBe(201);
	await acceptInvites(farmer.user.email, projectId);

	await farmer.page.goto(url);
	// Like the workspace, the report sends a farmer to their farm page (replacing the history entry).
	await expect(farmer.page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	await expect(farmer.page.locator('main.report')).toHaveCount(0);
	// The API refuses the farmer the run and its publication (403, not 404: they are a member).
	expect((await farmer.page.request.get(`${API_URL}/projects/${projectId}/runs/${runId}`)).status()).toBe(403);
	expect((await farmer.page.request.get(`${API_URL}/projects/${projectId}/runs/${runId}/publication`)).status()).toBe(403);
	void owner;
});

test('the Overview’s published card opens the published run’s report: who published it, the notice, and what changed since the publication before', async ({ page, owner }) => {
	const { projectId, runId: first } = await seedRun(page, 'Report publication');
	expect((await page.request.post(`${API_URL}/projects/${projectId}/publication`, { data: { runId: first } })).status()).toBe(201);
	// A saved change (a bigger dam on the upper farm), then that run published with a notice.
	const model = await (await page.request.get(`${API_URL}/projects/${projectId}/model`)).json();
	await putModel(page.request, projectId, { ...model, nodes: model.nodes.map((n: { name: string; damCapacityM3: number }) => (n.name === 'Upper farm' ? { ...n, damCapacityM3: 200_000 } : n)) });
	const second = await createRun(page.request, projectId, 'Bigger dam');
	const pub = await page.request.post(`${API_URL}/projects/${projectId}/publication`, {
		data: { runId: second, restriction: { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night only.' } } }
	});
	expect(pub.status()).toBe(201);

	await page.goto(`/projects/${projectId}`);
	const card = page.getByRole('region', { name: 'Published baseline' });
	await card.getByRole('link', { name: 'Report', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/report\\?run=${second}$`));
	await ready(page);

	await expect(page.getByTestId('report-published')).toContainText(`by ${owner.displayName}; the run stakeholders see now`);
	const notice = page.getByRole('note', { name: /^Restriction notice: Restricted · 20 %/ });
	await expect(notice).toContainText('English: Irrigate at night only.');
	// This run has no notes, so the changes follow the summary.
	await expect(page.getByRole('heading', { level: 2 })).toContainText(['7. Hydrological units, warnings and checks', '8. Changes since the previous publication', '9. Validation statement']);
	const changes = page.getByRole('region', { name: '8. Changes since the previous publication' });
	await expect(changes).toContainText('Since the publication before this one: “Baseline”');
	await expect(changes).toContainText('Upper farm');
	await expect(changes).toContainText(`1 saved change to the model or settings between the runs, by ${owner.displayName}.`);

	// The first run's report: published, since replaced, with nothing published before it.
	await page.goto(`/projects/${projectId}/report?run=${first}`);
	await ready(page);
	await expect(page.getByTestId('report-published')).toContainText('; replaced ');
	await expect(page.getByRole('heading', { level: 2, name: /Changes since the previous publication/ })).toHaveCount(0);
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
