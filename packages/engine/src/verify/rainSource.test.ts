import { describe, expect, it } from 'vitest';
import type { ModelOutput } from '../project';
import { RAIN_SOURCE_CODE, RAIN_SOURCE_COLUMN } from '../rainSourcePeriods';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { checkRainSource } from './checks';

/** A copy of `out` with the rain_source column's values replaced. */
const withSource = (out: ModelOutput, edit: (v: number[]) => void): ModelOutput => ({
	...out,
	series: out.series.map((s) => {
		if (s.nodeId !== null || s.key !== RAIN_SOURCE_COLUMN.key) return s;
		const values = [...s.values];
		edit(values);
		return { ...s, values };
	})
});

describe('checkRainSource (engine 1.27.0)', () => {
	const runs = [1, 2, 3, 4, 5].map((seed) => runModel(randomInput(seed, { maxDays: 300 })));

	it('passes on random networks, whose runs all carry the column', () => {
		for (const [i, out] of runs.entries()) {
			expect(out.series.some((s) => s.key === RAIN_SOURCE_COLUMN.key), `seed ${i + 1}`).toBe(true);
			expect(checkRainSource(out), `seed ${i + 1}`).toBeNull();
		}
	});

	it('fails a blank source on a day rain_final has rain, and a source on a blank day', () => {
		const out = runs[0]!;
		const final = out.series.find((s) => s.key === 'rain_final')!.values;
		const wet = final.findIndex((v) => !Number.isNaN(v));
		expect(wet).toBeGreaterThanOrEqual(0);
		expect(checkRainSource(withSource(out, (v) => (v[wet] = NaN)))).toMatch(/^rain_source\[\d+\] is NaN where rain_final is/);
		const blankFinal = { ...out, series: out.series.map((s) => (s.key === 'rain_final' ? { ...s, values: s.values.map((v, t) => (t === wet ? NaN : v)) } : s)) };
		expect(checkRainSource(blankFinal)).toMatch(/where rain_final is NaN/);
	});

	it('fails a period’s code in a run without rain-source periods', () => {
		const out = runs[0]!;
		const final = out.series.find((s) => s.key === 'rain_final')!.values;
		const wet = final.findIndex((v) => !Number.isNaN(v));
		expect(checkRainSource(withSource(out, (v) => (v[wet] = RAIN_SOURCE_CODE.series)))).toMatch(/without rain-source periods/);
		expect(checkRainSource(withSource(out, (v) => (v[wet] = RAIN_SOURCE_CODE.chirps)))).toBeNull(); // positive control: a plain code passes
	});
});
