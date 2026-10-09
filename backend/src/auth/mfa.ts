// Two-step sign-in's storage and checks (issue #282, 150_mfa.sql;
// docs/security.md § Two-step sign-in). The routes are auth/mfa-routes.ts
// and the sign-in step in auth/routes.ts; the requirement for the roles that
// need it is auth/stepUp.ts. Every function here runs as the account itself
// (withUser, or a transaction acting as the account a sign-in challenge
// proved), so RLS shows it only its own rows.
import type { Db } from '../db/tx.js';
import { pendingReset } from './mfaReset.js';
import { open, seal } from './secretBox.js';
import { hasConfirmedFactor } from './stepUp.js';
import { EMAIL_CODE_SEND, EMAIL_CODE_TTL_SECONDS, hashEmailCode, newEmailCode, normaliseEmailCode, type EmailCodePurpose } from './emailCode.js';
import {
	base32Encode,
	hashRecoveryCode,
	newRecoveryCode,
	newTotpSecret,
	normaliseRecoveryCode,
	otpauthUri,
	RECOVERY_CODE_COUNT,
	verifyTotp
} from './totp.js';

/**
 * The code throttle (mfa_throttle, 150): the 5th wrong code in a row locks
 * the account's code checks for a minute, doubling to 15, as the password
 * lockout does (LOGIN_THROTTLE). A right code clears it; a day forgets it.
 */
export const MFA_THROTTLE = { freeAttempts: 5, baseLock: '1 minute', maxLock: '15 minutes' } as const;

export type SecurityEventKind =
	| 'mfa.enrolled'
	| 'mfa.disabled'
	| 'mfa.recovery_used'
	| 'mfa.recovery_regenerated'
	// Recovering a lost factor (205_mfa_recovery; auth/mfaReset.ts). Written by its SECURITY DEFINER functions, not by recordSecurityEvent.
	| 'mfa.reset_requested'
	| 'mfa.reset_confirmed'
	| 'mfa.reset_cancelled'
	| 'mfa.reset_completed'
	| 'mfa.reset_by_admin'
	| 'mfa.reset_by_operator'
	// Codes by email (206_mfa_email_code).
	| 'mfa.email_enrolled'
	| 'mfa.email_disabled';

/** A second factor: the authenticator app (150) or a code by email (206). */
export type MfaMethod = 'totp' | 'email';

export interface MfaStatus {
	/** Two-step sign-in is on: at least one factor is confirmed. */
	enrolled: boolean;
	/** When the first factor still on was confirmed. */
	enrolledAt: string | null;
	/** The confirmed factors, the app first. */
	methods: MfaMethod[];
	/** Emailed codes are being turned on: a code went out and hasn't come back yet. */
	emailPending: boolean;
	/** Unused recovery codes left. */
	recoveryCodesLeft: number;
	/** The person's roles need two-step sign-in (stepUp.ts): an owner or admin where the project or team requires it, or someone who decides for an authority. */
	required: boolean;
	/** A confirmed reset of the factor is waiting (205, auth/mfaReset.ts): when it takes effect. Null when none. */
	pendingReset: { effectiveAt: string } | null;
}

/** Whether `userId` has a confirmed second factor of any kind (stepUp.ts hasConfirmedFactor). */
export const isEnrolled = hasConfirmedFactor;

interface FactorRows {
	totp_at: Date | null;
	email_at: Date | null;
	email_pending: boolean;
}

async function factorRows(db: Db, userId: string): Promise<FactorRows> {
	const { rows } = await db.query<FactorRows>(
		`SELECT (SELECT confirmed_at FROM user_totp WHERE user_id = $1) AS totp_at,
			(SELECT confirmed_at FROM user_email_otp WHERE user_id = $1) AS email_at,
			EXISTS (SELECT 1 FROM user_email_otp WHERE user_id = $1 AND confirmed_at IS NULL) AS email_pending`,
		[userId]
	);
	return rows[0] ?? { totp_at: null, email_at: null, email_pending: false };
}

/** The confirmed second factors of `userId`, the app first: what the sign-in challenge offers. */
export async function confirmedMethods(db: Db, userId: string): Promise<MfaMethod[]> {
	const f = await factorRows(db, userId);
	return [...(f.totp_at ? (['totp'] as const) : []), ...(f.email_at ? (['email'] as const) : [])];
}

/**
 * Whether the person's roles need two-step sign-in (stepUp.ts, opt-in since
 * 2026-10-08): owner of a project (directly, or as admin of its team) that
 * requires it, by its own setting or its team's (app_project_requires_mfa);
 * admin of a team that requires it; or someone whose actions always need it
 * whatever the settings: a member acting for the responsible authority (163:
 * deciding applications, endorsing a baseline, recording registration
 * checks) or an assessor (an editor or owner of a project that has a
 * submitted or decided application, 045). Publishing to farmers always needs
 * it too, but any editor may publish, so an editor isn't told so up front:
 * the refused action prompts (the workspace's banner). What the Account page
 * says; the routes check the action itself, so this only informs. As the
 * person (withUser): RLS limits the projects to theirs.
 */
export async function holdsRequiredRole(db: Db, userId: string): Promise<boolean> {
	const { rows } = await db.query<{ required: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM project p WHERE app_project_role(p.id) = 'owner' AND app_project_requires_mfa(p.id))
			OR EXISTS (SELECT 1 FROM team_member m JOIN team t ON t.id = m.team_id WHERE m.user_id = $1 AND m.role = 'admin' AND t.require_mfa)
			OR EXISTS (SELECT 1 FROM project_member WHERE user_id = $1 AND acts_for_authority)
			OR EXISTS (
				SELECT 1 FROM scenario s
				WHERE s.origin = 'applicant' AND s.status IN ('submitted', 'decided')
				  AND app_project_role(s.project_id) IN ('editor', 'owner')
			) AS required`,
		[userId]
	);
	return rows[0]?.required ?? false;
}

export async function mfaStatus(db: Db, userId: string): Promise<MfaStatus> {
	const f = await factorRows(db, userId);
	const { rows } = await db.query<{ codes: number }>('SELECT count(*)::int AS codes FROM user_recovery_code WHERE user_id = $1', [userId]);
	const confirmed = [f.totp_at, f.email_at].filter((d): d is Date => d !== null);
	const first = confirmed.length ? new Date(Math.min(...confirmed.map((d) => d.getTime()))) : null;
	// "Is two-step on" from the one test (mfa_has_factor), so the Account page says what the routes check.
	const enrolled = await hasConfirmedFactor(db, userId);
	return {
		enrolled,
		enrolledAt: enrolled ? (first?.toISOString() ?? null) : null,
		methods: [...(f.totp_at ? (['totp'] as const) : []), ...(f.email_at ? (['email'] as const) : [])],
		emailPending: f.email_pending,
		recoveryCodesLeft: enrolled ? (rows[0]?.codes ?? 0) : 0,
		required: await holdsRequiredRole(db, userId),
		pendingReset: await pendingReset(db, userId)
	};
}

/** Counts one code check against the throttle: the seconds left on a lock, or 0 to go ahead. Its own transaction, before the check. */
export async function countCodeAttempt(db: Db): Promise<number> {
	const { rows } = await db.query<{ locked: number }>('SELECT app_mfa_attempt($1, $2::interval, $3::interval) AS locked', [
		MFA_THROTTLE.freeAttempts,
		MFA_THROTTLE.baseLock,
		MFA_THROTTLE.maxLock
	]);
	return rows[0]?.locked ?? 0;
}

export async function recordSecurityEvent(db: Db, userId: string, kind: SecurityEventKind): Promise<void> {
	await db.query('INSERT INTO account_security_event (user_id, kind) VALUES ($1, $2)', [userId, kind]);
}

/**
 * Start (or restart) enrolment: a new secret, sealed, unconfirmed. Null when
 * an authenticator is already confirmed (turn it off first). The secret goes
 * back to the person once, as the QR code's URI and as text to type in.
 */
export async function startEnrolment(db: Db, userId: string, email: string): Promise<{ secret: string; uri: string } | null> {
	const secret = newTotpSecret();
	const { rowCount } = await db.query(
		`INSERT INTO user_totp (user_id, secret_enc) VALUES ($1, $2)
		 ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, created_at = now(), last_used_step = NULL
		 WHERE user_totp.confirmed_at IS NULL`,
		[userId, seal(secret, userId)]
	);
	if (!rowCount) return null;
	return { secret: base32Encode(secret), uri: otpauthUri(secret, email) };
}

/** New recovery codes, replacing any left: the codes, to show once. */
export async function replaceRecoveryCodes(db: Db, userId: string): Promise<string[]> {
	await db.query('DELETE FROM user_recovery_code WHERE user_id = $1', [userId]);
	const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
	await db.query(
		`INSERT INTO user_recovery_code (user_id, code_hash) SELECT $1, unnest($2::bytea[])`,
		[userId, codes.map((c) => hashRecoveryCode(normaliseRecoveryCode(c)!))]
	);
	return codes;
}

/**
 * Check a typed code and, if right, use it up: a TOTP code moves the
 * factor's last used step forward (so it can't be used again), an emailed
 * code is spent (app_mfa_email_use), a recovery code is deleted. Six digits
 * are tried against the authenticator first, then against the live emailed
 * code. `pending`: check against an unconfirmed authenticator (its confirm
 * step) instead of the confirmed factors. `recovery`: whether a recovery code
 * is accepted here. Returns how it matched, or null.
 */
export async function useCode(
	db: Db,
	userId: string,
	code: string,
	opts: { pending?: boolean; recovery?: boolean } = {},
	nowMs = Date.now()
): Promise<MfaMethod | 'recovery' | null> {
	const six = normaliseEmailCode(code);
	if (six) {
		const { rows } = await db.query<{ secret_enc: Buffer; last_used_step: string | null }>(
			`SELECT secret_enc, last_used_step FROM user_totp WHERE user_id = $1 AND (confirmed_at IS NULL) = $2 FOR UPDATE`,
			[userId, !!opts.pending]
		);
		const row = rows[0];
		if (row) {
			const step = verifyTotp(open(row.secret_enc, userId), six, nowMs, row.last_used_step === null ? null : Number(row.last_used_step));
			if (step !== null) {
				await db.query('UPDATE user_totp SET last_used_step = $2 WHERE user_id = $1', [userId, step]);
				return 'totp';
			}
		}
		if (opts.pending) return null;
		// An emailed code counts only while emailed codes are on (a code sent to confirm them is 'enrol', never 'use').
		const { rows: email } = await db.query('SELECT 1 FROM user_email_otp WHERE user_id = $1 AND confirmed_at IS NOT NULL', [userId]);
		if (!email.length) return null;
		return (await spendEmailCode(db, userId, 'use', six)) ? 'email' : null;
	}
	const recovery = opts.recovery && !opts.pending ? normaliseRecoveryCode(code) : null;
	if (!recovery) return null;
	// Only while a factor is confirmed: a code left from an earlier enrolment can't stand in for none.
	if (!(await isEnrolled(db, userId))) return null;
	const { rowCount } = await db.query('DELETE FROM user_recovery_code WHERE user_id = $1 AND code_hash = $2', [userId, hashRecoveryCode(recovery)]);
	return rowCount ? 'recovery' : null;
}

/** Spend the live emailed code if it is `code` (already six digits) for `purpose` and still in time. As the account. */
export async function spendEmailCode(db: Db, userId: string, purpose: EmailCodePurpose, code: string): Promise<boolean> {
	const { rows } = await db.query<{ ok: boolean }>('SELECT app_mfa_email_use($1, $2) AS ok', [hashEmailCode(userId, purpose, code), purpose]);
	return rows[0]?.ok ?? false;
}

/**
 * A new emailed code for `userId` (as the account), replacing the live one,
 * unless a send limit holds it back: `{ code }` to email now, or
 * `{ waitSeconds }` (nothing stored; send nothing).
 */
export async function newEmailCodeFor(db: Db, userId: string, purpose: EmailCodePurpose): Promise<{ code: string } | { waitSeconds: number }> {
	const code = newEmailCode();
	const { rows } = await db.query<{ wait: number }>('SELECT app_mfa_email_send($1, $2, $3::interval, $4::interval, $5) AS wait', [
		hashEmailCode(userId, purpose, code),
		purpose,
		`${EMAIL_CODE_TTL_SECONDS} seconds`,
		`${EMAIL_CODE_SEND.gapSeconds} seconds`,
		EMAIL_CODE_SEND.perHour
	]);
	const wait = rows[0]?.wait ?? 0;
	return wait > 0 ? { waitSeconds: wait } : { code };
}

/**
 * The signed-in person turns one of their own factors off (DELETE
 * /auth/mfa/totp, DELETE /auth/mfa/email, after a right code). Through
 * mfa_remove_factor (205, 206), the one place the owner removes a factor:
 * while another is still on, only this one goes (the recovery codes stand in
 * for any factor, so they stay); with the last one, every second factor, the
 * recovery codes and a waiting reset go through mfa_remove_factors, the one
 * place every factor is removed (a completed reset, a team admin's and the
 * operator's use it too). Every session is signed out at `watermark` (this
 * server's clock, the one that stamps a session's iat_ms). Returns whether a
 * factor is still on. A new kind of factor is added in SQL, not here.
 */
export async function removeFactor(db: Db, method: MfaMethod, watermark: Date): Promise<boolean> {
	const { rows } = await db.query<{ left: boolean }>('SELECT app_mfa_remove_own_factor($1, $2) AS left', [method, watermark]);
	return rows[0]?.left ?? false;
}
