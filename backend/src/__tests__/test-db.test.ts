import { describe, expect, it } from 'vitest';
import { testDbName } from './test-db.js';

// Three worktrees that ran DB tests at once and all got water_test_w3 from the old 1–98 slot.
const COLLIDED = ['/home/jared/github/wm-r2-delineate-job', '/home/jared/github/wm-r2-followups2', '/home/jared/github/wm-r3-licensing-authority'];

describe('per-checkout test database', () => {
	it('the main checkout and CI keep water_test', () => {
		expect(testDbName('/repo', false)).toBe('water_test');
	});

	it('a worktree gets water_test_w<16 hex>, which the setup guards accept', () => {
		const name = testDbName('/repo/.claude/worktrees/agent-0', true);
		expect(name).toMatch(/^water_test_w[0-9a-f]{16}$/);
		// setup.ts and db-global-setup.ts refuse anything else.
		expect(`postgresql://x@h/${name}`).toMatch(/\/water_test(_[a-z0-9_]+)?$/);
		// migrate.db.test.ts's scratch database too, within Postgres's 63-byte identifier limit.
		expect(`${name}_migrate`.length).toBeLessThanOrEqual(63);
	});

	it('is stable for a path', () => {
		expect(testDbName('/repo/wt', true)).toBe(testDbName('/repo/wt', true));
	});

	it('gives distinct paths distinct names, the three that once shared water_test_w3 included', () => {
		expect(new Set(COLLIDED.map((p) => testDbName(p, true))).size).toBe(3);
		const many = Array.from({ length: 2000 }, (_, i) => testDbName(`/home/x/github/wm-agent-${i}`, true));
		expect(new Set(many).size).toBe(many.length);
	});
});
