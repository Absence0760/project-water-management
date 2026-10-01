// /projects/:id/scenarios — named overrides on a base run (roadmap WP-3.2,
// docs/api.md § Scenarios, docs/scenarios.md) — and applications, the
// scenarios a contributor (a licence applicant, WP-3.3) makes on the
// published baseline and submits to the assessors (docs/scenarios.md
// § Applications).
//
// Who may do what (RLS in 024/045 enforces the same underneath):
//  - a team scenario: viewers read, editors write, as WP-3.2 built it;
//  - an application: its owner and the people they add (scenario_member)
//    read it, editors once submitted, viewers once decided. Only its owner
//    edits, submits, withdraws and reopens it; only an editor who isn't its
//    owner decides it. A contributor never receives the base run's input:
//    they get the applicant projection (applicant.ts), and an
//    application's ops meet other farms under the anonymous names that
//    projection gives them (checkScenario), so nothing quotes a hidden name.
//    The owner shares an application only with the people app_share_candidates
//    lists for them (049: a contributor's own party, which the project owner
//    curates), never by probing an address;
//  - farmers: 403, like every viewer route.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, mustChange } from '../http/errors.js';
import { rank, requireRole, type Role, UUID } from '../projects/access.js';
import { requireStepUp } from '../auth/stepUp.js';
import { projectAuthority, requireActsForAuthority } from '../projects/authoritySettings.js';
import { lockProjectRuns, runFailure, trimRuns } from '../runs/execute.js';
import { RUN_META_SQL } from '../runs/routes.js';
import { runUnverified, unverifiedScenarioRuns } from '../runs/stamp.js';
import { projectBaseForApplicant } from './applicant.js';
import {
	checkScenario,
	loadBaseInput,
	loadScenario,
	runScenario,
	SCENARIO_SELECT,
	trimApplicationRuns,
	type ScenarioCheck,
	type ScenarioRow
} from './execute.js';
import { loadApplicantResults, newestApplicationRun } from './results.js';
import { applicantOpNames, baseNames, opNames, ownNames, type OpName } from './names.js';
import { CreateScenarioBody, DecideBody, opsSha256, PatchScenarioBody, RebaseBody, ScenarioRunBody, ShareBody, STATUS_MOVES, type ScenarioStatus } from './schema.js';

/**
 * What the editor shows beside the ops: which applied, which don't, and how
 * each is classed. The input itself stays server-side. The messages quote
 * only names the caller sees (checkScenario masks an application's hidden
 * nodes for everyone); `renamed`, the hidden nodes an application's ops took
 * the name of, and `reIds`, the new items moved off a hidden item's id, are
 * for the assessors, never a contributor.
 */
function checkView(c: ScenarioCheck, role: Role) {
	const view = { applied: c.applied, problems: c.problems, classified: c.classified };
	return role === 'contributor' ? view : { ...view, renamed: c.renamed, reIds: c.reIds };
}

/** A scenario and its check against its base, or `check: null` with why when the base can't be rebuilt. */
async function withCheck(db: Db, projectId: string, s: ScenarioRow, role: Role) {
	const scenario = applicantOpNames(s, role);
	// An application's runs whose server stamp is missing or wrong (077,
	// runs/stamp.ts), for the assessors: its decision waits until none remain.
	// null for a team scenario and for anyone below editor.
	const unverifiedRunIds = isApplication(s) && rank[role] >= rank.editor ? await unverifiedScenarioRuns(db, projectId, s.id) : null;
	try {
		const base = await loadBaseInput(db, projectId, s.baseRunId, role);
		return { scenario, check: checkView(checkScenario(base, s), role), checkError: null, unverifiedRunIds };
	} catch (err) {
		if (err instanceof ApiError && err.status === 409) return { scenario, check: null, checkError: err.message, unverifiedRunIds };
		throw err;
	}
}

const scenarioId = (sid: string) => {
	if (!UUID.test(sid)) throw new ApiError(404, 'not found');
	return sid;
};

/**
 * A name already taken reads as a 409 that says so. A team scenario's name is
 * unique among the team's scenarios, an application's among its owner's
 * applications (049: so the answer never says a hidden one exists).
 */
const duplicateName = (application: boolean) => (err: unknown): never => {
	if ((err as { code?: string }).code === '23505')
		throw new ApiError(409, application ? 'you already have an application with that name' : 'this project already has a scenario with that name');
	throw err;
};

/** restrict_violation: scenario_signed_run_guard (072) refused the DELETE. */
const PG_RESTRICT = '23001';
const signedKept = () =>
	new ApiError(409, 'this scenario has a signed-off run or an evidence pack, so it is kept: the run stays the scenario run that was signed or packed');
const commentsKept = () => new ApiError(409, 'this application drew public comments, so it is kept: they are the record of its public participation');
const frozen = (s: ScenarioRow) => new ApiError(409, `this scenario is ${s.status}, so its ops, owned nodes and base run can't change`);
const isApplication = (s: ScenarioRow) => s.origin === 'applicant';

/** Change a scenario's ops, name, base or status: an editor on a team scenario, the owner on an application. */
function assertCanChange(s: ScenarioRow, role: Role, userId: string) {
	if (isApplication(s)) {
		if (s.ownerUserId !== userId) throw new ApiError(403, 'only the applicant changes their application');
	} else if (rank[role] < rank.editor) {
		throw new ApiError(403, 'requires editor role');
	}
}

/** op_names as stored: an application keeps only its own nodes' names (047; its applicant sees the rest anonymised). */
const namesToStore = (s: ScenarioRow, names: OpName[], ownedNodeIds: string[]): OpName[] =>
	isApplication(s) ? ownNames({ opNames: names, ownedNodeIds }).opNames : names;

/** The current user's farm links in the project: an applicant's own nodes (045; classifyOp's proposal nodes). */
async function ownFarms(db: Db, projectId: string): Promise<string[]> {
	const { rows } = await db.query<{ id: string }>('SELECT app_farm_nodes($1) AS id ORDER BY 1', [projectId]);
	return rows.map((r) => r.id);
}

/**
 * The audit subject for a scenario event. An application's name stays out of
 * the project's log (every viewer reads it) until it is decided, when viewers
 * may read the application itself.
 */
const subject = (s: Pick<ScenarioRow, 'id' | 'name' | 'origin'>, extra: Record<string, unknown> = {}, decided = false) =>
	s.origin === 'applicant' && !decided ? { scenarioId: s.id, application: true, ...extra } : { scenarioId: s.id, name: s.name, ...extra };

/** Move a scenario's status after the caller's right to has been checked; the guard trigger checks the move again. */
/** What recording the authority's decision writes beside the move (163_licensing_authority). */
interface DecisionRecord {
	outcome: string;
	note: string;
	authority: string;
	decisionDate: string;
	reference: string;
	reasonsReceived: boolean;
}

async function move(db: Db, projectId: string, s: ScenarioRow, to: ScenarioStatus, decision: DecisionRecord | null = null) {
	if (!STATUS_MOVES[s.status].includes(to)) throw new ApiError(409, `a ${s.status} scenario can't become ${to}`);
	// Only from the status the caller read: a concurrent move (the applicant
	// withdrawing while the assessor decides) makes this match no row, and RLS
	// filters an UPDATE silently, so a zero count is the 409, never a success.
	const { rowCount } = await db.query(
		decision
			? `UPDATE scenario SET status = $3, outcome = $5, decision_note = $6, decision_authority = $7, decision_date = $8::date,
					decision_reference = $9, reasons_received = $10
				 WHERE project_id = $1 AND id = $2 AND status = $4`
			: 'UPDATE scenario SET status = $3 WHERE project_id = $1 AND id = $2 AND status = $4',
		decision
			? [projectId, s.id, to, s.status, decision.outcome, decision.note, decision.authority, decision.decisionDate, decision.reference, decision.reasonsReceived]
			: [projectId, s.id, to, s.status]
	);
	if (!rowCount) {
		const now = await loadScenario(db, projectId, s.id).catch(() => null);
		throw new ApiError(409, `this scenario is ${now?.status ?? 'no longer available'}; it can't become ${to}`);
	}
}

export const scenarioRoutes = new Hono<AuthEnv>()
	.get('/:id/scenarios', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			// RLS lists what the caller reads: a contributor, their own applications and those shared with them.
			const role = await requireRole(db, id, 'contributor');
			const { rows } = await db.query<ScenarioRow>(`${SCENARIO_SELECT} WHERE s.project_id = $1 ORDER BY s.created_at DESC, s.id DESC`, [id]);
			return c.json({ scenarios: rows.map((s) => applicantOpNames(s, role)) });
		});
	})
	.post('/:id/scenarios', async (c) => {
		const id = c.req.param('id');
		const body = CreateScenarioBody.parse(await readJson(c, { optional: true }));
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			// A viewer reads scenarios but makes none; a contributor makes applications.
			if (role === 'viewer') throw new ApiError(403, 'requires editor role');
			const applicant = role === 'contributor';
			if (applicant && body.ownedNodeIds.length) throw new ApiError(403, "an applicant's own nodes are their farm links");
			// Citing a run: not while a trim or delete of this project's runs is under way (it would miss the citation).
			await lockProjectRuns(db, id);
			const base = await loadBaseInput(db, id, body.baseRunId, role);
			// The names the ops need, from the full base (server-side; applicantOpNames filters them for an applicant).
			const all = opNames(body.ops, base.model, []);
			const owned = applicant ? await ownFarms(db, id) : body.ownedNodeIds;
			const names = applicant ? ownNames({ opNames: all, ownedNodeIds: owned }).opNames : all;
			const { rows } = await db
				.query<{ id: string }>(
					`INSERT INTO scenario (project_id, name, description, base_run_id, ops, ops_sha256, owned_node_ids, op_names, purpose_need, mitigation, monitoring)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
					[
						id,
						body.name,
						body.description,
						body.baseRunId,
						JSON.stringify(body.ops),
						opsSha256(body.ops),
						owned,
						JSON.stringify(names),
						body.purposeAndNeed,
						body.mitigation,
						body.monitoring
					]
				)
				.catch(duplicateName(applicant));
			const s = await loadScenario(db, id, rows[0]!.id);
			await recordAudit(db, id, 'scenario.created', subject(s, { baseRunId: body.baseRunId, ops: body.ops.length }));
			return c.json(await withCheck(db, id, s, role), 201);
		});
	})
	// The assessors' list: every application that has been submitted (drafts are the applicant's alone).
	.get('/:id/applications', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { rows } = await db.query<ScenarioRow>(
				`${SCENARIO_SELECT} WHERE s.project_id = $1 AND s.origin = 'applicant' AND s.status <> 'draft'
				 ORDER BY COALESCE(s.submitted_at, s.updated_at) DESC, s.id DESC`,
				[id]
			);
			return c.json({ applications: rows });
		});
	})
	.get('/:id/scenarios/:sid', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			return c.json(await withCheck(db, id, await loadScenario(db, id, scenarioId(sid)), role));
		});
	})
	// The base the scenario applies to, as the caller may see it: the run's
	// model and settings for a viewer and above, the applicant projection for
	// a contributor (applicant.ts).
	.get('/:id/scenarios/:sid/base', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			const s = await loadScenario(db, id, scenarioId(sid));
			const base = await loadBaseInput(db, id, s.baseRunId, role);
			const view = role === 'contributor' ? projectBaseForApplicant(base, s.ownedNodeIds) : { settings: base.settings, model: base.model, anonymisedNodeIds: [] };
			return c.json({ baseRunId: s.baseRunId, ...view });
		});
	})
	// An application run's results as its applicant sees them against its base
	// (results.ts, applicantResults.ts: D2's default): EWR sites, the catchment
	// under the k rule, their own units, other units downstream anonymous. The
	// newest run by default. For any reader of the application; a team
	// scenario's runs are compared on the compare page instead.
	.get('/:id/scenarios/:sid/results', async (c) => {
		const { id, sid } = c.req.param();
		const q = z.object({ runId: z.string().uuid().optional() }).parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'contributor');
			const s = await loadScenario(db, id, scenarioId(sid));
			if (!isApplication(s)) throw new ApiError(409, "a team scenario's runs are compared with their base on the compare page");
			const runId = q.runId ?? (await newestApplicationRun(db, id, s.id));
			if (!runId) return c.json({ run: null, results: null });
			return c.json(await loadApplicantResults(db, id, s, runId));
		});
	})
	.patch('/:id/scenarios/:sid', async (c) => {
		const { id, sid } = c.req.param();
		const body = PatchScenarioBody.parse(await readJson(c, { optional: true }));
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			const userId = c.get('userId');
			const s = await loadScenario(db, id, scenarioId(sid));
			assertCanChange(s, role, userId);
			if (isApplication(s)) {
				if (body.ownedNodeIds !== undefined) throw new ApiError(403, "an application's own nodes are its owner's farm links");
				if (body.status !== undefined && body.status !== s.status)
					throw new ApiError(409, 'an application moves through …/submit, …/withdraw, …/reopen and (for the assessor) …/decide');
			}
			if ((body.ops !== undefined || body.ownedNodeIds !== undefined) && s.status !== 'draft') throw frozen(s);
			if (body.status !== undefined && body.status !== s.status && !STATUS_MOVES[s.status].includes(body.status))
				throw new ApiError(409, `a ${s.status} scenario can't become ${body.status}`);
			// An application's own nodes follow its owner's farm links while it is a draft.
			const owned = isApplication(s) && body.ops !== undefined ? await ownFarms(db, id) : body.ownedNodeIds;
			const set: [string, unknown][] = [];
			if (body.name !== undefined) set.push(['name', body.name]);
			if (body.description !== undefined) set.push(['description', body.description]);
			// Appendix C's fixed prompts (129): changed on the description's terms, not frozen by a submission.
			if (body.purposeAndNeed !== undefined) set.push(['purpose_need', body.purposeAndNeed]);
			if (body.mitigation !== undefined) set.push(['mitigation', body.mitigation]);
			if (body.monitoring !== undefined) set.push(['monitoring', body.monitoring]);
			// The notice's objection details (166): an application's, frozen once it is submitted (scenario_objection_frozen).
			if (body.objectionAddress !== undefined || body.objectionClosingDate !== undefined) {
				if (!isApplication(s)) throw new ApiError(409, 'only an application has a notice to object to');
				if (s.status !== 'draft') throw new ApiError(409, `a ${s.status} application's notice details are frozen; withdraw it to change them`);
				if (body.objectionAddress !== undefined) set.push(['objection_address', body.objectionAddress]);
				if (body.objectionClosingDate !== undefined) set.push(['objection_closing_date', body.objectionClosingDate]);
			}
			if (body.ops !== undefined)
				set.push(
					['ops', JSON.stringify(body.ops)],
					['ops_sha256', opsSha256(body.ops)],
					// The names the ops need, from the base as it is now, keeping those an earlier base gave (a node a rebase dropped).
					['op_names', JSON.stringify(namesToStore(s, opNames(body.ops, await baseNames(db, id, s.baseRunId, role), s.opNames), owned ?? s.ownedNodeIds))]
				);
			if (owned !== undefined) set.push(['owned_node_ids', owned]);
			if (body.status !== undefined) set.push(['status', body.status]);
			await db
				.query(`UPDATE scenario SET ${set.map(([k], i) => `${k} = $${i + 3}`).join(', ')} WHERE project_id = $1 AND id = $2`, [
					id,
					sid,
					...set.map(([, v]) => v)
				])
				.catch(duplicateName(isApplication(s)));
			// Only the fields whose value moved: a PATCH that re-sends the scenario as it is logs nothing.
			const was: Record<string, unknown> = {
				name: s.name,
				description: s.description,
				purposeAndNeed: s.purposeAndNeed,
				mitigation: s.mitigation,
				monitoring: s.monitoring,
				objectionAddress: s.objectionAddress,
				objectionClosingDate: s.objectionClosingDate,
				ops: s.opsSha256,
				owned_node_ids: [...s.ownedNodeIds].sort().join(','),
				status: s.status
			};
			const now: Record<string, unknown> = {
				name: body.name,
				description: body.description,
				purposeAndNeed: body.purposeAndNeed,
				mitigation: body.mitigation,
				monitoring: body.monitoring,
				objectionAddress: body.objectionAddress,
				objectionClosingDate: body.objectionClosingDate,
				ops: body.ops !== undefined ? opsSha256(body.ops) : undefined,
				owned_node_ids: owned !== undefined ? [...owned].sort().join(',') : undefined,
				status: body.status
			};
			const fields = Object.keys(now).filter((k) => now[k] !== undefined && now[k] !== was[k]);
			if (fields.length)
				await recordAudit(
					db,
					id,
					'scenario.changed',
					subject({ ...s, name: body.name ?? s.name }, { fields, ...(body.status !== undefined && body.status !== s.status ? { from: s.status, to: body.status } : {}) })
				);
			return c.json(await withCheck(db, id, await loadScenario(db, id, sid), role));
		});
	})
	.delete('/:id/scenarios/:sid', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			const s = await loadScenario(db, id, scenarioId(sid));
			assertCanChange(s, role, c.get('userId'));
			if (s.status === 'submitted' || s.status === 'decided') throw new ApiError(409, `a ${s.status} scenario can't be deleted`);
			// Its base run stops being cited and may be trimmed: under the project's run lock, as a trim is.
			await lockProjectRuns(db, id);
			// A signed-off run stays the run that was signed, its scenario included
			// (model_run.scenario_id would go NULL). The scenario_signed_run_guard
			// trigger (072) refuses the DELETE too, whoever runs it, and sees the
			// sign-offs a contributor can't read; its restrict_violation is the same 409.
			// An evidence pack of the scenario likewise (112_evidence_pack): the same trigger refuses it.
			const signed = await db.query(
				`SELECT 1 FROM signoff so JOIN model_run r ON r.id = so.run_id WHERE r.scenario_id = $1
				 UNION ALL SELECT 1 FROM evidence_pack ep WHERE ep.scenario_id = $1 LIMIT 1`,
				[sid]
			);
			if (signed.rowCount) throw signedKept();
			// Public comments are a participation record: the scenario_comments_kept trigger (115) refuses too.
			const { rows: commented } = await db.query<{ yes: boolean }>('SELECT app_scenario_has_public_comments($1, $2) AS yes', [id, sid]);
			if (commented[0]?.yes) throw commentsKept();
			await db.query('DELETE FROM scenario WHERE project_id = $1 AND id = $2', [id, sid]).then(mustChange, (err: { code?: string; message?: string }) => {
				throw err.code === PG_RESTRICT ? (err.message?.includes('public comments') ? commentsKept() : signedKept()) : err;
			});
			await recordAudit(db, id, 'scenario.deleted', subject(s));
			return c.body(null, 204);
		});
	})
	.post('/:id/scenarios/:sid/runs', async (c) => {
		const { id, sid } = c.req.param();
		const body = ScenarioRunBody.parse(await readJson(c, { optional: true }));
		// A team scenario: an editor runs it. An application: whoever reads it
		// as its owner or a shared member, and the assessors; never a viewer.
		// Checked when the run is read and again when it is stored (runScenario).
		const authorize = async (db: Db) => {
			const role = await requireRole(db, id, 'contributor');
			const scenario = await loadScenario(db, id, scenarioId(sid));
			if (role === 'viewer' || (!isApplication(scenario) && rank[role] < rank.editor)) throw new ApiError(403, 'requires editor role');
			return { role, scenario };
		};
		const result = await runScenario(c.get('userId'), id, body.label, authorize, async (db, { id: runId, check, scenario: s }, role) => {
			if (role === 'contributor') {
				// The applicant's own cap (they can't trim the project's runs), and
				// the run's metadata only (app_scenario_run_meta, 046: they can't
				// read the row, whose inputs and summary hold every farm).
				const removedRunIds = await trimApplicationRuns(db, id, s.id);
				if (removedRunIds.length) await recordAudit(db, id, 'run.deleted', { runIds: removedRunIds, reason: 'trimmed' });
				const { rows } = await db.query(
					`SELECT r.id, r.label, r.engine_version AS "engineVersion", r.start_date AS "startDate", r.end_date AS "endDate",
						r.created_at AS "createdAt", r.scenario_id AS "scenarioId" FROM app_scenario_run_meta($1, $2) r WHERE r.id = $3`,
					[id, s.id, runId]
				);
				const { applied, classified } = checkView(check, role);
				return { run: rows[0], removedRunIds, applied, classified };
			}
			// A scenario run counts toward the cap like any other.
			const removedRunIds = await trimRuns(db, id);
			const { rows } = await db.query(`SELECT ${RUN_META_SQL.meta}, r.summary ${RUN_META_SQL.from} WHERE r.id = $1`, [runId]);
			return { run: rows[0], removedRunIds, ...checkView(check, role) };
		}).catch(runFailure); // As POST …/runs: engine problems with the input are the user's to fix.
		return c.json(result, 201);
	})
	.post('/:id/scenarios/:sid/rebase', async (c) => {
		const { id, sid } = c.req.param();
		const body = RebaseBody.parse(await readJson(c, { optional: true }));
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			const current = await loadScenario(db, id, scenarioId(sid));
			assertCanChange(current, role, c.get('userId'));
			// Lock first (as a trim and a scenario run do), then the new base's input.
			if (!body.dryRun) await lockProjectRuns(db, id);
			const base = await loadBaseInput(db, id, body.baseRunId, role);
			if (!body.dryRun) {
				// The update takes the row lock, so the ops checked below are the ones the
				// scenario has now, not ones a concurrent PATCH has since replaced.
				const { rowCount } = await db.query("UPDATE scenario SET base_run_id = $3 WHERE project_id = $1 AND id = $2 AND status = 'draft'", [id, sid, body.baseRunId]);
				if (!rowCount) throw frozen(await loadScenario(db, id, sid));
			}
			const s = await loadScenario(db, id, sid);
			if (!body.dryRun) {
				// Names from the new (full) base, keeping the old base's for nodes the new one dropped.
				s.opNames = namesToStore(s, opNames(s.ops, base.model, s.opNames), s.ownedNodeIds);
				await db.query('UPDATE scenario SET op_names = $3 WHERE project_id = $1 AND id = $2', [id, sid, JSON.stringify(s.opNames)]);
				await recordAudit(db, id, 'scenario.changed', subject(s, { fields: ['base_run_id'], baseRunId: body.baseRunId }));
			}
			return c.json({ scenario: applicantOpNames(s, role), ...checkView(checkScenario(base, s), role) });
		});
	})
	// --- the submission workflow (WP-3.3) ---------------------------------------------
	// Submit: freezes the ops (their hash is the one the assessor decides on).
	// Only a scenario whose every op applies to its base may be submitted.
	.post('/:id/scenarios/:sid/submit', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			assertCanChange(await loadScenario(db, id, scenarioId(sid)), role, c.get('userId'));
			// Held until the submit commits, so the ops checked below are the ones
			// frozen: a concurrent PATCH waits, then finds it submitted.
			await db.query('SELECT 1 FROM scenario WHERE project_id = $1 AND id = $2 FOR UPDATE', [id, sid]);
			const s = await loadScenario(db, id, sid);
			if (s.status !== 'draft') throw new ApiError(409, `a ${s.status} scenario can't be submitted`);
			const base = await loadBaseInput(db, id, s.baseRunId, role);
			const { problems } = checkScenario(base, s);
			if (problems.length) throw new ApiError(422, "a scenario whose changes don't all apply to its base can't be submitted", { problems });
			await move(db, id, s, 'submitted');
			await recordAudit(db, id, 'scenario.submitted', subject(s, { opsSha256: s.opsSha256 }));
			return c.json(await withCheck(db, id, await loadScenario(db, id, sid), role));
		});
	})
	.post('/:id/scenarios/:sid/withdraw', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			const s = await loadScenario(db, id, scenarioId(sid));
			assertCanChange(s, role, c.get('userId'));
			await move(db, id, s, 'withdrawn');
			await recordAudit(db, id, 'scenario.withdrawn', subject(s));
			return c.json(await withCheck(db, id, await loadScenario(db, id, sid), role));
		});
	})
	// Withdrawn → draft: editable again (and to be submitted again).
	.post('/:id/scenarios/:sid/reopen', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			const s = await loadScenario(db, id, scenarioId(sid));
			assertCanChange(s, role, c.get('userId'));
			await move(db, id, s, 'draft');
			await recordAudit(db, id, 'scenario.reopened', subject(s));
			return c.json(await withCheck(db, id, await loadScenario(db, id, sid), role));
		});
	})
	// Record the responsible authority's decision (163_licensing_authority): an
	// editor the owner marks as acting for the authority, who didn't make the
	// application. The app records the decision; it never makes one.
	.post('/:id/scenarios/:sid/decide', async (c) => {
		const { id, sid } = c.req.param();
		const body = DecideBody.parse(await readJson(c, { optional: true }));
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'editor');
			// Recording the decision needs two-step sign-in (auth/stepUp.ts).
			await requireStepUp(db);
			await requireActsForAuthority(db, id);
			const s = await loadScenario(db, id, scenarioId(sid));
			if (isApplication(s) && s.ownerUserId === c.get('userId')) throw new ApiError(403, 'an applicant can’t decide their own application');
			const authority = body.authority ?? (await projectAuthority(db, id))?.name;
			if (!authority) throw new ApiError(400, 'name the responsible authority whose decision this is (authority), or set the project’s settings.responsibleAuthority');
			// The decision letter's date: today at the latest (a day's grace for time zones).
			if (body.decisionDate > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) throw new ApiError(400, 'the decision date is in the future');
			// Decided on runs the model run stored, never on one written past it (077, runs/stamp.ts).
			const unverified = await unverifiedScenarioRuns(db, id, s.id);
			if (unverified.length)
				throw runUnverified(
					`this scenario can't be decided: ${unverified.length} of its runs (unverifiedRunIds) weren't stored by the model run itself (a server stamp missing or no longer matching its results); delete them and run it again`
				);
			await move(db, id, s, 'decided', {
				outcome: body.outcome,
				note: body.note,
				authority,
				decisionDate: body.decisionDate,
				reference: body.reference,
				reasonsReceived: body.reasonsReceived
			});
			await recordAudit(db, id, 'scenario.decided', subject(s, { outcome: body.outcome, authority, decisionDate: body.decisionDate }, true));
			return c.json(await withCheck(db, id, await loadScenario(db, id, sid), role));
		});
	})
	// --- sharing an application with a consultant or client (scenario_member) ----------
	// Whom its owner may share it with (app_share_candidates, 049): for an
	// applicant, the other members of their own party, which the project owner
	// curates; for a viewer and up, every contributor-or-above member. Names
	// only. The only way an applicant names someone to share with, so nothing
	// they can send says whether an address or an id belongs to a member.
	.get('/:id/scenarios/:sid/share-candidates', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			const s = await loadScenario(db, id, scenarioId(sid));
			if (!isApplication(s)) throw new ApiError(409, 'a team scenario is read by every viewer: there is nothing to share');
			assertCanChange(s, role, c.get('userId'));
			const { rows } = await db.query<{ userId: string; displayName: string }>(
				'SELECT candidate_id AS "userId", candidate_name AS "displayName" FROM app_share_candidates($1)',
				[id]
			);
			return c.json({ candidates: rows });
		});
	})
	.post('/:id/scenarios/:sid/members', async (c) => {
		const { id, sid } = c.req.param();
		const body = ShareBody.parse(await readJson(c, { optional: true }));
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'contributor');
			const s = await loadScenario(db, id, scenarioId(sid));
			if (!isApplication(s)) throw new ApiError(409, 'a team scenario is read by every viewer: there is nothing to share');
			assertCanChange(s, role, c.get('userId'));
			// An applicant picks from their candidates; one refusal for every id
			// that isn't among them, whoever it belongs to. By address: the same
			// refusal for every address, member or not.
			let userId: string;
			if ('email' in body) {
				if (rank[role] < rank.viewer) throw new ApiError(403, 'an applicant shares with someone from …/share-candidates, by id');
				// RLS on app_user (068) shows the project's people, so an outsider's
				// address finds nothing; the insert's trigger checks the address
				// belongs to a contributor-or-above member.
				const { rows: users } = await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [body.email]);
				if (!users[0]) throw new ApiError(404, 'no contributor or above on this project has that address');
				userId = users[0].id;
			} else {
				userId = body.userId;
			}
			const refused = () =>
				'email' in body
					? new ApiError(404, 'no contributor or above on this project has that address')
					: new ApiError(404, 'not someone you can share this application with');
			if (userId === s.ownerUserId) throw new ApiError(409, 'you already own this application');
			await db.query('SAVEPOINT scenario_share');
			const added = await db
				.query('INSERT INTO scenario_member (scenario_id, project_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [s.id, id, userId])
				.catch(async (err: { code?: string; constraint?: string }) => {
					// 163's conflict guard (an editor can't be shared an application): said as
					// it is to a viewer and up, who read the member list anyway; an applicant
					// gets the one refusal (their candidates are their party, never an editor).
					if (err.constraint === 'role_conflict' && rank[role] >= rank.viewer) throw err;
					if (err.code === '23514' || err.code === '23503') {
						await db.query('ROLLBACK TO SAVEPOINT scenario_share');
						throw refused();
					}
					throw err;
				});
			if (added.rowCount) await recordAudit(db, id, 'scenario.shared', subject(s, { userId }));
			return c.json({ members: (await loadScenario(db, id, s.id)).members }, added.rowCount ? 201 : 200);
		});
	})
	// The owner removes anyone; anyone listed may leave.
	.delete('/:id/scenarios/:sid/members/:userId', async (c) => {
		const { id, sid, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'contributor');
			const s = await loadScenario(db, id, scenarioId(sid));
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			const me = c.get('userId');
			if (s.ownerUserId !== me && userId !== me) throw new ApiError(403, 'only the applicant removes someone else');
			const { rowCount } = await db.query('DELETE FROM scenario_member WHERE scenario_id = $1 AND user_id = $2', [s.id, userId]);
			if (!rowCount) throw new ApiError(404, 'not found');
			await recordAudit(db, id, 'scenario.unshared', subject(s, { userId, self: userId === me }));
			return c.body(null, 204);
		});
	});
