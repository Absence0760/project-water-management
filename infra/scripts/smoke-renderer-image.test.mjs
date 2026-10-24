// infra/scripts/smoke-renderer-image.sh's sha256_of, the check that pins the
// Lambda runtime interface emulator by checksum: run as the script defines it,
// with this machine's sha256sum (GNU on CI's runners, BSD /sbin/sha256sum on
// macOS, which has no --status: the script's old `sha256sum -c --status`
// failed there), against Node's own SHA-256. Needs bash and sha256sum.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = readFileSync(new URL('./smoke-renderer-image.sh', import.meta.url), 'utf8');
const helper = script.split('\n').find((l) => l.startsWith('sha256_of()'));

test('sha256_of prints the file hash, on this platform, as Node computes it', () => {
	assert.ok(helper, 'smoke-renderer-image.sh defines sha256_of() on one line');
	const dir = mkdtempSync(join(tmpdir(), 'sha256-'));
	const file = join(dir, 'with space.bin');
	const bytes = Buffer.from('aws-lambda-rie\n\u0000ÿ');
	writeFileSync(file, bytes);
	const r = spawnSync('bash', ['-c', `${helper}\nsha256_of "$1"`, 'bash', file], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), createHash('sha256').update(bytes).digest('hex'));
});

test('the script checks the emulator through sha256_of only, never a GNU-only flag', () => {
	const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
	assert.doesNotMatch(code, /sha256sum\s+-c\b|--status/);
	assert.equal(script.match(/\$\(sha256_of "\$RIE_BIN(\.part)?"\)/g)?.length, 2);
});
