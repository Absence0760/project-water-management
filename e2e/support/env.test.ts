// The per-checkout e2e slot and database (support/env.ts). Run by `pnpm test` (node:test;
// e2e has no unit-test framework of its own).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDirsFor, e2eDbName, hashedSlot, slotFor } from './env.ts';

test('the main checkout and CI use slot 0 (:3101, :7801, water_e2e)', () => {
	assert.equal(slotFor('/home/me/github/project-water-management', false), 0);
	assert.equal(e2eDbName('/home/me/github/project-water-management', false, 0), 'water_e2e');
});

test('without a registry, a worktree gets a stable hashed slot from 1 to 98', () => {
	const paths = Array.from({ length: 12 }, (_, i) => `/repo/.claude/worktrees/agent-${i}`);
	const slots = paths.map((p) => slotFor(p, true, undefined, null));
	for (const s of slots) assert.ok(s >= 1 && s <= 98, `slot ${s}`);
	assert.deepEqual(paths.map((p) => hashedSlot(p)), slots, 'same path, same slot');
});

test('E2E_SLOT overrides the derived slot, and a bad value is refused', () => {
	assert.equal(slotFor('/any', true, '0', null), 0);
	assert.equal(slotFor('/any', false, '42'), 42);
	assert.equal(slotFor('/any', true, '', null), slotFor('/any', true, undefined, null));
	for (const bad of ['99', '-1', '1.5', 'abc']) assert.throws(() => slotFor('/any', false, bad), /E2E_SLOT/);
});

test("a worktree's database is named by its path and slot: distinct between checkouts, stable, a valid identifier", () => {
	// Three worktrees whose hashed slots and databases once collided (the DB tests' water_test_w3).
	const paths = ['/home/jared/github/wm-r2-delineate-job', '/home/jared/github/wm-r2-followups2', '/home/jared/github/wm-r3-licensing-authority'];
	assert.equal(new Set(paths.map((p) => e2eDbName(p, true, 3))).size, 3, 'same slot, different checkouts, different databases');
	const many = Array.from({ length: 2000 }, (_, i) => e2eDbName(`/home/x/wm-${i}`, true, 98));
	assert.equal(new Set(many).size, many.length);
	assert.equal(e2eDbName('/home/x/wm-a', true, 7), e2eDbName('/home/x/wm-a', true, 7));
	assert.notEqual(e2eDbName('/home/x/wm-a', true, 7), e2eDbName('/home/x/wm-a', true, 8), 'two slots in one checkout');
	assert.notEqual(e2eDbName('/home/x/main', false, 5), 'water_e2e', 'the main checkout on another slot by hand');
	for (const name of [...many, e2eDbName('/home/x/main', false, 5)]) {
		assert.match(name, /^water_e2e_w[0-9a-f]{16}_\d{1,2}$/);
		assert.ok(name.length <= 63, 'within Postgres identifier limit');
	}
});

test('slot 0 builds the site into build-e2e (CI uploads that path); any other slot into its own folders', () => {
	assert.deepEqual(buildDirsFor(0), { build: 'build-e2e', kit: '.svelte-kit-e2e' });
	assert.deepEqual(buildDirsFor(76), { build: 'build-e2e-76', kit: '.svelte-kit-e2e-76' });
	assert.notEqual(buildDirsFor(3).build, buildDirsFor(4).build);
});
