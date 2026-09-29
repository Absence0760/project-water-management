#!/usr/bin/env node
// A fake `sops` for tf.test.mjs and restore-db.test.mjs. Handles only
// `sops exec-env [--same-process] <file> <command>`, as the real one does:
// the "decrypted" keys (FAKE_SOPS_ENV, a JSON object of synthetic values, or
// the default below) are added to the environment and <command> runs under
// /bin/sh -c. Every call is appended to FAKE_SOPS_LOG (if set) as a JSON line.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';

const DEFAULT = {
	auth_jwt_secret: 'synthetic-jwt-0123456789abcdef0123456789abcdef',
	db_app_password: 'synthetic0db0password0123456789',
	alerts_token_secret: 'synthetic0alerts0token0123456789abcdef',
};

const args = process.argv.slice(2);
if (process.env.FAKE_SOPS_LOG) appendFileSync(process.env.FAKE_SOPS_LOG, JSON.stringify({ args }) + '\n');
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
