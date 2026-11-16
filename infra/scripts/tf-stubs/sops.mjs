#!/usr/bin/env node
// A fake `sops` for tf.test.mjs, restore-db.test.mjs and the check scripts'
// tests. Handles only two calls, as the real one does:
//   `sops exec-env [--same-process] <file> <command>`: the "decrypted" keys
//     (FAKE_SOPS_ENV, a JSON object of synthetic values, or the default below)
//     are added to the environment and <command> runs under /bin/sh -c.
//   `sops --decrypt --input-type binary --output-type binary <file>`: the
//     "encrypted" file is synthetic plaintext, so it is copied to stdout as is
//     (FAKE_SOPS_DECRYPT_FAIL=1 fails instead, as a missing AWS session does).
// Every call is appended to FAKE_SOPS_LOG (if set) as a JSON line, with the
// AWS_PROFILE it saw.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const DEFAULT = {
	auth_jwt_secret: 'synthetic-jwt-0123456789abcdef0123456789abcdef',
	db_app_password: 'synthetic0db0password0123456789',
	alerts_token_secret: 'synthetic0alerts0token0123456789abcdef',
	cloudfront_private_key: 'synthetic signing key\nsecond line',
	app_encryption_key: 'synthetic0app0encryption0key0123456789',
};

const args = process.argv.slice(2);
if (process.env.FAKE_SOPS_LOG) {
	const entry = args[0] === 'exec-env' ? { args } : { args, profile: process.env.AWS_PROFILE };
	appendFileSync(process.env.FAKE_SOPS_LOG, JSON.stringify(entry) + '\n');
}
if (args[0] === '--decrypt') {
	const want = ['--decrypt', '--input-type', 'binary', '--output-type', 'binary'];
	if (args.length !== want.length + 1 || want.some((a, i) => args[i] !== a)) {
		process.stderr.write(`fake sops: unexpected call: ${args.join(' ')}\n`);
		process.exit(99);
	}
	const file = args[want.length];
	if (!existsSync(file)) {
		process.stderr.write(`fake sops: ${file}: no such file\n`);
		process.exit(1);
	}
	if (process.env.FAKE_SOPS_DECRYPT_FAIL) {
		process.stderr.write('fake sops: Failed to get the data key required to decrypt the SOPS file.\n');
		process.exit(128);
	}
	process.stdout.write(readFileSync(file));
	process.exit(0);
}
if (args[0] !== 'exec-env') {
	process.stderr.write(`fake sops: unexpected call: ${args.join(' ')}\n`);
	process.exit(99);
}
const rest = args.slice(1).filter((a) => a !== '--same-process');
if (rest.length !== 2) {
	process.stderr.write('fake sops: exec-env takes a file and a command\n');
	process.exit(99);
}
const [file, command] = rest;
if (!existsSync(file)) {
	process.stderr.write(`fake sops: ${file}: no such file\n`);
	process.exit(1);
}
const values = process.env.FAKE_SOPS_ENV ? JSON.parse(process.env.FAKE_SOPS_ENV) : DEFAULT;
const r = spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit', env: { ...process.env, ...values } });
process.exit(r.status ?? 1);
