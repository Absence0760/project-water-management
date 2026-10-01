// The public-participation record of one application, for the applicant's
// GN R267 reg 19 report (164_public_participation; licensing positions, build
// list item 11; provisional position, pre-counsel research, 2026-10-01;
// docs/api.md § Applications → Public participation, docs/scenarios.md
// § Sharing and comments).
//
// GET /projects/:id/scenarios/:sid/participation-export[?format=csv]: every
// public comment on the application and on its evidence packs, with the
// author's display name, dates, earlier texts and moderation state, laid out
// under Annexure D item 8's headings by the print page. A commenter's email
// is in it only when they ticked "give my name and email to the applicant for
// the register of interested and affected parties (reg 18)". For the
// application's owner (the applicant compiles the report, reg 19(1)) and the
// editors who read it; everyone else gets 404. The database builds it
// (app_participation_export, SECURITY DEFINER: a contributor reads no other
// account's email under RLS); the mapping below applies the shape again
// field by field. Every download is in the audit log (who took the emails).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { csvTooLarge, csvDownload } from '../export/download.js';
import { csvRow, exportFilename } from '../export/csv.js';
import { recordAudit } from '../history/record.js';
import { notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';

export type ParticipationState = 'shown' | 'withdrawn' | 'removed';

export interface ParticipationComment {
	id: string;
	/** On the application itself, or on one of its evidence packs (`packVersion`). */
	target: 'application' | 'pack';
	packVersion: number | null;
	/** Display name; null once the account is gone. */
	author: string | null;
	/** Only where the commenter agreed to the register (reg 18), and while the account exists. */
	email: string | null;
	registerConsent: boolean;
	/** Posted through a share link (a link participant), not by a member in the app. */
	viaLink: boolean;
	createdAt: string;
	editedAt: string | null;
	/** shown; withdrawn by its author; removed by a moderator (an editor). */
	state: ParticipationState;
	deletedAt: string | null;
	/** Null for a withdrawn or removed comment, unless the caller is an editor. */
	body: string | null;
	/** Earlier texts, oldest first (note_revision). */
	revisions: { body: string; writtenAt: string; editedAt: string }[];
}

export interface ParticipationExport {
	application: {
		id: string;
		name: string;
		status: string;
		submittedAt: string | null;
		decidedAt: string | null;
		outcome: string | null;
		objectionAddress: string | null;
		objectionClosingDate: string | null;
	};
	/** How it was put out for comment: its share links and its packs' (dates only). */
	links: { target: 'application' | 'pack'; packVersion: number | null; createdAt: string; expiresAt: string; revokedAt: string | null }[];
	comments: ParticipationComment[];
	/** The register of interested and affected parties the app can fill: each consenting commenter once, by email. */
	register: { name: string; email: string }[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** app_participation_export's answer, field by field. */
export function toParticipationExport(raw: Record<string, unknown>): ParticipationExport {
	const a = obj(raw.application);
	const comments: ParticipationComment[] = arr(raw.comments).map((x) => {
		const c = obj(x);
		const state: ParticipationState = c.state === 'withdrawn' || c.state === 'removed' ? c.state : 'shown';
		return {
			id: str(c.id) ?? '',
			target: c.target === 'pack' ? 'pack' : 'application',
			packVersion: num(c.packVersion),
			author: str(c.author),
			email: c.registerConsent === true ? str(c.email) : null,
			registerConsent: c.registerConsent === true,
			viaLink: c.viaLink === true,
			createdAt: str(c.createdAt) ?? '',
			editedAt: str(c.editedAt),
			state,
			deletedAt: str(c.deletedAt),
			body: str(c.body),
			revisions: arr(c.revisions).map((r) => {
				const o = obj(r);
				return { body: str(o.body) ?? '', writtenAt: str(o.writtenAt) ?? '', editedAt: str(o.editedAt) ?? '' };
			})
		};
	});
	const register = new Map<string, { name: string; email: string }>();
	for (const c of comments) {
		if (c.email && !register.has(c.email.toLowerCase())) register.set(c.email.toLowerCase(), { name: c.author ?? '', email: c.email });
	}
	return {
		application: {
			id: str(a.id) ?? '',
			name: str(a.name) ?? '',
			status: str(a.status) ?? '',
			submittedAt: str(a.submittedAt),
			decidedAt: str(a.decidedAt),
			outcome: str(a.outcome),
			objectionAddress: str(a.objectionAddress),
			objectionClosingDate: str(a.objectionClosingDate)
		},
		links: arr(raw.links).map((x) => {
			const l = obj(x);
			return {
				target: l.target === 'pack' ? 'pack' : 'application',
				packVersion: num(l.packVersion),
				createdAt: str(l.createdAt) ?? '',
				expiresAt: str(l.expiresAt) ?? '',
				revokedAt: str(l.revokedAt)
			};
		}),
		comments,
		register: [...register.values()]
	};
}

export const PARTICIPATION_CSV_HEADER = [
	'comment_id',
	'on',
	'text_version',
	'text_written_at',
	'posted_at',
	'author',
	'email',
	'register_consent',
	'posted_through',
	'state',
	'text'
] as const;

/** One row per text of each comment: its current text, then each earlier one (oldest first). */
export function* participationCsvLines(x: ParticipationExport): Generator<string> {
	yield csvRow([...PARTICIPATION_CSV_HEADER]);
	for (const c of x.comments) {
		const on = c.target === 'pack' ? `evidence pack v${c.packVersion ?? '?'}` : 'application';
		const base = [c.author ?? 'a former account', c.email ?? '', c.registerConsent ? 'yes' : 'no', c.viaLink ? 'share link' : 'member', c.state] as const;
		yield csvRow([c.id, on, 'current', c.editedAt ?? c.createdAt, c.createdAt, ...base, c.body ?? '(withheld)']);
		for (const [i, r] of c.revisions.entries()) {
			yield csvRow([c.id, on, `earlier ${i + 1}`, r.writtenAt, c.createdAt, ...base, c.body === null ? '(withheld)' : r.body]);
		}
	}
}

async function loadExport(db: Db, projectId: string, scenarioId: string): Promise<ParticipationExport> {
	if (!UUID.test(scenarioId)) throw notFound();
	const { rows } = await db.query<{ x: Record<string, unknown> | null }>('SELECT app_participation_export($1, $2) AS x', [projectId, scenarioId]);
	const x = rows[0]?.x;
	// Not the application's owner nor an editor who reads it, a team scenario, or none at all: the same 404.
	if (!x) throw notFound();
	return toParticipationExport(x);
}

export const participationRoutes = new Hono<AuthEnv>().get('/:id/scenarios/:sid/participation-export', async (c) => {
	const { id, sid } = c.req.param();
	const q = z.object({ format: z.enum(['json', 'csv']).default('json') }).strict().parse(c.req.query());
	const { x, name, timeZone } = await withUser(c.get('userId'), async (db) => {
		await requireRole(db, id, 'contributor');
		const x = await loadExport(db, id, sid);
		const { rows } = await db.query<{ name: string; timeZone: string }>('SELECT name, time_zone AS "timeZone" FROM project WHERE id = $1', [id]);
		// Who took the record, and how many commenters' emails it carried.
		await recordAudit(db, id, 'scenario.participation_exported', {
			scenarioId: x.application.id,
			// Never the name: the history shows an application only as "an application" (scenarios/routes.ts subject).
			application: true,
			format: q.format,
			comments: x.comments.length,
			emails: x.register.length
		});
		return { x, name: rows[0]?.name ?? 'project', timeZone: rows[0]?.timeZone ?? 'UTC' };
	});
	c.header('Cache-Control', 'no-store');
	if (q.format === 'json') return c.json(x);
	return csvDownload(
		c,
		() => participationCsvLines(x),
		exportFilename(name, [x.application.name || 'application', 'public-participation'], 'csv', timeZone),
		csvTooLarge('the comments are too many for one file; ask the operator')
	);
});
