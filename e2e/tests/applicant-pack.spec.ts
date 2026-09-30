// An applicant reads and shares their own application's evidence pack
// (WP-3.15; issue #71; 131_applicant_packs; docs/ui.md § Evidence pack → The
// applicant's pack view). The assessors draft, sign and issue a pack of a
// submitted application (through the API: the screens are
// evidence-pack.spec.ts'); the applicant finds it in their Application panel,
// opens their copy (their own farm by name, the neighbour only as "Farm 1",
// no PDF, manifest or bundle), makes a read-only share link to it, and
// someone signed out opens the link. axe on the pack view and the Share
// dialog; the phone layout doesn't scroll sideways. Synthetic catchment and
// invented rule table, as evidence-pack.spec.ts.
//
// Needs MinIO (`pnpm dev:s3:up`; CI starts it): issuing a pack stores its
// reproduction bundle there. Locally, without it the spec is skipped and says
// why; in CI it never skips.
import type { APIRequestContext } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, nominateRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const PHONE = { width: 360, height: 740 };
const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
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
const S3 = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9002';

test.beforeAll(async () => {
	const up = await fetch(`${S3}/minio/health/live`, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);
	test.skip(!up && !process.env.CI, 'needs MinIO (issuing a pack stores its reproduction bundle): pnpm dev:s3:up');
});

/** Draft, sign (every confirmation shown) and issue a pack of `runId` through the API, as an editor. */
async function issuePack(request: APIRequestContext, projectId: string, runId: string): Promise<{ id: string; shortCode: string }> {
	const at = `${API_URL}/projects/${projectId}/packs`;
	const drafted = await request.post(at, { data: { runId } });
	expect(drafted.status(), await drafted.text()).toBe(201);
	const { pack } = (await drafted.json()) as { pack: { id: string; shortCode: string } };
	const shown = (await (await request.get(`${at}/${pack.id}/signoffs`)).json()) as { statement: { confirmations: { id: string }[] }; statementSha256: string };
	const signed = await request.post(`${at}/${pack.id}/signoffs`, {
		data: {
			fullName: 'Dr D. Signer',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '400999/20',
			scope: 'Hydrology of the evidence pack',
			confirmed: shown.statement.confirmations.map((c) => c.id),
			statementSha256: shown.statementSha256
		}
	});
	expect(signed.status(), await signed.text()).toBe(201);
	const issued = await request.post(`${at}/${pack.id}/issue`, { data: {} });
	expect(issued.status(), await issued.text()).toBe(200);
	return pack;
}

test('an applicant reads their own issued pack, anonymised, and shares it by link', async ({ page, owner, signIn, browser }) => {
	void owner;
	// A nominated, published baseline with the declared rule and its ensemble.
	const project = await seedRunnableProject(page.request, 'Applicant pack catchment');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', ewrRules: [TABLE], evidenceUncertaintyRule: RULE });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Calibrated baseline for the applicant pack test');
	await page.goto(`/projects/${project.id}?tab=river&run=${baseline}`);
	const panel = page.getByTestId('uncertainty-panel');
	await panel.getByLabel('Parameter sets').fill('30');
	await panel.getByLabel(/^Lowest skill kept/).fill('-10');
	await panel.getByLabel('Worst WR2012 flag kept').selectOption('unusable');
	await panel.getByRole('checkbox', { name: 'Check the low-flow bias' }).uncheck();
	await panel.getByRole('button', { name: 'Run ensemble' }).click();
	await expect(panel.getByTestId('kept')).toHaveText(/^\d+ of 31$/);
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId: baseline } })).status()).toBe(201);

	// The applicant's application on Upper farm, run and submitted; the assessors' paired band and pack.
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const applicant = await signIn('Pack applicant');
	await addMember(page.request, project.id, applicant.user.email, 'contributor');
	expect((await page.request.put(`${API_URL}/projects/${project.id}/farmers/${applicant.user.id}`, { data: { nodeIds: [upper] } })).status()).toBe(200);
	const created = await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: { name: 'Upper dam 300 000 m³', baseRunId: baseline, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 300_000 }] }
	});
	expect(created.status(), await created.text()).toBe(201);
	const scenarioId = ((await created.json()) as { scenario: { id: string } }).scenario.id;
	const ran = await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	expect(ran.status(), await ran.text()).toBe(201);
	const app = ((await ran.json()) as { run: { id: string } }).run.id;
	expect((await applicant.context.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/submit`, { data: {} })).status()).toBe(200);
	await page.goto(`/compare?a=${project.id}:${baseline}&b=${project.id}:${app}`);
	const paired = page.getByTestId('paired-uncertainty');
	await paired.getByRole('button', { name: 'Compute the paired band' }).click();
	await expect(paired.getByTestId('paired-rule')).toContainText('percentiles of the difference');
	const pack = await issuePack(page.request, project.id, app);

	// The applicant finds it in their Application panel and opens their copy.
	const a = applicant.page;
	await a.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	const mine = a.getByTestId('application-panel-my-packs');
	const open = mine.getByRole('link', { name: `Version 1, code ${pack.shortCode}` });
	await expect(open).toHaveAttribute('href', `/projects/${project.id}/scenarios/${scenarioId}/packs/${pack.id}`);
	await open.click();
	const view = a.getByTestId('applicant-pack');
	await expect(view.getByTestId('applicant-pack-standing')).toHaveAttribute('data-status', 'issued');
	await expect(view.getByTestId('applicant-pack-code')).toHaveText(pack.shortCode);
	await expect(view.getByTestId('applicant-pack-own').getByRole('rowheader')).toHaveText([/^Upper farm/]);
	await expect(view.getByTestId('applicant-pack-others').getByRole('rowheader')).toHaveText(['Farm 1']);
	await expect(view.getByTestId('applicant-pack-rows')).toBeVisible();
	// The neighbour is never named, and the assessors' copies aren't offered.
	await expect(view).not.toContainText('Lower farm');
	await expect(view.getByRole('link', { name: /Download/ })).toHaveCount(0);
	await expectNoViolations(a);

	// A share link from the pack view, opened signed out.
	await view.getByTestId('applicant-pack-share-open').click();
	const dialog = a.getByRole('dialog', { name: 'Share evidence pack v1 read-only' });
	await expect(dialog.getByTestId('pack-share')).toContainText('If the pack is later withdrawn or replaced, the link says so');
	await dialog.getByLabel('Who it’s for').fill('Catchment forum');
	await dialog.getByRole('button', { name: 'Make link' }).click();
	const url = await dialog.getByLabel('The new link').inputValue();
	expect(url).toMatch(/\/share#t=[A-Za-z0-9_-]{43}&k=pack$/);
	await expect(dialog.getByRole('row', { name: /Catchment forum/ })).toContainText('Live');
	await expectNoViolations(a);
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();

	// Signed out, the link shows the pack's public projection: no hydrological unit named, the applicant's own included.
	const outside = await browser.newContext({ viewport: PHONE, locale: 'en-ZA', timezoneId: 'UTC' });
	const pub = await outside.newPage();
	await pub.goto(url);
	await expect(pub.getByTestId('share-pack-status')).toHaveAttribute('data-status', 'issued');
	await expect(pub.getByTestId('share-pack-rows')).toContainText('Days below the EWR at the outlet');
	for (const farm of ['Upper farm', 'Lower farm']) await expect(pub.getByText(farm)).toHaveCount(0);
	await outside.close();

	// The phone layout of the applicant's view.
	await a.setViewportSize(PHONE);
	await a.goto(`/projects/${project.id}/scenarios/${scenarioId}/packs/${pack.id}`);
	await expect(view.getByTestId('applicant-pack-standing')).toBeVisible();
	await expectNoSidewaysScroll(a);
});
