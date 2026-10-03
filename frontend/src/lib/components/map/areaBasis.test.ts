// Which of a delineated area a unit takes (195, areaBasis.ts): the choice the
// Start and Divide sheets' area ticks and the Map's Use this area show.
import { describe, expect, it } from 'vitest';
import { basisNote, basisOptions, offersEffective, takenAreaM2 } from './areaBasis';

describe('the effective-area choice', () => {
	it('is offered only for a piece with a pans figure, something in the pans and something left', () => {
		expect(offersEffective(5e6, 1e6)).toBe(true);
		expect(offersEffective(5e6, 0)).toBe(false);
		expect(offersEffective(5e6, null)).toBe(false);
		expect(offersEffective(5e6, undefined)).toBe(false);
		expect(offersEffective(null, 1e6)).toBe(false);
		expect(offersEffective(5e6, 5e6)).toBe(false);
	});

	it('takes the gross area unless the effective one is chosen, and the effective one only with a figure', () => {
		expect(takenAreaM2(5e6, 1e6, 'gross')).toBe(5e6);
		expect(takenAreaM2(5e6, 1e6, 'effective')).toBe(4e6);
		expect(takenAreaM2(5e6, null, 'effective')).toBe(5e6);
		expect(takenAreaM2(5e6, 6e6, 'effective')).toBe(0);
	});

	it('words both options, gross first (the default), and a unit’s basis only when it is effective', () => {
		expect(basisOptions(12.3e6, 1.2e6)).toEqual([
			{ value: 'gross', label: 'Gross, 12.30 km² (what drains into pans included)' },
			{ value: 'effective', label: 'Effective, 11.10 km² (without the 1.20 km² draining into pans)' }
		]);
		expect(basisOptions(12.3e6, 1.2e6, 3)[1]!.label).toBe('Effective, 11.100 km² (without the 1.200 km² draining into pans)');
		expect(basisNote('effective')).toBe('effective, without pans');
		expect(basisNote('gross')).toBe('');
		expect(basisNote(null)).toBe('');
	});
});
