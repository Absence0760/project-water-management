// The regional prior on the Calibration page (issue #622 step 5): how a fit
// uses it, the prior calibrate() is given, the skill words ("No skill" only
// when the skill is 0 or below; a missing score is unknown, not none), the
// range rows beside the parameters now, and the fit record's line.
import { describe, expect, it } from 'vitest';
import type { ParamPriors, PriorProvenance } from '@water-management/engine';
import { calibrationPriorOf, donorLine, fitBoundsOf, priorKey, priorRecordLine, priorUseOfRecord, priorWeightError, rangeRows, skillText } from './prior';

const RANGES: ParamPriors = {
	x1: { p10: 200, p50: 300, p90: 500 },
	x2: { p10: 0, p50: 0, p90: 0 },
	x3: { p10: 40, p50: 60, p90: 90 },
	x4: { p10: 1.2, p50: 1.6, p90: 2.2 }
};
const PROV: PriorProvenance = {
	dataset: 'synthetic',
	datasetVersion: 'synthetic 1',
	synthetic: true,
	donorSetSha256: 'cd'.repeat(32),
	donorSetHash: '0123456789abcdef',
	donorCount: 14,
	k: 7,
	similarityWeight: 0.5,
	donors: Array.from({ length: 7 }, (_, i) => ({ id: `SYN-0${i + 1}`, weight: 1 / 7 })),
	leaveOneOutSkill: 0.42,
	leaveOneOutN: 14,
	x1From: 'soil',
	referenceLoad: null,
	target: { zoneNodeId: null, units: null }
};

describe('how a fit uses the prior', () => {
	it('searches the prior’s box under bounds and both, else the Bounds choice', () => {
		expect(fitBoundsOf('off', 'typical')).toBe('typical');
		expect(fitBoundsOf('penalty', 'wide')).toBe('wide');
		expect(fitBoundsOf('bounds', 'typical')).toBe('prior');
		expect(fitBoundsOf('both', 'wide')).toBe('prior');
	});

	it('gives calibrate() the ranges and provenance, with a weight only under a penalty', () => {
		const p = { ranges: RANGES, provenance: PROV };
		expect(calibrationPriorOf(p, 'off', 0.1)).toBeNull();
		expect(calibrationPriorOf(p, 'penalty', 0.3)).toEqual({ ranges: RANGES, weight: 0.3, provenance: PROV });
		expect(calibrationPriorOf(p, 'bounds', 0.3)!.weight).toBe(0);
		expect(calibrationPriorOf(p, 'both', null)!.weight).toBe(0.1);
		expect(calibrationPriorOf({ ranges: null, provenance: null }, 'both', 0.1)).toBeNull();
		expect(priorKey(null)).toBe('');
		expect(priorKey('g1')).toBe('g1');
	});

	it('asks for a weight over 0 and at most 10, only with the penalty', () => {
		expect(priorWeightError('bounds', null)).toBeNull();
		expect(priorWeightError('penalty', 0.1)).toBeNull();
		expect(priorWeightError('both', 0)).toMatch(/over 0 and at most 10/);
		expect(priorWeightError('penalty', 11)).toMatch(/at most 10/);
		expect(priorWeightError('penalty', null)).toMatch(/over 0/);
	});

	it('reads a fit record’s use back for the next fit', () => {
		expect(priorUseOfRecord({ bounds: 'typical' })).toEqual({ use: 'off', bounds: 'typical', weight: null });
		expect(priorUseOfRecord({ bounds: 'wide', prior: { weight: 0.2, bounded: false } })).toEqual({ use: 'penalty', bounds: 'wide', weight: 0.2 });
		expect(priorUseOfRecord({ bounds: 'prior', prior: { weight: 0, bounded: true } })).toEqual({ use: 'bounds', bounds: 'wide', weight: null });
		expect(priorUseOfRecord({ bounds: 'prior', prior: { weight: 0.1, bounded: true } })).toEqual({ use: 'both', bounds: 'wide', weight: 0.1 });
	});
});

describe('what the panel shows', () => {
	it('labels a skill of 0 or below “no skill”, and a missing score unknown', () => {
		expect(skillText(0.42, 14)).toEqual({ text: '0.42 (leave-one-out over 14 donors)', noSkill: false });
		expect(skillText(-0.1, 14)).toEqual({ text: '−0.10 (leave-one-out over 14 donors): no better than the donors’ plain median', noSkill: true });
		expect(skillText(0, 3).noSkill).toBe(true);
		expect(skillText(null, null)).toEqual({ text: 'Not scored: too few donors to leave one out', noSkill: false });
	});

	it('puts each parameter’s range beside its value now, and says where it sits', () => {
		const rows = rangeRows(RANGES, { x1: 150, x2: 0, x3: 60, x4: 3 });
		expect(rows.map((r) => [r.key, r.p10, r.p50, r.p90, r.current, r.where])).toEqual([
			['x1', '200', '300', '500', '150', 'below'],
			['x2', '0.00', '0.00', '0.00', '0.00', null],
			['x3', '40.0', '60.0', '90.0', '60.0', 'inside'],
			['x4', '1.20', '1.60', '2.20', '3.00', 'above']
		]);
		expect(rangeRows(RANGES, null)[0]!.current).toBe('–');
	});

	it('names the donor set and the fit record’s use of the prior', () => {
		expect(donorLine(PROV)).toBe('7 of 14 donors from “synthetic” (invented donors)');
		expect(priorRecordLine({ weight: 0.1, bounded: true, provenance: PROV })).toBe(
			'Regional prior: penalty weight 0.10, searched its p10–p90 box; 7 of 14 donors from “synthetic” (invented donors), SHA-256 cdcdcdcdcdcd…; skill 0.42 (leave-one-out over 14 donors).'
		);
	});
});
