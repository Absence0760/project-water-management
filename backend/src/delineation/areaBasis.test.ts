// Which of a delineated area a unit takes (195, areaBasis.ts): the pure parts.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { areaBasisNote, basisText, takenAreaM2 } from './areaBasis.js';

describe('takenAreaM2', () => {
	it('takes the gross area whatever the pans figure, known or not', () => {
		expect(takenAreaM2('A', 5e6, 1e6, 'gross')).toBe(5e6);
		expect(takenAreaM2('A', 5e6, null, 'gross')).toBe(5e6);
		expect(takenAreaM2('A', 5e6, undefined, 'gross')).toBe(5e6);
	});

	it('takes the effective area as the gross less what drains into pans', () => {
		expect(takenAreaM2('A', 5e6, 1.25e6, 'effective')).toBe(3.75e6);
		expect(takenAreaM2('A', 5e6, 0, 'effective')).toBe(5e6);
	});

	it('refuses the effective area without a figure, or with nothing left, naming the area', () => {
		expect(() => takenAreaM2('“Pan veld”', 5e6, null, 'effective')).toThrow(ApiError);
		expect(() => takenAreaM2('“Pan veld”', 5e6, null, 'effective')).toThrow(/^“Pan veld” has no figure for what drains into pans/);
		expect(() => takenAreaM2('Dam unit', 5e6, 5e6, 'effective')).toThrow(/^All of Dam unit drains into pans/);
		expect(() => takenAreaM2('Dam unit', 5e6, 6e6, 'effective')).toThrow(/^All of Dam unit drains into pans/);
	});
});

describe('the words', () => {
	it('says which area was taken, and nothing of pans for a feature with no figure', () => {
		expect(basisText('effective', 1.2e6)).toBe('the effective area, without the 1.200 km² draining into pans');
		expect(basisText('gross', 1.2e6)).toBe('the gross area, the 1.200 km² draining into pans included');
		expect(basisText('gross', 0)).toBe('the gross area');
		expect(basisText('gross', null)).toBeNull();
	});

	it('notes a Start or Divide revision’s areas: all gross, all effective, or which were effective', () => {
		expect(areaBasisNote(0, [])).toBe('');
		expect(areaBasisNote(2, [])).toBe(' (gross)');
		expect(areaBasisNote(1, ['Dam'])).toBe(' (effective, without what drains into pans)');
		expect(areaBasisNote(3, ['Dam', 'Rest'])).toBe(' (gross; effective, without what drains into pans: Dam, Rest)');
	});
});
