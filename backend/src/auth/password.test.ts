import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, PASSWORD_COST, verifyPassword } from './password';

describe('password hashing', () => {
	it('uses bcrypt’s minimum cost under test, and a dummy hash of the same cost', async () => {
		expect(PASSWORD_COST).toBe(4);
		const h = await hashPassword('correct horse');
		expect(h.slice(0, 7)).toBe('$2b$04$');
		expect(DUMMY_HASH.slice(0, 7)).toBe(h.slice(0, 7));
		expect(await verifyPassword('correct horse', h)).toBe(true);
		expect(await verifyPassword('correct horse', DUMMY_HASH)).toBe(false);
	});

	it('keeps cost 12 outside tests (the production work factor, and its dummy hash)', () => {
		const src = readFileSync(new URL('./password.ts', import.meta.url), 'utf8');
		expect(src).toMatch(/PASSWORD_COST = UNDER_TEST \? 4 : 12;/);
		expect(src).toMatch(/: '\$2b\$12\$[./A-Za-z0-9]{53}';/);
	});
});
