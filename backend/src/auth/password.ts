import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';

// bcryptjs is pure JS (no native build step), so the Lambda bundle stays
// portable. Cost 12 ≈ 250 ms per hash on Lambda — acceptable for login only.
//
// Under vitest the cost is bcrypt's minimum, 4: the db suite signs up and logs
// in hundreds of times, and at cost 12 the lockout tests spent their whole
// 5 s budget hashing (bcryptjs is ~250 ms a hash on a dev laptop). What they
// test is the counting and locking, not the work factor.
//
// The e2e API server lowers it the same way, with PASSWORD_HASH_COST=4
// (e2e/playwright.config.ts): every e2e test registers at least one user, and
// all the workers share that one single-threaded server, where a cost-12 hash
// holds the event loop in ~100 ms slices. At 12, hashing took ~35 s of a
// 90 s run, and every other request queued behind it (issue #41). Lambda serves
// one request per container, so there a hash delays nobody else; it refuses
// the override and always uses 12. So does everything else, the local dev
// server included.
export const PRODUCTION_COST = 12;

/** The work factor for new hashes: 4 under vitest, PASSWORD_HASH_COST (4–12) when set off Lambda, else 12. */
export function passwordCost(env: Record<string, string | undefined> = process.env): number {
	if (env.VITEST) return 4;
	const raw = env.PASSWORD_HASH_COST;
	if (raw === undefined || raw === '') return PRODUCTION_COST;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 4 || n > PRODUCTION_COST) {
		throw new Error(`PASSWORD_HASH_COST must be a whole number from 4 to ${PRODUCTION_COST}, got ${raw}`);
	}
	if (n !== PRODUCTION_COST && env.AWS_LAMBDA_FUNCTION_NAME) {
		throw new Error(`PASSWORD_HASH_COST is for the local e2e server only; Lambda always hashes at cost ${PRODUCTION_COST}`);
	}
	return n;
}

export const PASSWORD_COST = passwordCost();

/**
 * bcrypt reads only the first 72 bytes of what it hashes, and a password may
 * be 200 characters (up to 800 UTF-8 bytes): hashed as typed, two long
 * passphrases that share their first 72 bytes would both open the account.
 * So a new hash is of the password's SHA-256 (44 base64 characters, well
 * inside bcrypt's 72 bytes), under its own prefix, so a hash made before this
 * (a plain `$2b$…`, of the password as typed) still checks the old way. The
 * prefix says which way a hash is checked; neither form is ever tried for the other.
 */
export const PREHASH_PREFIX = '$wm-sha256$';

const prehash = (password: string) => createHash('sha256').update(password, 'utf8').digest('base64');

export const hashPassword = async (password: string) => PREHASH_PREFIX + (await bcrypt.hash(prehash(password), PASSWORD_COST));
export const verifyPassword = (password: string, hash: string) =>
	hash.startsWith(PREHASH_PREFIX) ? bcrypt.compare(prehash(password), hash.slice(PREHASH_PREFIX.length)) : bcrypt.compare(password, hash);

/** A real hash of a random string, compared against when the email is unknown,
 *  so login timing doesn't reveal which emails have accounts. It has the cost
 *  in use, so an unknown email takes as long as a known one. */
export const DUMMY_HASH =
	PREHASH_PREFIX +
	(PASSWORD_COST === PRODUCTION_COST ? '$2b$12$9Vik78a3Kg7RDbvCFYCJgOZBiF9Zmk/m4MlqKjPTD.qUkhqk6vykW' : bcrypt.hashSync('not-a-password-8c1f', PASSWORD_COST));
