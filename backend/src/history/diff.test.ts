import type { ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { monthly, node } from '../__tests__/helpers.js';
import { seriesChange, stableJson, touchedNodeIds } from './diff.js';
import { maskEmail } from './record.js';

const outlet = node('Weir', null);
const a = node('A', outlet.id);
const b = node('B', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const model = (over: Record<string, unknown> = {}): ProjectModel =>
	({
		nodes: [outlet, a, b],
		crops: [crop],
		cropAreas: [
			{ nodeId: a.id, cropId: crop.id, areaM2: 10 },
			{ nodeId: b.id, cropId: crop.id, areaM2: 20 }
		],
		transfers: [],
		landCover: [],
		...over
	}) as unknown as ProjectModel;

describe('stableJson', () => {
	it('ignores key order and undefined keys, keeps array order', () => {
		expect(stableJson({ b: 1, a: [2, 1], c: undefined })).toBe(stableJson({ a: [2, 1], b: 1 }));
		expect(stableJson({ a: [1, 2] })).not.toBe(stableJson({ a: [2, 1] }));
	});
});

describe('touchedNodeIds', () => {
	it('is empty for the same model, whatever the order of its crop areas', () => {
		const m = model();
		expect(touchedNodeIds(m, model({ cropAreas: [...m.cropAreas].reverse() }))).toEqual([]);
	});

	it('names a node whose field, crop area or transfer changed, and added or removed nodes', () => {
		expect(touchedNodeIds(model(), model({ nodes: [outlet, { ...a, damCapacityM3: 1 }, b] }))).toEqual([a.id]);
		expect(touchedNodeIds(model(), model({ cropAreas: [{ nodeId: a.id, cropId: crop.id, areaM2: 10 }] }))).toEqual([b.id]);
		const t = { id: crypto.randomUUID(), fromNodeId: a.id, toNodeId: b.id, months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 };
		expect(touchedNodeIds(model(), model({ transfers: [t] as ProjectModel['transfers'] }))).toEqual([a.id, b.id].sort());
		expect(touchedNodeIds(model(), model({ nodes: [outlet, a], cropAreas: [{ nodeId: a.id, cropId: crop.id, areaM2: 10 }] }))).toEqual([b.id]);
		expect(touchedNodeIds(null, model({ nodes: [outlet], cropAreas: [] }))).toEqual([outlet.id]);
	});

	it('treats a zero crop area as no area, as the save does', () => {
		expect(touchedNodeIds(model(), model({ cropAreas: [...model().cropAreas, { nodeId: outlet.id, cropId: crop.id, areaM2: 0 }] }))).toEqual([]);
	});
});

describe('seriesChange', () => {
	it('counts changed days over both ranges, a day outside a range reading as no reading', () => {
		expect(seriesChange({ startDate: '2024-01-01', values: [1, 2, 3] }, { startDate: '2024-01-02', values: [2, 5, 6] })).toEqual({
			from: '2024-01-02',
			to: '2024-01-04',
			daysChanged: 3 // 1 Jan gone, 3 Jan changed, 4 Jan new
		});
		expect(seriesChange({ startDate: '2024-01-01', values: [null, 1] }, { startDate: '2024-01-02', values: [1] }).daysChanged).toBe(0);
	});

	it('describes a new series and a deleted one', () => {
		expect(seriesChange(null, { startDate: '2024-02-28', values: [1, null, 2] })).toEqual({ from: '2024-02-28', to: '2024-03-01', daysChanged: 2 });
		expect(seriesChange({ startDate: '2024-01-01', values: [1, 2] }, null)).toEqual({ from: null, to: null, daysChanged: 2 });
	});
});

describe('maskEmail', () => {
	it('keeps the first letter and the domain', () => {
		expect(maskEmail('jane@example.com')).toBe('j•••@example.com');
		expect(maskEmail('nope')).toBe('•••');
	});
});
