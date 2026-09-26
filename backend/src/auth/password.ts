import bcrypt from 'bcryptjs';

// bcryptjs is pure JS (no native build step), so the Lambda bundle stays
// portable. Cost 12 ≈ 250 ms per hash on Lambda — acceptable for login only.
//
// Under vitest the cost is bcrypt's minimum, 4: the db suite signs up and logs
// in hundreds of times, and at cost 12 the lockout tests spent their whole
// 5 s budget hashing (bcryptjs is ~300 ms a hash on a dev laptop). What they
// test is the counting and locking, not the work factor. Everything else,
// Lambda and the local dev server included, uses 12.
const UNDER_TEST = Boolean(process.env.VITEST);
export const PASSWORD_COST = UNDER_TEST ? 4 : 12;

export const hashPassword = (password: string) => bcrypt.hash(password, PASSWORD_COST);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/** A real hash of a random string, compared against when the email is unknown,
 *  so login timing doesn't reveal which emails have accounts. It has the cost
 *  in use, so an unknown email takes as long as a known one. */
export const DUMMY_HASH = UNDER_TEST ? bcrypt.hashSync('not-a-password-8c1f', 4) : '$2b$12$9Vik78a3Kg7RDbvCFYCJgOZBiF9Zmk/m4MlqKjPTD.qUkhqk6vykW';
