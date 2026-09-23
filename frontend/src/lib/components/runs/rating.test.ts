import { describe, expect, it } from 'vitest';
import { describePbias, rateNse, ratePbias } from './rating';

describe('rateNse (Moriasi 2007)', () => {
	it.each([
		[0.9, 'very good'],
		[0.7501, 'very good'],
		[0.75, 'good'],
		[0.66, 'good'],
		[0.65, 'satisfactory'],
		[0.51, 'satisfactory'],
		[0.5, 'unsatisfactory'],
		[-0.698, 'unsatisfactory']
	])('%s → %s', (nse, want) => expect(rateNse(nse)).toBe(want));

	it('has no rating without a value', () => {
		expect(rateNse(null)).toBeNull();
		expect(rateNse(Number.NaN)).toBeNull();
	});
});

describe('ratePbias (Moriasi 2007)', () => {
	it.each([
		[0, 'very good'],
		[-9.9, 'very good'],
		[10, 'good'],
		[-14.9, 'good'],
		[15, 'satisfactory'],
		[-23.5, 'satisfactory'],
		[25, 'unsatisfactory'],
		[-40, 'unsatisfactory']
	])('%s → %s', (p, want) => expect(ratePbias(p)).toBe(want));

	it('has no rating without a value', () => expect(ratePbias(undefined)).toBeNull());
});

describe('describePbias', () => {
	it('reads the engine sign convention (positive = under-estimate)', () => {
		expect(describePbias(12)).toBe('model under-estimates total flow');
		expect(describePbias(-23.5)).toBe('model over-estimates total flow');
		expect(describePbias(0)).toBe('no overall bias');
		expect(describePbias(null)).toBe('');
	});
});
