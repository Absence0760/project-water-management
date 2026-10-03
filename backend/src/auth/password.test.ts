import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, PASSWORD_COST, passwordCost, PREHASH_PREFIX, PRODUCTION_COST, verifyPassword } from './password';

// The literal password.ts uses at cost 12 (read from the source: under vitest the module computes a cost-4 one).
const DUMMY_HASH_12 = (readFileSync(new URL('./password.ts', import.meta.url), 'utf8').match(/'(\$2b\$12\$[./A-Za-z0-9]{53})'/) ?? [])[1] ?? '';

describe('password hashing', () => {
	it('uses bcrypt’s minimum cost under test, and a dummy hash of the same cost', async () => {
		expect(PASSWORD_COST).toBe(4);
		const h = await hashPassword('correct horse');
		expect(h.startsWith(`${PREHASH_PREFIX}$2b$04$`)).toBe(true);
		const scheme = (x: string) => x.slice(0, PREHASH_PREFIX.length + 7);
		expect(scheme(DUMMY_HASH)).toBe(scheme(h));
		expect(await verifyPassword('correct horse', h)).toBe(true);
		expect(await verifyPassword('correct horse', DUMMY_HASH)).toBe(false);
	});

	it('keeps cost 12 outside tests: the production work factor, with no override set', () => {
		expect(PRODUCTION_COST).toBe(12);
		expect(passwordCost({})).toBe(12);
		expect(passwordCost({ PASSWORD_HASH_COST: '' })).toBe(12);
		expect(passwordCost({ AWS_LAMBDA_FUNCTION_NAME: 'water-api' })).toBe(12);
	});

	it('lets the e2e server lower the cost (PASSWORD_HASH_COST), within bcrypt’s range and never above 12', () => {
		expect(passwordCost({ PASSWORD_HASH_COST: '4' })).toBe(4);
		expect(passwordCost({ PASSWORD_HASH_COST: '10' })).toBe(10);
		for (const bad of ['3', '13', '4.5', 'four', '-4']) {
			expect(() => passwordCost({ PASSWORD_HASH_COST: bad }), bad).toThrow(/from 4 to 12/);
		}
	});

	it('refuses a lowered cost on Lambda, so production can’t be misconfigured', () => {
		expect(() => passwordCost({ PASSWORD_HASH_COST: '4', AWS_LAMBDA_FUNCTION_NAME: 'water-api' })).toThrow(/e2e server only/);
		expect(passwordCost({ PASSWORD_HASH_COST: '12', AWS_LAMBDA_FUNCTION_NAME: 'water-api' })).toBe(12);
	});

	it('vitest wins over the override (the db suite relies on cost 4)', () => {
		expect(passwordCost({ VITEST: 'true', PASSWORD_HASH_COST: '12' })).toBe(4);
	});

	it('tells apart long passwords that share their first 72 bytes (bcrypt reads no further)', async () => {
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

	it('still checks a hash made before the SHA-256 step (a plain bcrypt hash) against the password as typed', async () => {
		const legacy = await bcrypt.hash('correct horse', 4);
		expect(await verifyPassword('correct horse', legacy)).toBe(true);
		expect(await verifyPassword('wrong horse', legacy)).toBe(false);
	});

	it('never checks the SHA-256 itself as a password: the prefix decides the scheme', async () => {
		const h = await hashPassword('correct horse');
		const { createHash } = await import('node:crypto');
		const digest = createHash('sha256').update('correct horse', 'utf8').digest('base64');
		expect(await verifyPassword(digest, h)).toBe(false);
	});

	it('the cost-12 dummy hash is a real cost-12 bcrypt hash', () => {
		expect(bcrypt.getRounds(DUMMY_HASH_12)).toBe(12);
	});
});
