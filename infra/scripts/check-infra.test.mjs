// bin/check-infra.sh (`pnpm check:infra`) against a fake `terraform` that
// reports where it ran and what it saw, in a throwaway git repo shaped like
// this one (bin/ + infra/). Terraform runs in a private copy of infra/, never
// in infra/ itself: the local-backend override lives only in the copy, so
// neither a SIGKILL mid-run nor two runs at once can leave one behind in the
// checkout (issue #126). The copy holds what git would commit, so a
// gitignored terraform.tfvars or the operator's own *_override.tf stays out;
// an override an older version of the script left behind is refused. Needs
// bash, git and node. No Terraform, no AWS.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const here = new URL('.', import.meta.url).pathname;
const script = join(here, '..', '..', 'bin', 'check-infra.sh');
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
const STALE_OVERRIDE = 'terraform {\n  backend "local" {}\n}\n';

function setup() {
	// realpath: on macOS tmpdir() is under /var, a symlink to /private/var, and the
	// fake terraform reports process.cwd(), which is always the resolved path.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'check-infra-test-')));
	const repo = join(dir, 'repo');
	mkdirSync(join(repo, 'bin'), { recursive: true });
	mkdirSync(join(repo, 'infra', 'tests'), { recursive: true });
	copyFileSync(script, join(repo, 'bin', 'check-infra.sh'));
	writeFileSync(join(repo, 'infra', 'main.tf'), 'terraform {}\n');
	writeFileSync(join(repo, 'infra', 'tests', 'a.tftest.hcl'), 'run "a" {}\n');
	writeFileSync(join(repo, 'infra', '.gitignore'), '*_override.tf\n*.tfvars\n.terraform/\n');
	spawnSync('git', ['init', '-q', repo]);
	spawnSync('git', ['-C', repo, 'add', '.']);
	// Untracked but not ignored: a file being written right now is checked too.
	writeFileSync(join(repo, 'infra', 'new.tf'), '# new\n');
	// Ignored: must never reach the copy.
	writeFileSync(join(repo, 'infra', 'terraform.tfvars'), 'secret = "synthetic"\n');
	writeFileSync(join(repo, 'infra', 'mine_override.tf'), '# operator override\n');

	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(
		join(bin, 'terraform'),
		`#!/usr/bin/env node
const { appendFileSync, readdirSync, readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const cwd = process.cwd();
appendFileSync(process.env.FAKE_TF_LOG, JSON.stringify({
	args, cwd, cache: process.env.TF_PLUGIN_CACHE_DIR, files: readdirSync(cwd).sort(),
	override: (() => { try { return readFileSync(cwd + '/backend_override.tf', 'utf8'); } catch { return null; } })(),
}) + '\\n');
if (args[0] === 'init') { mkdirSync(cwd + '/.terraform', { recursive: true }); writeFileSync(cwd + '/.terraform/stub.zip', String(process.pid)); }
if (process.env.FAKE_TF_SLEEP_ON === args[0]) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_TF_SLEEP_MS));
if (process.env.FAKE_TF_FAIL_ON === args[0]) process.exit(3);
if (process.env.FAKE_TF_FAIL_FILTER && args.includes('-filter=' + process.env.FAKE_TF_FAIL_FILTER)) { console.log('FAKE FAIL ' + process.env.FAKE_TF_FAIL_FILTER); process.exit(1); }
if (args[0] === 'test') console.log('FAKE RAN ' + (args[1] ?? 'all'));
`,
	);
	chmodSync(join(bin, 'terraform'), 0o755);
	const log = join(dir, 'tf.log');
	writeFileSync(log, '');
	const tmp = join(dir, 'tmp');
	mkdirSync(tmp);
	return { dir, repo, bin, log, tmp, cache: join(dir, 'cache') };
}

const envFor = (ctx, extra = {}) => ({
	PATH: `${ctx.bin}:${process.env.PATH}`,
	HOME: ctx.dir,
	TMPDIR: ctx.tmp,
	TF_PLUGIN_CACHE_DIR: ctx.cache,
	FAKE_TF_LOG: ctx.log,
	...extra,
});

const runSync = (ctx, extra, args = []) => spawnSync(BASH, [join(ctx.repo, 'bin', 'check-infra.sh'), ...args], { encoding: 'utf8', env: envFor(ctx, extra) });
const calls = (ctx) =>
	readFileSync(ctx.log, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
const infraFiles = (ctx) => readdirSync(join(ctx.repo, 'infra')).sort();

test('runs fmt, init, validate and test in a private copy that holds a local-backend override', () => {
	const ctx = setup();
	const before = infraFiles(ctx);
	const r = runSync(ctx);
	assert.equal(r.status, 0, r.stderr);
	const c = calls(ctx);
	assert.deepEqual(
		c.map((x) => x.args[0]),
		['fmt', 'init', 'validate', 'test'],
	);
	assert.deepEqual(c[1].args, ['init', '-backend=false', '-input=false', '-lockfile=readonly']);
	for (const x of c) {
		assert.notEqual(x.cwd, join(ctx.repo, 'infra'));
		assert.ok(x.cwd.startsWith(ctx.tmp), x.cwd);
		assert.equal(x.override, STALE_OVERRIDE);
		assert.equal(x.cache, ctx.cache);
	}
	// Tracked and untracked-but-not-ignored files are checked; ignored ones never leave the checkout.
	assert.ok(c[0].files.includes('main.tf') && c[0].files.includes('new.tf') && c[0].files.includes('tests'));
	assert.ok(!c[0].files.includes('terraform.tfvars'));
	assert.ok(!c[0].files.includes('mine_override.tf'));
	// The checkout is untouched (no override, no .terraform/), and the copy is gone.
	assert.deepEqual(infraFiles(ctx), before);
	assert.equal(existsSync(c[0].cwd), false);
	assert.deepEqual(readdirSync(ctx.tmp), []);
});

test('passes its arguments to terraform test only', () => {
	const ctx = setup();
	const r = runSync(ctx, {}, ['-filter=tests/a.tftest.hcl']);
	assert.equal(r.status, 0, r.stderr);
	const c = calls(ctx);
	assert.deepEqual(c[3].args, ['test', '-filter=tests/a.tftest.hcl']);
	assert.deepEqual(c[2].args, ['validate']);
});

test('a failing step fails the run and still removes the copy', () => {
	const ctx = setup();
	const r = runSync(ctx, { FAKE_TF_FAIL_ON: 'validate' });
	assert.equal(r.status, 3);
	assert.deepEqual(
		calls(ctx).map((x) => x.args[0]),
		['fmt', 'init', 'validate'],
	);
	assert.deepEqual(readdirSync(ctx.tmp), []);
	assert.equal(existsSync(join(ctx.repo, 'infra', 'backend_override.tf')), false);
});

test('refuses to run while a stale override from an older check:infra sits in infra/', () => {
	const ctx = setup();
	writeFileSync(join(ctx.repo, 'infra', 'backend_override.tf'), STALE_OVERRIDE);
	const r = runSync(ctx);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /left by an interrupted check:infra run/);
	assert.deepEqual(calls(ctx), []);
	// Left for the operator to decide on.
	assert.equal(readFileSync(join(ctx.repo, 'infra', 'backend_override.tf'), 'utf8'), STALE_OVERRIDE);
});

const start = (ctx, extra) => {
	const child = spawn(BASH, [join(ctx.repo, 'bin', 'check-infra.sh')], { env: envFor(ctx, extra), stdio: ['ignore', 'ignore', 'pipe'] });
	const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
	return { child, done };
};

async function until(fn, ms = 10_000) {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await new Promise((r) => setTimeout(r, 20));
	}
}

test('a SIGKILL mid-run leaves nothing in infra/ (the next real init stays on the S3 backend)', async () => {
	const ctx = setup();
	const before = infraFiles(ctx);
	const { child, done } = start(ctx, { FAKE_TF_SLEEP_ON: 'validate', FAKE_TF_SLEEP_MS: '5000' });
	await until(() => calls(ctx).some((x) => x.args[0] === 'validate'));
	child.kill('SIGKILL');
	const { signal } = await done;
	assert.equal(signal, 'SIGKILL');
	assert.deepEqual(infraFiles(ctx), before);
	assert.equal(existsSync(join(ctx.repo, 'infra', 'backend_override.tf')), false);
	// The fake terraform child sleeps on; the next run is still clean.
	const r = runSync(ctx);
	assert.equal(r.status, 0, r.stderr);
});

test('two runs at once each get their own copy and .terraform/', async () => {
	const ctx = setup();
	const extra = { FAKE_TF_SLEEP_ON: 'validate', FAKE_TF_SLEEP_MS: '400' };
	const a = start(ctx, extra);
	const b = start(ctx, extra);
	const [ra, rb] = await Promise.all([a.done, b.done]);
	assert.equal(ra.code, 0);
	assert.equal(rb.code, 0);
	const dirs = new Set(calls(ctx).map((x) => x.cwd));
	assert.equal(dirs.size, 2);
	assert.equal(existsSync(join(ctx.repo, 'infra', '.terraform')), false);
	assert.deepEqual(readdirSync(ctx.tmp), []);
});

// More than one test file: each runs in its own copy, all at once (CI's 10-minute job outgrew one file at a time).
const withFiles = (ctx, names) => {
	for (const n of names) writeFileSync(join(ctx.repo, 'infra', 'tests', `${n}.tftest.hcl`), `run "${n}" {}\n`);
};

test('with several test files and no arguments, runs each file once in its own copy, every output printed', () => {
	const ctx = setup();
	withFiles(ctx, ['b', 'c']);
	const r = runSync(ctx, { CHECK_INFRA_JOBS: '3' });
	assert.equal(r.status, 0, r.stderr);
	const tests = calls(ctx).filter((x) => x.args[0] === 'test');
	assert.deepEqual(tests.map((x) => x.args[1]).sort(), ['-filter=tests/a.tftest.hcl', '-filter=tests/b.tftest.hcl', '-filter=tests/c.tftest.hcl']);
	const validate = calls(ctx).find((x) => x.args[0] === 'validate');
	assert.equal(new Set(tests.map((x) => x.cwd)).size, 3);
	for (const x of tests) {
		assert.ok(x.cwd.startsWith(ctx.tmp), x.cwd);
		assert.notEqual(x.cwd, validate.cwd);
		assert.equal(x.override, STALE_OVERRIDE);
	}
	for (const f of ['a', 'b', 'c']) assert.match(r.stdout, new RegExp(`FAKE RAN -filter=tests/${f}.tftest.hcl`));
	assert.match(r.stdout, /all 3 test files passed/);
	assert.deepEqual(readdirSync(ctx.tmp), []);
});

test('one failing file fails the run, the others still run and every output prints', () => {
	const ctx = setup();
	withFiles(ctx, ['b', 'c']);
	const r = runSync(ctx, { CHECK_INFRA_JOBS: '3', FAKE_TF_FAIL_FILTER: 'tests/b.tftest.hcl' });
	assert.equal(r.status, 1);
	assert.match(r.stdout, /FAKE FAIL tests\/b.tftest.hcl/);
	assert.match(r.stdout, /FAKE RAN -filter=tests\/a.tftest.hcl/);
	assert.match(r.stdout, /FAKE RAN -filter=tests\/c.tftest.hcl/);
	assert.match(r.stderr, /tests\/b.tftest.hcl failed/);
	assert.match(r.stderr, /1 of 3 test files failed/);
	assert.deepEqual(readdirSync(ctx.tmp), []);
});

test('runs the files at the same time', () => {
	const ctx = setup();
	withFiles(ctx, ['b', 'c']);
	const t0 = Date.now();
	const r = runSync(ctx, { CHECK_INFRA_JOBS: '3', FAKE_TF_SLEEP_ON: 'test', FAKE_TF_SLEEP_MS: '1500' });
	assert.equal(r.status, 0, r.stderr);
	// One at a time would take 4.5 s of sleeping alone.
	assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test('CHECK_INFRA_JOBS=1 and an explicit filter keep the single terraform test', () => {
	const ctx = setup();
	withFiles(ctx, ['b']);
	assert.equal(runSync(ctx, { CHECK_INFRA_JOBS: '1' }).status, 0);
	assert.deepEqual(calls(ctx).filter((x) => x.args[0] === 'test').map((x) => x.args), [['test']]);
});
