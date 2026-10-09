import { describe, expect, it } from 'vitest';
import { delineate } from './delineate.js';
import { delineateUnits, START_METHOD_VERSION, type UnitPoint } from './subcatchments.js';
import { at, functionDem, valley } from './valleyFixture.js';

// Start, Divide and Sub-catchments route their window the way Delineate does since start-12 (issue #390, the hydrologist persona's
// findings 1 and 6): each larger window placed over the catchment the last one cut. Against the invented valley
// (valleyFixture.ts), 200 cells (about 53 km) long, running north of its outlet.

const LONG = 200;
const dem = functionDem(valley(LONG));
const click = (id: string, u: number, v: number): UnitPoint => ({ id, role: 'user', geometry: { type: 'Point', coordinates: at(u, v) }, name: id });

describe('delineateUnits: the windows (start-12)', () => {
	it('places a larger window over a catchment the first one cut, as Delineate does (finding 6)', async () => {
		const whole = await delineate(dem, at(0, 0), { windows: [512] });
		// A gauge at the outlet: centred, 256 cells reach 128 north of it, short of the valley's 200.
		const r = await delineateUnits(dem, { outlet: at(0, 0), boundary: null, points: [] }, { windows: [128, 256] });
		expect(r.windowCells).toBe(256);
		expect(Math.abs(r.catchment.areaM2 / whole.areaM2 - 1)).toBeLessThan(0.02);
		expect(START_METHOD_VERSION).toBe('start-15');
	});

	it('grows for the lowest click on a river the first window cuts', async () => {
		const whole = await delineate(dem, at(0, -3), { windows: [512] });
		const r = await delineateUnits(dem, { outlet: 'lowest', boundary: null, points: [click('c1', 0, -3)] }, { windows: [128, 256] });
		expect(r.windowCells).toBe(256);
		expect(r.outlet.placedBy).toBe('snapped');
		expect(Math.abs(r.catchment.areaM2 / whole.areaM2 - 1)).toBeLessThan(0.05);
	});
});
