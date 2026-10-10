// An issued evidence pack's PDF (issue #71, WP-3.14 "Rendering: reuse
// WP-2.15"; docs/evidence-pack.md § The PDF, 119_pack_render): issuing a
// signed pack queues its render; the background worker (support/jobs.ts, one
// tick) prints the pack's own page in its own headless Chromium through a
// render session that reads that pack only, stores the PDF in MinIO under its
// SHA-256, and records the hash on the pack once. The download is those very
// bytes: their SHA-256 is what the pack and the public verify lookup answer.
// The same tick re-runs the pack's runs from its stored reproduction bundle
// (pack_reproduce, 154_pack_reproduce), and the pack's page says they
// reproduced; verify doesn't (it is the app's own claim). After an engine
// upgrade an editor re-runs it on the new engine from the same bar, and the
// new outcome is recorded beside the old.
// The pack has a map, so its § 1 prints the locality map (evidence-12).
//
// Needs MinIO (`pnpm dev:s3:up`; CI starts it). Locally, without it the spec
// is skipped and says why; in CI it never skips.
import { createHash } from 'node:crypto';
import { createRun, nominateRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { ageReproductionEngine } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { box } from '../support/map.ts';

const S3 = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9002';
/** The rule the project declares, and the ensemble the River tab runs to it (evidence-report.spec.ts). */
const RULE = { members: 30, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: -10, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null } };

test.beforeAll(async () => {
	const up = await fetch(`${S3}/minio/health/live`, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);
	test.skip(!up && !process.env.CI, 'needs MinIO: pnpm dev:s3:up');
});

test('issuing a pack prints its PDF once; the download is the bytes whose SHA-256 the pack and verify answer', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Pack PDF catchment');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', evidenceUncertaintyRule: RULE });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Calibrated baseline for the pack PDF test');
	// A map, so the pack's § 1 prints its locality map (evidence-12): the figure is an image of the SVG in the page the renderer prints.
	expect(
		(await page.request.post(`${API_URL}/projects/${project.id}/map/features`, { data: { kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [box(21.3, -33.7, 0.1)] } } })).status()
	).toBe(201);

	// The ensemble the pack cites, run to the declared rule on River & reserve.
	await page.goto(`/projects/${project.id}?tab=river&run=${baseline}`);
	const panel = page.getByTestId('uncertainty-panel');
	await panel.getByRole('button', { name: 'Run…' }).click();
	await panel.getByLabel('Parameter sets').fill('30');
	await panel.getByLabel(/^Lowest skill kept/).fill('-10');
	await panel.getByLabel('Worst WR2012 flag kept').selectOption('unusable');
	await panel.getByRole('checkbox', { name: 'Check the low-flow bias' }).uncheck();
	await panel.getByRole('button', { name: 'Run ensemble' }).click();
	await expect(panel.getByTestId('kept')).toHaveText(/^\d+ of 31$/);

	// Draft, sign and issue the baseline pack.
	const at = `${API_URL}/projects/${project.id}/packs`;
	const drafted = await page.request.post(at, { data: { runId: baseline } });
	expect(drafted.status(), await drafted.text()).toBe(201);
	const { pack } = (await drafted.json()) as { pack: { id: string; shortCode: string; version: number } };
	const shown = (await (await page.request.get(`${at}/${pack.id}/signoffs`)).json()) as { statement: { confirmations: { id: string }[] }; statementSha256: string };
	const signed = await page.request.post(`${at}/${pack.id}/signoffs`, {
		data: {
			fullName: 'Dr A. Hydrologist',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '400999/20',
			scope: 'the hydrology of the evidence pack',
			confirmed: shown.statement.confirmations.map((k) => k.id),
			statementSha256: shown.statementSha256
		}
	});
	expect(signed.status(), await signed.text()).toBe(201);
	const issued = await page.request.post(`${at}/${pack.id}/issue`, { data: {} });
	expect(issued.status(), await issued.text()).toBe(200);
	expect((await issued.json()).pdf).toEqual({ status: 'rendering', error: null });

	// The background worker's tick: prints the pack's page, stores it, records its hash.
	await runJobsTick({ projects: [project.id], schedule: false });

	const read = (await (await page.request.get(`${at}/${pack.id}`)).json()) as {
		pack: { pdfSha256: string | null; pdfPages: number | null };
		pdf: { status: string };
		reproduction: { status: string; engineVersion: string | null; checks: { id: string; ok: boolean }[] };
	};
	expect(read.pdf).toEqual({ status: 'ready', error: null });
	// The same tick re-ran the baseline run from the stored bundle: reproduced, every check passing.
	expect(read.reproduction.status).toBe('reproduced');
	expect(read.reproduction.engineVersion).toBeTruthy();
	expect(read.reproduction.checks.map((c) => c.id)).toContain('reproduce:baseline');
	expect(read.reproduction.checks.every((c) => c.ok)).toBe(true);
	expect(read.pack.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(read.pack.pdfPages).toBeGreaterThanOrEqual(1);

	// The download: a short-lived signed URL of the packs bucket, and the bytes behind it are the ones hashed.
	const link = await page.request.get(`${at}/${pack.id}/pdf`, { maxRedirects: 0 });
	expect(link.status()).toBe(302);
	const location = link.headers()['location']!;
	expect(location).toContain(`/water-packs/packs/${project.id}/${pack.id}/${read.pack.pdfSha256}.pdf?`);
	const pdf = Buffer.from(await (await fetch(location)).arrayBuffer());
	expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
	expect(createHash('sha256').update(pdf).digest('hex')).toBe(read.pack.pdfSha256);
	expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length).toBe(read.pack.pdfPages);

	// What anyone holding the printed code sees: the same hash, and nothing of the server's re-run.
	const verified = await page.request.get(`${API_URL}/verify/${pack.shortCode}`);
	const verifiedBody = (await verified.json()) as { pack: { pdfSha256: string } };
	expect(verifiedBody.pack.pdfSha256).toBe(read.pack.pdfSha256);
	expect(JSON.stringify(verifiedBody)).not.toMatch(/reproduc/i);

	// The pack's page offers the server PDF (not the browser's print), and no longer says it is printing.
	await page.goto(`/projects/${project.id}/packs/${pack.id}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByTestId('pack-pdf-download')).toHaveAttribute('href', `${API_URL}/projects/${project.id}/packs/${pack.id}/pdf`);
	await expect(page.getByTestId('pack-pdf-state')).toHaveCount(0);
	// And what the server's re-run found, in the bar (never printed).
	const reproduced = page.getByTestId('pack-reproduction');
	await expect(reproduced).toHaveAttribute('data-state', 'reproduced');
	await expect(reproduced).toContainText(`re-run with engine ${read.reproduction.engineVersion} from the stored reproduction bundle, its run gave the same results`);

	// Printed once: a second request is refused.
	expect((await page.request.post(`${at}/${pack.id}/pdf`, { data: {} })).status()).toBe(409);

	// On the engine it ran with, the outcome stands: no re-run is offered.
	await expect(page.getByTestId('pack-reproduce-again')).toHaveCount(0);
	// After an engine upgrade (the recorded outcome now an older engine's), the editor re-runs it on the server's.
	await ageReproductionEngine(pack.id, '0.0.1-older');
	await page.reload();
	await expect(reproduced).toHaveAttribute('data-state', 'reproduced');
	await expect(reproduced).toContainText(`The server now runs engine ${read.reproduction.engineVersion}`);
	const again = page.getByTestId('pack-reproduce-again');
	await expect(again).toHaveText(`Re-run on engine ${read.reproduction.engineVersion}`);
	await again.click();
	await expect(reproduced).toHaveAttribute('data-state', 'checking');
	await expect(again).toHaveCount(0);
	await runJobsTick({ projects: [project.id], schedule: false });
	await reproduced.getByRole('button', { name: 'Check again' }).click();
	await expect(reproduced).toHaveAttribute('data-state', 'reproduced');
	await expect(reproduced).toContainText(`re-run with engine ${read.reproduction.engineVersion} from the stored reproduction bundle`);
	await expect(reproduced).not.toContainText('now runs engine');
	await expect(again).toHaveCount(0);
});
