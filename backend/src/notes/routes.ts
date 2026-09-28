// Notes and comments (roadmap WP-2.7, 037_notes.sql; docs/api.md § Notes).
//
// Plain-text notes kept against a node, a run, a setting or the project.
// The min role is farmer on every route, and RLS does the scoping: a farmer
// reads and writes only `farm` notes on their linked nodes, and never sees a
// `team` note. The checks here repeat the rules for clear 403s; the policies
// are what hold if a check is missed.
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
		visibility: z.enum(['team', 'farm']).optional()
	})
	.strict()
	.refine((b) => [b.nodeId, b.runId, b.settingKey].filter((t) => t !== undefined).length <= 1, 'a note is about one thing: a node, a run or a setting')
	.refine((b) => b.visibility !== 'farm' || b.nodeId !== undefined, 'only a note on a farm can be shown to its farmers');

export const EditNote = z.object({ body: Body }).strict();

export const NotesQuery = z
	.object({
		nodeId: uuid.optional(),
		runId: uuid.optional(),
		/** Exact key or group: `calibration` matches `calibration` and `calibration.*`. */
		settingKey: settingKey.optional(),
		/** Only notes on this kind of target (`project`: the project-level ones). */
		target: z.enum(['project', 'node', 'run', 'setting']).optional(),
		limit: z.coerce.number().int().min(1).max(NOTES_LIMIT_MAX).optional()
	})
	.strict();

export type NoteTarget = 'project' | 'node' | 'run' | 'setting';

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
	visibility: 'team' | 'farm';
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
	visibility: 'team' | 'farm';
	/** The caller wrote it (and may edit it). */
	mine: boolean;
	/** The caller may delete it: its author, or an editor. */
	canDelete: boolean;
}

export const targetOf = (r: Pick<NoteRow, 'node_id' | 'run_id' | 'setting_key'>): NoteTarget =>
	r.node_id ? 'node' : r.run_id ? 'run' : r.setting_key ? 'setting' : 'project';

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
		visibility: r.visibility,
		mine,
		canDelete: mine || rank[role] >= rank.editor
	};
}

// The API lists no deleted note, not even to the editors RLS lets see them.
const SELECT_NOTES = `
	SELECT n.id, n.body, n.author_id, u.display_name AS author_name, n.created_at, n.edited_at,
		n.node_id, nd.name AS node_name, n.run_id, n.setting_key, n.visibility
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

/** GET/POST /projects/:id/notes, GET /projects/:id/notes/counts, PATCH|DELETE /projects/:id/notes/:noteId. */
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
			if (q.target === 'project') where.push('n.node_id IS NULL AND n.run_id IS NULL AND n.setting_key IS NULL');
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
			const { rows } = await db.query<{ node_id: string | null; run_id: string | null; setting_key: string | null; n: number }>(
				`SELECT node_id, run_id, setting_key, count(*)::integer AS n FROM note
				 WHERE project_id = $1 AND deleted_at IS NULL
				 GROUP BY node_id, run_id, setting_key`,
				[id]
			);
			const counts = { project: 0, nodes: {} as Record<string, number>, runs: {} as Record<string, number>, settings: {} as Record<string, number> };
			for (const r of rows) {
				if (r.node_id) counts.nodes[r.node_id] = r.n;
				else if (r.run_id) counts.runs[r.run_id] = r.n;
				else if (r.setting_key) counts.settings[r.setting_key] = r.n;
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
				visibility: note.visibility,
				author: note.author_name,
				// So deleting the author's account can pseudonymise this event (048_account_deletion.sql).
				authorId: note.author_id,
				own
			});
			return c.body(null, 204);
		});
	});
