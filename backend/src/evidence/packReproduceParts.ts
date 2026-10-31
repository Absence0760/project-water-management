// The server's re-run of an issued evidence pack, in parts (302_pack_reproduce_parts;
// docs/evidence-pack.md § Reproduction).
//
// The `pack_reproduce` job (jobs/handlers/pack-reproduce.ts) reads the
// bundle back, checks it is the bytes the pack records, and checks it without
// re-running (engine planPackBundleReruns). A check that fails is the outcome
// at once (not reproduced), recorded by that job as before. Otherwise it fans
// out (fanOutReproduction): one `pack_reproduce_part` job per part of the
// plan (each run, the headline pair, § 8's pairs, the combined row's
// assessment and its background, one firm-yield search per touched dam and
// run), kept in `pack_reproduce_gathering` / `pack_reproduce_part`. Each part
// job (computeReproducePart), as the same editor, reads the bundle, checks its
// hash again, runs its part (engine rerunPackBundlePart) and stores what it
// found; then gathers (gatherReproduction): under a per-gathering lock, once
// every part is back, it folds them (engine foldPackBundleReruns: the checks
// of a full checkPackBundle re-run, id for id) and records the outcome
// (app_finish_pack_reproduce: 154's rules, once per pack and engine).
//
// Never hanging: a part whose job stopped without its result fails the
// gathering, naming it (app_fail_pack_reproduce from the dead job's onDead,
// or the tick's sweep for a death no hook sees, 302), and the pack's page
// reads a gathering with a stopped part as failed in any case
// (stoppedPartsSql). A failed gathering is not an outcome: the page says the
// re-run couldn't be done, with why, and an editor may run it again.
import { randomUUID } from 'node:crypto';
import {
	BUNDLE_ZIP_LIMITS,
	bundlePartCheckId,
	bundlePartLabel,
	ENGINE_VERSION,
	foldPackBundleReruns,
	rerunPackBundlePart,
	type BundleCheck,
	type BundleCheckResult,
	type BundlePartResult,
	type BundleRerunPart
} from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { JobError } from '../jobs/errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { logEvent } from '../logging/logEvent.js';
import { getPackBundle } from '../reports/storage.js';
import { bundleHash } from './bundle.js';
import type { PackReproductionOutcome } from './packReproduce.js';

/** The `pack_reproduce_part` job's payload: its part, its gathering and its pack. */
export const PackReproducePartPayload = z.object({ packId: z.string().uuid(), gatheringId: z.string().uuid(), partId: z.string().uuid() }).strict();
export type PackReproducePartPayload = z.infer<typeof PackReproducePartPayload>;

/** Attempts per part (a store that can't be read is retried once). */
export const PACK_REPRODUCE_PART_ATTEMPTS = 2;

/**
 * Whether a check re-runs the model with this engine: each run and the
 * headline pair (`reproduce:<run>`, `reproduce:headline`), § 4's combined
 * row's assessment (`reproduce:combined`, `reproduce:dams`,
 * `reproduce:background`, bundle-3), and § 8's future
 * yield, every pair run again from the frozen factors (`climate:delta`,
 * evidence-23). On another engine than the runs' these are expected to differ.
 */
export const isRerunCheck = (id: string) => id.startsWith('reproduce:') || id === 'climate:delta';

/** What the outcome is called on the pack, from the engine's checks. */
export function reproductionOutcome(r: Pick<BundleCheckResult, 'ok' | 'checks' | 'engine'>): Exclude<PackReproductionOutcome, 'no_bundle'> {
	if (r.ok) return 'reproduced';
	// Only the re-runs differ, and some run was made with another engine than this one: expected to differ, not evidence of a fault.
	const failed = r.checks.filter((c) => !c.ok);
	const onlyReruns = failed.length > 0 && failed.every((c) => isRerunCheck(c.id));
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

/** Checks as pack_reproduction keeps them: each detail at most 2 000 characters. */
export const storedChecks = (checks: readonly BundleCheck[]) =>
	checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail.length > 2000 ? `${c.detail.slice(0, 1999)}…` : c.detail }));

/**
 * The parts of a gathering `ref` (a SQL expression) whose job stopped without
 * storing their result: dead, done without it, or purged. One line each, in
 * the plan's order, as `problem` (302 pack_reproduce_stopped_parts, the same lines).
 */
export const stoppedPartsSql = (ref: string) => `SELECT format('%s didn''t finish (%s)', p.label,
		CASE WHEN j.id IS NULL THEN 'its job was cleared' WHEN j.status = 'dead' THEN COALESCE(j.last_error, 'its job stopped') ELSE 'its job ended without storing it' END) AS problem,
		p.position
	FROM pack_reproduce_part p LEFT JOIN job j ON j.id = p.job_id
	WHERE p.gathering_id = ${ref} AND p.status = 'pending' AND (j.id IS NULL OR j.status IN ('dead', 'done'))`;

/**
 * Fan a pack's re-run out from its running `pack_reproduce` job: queue one
 * part job per part, as the transaction's user, and keep the plan's checks
 * until they are back (app_pack_reproduce_fan_out). Returns the gathering's id.
 */
export async function fanOutReproduction(
	db: Db,
	job: { id: string; projectId: string },
	pack: { id: string; bundleSha256: string },
	plan: { checks: readonly BundleCheck[]; runEngines: string[]; parts: readonly BundleRerunPart[] }
): Promise<string> {
	const gatheringId = randomUUID();
	const parts = [];
	for (const [position, part] of plan.parts.entries()) {
		const partId = randomUUID();
		const { job: queued } = await enqueueJob(db, {
			projectId: job.projectId,
			kind: 'pack_reproduce_part',
			payload: { packId: pack.id, gatheringId, partId },
			maxAttempts: PACK_REPRODUCE_PART_ATTEMPTS
		});
		parts.push({ id: partId, jobId: queued.id, position, part, label: bundlePartLabel(part) });
	}
	await db.query('SELECT app_pack_reproduce_fan_out($1, $2, $3, $4, $5, $6, $7, $8)', [
		pack.id,
		job.id,
		gatheringId,
		ENGINE_VERSION,
		plan.runEngines,
		pack.bundleSha256,
		JSON.stringify(storedChecks(plan.checks)),
		JSON.stringify(parts)
	]);
	return gatheringId;
}

interface PartRow {
	id: string;
	status: 'pending' | 'done';
	part: BundleRerunPart;
	gatheringStatus: string;
	engineVersion: string;
	bundleSha256: string;
	bundleKey: string | null;
}

/** The pack's bundle as stored, checked against the hash the gathering was planned on; throws a retryable JobError when the store can't be read. */
async function bundleOf(key: string | null, sha256: string): Promise<{ bytes: Uint8Array<ArrayBuffer> | null; check: BundleCheck }> {
	if (!key) return { bytes: null, check: storedBundleCheck(null, sha256) };
	let bytes: Uint8Array<ArrayBuffer> | null;
	try {
		bytes = await getPackBundle(key, BUNDLE_ZIP_LIMITS.maxTotalBytes);
	} catch (err) {
		console.error(`reading a pack bundle failed:`, (err as Error).message);
		throw new JobError('the reproduction bundle could not be read from storage (is object storage running? `pnpm dev:s3:up`)');
	}
	const check = storedBundleCheck(bytes && { sha256: bundleHash(bytes) }, sha256);
	return { bytes: check.ok ? bytes : null, check };
}

/**
 * The `pack_reproduce_part` job's work, as the editor whose re-run it is: its
 * part (of the job's own project, naming this job: a payload naming another
 * project's part, or another job's, does nothing), the bundle read and
 * checked against the gathering's hash, the part run, its result stored,
 * then the gather. Nothing to do when the part or its gathering is finished
 * or gone. On another engine than the gathering's it stops without a retry,
 * and the gathering fails naming it (onDead): one record never mixes two.
 */
export async function computeReproducePart(db: Db, job: { id: string; projectId: string }, payload: PackReproducePartPayload): Promise<void> {
	const { rows } = await db.query<PartRow>(
		`SELECT p.id, p.status, p.part, g.status AS "gatheringStatus", g.engine_version AS "engineVersion", g.bundle_sha256 AS "bundleSha256",
			e.bundle_key AS "bundleKey"
		 FROM pack_reproduce_part p JOIN pack_reproduce_gathering g ON g.id = p.gathering_id JOIN evidence_pack e ON e.id = g.pack_id
		 WHERE p.id = $1 AND p.gathering_id = $2 AND g.pack_id = $3 AND p.project_id = $4 AND p.job_id = $5`,
		[payload.partId, payload.gatheringId, payload.packId, job.projectId, job.id]
	);
	const row = rows[0];
	if (!row || row.status !== 'pending' || row.gatheringStatus !== 'gathering') return;
	if (row.engineVersion !== ENGINE_VERSION)
		throw new JobError(`the server’s engine changed from ${row.engineVersion} to ${ENGINE_VERSION} while the pack was re-run; re-run it again`, { retry: false });
	const { bytes, check } = await bundleOf(row.bundleKey, row.bundleSha256);
	const result: BundlePartResult = bytes
		? await rerunPackBundlePart(bytes, row.part, { hash: bundleHash, expectManifestSha256: await manifestSha256(db, payload.packId) })
		: { checks: [{ id: bundlePartCheckId(row.part), ok: false, detail: `not re-run: ${check.detail}` }] };
	await db.query('SELECT app_pack_reproduce_part_done($1, $2)', [row.id, JSON.stringify({ ...result, checks: storedChecks(result.checks) })]);
	await gatherReproduction(db, job.projectId, payload.gatheringId, bytes);
}

const manifestSha256 = async (db: Db, packId: string) =>
	(await db.query<{ sha: string }>('SELECT manifest_sha256 AS sha FROM evidence_pack WHERE id = $1', [packId])).rows[0]?.sha;

interface GatheringRow {
	packId: string;
	status: string;
	engineVersion: string;
	runEngines: string[];
	bundleSha256: string;
	checks: BundleCheck[];
	bundleKey: string | null;
	createdAt: Date;
}

/**
 * Gather a pack's re-run, holding its lock (so of two parts finishing at
 * once, the second sees the first's result): nothing while a part is still
 * out; failed, naming them, when a part stopped without its result;
 * otherwise the parts folded into the full re-run's checks and the outcome
 * recorded. From a running part job of the gathering (app_finish_pack_reproduce).
 */
export async function gatherReproduction(db: Db, projectId: string, gatheringId: string, bytes: Uint8Array<ArrayBuffer> | null = null): Promise<void> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('pack_reproduce_gather:' || $1::text, 0))`, [gatheringId]);
	const { rows: found } = await db.query<GatheringRow>(
		`SELECT g.pack_id AS "packId", g.status, g.engine_version AS "engineVersion", g.run_engines AS "runEngines", g.bundle_sha256 AS "bundleSha256",
			g.checks, e.bundle_key AS "bundleKey", g.created_at AS "createdAt"
		 FROM pack_reproduce_gathering g JOIN evidence_pack e ON e.id = g.pack_id WHERE g.project_id = $1 AND g.id = $2`,
		[projectId, gatheringId]
	);
	const g = found[0];
	if (!g || g.status !== 'gathering') return;
	const { rows: stopped } = await db.query<{ problem: string }>(`SELECT s.problem FROM (${stoppedPartsSql('$1')}) s ORDER BY s.position`, [gatheringId]);
	if (stopped.length) {
		await db.query('SELECT app_fail_pack_reproduce($1)', [gatheringId]);
		return;
	}
	const { rows: parts } = await db.query<{ status: string; part: BundleRerunPart; result: BundlePartResult | null }>(
		'SELECT status, part, result FROM pack_reproduce_part WHERE gathering_id = $1 ORDER BY position',
		[gatheringId]
	);
	if (parts.some((p) => p.status !== 'done' || !p.result)) return;
	// The planned checks, as stored: `stored` first (the job's), then the engine's.
	const [storedCheck, ...planned] = g.checks;
	const read = bytes ?? (await bundleOf(g.bundleKey, g.bundleSha256)).bytes;
	let checks: BundleCheck[];
	let ok: boolean;
	if (!read) {
		checks = [...g.checks.map((c) => (c.id === 'stored' ? { ...c, ok: false, detail: 'the stored bundle is no longer the one the re-run was planned on' } : c))];
		ok = false;
	} else {
		const folded = await foldPackBundleReruns(
			read,
			{ hash: bundleHash, expectManifestSha256: await manifestSha256(db, g.packId) },
			{ checks: planned, pack: null, engine: { here: ENGINE_VERSION, runs: g.runEngines }, headline: null, combined: null },
			parts.map((p) => ({ part: p.part, result: p.result! }))
		);
		checks = [...(storedCheck ? [storedCheck] : []), ...folded.checks];
		ok = folded.ok && (storedCheck?.ok ?? false);
	}
	const outcome = reproductionOutcome({ ok, checks, engine: { here: ENGINE_VERSION, runs: g.runEngines } });
	const { rows } = await db.query<{ recorded: boolean }>('SELECT app_finish_pack_reproduce($1, $2, $3) AS recorded', [
		gatheringId,
		outcome,
		JSON.stringify(storedChecks(checks))
	]);
	logEvent(outcome === 'reproduced' ? 'info' : 'warn', {
		event: 'pack_reproduced',
		packId: g.packId,
		projectId,
		outcome,
		engine: ENGINE_VERSION,
		failed: checks.filter((c) => !c.ok).map((c) => c.id).join(','),
		parts: parts.length,
		ms: Date.now() - g.createdAt.getTime(),
		recorded: rows[0]?.recorded ?? false
	});
}
