// The licensing evidence report (issue #71, WP-2.15 Phase C; docs/ui.md §
// Evidence report; docs/design/evidence-report.md §11): the nominated run with
// a declared uncertainty rule and an ensemble run to it, an application
// scenario on it with a paired band, then the report: every section and
// page-1 row present with "Draft · not issued" on each, the checks passing,
// print to PDF. A run that isn't the nomination is refused (board 2), and an
// application that moves a baseline assumption previews with the red banner
// and can't be issued. Synthetic catchment and invented rule table.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
/** The rule the project declares, and the ensemble the River tab runs to it. */
const RULE = { members: 30, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: -10, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null } };
const TABLE = {
	siteNodeId: null,
	source: 'Invented rule table for tests',
	category: 'B/C',
	component: 'total',
	unit: 'mcm',
	points: POINTS,
	ewr: Array.from({ length: 12 }, () => POINTS.map((_, i) => 0.5 - i * 0.04)),
	naturalSource: 'run',
	natural: null,
	scale: 1
};
const ready = (page: Page) => expect(page.locator('main[data-report-ready="true"]')).toBeVisible();

async function seed(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', ewrRules: [TABLE], evidenceUncertaintyRule: RULE });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Calibrated baseline for the evidence test');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	return { project, baseline, upper };
}

async function scenarioRun(page: Page, projectId: string, baseRunId: string, upper: string, name: string, own: boolean) {
	const res = await page.request.post(`${API_URL}/projects/${projectId}/scenarios`, {
		data: { name, baseRunId, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 300_000 }], ownedNodeIds: own ? [upper] : [] }
	});
	expect(res.status()).toBe(201);
	const { scenario } = (await res.json()) as { scenario: { id: string } };
	const ran = await page.request.post(`${API_URL}/projects/${projectId}/scenarios/${scenario.id}/runs`, { data: {} });
	expect(ran.status()).toBe(201);
	return { scenarioId: scenario.id, runId: ((await ran.json()) as { run: { id: string } }).run.id };
}

test('an application on the nominated run gives the full evidence report, draft on every page', async ({ page, owner }) => {
	void owner;
	const { project, baseline, upper } = await seed(page, 'Evidence report');

	// The ensemble, run to the declared rule on River & reserve (the server draws the seed and checks it).
	await page.goto(`/projects/${project.id}?tab=river&run=${baseline}`);
	const panel = page.getByTestId('uncertainty-panel');
	await panel.getByLabel('Parameter sets').fill('30');
	await panel.getByLabel(/^Lowest skill kept/).fill('-10');
	await panel.getByLabel('Worst WR2012 flag kept').selectOption('unusable');
	await panel.getByRole('checkbox', { name: 'Check the low-flow bias' }).uncheck();
	await panel.getByRole('button', { name: 'Run ensemble' }).click();
	await expect(panel.getByTestId('kept')).toHaveText(/^\d+ of 31$/);

	// The application, and its paired band on Compare.
	const { scenarioId, runId: app } = await scenarioRun(page, project.id, baseline, upper, 'Upper dam 300 000 m³', true);
	await page.goto(`/compare?a=${project.id}:${baseline}&b=${project.id}:${app}`);
	const paired = page.getByTestId('paired-uncertainty');
	await paired.getByRole('button', { name: 'Compute the paired band' }).click();
	await expect(paired.getByTestId('paired-rule')).toContainText('percentiles of the difference');

	// The Runs tab offers the evidence report of the nominated run; the scenario run's is the application report.
	await page.goto(`/projects/${project.id}?tab=runs&run=${baseline}`);
	await expect(page.getByTestId('evidence-report-link')).toHaveAttribute('href', new RegExp(`/report\\?run=${baseline}&evidence$`));
	// The scenario's comparison against its base links to the application report of its run.
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	await expect(page.getByTestId('scenario-evidence-link')).toHaveAttribute('href', new RegExp(`/report\\?run=${app}&evidence$`));

	await page.goto(`/projects/${project.id}/report?run=${app}&evidence`);
	await ready(page);
	const report = page.getByTestId('evidence-report');
	await expect(report).toHaveAttribute('data-evidence-mode', 'application');
	await expect(page.getByRole('heading', { level: 1, name: 'Upper dam 300 000 m³' })).toBeVisible();
	for (const h of ['1. The river', '2. Uncertainty', '3. Model and data', '4. Other users', '5. Registered water use', 'Appendix A. Inputs and assumptions', 'Appendix B. Limitations, sign-off and verification', 'Appendix C. Applicant’s statement'])
		await expect(page.getByRole('heading', { level: 2, name: h })).toBeVisible();
	// G12: the draft stamp on every section.
	await expect(page.getByTestId('evidence-stamp')).toHaveCount(9);
	for (const s of await page.getByTestId('evidence-stamp').all()) await expect(s).toHaveText('Draft · not issued');

	// Page 1: the banner, the flags, and the fixed rows with paired bands and "worse in".
	await expect(page.getByTestId('evidence-banner')).toContainText('No baseline assumption changed.');
	await expect(page.getByTestId('evidence-published')).toContainText('Nothing is published for this project');
	const table = page.getByTestId('evidence-change-table');
	for (const label of [
		'Reserve months met',
		'Days below the EWR',
		'Volume short of the EWR, whole run',
		'No-flow days at the outlet',
		'Days below the EWR, first site below the works',
		'Mean annual outflow at the outlet',
		'The applicant’s own supply',
		'Registered vs modelled use'
	])
		await expect(table.getByRole('rowheader', { name: new RegExp(`^${label}`) }).first()).toBeVisible();
	// The outlet's row comes before the works' row, which starts the same way.
	const days = table.getByRole('row', { name: /^Days below the EWR/ }).first();
	await expect(days.getByRole('cell').nth(3)).toHaveText(/^\d+ of \d+ sets \(\d+ %\)$/);
	// The engine-1.32.0 measures carry the paired band and "worse in" (ER4): no-flow days and the applicant's own supply.
	for (const label of [/^No-flow days at the outlet/, /^The applicant’s own supply/])
		await expect(table.getByRole('row', { name: label }).getByRole('cell').nth(3)).toHaveText(/^\d+ of \d+ sets \(\d+ %\)$/);
	// The upper farm's dam has no EWR site between it and the outlet: said, with the assessor's question.
	await expect(table.getByRole('row', { name: /^Days below the EWR, first site below the works/ })).toContainText('Not assessed: no EWR site between the works and the outlet');
	await expect(page.getByTestId('evidence-rules')).toContainText('R2 · Paired rule');
	// § 5 and its row: the project has no registered volumes, so both say so (G6); evidence-allocations.spec.ts has the assessed case.
	await expect(table.getByRole('row', { name: /^Registered vs modelled use/ })).toContainText('Not assessed: the runs carry no registered volumes');
	await expect(page.getByTestId('evidence-allocations-na')).toContainText('Not assessed: the runs carry no registered volumes');

	// § 1: the FDC check carries the baseline's band (ER5). § 4: each unit's change is banded, and the users served in full while the outlet fails.
	await expect(report.getByTestId('fdc-band-a').first()).toBeVisible();
	await expect(page.getByTestId('evidence-users').getByRole('row', { name: /^Lower farm/ })).toContainText(/\d+ of \d+ sets/);
	await expect(page.getByTestId('evidence-served').first().getByRole('rowheader', { name: /^Upper farm \(the applicant’s\)/ })).toBeVisible();

	// Board 1: nothing stops the report being issued.
	await expect(page.getByTestId('evidence-checks')).toContainText('Every check that stops a pack being issued passes.');
	// The ledger, the ops with their class, the series hashes, the applicant's words only in Appendix C.
	await expect(page.getByTestId('evidence-ledger').getByRole('row')).toHaveCount(2);
	await expect(page.getByTestId('evidence-ops')).toContainText('Proposal Upper farm: Dam capacity');
	await expect(page.getByTestId('evidence-series').getByRole('cell', { name: /^[0-9a-f]{64}$/ }).first()).toBeVisible();
	await expect(page.getByTestId('evidence-application-runs')).toContainText('(this report)');

	await expectNoViolations(page);
	// It prints (WP-2.15's test pattern).
	await page.emulateMedia({ media: 'print' });
	const pdf = await page.pdf({ format: 'A4' });
	expect(pdf.byteLength).toBeGreaterThan(10_000);
});

test('a run that isn’t the nomination is refused; a baseline-assumption application previews in red and can’t be issued', async ({ page, owner }) => {
	void owner;
	const { project, baseline, upper } = await seed(page, 'Evidence refusals');

	// Board 2: an ordinary run that isn't the nomination.
	const other = await createRun(page.request, project.id, 'Another run');
	// The Runs tab offers no evidence report for a plain run that isn't the nomination; the nominated run's is the positive control.
	await page.goto(`/projects/${project.id}?tab=runs&run=${baseline}`);
	await expect(page.getByTestId('evidence-report-link')).toHaveAttribute('href', new RegExp(`/report\\?run=${baseline}&evidence$`));
	await page.goto(`/projects/${project.id}?tab=runs&run=${other}`);
	await expect(page.getByRole('link', { name: 'Report', exact: true })).toHaveAttribute('href', new RegExp(`/report\\?run=${other}$`));
	await expect(page.getByTestId('evidence-report-link')).toHaveCount(0);
	await page.goto(`/projects/${project.id}/report?run=${other}&evidence`);
	await ready(page);
	const refused = page.getByTestId('evidence-refused');
	await expect(refused.getByRole('heading', { name: 'This run can’t be reported as evidence' })).toBeVisible();
	await expect(refused).toContainText('The baseline is the project’s current nominated evidence run.');
	await expect(refused.getByRole('link', { name: 'Open the ordinary catchment report of this run' })).toBeVisible();
	await expect(page.getByTestId('evidence-report')).toHaveCount(0);
	await expectNoViolations(page);

	// Positive control: the nominated run's own (baseline) report isn't refused.
	await page.goto(`/projects/${project.id}/report?run=${baseline}&evidence`);
	await ready(page);
	await expect(page.getByTestId('evidence-report')).toHaveAttribute('data-evidence-mode', 'baseline');
	// § 1's site strip prints the rule table's REC (ER9).
	await expect(page.getByTestId('evidence-rec')).toHaveText('B/C');
	await expect(page.getByRole('heading', { level: 2, name: 'Appendix C. Applicant’s statement' })).toHaveCount(0);

	// A team scenario owns no node: its change moves a baseline assumption (G3).
	const { runId: app } = await scenarioRun(page, project.id, baseline, upper, 'Assumption change', false);
	await page.goto(`/projects/${project.id}/report?run=${app}&evidence`);
	await ready(page);
	await expect(page.getByTestId('evidence-banner')).toContainText('Baseline assumptions changed.');
	await expect(page.getByTestId('evidence-flags').getByRole('listitem').first()).toContainText('Baseline assumptions changed: this report is a preview and can’t be issued.');
	const checks = page.getByTestId('evidence-checks');
	await expect(checks).toContainText('Some checks stop this report being issued as a pack.');
	await expect(checks).toContainText('No baseline assumption is changed (stops issue)');
});
