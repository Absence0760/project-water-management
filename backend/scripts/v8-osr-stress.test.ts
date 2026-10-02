import { describe, expect, it } from 'vitest';
import { childResult, DEFAULT_PERIODS, exitCodeOf, hashesOf, parseStressArgs, PRE_FIX_REV, summarize } from './v8-osr-stress';

describe('parseStressArgs', () => {
	it('defaults to the pre-fix loop, the periods the fault showed at and this node', () => {
		const o = parseStressArgs([]);
		expect(o).toEqual({ rev: PRE_FIX_REV, node: process.execPath, periods: DEFAULT_PERIODS, trials: 2, runs: 6, jobs: 4, flags: [] });
	});

	it('passes everything after -- to the children as V8 flags', () => {
		const o = parseStressArgs(['--rev', 'HEAD', '--periods', '2600, 2900', '--trials', '3', '--', '--no-maglev-osr', '--single-threaded']);
		expect(o.rev).toBe('HEAD');
		expect(o.periods).toEqual([2600, 2900]);
		expect(o.trials).toBe(3);
		expect(o.flags).toEqual(['--no-maglev-osr', '--single-threaded']);
	});

	it('refuses a count that is not a whole number ≥ 1, and an unknown option', () => {
		expect(() => parseStressArgs(['--runs', '0'])).toThrow(/--runs/);
		expect(() => parseStressArgs(['--periods', '2900,x'])).toThrow(/--periods/);
		expect(() => parseStressArgs(['--bogus'])).toThrow();
	});
});

describe('childResult and summarize', () => {
	const line = (hash: string) => `${JSON.stringify({ hash, passed: null, detail: null })}\n`;

	it('counts the runs whose hash differs from the reference, skipping lines that are not results', () => {
		const out = line('a') + 'not json\n' + line('b') + line('a') + '\n';
		expect(hashesOf(out)).toEqual(['a', 'b', 'a']);
		expect(childResult(2900, out, 'a', null)).toEqual({ period: 2900, runs: 3, wrong: 1, error: null });
	});

	it('keeps the runs a child finished before it timed out', () => {
		expect(childResult(1800, line('a') + '{"hash":"a"', 'a', 'timeout')).toEqual({ period: 1800, runs: 1, wrong: 0, error: 'timeout' });
	});

	it('sums processes, wrong runs and children that ended early', () => {
		const s = summarize([
			{ period: 1800, runs: 6, wrong: 0, error: null },
			{ period: 2900, runs: 6, wrong: 2, error: null },
			{ period: 3200, runs: 4, wrong: 1, error: 'timeout' }
		]);
		expect(s).toEqual({ processes: 3, failedProcesses: 2, runs: 16, wrong: 3, incomplete: 1 });
	});

	it('exits 1 on a wrong run, 2 when a child ended early with nothing wrong, 0 only when all finished and matched', () => {
		const ok = { period: 2900, runs: 6, wrong: 0, error: null };
		expect(exitCodeOf(summarize([ok, ok]))).toBe(0);
		expect(exitCodeOf(summarize([ok, { period: 1800, runs: 0, wrong: 0, error: 'exit 134' }]))).toBe(2);
		expect(exitCodeOf(summarize([{ period: 2900, runs: 6, wrong: 1, error: null }, { period: 1800, runs: 2, wrong: 0, error: 'timeout' }]))).toBe(1);
	});
});
