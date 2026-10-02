// `pack_reproduce`: re-run an issued evidence pack's runs on the server from
// its stored reproduction bundle, and record what came of it on the pack
// (issue #71, followups.md "Re-run both runs on the server after issue";
// docs/evidence-pack.md § Reproduction, 154_pack_reproduce.sql). Queued by
// POST …/packs/:packId/issue in the issue's transaction, as the editor who
// issued, one pending per pack.
//
// It does what an assessor's `pnpm reproduce:pack --expect <hash>` does, on
// the bytes the app stored: read the bundle back from the packs bucket, check
// they hash to the pack's recorded bundle_sha256, then the engine's
// checkPackBundle with the re-run (every file, the manifest against the
// pack's hash, the inputs, the stored results, and each run re-run to its
// results digest). The outcome, this engine's version, the runs' engines and
// every check are recorded through app_record_pack_reproduction, which takes
// them only from this job's own transaction, once per engine version.
//
// A bundle that doesn't reproduce is an outcome, recorded, not a job failure:
// the job is done. Only what another attempt can fix fails it (the store
// unreachable), with retries; then the pack's page says the check failed.
import { type BundleCheck, type BundleCheckResult, BUNDLE_ZIP_LIMITS, checkPackBundle, ENGINE_VERSION } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../../db/tx.js';
import { bundleHash } from '../../evidence/bundle.js';
import type { PackReproductionOutcome } from '../../evidence/packReproduce.js';
import { logEvent } from '../../logging/logEvent.js';
import { getPackBundle } from '../../reports/storage.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const PackReproducePayload = z.object({ packId: z.string().uuid() }).strict();

/** What the outcome is called on the pack, from the engine's checks. */
export function reproductionOutcome(r: Pick<BundleCheckResult, 'ok' | 'checks' | 'engine'>): Exclude<PackReproductionOutcome, 'no_bundle'> {
	if (r.ok) return 'reproduced';
	// Only the re-runs differ, and some run was made with another engine than this one: expected to differ, not evidence of a fault.
	const failed = r.checks.filter((c) => !c.ok);
	const onlyReruns = failed.length > 0 && failed.every((c) => c.id.startsWith('reproduce:'));
	if (onlyReruns && r.engine.runs.some((v) => v !== r.engine.here)) return 'other_engine';
	return 'not_reproduced';
}

/** A check the job adds before the engine's: the stored bytes are the bundle the pack records. */
export function storedBundleCheck(stored: { sha256: string } | null, recorded: string): BundleCheck {
	if (!stored) return { id: 'stored', ok: false, detail: 'the packs bucket holds no object under the pack’s recorded bundle key' };
	return stored.sha256 === recorded
		? { id: 'stored', ok: true, detail: `the stored bundle hashes to the pack’s recorded SHA-256 ${recorded}` }
		: { id: 'stored', ok: false, detail: `the stored bundle hashes to ${stored.sha256}, not the pack’s recorded ${recorded}` };
}

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
			const result = await checkPackBundle(bytes, { hash: bundleHash, rerun: true, expectManifestSha256: pack.manifestSha256 });
			outcome = reproductionOutcome(result);
			checks = [stored, ...result.checks];
			runEngines = [...new Set(result.engine.runs)];
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
