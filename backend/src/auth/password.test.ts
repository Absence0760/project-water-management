import { describe, expect, it } from 'vitest';
import { hashCost, hashPassword, verifyPassword } from './password.js';

describe('hashCost', () => {
	it('is 12 outside vitest, whatever PASSWORD_HASH_COST says', () => {
		expect(hashCost({ PASSWORD_HASH_COST: '4' })).toBe(12);
		expect(hashCost({})).toBe(12);
	});

	it('under vitest takes PASSWORD_HASH_COST between 4 and 12, else 12', () => {
		expect(hashCost({ VITEST: 'true', PASSWORD_HASH_COST: '4' })).toBe(4);
		expect(hashCost({ VITEST: 'true', PASSWORD_HASH_COST: '12' })).toBe(12);
		for (const bad of [undefined, '', '3', '13', '4.5', 'x']) expect(hashCost({ VITEST: 'true', PASSWORD_HASH_COST: bad })).toBe(12);
	});

	it('the test setup lowers it, and the hash still verifies', async () => {
		expect(hashCost()).toBe(4);
		const hash = await hashPassword('correct horse');
		expect(hash).toMatch(/^\$2[aby]\$04\$/);
		expect(await verifyPassword('correct horse', hash)).toBe(true);
		expect(await verifyPassword('wrong', hash)).toBe(false);
	});
});
