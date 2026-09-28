import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashToken, newToken, parseToken } from './tokens.js';

describe('email tokens', () => {
	it('are 256-bit base64url strings, stored as their SHA-256', () => {
		const { token, hash } = newToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(token, 'base64url')).toHaveLength(32);
		expect(hash.equals(createHash('sha256').update(token).digest())).toBe(true);
		expect(newToken().token).not.toBe(token);
	});

	it('parseToken hashes well-formed tokens and rejects anything else', () => {
		const { token, hash } = newToken();
		expect(parseToken(token)!.equals(hash)).toBe(true);
		expect(parseToken('')).toBeNull();
		expect(parseToken(`${token}x`)).toBeNull();
		expect(parseToken(token.replace(/.$/, '='))).toBeNull();
		expect(hashToken('a')).toHaveLength(32);
	});
});
