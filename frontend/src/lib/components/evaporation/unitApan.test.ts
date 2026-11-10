import { describe, expect, it } from 'vitest';
import type { UnitApanProposal } from '#lib/api/index.js';
import { catchmentRow, diffText, leftOut, spreadText } from './unitApan';

const row = Array(12).fill(200);
const unit = (name: string, diffPct: number | null) => ({ nodeId: name, name, areaKm2: 10, monthlyMm: row, annualMm: 2400, cells: 4, coveredShare: 1, diffPct });
const proposal = (over: Partial<UnitApanProposal> = {}): UnitApanProposal => ({
	dataset: { label: 'Atlas-Apan-2007', version: '1', source: 's', attribution: 'a', method: 'm', cellDeg: 0.0167, synthetic: false },
	boundary: { featureId: 'b', name: 'Catchment' },
	catchment: { monthlyMm: row, annualMm: 2400, coverage: 1, cells: 9 },
	units: [],
	uncovered: [],
	withoutPolygon: [],
	refused: [],
	settingsApanMm: row,
	...over
});

describe('diffText', () => {
	it('signs a difference with a real minus and one decimal', () => {
		expect(diffText(5.46)).toBe('+5.5 %');
		expect(diffText(-12.04)).toBe('−12.0 %');
		expect(diffText(0.04)).toBe('0.0 %');
		expect(diffText(null)).toBe('–');
	});
});

describe('spreadText', () => {
	it('says how far the units spread around the catchment’s year', () => {
		expect(spreadText(proposal({ units: [unit('A', -3.2), unit('B', 4.1), unit('C', 0)] }))).toBe('The 3 units the grid covers range from −3.2 % to +4.1 % of the catchment’s year.');
		expect(spreadText(proposal({ units: [unit('A', 2)] }))).toBe('The one unit the grid covers is +2.0 % from the catchment’s year.');
	});
	it('says nothing without a unit or a catchment average', () => {
		expect(spreadText(proposal())).toBeNull();
		expect(spreadText(proposal({ units: [unit('A', null)], catchment: null }))).toBeNull();
	});
});

describe('catchmentRow and leftOut', () => {
	it('reads the catchment row only when the grid summarised the boundary', () => {
		expect(catchmentRow(proposal())?.annualMm).toBe(2400);
		expect(catchmentRow(proposal({ catchment: { problem: 'no value' } }))).toBeNull();
		expect(catchmentRow(proposal({ catchment: null }))).toBeNull();
	});
	it('lists every unit left out with why: under-covered, no outline, several parcels', () => {
		const p = proposal({
			uncovered: [{ nodeId: 'u', name: 'Edge', coveredShare: 0.5, reason: 'only 50 %' }],
			withoutPolygon: [{ nodeId: 'w', name: 'Bare' }],
			refused: [{ nodeId: 'r', name: 'Split', reason: 'several parcels' }]
		});
		expect(leftOut(p)).toEqual([
			{ nodeId: 'u', name: 'Edge', reason: 'only 50 %' },
			{ nodeId: 'w', name: 'Bare', reason: 'the unit has no outline (parcel) on the map' },
			{ nodeId: 'r', name: 'Split', reason: 'several parcels' }
		]);
	});
});
