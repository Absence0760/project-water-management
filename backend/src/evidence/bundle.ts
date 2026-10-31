// An evidence pack's reproduction bundle from the API's side (122_pack_bundle;
// docs/evidence-pack.md § Reproduction): read both runs' stored inputs and
// results, build the bundle (engine evidence/bundle.ts), check it, store it in
// the packs bucket and record it, all inside the issue route's transaction. If
// any step fails the transaction rolls back and the pack isn't issued, so an
// issued pack always has its bundle. The bundle is built from what is stored
// when the pack is issued, not later: a run's daily outputs follow their node
// (run_series.node_id cascades), so a later build could miss one.
//
// Reading runs the caller's RLS: the issuer is an editor, who reads both runs.
//
// From bundle-3 the bundle also carries the cumulative assessment § 4's
// combined row cites (loadBundleAssessment): its members, its stored report
// and its background run's inputs, so `pnpm reproduce:pack` and the
// pack_reproduce job re-run that row too. An assessment is an editor's (145),
// as the issuer is.
import {
	assessedAlternatives,
	buildPackBundle,
	checkPackBundle,
	citedAssessment,
	type BundleAssessmentMember,
	type BundleAssessmentReport,
	type PackBundleAssessment,
	type PackBundleBackgroundRun,
	type PackBundleInput,
	type PackBundleRun,
	type PackManifest
} from '@water-management/engine';
import { createHash } from 'node:crypto';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { packBundleKey, putPackBundle } from '../reports/storage.js';
import { loadRunInput, RunInputError } from '../runs/execute.js';

/** SHA-256 hex of a string (UTF-8) or bytes: the engine's BundleHash on the server. */
export const bundleHash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** A run's checked input values (loadRunInput), by kind: 404 when it's gone, 409 when its inputs can't be rebuilt. */
async function runValues(db: Db, runId: string, what: string): Promise<PackBundleRun['values']> {
	try {
		const input = await loadRunInput(db, runId);
		return Object.fromEntries(Object.entries(input.series).flatMap(([kind, s]) => (s ? [[kind, s.values]] : [])));
	} catch (err) {
		if (!(err instanceof RunInputError)) throw err;
		if (err.problem === 'not_found') throw new ApiError(404, `${what} gone, or you can’t see them`);
		throw new ApiError(409, `${what} can’t be reproduced from their stored inputs, so it can’t be issued: ${err.message}`);
	}
}

/** One run as the bundle needs it: its stored row, its checked input values (loadRunInput) and its daily outputs. */
export async function loadBundleRun(db: Db, runId: string): Promise<PackBundleRun> {
	const { rows } = await db.query<Omit<PackBundleRun, 'runId' | 'values' | 'series'>>(
		'SELECT engine_version AS "engineVersion", start_date AS "startDate", inputs, summary FROM model_run WHERE id = $1',
		[runId]
	);
	const run = rows[0];
	if (!run) throw new ApiError(404, 'the pack’s runs are gone, or you can’t see them');
	const values = await runValues(db, runId, 'the pack’s runs are');
	const { rows: series } = await db.query<PackBundleRun['series'][number]>(
		`SELECT node_id AS "nodeId", key, meta->>'label' AS label, "values" FROM run_series WHERE run_id = $1`,
		[runId]
	);
	return { runId, ...run, values, series };
}

/**
 * The cumulative assessment the manifest's combined row cites (bundle-3), as
 * the issuer reads it (RLS: an editor's): its members in the order it ran
 * them, with the ops each counted with and the id its runs took it under,
 * its stored report, and its background run's stored inputs. Null when the
 * row cites none. 409 when it is gone (kept to the project's newest, and
 * deleted with its base or background run): the bundle couldn't re-run the
 * row the manifest prints, so the pack is drafted again, which reads what
 * there is now.
 */
export async function loadBundleAssessment(db: Db, pack: { baselineRunId: string }, manifest: PackManifest): Promise<PackBundleAssessment | null> {
	const cited = citedAssessment(manifest);
	if (!cited) return null;
	const { rows } = await db.query<{ name: string; engineVersion: string | null; baseRunId: string; backgroundRunId: string | null; status: string; report: BundleAssessmentReport | null }>(
		`SELECT name, engine_version AS "engineVersion", base_run_id AS "baseRunId", background_run_id AS "backgroundRunId", status, report
		 FROM assessment WHERE id = $1`,
		[cited.id]
	);
	const a = rows[0];
	if (!a || a.status !== 'complete' || !a.report || a.baseRunId !== pack.baselineRunId)
		throw new ApiError(409, 'the cumulative assessment this pack’s combined row reads is gone, so its bundle couldn’t re-run that row: draft the pack again, which reads the assessments there are now');
	const { rows: members } = await db.query<BundleAssessmentMember>(
		`SELECT COALESCE(scenario_id, id)::text AS id, scenario_id AS "scenarioId", name, origin, ops, ops_sha256 AS "opsSha256", owned_node_ids::text[] AS "ownedNodeIds"
		 FROM assessment_member WHERE assessment_id = $1 ORDER BY position`,
		[cited.id]
	);
	let background: PackBundleBackgroundRun | null = null;
	if (a.backgroundRunId) {
		const { rows: bg } = await db.query<{ inputs: PackBundleBackgroundRun['inputs'] }>('SELECT inputs FROM model_run WHERE id = $1', [a.backgroundRunId]);
		if (!bg[0]) throw new ApiError(404, 'the assessment’s background run is gone, or you can’t see it');
		background = { runId: a.backgroundRunId, inputs: bg[0].inputs, values: await runValues(db, a.backgroundRunId, 'the assessment’s background run’s inputs are') };
	}
	return { id: cited.id, name: a.name, engineVersion: a.engineVersion, baseRunId: a.baseRunId, backgroundRunId: a.backgroundRunId, members, report: a.report, background };
}

/** The runs of the alternatives page 1 assesses, one at a time on the transaction's client. */
async function alternativeRuns(db: Db, manifest: PackManifest): Promise<PackBundleRun[]> {
	const out: PackBundleRun[] = [];
	for (const a of assessedAlternatives(manifest)) out.push(await loadBundleRun(db, a.runId));
	return out;
}

/** What buildPackBundle needs for a pack: its stored manifest, both runs, the assessment its combined row cites, and the alternatives' runs. */
export async function loadPackBundleInput(db: Db, pack: { baselineRunId: string; scenarioRunId: string | null }, manifest: PackManifest): Promise<PackBundleInput> {
	return {
		manifest,
		baseline: await loadBundleRun(db, pack.baselineRunId),
		application: pack.scenarioRunId ? await loadBundleRun(db, pack.scenarioRunId) : null,
		assessment: await loadBundleAssessment(db, pack, manifest),
		// The alternatives page 1 assesses (bundle-3, evidence-26), each a run of its own, in the manifest's order.
		alternatives: await alternativeRuns(db, manifest)
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
