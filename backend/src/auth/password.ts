import bcrypt from 'bcryptjs';

// bcryptjs is pure JS (no native build step), so the Lambda bundle stays
// portable. Cost 12 ≈ 250 ms per hash on Lambda — acceptable for login only.
const COST = 12;

export const hashPassword = (password: string) => bcrypt.hash(password, COST);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/** A real hash of a random string, compared against when the email is unknown,
 *  so login timing doesn't reveal which emails have accounts. */
export const DUMMY_HASH = '$2b$12$9Vik78a3Kg7RDbvCFYCJgOZBiF9Zmk/m4MlqKjPTD.qUkhqk6vykW';
