import { describe, expect, it } from 'vitest';
import type { UnitMapProposal, UnitRainProposal } from '#lib/api/types.js';
import { initialUnitTicks, tickAllUnits, unitApplyPlan, unitApplySummary, unitDataRows } from './unitsData';

const order = [
	{ id: 'a', name: 'Upper' },
	{ id: 'b', name: 'Middle' },
	{ id: 'c', name: 'Lower' },
	{ id: 'g', name: 'Weir' }
];
const cell = { lat: -33.775, lon: 21.225, share: 1, weight: 0.8 };
const map: UnitMapProposal = {
	dataset: { label: 'synthetic', version: '1', source: 'Invented MAP grid', attribution: '', cellDeg: 0.01, synthetic: true },
	coversAll: false,
	units: [
		{ nodeId: 'a', name: 'Upper', featureId: 'fa', mapMm: 640, cells: 12, coveredShare: 1, current: { mapMm: null, mapSource: null }, same: false },
		{ nodeId: 'b', name: 'Middle', featureId: 'fb', mapMm: 600, cells: 9, coveredShare: 0.95, current: { mapMm: 600, mapSource: 'grid' }, same: true }
	],
	uncovered: [{ nodeId: 'c', name: 'Lower', coveredShare: 0, reason: 'outside the grid' }],
	withoutPolygon: [],
	refused: [],
	otherGrid: [],
	candidates: []
};
const rain = (canApply: boolean): UnitRainProposal => ({
	product: 'rnl',
	units: [
		{ nodeId: 'a', name: 'Upper', featureId: 'fa', areaKm2: 4, cells: [cell], feedId: null, seriesDays: 0, action: 'create' },
		{ nodeId: 'b', name: 'Middle', featureId: 'fb', areaKm2: 3, cells: [cell, cell], feedId: 'f1', seriesDays: 10, action: 'none' }
	],
	withoutPolygon: [{ nodeId: 'c', name: 'Lower' }],
	refused: [],
	canApply,
	maxFeeds: 50
});

describe('unitDataRows', () => {
	it('one row per land unit in the model’s order, each value offered, held already, or none with why', () => {
		const rows = unitDataRows(order, map, rain(true));
		expect(rows.map((r) => r.name)).toEqual(['Upper', 'Middle', 'Lower']);
		expect(rows[0]).toMatchObject({ map: { kind: 'offer', mapMm: 640, current: null }, rain: { kind: 'offer', action: 'create', owner: true } });
		expect(rows[1]).toMatchObject({ map: { kind: 'same', mapMm: 600 }, rain: { kind: 'same', cellsText: '2 cells, 100 % of their area inside' } });
		expect(rows[2]).toMatchObject({ map: { kind: 'none', reason: 'outside the grid' }, rain: { kind: 'none', reason: 'no boundary or parcel on the map' } });
	});

	it('a proposal that failed to load says so on every unit', () => {
		const rows = unitDataRows(order, null, rain(true), { map: 'the MAP proposal couldn’t be read', rain: '' });
		expect(rows[0]!.map).toEqual({ kind: 'none', reason: 'the MAP proposal couldn’t be read' });
	});
});

describe('the ticks', () => {
	it('open unticked; Tick all ticks only what is offered (an editor never ticks a feed); Apply sends only the ticked', () => {
		const rows = unitDataRows(order, map, rain(true));
		const none = initialUnitTicks(rows);
		expect(unitApplyPlan(rows, none)).toEqual({ map: [], rain: [] });
		const all = tickAllUnits(rows);
		expect(all).toEqual({ a: { map: true, rain: true }, b: { map: false, rain: false }, c: { map: false, rain: false } });
		expect(unitApplyPlan(rows, all)).toEqual({ map: ['a'], rain: ['a'] });
		// A tick on a value that isn't offered is never sent.
		expect(unitApplyPlan(rows, { ...all, b: { map: true, rain: true } })).toEqual({ map: ['a'], rain: ['a'] });

		const editor = unitDataRows(order, map, rain(false));
		expect(unitApplyPlan(editor, tickAllUnits(editor))).toEqual({ map: ['a'], rain: [] });
	});

	it('the confirm names the grid, the product and the counts', () => {
		expect(unitApplySummary({ map: ['a'], rain: ['a', 'b'] }, map, rain(true))).toBe(
			'1 unit gets its MAP from the MAP grid synthetic 1, saved straight to the model as one change in History. 2 units get their own CHIRPS feeds (rnl), over their boundary’s cells, recorded as one change in History; the feeds fetch on their schedule.'
		);
	});
});
