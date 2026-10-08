// Recovering a lost second factor (205_mfa_recovery.sql; docs/security.md
// § Two-step sign-in → Recovery). The routes are auth/mfa-reset-routes.ts;
// this is the storage and the tick's part.
//
//   1. At the sign-in's code step, a live `wm_mfa` challenge (the password
//      was just proved) asks for a reset: a confirmation link goes to the
//      account's address (1 hour, single use). Nothing changes yet.
//   2. Following the link starts a 3-day wait (MFA_RESET_WAIT, a constant on
//      purpose: no environment can shorten it). The factor keeps working;
//      the start, a daily reminder and the end are emailed, each with a
//      cancel link that needs no sign-in. A sign-in or step-up with a code
//      cancels it, and so does turning the factor off.
//   3. When the wait is over, the tick (runMfaResets, from jobs/runner.ts)
//      removes every second factor of the account (mfa_remove_factors, the
//      one place a factor is removed), moves the session watermark and sends
//      the completion email.
//
// The job queue's jobs belong to a project (job.project_id is NOT NULL), and a
// reset belongs to no project, so this is a step of the tick, like the
// licence-record notices, not a job kind.
import { type Db, withoutUser } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { mfaResetMail, siteLink } from '../mail/templates.js';
import { sendMail, type Mail } from '../mail/transport.js';
import { newToken } from './tokens.js';

/** How long the wait between confirming a reset and the factor's removal is: 3 days. Not configurable. */
export const MFA_RESET_WAIT = '72 hours';
export const MFA_RESET_WAIT_MS = 72 * 3600 * 1000;
/** How long the emailed confirmation link lasts. */
export const MFA_RESET_CONFIRM_TTL = '1 hour';
/**
 * The cap on asking for a reset: each request emails the account (SES bills
 * every email), so at most this many per account in MFA_RESET_WINDOW. One
 * reset waits at a time, so the reminders are bounded by the wait itself.
 */
export const MFA_RESET_CAP = 3;
export const MFA_RESET_WINDOW = '24 hours';
/** A reminder goes this long after the last notice, and not when the end is nearer than MFA_RESET_MARGIN (the completion email says it then). */
export const MFA_RESET_REMINDER_GAP = '24 hours';
export const MFA_RESET_MARGIN = '2 hours';
/** An ended reset is deleted this long after it ended; the account's security log keeps that it happened. */
export const MFA_RESET_RETENTION = '90 days';

/** The pages the emailed links open (frontend routes/mfa-reset). */
export const MFA_RESET_CONFIRM_PATH = '/mfa-reset';
export const MFA_RESET_CANCEL_PATH = '/mfa-reset/cancel';

export type ResetRequest =
	| { status: 'issued'; token: string }
	| { status: 'pending'; effectiveAt: Date }
	| { status: 'capped' }
	| { status: 'not_enrolled' };

/** Ask for a reset, as the account (withUser of the challenge's user): see app_mfa_reset_request. */
export async function requestReset(db: Db): Promise<ResetRequest> {
	const { token, hash } = newToken();
	const { rows } = await db.query<{ status: ResetRequest['status']; effective_at: Date | null }>(
		'SELECT status, effective_at FROM app_mfa_reset_request($1, $2::interval, $3, $4::interval)',
		[hash, MFA_RESET_CONFIRM_TTL, MFA_RESET_CAP, MFA_RESET_WINDOW]
	);
	const r = rows[0]!;
	if (r.status === 'issued') return { status: 'issued', token };
	if (r.status === 'pending') return { status: 'pending', effectiveAt: r.effective_at! };
	return { status: r.status };
}

/**
 * Follow the confirmation link (no user): the wait starts. The "started" email
 * to send, when it ends, and its cancel link's hash (for noticeFailed), or null
 * for a dead link.
 */
export async function confirmReset(db: Db, hash: Buffer): Promise<{ mail: Mail; effectiveAt: Date; cancelHash: Buffer } | null> {
	const cancel = newToken();
	const { rows } = await db.query<{ user_id: string; email: string; locale: string | null; effective_at: Date }>(
		'SELECT user_id, email, locale, effective_at FROM app_mfa_reset_confirm($1, $2::interval, $3)',
		[hash, MFA_RESET_WAIT, cancel.hash]
	);
	const r = rows[0];
	if (!r) return null;
	return {
		effectiveAt: r.effective_at,
		cancelHash: cancel.hash,
		mail: mfaResetMail(r.email, { stage: 'started', cancelUrl: siteLink(MFA_RESET_CANCEL_PATH, cancel.token), effectiveAt: r.effective_at }, r.locale)
	};
}

/** The "started" email failed: the next tick sends a reminder (with a cancel link) at once, not a day later. */
export async function noticeFailed(db: Db, cancelHash: Buffer): Promise<void> {
	await db.query('SELECT app_mfa_reset_notice_failed($1)', [cancelHash]);
}

/** Follow a cancel link (no user): the account's id, or null for a dead link. */
export async function cancelReset(db: Db, hash: Buffer): Promise<string | null> {
	const { rows } = await db.query<{ user_id: string | null }>('SELECT app_mfa_reset_cancel($1) AS user_id', [hash]);
	return rows[0]?.user_id ?? null;
}

/** As the account: a code just proved the owner has their factor, so a waiting reset ends. True when one did. */
export async function cancelOwnReset(db: Db): Promise<boolean> {
	const { rows } = await db.query<{ ended: boolean }>('SELECT app_mfa_reset_cancel_own() AS ended');
	return rows[0]?.ended ?? false;
}

/** The person's waiting reset, if any (own rows under RLS): when its wait ends, or null while unconfirmed or none. */
export async function pendingReset(db: Db, userId: string): Promise<{ effectiveAt: string } | null> {
	const { rows } = await db.query<{ effective_at: Date }>(
		'SELECT effective_at FROM mfa_reset WHERE user_id = $1 AND ended_at IS NULL AND confirmed_at IS NOT NULL',
		[userId]
	);
	return rows[0] ? { effectiveAt: rows[0].effective_at.toISOString() } : null;
}

export interface MfaResetTickResult {
	/** Resets whose wait ended this tick: every second factor removed. */
	completed: number;
	reminded: number;
	/** Ended resets deleted past MFA_RESET_RETENTION. */
	purged: number;
	failed: number;
}

async function send(mail: Mail, r: MfaResetTickResult): Promise<void> {
	try {
		await sendMail(mail);
	} catch (err) {
		// The line the mail-send-failed alarm counts (infra/alarms.tf): kind and error code only.
		logEvent('error', { event: 'mail_send_failed', kind: 'mfa_reset', ...safeError(err) });
		r.failed++;
	}
}

/**
 * The tick's part (jobs/runner.ts runTick): complete the resets whose wait is
 * over, send the daily reminders, purge old ones. Each reset is handed out by
 * its own function in its own transaction, which checks again that it is due,
 * so two ticks at once can't complete or remind one twice. The email goes
 * after the commit: a failed send is logged, never retried (a reminder comes
 * again the next day; the completion is in the account's security log).
 */
export async function runMfaResets({ limit = 50 }: { limit?: number } = {}): Promise<MfaResetTickResult> {
	const r: MfaResetTickResult = { completed: 0, reminded: 0, purged: 0, failed: 0 };
	r.purged = await withoutUser(
		async (db) => (await db.query<{ n: number }>('SELECT app_mfa_reset_purge($1::interval) AS n', [MFA_RESET_RETENTION])).rows[0]?.n ?? 0
	);
	const { rows: due } = await withoutUser((db) =>
		db.query<{ id: string; action: 'complete' | 'remind' }>('SELECT id, action FROM app_mfa_reset_due($1, $2::interval, $3::interval)', [
			limit,
			MFA_RESET_REMINDER_GAP,
			MFA_RESET_MARGIN
		])
	);
	for (const d of due) {
		let mail: Mail | null = null;
		try {
			if (d.action === 'complete') {
				// This server's clock, the one that stamps session iat_ms (as every watermark).
				const watermark = new Date();
				const { rows } = await withoutUser((db) =>
					db.query<{ email: string; locale: string | null }>('SELECT email, locale FROM app_mfa_reset_complete($1, $2)', [d.id, watermark])
				);
				if (rows[0]) {
					r.completed++;
					// The account's random id only (never its address), so the operator can match a support request.
					logEvent('info', { event: 'mfa_reset_completed', resetId: d.id });
					mail = mfaResetMail(rows[0].email, { stage: 'done' }, rows[0].locale);
				}
			} else {
				const cancel = newToken();
				const { rows } = await withoutUser((db) =>
					db.query<{ email: string; locale: string | null; effective_at: Date }>(
						'SELECT email, locale, effective_at FROM app_mfa_reset_remind($1, $2, $3::interval, $4::interval)',
						[d.id, cancel.hash, MFA_RESET_REMINDER_GAP, MFA_RESET_MARGIN]
					)
				);
				if (rows[0]) {
					r.reminded++;
					mail = mfaResetMail(
						rows[0].email,
						{ stage: 'reminder', cancelUrl: siteLink(MFA_RESET_CANCEL_PATH, cancel.token), effectiveAt: rows[0].effective_at },
						rows[0].locale
					);
				}
			}
		} catch (err) {
			logEvent('error', { event: 'mfa_reset_tick_failed', resetId: d.id, action: d.action, ...safeError(err) });
			r.failed++;
			continue;
		}
		if (mail) await send(mail, r);
	}
	return r;
}
