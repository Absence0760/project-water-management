// An evidence pack's reproduction bundle from the API's side (120_pack_bundle;
// docs/evidence-pack.md § Reproduction): read both runs' stored inputs and
// results, build the bundle (engine evidence/bundle.ts), check it, store it in
// the packs bucket and record it, all inside the issue route's transaction. If
// any step fails the transaction rolls back and the pack isn't issued, so an
// issued pack always has its bundle. The bundle is built from what is stored
// when the pack is issued, not later: a run's daily outputs follow their node
// (run_series.node_id cascades), so a later build could miss one.
//
// Reading runs the caller's RLS: the issuer is an editor, who reads both runs.
import { buildPackBundle, checkPackBundle, type PackBundleInput, type PackBundleRun, type PackManifest } from '@water-management/engine';
import { createHash } from 'node:crypto';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { packBundleKey, putPackBundle } from '../reports/storage.js';
import { loadRunInput, RunInputError } from '../runs/execute.js';

/** SHA-256 hex of a string (UTF-8) or bytes: the engine's BundleHash on the server. */
export const bundleHash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** One run as the bundle needs it: its stored row, its checked input values (loadRunInput) and its daily outputs. */
export async function loadBundleRun(db: Db, runId: string): Promise<PackBundleRun> {
	const { rows } = await db.query<Omit<PackBundleRun, 'runId' | 'values' | 'series'>>(
		'SELECT engine_version AS "engineVersion", start_date AS "startDate", inputs, summary FROM model_run WHERE id = $1',
		[runId]
	);
	const run = rows[0];
	if (!run) throw new ApiError(404, 'the pack’s runs are gone, or you can’t see them');
	let values: PackBundleRun['values'];
	try {
		const input = await loadRunInput(db, runId);
		values = Object.fromEntries(Object.entries(input.series).flatMap(([kind, s]) => (s ? [[kind, s.values]] : [])));
	} catch (err) {
		if (!(err instanceof RunInputError)) throw err;
		if (err.problem === 'not_found') throw new ApiError(404, 'the pack’s runs are gone, or you can’t see them');
		throw new ApiError(409, `this pack’s runs can’t be reproduced from their stored inputs, so it can’t be issued: ${err.message}`);
	}
	const { rows: series } = await db.query<PackBundleRun['series'][number]>(
		`SELECT node_id AS "nodeId", key, meta->>'label' AS label, "values" FROM run_series WHERE run_id = $1`,
		[runId]
	);
	return { runId, ...run, values, series };
}

/** What buildPackBundle needs for a pack: its stored manifest and both runs. */
export async function loadPackBundleInput(db: Db, pack: { baselineRunId: string; scenarioRunId: string | null }, manifest: PackManifest): Promise<PackBundleInput> {
	return {
		manifest,
		baseline: await loadBundleRun(db, pack.baselineRunId),
		application: pack.scenarioRunId ? await loadBundleRun(db, pack.scenarioRunId) : null
	};
}

/**
 * Build, check, store and record a pack's bundle, in the transaction that
 * issues it (app_record_pack_bundle refuses any other). The check is the one
 * `pnpm reproduce:pack --no-run` makes: every file, the manifest's hash, the
 * inputs and stored results against the manifest. Re-running both runs is
 * left to the reader (it takes as long as the runs). Returns the bundle's key
 * and SHA-256.
 */
export async function issuePackBundle(
	db: Db,
	projectId: string,
	pack: { id: string; manifestSha256: string; baselineRunId: string; scenarioRunId: string | null },
	manifest: PackManifest
): Promise<{ key: string; sha256: string }> {
	const built = await buildPackBundle(await loadPackBundleInput(db, pack, manifest), bundleHash);
	const check = await checkPackBundle(built.bytes, { hash: bundleHash, rerun: false, expectManifestSha256: pack.manifestSha256 });
	if (!check.ok) {
		const failed = check.checks.filter((k) => !k.ok).map((k) => `${k.id}: ${k.detail}`);
		throw new Error(`evidence pack ${pack.id}'s reproduction bundle fails its own check: ${failed.join('; ')}`);
	}
	const key = packBundleKey(projectId, pack.id, built.sha256);
	await putPackBundle(key, built.bytes, built.sha256);
	const { rows } = await db.query<{ key: string | null }>('SELECT app_record_pack_bundle($1, $2) AS key', [pack.id, built.sha256]);
	if (rows[0]?.key !== key) throw new Error(`evidence pack ${pack.id}'s bundle was recorded under ${String(rows[0]?.key)}, not the ${key} it was stored under`);
	return { key, sha256: built.sha256 };
}
