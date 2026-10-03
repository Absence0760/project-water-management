// /projects/:id/licence-record — the licence decision a project's evidence
// supports, and so how long its licence record is kept (161_licence_record.sql;
// docs/api.md § Licence record, docs/evidence-pack.md § Retention). Provisional
// position (pre-counsel research, 2026-10-01): a sign-off's name and an issued
// pack's makers are kept until three years after the licence expires, or three
// years after the application is refused or withdrawn; until the outcome is
// recorded, the owners confirm every five years that the record is still
// needed. Nothing is deleted automatically (licence/record.ts tells the owners
// and the operator).
//
// Editors and owners read it; only owners record the outcome or confirm the
// record (app_set_licence_outcome, app_confirm_licence_record, which check the
// role again under the database's own rules).
import { isIsoDate } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';

export const LICENCE_OUTCOMES = ['granted', 'refused', 'withdrawn'] as const;
export type LicenceOutcome = (typeof LICENCE_OUTCOMES)[number];

/** The licence record as the API answers it (dates as YYYY-MM-DD). */
export interface LicenceRecord {
	outcome: LicenceOutcome | null;
	outcomeOn: string | null;
	expiresOn: string | null;
	reason: string;
	/** When the record may be deleted: expiry (granted) or decision + 3 years; null without an outcome. */
	closesOn: string | null;
	/** While no outcome is recorded: when the owners must next confirm the record is still needed; null before the first issued pack or nomination. */
	reviewDueOn: string | null;
}

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
	.refine((s) => isIsoDate(s), 'not a date');
const reason = z
	.string()
	.trim()
	.min(1, 'say why (the decision letter, its reference)')
	.max(2000)
	.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters');

export const OutcomeBody = z.union([
	z
		.object({ outcome: z.literal('granted'), outcomeOn: isoDate, expiresOn: isoDate, reason })
		.strict()
		.refine((b) => b.expiresOn >= b.outcomeOn, { message: 'the licence expires before it was granted', path: ['expiresOn'] }),
	z.object({ outcome: z.enum(['refused', 'withdrawn']), outcomeOn: isoDate, reason }).strict(),
	// Clear a mistaken record: the reviews start again.
	z.object({ outcome: z.null(), reason }).strict()
]);

const SELECT = `SELECT licence_outcome AS outcome, to_char(licence_outcome_on, 'YYYY-MM-DD') AS "outcomeOn",
	to_char(licence_expires_on, 'YYYY-MM-DD') AS "expiresOn", licence_outcome_reason AS reason,
	to_char(record_closes_on, 'YYYY-MM-DD') AS "closesOn",
	CASE WHEN licence_outcome IS NULL THEN to_char(record_review_due_on, 'YYYY-MM-DD') END AS "reviewDueOn"
	FROM project WHERE id = $1`;

export async function loadLicenceRecord(db: Db, projectId: string): Promise<LicenceRecord> {
	const { rows } = await db.query<LicenceRecord>(SELECT, [projectId]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

export const licenceRecordRoutes = new Hono<AuthEnv>()
	.get('/:id/licence-record', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			return c.json({ licenceRecord: await loadLicenceRecord(db, id) });
		});
	})
	.put('/:id/licence-record', async (c) => {
		const id = c.req.param('id');
		const body = OutcomeBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const before = await loadLicenceRecord(db, id);
			const on = body.outcome === null ? null : body.outcomeOn;
			const expires = body.outcome === 'granted' ? body.expiresOn : null;
			await db.query('SELECT app_set_licence_outcome($1, $2, $3::date, $4::date, $5)', [id, body.outcome, on, expires, body.reason]);
			const after = await loadLicenceRecord(db, id);
			await recordAudit(db, id, 'licence.outcome', {
				outcome: after.outcome,
				outcomeOn: after.outcomeOn,
				expiresOn: after.expiresOn,
				closesOn: after.closesOn,
				previous: before.outcome,
				reason: body.reason
			});
			return c.json({ licenceRecord: after });
		});
	})
	.post('/:id/licence-record/confirm', async (c) => {
		const id = c.req.param('id');
		// Nothing to send: an empty body (or none) only.
		z.object({}).strict().parse((await readJson(c, { optional: true })) ?? {});
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const before = await loadLicenceRecord(db, id);
			if (before.outcome !== null) throw new ApiError(409, 'the licence outcome is recorded, so the record closes on its own date and there is no review to confirm');
			await db.query('SELECT app_confirm_licence_record($1)', [id]);
			const after = await loadLicenceRecord(db, id);
			await recordAudit(db, id, 'licence.confirmed', { reviewDueOn: after.reviewDueOn, previousDueOn: before.reviewDueOn });
			return c.json({ licenceRecord: after });
		});
	});
