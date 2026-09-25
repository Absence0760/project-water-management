// The per-checkout e2e slot (support/env.ts). Run by `pnpm test` (node:test;
// e2e has no unit-test framework of its own).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slotFor } from './env.ts';

test('the main checkout and CI use slot 0 (:3101, :7801, water_e2e)', () => {
	assert.equal(slotFor('/home/me/github/project-water-management', false), 0);
});

test('a worktree gets a stable slot from 1 to 98, and different paths usually differ', () => {
	const paths = Array.from({ length: 12 }, (_, i) => `/repo/.claude/worktrees/agent-${i}`);
	const slots = paths.map((p) => slotFor(p, true));
	for (const s of slots) assert.ok(s >= 1 && s <= 98, `slot ${s}`);
	assert.deepEqual(paths.map((p) => slotFor(p, true)), slots, 'same path, same slot');
	assert.ok(new Set(slots).size >= 10, `12 worktrees landed on only ${new Set(slots).size} slots`);
});

test('E2E_SLOT overrides the derived slot, and a bad value is refused', () => {
	assert.equal(slotFor('/any', true, '0'), 0);
	assert.equal(slotFor('/any', false, '42'), 42);
	assert.equal(slotFor('/any', true, ''), slotFor('/any', true));
	for (const bad of ['99', '-1', '1.5', 'abc']) assert.throws(() => slotFor('/any', false, bad), /E2E_SLOT/);
});
