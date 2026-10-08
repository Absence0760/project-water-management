// Two-step sign-in's storage and checks (issue #282, 150_mfa.sql;
// docs/security.md § Two-step sign-in). The routes are auth/mfa-routes.ts
// and the sign-in step in auth/routes.ts; the requirement for the roles that
// need it is auth/stepUp.ts. Every function here runs as the account itself
// (withUser, or a transaction acting as the account a sign-in challenge
// proved), so RLS shows it only its own rows.
import type { Db } from '../db/tx.js';
import { pendingReset } from './mfaReset.js';
import { open, seal } from './secretBox.js';
import {
	base32Encode,
	hashRecoveryCode,
	newRecoveryCode,
	newTotpSecret,
	normaliseRecoveryCode,
	normaliseTotp,
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
	| 'mfa.reset_by_operator';

export interface MfaStatus {
	/** An authenticator is set up (its first code confirmed). */
	enrolled: boolean;
	enrolledAt: string | null;
	/** Unused recovery codes left. */
	recoveryCodesLeft: number;
	/** The person holds a role that needs two-step sign-in (stepUp.ts): a project owner, a team admin or an assessor. */
	required: boolean;
	/** A confirmed reset of the factor is waiting (205, auth/mfaReset.ts): when it takes effect. Null when none. */
	pendingReset: { effectiveAt: string } | null;
}

/** Whether `userId` has a confirmed authenticator. */
export async function isEnrolled(db: Db, userId: string): Promise<boolean> {
	const { rows } = await db.query<{ enrolled: boolean }>(
		'SELECT EXISTS (SELECT 1 FROM user_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL) AS enrolled',
		[userId]
	);
	return rows[0]?.enrolled ?? false;
}

/**
 * Whether the person holds a role that needs two-step sign-in: owner of a
 * project (directly, or as admin of its team), admin of a team, or an
 * assessor (an editor or owner of a project that has a submitted or decided
 * application, 045). What the Account page says; the routes check the action
 * itself (stepUp.ts), so this only informs.
 */
export async function holdsRequiredRole(db: Db, userId: string): Promise<boolean> {
	const { rows } = await db.query<{ required: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM project_member WHERE user_id = $1 AND role = 'owner')
			OR EXISTS (SELECT 1 FROM team_member WHERE user_id = $1 AND role = 'admin')
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
	const { rows } = await db.query<{ confirmed_at: Date | null; codes: number }>(
		`SELECT (SELECT confirmed_at FROM user_totp WHERE user_id = $1) AS confirmed_at,
			(SELECT count(*)::int FROM user_recovery_code WHERE user_id = $1) AS codes`,
		[userId]
	);
	const confirmedAt = rows[0]?.confirmed_at ?? null;
	return {
		enrolled: confirmedAt !== null,
		enrolledAt: confirmedAt?.toISOString() ?? null,
		recoveryCodesLeft: confirmedAt ? (rows[0]?.codes ?? 0) : 0,
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
 * factor's last used step forward (so it can't be used again), a recovery
 * code is deleted. `pending`: check against an unconfirmed enrolment (the
 * confirm step) instead of the confirmed factor. `recovery`: whether a
 * recovery code is accepted here. Returns how it matched, or null.
 */
export async function useCode(
	db: Db,
	userId: string,
	code: string,
	opts: { pending?: boolean; recovery?: boolean } = {},
	nowMs = Date.now()
): Promise<'totp' | 'recovery' | null> {
	if (normaliseTotp(code)) {
		const { rows } = await db.query<{ secret_enc: Buffer; last_used_step: string | null }>(
			`SELECT secret_enc, last_used_step FROM user_totp WHERE user_id = $1 AND (confirmed_at IS NULL) = $2 FOR UPDATE`,
			[userId, !!opts.pending]
		);
		const row = rows[0];
		if (!row) return null;
		const step = verifyTotp(open(row.secret_enc, userId), code, nowMs, row.last_used_step === null ? null : Number(row.last_used_step));
		if (step === null) return null;
		await db.query('UPDATE user_totp SET last_used_step = $2 WHERE user_id = $1', [userId, step]);
		return 'totp';
	}
	const recovery = opts.recovery && !opts.pending ? normaliseRecoveryCode(code) : null;
	if (!recovery) return null;
	// Only while an authenticator is confirmed: a code left from an earlier enrolment can't stand in for none.
	if (!(await isEnrolled(db, userId))) return null;
	const { rowCount } = await db.query('DELETE FROM user_recovery_code WHERE user_id = $1 AND code_hash = $2', [userId, hashRecoveryCode(recovery)]);
	return rowCount ? 'recovery' : null;
}

/**
 * Turn the signed-in person's two-step sign-in off: every second factor goes
 * (the authenticator and every recovery code), and a reset that was waiting
 * ends with it. Through mfa_remove_factors (205_mfa_recovery), the one place
 * a second factor is removed, which a completed reset and a team admin's
 * reset use too: a new kind of factor is added there, nowhere else.
 */
export async function removeOwnFactors(db: Db): Promise<void> {
	await db.query('SELECT app_mfa_remove_own_factors()');
}
