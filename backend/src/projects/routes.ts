import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import {
	beginSettingsChange,
	farmLinks,
	maskEmail,
	Reason,
	recordAudit,
	recordLinkChanges,
	recordModelRevision
} from '../history/record.js';
import { dropInvite, inviteByEmail } from '../invites/invites.js';
import { trySendMail } from '../mail/transport.js';
import { loadModel, saveModel } from '../model/store.js';
import { hasTeamRole, requireTeamRole } from '../teams/access.js';
import { requireRole, UUID, type Role } from './access.js';
import { mergeSettings, patchSettings, remapSettingNodeIds, SettingsPatch } from './settings.js';
import { resolveAutoRun } from '../runs/autoRun.js';
import { readJson } from '../http/body.js';
import { bodyLimit } from 'hono/body-limit';
import { freshIds, IMPORT_MAX_BYTES, insertProjectFile, parseProjectFile, runImported } from './import.js';
import { insertImportReport, latestImportReport, parseImportReport } from './importReport.js';

type ProjectRow = {
	id: string;
	name: string;
	description: string;
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
	/** When the project's pending re-run is due, or null (041_auto_rerun). */
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
// settings.autoRun isn't in the engine's defaults (it's no model input), so it is resolved here: clients see every field.
// rerunQueuedFor: when the pending re-run is due (the header's "Re-run queued for 14:05"), or null.
const full = (r: ProjectRow) => ({
	...summary(r),
	settings: { ...mergeSettings(r.settings), autoRun: resolveAutoRun(r.settings) },
	rerunQueuedFor: r.rerun_queued_for ? r.rerun_queued_for.toISOString() : null
});

// RLS already limits rows to projects the user can see (directly or via a
// team); app_project_role gives the effective role. The team name is only
// visible to team members (team RLS), so it may be null for direct members.
const SELECT_PROJECT = `
	SELECT p.id, p.name, p.description, p.settings, p.created_at, p.updated_at, p.team_id,
		t.name AS team_name, app_project_role(p.id) AS role,
		-- Data freshness and last run for the project list, in the same query
		-- (both subqueries use the (project_id…) indexes; no N+1 from the client).
		-- Freshness is recorded rain (catchment or CHIRPS): what a run is driven
		-- by. A forecast runs into the future and observed flow only scores a
		-- run, so either one would read "up to date" while the rain lags.
		(SELECT max(ts.start_date + cardinality(ts."values") - 1) FROM time_series ts
			WHERE ts.project_id = p.id AND ts.kind IN ('rain_catchment_mm', 'rain_chirps_mm') AND cardinality(ts."values") > 0) AS data_until,
		(SELECT max(r.created_at) FROM model_run r WHERE r.project_id = p.id) AS last_run_at,
		-- The current publication's date (022_publication; its partial unique
		-- index answers it). Every member reads run_publication, farmers too.
		(SELECT pub.published_at FROM run_publication pub
			WHERE pub.project_id = p.id AND pub.superseded_at IS NULL) AS published_at,
		-- When the pending re-run (manual or automatic, 041_auto_rerun) is due;
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
	settings: SettingsPatch.optional(),
	/** Why the settings changed, kept with the revision (ignored without settings). */
	reason: Reason
});
const RoleEnum = z.enum(['viewer', 'editor', 'owner']);
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
function evidenceKept(run: { runId: string; runLabel: string; nominations: number } | null) {
	const named = run ? `"${run.runLabel || 'Untitled run'}" is its nominated evidence run` : 'it has a nominated evidence run';
	return new ApiError(
		409,
		`this project can't be deleted: ${named}, and a project keeps its evidence run and nomination history for good. ` +
			'A nomination can be replaced but not withdrawn; copy the project to start again without it.',
		{ evidenceRun: run ? { id: run.runId, label: run.runLabel } : null, nominations: run?.nominations ?? null }
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
const withoutAutoRun = (settings: unknown) => {
	const { autoRun: _autoRun, ...rest } = settings as Record<string, unknown>;
	return rest;
};

/**
 * A patch that changes nothing but settings.autoRun (when the project re-runs
 * itself, not how) leaves updated_at alone: updated_at is "the inputs changed
 * since the latest run" to the Runs tab, and turning automatic runs on
 * changes no input. The Settings form sends every setting, so this compares
 * the settings as they'd be saved, not the keys sent.
 */
const onlyAutoRun = (body: z.infer<typeof PatchBody>, stored: unknown, next: unknown) =>
	body.name === undefined &&
	body.description === undefined &&
	body.teamId === undefined &&
	next !== undefined &&
	stableJson(withoutAutoRun(next)) === stableJson(withoutAutoRun(mergeSettings(stored)));

export const projectRoutes = new Hono<AuthEnv>()
	.get('/', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<ProjectRow>(`${SELECT_PROJECT} ORDER BY p.updated_at DESC`);
			return c.json({ projects: rows.map(summary) });
		})
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
	.get('/:id/import-report', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const report = await latestImportReport(db, c.req.param('id'));
			if (!report) throw new ApiError(404, 'no import report');
			return c.json({ report });
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
			await db.query(
				`UPDATE project SET
					name = COALESCE($2, name),
					description = COALESCE($3, description),
					settings = COALESCE($4::jsonb, settings),
					team_id = CASE WHEN $5 THEN $6::uuid ELSE team_id END,
					updated_at = CASE WHEN $7 THEN updated_at ELSE now() END
				 WHERE id = $1`,
				[id, body.name ?? null, body.description ?? null, settings ? JSON.stringify(settings) : null,
					body.teamId !== undefined, body.teamId ?? null, onlyAutoRun(body, current.settings, settings)]
			);
			if (before) await recordModelRevision(db, id, { source: 'settings_patch', before, reason: body.reason });
			const fields = [
				body.name !== undefined && body.name !== current.name && 'name',
				body.description !== undefined && body.description !== current.description && 'description',
				body.teamId !== undefined && body.teamId !== current.team_id && 'team'
			].filter((f): f is string => !!f);
			const updated = await getProject(db, id);
			if (fields.length) {
				await recordAudit(db, id, 'project.changed', {
					fields,
					...(fields.includes('name') ? { from: current.name, to: updated.name } : {}),
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
			const { rows: evidence } = await db.query<{ runId: string; runLabel: string; nominations: number }>(
				`SELECT n.run_id AS "runId", r.label AS "runLabel", count(*) OVER ()::int AS nominations
				 FROM run_nomination n JOIN model_run r ON r.id = n.run_id
				 WHERE n.project_id = $1 ORDER BY n.nominated_at DESC LIMIT 1`,
				[id]
			);
			if (evidence[0]) throw evidenceKept(evidence[0]);
			try {
				await db.query('DELETE FROM project WHERE id = $1', [id]);
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
				`INSERT INTO project (id, name, description, settings, created_by, team_id)
				 VALUES ($1, $2, $3, $4, app_current_user_id(), $5)`,
				[newId, body.name, src.description, JSON.stringify(remapSettingNodeIds(src.settings ?? {}, ids)), teamId]
			);
			await saveModel(db, newId, copied);
			await db.query(
				`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", product, product_version, day_boundary)
				 SELECT $2, kind, name, unit, start_date, "values", product, product_version, day_boundary FROM time_series WHERE project_id = $1`,
				[srcId, newId]
			);
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
				`SELECT m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role
				 FROM project_member m JOIN app_user u ON u.id = m.user_id
				 WHERE m.project_id = $1 ORDER BY m.role DESC, u.display_name`,
				[c.req.param('id')]
			);
			return c.json({ members: rows });
		})
	)
	.post('/:id/members', async (c) => {
		const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: RoleEnum }).parse(await readJson(c));
		const id = c.req.param('id');
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const { rows: users } = await db.query<{ id: string; email: string; display_name: string; verified: boolean }>(
				'SELECT id, email, display_name, email_verified_at IS NOT NULL AS verified FROM app_user WHERE email = $1',
				[body.email]
			);
			const user = users[0];
			// No account yet, or one that never proved it owns the address: invite
			// by email (they join once the address is verified), so pre-registering
			// a colleague's address can't get you added in their place.
			if (!user?.verified) {
				const invited = await inviteByEmail(db, 'project', id, body.email, body.role, user?.id);
				await recordAudit(db, id, 'invite.sent', { inviteId: invited.invite.id, email: maskEmail(body.email), role: body.role, mailed: !!invited.mail });
				return { invited };
			}
			const { rowCount } = await db.query(
				`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				[id, user.id, body.role]
			);
			if (!rowCount) throw new ApiError(409, 'already a member');
			await dropInvite(db, 'project', id, user.email);
			await recordAudit(db, id, 'member.added', { userId: user.id, displayName: user.display_name, role: body.role });
			return { member: { userId: user.id, email: user.email, displayName: user.display_name, role: body.role } };
		});
		// Mail goes out after the transaction commits, and never fails the request.
		if (result.invited) {
			if (result.invited.mail) await trySendMail(result.invited.mail);
			return c.json({ invited: true, invite: result.invited.invite }, 201);
		}
		return c.json({ member: result.member }, 201);
	})
	.patch('/:id/members/:userId', async (c) => {
		const body = z.object({ role: RoleEnum }).parse(await readJson(c));
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			if (body.role !== 'owner') await assertNotLastOwner(db, id, userId);
			const { rows: was } = await db.query<{ role: string }>('SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2', [id, userId]);
			const { rows } = await db.query(
				`UPDATE project_member m SET role = $3 FROM app_user u
				 WHERE m.project_id = $1 AND m.user_id = $2 AND u.id = m.user_id
				 RETURNING m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role`,
				[id, userId, body.role]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			if (was[0]?.role !== body.role) {
				await recordAudit(db, id, 'member.role', { userId, displayName: rows[0].displayName, from: was[0]?.role ?? null, to: body.role });
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
