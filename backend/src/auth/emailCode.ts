// The emailed second-factor code (206_mfa_email_code.sql; docs/security.md
// § Two-step sign-in → Code by email): six random digits, valid ten minutes,
// good once, stored as an HMAC.
//
// Why an HMAC and not a plain SHA-256: a recovery code or a link token has
// ~49 bits or more, so its SHA-256 can't be reversed; a 6-digit code has
// under 20, and anyone who reads the table (a backup, a leaked dump, an SQL
// injection) could try all million in a moment, even with the account id
// mixed in. Keyed by a secret the database never sees, the stored value is
// useless without the API's APP_ENCRYPTION_KEY: an HMAC-SHA256 under a key
// derived from it (HKDF-SHA256, its own `info`, as auth/secretBox.ts derives
// the TOTP seal key), over the account id, the purpose and the code, so a
// stored value copied to another account or purpose doesn't match there.
import { createHmac, hkdfSync, randomInt } from 'node:crypto';

/** How long an emailed code works. */
export const EMAIL_CODE_TTL_SECONDS = 10 * 60;

/** The send limits (app_mfa_email_send): a minute between emails, and at most 5 in a rolling hour, per account. */
export const EMAIL_CODE_SEND = { gapSeconds: 60, perHour: 5 } as const;

/** What a code is for: confirming a pending factor, or using a confirmed one (sign-in, step-up, an action's confirmation). */
export type EmailCodePurpose = 'enrol' | 'use';

const INFO = 'water-management/mfa-email-code/v1';

function key(env: Record<string, string | undefined> = process.env): Buffer {
	const s = env.APP_ENCRYPTION_KEY ?? '';
	if (s.length < 32) throw new Error('APP_ENCRYPTION_KEY must be set (≥ 32 characters)');
	return Buffer.from(hkdfSync('sha256', Buffer.from(s, 'utf8'), Buffer.alloc(0), INFO, 32));
}

/** Six digits, uniformly random (crypto), leading zeros kept. */
export function newEmailCode(): string {
	return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** The code as typed, without spaces or dashes, if it is six digits; else null. */
export function normaliseEmailCode(typed: string): string | null {
	const s = typed.replace(/[\s-]/g, '');
	return /^\d{6}$/.test(s) ? s : null;
}

/** The stored form: HMAC-SHA256(key, account · purpose · code), 32 bytes. */
export function hashEmailCode(userId: string, purpose: EmailCodePurpose, code: string, env?: Record<string, string | undefined>): Buffer {
	return createHmac('sha256', key(env)).update(`${userId.toLowerCase()}\0${purpose}\0${code}`, 'utf8').digest();
}
