import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { dummyHash, FAST_PARAMS, hashPassword, needsRehash, parseArgon2, PASSWORD_PARAMS, passwordParams, PRODUCTION_PARAMS, verifyPassword } from './password';

describe('password hashing', () => {
	it('hashes with Argon2id as a PHC string, at the fast parameters under test', async () => {
		expect(PASSWORD_PARAMS).toEqual(FAST_PARAMS);
		const h = await hashPassword('correct horse');
		expect(h).toMatch(/^\$argon2id\$v=19\$m=8,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
		expect(await verifyPassword('correct horse', h)).toBe(true);
		expect(await verifyPassword('correct horsf', h)).toBe(false);
		// A fresh salt each time: the same password never hashes the same.
		expect(await hashPassword('correct horse')).not.toBe(h);
	});

	it('uses RFC 9106’s 64 MiB, 3-pass parameters outside tests, with no override set', () => {
		expect(PRODUCTION_PARAMS).toEqual({ m: 65536, t: 3, p: 1 });
		expect(passwordParams({})).toBe(PRODUCTION_PARAMS);
		expect(passwordParams({ PASSWORD_HASH_FAST: '' })).toBe(PRODUCTION_PARAMS);
		expect(passwordParams({ AWS_LAMBDA_FUNCTION_NAME: 'water-api' })).toBe(PRODUCTION_PARAMS);
	});

	it('lets the e2e server use the fast parameters (PASSWORD_HASH_FAST=1), and nothing else', () => {
		expect(passwordParams({ PASSWORD_HASH_FAST: '1' })).toBe(FAST_PARAMS);
		for (const bad of ['0', 'true', '4', 'yes']) expect(() => passwordParams({ PASSWORD_HASH_FAST: bad }), bad).toThrow(/must be 1 or unset/);
	});

	it('refuses the fast parameters on Lambda, so production can’t be misconfigured', () => {
		expect(() => passwordParams({ PASSWORD_HASH_FAST: '1', AWS_LAMBDA_FUNCTION_NAME: 'water-api' })).toThrow(/e2e server only/);
	});

	it('vitest wins (the db suite relies on the fast parameters)', () => {
		expect(passwordParams({ VITEST: 'true' })).toBe(FAST_PARAMS);
	});

	it('checks a hash by the parameters it carries, so raising them leaves older hashes checkable', async () => {
		const older = await hashPassword('correct horse', { m: 16, t: 2, p: 1 });
		expect(parseArgon2(older)?.params).toEqual({ m: 16, t: 2, p: 1 });
		expect(await verifyPassword('correct horse', older)).toBe(true);
		expect(needsRehash(older)).toBe(true);
		expect(needsRehash(await hashPassword('correct horse'))).toBe(false);
	});

	it('reads the whole password: long passphrases that share their first 72 bytes differ', async () => {
		const shared = 'correct horse battery staple '.repeat(3); // 87 bytes
		const h = await hashPassword(`${shared}one`);
		expect(await verifyPassword(`${shared}one`, h)).toBe(true);
		expect(await verifyPassword(`${shared}two`, h)).toBe(false);
		// Multi-byte characters count as bytes: 40 × 'ü' is 80 bytes, so these differ only past byte 72.
		const umlauts = 'ü'.repeat(40);
		const u = await hashPassword(`${umlauts}a`);
		expect(await verifyPassword(`${umlauts}a`, u)).toBe(true);
		expect(await verifyPassword(`${umlauts}b`, u)).toBe(false);
	});

	it('still checks a legacy bcrypt hash against the password as typed, and marks it for rehashing', async () => {
		const legacy = await bcrypt.hash('correct horse', 4);
		expect(await verifyPassword('correct horse', legacy)).toBe(true);
		expect(await verifyPassword('wrong horse', legacy)).toBe(false);
		expect(needsRehash(legacy)).toBe(true);
	});

	it('never matches a hash it doesn’t recognise, nor one with out-of-bounds parameters', async () => {
		const h = await hashPassword('correct horse');
		for (const bad of ['', 'correct horse', `$wm-sha256$${await bcrypt.hash('x', 4)}`, h.replace('$argon2id$', '$argon2i$'), h.replace('m=8,', 'm=99999999,'), h.replace('t=1,', 't=0,')]) {
			expect(await verifyPassword('correct horse', bad), bad).toBe(false);
		}
	});

	it('the dummy hash for unknown emails is a real hash at the parameters in use, made once', async () => {
		const d = await dummyHash();
		expect(parseArgon2(d)?.params).toEqual(PASSWORD_PARAMS);
		expect(await dummyHash()).toBe(d);
		expect(await verifyPassword('correct horse', d)).toBe(false);
	});
});
