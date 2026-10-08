// The emailed second-factor code (auth/emailCode.ts, 206): generation,
// normalising what was typed, and the keyed hash it is stored as.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMAIL_CODE_SEND, EMAIL_CODE_TTL_SECONDS, hashEmailCode, newEmailCode, normaliseEmailCode } from './emailCode.js';

const KEY = { APP_ENCRYPTION_KEY: 'test-only-0123456789abcdef0123456789abcdef' };
const USER = '7a0c9f2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('newEmailCode', () => {
	it('is six digits, leading zeros kept, and spread over the whole range', () => {
		const seen = new Set<string>();
		let low = 0;
		for (let i = 0; i < 2000; i++) {
			const c = newEmailCode();
			expect(c).toMatch(/^\d{6}$/);
			seen.add(c);
			if (c.startsWith('0')) low++;
		}
		// 2000 draws from a million: repeats are rare, and about a tenth start with 0.
		expect(seen.size).toBeGreaterThan(1990);
		expect(low).toBeGreaterThan(100);
		expect(low).toBeLessThan(320);
	});
});

describe('normaliseEmailCode', () => {
	it('forgives spaces and a dash, and refuses anything but six digits', () => {
		expect(normaliseEmailCode(' 012 345 ')).toBe('012345');
		expect(normaliseEmailCode('012-345')).toBe('012345');
		for (const bad of ['', '12345', '1234567', '01234a', 'ABCDE-FGH23']) expect(normaliseEmailCode(bad), bad).toBeNull();
	});
});

describe('hashEmailCode', () => {
	it('is a 32-byte HMAC, bound to the account, the purpose and the key', () => {
		const h = hashEmailCode(USER, 'use', '012345', KEY);
		expect(h).toHaveLength(32);
		expect(hashEmailCode(USER.toUpperCase(), 'use', '012345', KEY).equals(h)).toBe(true);
		expect(hashEmailCode(USER, 'use', '012346', KEY).equals(h)).toBe(false);
		expect(hashEmailCode(USER, 'enrol', '012345', KEY).equals(h)).toBe(false);
		expect(hashEmailCode('00000000-0000-4000-8000-000000000000', 'use', '012345', KEY).equals(h)).toBe(false);
		expect(hashEmailCode(USER, 'use', '012345', { APP_ENCRYPTION_KEY: 'another-test-key-0123456789abcdef0123456789' }).equals(h)).toBe(false);
		// Not a plain digest anyone could recompute from the table for all million codes.
		for (const plain of ['012345', `${USER}012345`, `${USER}\u0000use\u0000012345`]) expect(createHash('sha256').update(plain).digest().equals(h)).toBe(false);
	});

	it('refuses to hash without a real key', () => {
		expect(() => hashEmailCode(USER, 'use', '012345', { APP_ENCRYPTION_KEY: 'short' })).toThrow(/APP_ENCRYPTION_KEY/);
	});

	it('the limits are what the docs say: 10 minutes, a minute apart, five an hour', () => {
		expect(EMAIL_CODE_TTL_SECONDS).toBe(600);
		expect(EMAIL_CODE_SEND).toEqual({ gapSeconds: 60, perHour: 5 });
	});
});
