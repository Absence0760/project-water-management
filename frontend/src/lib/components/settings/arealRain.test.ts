import { arealRainError, PE_SOURCE_MAX } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { AREAL_METHOD_OPTIONS, arealRainFormError, flatFactor, withArealRain, withFactorEveryMonth } from './arealRain';

const areal = { factors: new Array(12).fill(1.9), method: 'map' as const, source: 'invented MAP ÷ forcing mean' };

describe('the areal rainfall correction form', () => {
	it('switches on at × 1 with a blank source (Save waits for it), back from a correction switched off, and off to null', () => {
		const on = withArealRain(true)!;
		expect(on).toEqual({ factors: new Array(12).fill(1), method: 'map', source: '' });
		expect(arealRainFormError(on)).toMatch(/source is required/);
		expect(withArealRain(true, areal)).toEqual(areal);
		expect(withArealRain(true, areal)!.factors).not.toBe(areal.factors);
		expect(withArealRain(false, areal)).toBeNull();
	});

	it('fills one factor into every month and reads it back while the months agree', () => {
		const one = withFactorEveryMonth(areal, 2.05);
		expect(one.factors).toEqual(new Array(12).fill(2.05));
		expect(flatFactor(one)).toBe(2.05);
		expect(flatFactor({ factors: [...one.factors.slice(1), 1] })).toBeNull();
	});

	it('blocks Save on what the API refuses, and on nothing else', () => {
		expect(arealRainFormError(null)).toBeNull();
		expect(arealRainFormError(areal)).toBeNull();
		const bad = [
			{ ...areal, factors: areal.factors.slice(1) },
			{ ...areal, factors: [...areal.factors.slice(1), 4.5] },
			{ ...areal, factors: [...areal.factors.slice(1), 0.1] },
			{ ...areal, source: '   ' },
			{ ...areal, source: 'x'.repeat(PE_SOURCE_MAX + 1) }
		];
		for (const b of bad) {
			expect(arealRainFormError(b), JSON.stringify(b).slice(0, 60)).not.toBeNull();
			expect(arealRainError(b)).not.toBeNull();
		}
		expect(arealRainFormError({ ...areal, factors: [...areal.factors.slice(1), 4.5] })).toMatch(/check Sep/);
	});

	it('offers every method the engine knows', () => {
		expect(AREAL_METHOD_OPTIONS.map((o) => o.value)).toEqual(['map', 'stations', 'fitted']);
	});
});
