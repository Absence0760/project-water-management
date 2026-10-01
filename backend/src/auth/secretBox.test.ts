// Sealing the TOTP secrets at rest (auth/secretBox.ts, issue #282): a sealed
// secret opens only under the same key and for the same account, and any
// change to it is refused rather than opening to something else.
import { describe, expect, it } from 'vitest';
import { open, seal } from './secretBox.js';

const env = { APP_ENCRYPTION_KEY: 'test-only-app-encryption-key-00000000000' };
const other = { APP_ENCRYPTION_KEY: 'another-key-that-is-long-enough-000000000' };
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const secret = Buffer.from('12345678901234567890');

describe('seal / open', () => {
	it('round-trips, and seals the same secret differently each time (a fresh IV)', () => {
		const a = seal(secret, alice, env);
		const b = seal(secret, alice, env);
		expect(open(a, alice, env)).toEqual(secret);
		expect(a.equals(b)).toBe(false);
		expect(a.includes(secret)).toBe(false);
		expect(a[0]).toBe(1);
		expect(a).toHaveLength(1 + 12 + 16 + 20);
	});
	it('ignores the case of the account id', () => {
		expect(open(seal(secret, alice.toUpperCase(), env), alice, env)).toEqual(secret);
	});
	it('refuses another account’s sealed secret (the account id is authenticated)', () => {
		expect(() => open(seal(secret, alice, env), bob, env)).toThrow();
	});
	it('refuses under another key', () => {
		expect(() => open(seal(secret, alice, env), alice, other)).toThrow();
	});
	it('refuses any changed byte, and a wrong version or a short value', () => {
		const sealed = seal(secret, alice, env);
		for (const i of [0, 5, 20, sealed.length - 1]) {
			const bad = Buffer.from(sealed);
			bad[i] = bad[i]! ^ 1;
			expect(() => open(bad, alice, env), `byte ${i}`).toThrow();
		}
		expect(() => open(sealed.subarray(0, 20), alice, env)).toThrow(/not a sealed secret/);
	});
	it('needs a key of at least 32 characters', () => {
		expect(() => seal(secret, alice, { APP_ENCRYPTION_KEY: 'short' })).toThrow(/APP_ENCRYPTION_KEY/);
		expect(() => seal(secret, alice, {})).toThrow(/APP_ENCRYPTION_KEY/);
	});
});
