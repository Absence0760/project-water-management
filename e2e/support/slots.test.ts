// The e2e slot registry (support/slots.ts). Run by `pnpm test` (node:test).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claimSlot, gitCommonDir, registryDir } from './slots.ts';

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), 'e2e-slots-')));
}

test('worktrees that hash to the same slot get different ones, and keep them', () => {
	const dir = join(scratch(), 'slots');
	const alive = () => true;
	const a = claimSlot(dir, '/w/a', 3, 99, alive);
	const b = claimSlot(dir, '/w/b', 3, 99, alive);
	const c = claimSlot(dir, '/w/c', 3, 99, alive);
	assert.deepEqual([a, b, c], [3, 4, 5]);
	assert.equal(claimSlot(dir, '/w/b', 3, 99, alive), 4, 'stable for the same path');
	assert.equal(readFileSync(join(dir, '4'), 'utf8').trim(), '/w/b');
});

test('the search wraps past the last slot', () => {
	const dir = join(scratch(), 'slots');
	assert.equal(claimSlot(dir, '/w/a', 98, 99, () => true), 98);
	assert.equal(claimSlot(dir, '/w/b', 98, 99, () => true), 1);
});

test("a removed worktree's slot is taken back; a live one's never is", () => {
	const dir = join(scratch(), 'slots');
	assert.equal(claimSlot(dir, '/w/gone', 10, 99, () => true), 10);
	assert.equal(claimSlot(dir, '/w/live', 10, 99, () => true), 11);
	assert.equal(claimSlot(dir, '/w/new', 10, 99, (p) => p !== '/w/gone'), 10);
	assert.equal(readFileSync(join(dir, '10'), 'utf8').trim(), '/w/new');
});

test('all slots held by live worktrees: a clear error naming E2E_SLOT', () => {
	const dir = join(scratch(), 'slots');
	claimSlot(dir, '/w/a', 1, 3, () => true);
	claimSlot(dir, '/w/b', 1, 3, () => true);
	assert.throws(() => claimSlot(dir, '/w/c', 1, 3, () => true), /E2E_SLOT/);
});

test('parallel claims from separate processes never share a slot', async () => {
	const dir = join(scratch(), 'slots');
	const mod = fileURLToPath(new URL('./slots.ts', import.meta.url));
	const runs = Array.from({ length: 8 }, (_, i) =>
		new Promise<string>((done, fail) => {
			const child = spawn(process.execPath, ['--input-type=module', '-e', `import { claimSlot } from ${JSON.stringify(mod)}; process.stdout.write(String(claimSlot(${JSON.stringify(dir)}, '/w/${i}', 5, 99, () => true)));`]);
			let out = '';
			child.stdout.on('data', (d) => (out += d));
			child.on('exit', (code) => (code === 0 ? done(out) : fail(new Error(`claim ${i} exited ${code}`))));
		})
	);
	const slots = await Promise.all(runs);
	assert.equal(new Set(slots).size, 8, `slots ${slots.join(',')}`);
});

test("a real worktree's registry is in the main checkout's .git", () => {
	const root = scratch();
	const main = join(root, 'main');
	mkdirSync(main);
	const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'pipe' });
	git('init', '-q');
	writeFileSync(join(main, 'f'), 'x');
	git('add', 'f');
	git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'x');
	git('worktree', 'add', '-q', join(root, 'wt'));
	assert.equal(gitCommonDir(join(root, 'wt')), join(main, '.git'));
	assert.equal(registryDir(join(root, 'wt')), join(main, '.git', 'water-e2e-slots'));
	assert.equal(gitCommonDir(main), null, 'the main checkout has no .git file');
	rmSync(root, { recursive: true, force: true });
});
