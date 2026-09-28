#!/usr/bin/env node
// The fast inner loop: typecheck and unit-test only what the working changes
// touch, in seconds rather than the full suites' minutes (docs/testing.md).
//
//   pnpm test:changed              changes since the merge-base with origin/main, committed or not
//   pnpm test:changed -- --base HEAD   only the uncommitted changes
//
// What it runs, for the files changed since the base:
//   - `check` (typecheck) in each workspace a changed file belongs to, and in
//     frontend and backend too when the engine changed (they import its source);
//   - `vitest run --changed <base>` in engine, frontend and backend: vitest
//     follows each workspace's module graph, so a frontend test that imports a
//     changed engine file runs, and one that doesn't is skipped;
//   - the backend's db project the same way when local Postgres (:5434) is up;
//   - node:test for changed scripts/ guards.
// Playwright is never run here (minutes, and it builds the frontend): it names
// the e2e specs that changed, for `pnpm test:e2e <spec>`. The full suites stay
// the gate before a commit or push: pnpm check && pnpm test.
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';

const args = process.argv.slice(2);
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;

const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
const base = baseArg ?? (git('merge-base', 'HEAD', 'origin/main').stdout.trim() || 'HEAD');

const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const changed = [
	...new Set([
		...lines(git('diff', '--name-only', base).stdout),
		...lines(git('ls-files', '--others', '--exclude-standard').stdout)
	])
];

if (!changed.length) {
	console.log(`test:changed: nothing changed since ${base.slice(0, 12)}.`);
	process.exit(0);
}

const WORKSPACES = { engine: 'packages/engine', frontend: 'frontend', backend: 'backend', e2e: 'e2e' };
const touched = new Set(Object.entries(WORKSPACES).filter(([, dir]) => changed.some((f) => f.startsWith(`${dir}/`))).map(([name]) => name));
// Frontend and backend compile the engine's source: an engine change can break either.
if (touched.has('engine')) {
	touched.add('frontend');
	touched.add('backend');
}

const results = [];
function step(label, cmd, cmdArgs, opts = {}) {
	const t0 = Date.now();
	console.log(`\n▶ ${label}`);
	const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
	results.push({ label, ok: r.status === 0, s: ((Date.now() - t0) / 1000).toFixed(1) });
}

const dbUp = await new Promise((done) => {
	const sock = connect({ host: '127.0.0.1', port: 5434 });
	sock.setTimeout(500);
	sock.on('connect', () => (sock.destroy(), done(true)));
	sock.on('error', () => done(false));
	sock.on('timeout', () => (sock.destroy(), done(false)));
});

console.log(`test:changed: ${changed.length} file(s) changed since ${base.slice(0, 12)}; workspaces: ${[...touched].join(', ') || 'none'}`);

for (const name of ['engine', 'frontend', 'backend', 'e2e']) {
	if (touched.has(name)) step(`typecheck ${name}`, 'pnpm', ['-C', WORKSPACES[name], 'check']);
}
// --passWithNoTests: a workspace no change reaches has nothing to run, which is a pass.
const vitest = (dir, extra = []) => ['-C', dir, 'exec', 'vitest', 'run', '--changed', base, '--passWithNoTests', ...extra];
step('unit tests engine (changed)', 'pnpm', vitest(WORKSPACES.engine, ['--project', 'unit']));
step('unit tests frontend (changed)', 'pnpm', vitest(WORKSPACES.frontend));
step('unit tests backend (changed)', 'pnpm', vitest(WORKSPACES.backend, ['--project', 'unit']));
if (dbUp) step('db tests backend (changed)', 'pnpm', vitest(WORKSPACES.backend, ['--project', 'db']));
else console.log('\n(skipped the backend db tests: local Postgres on :5434 is down; pnpm dev:db:up)');

const guards = changed.filter((f) => /^scripts\/(guards|release)\/.*\.test\.mjs$/.test(f) || /^scripts\/(guards|release)\/[^/]+\.mjs$/.test(f));
if (guards.length) step('script guards', 'pnpm', ['test:guards']);
if (changed.includes('package.json') || changed.some((f) => f.startsWith('scripts/'))) step('root scripts guard', 'pnpm', ['test:scripts']);

const specs = changed.filter((f) => /^e2e\/tests\/.*\.spec\.ts$/.test(f));
if (specs.length) console.log(`\ne2e specs changed (not run here): pnpm test:e2e ${specs.map((f) => f.replace(/^e2e\//, '')).join(' ')}`);

console.log('\n── test:changed ──');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.label} (${r.s}s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
