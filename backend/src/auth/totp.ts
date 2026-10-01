// Time-based one-time passwords (RFC 6238) and the recovery codes that stand
// in for a lost authenticator (issue #282; docs/security.md § Two-step
// sign-in). Written on node:crypto rather than taken from a package: the
// whole algorithm is an HMAC, a dynamic truncation and a modulus (RFC 4226
// § 5.3), small enough to read in one sitting, and totp.test.ts checks it
// against the RFCs' own test vectors. No I/O here; mfa.ts stores and checks.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** What every authenticator app reads by default (Google Authenticator ignores anything else). */
export const TOTP = { algorithm: 'sha1', digits: 6, periodSeconds: 30, secretBytes: 20, issuer: 'Water Management' } as const;
/** Steps either side of now a code may come from: one, for a phone clock a few seconds off (RFC 6238 § 5.2). */
export const TOTP_WINDOW = 1;

export type HotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding: how an otpauth URI and a typed-in key carry the secret. */
export function base32Encode(bytes: Uint8Array): string {
	let out = '';
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

/** Inverse of base32Encode; spaces, dashes, padding and case are forgiven. Null when it isn't base32. */
export function base32Decode(text: string): Buffer | null {
	const clean = text.replace(/[\s=-]/g, '').toUpperCase();
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of clean) {
		const i = BASE32.indexOf(ch);
		if (i < 0) return null;
		value = (value << 5) | i;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** HOTP (RFC 4226 § 5.3): the code for one counter value, zero-padded to `digits`. */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP.digits, algorithm: HotpAlgorithm = TOTP.algorithm): string {
	if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError('counter must be a non-negative integer');
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const mac = createHmac(algorithm, secret).update(msg).digest();
	const offset = mac[mac.length - 1]! & 0x0f;
	const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
	return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The time step (RFC 6238 § 4.2, T0 = 0) that `nowMs` falls in. */
export const totpStep = (nowMs: number, periodSeconds: number = TOTP.periodSeconds): number => Math.floor(nowMs / 1000 / periodSeconds);

/** TOTP (RFC 6238): the code for the step `nowMs` falls in. */
export const totp = (secret: Uint8Array, nowMs: number, digits: number = TOTP.digits, algorithm: HotpAlgorithm = TOTP.algorithm): string =>
	hotp(secret, totpStep(nowMs), digits, algorithm);

/** A typed code as six digits, or null: spaces are forgiven ("123 456", as many apps show it). */
export function normaliseTotp(code: string): string | null {
	const c = code.replace(/\s/g, '');
	return /^\d{6}$/.test(c) ? c : null;
}

/**
 * The step a typed code matches, within TOTP_WINDOW of now, or null. A step
 * at or before `lastUsedStep` never matches, so a code (or an earlier one)
 * can't be used twice (RFC 6238 § 5.2): the caller stores the step returned.
 * Every candidate is compared, in constant time, so the timing says nothing
 * about which step was close.
 */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number, lastUsedStep: number | null): number | null {
	const typed = normaliseTotp(code);
	if (!typed) return null;
	const now = totpStep(nowMs);
	let matched: number | null = null;
	for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
		if (step < 0) continue;
		const same = timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(typed));
		if (same && matched === null && (lastUsedStep === null || step > lastUsedStep)) matched = step;
	}
	return matched;
}

/** A new random secret (160 bits, RFC 4226 § 4's recommended length). */
export const newTotpSecret = (): Buffer => randomBytes(TOTP.secretBytes);

/**
 * The otpauth:// URI an authenticator app reads from the QR code (the Key
 * Uri Format every app follows). The label is the issuer and the address,
 * so the app lists the account by name.
 */
export function otpauthUri(secret: Uint8Array, accountEmail: string): string {
	const label = `${encodeURIComponent(TOTP.issuer)}:${encodeURIComponent(accountEmail)}`;
	const params = new URLSearchParams({
		secret: base32Encode(secret),
		issuer: TOTP.issuer,
		algorithm: TOTP.algorithm.toUpperCase(),
		digits: String(TOTP.digits),
		period: String(TOTP.periodSeconds)
	});
	// URLSearchParams writes a space as '+', which some apps show literally.
	return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}

// ---- Recovery codes --------------------------------------------------------

/** How many a person gets, each good once. */
export const RECOVERY_CODE_COUNT = 10;
/** Crockford-style alphabet: no 0/O, 1/I/L or U, so a code read off paper can't be mistyped into another. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const RECOVERY_LENGTH = 10;

/**
 * A new recovery code, shown as two groups of five (`ABCDE-FGH23`): 10
 * characters from 30, about 49 bits. They are stored as SHA-256 (high
 * entropy, so no slow hash is needed), checked under the code throttle, and
 * each works once.
 */
export function newRecoveryCode(): string {
	// Rejection sampling: 256 isn't a multiple of 30, so bytes ≥ 240 are redrawn.
	let out = '';
	while (out.length < RECOVERY_LENGTH) {
		for (const b of randomBytes(16)) {
			if (b < 240 && out.length < RECOVERY_LENGTH) out += RECOVERY_ALPHABET[b % 30];
		}
	}
	return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** A typed recovery code in its stored form (upper case, no separators), or null when it can't be one. */
export function normaliseRecoveryCode(code: string): string | null {
	const c = code.replace(/[\s-]/g, '').toUpperCase();
	return c.length === RECOVERY_LENGTH && [...c].every((ch) => RECOVERY_ALPHABET.includes(ch)) ? c : null;
}

/** What is stored for a recovery code: SHA-256 of its normalised form. */
export const hashRecoveryCode = (normalised: string): Buffer => createHash('sha256').update(normalised, 'utf8').digest();
