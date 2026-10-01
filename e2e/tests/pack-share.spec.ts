// A share link to one evidence pack, and public comments on it (WP-3.15, the
// pack half; issue #71; 128_pack_share_notes; docs/ui.md § Evidence pack,
// § Share page): an editor makes a read-only link from an issued pack's own
// page; someone outside opens it signed out on a phone and reads what the
// verify page says plus the pack's own river figures, and no hydrological
// unit's name; an NGO officer signs in from the page and comments (no role in
// the project: a link participant, 166_public_participation); the pack
// is then withdrawn, and the same link says so, and why, with no figure and
// commenting closed, while the comment stays. The editor sees the comment in
// the pack's notes. axe on the Share dialog, the shared pack (issued and
// withdrawn) and the notes drawer. Synthetic catchment, invented names only.
//
// Needs MinIO (`pnpm dev:s3:up`; CI starts it): issuing a pack stores its
// reproduction bundle there. Locally, without it the spec is skipped and says
// why; in CI it never skips.
import type { APIRequestContext } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, PASSWORD, seedRunnableProject, updateSettings } from '../support/api.ts';
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
const REASON = 'The rule table was replaced by the 2026 determination.';
const COMMENT = 'Please publish the low-flow months for the wetland below the weir.';
const S3 = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9002';

test.beforeAll(async () => {
	const up = await fetch(`${S3}/minio/health/live`, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);
	test.skip(!up && !process.env.CI, 'needs MinIO (issuing a pack stores its reproduction bundle): pnpm dev:s3:up');
});

/** Draft, sign (every confirmation of the statement shown) and issue a baseline pack through the API. */
async function issueBaselinePack(request: APIRequestContext, projectId: string, runId: string): Promise<{ id: string; shortCode: string }> {
	const at = `${API_URL}/projects/${projectId}/packs`;
	const drafted = await request.post(at, { data: { runId } });
	expect(drafted.status(), await drafted.text()).toBe(201);
	const { pack } = (await drafted.json()) as { pack: { id: string; shortCode: string } };
	const shown = (await (await request.get(`${at}/${pack.id}/signoffs`)).json()) as { statement: { confirmations: { id: string }[] }; statementSha256: string };
	const signed = await request.post(`${at}/${pack.id}/signoffs`, {
		data: {
			fullName: 'Dr C. Signer',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '400777/18',
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

test('an editor shares an issued pack; an NGO reads it signed out and comments; withdrawn, the link says so and why', async ({ page, owner, signIn, browser }) => {
	void owner;
	const ngo = await signIn('Wetland Trust officer');
	const project = await seedRunnableProject(page.request, 'Shared pack catchment');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', ewrRules: [TABLE], evidenceUncertaintyRule: RULE });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Calibrated baseline for the pack share test');
	// Not a member of the project: they comment through the link alone (166_public_participation).

	// The ensemble the pack cites, run to the declared rule on River & reserve.
	await page.goto(`/projects/${project.id}?tab=river&run=${baseline}`);
	const panel = page.getByTestId('uncertainty-panel');
	await panel.getByLabel('Parameter sets').fill('30');
	await panel.getByLabel(/^Lowest skill kept/).fill('-10');
	await panel.getByLabel('Worst WR2012 flag kept').selectOption('unusable');
	await panel.getByRole('checkbox', { name: 'Check the low-flow bias' }).uncheck();
	await panel.getByRole('button', { name: 'Run ensemble' }).click();
	await expect(panel.getByTestId('kept')).toHaveText(/^\d+ of 31$/);
	const pack = await issueBaselinePack(page.request, project.id, baseline);

	// The editor (the owner) makes a link from the pack's own page.
	await page.goto(`/projects/${project.id}/packs/${pack.id}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await page.getByTestId('pack-share-open').click();
	const dialog = page.getByRole('dialog', { name: 'Share evidence pack v1 read-only' });
	await expect(dialog.getByTestId('pack-share')).toContainText('If the pack is later withdrawn or replaced, the link says so');
	await dialog.getByLabel('Who it’s for').fill('Wetland forum');
	await dialog.getByRole('button', { name: 'Make link' }).click();
	const url = await dialog.getByLabel('The new link').inputValue();
	expect(url).toMatch(/\/share#t=[A-Za-z0-9_-]{43}&k=pack$/);
	await expect(dialog.getByRole('row', { name: /Wetland forum/ })).toContainText('Live');
	await expectNoViolations(page);
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();

	// Signed out, on a phone: the pack's standing and its river figures, no hydrological unit named.
	const outside = await browser.newContext({ viewport: PHONE, locale: 'en-ZA', timezoneId: 'UTC' });
	const shared = await outside.newPage();
	await shared.goto(url);
	await expect(shared).toHaveURL(/\/share$/);
	await expect(shared.getByRole('heading', { level: 1 })).toHaveText('Shared pack catchment');
	await expect(shared.getByTestId('share-pack-status')).toHaveAttribute('data-status', 'issued');
	await expect(shared.getByTestId('share-pack-status')).toHaveText(/^Issued on /);
	const ewr = shared.getByRole('region', { name: 'The river’s ecological reserve' });
	await expect(ewr.getByText('At the catchment outlet')).toBeVisible();
	await expect(ewr.getByRole('definition').first()).toContainText(/^Met in \d+\s?% of \d+\smonths$/);
	await expect(shared.getByTestId('share-pack-rows')).toContainText('Days below the EWR at the outlet');
	const check = shared.getByTestId('share-pack-check');
	await expect(check).toContainText(pack.shortCode);
	await expect(check).toContainText('Dr C. Signer, SACNASP 400777/18');
	await expect(shared.getByTestId('share-pack-verify')).toHaveAttribute('href', `/verify/${pack.shortCode}`);
	for (const farm of ['Upper farm', 'Lower farm']) await expect(shared.getByText(farm)).toHaveCount(0);
	await expectNoSidewaysScroll(shared);
	await expectNoViolations(shared);

	// They sign in from the page, come back to the same pack, and comment for public participation, with no role in the project.
	await shared.getByTestId('share-sign-in').click();
	await expect(shared).toHaveURL(/\/login/);
	await shared.getByLabel('Email').fill(ngo.user.email);
	await shared.getByLabel('Password').fill(PASSWORD);
	await shared.getByRole('button', { name: 'Sign in' }).click();
	await expect(shared).toHaveURL(/\/share$/);
	await expect(shared.getByRole('heading', { level: 1 })).toHaveText('Shared pack catchment');
	const comments = shared.getByRole('region', { name: 'Public comments' });
	await comments.getByLabel('Add a comment').fill(COMMENT);
	await comments.getByRole('button', { name: 'Post comment' }).click();
	await expect(comments.getByRole('listitem').filter({ hasText: COMMENT })).toContainText('Wetland Trust officer');
	await expectNoViolations(shared);

	// The editor sees the comment in the pack's notes, marked public, then withdraws the pack.
	await page.reload();
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await page.getByRole('button', { name: 'Notes on evidence pack v1 (1)' }).click();
	const drawer = page.getByRole('dialog', { name: 'Notes and comments on evidence pack v1' });
	const note = drawer.getByRole('listitem').filter({ hasText: COMMENT });
	await expect(note).toContainText('Wetland Trust officer');
	await expect(note.getByTestId('note-audience-badge')).toHaveText('Public');
	await expect(drawer.getByTestId('note-audience')).toHaveValue('team');
	await expectNoViolations(page);
	await drawer.getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByTestId('pack-actions').getByRole('button', { name: 'Withdraw…' }).click();
	const withdraw = page.getByRole('dialog', { name: 'Withdraw version 1 of this pack' });
	await withdraw.getByLabel('Reason').fill(REASON);
	await withdraw.getByRole('button', { name: 'Withdraw pack' }).click();
	await expect(page.getByTestId('pack-banner')).toContainText(REASON);

	// The same link now says the pack is withdrawn, and why: no figure, commenting closed, the comment kept.
	await shared.goto(url);
	await expect(shared.getByTestId('share-pack-status')).toHaveAttribute('data-status', 'withdrawn');
	await expect(shared.getByTestId('share-pack-standing')).toContainText('This pack was withdrawn');
	await expect(shared.getByTestId('share-pack-reason')).toHaveText(REASON);
	await expect(shared.getByTestId('share-pack-ewr')).toHaveCount(0);
	await expect(shared.getByTestId('share-pack-rows')).toHaveCount(0);
	const closed = shared.getByRole('region', { name: 'Public comments' });
	await expect(closed.getByRole('listitem').filter({ hasText: COMMENT })).toBeVisible();
	await expect(closed).toContainText('Commenting is closed: this pack no longer stands.');
	await expect(closed.getByLabel('Add a comment')).toHaveCount(0);
	await expectNoSidewaysScroll(shared);
	await expectNoViolations(shared);
	await outside.close();

	// The owner's inventory lists the link with what it opens now.
	await page.goto(`/projects/${project.id}?tab=project`);
	await expect(page.getByRole('row', { name: /Wetland forum/ })).toContainText('The pack is withdrawn: the link shows that and why, not its figures.');
});
