// The quaternary lookup's proposal (quaternaryProposal.ts): what each row
// shows beside the form, and that "Use" changes only the value asked for.
import { describe, expect, it } from 'vitest';
import type { MapFeature, QuaternaryProposal } from '$lib/api/types';
import { blankReference } from './wr2012';
import { lookupPoints, proposalRows, proposedSource, useValue } from './quaternaryProposal';

const p: QuaternaryProposal = {
	code: 'Z01B',
	dataset: 'synthetic',
	synthetic: true,
	areaKm2: 642.5,
	mapMm: 540,
	marMm3: 17.001,
	monthlyMm3: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 6.001],
	periodStart: 1920,
	periodEnd: 2009,
	source: 'SYNTHETIC test data: quaternary Z01B',
	loadedAt: '2026-10-01T00:00:00Z'
};
const at: [number, number] = [21.35, -33.65];

describe('proposalRows', () => {
	it('lists every value with the form’s now and the proposal, none the same on a blank form', () => {
		const rows = proposalRows(blankReference(), p, at);
		expect(rows.map((r) => r.key)).toEqual(['quaternary', 'areaKm2', 'mapMm', 'marMm3', 'period', 'monthlyMm3', 'source']);
		expect(rows.every((r) => !r.same && !r.missing)).toBe(true);
		expect(rows.find((r) => r.key === 'period')!.proposed).toBe('1920/21 to 2009/10');
		expect(rows.find((r) => r.key === 'source')!.proposed).toBe('SYNTHETIC test data: quaternary Z01B (quaternary Z01B, looked up on the map at -33.6500, 21.3500)');
	});

	it('marks a value the dataset lacks as missing', () => {
		const rows = proposalRows(blankReference(), { ...p, mapMm: null, monthlyMm3: null, periodEnd: null }, at);
		expect(rows.filter((r) => r.missing).map((r) => r.key)).toEqual(['mapMm', 'period', 'monthlyMm3']);
	});
});

describe('useValue', () => {
	it('puts in only the value asked for, and then that row reads as the same', () => {
		const ref = blankReference();
		useValue(ref, p, 'mapMm', at);
		expect(ref).toEqual({ ...blankReference(), mapMm: 540 });
		useValue(ref, p, 'monthlyMm3', at);
		useValue(ref, p, 'period', at);
		useValue(ref, p, 'source', at);
		expect(ref.monthlyMm3).toEqual(p.monthlyMm3);
		expect(ref.monthlyMm3).not.toBe(p.monthlyMm3);
		expect([ref.periodStart, ref.periodEnd]).toEqual([1920, 2009]);
		expect(ref.source).toBe(proposedSource(p, at));
		const same = proposalRows(ref, p, at).filter((r) => r.same).map((r) => r.key);
		expect(same).toEqual(['mapMm', 'period', 'monthlyMm3', 'source']);
		expect(ref.quaternary).toBe('');
		expect(ref.areaKm2).toBeNull();
	});

	it('leaves a value the dataset lacks as it was', () => {
		const ref = { ...blankReference(), mapMm: 600 };
		useValue(ref, { ...p, mapMm: null }, 'mapMm', at);
		expect(ref.mapMm).toBe(600);
	});
});

describe('lookupPoints', () => {
	it('starts from the boundary’s centre, then each gauge', () => {
		const base = { nodeId: null, nodeName: null, properties: {}, areaM2: null, sourceId: null, nonContributingM2: null, createdBy: null, createdAt: '', updatedAt: '' };
		const fs: MapFeature[] = [
			{ ...base, id: 'g', kind: 'gauge', name: 'Weir', geometry: { type: 'Point', coordinates: [21.3, -33.6] }, center: [21.3, -33.6] },
			{ ...base, id: 'b', kind: 'catchment_boundary', name: 'Upper', geometry: { type: 'Polygon', coordinates: [] }, center: [21.35, -33.65], areaM2: 1 },
			{ ...base, id: 'd', kind: 'dam', name: 'Dam', geometry: { type: 'Point', coordinates: [21, -33] }, center: [21, -33] }
		];
		expect(lookupPoints(fs)).toEqual([
			{ id: 'b', label: 'The catchment boundary’s centre (Upper)', at: [21.35, -33.65] },
			{ id: 'g', label: 'Gauge Weir', at: [21.3, -33.6] }
		]);
	});
});
