// Settings → Rain for each unit → "MAP from the grid" (issue #482): which
// state the panel shows, the coverage sentence (every unit, or the most with
// the rest listed), the grid picker's labels, which units Use would change,
// the confirmation and the notice after it. The panel itself is pinned by
// e2e/tests/unit-map.spec.ts.
import { describe, expect, it } from 'vitest';
import type { UnitMapProposal } from '$lib/api';
import { appliedNotice, candidateLabel, cellText, coverageLine, currentText, pctText, toChange, unitMapView, useMessage } from './unitMapProposal';

const unit = (name: string, mapMm: number, patch: Partial<UnitMapProposal['units'][number]> = {}): UnitMapProposal['units'][number] => ({
	nodeId: `n-${name}`,
	name,
	featureId: `f-${name}`,
	mapMm,
	cells: 4,
	coveredShare: 1,
	current: { mapMm: null, mapSource: null },
	same: false,
	...patch
});
const props = (patch: Partial<UnitMapProposal> = {}): UnitMapProposal => ({
	dataset: { label: 'synthetic', version: 'synthetic 1', source: 'Invented', attribution: 'Synthetic test data', cellDeg: 0.01, synthetic: true },
	coversAll: true,
	units: [unit('Upper', 612), unit('Lower', 540)],
	uncovered: [],
	withoutPolygon: [],
	refused: [],
	otherGrid: [],
	candidates: [{ label: 'synthetic', version: 'synthetic 1', cellDeg: 0.01, synthetic: true, covered: 2, missing: [] }],
	...patch
});

describe('unitMapView', () => {
	it('says why there is nothing to use: no grid loaded, no unit with a parcel, or none covered', () => {
		expect(unitMapView(props({ dataset: null, units: [], candidates: [] }))).toEqual({ kind: 'no-dataset' });
		expect(unitMapView(props({ units: [] }))).toEqual({ kind: 'no-units' });
		expect(unitMapView(props({ dataset: null, units: [], uncovered: [{ nodeId: 'a', name: 'A', coveredShare: 0, reason: 'r' }] }))).toEqual({ kind: 'none-covered' });
		expect(unitMapView(props())).toEqual({ kind: 'ready' });
	});
});

describe('the coverage sentence and the picker', () => {
	it('says the grid covers every unit, or the most, with its cell size', () => {
		expect(cellText(0.01)).toBe('0.01° cells');
		expect(cellText(1 / 60)).toBe('0.0167° cells');
		expect(coverageLine(props())).toBe('synthetic (0.01° cells) covers all 2 units with a parcel on the map.');
		expect(coverageLine(props({ units: [unit('Upper', 612)] }))).toBe('synthetic (0.01° cells) covers the unit with a parcel on the map.');
		expect(coverageLine(props({ coversAll: false, uncovered: [{ nodeId: 'c', name: 'C', coveredShare: 0.4, reason: 'r' }] }))).toBe(
			'synthetic (0.01° cells) covers 2 of the 3 units with a parcel on the map; the rest keep what they have.'
		);
		expect(candidateLabel(props().candidates[0]!, 3)).toBe('synthetic (0.01° cells, synthetic 1): covers 2 of 3');
	});

	it('words what each unit holds now and how much of a parcel has values', () => {
		expect(currentText(unit('A', 600))).toBe('None');
		expect(currentText(unit('A', 600, { current: { mapMm: 812, mapSource: 's' } }))).toBe('812 mm');
		expect(pctText(0.5)).toBe('50 %');
		// Floored, so a unit just short of the rule never reads as 90 %.
		expect(pctText(0.8999)).toBe('89.9 %');
	});
});

describe('Use', () => {
	it('changes only the units that don’t hold this MAP already, and says so before and after', () => {
		const p = props({ units: [unit('Upper', 612), unit('Lower', 540, { same: true })], withoutPolygon: [{ nodeId: 'w', name: 'W' }] });
		expect(toChange(p).map((u) => u.name)).toEqual(['Upper']);
		expect(useMessage(p)).toBe(
			'1 unit gets its MAP and source from synthetic synthetic 1, replacing what its form holds, saved straight to the model as one change in History. 1 unit without a MAP from this grid keeps what it has. The MAP sets the level of each unit’s rain while Rain for each unit is on: run and refit afterwards.'
		);
		expect(useMessage(props())).toMatch(/^2 units get their MAP and source from synthetic synthetic 1, replacing what their forms hold/);
		expect(appliedNotice({ dataset: 'synthetic', units: [], changed: 2, revisionId: 'r' }, 'synthetic synthetic 1')).toBe(
			'2 units now have their MAP from synthetic synthetic 1, saved as one model change (History).'
		);
		expect(appliedNotice({ dataset: 'synthetic', units: [], changed: 0, revisionId: null }, 'g 1')).toBe('Every unit already had its MAP from g 1: nothing changed.');
	});
});
