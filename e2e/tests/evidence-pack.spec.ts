// Evidence packs on screen (WP-3.14, issue #71; docs/ui.md § Evidence pack and
// § Verify; docs/evidence-pack.md): a baseline pack created from the evidence
// report, signed in Appendix B.2 (the dialog says the signer's name is
// public), issued, stamped with its hash and code in every section and the
// footer the server PDF prints; then the public verify page, signed out: the
// verdict and signers, a wrong code, the downloaded manifest matching (as is
// and pretty-printed) and a one-byte change refused; then withdrawn, with its
// public reason. The reproduction bundle downloads from the pack and checks
// on the verify page. An application's packs in the Applications tab and panel,
// and a new version superseding the first. Synthetic catchment and invented
// rule table, as evidence-report.spec.ts.
//
// Needs MinIO (`pnpm dev:s3:up`; CI starts it): issuing a pack stores its
// reproduction bundle there. Locally, without it the spec is skipped and says
// why; in CI it never skips.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, nominateRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

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

const ready = (page: Page) => expect(page.locator('main[data-report-ready="true"]')).toBeVisible();

interface ApiPack {
	id: string;
	version: number;
	status: string;
	shortCode: string;
	manifestSha256: string;
	issuedAt: string | null;
	bundleSha256: string | null;
}

/** A nominated baseline with the declared rule, and the ensemble run to it on River & reserve (the browser runs it). */
async function seed(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', ewrRules: [TABLE], evidenceUncertaintyRule: RULE });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Calibrated baseline for the pack test');
	await page.goto(`/projects/${project.id}?tab=river&run=${baseline}`);
	const panel = page.getByTestId('uncertainty-panel');
	await panel.getByLabel('Parameter sets').fill('30');
	await panel.getByLabel(/^Lowest skill kept/).fill('-10');
	await panel.getByLabel('Worst WR2012 flag kept').selectOption('unusable');
	await panel.getByRole('checkbox', { name: 'Check the low-flow bias' }).uncheck();
	await panel.getByRole('button', { name: 'Run ensemble' }).click();
	await expect(panel.getByTestId('kept')).toHaveText(/^\d+ of 31$/);
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	return { project, baseline, upper };
}

/** Sign a pack through the API, every confirmation of the statement shown (the UI path is the first test's). */
async function signPack(request: APIRequestContext, projectId: string, packId: string) {
	const shown = (await (await request.get(`${API_URL}/projects/${projectId}/packs/${packId}/signoffs`)).json()) as {
		statement: { confirmations: { id: string }[] };
		statementSha256: string;
	};
	const res = await request.post(`${API_URL}/projects/${projectId}/packs/${packId}/signoffs`, {
		data: {
			fullName: 'Dr B. Signer',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '400888/19',
			scope: 'Hydrology of the evidence pack',
			confirmed: shown.statement.confirmations.map((c) => c.id),
			statementSha256: shown.statementSha256
		}
	});
	expect(res.status(), await res.text()).toBe(201);
}

async function getPack(request: APIRequestContext, projectId: string, packId: string): Promise<ApiPack> {
	return ((await (await request.get(`${API_URL}/projects/${projectId}/packs/${packId}`)).json()) as { pack: ApiPack }).pack;
}

test('a baseline pack is created, signed, issued and verified signed out; a copy is checked in the browser; withdrawn, it says why', async ({ page, owner, browser }) => {
	void owner;
	const { project, baseline } = await seed(page, 'Pack catchment');

	// The evidence report lists no pack yet, and offers to create one (the report may be issued).
	await page.goto(`/projects/${project.id}/report?run=${baseline}&evidence`);
	await ready(page);
	const packs = page.getByTestId('evidence-packs');
	await expect(packs).toContainText('None yet.');
	await packs.getByRole('button', { name: 'Create evidence pack' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/packs/[0-9a-f-]+$`));
	const packId = page.url().split('/').pop()!;
	await ready(page);

	// A draft: every section says so, no verify line, and the checklist says what's missing.
	const stamps = page.getByTestId('evidence-stamp');
	await expect(stamps.first()).toBeVisible();
	for (const s of await stamps.all()) await expect(s).toHaveText('Draft pack · not issued');
	await expect(page.getByTestId('evidence-verify-line')).toHaveCount(0);
	const actions = page.getByTestId('pack-actions');
	await expect(actions).toContainText('Draft pack, not issued.');
	const checklist = page.getByTestId('pack-checklist');
	await expect(checklist).toContainText('The frozen report may be issued');
	await expect(checklist).toContainText('Not signed under the current pack statement');
	await expect(actions.getByRole('button', { name: 'Issue pack' })).toBeDisabled();
	await expect(page.locator('main')).toHaveAttribute('data-report-footer', /^Draft pack · not issued · /);
	await expectNoViolations(page);

	// Sign it in Appendix B.2: the dialog says first that the signer's name and registration are public.
	await page.getByRole('button', { name: 'Sign off this evidence pack…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Sign off this evidence pack' });
	await expect(dialog.getByTestId('signoff-public')).toContainText('shown publicly, to anyone holding its code, on its verify page');
	await expectNoViolations(page, { include: 'dialog[open]' });
	await dialog.getByLabel('Full name', { exact: true }).fill('Dr A. Hydrologist');
	await dialog.getByLabel('Registration category', { exact: true }).selectOption('pr_sci_nat');
	await dialog.getByLabel('Field of practice', { exact: true }).selectOption('water_resources');
	await dialog.getByLabel('Registration number', { exact: true }).fill('400999/20');
	await dialog.getByLabel('What this sign-off covers', { exact: true }).fill('Hydrology of a synthetic WULA');
	const boxes = dialog.getByRole('checkbox');
	// The run statement's ten, and the pack's own eleventh naming its version and hash.
	await expect(boxes).toHaveCount(11);
	for (const box of await boxes.all()) await box.check();
	await dialog.getByRole('region', { name: /^Known limitations/ }).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
	await dialog.getByRole('button', { name: 'Sign off', exact: true }).click();
	await expect(dialog).toBeHidden();

	// Signed: the checklist is complete, and an editor issues it.
	await expect(checklist.locator('li.fail')).toHaveCount(0);
	// Reading the pack again after the issue fails once: the loaded pack stays, with the error inline and Try again.
	const packUrl = `${API_URL}/projects/${project.id}/packs/${packId}`;
	await page.route(packUrl, (route) =>
		route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Server busy' }) }) : route.fallback()
	);
	await actions.getByRole('button', { name: 'Issue pack' }).click();
	await answerConfirm(page, true, 'Its verify page then answers for code');
	const reloadError = page.getByTestId('pack-reload-error');
	await expect(reloadError).toContainText('The pack changed, but reading it again failed');
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(stamps.first()).toHaveText('Draft pack · not issued');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await page.unroute(packUrl);
	await reloadError.getByRole('button', { name: 'Try again' }).click();
	await expect(reloadError).toHaveCount(0);
	await expect(actions).toContainText('Issued');
	const issued = await getPack(page.request, project.id, packId);
	expect(issued.status).toBe('issued');
	const code = issued.shortCode;
	const stamp = `Issued · version 1 · ${issued.issuedAt!.slice(0, 10)}`;
	for (const s of await stamps.all()) await expect(s).toHaveText(stamp);
	const origin = new URL(page.url()).origin;
	const line = `Manifest SHA-256 ${issued.manifestSha256} · verify code ${code} at ${origin}/verify/${code}`;
	await expect(page.getByTestId('evidence-verify-line')).toHaveCount(await stamps.count());
	await expect(page.getByTestId('evidence-verify-line').first()).toHaveText(line);
	await expect(page.getByTestId('evidence-verify')).toContainText(issued.manifestSha256);
	await expect(page.getByTestId('pack-code')).toHaveText(code);
	// Issuing queued its server PDF (evidence-pack-pdf.spec.ts prints it): the bar says so, and offers the browser's print meanwhile.
	await expect(page.getByTestId('pack-pdf-state')).toHaveAttribute('data-state', 'rendering');
	await expect(page.getByTestId('pack-pdf-download')).toHaveCount(0);
	// The footer a server render prints on every page carries the stamp and the verify line.
	await expect(page.locator('main[data-report-ready="true"]')).toHaveAttribute('data-report-footer', new RegExp(`^${stamp} · Manifest SHA-256 ${issued.manifestSha256} · verify code ${code} at `));
	await expectNoViolations(page);

	// The manifest downloads as the canonical bytes its hash is taken of.
	const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('pack-manifest-download').click()]);
	expect(download.suggestedFilename()).toBe(`evidence-pack-${code}-manifest.json`);
	const manifest = await readFile((await download.path())!);

	// So does the reproduction bundle, through the API's redirect: its bytes are the ones recorded.
	expect(issued.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
	await expect(page.getByTestId('pack-bundle-sha')).toHaveText(issued.bundleSha256!);
	const [bundleDownload] = await Promise.all([page.waitForEvent('download'), page.getByTestId('pack-bundle-download').click()]);
	expect(bundleDownload.suggestedFilename()).toBe(`pack-${code}.zip`);
	const bundle = await readFile((await bundleDownload.path())!);
	expect(createHash('sha256').update(bundle).digest('hex')).toBe(issued.bundleSha256);

	// The evidence report lists it now.
	await page.goto(`/projects/${project.id}/report?run=${baseline}&evidence`);
	await ready(page);
	await expect(packs.getByRole('link', { name: `Version 1, code ${code}` })).toHaveAttribute('href', `/projects/${project.id}/packs/${packId}`);

	// Signed out: the public verify page.
	const anon = await browser.newContext();
	const pub = await anon.newPage();
	await pub.goto(`/verify/${code}`);
	const result = pub.getByTestId('verify-result');
	await expect(result).toHaveAttribute('data-status', 'issued');
	await expect(pub.getByTestId('verify-verdict')).toContainText('Issued and current.');
	await expect(result).toContainText('Pack catchment');
	await expect(pub.getByTestId('verify-manifest-sha')).toHaveText(issued.manifestSha256);
	await expect(pub.getByRole('definition').filter({ hasText: 'Dr A. Hydrologist' })).toBeVisible();
	await expect(pub.getByText('Pr.Sci.Nat. (Professional Natural Scientist), SACNASP, Water Resources Science, no. 400999/20')).toBeVisible();
	// The code is read in any case, without dashes.
	await pub.goto(`/verify/${code.replaceAll('-', '').toUpperCase()}`);
	await expect(result).toHaveAttribute('data-status', 'issued');

	// A copy checked in the browser: the manifest as downloaded, pretty-printed, and with one byte changed.
	const check = pub.getByTestId('verify-check');
	await expect(check.getByRole('heading', { name: 'Check a reproduction bundle or manifest' })).toBeVisible();
	await expect(pub.getByTestId('verify-bundle-sha')).toContainText(issued.bundleSha256!);
	const file = pub.getByTestId('verify-file');
	const verdict = pub.getByTestId('verify-check-result');
	await file.setInputFiles({ name: 'manifest.json', mimeType: 'application/json', buffer: manifest });
	await expect(verdict).toContainText('Matches. “manifest.json” is this pack’s manifest, unchanged.');
	await file.setInputFiles({ name: `pack-${code}.zip`, mimeType: 'application/zip', buffer: bundle });
	await expect(verdict).toContainText(`Matches. “pack-${code}.zip” is this pack’s reproduction bundle, unchanged.`);
	await file.setInputFiles({ name: 'pretty.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(JSON.parse(manifest.toString('utf8')), null, 2)) });
	await expect(verdict).toContainText('(compared in its canonical JSON form, as the hash is taken)');
	const changed = Buffer.from(manifest);
	const at = changed.indexOf('"pack-1"') + 6;
	expect(at).toBeGreaterThan(5);
	changed[at] = '2'.charCodeAt(0);
	await file.setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: changed });
	await expect(verdict).toContainText('Doesn’t match. “changed.json” is not this pack’s reproduction bundle or manifest');
	await expectNoViolations(pub);
	await pub.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(pub);
	await pub.emulateMedia({ colorScheme: 'light' });

	// A code nothing answers for, and a malformed one: the same "not found".
	for (const wrong of ['ffff-ffff-ffff', 'not-a-code']) {
		await pub.goto(`/verify/${wrong}`);
		await expect(pub.getByTestId('verify-not-found')).toContainText(`Nothing answers for ${wrong}.`);
	}
	await expectNoViolations(pub);

	// Withdrawn, with a reason the dialog says is public: the pack and the verify page both say it.
	await page.goto(`/projects/${project.id}/packs/${packId}`);
	await ready(page);
	await actions.getByRole('button', { name: 'Withdraw…' }).click();
	const withdraw = page.getByRole('dialog', { name: 'Withdraw version 1 of this pack' });
	await expect(withdraw).toContainText('The reason is public:');
	await withdraw.getByLabel('Reason').fill('The rule table was replaced by the 2026 determination.');
	await withdraw.getByRole('button', { name: 'Withdraw pack' }).click();
	await expect(page.getByTestId('pack-banner')).toContainText('Withdrawn. Reason (shown publicly on the verify page): The rule table was replaced by the 2026 determination.');
	for (const s of await stamps.all()) await expect(s).toHaveText(/^Withdrawn · version 1 · issued \d{4}-\d{2}-\d{2}$/);
	await pub.goto(`/verify/${code}`);
	await expect(result).toHaveAttribute('data-status', 'withdrawn');
	await expect(pub.getByTestId('verify-verdict')).toContainText('Withdrawn.');
	await expect(pub.getByTestId('verify-reason')).toHaveText('Reason given: The rule table was replaced by the 2026 determination.');
	await expectNoViolations(pub);
	await anon.close();
});

test('an application’s packs show in the Applications tab and its panel; a new version supersedes the first', async ({ page, owner, browser, signIn }) => {
	void owner;
	const { project, baseline, upper } = await seed(page, 'Pack applications');

	// An applicant's application on the published (and nominated) baseline, run and submitted; then its paired band.
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId: baseline } })).status()).toBe(201);
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

	// Version 1, drafted from the application report, then signed and issued.
	await page.goto(`/projects/${project.id}/report?run=${app}&evidence`);
	await ready(page);
	await page.getByTestId('evidence-packs').getByRole('button', { name: 'Create evidence pack' }).click();
	await expect(page).toHaveURL(/\/packs\/[0-9a-f-]+$/);
	const v1 = page.url().split('/').pop()!;
	await ready(page);
	// The licence impact board is in the manifest (evidence-5), so the pack prints it, not the note an older pack shows.
	await expect(page.getByTestId('evidence-impact-board').getByRole('heading', { name: 'Impact by year class' })).toBeVisible();
	await expect(page.getByTestId('evidence-impact-board-omitted')).toHaveCount(0);
	await signPack(page.request, project.id, v1);
	expect((await page.request.post(`${API_URL}/projects/${project.id}/packs/${v1}/issue`, { data: {} })).status()).toBe(200);
	const first = await getPack(page.request, project.id, v1);

	// The Applications tab lists it in its row; the Application panel too.
	await page.goto(`/projects/${project.id}?tab=applications`);
	const cell = page.getByTestId('application-packs');
	await expect(cell.getByRole('link', { name: /^Evidence pack v1 Issued$/ })).toHaveAttribute('href', `/projects/${project.id}/packs/${v1}`);
	await expectNoViolations(page);
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	const listed = page.getByTestId('application-panel-packs');
	await expect(listed.getByRole('link', { name: new RegExp(first.shortCode) })).toHaveAttribute('href', `/projects/${project.id}/packs/${v1}`);

	// Version 2 from the evidence report: named as the next version, it replaces version 1 once issued.
	await page.goto(`/projects/${project.id}/report?run=${app}&evidence`);
	await ready(page);
	await page.getByTestId('evidence-packs').getByRole('button', { name: 'Create version 2 of the evidence pack' }).click();
	await expect(page).not.toHaveURL(new RegExp(`/packs/${v1}$`));
	await expect(page).toHaveURL(/\/packs\/[0-9a-f-]+$/);
	const v2 = page.url().split('/').pop()!;
	await ready(page);
	await signPack(page.request, project.id, v2);
	expect((await page.request.post(`${API_URL}/projects/${project.id}/packs/${v2}/issue`, { data: {} })).status()).toBe(200);
	const second = await getPack(page.request, project.id, v2);
	expect(second.version).toBe(2);

	// Version 1's page says it is superseded and links the newer one; its verify page points to version 2's.
	await page.goto(`/projects/${project.id}/packs/${v1}`);
	await ready(page);
	const banner = page.getByTestId('pack-banner');
	await expect(banner).toContainText('Superseded. A newer version replaces this one.');
	await expect(banner.getByRole('link', { name: 'Open the newer version' })).toHaveAttribute('href', `/projects/${project.id}/packs/${v2}`);
	await expect(page.getByTestId('evidence-stamp').first()).toHaveText(/^Superseded · version 1 · issued /);
	const anon = await browser.newContext();
	const pub = await anon.newPage();
	await pub.goto(`/verify/${first.shortCode}`);
	await expect(pub.getByTestId('verify-result')).toHaveAttribute('data-status', 'superseded');
	await expect(pub.getByTestId('verify-verdict').getByRole('link', { name: `Verify the newer version (${second.shortCode})` })).toHaveAttribute('href', `/verify/${second.shortCode}`);
	await expectNoViolations(pub);
	await anon.close();
});
