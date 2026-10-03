import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

// Passwords are hashed with Argon2id (OWASP's first choice; RFC 9106), from
// Node's own node:crypto (24.7+), so the Lambda bundle stays free of native
// modules. A hash is a standard PHC string,
//   $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>
// (unpadded base64), carrying its own parameters: raising them later leaves
// every older hash checkable, and a sign-in upgrades it (needsRehash).
//
// Accounts made before this have a bcrypt hash ($2a$/$2b$/$2y$, bcryptjs cost
// 12). It still checks, and the next successful sign-in replaces it with an
// Argon2id one (auth/routes.ts /login). bcrypt reads only a password's first
// 72 bytes, so until then a long passphrase on such an account is checked by
// its first 72 bytes; Argon2id reads all of it (a password may be 200
// characters, up to 800 UTF-8 bytes).
//
// The production parameters are RFC 9106's second recommended option (64 MiB,
// 3 passes; one lane, since a Lambda has about one vCPU): ~110 ms on a dev
// laptop and in the ~250 ms of bcrypt cost 12 before it on a 1 GB Lambda. It
// runs on libuv's thread pool, so unlike bcryptjs it doesn't hold the event
// loop while it hashes.
//
// Under vitest, and on the e2e API server (PASSWORD_HASH_FAST=1,
// e2e/playwright.config.ts), new hashes use the smallest Argon2id parameters:
// the db suite and every e2e test sign up and sign in again and again, and
// what they test is the counting and locking, not the work factor (issue #41
// for the e2e server's history). Lambda refuses the override at startup, so
// production can't be misconfigured into it.
export interface Argon2Params {
	/** Memory, KiB. */
	m: number;
	/** Passes over the memory. */
	t: number;
	/** Lanes. */
	p: number;
}

export const PRODUCTION_PARAMS: Readonly<Argon2Params> = { m: 65536, t: 3, p: 1 };
export const FAST_PARAMS: Readonly<Argon2Params> = { m: 8, t: 1, p: 1 };

/** The parameters for new hashes: the fast ones under vitest or PASSWORD_HASH_FAST=1 off Lambda, else production's. */
export function passwordParams(env: Record<string, string | undefined> = process.env): Readonly<Argon2Params> {
	if (env.VITEST) return FAST_PARAMS;
	const raw = env.PASSWORD_HASH_FAST;
	if (raw === undefined || raw === '') return PRODUCTION_PARAMS;
	if (raw !== '1') throw new Error(`PASSWORD_HASH_FAST must be 1 or unset, got ${raw}`);
	if (env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('PASSWORD_HASH_FAST is for the local e2e server only; Lambda always hashes with the production parameters');
	return FAST_PARAMS;
}

export const PASSWORD_PARAMS = passwordParams();

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

function derive(password: string, salt: Buffer, params: Argon2Params, tagLength: number): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: params.p, tagLength, memory: params.m, passes: params.t }, (err, tag) =>
			err ? reject(err) : resolve(tag)
		)
	);
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,})\$([A-Za-z0-9+/]{22,})$/;
const BCRYPT = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

/** A PHC string's parts, or null when it isn't one this module writes. */
export function parseArgon2(hash: string): { params: Argon2Params; salt: Buffer; tag: Buffer } | null {
	const m = PHC.exec(hash);
	if (!m) return null;
	const params = { m: Number(m[1]), t: Number(m[2]), p: Number(m[3]) };
	// Bounded, so a stored hash can't make a check allocate gigabytes or spin (the column is written only by this module).
	if (params.m < 8 * params.p || params.m > 1 << 20 || params.t < 1 || params.t > 10 || params.p < 1) return null;
	return { params, salt: Buffer.from(m[4]!, 'base64'), tag: Buffer.from(m[5]!, 'base64') };
}

export async function hashPassword(password: string, params: Readonly<Argon2Params> = PASSWORD_PARAMS): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const tag = await derive(password, salt, params, TAG_BYTES);
	return `$argon2id$v=19$m=${params.m},t=${params.t},p=${params.p}$${b64(salt)}$${b64(tag)}`;
}

/** Whether `password` matches `hash` (Argon2id, or a legacy bcrypt hash); anything else never matches. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	const parsed = parseArgon2(hash);
	if (parsed) {
		const tag = await derive(password, parsed.salt, parsed.params, parsed.tag.length);
		return timingSafeEqual(tag, parsed.tag);
	}
	if (BCRYPT.test(hash)) return bcrypt.compare(password, hash);
	return false;
}

/** Whether a hash that just checked should be replaced: a legacy bcrypt one, or Argon2id with other parameters than new hashes get. */
export function needsRehash(hash: string, params: Readonly<Argon2Params> = PASSWORD_PARAMS): boolean {
	const parsed = parseArgon2(hash);
	return !parsed || parsed.params.m !== params.m || parsed.params.t !== params.t || parsed.params.p !== params.p;
}

/**
 * A real hash of a random string, checked against when the email is unknown,
 * so sign-in timing doesn't reveal which emails have accounts. Same
 * parameters as new hashes, so an unknown email takes as long as a known one
 * (a known account still on bcrypt differs until its first sign-in upgrades it).
 * Made on first use, not at import, so a cold start doesn't pay for it.
 */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
	dummy ??= hashPassword(randomBytes(18).toString('base64'));
	return dummy;
}
