// Encryption at rest for the TOTP secrets (issue #282, 150_mfa.sql). A
// database dump or a read through some future bug must not hand over the
// seeds that make the second factor: each is sealed with AES-256-GCM under
// APP_ENCRYPTION_KEY, a runtime secret the database never sees (production:
// the sops key app_encryption_key, infra/secrets.tf; local dev: a committed
// dev-only placeholder in backend/.env.development).
//
// The AES key is HKDF-SHA256 of APP_ENCRYPTION_KEY, so the setting can be
// any long random string (`openssl rand -hex 32`) and a future second use
// gets its own key from the same setting with another `info`. The account id
// is the additional authenticated data: a sealed secret copied onto another
// account's row doesn't open. Layout: version (1 byte, 1) · IV (12) · tag (16)
// · ciphertext.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const INFO = 'water-management/totp-secret/v1';

function key(env: Record<string, string | undefined> = process.env): Buffer {
	const s = env.APP_ENCRYPTION_KEY ?? '';
	if (s.length < 32) throw new Error('APP_ENCRYPTION_KEY must be set (≥ 32 characters)');
	return Buffer.from(hkdfSync('sha256', Buffer.from(s, 'utf8'), Buffer.alloc(0), INFO, 32));
}

/** Seal `plain` for the account `userId`. */
export function seal(plain: Uint8Array, userId: string, env?: Record<string, string | undefined>): Buffer {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key(env), iv, { authTagLength: TAG_BYTES });
	cipher.setAAD(Buffer.from(userId.toLowerCase(), 'utf8'));
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Open what seal made for `userId`. Throws on a wrong key, another account's row or any tampering. */
export function open(sealed: Uint8Array, userId: string, env?: Record<string, string | undefined>): Buffer {
	const buf = Buffer.from(sealed);
	if (buf.length < 1 + IV_BYTES + TAG_BYTES + 1 || buf[0] !== VERSION) throw new Error('not a sealed secret');
	const iv = buf.subarray(1, 1 + IV_BYTES);
	const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv('aes-256-gcm', key(env), iv, { authTagLength: TAG_BYTES });
	decipher.setAAD(Buffer.from(userId.toLowerCase(), 'utf8'));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(buf.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
}
