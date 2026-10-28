import { describe, expect, it } from 'vitest';
import { mapSetupSteps, setupCount } from './mapSetup';

describe('mapSetupSteps', () => {
	it('with no boundary: both steps to do, whatever the feeds say', () => {
		for (const rain of [null, 'none', 'current', 'error'] as const) {
			const steps = mapSetupSteps({ boundaryName: null, rain })!;
			expect(steps.map((s) => [s.id, s.done])).toEqual([
				['boundary', false],
				['rain', false]
			]);
			expect(setupCount(steps)).toBe('0 of 2');
		}
	});
	it('with no boundary: the step leads with Delineate when the server has an elevation model, as the empty map does', () => {
		expect(mapSetupSteps({ boundaryName: null, rain: null, canDelineate: true })![0]!.detail).toBe(
			'No catchment boundary yet. Delineate it from its outlet on the river, draw it on the map, or upload it as a GeoJSON file (WGS84).'
		);
		expect(mapSetupSteps({ boundaryName: null, rain: null })![0]!.detail).toBe('No catchment boundary yet. Draw it on the map, or upload it as a GeoJSON file (WGS84).');
	});
	it('with a boundary and no feed reading it (or one reading it before a redraw): one of two', () => {
		const none = mapSetupSteps({ boundaryName: 'Upper catchment', rain: 'none' })!;
		expect(setupCount(none)).toBe('1 of 2');
		expect(none[0]!.detail).toBe('Upper catchment is on the map.');
		expect(none[1]!.detail).toBe('No rain feed reads this catchment boundary yet.');
		expect(mapSetupSteps({ boundaryName: '', rain: 'changed' })![1]!.detail).toBe('The boundary changed since the rain feed took its cells.');
	});
	it('nothing once every step is done, nor while the feeds are still read or failed to load', () => {
		expect(mapSetupSteps({ boundaryName: 'B', rain: 'current' })).toBeNull();
		expect(mapSetupSteps({ boundaryName: 'B', rain: null })).toBeNull();
		expect(mapSetupSteps({ boundaryName: 'B', rain: 'error' })).toBeNull();
	});
});

describe('mapSetupSteps for a model started from the map (issue #646 F2)', () => {
	const item = (id: string, status: 'done' | 'partial' | 'todo' | 'unknown', optional = false) => ({ id, title: id, status, detail: `${id} detail`, href: `?tab=${id}`, where: id, optional }) as never;
	it('lists the data step’s items, with their status and link, in place of the boundary and rain steps', () => {
		const steps = mapSetupSteps({ boundaryName: 'B', rain: 'current', data: [item('rain', 'done'), item('unit-rain', 'partial'), item('run', 'todo')] })!;
		expect(steps.map((s) => [s.id, s.done, s.status, s.href])).toEqual([
			['rain', true, 'done', '?tab=rain'],
			['unit-rain', false, 'partial', '?tab=unit-rain'],
			['run', false, 'todo', '?tab=run']
		]);
		expect(setupCount(steps)).toBe('1 of 3');
	});
	it('goes once every item a run needs is done, an optional one left or not', () => {
		expect(mapSetupSteps({ boundaryName: null, rain: null, data: [item('rain', 'todo', true), item('run', 'done')] })).toBeNull();
		expect(mapSetupSteps({ boundaryName: 'B', rain: 'current', data: [item('run', 'unknown')] })).not.toBeNull();
	});
});
