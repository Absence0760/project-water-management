import { describe, expect, it } from 'vitest';
import type { UnitApanProposal } from '#lib/api/index.js';
import { catchmentRow, diffText, leftOut, savedText, spreadText, useMessage } from './unitApan';

const row = Array(12).fill(200);
const unit = (name: string, diffPct: number | null) => ({ nodeId: name, name, areaKm2: 10, monthlyMm: row, annualMm: 2400, cells: 4, coveredShare: 1, diffPct });
const proposal = (over: Partial<UnitApanProposal> = {}): UnitApanProposal => ({
	dataset: { label: 'Atlas-Apan-2007', version: '1', source: 's', attribution: 'a', method: 'm', cellDeg: 0.0167, synthetic: false, firstYear: null, lastYear: null },
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

describe('savedText and useMessage', () => {
	const two = { units: [unit('A', -1), unit('B', 1)] };
	it('says what the settings hold for the units', () => {
		expect(savedText(proposal({ ...two, same: true, saved: { basis: 'units', dataset: 'Atlas-Apan-2007', source: 's', units: { A: row, B: row } } }))).toBe('Saved: the model runs these 2 units on their own A-pan.');
		expect(savedText(proposal({ ...two, same: true, saved: { basis: 'catchment', dataset: 'Atlas-Apan-2007', source: 's', units: { A: row, B: row } } }))).toBe(
			'Saved for these 2 units; save the settings with this option to run on them.'
		);
		expect(savedText(proposal({ ...two, same: false, saved: { basis: 'units', dataset: null, source: null, units: {} } }))).toBe(
			'No unit has its own A-pan saved yet, so every unit runs on the A-pan row below until you use these.'
		);
		expect(savedText(proposal({ ...two, same: false, saved: { basis: 'units', dataset: 'old', source: 's', units: { A: row } } }))).toMatch(/^The model runs 1 unit on A-pan saved earlier from old/);
		expect(savedText(proposal({ ...two, same: false, saved: { basis: 'catchment', dataset: null, source: null, units: {} } }))).toBeNull();
		expect(savedText(proposal(two))).toBeNull();
	});
	it('the confirmation names the units left out and the daily record', () => {
		const m = useMessage(proposal({ ...two, uncovered: [{ nodeId: 'e', name: 'Edge', coveredShare: 0.5, reason: 'r' }] }));
		expect(m).toBe(
			'Crop demand, dam evaporation and, under pan coefficient × A-pan, GR4J will read each unit’s own 12 months for 2 units instead of the one A-pan row. Edge has none and runs on the covered units’ area-weighted mean, as does a dam outside every unit. A daily A-pan record isn’t read while this option is chosen.'
		);
	});
});
