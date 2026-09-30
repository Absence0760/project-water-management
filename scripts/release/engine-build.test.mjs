import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkJson, DEFAULT_CASES, engineBuildRecord, parseArgs, readEngineVersion, recordProblem, verdict } from './engine-build.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const record = { version: '1.2.3', gitSha: SHA, invariantsPassed: true, soakCases: 2000 };

test('reads ENGINE_VERSION from version.ts (the real file too)', () => {
	assert.equal(readEngineVersion("export const ENGINE_VERSION = '1.31.0';\n"), '1.31.0');
	assert.throws(() => readEngineVersion('export const OTHER = 1;'), /ENGINE_VERSION not found/);
	const real = readEngineVersion(readFileSync(new URL('../../packages/engine/src/version.ts', import.meta.url), 'utf8'));
	assert.match(real, /^\d+\.\d+\.\d+$/);
});

test('arguments: defaults, values, and refusals', () => {
	assert.deepEqual(parseArgs([]), { cases: DEFAULT_CASES, out: 'engine-build.json', allowDirty: false, check: false, maxWorkers: null });
	assert.deepEqual(parseArgs(['--cases', '50', '--out', 'x.json', '--allow-dirty']), { cases: 50, out: 'x.json', allowDirty: true, check: false, maxWorkers: null });
	assert.equal(parseArgs(['--max-workers', '3']).maxWorkers, 3);
	assert.equal(parseArgs(['--check']).check, true);
	for (const [argv, why] of [
		[['--cases'], /needs a value/],
		[['--cases', '0'], /positive whole number/],
		[['--cases', '1e3'], /positive whole number/],
		[['--cases', '-5'], /positive whole number/],
		[['--max-workers', '0'], /positive whole number/],
		[['--nope'], /unknown argument/]
	])
		assert.throws(() => parseArgs(argv), why, argv.join(' '));
});

test('the record is exactly the four fields, in a fixed order', () => {
	const r = engineBuildRecord({ soakCases: 5, invariantsPassed: false, gitSha: SHA, version: '1.0.0', extra: 1 });
	assert.equal(JSON.stringify(r), `{"version":"1.0.0","gitSha":"${SHA}","invariantsPassed":false,"soakCases":5}`);
	assert.equal(recordProblem(r, '1.0.0'), null);
});

// Shard i of 4 over `cases` seeds from 1, titled as packages/engine/src/fuzz/shard.ts titles it.
const shard = (i, cases, status = 'passed') => {
	const per = Math.ceil(cases / 4);
	return { title: `seeds ${1 + (i - 1) * per}–${Math.min(cases, i * per)} of ${cases} from 1, GR4J runoff (shard ${i} of 4)`, status };
};
const all = (cases) => [1, 2, 3, 4].map((i) => shard(i, cases));
const report = (tests, ok = true) => ({ success: ok, numFailedTests: tests.filter((t) => t.status === 'failed').length, numFailedTestSuites: 0, testResults: [{ assertionResults: tests }] });

test('verdict: passes only when every test passed and every soak shard ran at the asked size', () => {
	const other = { title: 'mass balance', status: 'passed' };
	assert.deepEqual(verdict(report([other, ...all(2000)]), 2000), { invariantsPassed: true, problems: [] });
	assert.deepEqual(verdict(report([other, ...all(3)]), 3), { invariantsPassed: true, problems: [] }, 'an empty last shard (seeds 4–3) still covers the range');
	assert.equal(verdict(report([other, ...all(400)]), 2000).invariantsPassed, false, 'ran at the default size: FUZZ_CASES never reached the shards');
	assert.equal(verdict(report([other]), 2000).invariantsPassed, false, 'no soak');
	assert.match(verdict(report([other, shard(1, 2000)]), 2000).problems.join(), /shard\(s\) 2, 3, 4 of 4 did not run/, 'a dropped shard narrows the soak');
	assert.match(verdict(report([other, ...all(2000), shard(1, 2000)]), 2000).problems.join(), /ran twice/);
	assert.equal(verdict(report([other, shard(1, 2000, 'failed'), ...all(2000).slice(1)], false), 2000).invariantsPassed, false);
	assert.equal(verdict(report([{ title: 'x', status: 'failed' }, ...all(2000)], false), 2000).invariantsPassed, false);
	assert.equal(verdict(report([other, shard(1, 2000, 'skipped'), ...all(2000).slice(1)]), 2000).invariantsPassed, false);
	assert.match(verdict(report([other, { title: 'seeds x of 2000, GR4J runoff (shard 1 of 4)', status: 'passed' }, ...all(2000).slice(1)]), 2000).problems.join(), /not understood/);
	assert.equal(verdict(null, 2000).invariantsPassed, false, 'no report (vitest crashed)');
	assert.equal(verdict({ ...report([other, ...all(2000)]), numFailedTestSuites: 1 }, 2000).invariantsPassed, false, 'a file that failed to load');
});

test('--check: empty is no record; anything else must be a record for this engine', () => {
	assert.equal(checkJson('', '1.2.3'), null);
	assert.equal(checkJson(undefined, '1.2.3'), null);
	assert.equal(checkJson(JSON.stringify(record), '1.2.3'), null);
	assert.equal(checkJson('{', '1.2.3'), 'not JSON');
	assert.match(checkJson(JSON.stringify(record), '1.2.4'), /made for engine 1\.2\.3/);
	assert.match(checkJson(JSON.stringify({ ...record, gitSha: 'HEAD' }), '1.2.3'), /gitSha/);
	assert.match(checkJson(JSON.stringify({ ...record, soakCases: -1 }), '1.2.3'), /soakCases/);
	assert.match(checkJson('[]', '1.2.3'), /not an object/);
});
