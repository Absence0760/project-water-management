// The licensing evidence report's data (issue #71, docs/evidence-report.md,
// docs/api.md § Evidence report): everything the engine's evidenceReport()
// needs, read in one withUser transaction so RLS decides what the reader
// sees, then built by the engine. One run names the report: an application
// run (a scenario run, whose recorded base run is the baseline) or, for
// baseline evidence, the run itself.
//
// Viewers and up read it, as they read compare: it names every farm (Step 3
// D2's anonymising is for what an applicant holds, ER10). Contributors and
// farmers get 403 from requireRole.
import {
	DISCLAIMER,
	diffInputs,
	ENGINE_ERRATA,
	ENGINE_VERSION,
	evidenceReport,
	KNOWN_LIMITATIONS,
	METHODOLOGY,
	summarisePaired,
	withLocalitySvgHash,
	type EnsembleHeader,
	type EnsembleSummary,
	type CumulativeReport,
	type EvidenceCombinedInput,
	type EvidenceEnsembleInput,
	type EvidenceImpactInput,
	type EvidenceInput,
	type EvidenceMapFeatureInput,
	type EvidenceReport,
	type EvidenceRunInput,
	type MemberResult,
	type PairedMember,
	type ResolvedEnsembleOptions,
	type RunInputsSnapshot,
	type RunSummary,
	type ScenarioOp
} from '@water-management/engine';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { runAllocationComparison } from '../allocations/runUse.js';
import { checkCombination } from '../assessments/store.js';
import { ASSESSMENT_SCENARIOS_MAX } from '../assessments/schema.js';
import type { AuthEnv } from '../auth/middleware.js';
import { differingKinds, storedValues } from '../compare/routes.js';
import { type Db, withUser } from '../db/tx.js';
import { revisionsBetween } from '../history/routes.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { projectAuthority } from '../projects/authoritySettings.js';
import { resolveOutcomes } from '../projects/outcomeSettings.js';
import type { RunScenarioSnapshot } from '../runs/execute.js';
import { loadBaseInput, type ScenarioOrigin } from '../scenarios/execute.js';
import { listNominations } from '../runs/evidence.js';

/** Most other application runs the ledger lists (newest first). */
export const APPLICATION_RUNS_MAX = 50;

const iso = (d: string | Date | null): string | null => (d === null ? null : new Date(d).toISOString());

interface RunRow {
	id: string;
	label: string | null;
	engineVersion: string;
	runoffModel: string;
	startDate: string;
	endDate: string;
	createdAt: Date;
	createdBy: string | null;
	trigger: string;
	summary: RunSummary;
	inputs: RunInputsSnapshot & { scenario?: RunScenarioSnapshot };
	notes: string | null;
	notesUpdatedAt: Date | null;
	notesUpdatedBy: string | null;
}

async function loadRun(db: Db, projectId: string, runId: string): Promise<RunRow | null> {
	if (!UUID.test(runId)) return null;
	const { rows } = await db.query<RunRow>(
		`SELECT r.id, r.label, r.engine_version AS "engineVersion",
			COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') AS "runoffModel",
			to_char(r.start_date, 'YYYY-MM-DD') AS "startDate", to_char(r.end_date, 'YYYY-MM-DD') AS "endDate",
			r.created_at AS "createdAt", u.display_name AS "createdBy", r."trigger", r.summary, r.inputs,
			r.notes, r.notes_updated_at AS "notesUpdatedAt", nu.display_name AS "notesUpdatedBy"
		 FROM model_run r
		 LEFT JOIN app_user u ON u.id = r.created_by
		 LEFT JOIN app_user nu ON nu.id = r.notes_updated_by
		 WHERE r.project_id = $1 AND r.id = $2`,
		[projectId, runId]
	);
	return rows[0] ?? null;
}

function runInput(r: RunRow): EvidenceRunInput {
	const { scenario: _scenario, ...inputs } = r.inputs;
	void _scenario;
	return {
		id: r.id,
		label: r.label ?? '',
		engineVersion: r.engineVersion,
		runoffModel: r.runoffModel,
		startDate: r.startDate,
		endDate: r.endDate,
		createdAt: iso(r.createdAt)!,
		createdBy: r.createdBy,
		trigger: r.trigger,
		summary: r.summary,
		inputs: inputs as RunInputsSnapshot,
		notes: r.notes ?? '',
		notesUpdatedAt: iso(r.notesUpdatedAt),
		notesUpdatedBy: r.notesUpdatedBy
	};
}

/**
 * § 5 (registered water use): the run's modelled use against the allocations
 * it ran with, per unit and water year. Only what the run stored: its
 * allocations carry no holder name (D3), so a viewer reads nothing here the
 * Allocations tab wouldn't show them.
 */
async function withAllocations(db: Db, run: EvidenceRunInput): Promise<EvidenceRunInput> {
	const forecastFrom = run.summary.forecast?.from ?? null;
	return { ...run, allocations: await runAllocationComparison(db, { id: run.id, startDate: run.startDate, forecastFrom, inputs: run.inputs }) };
}

interface EnsembleRow {
	id: string;
	runId: string;
	baselineId: string | null;
	status: 'started' | 'complete';
	seed: number;
	members: number;
	options: ResolvedEnsembleOptions;
	createdAt: Date;
	createdBy: string | null;
	completedAt: Date | null;
	accepted: number | null;
	summary: unknown;
}

const ENSEMBLE_COLUMNS = `u.id, u.run_id AS "runId", u.baseline_id AS "baselineId", u.status, u.seed::int AS seed, u.members, u.options,
	u.created_at AS "createdAt", au.display_name AS "createdBy", u.completed_at AS "completedAt", u.accepted, u.summary`;

/**
 * Every ensemble on the baseline run, and every paired one on the
 * application whose baseline is one of them. A paired row's bands are
 * recomputed from both rows' stored members (summarisePaired), so a band
 * stored before a summary field existed (the Reserve's "worse in", ER4)
 * carries it too; the members themselves were verified when stored. A
 * measure the members don't carry (no-flow days, EWR days per site, supply
 * per unit and the Reserve FDC on members stored before engine 1.33.0)
 * comes out as a band of no pairs, which the report prints as "no band".
 */
async function loadEnsembles(
	db: Db,
	projectId: string,
	baselineRunId: string,
	applicationRunId: string | null,
	/** The application's own units: its paired band on the applicant's own supply (page 1, ER4). */
	own: readonly string[] = []
): Promise<EvidenceInput['ensembles']> {
	const { rows: base } = await db.query<EnsembleRow>(
		`SELECT ${ENSEMBLE_COLUMNS} FROM run_uncertainty u LEFT JOIN app_user au ON au.id = u.created_by
		 WHERE u.project_id = $1 AND u.run_id = $2 AND u.baseline_id IS NULL ORDER BY u.created_at DESC, u.id`,
		[projectId, baselineRunId]
	);
	const toInput = (r: EnsembleRow, summary: EnsembleSummary | null, paired: EvidenceEnsembleInput['paired']): EvidenceEnsembleInput => ({
		id: r.id,
		runId: r.runId,
		baselineId: r.baselineId,
		status: r.status,
		seed: r.seed,
		members: r.members,
		options: r.options,
		createdAt: iso(r.createdAt)!,
		createdBy: r.createdBy,
		completedAt: iso(r.completedAt),
		accepted: r.accepted,
		summary,
		paired
	});
	const baseline = base.map((r) => toInput(r, r.status === 'complete' ? (r.summary as EnsembleSummary) : null, null));
	if (!applicationRunId) return { baseline, paired: [] };
	const { rows: pairedRows } = await db.query<EnsembleRow & { result: { header: EnsembleHeader; members: PairedMember[] } | null }>(
		`SELECT ${ENSEMBLE_COLUMNS}, u.result FROM run_uncertainty u LEFT JOIN app_user au ON au.id = u.created_by
		 WHERE u.project_id = $1 AND u.run_id = $2 AND u.baseline_id = ANY($3::uuid[]) ORDER BY u.created_at DESC, u.id`,
		[projectId, applicationRunId, base.map((r) => r.id)]
	);
	const needed = [...new Set(pairedRows.filter((p) => p.status === 'complete' && p.result).map((p) => p.baselineId!))];
	const results = new Map<string, { header: EnsembleHeader; members: MemberResult[] }>();
	if (needed.length) {
		const { rows } = await db.query<{ id: string; result: { header: EnsembleHeader; members: MemberResult[] } }>(
			'SELECT id, result FROM run_uncertainty WHERE project_id = $1 AND id = ANY($2::uuid[]) AND result IS NOT NULL',
			[projectId, needed]
		);
		for (const r of rows) results.set(r.id, r.result);
	}
	const paired = pairedRows.map((p) => {
		const b = p.baselineId ? results.get(p.baselineId) : undefined;
		const summary = p.status === 'complete' && p.result && b ? summarisePaired({ options: p.options, header: b.header, members: b.members }, p.result, { own }) : null;
		return toInput(p, null, summary);
	});
	return { baseline, paired };
}

/** The newest endorsement of any publication of the baseline run by the responsible authority (161; evidence-12), or null. */
async function loadEndorsement(db: Db, projectId: string, runId: string): Promise<EvidenceInput['baselineEndorsement']> {
	const { rows } = await db.query<{ endorsedAt: Date; endorsedBy: string | null; note: string }>(
		`SELECT p.endorsed_at AS "endorsedAt", u.display_name AS "endorsedBy", p.endorsement_note AS note
		 FROM run_publication p LEFT JOIN app_user u ON u.id = p.endorsed_by
		 WHERE p.project_id = $1 AND p.run_id = $2 AND p.endorsed_at IS NOT NULL
		 ORDER BY p.endorsed_at DESC, p.id DESC LIMIT 1`,
		[projectId, runId]
	);
	return rows[0] ? { endorsedAt: iso(rows[0].endorsedAt)!, endorsedBy: rows[0].endorsedBy, note: rows[0].note } : null;
}

async function loadPublications(db: Db, projectId: string, baseline: RunRow): Promise<Pick<EvidenceInput, 'publication' | 'history'>> {
	const { rows } = await db.query<{ runId: string; publishedAt: Date; publishedBy: string | null; current: boolean; runCreatedAt: Date }>(
		`SELECT p.run_id AS "runId", p.published_at AS "publishedAt", u.display_name AS "publishedBy", p.superseded_at IS NULL AS current,
			r.created_at AS "runCreatedAt"
		 FROM run_publication p
		 JOIN model_run r ON r.id = p.run_id
		 LEFT JOIN app_user u ON u.id = p.published_by
		 WHERE p.project_id = $1
		 ORDER BY p.published_at DESC, p.id DESC`,
		[projectId]
	);
	const pub = (r: (typeof rows)[number]) => ({ runId: r.runId, publishedAt: iso(r.publishedAt)!, publishedBy: r.publishedBy });
	const current = rows.find((r) => r.current) ?? null;
	const currentIdx = current ? rows.indexOf(current) : -1;
	// The publication the baseline's history is read from: the newest of another run made before the baseline.
	const since = rows.find((r) => r.runId !== baseline.id && r.runCreatedAt.getTime() < baseline.createdAt.getTime()) ?? null;
	let history: EvidenceInput['history'] = null;
	if (since) {
		const { revisions, truncated } = await revisionsBetween(db, projectId, since.runId, baseline.id);
		history = {
			since: pub(since),
			revisions: revisions.map((r) => ({ createdAt: iso(r.createdAt)!, actor: r.actor, reason: r.reason, changes: r.changes })),
			truncated
		};
	}
	return {
		publication: { current: current ? pub(current) : null, previous: currentIdx >= 0 && rows[currentIdx + 1] ? pub(rows[currentIdx + 1]!) : null },
		history
	};
}

/**
 * § 4's cumulative table: every other scenario on the baseline that is
 * submitted, or decided with a licence issued, with its newest run of its current
 * ops (the ops' hash the run recorded equals the scenario's) on this
 * baseline. Under the reader's RLS: the scenario and run policies decide
 * which applications appear (a submitted application to the project's
 * editors, a draft to its applicant only), so the report never names one the
 * reader couldn't open. The newest 50, and whether there were more. Only the two measures the table reads leave the
 * database, not the runs' summaries.
 */
async function loadOtherApplications(db: Db, projectId: string, baselineRunId: string, ownScenarioId: string | null): Promise<Pick<EvidenceInput, 'otherApplications' | 'otherApplicationsTruncated'>> {
	const { rows } = await db.query<{
		scenarioId: string;
		scenarioName: string;
		status: 'submitted' | 'decided';
		outcome: string | null;
		runId: string;
		runCreatedAt: Date;
		engineVersion: string;
		runoffModel: string;
		startDate: string;
		endDate: string;
		ewrDaysNotMet: number | null;
		reserveOutlet: { months: number; met: number; rate: number | null } | null;
	}>(
		`SELECT * FROM (SELECT DISTINCT ON (s.id) s.id AS "scenarioId", s.name AS "scenarioName", s.status, s.outcome,
			r.id AS "runId", r.created_at AS "runCreatedAt", r.engine_version AS "engineVersion",
			COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') AS "runoffModel",
			to_char(r.start_date, 'YYYY-MM-DD') AS "startDate", to_char(r.end_date, 'YYYY-MM-DD') AS "endDate",
			(r.summary->'catchment'->>'ewrDaysNotMet')::float8 AS "ewrDaysNotMet",
			jsonb_path_query_first(r.summary, '$.ewrAssurance[*] ? (@.isOutlet == true).overall') AS "reserveOutlet"
		 FROM scenario s
		 JOIN model_run r ON r.scenario_id = s.id AND r.project_id = s.project_id
		 WHERE s.project_id = $1
			AND ($3::uuid IS NULL OR s.id <> $3::uuid)
			AND (s.status = 'submitted' OR (s.status = 'decided' AND s.outcome = 'licence_issued'))
			AND r.inputs->'scenario'->>'baseRunId' = $2
			AND r.inputs->'scenario'->>'opsSha256' = s.ops_sha256
		 ORDER BY s.id, r.created_at DESC, r.id) newest
		 ORDER BY "runCreatedAt" DESC, "scenarioId"
		 LIMIT $4`,
		[projectId, baselineRunId, ownScenarioId, APPLICATION_RUNS_MAX + 1]
	);
	// One more than the cap is read, so a cut list says so rather than summing part of it silently.
	const truncated = rows.length > APPLICATION_RUNS_MAX;
	const otherApplications = rows.slice(0, APPLICATION_RUNS_MAX).map((r) => ({
		...r,
		runCreatedAt: iso(r.runCreatedAt)!,
		reserveOutlet: r.reserveOutlet ? { months: r.reserveOutlet.months, met: r.reserveOutlet.met, rate: r.reserveOutlet.rate } : null
	}));
	return { otherApplications, otherApplicationsTruncated: truncated };
}

/** This report's own application, as the combination takes it: the ops its run recorded. */
interface OwnApplication {
	id: string;
	name: string;
	origin: ScenarioOrigin;
	/** The scenario's status now; null once it is deleted. */
	status: string | null;
	ops: ScenarioOp[];
	opsSha256: string;
	ownedNodeIds: string[];
}

/**
 * Page 1's combined row (evidence-11, finding C26, WP-3.11): every other
 * application the reader can see that is submitted, or decided with a licence
 * issued, and based on this baseline, put together with this one.
 *
 * The figure is read from a completed cumulative assessment of exactly these
 * applications with these ops on this baseline (assessments/, which ran the
 * baseline, each alone and all together on one engine), not run here: a
 * combination is up to ASSESSMENT_SCENARIOS_MAX + 2 model runs, which a
 * report request (a viewer's GET, a pack draft) must not carry. With no such
 * assessment the combination is still checked here (checkCombination, pure,
 * no model run), so a conflict is named whether or not anyone asked for an
 * assessment; a matching complete assessment already passed that check on
 * the same base and ops. Under the reader's RLS: an assessment is an
 * editor's, so a viewer's report finds none.
 *
 * Only an assessment made on the baseline run's engine counts (operator
 * decision, 2026-10-01), so the row's baseline figure is the report's own
 * baseline. One made on another engine is named with why it isn't read
 * (`staleAssessment`); and when this server runs another engine than the
 * baseline's, no new assessment can match either, so the row says to run the
 * baseline again.
 */
export function staleAssessment(assessedOn: string | null, baselineEngine: string, serverEngine: string = ENGINE_VERSION): string | null {
	const was = assessedOn ? `they were assessed together on engine ${assessedOn}, but the baseline ran on engine ${baselineEngine}` : null;
	if (baselineEngine !== serverEngine)
		return `${was ? `${was}, and` : `the baseline ran on engine ${baselineEngine}, and`} an assessment now runs on engine ${serverEngine}, so none made now would match the report’s baseline: run the baseline again on engine ${serverEngine} and assess the applications on that run.`;
	return was ? `${was}, so its baseline figure isn’t this report’s: assess them together again.` : null;
}

async function loadCombined(
	db: Db,
	projectId: string,
	baselineRunId: string,
	baselineEngine: string,
	own: OwnApplication | null
): Promise<EvidenceCombinedInput> {
	const none: EvidenceCombinedInput = { others: [], unavailable: null, conflicts: [], problems: [], assessment: null, pending: false };
	const { rows: others } = await db.query<{ scenarioId: string; scenarioName: string; status: 'submitted' | 'decided'; outcome: string | null; opsSha256: string }>(
		`SELECT s.id AS "scenarioId", s.name AS "scenarioName", s.status, s.outcome, s.ops_sha256 AS "opsSha256"
		 FROM scenario s
		 WHERE s.project_id = $1 AND s.base_run_id = $2 AND ($3::uuid IS NULL OR s.id <> $3::uuid)
			AND (s.status = 'submitted' OR (s.status = 'decided' AND s.outcome = 'licence_issued'))
		 ORDER BY s.name, s.id
		 LIMIT $4`,
		[projectId, baselineRunId, own?.id ?? null, APPLICATION_RUNS_MAX + 1]
	);
	const listed = others.slice(0, APPLICATION_RUNS_MAX).map((o) => ({ scenarioId: o.scenarioId, scenarioName: o.scenarioName, status: o.status, outcome: o.outcome }));
	const total = others.length + (own ? 1 : 0);
	if (total < 2) return { ...none, others: listed };
	if (others.length > APPLICATION_RUNS_MAX)
		return { ...none, others: listed, unavailable: `more than ${APPLICATION_RUNS_MAX} other applications are based on this baseline; an assessment takes at most ${ASSESSMENT_SCENARIOS_MAX} together.` };
	if (own && own.origin === 'applicant' && own.status !== 'submitted' && own.status !== 'decided')
		return { ...none, others: listed, unavailable: 'this application isn’t submitted, and an application is assessed with the others once it is.' };
	if (total > ASSESSMENT_SCENARIOS_MAX)
		return { ...none, others: listed, unavailable: `${total} applications are based on this baseline, and an assessment takes at most ${ASSESSMENT_SCENARIOS_MAX} together.` };

	const members = [...(own ? [`${own.id}:${own.opsSha256}`] : []), ...others.map((o) => `${o.scenarioId}:${o.opsSha256}`)];
	const { rows: found } = await db.query<{ id: string; name: string; createdAt: Date; createdBy: string | null; engineVersion: string | null; status: 'complete' | 'pending'; report: CumulativeReport | null }>(
		`SELECT a.id, a.name, a.created_at AS "createdAt", u.display_name AS "createdBy", a.engine_version AS "engineVersion", a.status, a.report
		 FROM assessment a LEFT JOIN app_user u ON u.id = a.created_by
		 WHERE a.project_id = $1 AND a.base_run_id = $2 AND a.status IN ('complete', 'pending')
			AND (SELECT count(*) FROM assessment_member m WHERE m.assessment_id = a.id) = $4
			AND NOT EXISTS (SELECT 1 FROM assessment_member m WHERE m.assessment_id = a.id
				AND (m.scenario_id IS NULL OR NOT (m.scenario_id::text || ':' || m.ops_sha256) = ANY($3::text[])))
		 ORDER BY a.status = 'complete' AND a.engine_version = $5 DESC, a.status = 'pending' DESC, a.created_at DESC, a.id DESC
		 LIMIT 1`,
		[projectId, baselineRunId, members, members.length, baselineEngine]
	);
	const hit = found[0];
	if (hit?.status === 'complete' && hit.report && hit.engineVersion === baselineEngine)
		return {
			...none,
			others: listed,
			assessment: { id: hit.id, name: hit.name, createdAt: iso(hit.createdAt)!, createdBy: hit.createdBy, engineVersion: hit.engineVersion, report: hit.report }
		};
	// None on the baseline's engine (a pending one comes next, then one on another engine): one on another engine
	// isn't read, and says why; nor can one be made now while the server runs another engine than the baseline's.
	const stale = staleAssessment(hit?.status === 'complete' ? hit.engineVersion : null, baselineEngine);
	if (stale) return { ...none, others: listed, unavailable: stale };

	// No assessment of exactly these: check that they combine at all, so a conflict is named now.
	const { rows: full } = await db.query<{ id: string; name: string; origin: ScenarioOrigin; ops: ScenarioOp[]; ownedNodeIds: string[] }>(
		`SELECT s.id, s.name, s.origin, s.ops, s.owned_node_ids::text[] AS "ownedNodeIds" FROM scenario s WHERE s.project_id = $1 AND s.id = ANY($2::uuid[])`,
		[projectId, others.map((o) => o.scenarioId)]
	);
	const byId = new Map(full.map((r) => [r.id, r]));
	const scenarios = [...(own ? [own] : []), ...others.map((o) => byId.get(o.scenarioId)).filter((x): x is NonNullable<typeof x> => !!x)];
	let base: Awaited<ReturnType<typeof loadBaseInput>>;
	try {
		base = await loadBaseInput(db, projectId, baselineRunId);
	} catch (err) {
		if (err instanceof ApiError) return { ...none, others: listed, unavailable: `the baseline can’t be rebuilt to put them together (${err.message}).` };
		throw err;
	}
	const check = checkCombination(base, scenarios);
	return { ...none, others: listed, conflicts: check.conflicts.map((c) => c.message), problems: check.problems, pending: hit?.status === 'pending' };
}

/**
 * Page 1's licence impact inputs (issue #53 R7, evidence-5): the project's
 * outcome settings (no run records them, so the report, and a pack's
 * manifest, freezes them as they are now) and the three catchment series the
 * board reads. A series the reader can't see, or the run hasn't, is null, and
 * the report says what is missing.
 */
async function loadImpactInput(db: Db, projectId: string, baselineRunId: string, applicationRunId: string): Promise<EvidenceImpactInput> {
	const { rows: settings } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const outcomes = resolveOutcomes(settings[0]?.settings);
	const { rows } = await db.query<{ runId: string; key: string; values: (number | null)[] }>(
		`SELECT run_id AS "runId", key, "values" FROM run_series
		 WHERE project_id = $1 AND node_id IS NULL
		   AND ((run_id = $2 AND key IN ('natural_flow', 'ewr_shortfall')) OR (run_id = $3 AND key = 'ewr_shortfall'))`,
		[projectId, baselineRunId, applicationRunId]
	);
	const find = (runId: string, key: string) => rows.find((r) => r.runId === runId && r.key === key)?.values ?? null;
	return {
		yearClassMethod: outcomes.yearClassMethod,
		siteNodeId: outcomes.siteNodeId,
		series: {
			backgroundNatural: find(baselineRunId, 'natural_flow'),
			backgroundEwrShortfall: find(baselineRunId, 'ewr_shortfall'),
			applicationEwrShortfall: find(applicationRunId, 'ewr_shortfall')
		}
	};
}

/**
 * § 1's locality map (evidence-12, issue #326 A5): the project's map features
 * as they are now (no run records them, so the report, and a pack's manifest,
 * freezes them as drafted), under the reader's RLS, with the file each came
 * from. `other` features aren't drawn, so they aren't read. Ordered by kind
 * and id, so the same features give the same report.
 */
async function loadMapFeatures(db: Db, projectId: string): Promise<EvidenceMapFeatureInput[]> {
	const { rows } = await db.query<{
		kind: EvidenceMapFeatureInput['kind'];
		name: string;
		nodeId: string | null;
		geometry: EvidenceMapFeatureInput['geometry'];
		updatedAt: Date;
		fileName: string | null;
		sha256: string | null;
		importedAt: Date | null;
	}>(
		`SELECT f.kind, f.name, f.node_id AS "nodeId", f.geometry, f.updated_at AS "updatedAt",
			s.file_name AS "fileName", s.sha256, s.imported_at AS "importedAt"
		 FROM map_feature f
		 LEFT JOIN geo_source s ON s.id = f.source_id AND s.project_id = f.project_id
		 WHERE f.project_id = $1 AND f.kind <> 'other'
		 ORDER BY f.kind, f.id`,
		[projectId]
	);
	return rows.map((r) => ({
		kind: r.kind,
		name: r.name,
		nodeId: r.nodeId,
		geometry: r.geometry,
		updatedAt: iso(r.updatedAt)!,
		source: r.sha256 && r.fileName && r.importedAt ? { fileName: r.fileName, sha256: r.sha256, importedAt: iso(r.importedAt)! } : null
	}));
}

/** Everything evidenceReport() reads, for the report named by `runId`. 404 when the reader can't see the run or its base. */
export async function loadEvidenceInput(db: Db, projectId: string, runId: string): Promise<EvidenceInput> {
	const named = await loadRun(db, projectId, runId);
	if (!named) throw new ApiError(404, 'not found');
	const recorded = named.inputs.scenario;
	const baseRow = recorded ? await loadRun(db, projectId, recorded.baseRunId) : named;
	if (!baseRow) throw new ApiError(404, 'the application’s base run is gone, or you can’t see it');
	const { rows: project } = await db.query<{ id: string; name: string }>('SELECT id, name FROM project WHERE id = $1', [projectId]);
	const baseline = await withAllocations(db, runInput(baseRow));

	let application: EvidenceInput['application'] = null;
	let changes: EvidenceInput['changes'] = [];
	let applicationRuns: EvidenceInput['applicationRuns'] = [];
	let ownOrigin: ScenarioOrigin | null = null;
	if (recorded) {
		const { rows: sc } = await db.query<{
			name: string;
			description: string | null;
			purposeAndNeed: string;
			mitigation: string;
			monitoring: string;
			status: string;
			origin: ScenarioOrigin;
			ownerName: string | null;
		}>(
			`SELECT s.name, s.description, s.purpose_need AS "purposeAndNeed", s.mitigation, s.monitoring, s.status, s.origin, u.display_name AS "ownerName"
			 FROM scenario s LEFT JOIN app_user u ON u.id = s.owner_user_id
			 WHERE s.project_id = $1 AND s.id = $2`,
			[projectId, recorded.id]
		);
		const meta = sc[0];
		ownOrigin = meta?.origin ?? null;
		application = {
			...(await withAllocations(db, runInput(named))),
			scenario: {
				id: recorded.id,
				name: meta?.name ?? recorded.name,
				description: meta?.description ?? '',
				// Appendix C's fixed prompts (129), as the scenario holds them now: a deleted scenario answered none.
				prompts: { purposeAndNeed: meta?.purposeAndNeed ?? '', mitigation: meta?.mitigation ?? '', monitoring: meta?.monitoring ?? '' },
				status: meta?.status ?? null,
				ownerName: meta?.ownerName ?? null,
				baseRunId: recorded.baseRunId,
				ops: recorded.ops,
				opsSha256: recorded.opsSha256,
				ownedNodeIds: recorded.ownedNodeIds,
				classified: recorded.classified
			}
		};
		const kinds = differingKinds(baseline.inputs, application.inputs);
		changes = diffInputs(baseline.inputs, application.inputs, { a: await storedValues(db, baseline.id, kinds), b: await storedValues(db, application.id, kinds) });
	}
	{
		const { rows } = await db.query<{ runId: string; label: string | null; scenarioName: string; createdAt: Date; createdBy: string | null }>(
			`SELECT r.id AS "runId", r.label, COALESCE(s.name, r.inputs->'scenario'->>'name') AS "scenarioName", r.created_at AS "createdAt",
				u.display_name AS "createdBy"
			 FROM model_run r
			 LEFT JOIN scenario s ON s.id = r.scenario_id
			 LEFT JOIN app_user u ON u.id = r.created_by
			 WHERE r.project_id = $1 AND r.inputs->'scenario'->>'baseRunId' = $2
			 ORDER BY r.created_at DESC, r.id LIMIT $3`,
			[projectId, baseline.id, APPLICATION_RUNS_MAX]
		);
		applicationRuns = rows.map((r) => ({ runId: r.runId, label: r.label ?? '', scenarioName: r.scenarioName, createdAt: iso(r.createdAt)!, createdBy: r.createdBy }));
	}

	const others = await loadOtherApplications(db, projectId, baseline.id, recorded?.id ?? null);
	const combined = await loadCombined(
		db,
		projectId,
		baseline.id,
		baseline.engineVersion,
		recorded && application
			? {
					id: recorded.id,
					name: application.scenario.name,
					origin: ownOrigin ?? 'applicant',
					status: application.scenario.status,
					ops: recorded.ops,
					opsSha256: recorded.opsSha256,
					ownedNodeIds: recorded.ownedNodeIds
				}
			: null
	);

	const nominations = (await listNominations(db, projectId)).map((n) => ({
		withdrawn: n.withdrawn,
		runId: n.runId,
		runLabel: n.runLabel,
		runoffModel: n.runoffModel,
		engineVersion: n.engineVersion,
		reason: n.reason,
		nominatedAt: iso(n.nominatedAt)!,
		nominatedBy: n.nominatedBy
	}));
	return {
		project: { id: project[0]!.id, name: project[0]!.name },
		baseline,
		application,
		nominations,
		...(await loadPublications(db, projectId, baseRow)),
		authority: await projectAuthority(db, projectId),
		baselineEndorsement: await loadEndorsement(db, projectId, baseline.id),
		ensembles: await loadEnsembles(db, projectId, baseline.id, application?.id ?? null, application?.scenario.ownedNodeIds ?? []),
		changes,
		applicationRuns,
		...others,
		combined,
		liability: { methodology: METHODOLOGY, limitations: KNOWN_LIMITATIONS, errata: ENGINE_ERRATA, disclaimerVersion: DISCLAIMER.version },
		impact: application ? await loadImpactInput(db, projectId, baseline.id, application.id) : null,
		mapFeatures: await loadMapFeatures(db, projectId)
	};
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The report for one run, as the engine builds it, with § 1's locality map's SVG hashed (the engine has no hash of its own). */
export async function buildEvidenceReport(db: Db, projectId: string, runId: string): Promise<EvidenceReport> {
	return withLocalitySvgHash(evidenceReport(await loadEvidenceInput(db, projectId, runId)), sha256);
}

export const evidenceReportRoutes = new Hono<AuthEnv>().get('/:id/runs/:runId/evidence-report', async (c) => {
	const { id, runId } = c.req.param();
	return withUser(
		c.get('userId'),
		async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ report: await buildEvidenceReport(db, id, runId) });
		},
		{ readOnly: true }
	);
});
