import { describe, expect, it } from 'vitest';
import { testDbName } from './test-db.js';

describe('per-checkout test database', () => {
	it('the main checkout and CI keep water_test', () => {
		expect(testDbName('/repo', false)).toBe('water_test');
	});
	it('a worktree gets a stable water_test_w<1–98> that the setup guard accepts', () => {
		const names = Array.from({ length: 12 }, (_, i) => testDbName(`/repo/.claude/worktrees/agent-${i}`, true));
		for (const n of names) expect(n).toMatch(/^water_test_w([1-9]|[1-8][0-9]|9[0-8])$/);
		expect(testDbName('/repo/.claude/worktrees/agent-0', true)).toBe(names[0]);
		expect(new Set(names).size).toBeGreaterThanOrEqual(10);
	});
});
