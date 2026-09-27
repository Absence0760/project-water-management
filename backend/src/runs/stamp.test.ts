// The run stamp's key and comparison (runs/stamp.ts); the database side is
// stamp.db.test.ts.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runStamp, stampMatches } from './stamp.js';

const SECRET = process.env.AUTH_JWT_SECRET;
afterEach(() => {
	process.env.AUTH_JWT_SECRET = SECRET;
});

const digest = Buffer.alloc(32, 1);

describe('runStamp', () => {
	it('is a 32-byte HMAC under its own derived key, never the session secret itself', () => {
		const stamp = runStamp(digest);
		expect(stamp).toHaveLength(32);
		expect(stamp.equals(createHmac('sha256', SECRET!).update(digest).digest())).toBe(false);
		expect(runStamp(digest).equals(stamp)).toBe(true);
	});

	it('changes with the secret (a rotation leaves stored runs unverified)', () => {
		const before = runStamp(digest);
		process.env.AUTH_JWT_SECRET = 'x'.repeat(40);
		expect(runStamp(digest).equals(before)).toBe(false);
		expect(stampMatches(digest, before)).toBe(false);
	});

	it('refuses to sign without a real secret', () => {
		process.env.AUTH_JWT_SECRET = 'short';
		expect(() => runStamp(digest)).toThrow(/AUTH_JWT_SECRET/);
	});
});

describe('stampMatches', () => {
	it('takes only the stamp of that very digest (control: it does take it)', () => {
		const stamp = runStamp(digest);
		expect(stampMatches(digest, stamp)).toBe(true);
		expect(stampMatches(Buffer.alloc(32, 2), stamp)).toBe(false);
		expect(stampMatches(digest, Buffer.alloc(32, 0))).toBe(false);
		expect(stampMatches(digest, stamp.subarray(0, 31))).toBe(false);
		expect(stampMatches(null, stamp)).toBe(false);
		expect(stampMatches(digest, null)).toBe(false);
	});
});
