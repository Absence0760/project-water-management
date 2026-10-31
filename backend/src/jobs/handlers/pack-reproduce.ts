// `pack_reproduce`: re-run an issued evidence pack's runs on the server from
// its stored reproduction bundle, and record what came of it on the pack
// (issue #71, followups.md "Re-run both runs on the server after issue";
// docs/evidence-pack.md § Reproduction, 154_pack_reproduce.sql). Queued by
// POST …/packs/:packId/issue in the issue's transaction, as the editor who
// issued, one pending per pack.
//
// It does what an assessor's `pnpm reproduce:pack --expect <hash>` does, on
// the bytes the app stored: read the bundle back from the packs bucket, check
// they hash to the pack's recorded bundle_sha256, then check it without
// re-running (engine planPackBundleReruns: every file, the manifest against
// the pack's hash, the inputs, the stored results). A failed check is the
// outcome now, recorded through app_record_pack_reproduction from this job's
// own transaction, once per engine version. Otherwise the re-runs go out as
// parts, each its own `pack_reproduce_part` job (302, so a pack whose
// combined row holds 160 firm-yield searches never runs past one job's
// 300 s), gathered into the same record by the last one back
// (evidence/packReproduceParts.ts).
//
// A bundle that doesn't reproduce is an outcome, recorded, not a job failure:
// the job is done. Only what another attempt can fix fails it (the store
// unreachable), with retries; then the pack's page says the check failed.
import { type BundleCheck, BUNDLE_ZIP_LIMITS, ENGINE_VERSION, planPackBundleReruns } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../../db/tx.js';
import { bundleHash } from '../../evidence/bundle.js';
import type { PackReproductionOutcome } from '../../evidence/packReproduce.js';
import { fanOutReproduction, reproductionOutcome, storedBundleCheck } from '../../evidence/packReproduceParts.js';
import { logEvent } from '../../logging/logEvent.js';
import { getPackBundle } from '../../reports/storage.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

export { isRerunCheck, reproductionOutcome, storedBundleCheck } from '../../evidence/packReproduceParts.js';

export const PackReproducePayload = z.object({ packId: z.string().uuid() }).strict();

async function record(
	db: Db,
	packId: string,
	outcome: PackReproductionOutcome,
	runEngines: string[],
	bundleSha256: string | null,
	checks: BundleCheck[]
): Promise<boolean> {
	const { rows } = await db.query<{ recorded: boolean }>('SELECT app_record_pack_reproduction($1, $2, $3, $4, $5, $6) AS recorded', [
		packId,
		outcome,
		ENGINE_VERSION,
		runEngines,
		bundleSha256,
		JSON.stringify(checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail.length > 2000 ? `${c.detail.slice(0, 1999)}…` : c.detail })))
	]);
	return rows[0]?.recorded ?? false;
}

export const packReproduceHandler = defineHandler({
	// Queued by the editor who issued the pack; only editors enqueue jobs of this kind (job_insert).
	role: 'editor',
	payload: PackReproducePayload,
	async run({ db, job, payload }) {
		const { rows } = await db.query<{ issued: boolean; manifestSha256: string; bundleKey: string | null; bundleSha256: string | null }>(
			`SELECT issued_at IS NOT NULL AS issued, manifest_sha256 AS "manifestSha256", bundle_key AS "bundleKey", bundle_sha256 AS "bundleSha256"
			 FROM evidence_pack WHERE project_id = $1 AND id = $2`,
			[job.projectId, payload.packId]
		);
		const pack = rows[0];
		if (!pack) throw new JobError('the evidence pack is gone, or you can no longer see it', { retry: false });
		if (!pack.issued) throw new JobError('an evidence pack that was never issued is not re-run', { retry: false });
		// Recorded already for this engine (a second job, a redelivery): the first outcome stands.
		const { rowCount } = await db.query('SELECT 1 FROM pack_reproduction WHERE pack_id = $1 AND engine_version = $2', [payload.packId, ENGINE_VERSION]);
		if (rowCount) return;

		if (!pack.bundleKey || !pack.bundleSha256) {
			await record(db, payload.packId, 'no_bundle', [], null, [{ id: 'stored', ok: false, detail: 'this pack was issued without a reproduction bundle' }]);
			return;
		}

		let bytes: Uint8Array<ArrayBuffer> | null;
		try {
			bytes = await getPackBundle(pack.bundleKey, BUNDLE_ZIP_LIMITS.maxTotalBytes);
		} catch (err) {
			console.error(`pack ${payload.packId}: reading the bundle failed:`, (err as Error).message);
			throw new JobError('the reproduction bundle could not be read from storage (is object storage running? `pnpm dev:s3:up`)');
		}
		const stored = storedBundleCheck(bytes && { sha256: bundleHash(bytes) }, pack.bundleSha256);
		const started = Date.now();
		let outcome: PackReproductionOutcome;
		let checks: BundleCheck[];
		let runEngines: string[] = [];
		if (!stored.ok || !bytes) {
			outcome = 'not_reproduced';
			checks = [stored];
		} else {
			// Checked without re-running; the re-runs are parts, each its own job (302, evidence/packReproduceParts.ts).
			const plan = await planPackBundleReruns(bytes, { hash: bundleHash, expectManifestSha256: pack.manifestSha256 });
			runEngines = [...new Set(plan.result.engine.runs)];
			checks = [stored, ...plan.result.checks];
			if (plan.parts.length) {
				const gatheringId = await fanOutReproduction(db, job, { id: payload.packId, bundleSha256: pack.bundleSha256 }, { checks, runEngines, parts: plan.parts });
				logEvent('info', { event: 'pack_reproduce_fanned_out', packId: payload.packId, projectId: job.projectId, gatheringId, parts: plan.parts.length, ms: Date.now() - started });
				return;
			}
			// A check failed before any re-run (or there was none to make): the outcome is known now.
			outcome = reproductionOutcome({ ok: plan.result.ok, checks, engine: plan.result.engine });
		}
		const recorded = await record(db, payload.packId, outcome, runEngines, pack.bundleSha256, checks);
		logEvent(outcome === 'reproduced' ? 'info' : 'warn', {
			event: 'pack_reproduced',
			packId: payload.packId,
			projectId: job.projectId,
			outcome,
			engine: ENGINE_VERSION,
			failed: checks.filter((c) => !c.ok).map((c) => c.id).join(','),
			ms: Date.now() - started,
			recorded
		});
	}
});
