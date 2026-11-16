// A station API feed's credential (issue #784), sealed so that only the
// process that fetches can open it.
//
// The API seals with the fetcher's public key (FEED_CREDENTIAL_PUBLIC_KEY, not
// a secret); the private key (FEED_CREDENTIAL_PRIVATE_KEY) is the fetcher
// Lambda's runtime secret, and the local worker's in dev (FEED_FETCHER=inline,
// a committed dev-only pair in backend/.env.development). So the database, a
// dump of it, the API and the production worker hold only ciphertext: none of
// them can turn a stored credential back into the key, and the worker hands
// the sealed bytes to the fetcher through the fetch queue unopened.
//
// ECIES on X25519: a fresh ephemeral key per seal, ECDH with the fetcher's
// key, HKDF-SHA256 (salt: the ephemeral public key, info: INFO) to an
// AES-256-GCM key. The feed's id is the additional authenticated data, so a
// sealed credential copied onto another feed's row (or another project's)
// doesn't open. Layout, base64: version (1 byte) · ephemeral public key (32)
// · IV (12) · tag (16) · ciphertext.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject, randomBytes } from 'node:crypto';
import { z } from 'zod';

const VERSION = 1;
const PUB_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const INFO = 'water-management/feed-credential/v1';
/** DER prefixes of an X25519 SubjectPublicKeyInfo and PKCS#8 private key (RFC 8410), before the 32 raw key bytes. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** What a credential holds: one secret (a token, a key, a password) and, for Basic auth, a user name. */
export const FeedCredential = z
	.object({
		secret: z.string().min(1).max(4096),
		user: z.string().min(1).max(256).optional()
	})
	.strict();
export type FeedCredential = z.output<typeof FeedCredential>;

type Env = Record<string, string | undefined>;

const raw32 = (name: string, value: string | undefined): Buffer => {
	const b = Buffer.from(value?.trim() ?? '', 'base64url');
	if (b.length !== 32) throw new Error(`${name} must be set (32 bytes, base64url; pnpm gen:feed-credential-key)`);
	return b;
};

const publicKey = (env: Env): KeyObject =>
	createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32('FEED_CREDENTIAL_PUBLIC_KEY', env.FEED_CREDENTIAL_PUBLIC_KEY)]), format: 'der', type: 'spki' });
const privateKey = (env: Env): KeyObject =>
	createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw32('FEED_CREDENTIAL_PRIVATE_KEY', env.FEED_CREDENTIAL_PRIVATE_KEY)]), format: 'der', type: 'pkcs8' });

const rawPublic = (k: KeyObject): Buffer => Buffer.from(k.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length));

const aesKey = (shared: Buffer, ephemeral: Buffer): Buffer => Buffer.from(hkdfSync('sha256', shared, ephemeral, INFO, 32));

const aad = (feedId: string) => Buffer.from(`feed:${feedId.toLowerCase()}`, 'utf8');

/** A new key pair, base64url (gen:feed-credential-key prints it for the operator; tests make their own). */
export function generateFeedCredentialKeys(): { publicKey: string; privateKey: string } {
	const { publicKey: pub, privateKey: priv } = generateKeyPairSync('x25519');
	return {
		publicKey: rawPublic(pub).toString('base64url'),
		privateKey: Buffer.from(priv.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length)).toString('base64url')
	};
}

/** Seal `credential` for the feed `feedId` with the fetcher's public key. Needs only FEED_CREDENTIAL_PUBLIC_KEY. */
export function sealFeedCredential(credential: FeedCredential, feedId: string, env: Env = process.env): string {
	const plain = Buffer.from(JSON.stringify(FeedCredential.parse(credential)), 'utf8');
	const eph = generateKeyPairSync('x25519');
	const ephPub = rawPublic(eph.publicKey);
	const key = aesKey(diffieHellman({ privateKey: eph.privateKey, publicKey: publicKey(env) }), ephPub);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
	cipher.setAAD(aad(feedId));
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	return Buffer.concat([Buffer.from([VERSION]), ephPub, iv, cipher.getAuthTag(), body]).toString('base64');
}

/** The longest sealed credential (a 4096-character secret and a 256-character user, JSON, sealed, base64). */
export const SEALED_MAX = 6000;

export class FeedCredentialError extends Error {
	override name = 'FeedCredentialError';
}

/**
 * Open what sealFeedCredential made for `feedId`. Needs FEED_CREDENTIAL_PRIVATE_KEY: only the fetcher (and the
 * local worker). Throws FeedCredentialError, with no detail of the bytes, on a wrong key, another feed's
 * credential or any tampering.
 */
export function openFeedCredential(sealed: string, feedId: string, env: Env = process.env): FeedCredential {
	const priv = privateKey(env);
	try {
		const buf = Buffer.from(sealed, 'base64');
		if (sealed.length > SEALED_MAX || buf.length < 1 + PUB_BYTES + IV_BYTES + TAG_BYTES + 1 || buf[0] !== VERSION) throw new Error('layout');
		const ephPub = buf.subarray(1, 1 + PUB_BYTES);
		const iv = buf.subarray(1 + PUB_BYTES, 1 + PUB_BYTES + IV_BYTES);
		const tag = buf.subarray(1 + PUB_BYTES + IV_BYTES, 1 + PUB_BYTES + IV_BYTES + TAG_BYTES);
		const peer = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, ephPub]), format: 'der', type: 'spki' });
		const key = aesKey(diffieHellman({ privateKey: priv, publicKey: peer }), Buffer.from(ephPub));
		const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
		decipher.setAAD(aad(feedId));
		decipher.setAuthTag(tag);
		const plain = Buffer.concat([decipher.update(buf.subarray(1 + PUB_BYTES + IV_BYTES + TAG_BYTES)), decipher.final()]);
		return FeedCredential.parse(JSON.parse(plain.toString('utf8')));
	} catch {
		throw new FeedCredentialError('the feed’s saved key could not be opened: enter it again (Replace key)');
	}
}

/**
 * What the card shows of a saved secret: its last four characters, only when it is long enough that four give
 * nothing useful away (at least 16), else nothing. Computed when the key is saved and stored beside the sealed bytes.
 */
export function credentialHint(credential: FeedCredential): string | null {
	const s = credential.secret;
	return s.length >= 16 ? s.slice(-4) : null;
}
