import { describe, expect, it } from 'vitest';
import { newDemandObjectDefaults, type Borehole, type DemandObject, type LandCoverPatch } from '@water-management/engine';
import { newWindow } from './demandSchedule';
import { boreholeQuestion, curveQuestion, demandObjectQuestion, focusAfter, patchQuestion, windowQuestion } from './removeQuestions';

const object = (over: Partial<DemandObject> = {}): DemandObject =>
	({
		id: 'o',
		nodeId: 'n',
		name: 'Town A',
		category: 'municipal',
		...newDemandObjectDefaults('municipal'),
		sizing: 'monthly',
		monthlyM3Day: new Array(12).fill(0),
		count: null,
		monthlyFactor: null,
		enabled: true,
		schedule: null,
		source: null,
		rank: null,
		waterSource: null,
		riverPumpM3Day: null,
		riverPoolM3: null,
		note: '',
		...over
	}) as DemandObject;

describe('the remove questions', () => {
	it('asks nothing for a demand object as + Add demand made it, and names one with a demand and its windows', () => {
		expect(demandObjectQuestion(object(), 0)).toBeNull();
		const q = demandObjectQuestion(object({ monthlyM3Day: [5, ...new Array(11).fill(0)], schedule: [newWindow('always'), newWindow('easter')] }), 0)!;
		expect(q.title).toBe('Remove “Town A”?');
		expect(q.message).toMatch(/^Its monthly demand and 2 schedule windows go with it\. Until you save, Discard brings it back/);
		expect(q.confirmLabel).toBe('Remove demand object');
		expect(demandObjectQuestion(object({ name: ' ', note: 'meter 4' }), 1)!.title).toBe('Remove “demand object 2”?');
	});

	it('asks for a borehole only once it has a capacity, cap or depletion', () => {
		const b: Borehole = { id: 'b', nodeId: 'n', name: 'Borehole 1', capacityM3Day: 0, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 };
		expect(boreholeQuestion(b, 0)).toBeNull();
		expect(boreholeQuestion({ ...b, capacityM3Day: 100 }, 0)!.confirmLabel).toBe('Remove borehole');
	});

	it('asks for a land-cover patch once it has an area', () => {
		const p: LandCoverPatch = { id: 'p', nodeId: 'n', coverClass: 'invasive', areaKm2: 0, densityPct: 1, factors: null };
		expect(patchQuestion(p, 0, 'Invasive')).toBeNull();
		expect(patchQuestion({ ...p, areaKm2: 2 }, 0, 'Invasive')!.title).toBe('Remove land-cover patch 1 (Invasive)?');
	});

	it('asks for a schedule window once it differs from a new one', () => {
		expect(windowQuestion(newWindow('yearly'), 0)).toBeNull();
		expect(windowQuestion({ ...newWindow('yearly'), factor: 0.5 }, 1)!.title).toBe('Remove window 2 (Christmas break)?');
	});

	it('always asks for the survey curve', () => {
		expect(curveQuestion(4, 'Upper farm').message).toMatch(/^Its 4 survey rows go with it/);
	});

	it('focuses the next item, else the one before, else nothing', () => {
		expect(focusAfter(0, 3)).toBe(0);
		expect(focusAfter(2, 3)).toBe(1);
		expect(focusAfter(0, 1)).toBeNull();
	});
});
