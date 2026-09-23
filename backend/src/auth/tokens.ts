// Emailed one-time tokens (verify, reset, invite). 32 random bytes, sent as
// base64url; only the SHA-256 hash is stored (migrations/003_email.sql).
import { createHash, randomBytes } from 'node:crypto';

/** Format of a token we issued: 32 bytes → 43 base64url characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export function newToken(): { token: string; hash: Buffer } {
	const token = randomBytes(32).toString('base64url');
	return { token, hash: hashToken(token) };
}

/** Hash of a client-supplied token, or null if it can't be one of ours. */
export const parseToken = (token: string): Buffer | null => (TOKEN_RE.test(token) ? hashToken(token) : null);

/** Lifetimes and per-address re-send throttles (Postgres interval literals). */
export const TOKEN_TTL = { verify: '48 hours', reset: '1 hour', invite: '7 days' } as const;
export const RESEND_COOLDOWN = { verify: '60 seconds', reset: '60 seconds', invite: '60 seconds' } as const;
