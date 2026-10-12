// Page 1's licence impact board against full authorised use (licensing build
// item 8; provisional position, pre-counsel research, 2026-10-01; engine
// evidence/authorised.ts; docs/model.md §2.14a, docs/evidence-pack.md § Both
// impact bases; 165_applicant_copy section 5).
//
// The first board judges an application against its baseline as it ran:
// "existing use" is what the model found holders use. This one runs the pair
// again with every holder at their registered volume
// (settings.allocationMode `fullAllocation`, the baseline's stored input and
// the application's recorded ops on it) and judges the application against
// that, the protective basis for existing and potential users (NWA s27(1)(a),
// (f), s29(1)(a)(iii); R267 "cumulative impact"). Two model runs: an editor
// asks for them (POST …/runs/:runId/authorised-impact, synchronous, as a
// scenario run is), and the board the engine builds is kept in
// authorised_impact; the evidence report reads the newest for its
// application run (loadAuthorisedImpact), or says why there is none. The
// pair's runs aren't stored as runs (nothing in the run list, no run cap), so
// the board records how to re-derive them and what they give (`reproduction`,
// engine evidence/authorisedPair.ts, issue #523 G2): both results digests, the
// outcome settings, and how each registered volume was held as at the
// baseline run (226), which a pack's reproduction bundle re-runs and checks.
//
//  POST /projects/:id/runs/:runId/authorised-impact   editor
import {
	authorisedMix,
	AUTHORISED_PAIR_VERSION,
	authorisedPairBoard,
	authorisedPairInputs,
	authorisedTakes,
	atFullAllocation,
	foldedMix,
	authorisedUnavailable,
	ENGINE_VERSION,
	freshResultsDigest,
	pairKinds,
	runModelChecked,
	RUN_RESULTS_VERSION,
	sameModelInput,
	type AuthorisedPairRecord,
	type EvidenceAuthorisedImpact,
	type ModelInput,
	type ModelOutput,
	type ScenarioOp,
	type YearClassMethod
} from '@water-management/engine';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { resolveOutcomes } from '../projects/outcomeSettings.js';
import { checkScenario, loadBaseInput, type ScenarioOrigin } from '../scenarios/execute.js';
import { allocationHolderKeys, allocationKindsAsAtRun } from '../allocations/holders.js';
import { bundleHash } from './bundle.js';
import { z } from 'zod';

/** The registered volumes a full-allocation run of `input` holds holders to: those that take (not s21b storage only). */
const takes = authorisedTakes;

/** The engine's own words, or a plain line: never DB text. */
function engineRun(input: ModelInput, which: string): ModelOutput {
	try {
		return runModelChecked(input);
	} catch (err) {
		throw new ApiError(409, `the full-allocation ${which} couldn’t be run: ${(err as Error).message}`);
	}
}

/**
 * Run the full-allocation pair of an application run and build its board, as
 * the caller (an editor: the base input is the stored run's). Stores it,
 * replacing the run's older boards, and returns it.
 */
export async function buildAuthorisedImpact(db: Db, projectId: string, runId: string): Promise<EvidenceAuthorisedImpact> {
	if (!UUID.test(runId)) throw notFound();
	const { rows } = await db.query<{ scenario: { id: string; baseRunId: string; ops: ScenarioOp[]; opsSha256?: string; ownedNodeIds?: string[] } | null }>(
		`SELECT inputs->'scenario' AS scenario FROM model_run WHERE project_id = $1 AND id = $2`,
		[projectId, runId]
	);
	if (!rows[0]) throw notFound();
	const recorded = rows[0].scenario;
	if (!recorded) throw new ApiError(409, 'the board against full authorised use is for an application run: this run is the model’s own');
	const { rows: baseRows } = await db.query<{ engineVersion: string }>('SELECT engine_version AS "engineVersion" FROM model_run WHERE project_id = $1 AND id = $2', [
		projectId,
		recorded.baseRunId
	]);
	if (!baseRows[0]) throw new ApiError(409, 'the application’s base run is gone, or you can’t see it');
	// One engine for the report: a pair run now must be on the baseline's engine, as a cumulative assessment must.
	if (baseRows[0].engineVersion !== ENGINE_VERSION)
		throw new ApiError(
			409,
			`the baseline ran on engine ${baseRows[0].engineVersion}, and a pair runs now on engine ${ENGINE_VERSION}, so its board wouldn’t be the report’s: run the baseline again on engine ${ENGINE_VERSION} and the application on it`
		);
	const base = await loadBaseInput(db, projectId, recorded.baseRunId, 'editor');
	if (!takes(base).length) throw new ApiError(409, 'the baseline ran with no registered or licensed volumes (Allocations), so there is no authorised use to hold holders to');

	const { rows: sc } = await db.query<{ origin: ScenarioOrigin }>('SELECT origin FROM scenario WHERE project_id = $1 AND id = $2', [projectId, recorded.id]);
	const origin: ScenarioOrigin = sc[0]?.origin ?? 'team';
	const full: ModelInput = atFullAllocation(base);
	const check = checkScenario(full, { ops: recorded.ops, ownedNodeIds: recorded.ownedNodeIds ?? [], origin });
	if (check.problems.length)
		throw new ApiError(409, 'the application’s changes don’t all apply to the baseline at full allocation', { problems: check.assessorProblems });
	// The pair must be the one an assessor re-derives from the pack's bundle (engine authorisedPairInputs: the ops applied
	// with nothing masked). An applicant's ops are checked in their namespace (checkScenario's mask), which gives another
	// input only when an op meets hidden data (a new item under a hidden one's id or name): such a board couldn't be
	// reproduced, so it isn't built (#523 G2).
	const pair = authorisedPairInputs(base, recorded.ops);
	if (pair.problems.length || !sameModelInput(pair.application, check.input))
		throw new ApiError(
			409,
			'the application’s changes meet data its applicant can’t see, so the pair at full allocation couldn’t be re-derived from the pack’s bundle: change the application so its new items don’t reuse a hidden one’s name or id'
		);
	const background = engineRun(pair.baseline, 'baseline');
	const application = engineRun(pair.application, 'application');

	const { rows: settings } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const outcomes = resolveOutcomes(settings[0]?.settings);
	const board = authorisedPairBoard(full, background, application, { yearClassMethod: outcomes.yearClassMethod, siteNodeId: outcomes.siteNodeId });
	// How the volumes it held holders to are held (licence, verified ELU, registration, …), as at the baseline run: the
	// authorisation frozen with it (226, #523 G2), not the allocation rows as they are now.
	const allocations = takes(full);
	// Who held each when the baseline ran (219's keys frozen with the run, counted as app_allocation_volumes counts
	// holders: the name, normalised; else another row's on the same unit; else the unit; else the row; a row no living
	// holder had, one shared key). The folded mix gives no line of fewer
	// than 5 holders' volume, and only as shares (evidence-18, #523 G1/H/J).
	const kindOf = await allocationKindsAsAtRun(db, projectId, recorded.baseRunId, allocations);
	const holders = await allocationHolderKeys(db, projectId, recorded.baseRunId, allocations);
	const entries = allocations.map((a) => ({
		volumeM3PerYear: a.volumeM3PerYear,
		waterUse: a.waterUse ?? null,
		authorisation: kindOf[a.id] ?? null,
		holder: holders[a.id]!,
		waterSource: a.waterSource
	}));
	// Both frozen: the full mix for editors, owners, the authority and the PDF; the folded shares (no m³, evidence-18) for
	// a viewer kept from each registered volume (allocations/viewerUnits.ts redactReportAllocations).
	const mix = authorisedMix(entries);
	const mixFolded = foldedMix(entries);
	const builtAt = new Date().toISOString();
	// What re-deriving the pair needs and must give (evidence-19): a pack's bundle re-runs it and checks these.
	const reproduction: AuthorisedPairRecord = {
		version: AUTHORISED_PAIR_VERSION,
		resultsVersion: RUN_RESULTS_VERSION,
		allocationMode: 'fullAllocation',
		opsSha256: recorded.opsSha256 ?? null,
		baselineResultsSha256: await freshResultsDigest(background, bundleHash),
		applicationResultsSha256: await freshResultsDigest(application, bundleHash),
		yearClassMethod: outcomes.yearClassMethod,
		siteNodeId: outcomes.siteNodeId,
		kinds: pairKinds(full, (id) => kindOf[id])
	};
	const result: EvidenceAuthorisedImpact = { status: 'ok', detail: null, board, mix, mixFolded, builtAt, engineVersion: ENGINE_VERSION, reproduction };

	// Newest wins: the run's older boards go (on any engine or settings), so one row per run is kept.
	await db.query('DELETE FROM authorised_impact WHERE project_id = $1 AND application_run_id = $2', [projectId, runId]);
	await db.query(
		`INSERT INTO authorised_impact (project_id, application_run_id, base_run_id, engine_version, year_class_method, reserve_site, result)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
		[projectId, runId, recorded.baseRunId, ENGINE_VERSION, outcomes.yearClassMethod, outcomes.siteNodeId, JSON.stringify(result)]
	);
	return result;
}

/**
 * The full-authorised-use board for an application run's evidence report,
 * under the reader's RLS: the stored one when it was run on the baseline's
 * engine with the project's outcome settings as they are now; else why not
 * (a fixed row on page 1, never left out).
 */
export async function loadAuthorisedImpact(
	db: Db,
	projectId: string,
	applicationRunId: string,
	o: { baselineEngine: string; yearClassMethod: YearClassMethod; siteNodeId: string | null; baselineInput: ModelInput }
): Promise<EvidenceAuthorisedImpact> {
	if (!takes(o.baselineInput).length) return authorisedUnavailable('noAllocations');
	const { rows } = await db.query<{ engineVersion: string; yearClassMethod: string; siteNodeId: string | null; result: EvidenceAuthorisedImpact; createdAt: Date }>(
		`SELECT engine_version AS "engineVersion", year_class_method AS "yearClassMethod", reserve_site AS "siteNodeId", result, created_at AS "createdAt"
		 FROM authorised_impact WHERE project_id = $1 AND application_run_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
		[projectId, applicationRunId]
	);
	const hit = rows[0];
	if (!hit) return authorisedUnavailable('notBuilt');
	const built = { builtAt: hit.createdAt.toISOString(), engineVersion: hit.engineVersion };
	if (hit.engineVersion !== o.baselineEngine)
		return authorisedUnavailable('stale', `it was run on engine ${hit.engineVersion}, but the baseline ran on engine ${o.baselineEngine}: run it again`, built);
	if (hit.yearClassMethod !== o.yearClassMethod || (hit.siteNodeId ?? null) !== o.siteNodeId)
		return authorisedUnavailable('stale', 'it was run with other outcome settings (how years are classed, or the Reserve site) than the project has now: run it again', built);
	// A board built before evidence-19 records neither its pair's digests nor the mix as at the baseline, so a pack's bundle couldn't re-run it (#523 G2).
	if (hit.result.status === 'ok' && !hit.result.reproduction)
		return authorisedUnavailable('stale', 'it was run before its pair of runs was recorded for reproduction, and its mix read the allocations as they were then: run it again', built);
	return hit.result;
}

export const authorisedImpactRoutes = new Hono<AuthEnv>().post('/:id/runs/:runId/authorised-impact', async (c) => {
	const { id, runId } = c.req.param();
	z.object({}).strict().parse((await readJson(c, { optional: true })) ?? {});
	return withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'editor');
		return c.json({ authorised: await buildAuthorisedImpact(db, id, runId) });
	});
});
