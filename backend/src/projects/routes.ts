import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError, mustChange } from '../http/errors.js';
import {
	beginSettingsChange,
	farmLinks,
	maskEmail,
	Reason,
	recordAudit,
	recordLinkChanges,
	recordModelRevision
} from '../history/record.js';
import { accountByEmail, countInvites, inviteByEmail } from '../invites/invites.js';
import { trySendMail } from '../mail/transport.js';
import { loadModel, saveModel } from '../model/store.js';
import { hasTeamRole, requireTeamRole } from '../teams/access.js';
import { requireRole, UUID, type Role } from './access.js';
import { autoFitRecordError, dataQualityPatchError, mergeSettings, patchSettings, remapSettingNodeIds, SettingsPatch, signOffChange } from './settings.js';
import { TimeZone } from './timeZone.js';
import { resolveAutoRun } from '../runs/autoRun.js';
import { checkOutcomeSite, resolveOutcomes } from './outcomeSettings.js';
import { resolveOutlook } from './outlookSettings.js';
import { readJson } from '../http/body.js';
import { bodyLimit } from 'hono/body-limit';
import { freshIds, IMPORT_MAX_BYTES, insertProjectFile, parseProjectFile, runImported } from './import.js';
import { insertImportReport, latestImportReport, parseImportReport } from './importReport.js';
import { loadMyOutcomes } from '../portfolio/portfolio.js';
import { recordedRainUntilSql } from '../series/lastDay.js';

type ProjectRow = {
	id: string;
	name: string;
	description: string;
	/** IANA zone (058_project_time_zone): dates the project's downloads. */
	time_zone: string;
	/** The WUA that publishes the figures (095_wua_name), or null. */
	wua_name: string | null;
	team_id: string | null;
	team_name: string | null;
	settings: unknown;
	role: Role;
	created_at: Date;
	updated_at: Date;
	/** Last day covered by any of the project's time series ('YYYY-MM-DD'), or null. */
	data_until: string | null;
	last_run_at: Date | null;
	/** When the current publication was published (022_publication), or null. */
	published_at: Date | null;
	/** When the project's pending re-run is due, or null (042_auto_rerun). */
	rerun_queued_for: Date | null;
};

const summary = (r: ProjectRow) => ({
	id: r.id,
	name: r.name,
	description: r.description,
	role: r.role,
	team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString(),
	dataUntil: r.data_until,
	lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : null,
	publishedAt: r.published_at ? r.published_at.toISOString() : null
});
// settings.autoRun, settings.outcomes and settings.outlook aren't in the engine's defaults (they're no model inputs), so they are resolved here: clients see every field.
// rerunQueuedFor: when the pending re-run is due (the header's "Re-run queued for 14:05"), or null.
const full = (r: ProjectRow) => ({
	...summary(r),
	timeZone: r.time_zone,
	wuaName: r.wua_name,
	settings: { ...mergeSettings(r.settings), autoRun: resolveAutoRun(r.settings), outcomes: resolveOutcomes(r.settings), outlook: resolveOutlook(r.settings) },
	rerunQueuedFor: r.rerun_queued_for ? r.rerun_queued_for.toISOString() : null
});

// RLS already limits rows to projects the user can see (directly or via a
// team); app_project_role gives the effective role. The team name is only
// visible to team members (team RLS), so it may be null for direct members.
const SELECT_PROJECT = `
	SELECT p.id, p.name, p.description, p.time_zone, p.wua_name, p.settings, p.created_at, p.updated_at, p.team_id,
		t.name AS team_name, app_project_role(p.id) AS role,
		-- Data freshness and last run for the project list, in the same query
		-- (both subqueries use the (project_id…) indexes; no N+1 from the client).
		-- Freshness is recorded rain (catchment or CHIRPS): what a run is driven
		-- by. A forecast runs into the future and observed flow only scores a
		-- run, so either one would read "up to date" while the rain lags.
		-- To the last day with a value, not the last day stored: blank days a
		-- logger sends for a dead sensor are no data (series/lastDay.ts).
		${recordedRainUntilSql('p.id')} AS data_until,
		(SELECT max(r.created_at) FROM model_run r WHERE r.project_id = p.id) AS last_run_at,
		-- The current publication's date (022_publication; its partial unique
		-- index answers it). Every member reads run_publication, farmers too.
		(SELECT pub.published_at FROM run_publication pub
			WHERE pub.project_id = p.id AND pub.superseded_at IS NULL) AS published_at,
		-- When the pending re-run (manual or automatic, 042_auto_rerun) is due;
		-- job_dedupe_idx answers it. Viewers read job rows (016_jobs).
		(SELECT j.run_after FROM job j
			WHERE j.project_id = p.id AND j.dedupe_key = 'rerun' AND j.status IN ('queued', 'failed')) AS rerun_queued_for
	FROM project p LEFT JOIN team t ON t.id = p.team_id`;

const name = z.string().trim().min(1).max(200);
const CreateBody = z.object({ name, description: z.string().max(5000).optional(), teamId: z.string().uuid().nullable().optional() });
const PatchBody = z.object({
	name: name.optional(),
	/** Move the project into a team you belong to (null = personal). Owner only. */
	teamId: z.string().uuid().nullable().optional(),
	description: z.string().max(5000).optional(),
	/** An IANA zone the runtime knows; dates the project's downloads (issue #45). */
	timeZone: TimeZone.optional(),
	/** The WUA the farm pages name in their contact lines; empty or null clears it. */
	wuaName: z
		.string()
		.trim()
		.max(200)
		.refine((s) => !s.includes('\u0000'), 'text cannot contain NUL characters')
		.nullable()
		.optional()
		.transform((s) => (s === '' ? null : s)),
	settings: SettingsPatch.optional(),
	/** Why the settings changed, kept with the revision (ignored without settings). */
	reason: Reason
});
// 'contributor': a licence applicant (044/045, WP-3.3). Farmers are added through /farmers.
const RoleEnum = z.enum(['contributor', 'viewer', 'editor', 'owner']);
const ImportQuery = z.object({
	teamId: z.string().uuid().optional(),
	/** `run=1`: run the model once after the import commits. */
	run: z.enum(['1', 'true', '0', 'false']).optional()
});
const IMPORT_MB = (IMPORT_MAX_BYTES / 1024 / 1024).toFixed(0);

/** restrict_violation: the project_evidence_guard trigger (035) refusing a DELETE. */
const PG_RESTRICT = '23001';

/**
 * DELETE /projects/:id's 409 for a project that has nominated evidence
 * (issue #43). `details.evidenceRun` names the current nomination so the UI
 * can link to it; null when the trigger caught a nomination made mid-request.
 */
function evidenceKept(run: { runId: string | null; runLabel: string | null; nominations: number } | null) {
	// The newest row is a withdrawal (098): no current evidence run, but the history is still kept.
	const named = !run
		? 'it has a nominated evidence run'
		: run.runId
			? `"${run.runLabel || 'Untitled run'}" is its nominated evidence run`
			: 'it has an evidence nomination history (its last nomination was withdrawn)';
	return new ApiError(
		409,
		`this project can't be deleted: ${named}, and a project keeps its evidence run and nomination history for good, ` +
			'even once a nomination is withdrawn; copy the project to start again without it.',
		{ evidenceRun: run?.runId ? { id: run.runId, label: run.runLabel ?? '' } : null, nominations: run?.nominations ?? null }
	);
}

async function getProject(db: import('../db/tx.js').Db, id: string) {
	const { rows } = await db.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.id = $1`, [id]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

/** JSON with object keys sorted, so two equal settings objects compare equal whatever order their keys were written in. */
const stableJson = (v: unknown): string =>
	JSON.stringify(v, (_k, x: unknown) =>
		x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x
	);
const withoutRunPolicy = (settings: unknown) => {
	const { autoRun: _autoRun, outcomes: _outcomes, outlook: _outlook, ...rest } = settings as Record<string, unknown>;
	return rest;
};

/**
 * A patch that changes nothing but settings.autoRun (when the project re-runs
 * itself, not how), settings.outcomes (how the outcome matrix reads a
 * sweep) or settings.outlook (how a seasonal outlook is set up) leaves
 * updated_at alone: updated_at is "the inputs changed since the latest run"
 * to the Runs tab, and none of them changes an input. The Settings
 * form sends every setting, so this compares the settings as they'd be
 * saved, not the keys sent.
 */
const onlyRunPolicy = (body: z.infer<typeof PatchBody>, stored: unknown, next: unknown) =>
	body.name === undefined &&
	body.description === undefined &&
	body.timeZone === undefined &&
	body.wuaName === undefined &&
	body.teamId === undefined &&
	next !== undefined &&
	stableJson(withoutRunPolicy(next)) === stableJson(withoutRunPolicy(mergeSettings(stored)));

export const projectRoutes = new Hono<AuthEnv>()
	.get('/', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<ProjectRow>(`${SELECT_PROJECT} ORDER BY p.updated_at DESC`);
			return c.json({ projects: rows.map(summary) });
		})
	)
	// The project list's outcome columns (issue #17): the portfolio's figures
	// for every project you can see, one query under RLS (portfolio.ts).
	.get('/outcomes', async (c) =>
		withUser(c.get('userId'), async (db) => c.json({ projects: await loadMyOutcomes(db, new Date()) }))
	)
	.post('/', async (c) => {
		const body = CreateBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			// Id generated here, not via RETURNING: RLS checks RETURNING rows against
			// the SELECT policy before the AFTER trigger has made us a member.
			const id = crypto.randomUUID();
			if (body.teamId) await requireTeamContributor(db, body.teamId);
			await db.query(
				`INSERT INTO project (id, name, description, created_by, team_id) VALUES ($1, $2, $3, app_current_user_id(), $4)`,
				[id, body.name, body.description ?? '', body.teamId ?? null]
			);
			return c.json({ project: full(await getProject(db, id)) }, 201);
		});
	})
	// A project document (what GET /:id/export.json writes, or the workbook
	// importer's project.json) as a new project: one transaction, fresh ids,
	// with the import report (importReport.ts) when the client sends one.
	// Its own body cap, the export cap, so anything the app exports imports
	// back (app.ts leaves this path out of the general 4 MB cap).
	.post(
		'/import',
		bodyLimit({
			maxSize: IMPORT_MAX_BYTES,
			onError: (c) =>
				c.json(
					{
						error: `project file larger than ${IMPORT_MB} MB — remove series the model doesn't need from the file, import it, then upload those series as CSV`
					},
					413
				)
		}),
		async (c) => {
			const query = ImportQuery.parse(c.req.query());
			const raw = await readJson(c);
			const data = parseProjectFile(raw);
			// The optional `importReport` beside the document (the review's notes
			// and unmapped report): validated before anything is written, and
			// stored in the same transaction, so a failure keeps neither.
			const report = parseImportReport(raw);
			const userId = c.get('userId');
			const project = await withUser(userId, async (db) => {
				const id = await insertProjectFile(db, data, { teamId: query.teamId ?? null });
				if (report) await insertImportReport(db, id, report);
				return full(await getProject(db, id));
			});
			// After the commit: a run that fails leaves the import standing (runError).
			const run = query.run === '1' || query.run === 'true' ? await runImported(userId, project.id) : {};
			return c.json({ project, ...run }, 201);
		}
	)
	// What the importer flagged when the project was imported (017_project_import).
	// `{ report: null }` for a project that wasn't: the Project page asks on every
	// visit, so "none" is an answer, not an error (issue #162). No access is still 404.
	.get('/:id/import-report', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ report: await latestImportReport(db, c.req.param('id')) });
		})
	)
	.get('/:id', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ project: full(await getProject(db, c.req.param('id'))) });
		})
	)
	.patch('/:id', async (c) => {
		const body = PatchBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, body.teamId !== undefined ? 'owner' : 'editor');
			if (body.teamId) await requireTeamContributor(db, body.teamId);
			if (body.teamId !== undefined) {
				// Someone who owns the project only through the current team would
				// lose access by moving it out; keep them as a direct owner.
				await db.query(
					`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, app_current_user_id(), 'owner')
					 ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner'`,
					[id]
				);
			}
			// A settings change is a revision of the project's inputs (history/record.ts).
			const before = body.settings ? await beginSettingsChange(db, id) : null;
			const current = await getProject(db, id);
			const settings = body.settings ? patchSettings(current.settings, body.settings) : undefined;
			const dqError = settings && body.settings?.dataQuality ? dataQualityPatchError(settings) : null;
			if (dqError) throw new ApiError(400, dqError);
			// An automated fit is the server's to write (issue #153): a save only carries the stored one back.
			const autoError = settings && body.settings?.fitRecord !== undefined ? autoFitRecordError(mergeSettings(current.settings), settings) : null;
			if (autoError) throw new ApiError(409, autoError);
			// A new sign-off of the calibration rules is dated by the server, and it and a withdrawal are audited with the account (issue #153).
			const signOff = settings && body.settings?.calibrationRules !== undefined ? signOffChange(current.settings, settings) : null;
			if (signOff === 'signed') settings!.calibrationRules = { ...settings!.calibrationRules, signedOff: { by: settings!.calibrationRules.signedOff!.by, on: new Date().toISOString().slice(0, 10) } };
			// The matrix's Reserve site: a change to a gauge is checked against the network and the rule tables being saved.
			const site = (body.settings as { outcomes?: { siteNodeId?: string | null } } | undefined)?.outcomes?.siteNodeId;
			if (settings && typeof site === 'string' && site !== resolveOutcomes(current.settings).siteNodeId) {
				await checkOutcomeSite(db, id, site, (settings as { ewrRules?: unknown }).ewrRules);
			}
			const changed = await db.query(
				`UPDATE project SET
					name = COALESCE($2, name),
					description = COALESCE($3, description),
					time_zone = COALESCE($8, time_zone),
					wua_name = CASE WHEN $9 THEN $10 ELSE wua_name END,
					settings = COALESCE($4::jsonb, settings),
					team_id = CASE WHEN $5 THEN $6::uuid ELSE team_id END,
					updated_at = CASE WHEN $7 THEN updated_at ELSE now() END
				 WHERE id = $1`,
				[id, body.name ?? null, body.description ?? null, settings ? JSON.stringify(settings) : null,
					body.teamId !== undefined, body.teamId ?? null, onlyRunPolicy(body, current.settings, settings), body.timeZone ?? null,
					body.wuaName !== undefined, body.wuaName ?? null]
			);
			mustChange(changed);
			if (before) await recordModelRevision(db, id, { source: 'settings_patch', before, reason: body.reason });
			if (signOff === 'signed') {
				await recordAudit(db, id, 'calibration_rules.signed_off', { revision: settings!.calibrationRules.revision, fullName: settings!.calibrationRules.signedOff!.by });
			} else if (signOff === 'withdrawn') {
				await recordAudit(db, id, 'calibration_rules.sign_off_withdrawn', { revision: settings!.calibrationRules.revision });
			}
			const fields = [
				body.name !== undefined && body.name !== current.name && 'name',
				body.description !== undefined && body.description !== current.description && 'description',
				body.timeZone !== undefined && body.timeZone !== current.time_zone && 'time_zone',
				body.wuaName !== undefined && body.wuaName !== current.wua_name && 'wua_name',
				body.teamId !== undefined && body.teamId !== current.team_id && 'team'
			].filter((f): f is string => !!f);
			const updated = await getProject(db, id);
			if (fields.length) {
				await recordAudit(db, id, 'project.changed', {
					fields,
					...(fields.includes('name') ? { from: current.name, to: updated.name } : {}),
					...(fields.includes('time_zone') ? { timeZone: { from: current.time_zone, to: updated.time_zone } } : {}),
					...(fields.includes('wua_name') ? { wuaName: { from: current.wua_name, to: updated.wua_name } } : {}),
					...(fields.includes('team') ? { team: updated.team_name } : {})
				});
			}
			return c.json({ project: full(updated) });
		});
	})
	.delete('/:id', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'owner');
			// A project that has nominated an evidence run keeps it and its
			// nomination history for good (issue #43); the project_evidence_guard
			// trigger (035) refuses the DELETE too, whoever runs it.
			const { rows: evidence } = await db.query<{ runId: string | null; runLabel: string | null; nominations: number }>(
				`SELECT n.run_id AS "runId", r.label AS "runLabel", count(*) OVER ()::int AS nominations
				 FROM run_nomination n LEFT JOIN model_run r ON r.id = n.run_id
				 WHERE n.project_id = $1 ORDER BY n.nominated_at DESC LIMIT 1`,
				[id]
			);
			if (evidence[0]) throw evidenceKept(evidence[0]);
			try {
				mustChange(await db.query('DELETE FROM project WHERE id = $1', [id]));
			} catch (err) {
				// A nomination that landed after the check above.
				if ((err as { code?: string }).code === PG_RESTRICT) throw evidenceKept(null);
				throw err;
			}
			return c.body(null, 204);
		})
	)
	.post('/:id/copy', async (c) => {
		const body = z.object({ name }).parse(await readJson(c));
		const srcId = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, srcId, 'viewer');
			const src = await getProject(db, srcId);
			const newId = crypto.randomUUID();
			// The copy stays in the team only if the copier may add projects to it
			// (team member or admin); a team viewer or a non-member gets a personal copy.
			let teamId: string | null = null;
			if (src.team_id) {
				const { rows } = await db.query<{ role: string | null }>('SELECT app_team_role($1) AS role', [src.team_id]);
				if (hasTeamRole(rows[0]?.role, 'member')) teamId = src.team_id;
			}
			// Fresh node ids for the copy; settings that name a node (the EWR rule tables' sites) follow them.
			const { model: copied, ids } = freshIds(await loadModel(db, srcId));
			await db.query(
				`INSERT INTO project (id, name, description, settings, created_by, team_id, time_zone)
				 VALUES ($1, $2, $3, $4, app_current_user_id(), $5, $6)`,
				[newId, body.name, src.description, JSON.stringify(remapSettingNodeIds(src.settings ?? {}, ids)), teamId, src.time_zone]
			);
			await saveModel(db, newId, copied);
			// A gauge record's site (084_gauge_records) follows its gauge to the copy's id; one whose
			// node has left the model has nothing to follow, so it keeps no site in the copy.
			const [from, to] = [[...ids.keys()], [...ids.values()]];
			await db.query(
				`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", product, product_version, day_boundary, site_node_id,
					source, source_unit, source_unit_factor)
				 SELECT $2, t.kind, t.name, t.unit, t.start_date, t."values", t.product, t.product_version, t.day_boundary, m.new_id,
					t.source, t.source_unit, t.source_unit_factor
				 FROM time_series t LEFT JOIN unnest($3::uuid[], $4::uuid[]) AS m(old_id, new_id) ON m.old_id = t.site_node_id
				 WHERE t.project_id = $1`,
				[srcId, newId, from, to]
			);
			// Notes don't copy (docs/data-model.md § Notes): a copy diverges, and a
			// note is its author's words about the original; RLS inserts a note only
			// as yourself, so keeping the author would mean bypassing it, and
			// re-authoring as the copier would misattribute. The original keeps them.
			// The copy's history starts with its first state; the original's stays with the original.
			await recordModelRevision(db, newId, { source: 'copy', before: null, reason: `Copied from "${src.name}"`.slice(0, 500) });
			return c.json({ project: full(await getProject(db, newId)) }, 201);
		});
	})
	// --- members -------------------------------------------------------------
	.get('/:id/members', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const { rows } = await db.query(
				`SELECT m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role, m.party
				 FROM project_member m JOIN app_user u ON u.id = m.user_id
				 WHERE m.project_id = $1 ORDER BY m.role DESC, u.display_name`,
				[c.req.param('id')]
			);
			return c.json({ members: rows });
		})
	)
	// Every add by email is an invite (issue #136): the same `{ invited: true,
	// invite }` whether or not the address has an account, so this never
	// tells the owner which addresses are registered, and an existing account
	// joins only when its holder accepts (POST /me/invites/:id/accept).
	.post('/:id/members', async (c) => {
		const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: RoleEnum }).parse(await readJson(c));
		const id = c.req.param('id');
		const invited = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			// The daily cap on adding by email (101_invite_throttle), counted before the address is looked up.
			await countInvites(c, db, 'project', id, 1);
			const account = await accountByEmail(db, body.email);
			// Already on the members list the owner can read: saying so tells them nothing new.
			if (account?.verified) {
				const { rows } = await db.query('SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2', [id, account.id]);
				if (rows[0]) throw new ApiError(409, 'already a member');
			}
			const result = await inviteByEmail(db, 'project', id, body.email, body.role, account);
			// No `mailed` flag: whether an email went out depends on the address's
			// account (an unverified one inside its verification cooldown gets none),
			// so the owner's History would tell them the address is registered.
			await recordAudit(db, id, 'invite.sent', { inviteId: result.invite.id, email: maskEmail(body.email), role: body.role });
			return result;
		});
		// Mail goes out after the transaction commits, and never fails the request.
		if (invited.mail) await trySendMail(invited.mail);
		return c.json({ invited: true, invite: invited.invite }, 201);
	})
	// A member's role, and their applying party (049: an applicant shares
	// applications only within their own party; '' or null takes them out of
	// every party, and a change ends the shares it no longer allows).
	.patch('/:id/members/:userId', async (c) => {
		const body = z
			.object({
				role: RoleEnum.optional(),
				party: z
					.string()
					.trim()
					.max(80)
					.nullable()
					.optional()
					.transform((p) => (p === '' ? null : p))
			})
			.strict()
			.refine((b) => b.role !== undefined || b.party !== undefined, 'give a role, a party or both')
			.parse(await readJson(c));
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			if (body.role !== undefined && body.role !== 'owner') await assertNotLastOwner(db, id, userId);
			const { rows: was } = await db.query<{ role: string; party: string | null }>('SELECT role, party FROM project_member WHERE project_id = $1 AND user_id = $2', [
				id,
				userId
			]);
			const { rows } = await db.query(
				`UPDATE project_member m SET role = COALESCE($3::project_role, m.role), party = CASE WHEN $4 THEN $5 ELSE m.party END FROM app_user u
				 WHERE m.project_id = $1 AND m.user_id = $2 AND u.id = m.user_id
				 RETURNING m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role, m.party`,
				[id, userId, body.role ?? null, body.party !== undefined, body.party ?? null]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			if (body.role !== undefined && was[0]?.role !== body.role) {
				await recordAudit(db, id, 'member.role', { userId, displayName: rows[0].displayName, from: was[0]?.role ?? null, to: body.role });
			}
			if (body.party !== undefined && (was[0]?.party ?? null) !== rows[0].party) {
				await recordAudit(db, id, 'member.party', { userId, displayName: rows[0].displayName, from: was[0]?.party ?? null, to: rows[0].party });
			}
			return c.json({ member: rows[0] });
		});
	})
	.delete('/:id/members/:userId', async (c) => {
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			// Anyone may leave, a farmer included; only an owner removes others.
			const role = await requireRole(db, id, 'farmer');
			const self = userId === c.get('userId');
			if (!self && role !== 'owner') throw new ApiError(403, 'requires owner role');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			await assertNotLastOwner(db, id, userId);
			// Recorded before the delete: afterwards someone who left can no
			// longer write to the project's log (audit_event_insert needs a member).
			const { rows: gone } = await db.query<{ role: string; display_name: string }>(
				`SELECT m.role, u.display_name FROM project_member m JOIN app_user u ON u.id = m.user_id WHERE m.project_id = $1 AND m.user_id = $2`,
				[id, userId]
			);
			if (!gone[0]) throw new ApiError(404, 'not found');
			// A farmer's links go with the membership (farm_link cascades): say whom
			// to re-link if they come back. Only viewers and above read every link;
			// a farmer leaving reads their own, which are the ones that go.
			const links = (await farmLinks(db, id)).filter((l) => l.userId === userId);
			await recordLinkChanges(db, id, links, [], 'member_removed');
			await recordAudit(db, id, 'member.removed', { userId, displayName: gone[0].display_name, role: gone[0].role, self });
			const { rowCount } = await db.query('DELETE FROM project_member WHERE project_id = $1 AND user_id = $2', [
				id,
				userId
			]);
			if (!rowCount) throw new ApiError(404, 'not found');
			return c.body(null, 204);
		});
	});

/**
 * Friendly 409 before the deferred DB trigger would abort the commit. Checked
 * *before* the change: afterwards a member who just left can no longer see
 * the member list through RLS.
 */
async function assertNotLastOwner(db: import('../db/tx.js').Db, projectId: string, userId: string) {
	const { rows } = await db.query<{ owners: number; target_is_owner: boolean }>(
		`SELECT count(*) FILTER (WHERE role = 'owner')::int AS owners,
			bool_or(user_id = $2 AND role = 'owner') AS target_is_owner
		 FROM project_member WHERE project_id = $1`,
		[projectId, userId]
	);
	if (rows[0]?.target_is_owner && rows[0].owners <= 1) {
		throw new ApiError(409, 'a project must keep at least one owner');
	}
}

/**
 * Placing a project in a team (create, move) needs a team role that may add
 * to it: member or admin. A team viewer only reads (403); a non-member gets 404.
 * RLS (project_insert / project_update, 008_team_viewer) enforces the same.
 */
async function requireTeamContributor(db: import('../db/tx.js').Db, teamId: string) {
	await requireTeamRole(db, teamId, 'member', 'team not found');
}
