import { defaultCalibrationRules, OBJECTIVES } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { pctToShare, rulesFieldsError, rulesStatusText, shareToPct, toggled } from './calibrationRules';

describe('the calibration rules fields', () => {
	it('keeps a ticked list in its canonical order, whatever order the boxes were ticked in', () => {
		expect(toggled(OBJECTIVES, ['nseLog'], 'kgePrime', true)).toEqual(['kgePrime', 'nseLog']);
		expect(toggled(OBJECTIVES, ['kgePrime', 'nseLog'], 'kgePrime', false)).toEqual(['nseLog']);
		expect(toggled(['wide', 'typical'], ['wide'], 'wide', true)).toEqual(['wide']);
	});

	it('shows the flagged-day share as a percentage and stores a fraction', () => {
		expect(shareToPct(0.2)).toBe(20);
		expect(pctToShare(12.5)).toBe(0.125);
		expect(shareToPct(null)).toBeNull();
	});

	it('blocks Save on the engine’s own check, worded for the form', () => {
		expect(rulesFieldsError(defaultCalibrationRules())).toBeNull();
		expect(rulesFieldsError({ ...defaultCalibrationRules(), cases: { bounds: [], objectives: ['kgePrime'] } })).toBe('Calibration rules: list at least one set of bounds.');
	});

	it('shows the revision and whether the hydrologist has signed the rules off', () => {
		expect(rulesStatusText(defaultCalibrationRules())).toBe('Revision 1 · draft, not signed off by the hydrologist');
		expect(rulesStatusText({ ...defaultCalibrationRules(), revision: 3, signedOff: { by: 'A. Hydrologist', on: '2026-09-29' } })).toBe(
			'Revision 3 · signed off by A. Hydrologist on 2026-09-29'
		);
	});
});
