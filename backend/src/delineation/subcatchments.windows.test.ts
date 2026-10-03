import { describe, expect, it } from 'vitest';
import { delineate } from './delineate.js';
import { delineateUnits, START_METHOD_VERSION, type UnitPoint } from './subcatchments.js';
import { at, functionDem, valley } from './valleyFixture.js';

// Start, Divide and Sub-catchments route their window the way Delineate does since start-12 (issue #390, the hydrologist persona's
// findings 1 and 6): grown for a river cut at the outlet, each larger window placed over the catchment. Against the invented valley
// (valleyFixture.ts), 200 cells (about 53 km) long, running north of its outlet.

const LONG = 200;
const dem = functionDem(valley(LONG));
const click = (id: string, u: number, v: number, hints: Partial<UnitPoint> = {}): UnitPoint => ({ id, role: 'user', geometry: { type: 'Point', coordinates: at(u, v) }, name: id, ...hints });

describe('delineateUnits: the windows (start-12)', () => {
	it('places a larger window over a catchment the first one cut, as Delineate does (finding 6)', async () => {
		const whole = await delineate(dem, at(0, 0), { windows: [512] });
		// A gauge at the outlet: centred, 256 cells reach 128 north of it, short of the valley's 200.
		const r = await delineateUnits(dem, { outlet: at(0, 0), boundary: null, points: [] }, { windows: [128, 256] });
		expect(r.windowCells).toBe(256);
		expect(Math.abs(r.catchment.areaM2 / whole.areaM2 - 1)).toBeLessThan(0.02);
		expect(START_METHOD_VERSION).toBe('start-12');
	});

	it('grows for a river the window cuts at a gauge, instead of leaving the outlet in a gully (finding 1)', async () => {
		const whole = await delineate(dem, at(0, -3), { windows: [512] });
		const expectedKm2 = (whole.cells * whole.cellAreaM2) / 1e6;
		// Three cells east of the river, as a gauge plotted beside its river: in a 128-cell window nothing matches the reach.
		const r = await delineateUnits(dem, { outlet: at(3, -3), outletHints: { expectedKm2 }, boundary: null, points: [] }, { windows: [128, 256] });
		expect(r.windowCells).toBe(256);
		expect(r.outlet.placedBy).toBe('matched');
		expect(Math.abs(r.catchment.areaM2 / whole.areaM2 - 1)).toBeLessThan(0.05);
	});

	it('grows for the lowest click’s river too', async () => {
		const whole = await delineate(dem, at(0, -3), { windows: [512] });
		const expectedKm2 = (whole.cells * whole.cellAreaM2) / 1e6;
		const r = await delineateUnits(dem, { outlet: 'lowest', boundary: null, points: [click('c1', 3, -3, { expectedKm2 })] }, { windows: [128, 256] });
		expect(r.windowCells).toBe(256);
		expect(r.outlet.placedBy).toBe('matched');
		expect(Math.abs(r.catchment.areaM2 / whole.areaM2 - 1)).toBeLessThan(0.05);
	});
});

describe('delineateUnits: `unmatched` on a click cut at the window (start-12)', () => {
	// A valley longer than any window here: the lowest click's piece is cut at the cap; the upper click's piece, above it, is
	// open, and the lowest's own piece between them is whole.
	const longer = functionDem(valley(400));
	const points = (lowerKm2: number) => [click('low', 0, 0, { expectedKm2: lowerKm2 }), { ...click('up', 0, -40), role: 'dam' as const }];

	it('keeps it when the reach would fit the routed square: a match was possible, so the warning stands', async () => {
		// 1 000 km² against the 256-cell square's ~4 600: no channel in the window comes within 50 % of it.
		const r = await delineateUnits(longer, { outlet: 'lowest', boundary: null, points: points(1000) }, { windows: [128, 256] });
		expect(r.outlet.id).toBe('low');
		expect(r.outlet.unmatched).toBe(true);
	});

	it('drops it when the reach is larger than the routed square (a main stem no window can match)', async () => {
		const r = await delineateUnits(longer, { outlet: 'lowest', boundary: null, points: points(1_000_000) }, { windows: [128, 256] });
		expect(r.outlet.id).toBe('low');
		expect(r.outlet.unmatched).toBeFalsy();
	});
});
