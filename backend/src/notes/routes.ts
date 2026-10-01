// Notes and comments (roadmap WP-2.7, 037_notes.sql; docs/api.md § Notes).
//
// Plain-text notes kept against a node, a run, a setting, a scenario or the
// project. The min role is farmer on every route, and RLS does the scoping: a
// farmer reads and writes only `farm` notes on their linked nodes, and never
// sees a `team` note. A scenario note (WP-3.15, 115_scenario_share_notes.sql)
// has one of three more audiences, `assessors`, `parties` and
// `public_participation` (docs/data-model.md § Notes has the matrix), and
// every edit of one keeps the text it replaced (note_revision). A note on an
// evidence pack (128_pack_share_notes.sql) is `team` (whoever reads the pack)
// or `public_participation` (posted while the pack is issued and has a live
// share link), its edits kept the same way. The checks
// here repeat the rules for clear 403s; the policies are what hold if a check
// is missed.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, mustChange, notFound } from '../http/errors.js';
import { rank, requireRole, UUID, type Role } from '../projects/access.js';

/** Longest note body (the 037 CHECK). */
export const NOTE_MAX = 4000;
/** Most notes one list returns. */
export const NOTES_LIMIT_MAX = 500;
const NOTES_LIMIT_DEFAULT = 100;

/** A settings path (`calibration.a`) or group (`ewr`); the 037 CHECK. */
export const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

const uuid = z.string().regex(UUID, 'not a valid id');
const settingKey = z.string().max(100).regex(SETTING_KEY, 'not a settings key');

/** Who reads a note (037, 115): the two node-note audiences and the three on a scenario. */
export const NOTE_VISIBILITIES = ['team', 'farm', 'assessors', 'parties', 'public_participation'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];
/** The audiences only a scenario note has (note_participation_on_scenario). */
export const SCENARIO_VISIBILITIES = ['assessors', 'parties', 'public_participation'] as const;
/** The audiences a pack note may have (note_pack_audience). */
export const PACK_VISIBILITIES = ['team', 'public_participation'] as const;
const onScenarioOnly = (v: string | undefined) => v === 'assessors' || v === 'parties';
const Body = z
	.string()
	.trim()
	.min(1, 'a note needs some text')
	.max(NOTE_MAX)
	.refine((s) => !s.includes('\u0000'), 'a note cannot contain NUL characters');

export const CreateNote = z
	.object({
		body: Body,
		nodeId: uuid.optional(),
		runId: uuid.optional(),
		settingKey: settingKey.optional(),
		scenarioId: uuid.optional(),
		packId: uuid.optional(),
		visibility: z.enum(NOTE_VISIBILITIES).optional(),
		/**
		 * A public comment's "give my name and email to the applicant for the register of interested and affected
		 * parties (GN R267 reg 18)" (166_public_participation). Only on a public-participation note.
		 */
		registerConsent: z.boolean().optional()
	})
	.strict()
	.refine(
		(b) => [b.nodeId, b.runId, b.settingKey, b.scenarioId, b.packId].filter((t) => t !== undefined).length <= 1,
		'a note is about one thing: a node, a run, a setting, a scenario or an evidence pack'
	)
	.refine((b) => b.visibility !== 'farm' || b.nodeId !== undefined, 'only a note on a farm can be shown to its farmers')
	.refine((b) => !onScenarioOnly(b.visibility) || b.scenarioId !== undefined, 'only a note on a scenario can be for the assessors or the parties')
	.refine(
		(b) => b.visibility !== 'public_participation' || b.scenarioId !== undefined || b.packId !== undefined,
		'only a note on a scenario or an evidence pack can be for public participation'
	)
	.refine((b) => !b.registerConsent || b.scenarioId !== undefined || b.packId !== undefined, 'only a public comment can give your name and email to the applicant’s register');

export const EditNote = z.object({ body: Body }).strict();

export const NotesQuery = z
	.object({
		nodeId: uuid.optional(),
		runId: uuid.optional(),
		/** Exact key or group: `calibration` matches `calibration` and `calibration.*`. */
		settingKey: settingKey.optional(),
		scenarioId: uuid.optional(),
		packId: uuid.optional(),
		/** Only notes on this kind of target (`project`: the project-level ones). */
		target: z.enum(['project', 'node', 'run', 'setting', 'scenario', 'pack']).optional(),
		limit: z.coerce.number().int().min(1).max(NOTES_LIMIT_MAX).optional()
	})
	.strict();

export type NoteTarget = 'project' | 'node' | 'run' | 'setting' | 'scenario' | 'pack';

interface NoteRow {
	id: string;
	body: string;
	author_id: string | null;
	author_name: string | null;
	created_at: Date;
	edited_at: Date | null;
	node_id: string | null;
	node_name: string | null;
	run_id: string | null;
	setting_key: string | null;
	scenario_id: string | null;
	pack_id: string | null;
	visibility: NoteVisibility;
}

export interface Note {
	id: string;
	body: string;
	/** Display name; null once that account is gone. */
	author: string | null;
	createdAt: string;
	editedAt: string | null;
	target: NoteTarget;
	nodeId: string | null;
	/** The node's name, when the caller can see the node. */
	nodeName: string | null;
	runId: string | null;
	settingKey: string | null;
	scenarioId: string | null;
	packId: string | null;
	visibility: NoteVisibility;
	/** The caller wrote it (and may edit it). */
	mine: boolean;
	/** The caller may delete it: its author, or an editor. */
	canDelete: boolean;
}

export const targetOf = (r: Pick<NoteRow, 'node_id' | 'run_id' | 'setting_key' | 'scenario_id'> & { pack_id?: string | null }): NoteTarget =>
	r.node_id ? 'node' : r.run_id ? 'run' : r.setting_key ? 'setting' : r.scenario_id ? 'scenario' : r.pack_id ? 'pack' : 'project';

export function toNote(r: NoteRow, userId: string, role: Role): Note {
	const mine = r.author_id === userId;
	return {
		id: r.id,
		body: r.body,
		author: r.author_name,
		createdAt: r.created_at.toISOString(),
		editedAt: r.edited_at?.toISOString() ?? null,
		target: targetOf(r),
		nodeId: r.node_id,
		nodeName: r.node_name,
		runId: r.run_id,
		settingKey: r.setting_key,
		scenarioId: r.scenario_id,
		packId: r.pack_id,
		visibility: r.visibility,
		mine,
		canDelete: mine || rank[role] >= rank.editor
	};
}

// The API lists no deleted note, not even to the editors RLS lets see them.
const SELECT_NOTES = `
	SELECT n.id, n.body, n.author_id,
		-- A link participant is no member (166): their name, which the link shows, comes from app_link_comment_author.
		COALESCE(u.display_name, CASE WHEN n.share_link_id IS NOT NULL THEN app_link_comment_author(n.id) END) AS author_name, n.created_at, n.edited_at,
		n.node_id, nd.name AS node_name, n.run_id, n.setting_key, n.scenario_id, n.pack_id, n.visibility
	FROM note n
	LEFT JOIN app_user u ON u.id = n.author_id
	LEFT JOIN node nd ON nd.id = n.node_id
	WHERE n.project_id = $1 AND n.deleted_at IS NULL`;

async function loadNote(db: Db, projectId: string, noteId: string): Promise<NoteRow> {
	if (!UUID.test(noteId)) throw notFound();
	const { rows } = await db.query<NoteRow>(`${SELECT_NOTES} AND n.id = $2`, [projectId, noteId]);
	if (!rows[0]) throw notFound();
	return rows[0];
}

/**
 * Whether the caller may post a note with this visibility on scenario
 * `scenarioId` (the insert policy's rule, for a clear answer): 404 when the
 * scenario isn't one they can read or comment on, 403 when it is but not
 * with that audience. Returns the visibility to use: the one asked for, or
 * the caller's natural audience (an assessor: the assessors; one of its
 * parties: the parties; anyone else: public participation).
 */
async function scenarioVisibility(db: Db, projectId: string, scenarioId: string, asked: NoteVisibility | undefined): Promise<NoteVisibility> {
	const { rows } = await db.query<{ readable: boolean; party: boolean; commentable: boolean; assessor: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM scenario WHERE id = $1 AND project_id = $2) AS readable,
			app_scenario_party($1) AS party,
			app_scenario_commentable($2, $1) AS commentable,
			app_has_role($2, 'editor') AS assessor`,
		[scenarioId, projectId]
	);
	const r = rows[0]!;
	// The scenario row is read under RLS (another project's, or a draft, isn't there); a party always reads it.
	if (!r.readable && !r.commentable) throw notFound();
	const visibility: NoteVisibility = asked ?? (r.assessor && r.readable ? 'assessors' : r.party ? 'parties' : 'public_participation');
	const { rows: ok } = await db.query<{ ok: boolean }>(
		`SELECT CASE WHEN $3 = 'team' THEN app_has_role($1, 'viewer') AND app_scenario_readable($2)
			WHEN $3 = 'farm' THEN false
			ELSE app_scenario_note_writable($1, $2, $3) END AS ok`,
		[projectId, scenarioId, visibility]
	);
	if (!ok[0]?.ok && visibility === 'public_participation') throw ApiError.coded(403, 'note_comment_closed', 'this scenario is not open for public comment');
	if (!ok[0]?.ok) throw ApiError.coded(403, 'note_audience_denied', `you can't post a note with visibility ${visibility} on this scenario`);
	return visibility;
}

/**
 * Whether the caller may post a note with this visibility on evidence pack
 * `packId` (the insert policy's rule, for a clear answer): 404 when it isn't a
 * pack they read or can comment on, 403 when it is but not with that
 * audience. Returns the visibility to use: the one asked for, or `team` for
 * a reader of the pack and public participation for anyone else.
 */
async function packVisibility(db: Db, projectId: string, packId: string, asked: NoteVisibility | undefined): Promise<NoteVisibility> {
	const { rows } = await db.query<{ readable: boolean; commentable: boolean; record: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM evidence_pack WHERE id = $1 AND project_id = $2) AS readable,
			app_pack_commentable($2, $1) AS commentable,
			app_pack_note_visible($2, $1, NULL) AS record`,
		[packId, projectId]
	);
	const r = rows[0]!;
	// The pack is read under RLS: another project's isn't there, nor one a contributor can't read unless it is
	// open for comment, or its comment record is theirs to read (shared, then withdrawn or superseded: a clear 403 below).
	if (!r.readable && !r.commentable && !r.record) throw notFound();
	const visibility: NoteVisibility = asked ?? (r.readable ? 'team' : 'public_participation');
	if (!(PACK_VISIBILITIES as readonly string[]).includes(visibility))
		throw ApiError.coded(403, 'note_audience_denied', `a note on an evidence pack is for the team or for public participation, not ${visibility}`);
	const { rows: ok } = await db.query<{ ok: boolean }>(
		`SELECT CASE WHEN $3 = 'team' THEN app_has_role($1, 'viewer') AND EXISTS (SELECT 1 FROM evidence_pack WHERE id = $2 AND project_id = $1)
			ELSE app_pack_note_writable($1, $2) END AS ok`,
		[projectId, packId, visibility]
	);
	if (!ok[0]?.ok && visibility === 'public_participation') throw ApiError.coded(403, 'note_comment_closed', 'this evidence pack is not open for public comment');
	if (!ok[0]?.ok) throw ApiError.coded(403, 'note_audience_denied', `you can't post a note with visibility ${visibility} on this evidence pack`);
	return visibility;
}

/** The register opt-in (166), only on a public comment: anything else is a 400, not a silent drop. */
function registerConsent(asked: boolean | undefined, visibility: NoteVisibility): boolean {
	if (asked && visibility !== 'public_participation') throw new ApiError(400, 'only a public comment can give your name and email to the applicant’s register');
	return asked ?? false;
}

/** GET/POST /projects/:id/notes, GET /projects/:id/notes/counts, PATCH|DELETE /projects/:id/notes/:noteId, GET …/notes/:noteId/revisions. */
export const noteRoutes = new Hono<AuthEnv>()
	.get('/:id/notes', async (c) => {
		const q = NotesQuery.parse(c.req.query());
		const id = c.req.param('id');
		const userId = c.get('userId');
		return withUser(userId, async (db) => {
			const role = await requireRole(db, id, 'farmer');
			const where: string[] = [];
			const params: unknown[] = [id];
			const add = (sql: string, v: unknown) => {
				params.push(v);
				where.push(sql.replaceAll('?', `$${params.length}`));
			};
			if (q.nodeId) add('n.node_id = ?', q.nodeId);
			if (q.runId) add('n.run_id = ?', q.runId);
			if (q.settingKey) add(`(n.setting_key = ? OR starts_with(n.setting_key, ? || '.'))`, q.settingKey);
			if (q.scenarioId) add('n.scenario_id = ?', q.scenarioId);
			if (q.packId) add('n.pack_id = ?', q.packId);
			if (q.target === 'project') where.push('n.node_id IS NULL AND n.run_id IS NULL AND n.setting_key IS NULL AND n.scenario_id IS NULL AND n.pack_id IS NULL');
			if (q.target === 'scenario') where.push('n.scenario_id IS NOT NULL');
			if (q.target === 'pack') where.push('n.pack_id IS NOT NULL');
			if (q.target === 'node') where.push('n.node_id IS NOT NULL');
			if (q.target === 'run') where.push('n.run_id IS NOT NULL');
			if (q.target === 'setting') where.push('n.setting_key IS NOT NULL');
			params.push(q.limit ?? NOTES_LIMIT_DEFAULT);
			const { rows } = await db.query<NoteRow>(
				`${SELECT_NOTES}${where.map((w) => ` AND ${w}`).join('')} ORDER BY n.created_at DESC, n.id LIMIT $${params.length}`,
				params
			);
			return c.json({ notes: rows.map((r) => toNote(r, userId, role)) });
		});
	})
	.get('/:id/notes/counts', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'farmer');
			const { rows } = await db.query<{ node_id: string | null; run_id: string | null; setting_key: string | null; scenario_id: string | null; pack_id: string | null; n: number }>(
				`SELECT node_id, run_id, setting_key, scenario_id, pack_id, count(*)::integer AS n FROM note
				 WHERE project_id = $1 AND deleted_at IS NULL
				 GROUP BY node_id, run_id, setting_key, scenario_id, pack_id`,
				[id]
			);
			const counts = {
				project: 0,
				nodes: {} as Record<string, number>,
				runs: {} as Record<string, number>,
				settings: {} as Record<string, number>,
				scenarios: {} as Record<string, number>,
				packs: {} as Record<string, number>
			};
			for (const r of rows) {
				if (r.node_id) counts.nodes[r.node_id] = r.n;
				else if (r.run_id) counts.runs[r.run_id] = r.n;
				else if (r.setting_key) counts.settings[r.setting_key] = r.n;
				else if (r.scenario_id) counts.scenarios[r.scenario_id] = r.n;
				else if (r.pack_id) counts.packs[r.pack_id] = r.n;
				else counts.project = r.n;
			}
			return c.json(counts);
		})
	)
	.post('/:id/notes', async (c) => {
		const body = CreateNote.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		return withUser(userId, async (db) => {
			const role = await requireRole(db, id, 'farmer');
			if (body.scenarioId) {
				// A scenario note: an applicant, their consultant, an NGO (a viewer) or an assessor.
				if (rank[role] < rank.contributor) throw ApiError.coded(403, 'note_audience_denied', 'a farmer can’t comment on a scenario');
				const visibility = await scenarioVisibility(db, id, body.scenarioId, body.visibility);
				const consent = registerConsent(body.registerConsent, visibility);
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO note (project_id, author_id, body, scenario_id, visibility, register_consent)
					 VALUES ($1, app_current_user_id(), $2, $3, $4, $5) RETURNING id`,
					[id, body.body, body.scenarioId, visibility, consent]
				);
				return c.json({ note: toNote(await loadNote(db, id, rows[0]!.id), userId, role) }, 201);
			}
			if (body.packId) {
				// A pack note: the team (whoever reads the pack), or a public comment from any member contributor+ while it is open.
				if (rank[role] < rank.contributor) throw ApiError.coded(403, 'note_audience_denied', 'a farmer can’t comment on an evidence pack');
				const visibility = await packVisibility(db, id, body.packId, body.visibility);
				const consent = registerConsent(body.registerConsent, visibility);
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO note (project_id, author_id, body, pack_id, visibility, register_consent)
					 VALUES ($1, app_current_user_id(), $2, $3, $4, $5) RETURNING id`,
					[id, body.body, body.packId, visibility, consent]
				);
				return c.json({ note: toNote(await loadNote(db, id, rows[0]!.id), userId, role) }, 201);
			}
			// An applicant (contributor, WP-3.3) reads what a farmer with the same
			// links reads (045_contributor_scope), so they note only their own farm too.
			const farmer = role === 'farmer' || role === 'contributor';
			const visibility = body.visibility ?? (farmer ? 'farm' : 'team');
			if (farmer && (!body.nodeId || visibility !== 'farm')) {
				throw ApiError.coded(403, 'note_farmer_own_farm', 'a farmer may add notes only to their own farm, shown to the farm');
			}
			if (body.nodeId) {
				// RLS: a farmer sees only their linked farms (and gauges).
				const { rows } = await db.query<{ kind: string; linked: boolean }>(
					'SELECT kind, id IN (SELECT app_farm_nodes($2)) AS linked FROM node WHERE id = $1 AND project_id = $2',
					[body.nodeId, id]
				);
				if (!rows[0]) throw notFound();
				if (farmer && !rows[0].linked) throw ApiError.coded(403, 'note_farmer_own_farm', 'a farmer may add notes only to their own farm, shown to the farm');
				if (visibility === 'farm' && rows[0].kind !== 'farm') throw ApiError.coded(400, 'note_farm_visibility', 'only a note on a farm can be shown to its farmers');
			}
			if (body.runId) {
				// Farmers never reach here (above); a run of another project is not found.
				const { rows } = await db.query('SELECT 1 FROM model_run WHERE id = $1 AND project_id = $2', [body.runId, id]);
				if (!rows[0]) throw notFound();
			}
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO note (project_id, author_id, body, node_id, run_id, setting_key, visibility)
				 VALUES ($1, app_current_user_id(), $2, $3, $4, $5, $6) RETURNING id`,
				[id, body.body, body.nodeId ?? null, body.runId ?? null, body.settingKey ?? null, visibility]
			);
			return c.json({ note: toNote(await loadNote(db, id, rows[0]!.id), userId, role) }, 201);
		});
	})
	.patch('/:id/notes/:noteId', async (c) => {
		const body = EditNote.parse(await readJson(c));
		const { id, noteId } = c.req.param();
		const userId = c.get('userId');
		return withUser(userId, async (db) => {
			const role = await requireRole(db, id, 'farmer');
			const note = await loadNote(db, id, noteId);
			if (note.author_id !== userId) throw ApiError.coded(403, 'note_author_only', 'only the author may edit a note');
			mustChange(await db.query('UPDATE note SET body = $3 WHERE id = $1 AND project_id = $2', [noteId, id, body.body]));
			return c.json({ note: toNote(await loadNote(db, id, noteId), userId, role) });
		});
	})
	.delete('/:id/notes/:noteId', async (c) => {
		const { id, noteId } = c.req.param();
		const userId = c.get('userId');
		return withUser(userId, async (db) => {
			const role = await requireRole(db, id, 'farmer');
			const note = await loadNote(db, id, noteId);
			const own = note.author_id === userId;
			if (!own && rank[role] < rank.editor) throw ApiError.coded(403, 'note_delete_denied', 'only the author or an editor may delete a note');
			// No RETURNING: a deleted note is no longer visible to its author (unless an editor).
			mustChange(await db.query('UPDATE note SET deleted_at = now() WHERE id = $1 AND project_id = $2', [noteId, id]));
			// Never the body: the log says whose note, about what, and that it was hidden.
			await recordAudit(db, id, 'note.deleted', {
				noteId,
				target: targetOf(note),
				nodeId: note.node_id,
				nodeName: note.node_name,
				runId: note.run_id,
				settingKey: note.setting_key,
				scenarioId: note.scenario_id,
				packId: note.pack_id,
				visibility: note.visibility,
				author: note.author_name,
				// So deleting the author's account can pseudonymise this event (048_account_deletion.sql).
				authorId: note.author_id,
				own
			});
			return c.body(null, 204);
		});
	})
	.get('/:id/notes/:noteId/revisions', async (c) => {
		const { id, noteId } = c.req.param();
		const userId = c.get('userId');
		return withUser(userId, async (db) => {
			const role = await requireRole(db, id, 'farmer');
			// Readable exactly as the note is (note_revision_select), and only a listed note's.
			const note = await loadNote(db, id, noteId);
			const { rows } = await db.query<{ body: string; written_at: Date; edited_at: Date }>(
				'SELECT body, written_at, edited_at FROM note_revision WHERE note_id = $1 AND project_id = $2 ORDER BY edited_at, id',
				[noteId, id]
			);
			return c.json({
				note: toNote(note, userId, role),
				// Each earlier text, oldest first: what it said from writtenAt until editedAt.
				revisions: rows.map((r) => ({ body: r.body, writtenAt: r.written_at.toISOString(), editedAt: r.edited_at.toISOString() }))
			});
		});
	});
