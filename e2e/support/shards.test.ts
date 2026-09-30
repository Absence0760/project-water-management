// Timing-balanced CI shards (support/shards.ts). Run by `pnpm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepsTogether, planShards, ranOnce, testKey, testListFile, testsIn, timingsFrom, unlistableTitles, type JsonReport, type ListedTest } from './shards.ts';

const t = (file: string, ...titles: string[]): ListedTest => ({ file, titles });
const never = () => false;

test('every test lands on exactly one shard, in listed order', () => {
	const tests = Array.from({ length: 40 }, (_, i) => t(`f${i % 7}.spec.ts`, `test ${i}`));
	const timings = Object.fromEntries(tests.map((x, i) => [testKey(x), (i * 37) % 900 + 100]));
	const shards = planShards(tests, timings, 6, never);
	const all = shards.flatMap((s) => s.tests.map(testKey));
	assert.deepEqual([...all].sort(), tests.map(testKey).sort());
	for (const s of shards) {
		const idx = s.tests.map((x) => tests.indexOf(x));
		assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
	}
});

test('the shards come out balanced by time, not by count', () => {
	// One slow file of 4 × 40 s and forty 2 s tests: a split by count gives
	// one shard all the slow tests.
	const slow = Array.from({ length: 4 }, (_, i) => t('slow.spec.ts', `slow ${i}`));
	const fast = Array.from({ length: 40 }, (_, i) => t('fast.spec.ts', `fast ${i}`));
	const timings = Object.fromEntries([...slow.map((x) => [testKey(x), 40_000]), ...fast.map((x) => [testKey(x), 2_000])]);
	const ms = planShards([...slow, ...fast], timings, 4, never).map((s) => s.ms);
	assert.deepEqual(ms, [60_000, 60_000, 60_000, 60_000]);
});

test('a serial or default-mode file stays on one shard', () => {
	const tests = [t('serial.spec.ts', 'a'), t('serial.spec.ts', 'b'), t('serial.spec.ts', 'c'), t('free.spec.ts', 'x'), t('free.spec.ts', 'y')];
	const timings = Object.fromEntries(tests.map((x) => [testKey(x), 10_000]));
	const shards = planShards(tests, timings, 3, (f) => f === 'serial.spec.ts');
	const holding = shards.filter((s) => s.tests.some((x) => x.file === 'serial.spec.ts'));
	assert.equal(holding.length, 1);
	assert.equal(holding[0]!.tests.filter((x) => x.file === 'serial.spec.ts').length, 3);
});

test('a test with no timing yet is planned at the median, never dropped', () => {
	const tests = [t('a.spec.ts', 'old 1'), t('a.spec.ts', 'old 2'), t('a.spec.ts', 'old 3'), t('b.spec.ts', 'new')];
	const timings = { [testKey(tests[0]!)]: 1_000, [testKey(tests[1]!)]: 5_000, [testKey(tests[2]!)]: 9_000, 'gone.spec.ts › removed': 99_000 };
	const shards = planShards(tests, timings, 2, never);
	assert.equal(shards.flatMap((s) => s.tests).length, 4);
	assert.equal(shards.reduce((a, s) => a + s.ms, 0), 1_000 + 5_000 + 9_000 + 5_000);
});

test('the same tests and timings give the same plan (each shard plans on its own)', () => {
	const tests = Array.from({ length: 30 }, (_, i) => t('x.spec.ts', `same ${i % 3} ${i}`));
	const timings = Object.fromEntries(tests.map((x) => [testKey(x), 1_000]));
	const a = planShards(tests, timings, 4, never).map(testListFile);
	const b = planShards([...tests], { ...timings }, 4, never).map(testListFile);
	assert.deepEqual(a, b);
});

test('a bad shard total is refused', () => {
	assert.throws(() => planShards([], {}, 0, never), /positive integer/);
});

test('keepsTogether reads describe.configure modes', () => {
	assert.equal(keepsTogether(`test.describe.configure({ mode: 'serial' });`), true);
	assert.equal(keepsTogether(`\ttest.describe.configure({ mode: "default" })`), true);
	assert.equal(keepsTogether(`test.describe.configure({ retries: 0, mode: 'serial' });`), true);
	assert.equal(keepsTogether(`test.describe.configure({ mode: 'parallel' });`), false);
	assert.equal(keepsTogether(`test('serial things', () => {});`), false);
});

test('titles --test-list would misread are caught', () => {
	const bad = unlistableTitles([t('a.spec.ts', 'fine'), t('a.spec.ts', 'x › y'), t('a.spec.ts', 'trailing ')]);
	assert.deepEqual(bad, ['a.spec.ts › x › y', 'a.spec.ts › trailing ']);
});

const report: JsonReport = {
	suites: [
		{
			title: 'a.spec.ts',
			file: 'a.spec.ts',
			specs: [{ title: 'top', file: 'a.spec.ts', tests: [{ results: [{ duration: 1_234, status: 'passed' }] }] }],
			suites: [
				{
					title: 'group',
					file: 'a.spec.ts',
					specs: [
						{ title: 'inner', file: 'a.spec.ts', tests: [{ results: [{ duration: 4_321, status: 'failed' }] }] },
						{ title: 'skipped', file: 'a.spec.ts', tests: [{ results: [{ duration: 0, status: 'skipped' }] }] }
					]
				}
			]
		}
	]
};

test('the report walk names each test by file, describes and title', () => {
	assert.deepEqual(testsIn(report).map(testKey), ['a.spec.ts › group › inner', 'a.spec.ts › group › skipped', 'a.spec.ts › top']);
});

test('timings round to 100 ms, sort by key, and skip a test that never ran', () => {
	const { timings, runs } = timingsFrom(report);
	assert.deepEqual(timings, { 'a.spec.ts › group › inner': 4_300, 'a.spec.ts › top': 1_200 });
	assert.deepEqual(Object.keys(timings), ['a.spec.ts › group › inner', 'a.spec.ts › top']);
	assert.equal(runs.get('a.spec.ts › group › skipped'), 1, 'a skipped test still sat on a shard');
});

test('ranOnce finds a test on no shard and one on two', () => {
	const runs = new Map([
		['a.spec.ts › once', 1],
		['a.spec.ts › twice', 2]
	]);
	assert.deepEqual(ranOnce([t('a.spec.ts', 'once'), t('a.spec.ts', 'twice'), t('a.spec.ts', 'never')], runs), {
		missing: ['a.spec.ts › never'],
		repeated: ['a.spec.ts › twice']
	});
});
