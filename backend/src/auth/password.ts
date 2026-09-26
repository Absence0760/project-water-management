import bcrypt from 'bcryptjs';

// bcryptjs is pure JS (no native build step), so the Lambda bundle stays
// portable. Cost 12 ≈ 250 ms per hash on Lambda — acceptable for login only.
const COST = 12;

/**
 * The bcrypt cost for new hashes: always 12, except under vitest, where
 * PASSWORD_HASH_COST may lower it (src/__tests__/setup.ts sets 4) so the auth
 * tests don't spend seconds per sign-up on a loaded machine and time out.
 * Outside vitest the variable is ignored, so no deployment can weaken it.
 */
export function hashCost(env: NodeJS.ProcessEnv = process.env): number {
	if (!env.VITEST) return COST;
	const n = Number(env.PASSWORD_HASH_COST);
	return Number.isInteger(n) && n >= 4 && n <= COST ? n : COST;
}

export const hashPassword = (password: string) => bcrypt.hash(password, hashCost());
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/** A real hash of a random string, compared against when the email is unknown,
 *  so login timing doesn't reveal which emails have accounts. */
export const DUMMY_HASH = '$2b$12$9Vik78a3Kg7RDbvCFYCJgOZBiF9Zmk/m4MlqKjPTD.qUkhqk6vykW';
