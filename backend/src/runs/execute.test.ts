import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNS_KEPT, runsKeptPerProject, seriesHash } from './execute.js';

describe('runsKeptPerProject', () => {
	it('reads RUNS_KEPT_PER_PROJECT and falls back to the default for anything invalid', () => {
		expect(DEFAULT_RUNS_KEPT).toBe(20);
		expect(runsKeptPerProject(undefined)).toBe(20);
		expect(runsKeptPerProject('5')).toBe(5);
		expect(runsKeptPerProject(' 7 ')).toBe(7);
		for (const bad of ['', '  ', '0', '-3', '2.5', 'ten', 'Infinity']) expect(runsKeptPerProject(bad)).toBe(20);
	});
});

describe('seriesHash', () => {
	it('is a stable SHA-256 hex that changes with any value, including a missing day', () => {
		const h = seriesHash([1, 2.5, null]);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(seriesHash([1, 2.5, null])).toBe(h);
		expect(seriesHash([1, 2.5, 0])).not.toBe(h);
		expect(seriesHash([1, 2.5])).not.toBe(h);
	});
});
