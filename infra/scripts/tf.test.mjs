// tf.sh against a fake `sops` (tf-stubs/sops.mjs, synthetic values) and a
// fake `terraform` that reports what it was given: the sops keys arrive as
// TF_VAR_* and nowhere else, the arguments pass through intact (spaces,
// quotes), a missing or empty key is refused by name without running
// Terraform, and --preflight decrypts nothing. Needs bash and node. No AWS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const here = new URL('.', import.meta.url).pathname;
const script = join(here, 'tf.sh');
const which = (tool) => spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
const BASH = which('bash');
const KEYS = ['auth_jwt_secret', 'db_app_password', 'alerts_token_secret', 'cloudfront_private_key'];
const VALUES = {
	auth_jwt_secret: 'synthetic-jwt-0123456789abcdef0123456789abcdef',
	db_app_password: 'synthetic0db0password0123456789',
	alerts_token_secret: "synthetic 'quoted' $HOME value",
	// A PEM is several lines: they must arrive intact.
	cloudfront_private_key: 'synthetic line one\nline two',
};

function setup({ withSops = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'tf-sh-'));
	// Only what tf.sh and the fakes use, so a real sops elsewhere on PATH can't answer.
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	for (const tool of ['dirname', 'printenv', 'node', 'sh']) symlinkSync(which(tool), join(bin, tool));
	if (withSops) {
		writeFileSync(join(bin, 'sops'), `#!/bin/sh\nexec node ${join(here, 'tf-stubs', 'sops.mjs')} "$@"\n`);
		chmodSync(join(bin, 'sops'), 0o755);
	}
	// Reports its arguments, the TF_VAR_ values it got, and any bare key left behind.
	writeFileSync(
		join(bin, 'terraform'),
		`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const keys = ${JSON.stringify(KEYS)};
appendFileSync(process.env.FAKE_TF_LOG, JSON.stringify({
	args: process.argv.slice(2),
	tfvars: Object.fromEntries(keys.filter((k) => ('TF_VAR_' + k) in process.env).map((k) => [k, process.env['TF_VAR_' + k]])),
	bare: keys.filter((k) => k in process.env),
}) + '\\n');
`,
	);
	chmodSync(join(bin, 'terraform'), 0o755);
	const secrets = join(dir, 'prod.sops.yaml');
	writeFileSync(secrets, 'synthetic: not read by the fake sops\n');
	const files = { tfLog: join(dir, 'tf.log'), sopsLog: join(dir, 'sops.log') };
	writeFileSync(files.tfLog, '');
	writeFileSync(files.sopsLog, '');
	return { dir, bin, secrets, files };
}

function run(ctx, args, env = {}) {
	const r = spawnSync(BASH, [script, ...args], {
		encoding: 'utf8',
		cwd: ctx.dir,
		env: {
			PATH: ctx.bin,
			HOME: ctx.dir,
			WM_SECRETS_FILE: ctx.secrets,
			FAKE_TF_LOG: ctx.files.tfLog,
			FAKE_SOPS_LOG: ctx.files.sopsLog,
			FAKE_SOPS_ENV: JSON.stringify(VALUES),
			...env,
		},
	});
	const lines = (f) =>
		readFileSync(f, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	return { ...r, tf: lines(ctx.files.tfLog), sops: lines(ctx.files.sopsLog) };
}

test('each sops key reaches Terraform as TF_VAR_<key>, and only so', () => {
	const ctx = setup();
	const r = run(ctx, ['plan', '-var-file=../prod.tfvars', '-out=/tmp/plan']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.tf.length, 1);
	assert.deepEqual(r.tf[0].args, ['plan', '-var-file=../prod.tfvars', '-out=/tmp/plan']);
	assert.deepEqual(r.tf[0].tfvars, VALUES);
	assert.deepEqual(r.tf[0].bare, [], 'the bare sops names are unset before Terraform runs');
	assert.deepEqual(r.sops, [{ args: ['exec-env', '--same-process', ctx.secrets, r.sops[0].args[3]] }]);
	assert.equal(r.stdout, '', 'prints nothing of its own');
});

test('arguments with spaces, quotes and $ pass through unchanged', () => {
	const ctx = setup();
	const args = ['apply', "-var=note=it's a 'test' $HOME", '-replace=random_password.cloudfront_shared_secret', ''];
	const r = run(ctx, args);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.tf[0].args, args);
});

test('refuses a missing or empty key by name, without running Terraform', () => {
	for (const [values, want] of [
		[{ auth_jwt_secret: VALUES.auth_jwt_secret, db_app_password: VALUES.db_app_password }, /alerts_token_secret is missing from the sops file/],
		[{ ...VALUES, db_app_password: '' }, /db_app_password is empty in the sops file/],
	]) {
		const ctx = setup();
		const r = run(ctx, ['plan'], { FAKE_SOPS_ENV: JSON.stringify(values) });
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, want);
		assert.deepEqual(r.tf, []);
		for (const v of Object.values(values)) if (v) assert.ok(!r.stderr.includes(v), 'never prints a value');
	}
});

test('refuses a missing sops file or sops binary before decrypting', () => {
	const ctx = setup();
	let r = run(ctx, ['plan'], { WM_SECRETS_FILE: join(ctx.dir, 'nope.sops.yaml') });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /no sops file at .*nope\.sops\.yaml/);
	assert.deepEqual(r.sops, []);

	const bare = setup({ withSops: false });
	r = run(bare, ['plan']);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /sops not found on PATH/);
	assert.deepEqual(r.tf, []);
});

test('--preflight checks sops and the file and decrypts nothing', () => {
	const ctx = setup();
	let r = run(ctx, ['--preflight']);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.sops, []);
	assert.deepEqual(r.tf, []);
	r = run(ctx, ['--preflight', 'plan']);
	assert.notEqual(r.status, 0);
});

test('refuses to run with no Terraform arguments', () => {
	const ctx = setup();
	const r = run(ctx, []);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /usage: tf\.sh/);
	assert.deepEqual(r.sops, []);
});
