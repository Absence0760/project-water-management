import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildRecord, engineVersionOf, envLine, RELEASE_MS_PER_CASE, soakCasesOf, suiteEnv } from './engine-build.mjs';

test('reads ENGINE_VERSION from the engine’s version module', () => {
	const source = readFileSync(new URL('../../packages/engine/src/version.ts', import.meta.url), 'utf8');
	assert.match(engineVersionOf(source), /^\d+\.\d+\.\d+$/);
	assert.throws(() => engineVersionOf('export const ENGINE_VERSION = "1.2.3";'), /no ENGINE_VERSION/);
});

test('takes a positive whole number of soak cases', () => {
	assert.equal(soakCasesOf(['--soak-cases', '4000']), 4000);
	for (const argv of [[], ['--soak-cases'], ['--soak-cases', '0'], ['--soak-cases', '1.5'], ['--soak-cases', 'many']]) {
		assert.throws(() => soakCasesOf(argv), /usage/, JSON.stringify(argv));
	}
});

test('writes one ENGINE_BUILD line the site build can parse back', () => {
	const record = buildRecord({ version: '1.30.1', gitSha: '0123456789abcdef0123456789abcdef01234567', invariantsPassed: true, soakCases: 4000 });
	const line = envLine(record);
	assert.match(line, /^ENGINE_BUILD=\{.*\}\n$/);
	assert.equal(line.split('\n').length, 2, 'a single line');
	assert.deepEqual(JSON.parse(line.slice('ENGINE_BUILD='.length)), record);
	assert.throws(() => buildRecord({ ...record, gitSha: 'main' }), /not a git SHA/);
});

test('runs the soak with the release’s loose per-case timeout, keeping the rest of the environment', () => {
	const env = suiteEnv(1600, { PATH: '/bin', FUZZ_MS_PER_CASE: '1' });
	assert.equal(env.FUZZ_CASES, '1600');
	assert.equal(env.FUZZ_MS_PER_CASE, String(RELEASE_MS_PER_CASE));
	assert.equal(env.PATH, '/bin');
	// A hang guard only: 5x the slowest runner seen (~0.4 s a case, web@0.1.6).
	assert.ok(RELEASE_MS_PER_CASE >= 2_000);
});
