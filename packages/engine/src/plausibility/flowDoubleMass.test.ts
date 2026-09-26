import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { flowDoubleMass, flowDoubleMassWarning, hintOf, type FlowDoubleMassInput } from './flowDoubleMass';

const start = toEpochDay('2000-10-01');
const end = toEpochDay('2020-09-30'); // 20 water years, 2000 … 2019
const days = end - start + 1;
const dryMonths = new Set([11, 12, 1, 2, 3, 4]);
const inSeason = Uint8Array.from({ length: days }, (_, t) => (dryMonths.has(monthOfEpochDay(start + t)) ? 1 : 0));
/** mm/day over 1 km² → m³/s. */
const m3s = (mm: number) => (mm * 1000) / 86_400;

/**
 * 2 mm of rain every day; the model runs 0.2 mm/day of outflow throughout
 * (runoff ratio 0.1). Observed matches it until water year 2009, then its dry-
 * and wet-season days are scaled by `dry` and `wet`; `simAfter` scales the model too.
 */
function input(dry: number, wet: number, simAfter = 1): FlowDoubleMassInput {
	const after = (t: number) => waterYearOf(start + t) >= 2010;
	return {
		flowKind: 'flow_observed_m3s',
		start,
		rainMm: new Array(days).fill(2),
		observedM3s: Array.from({ length: days }, (_, t) => m3s(0.2 * (after(t) ? (inSeason[t] ? dry : wet) : 1))),
		simulatedM3Day: Array.from({ length: days }, (_, t) => 0.2 * 1000 * (after(t) ? simAfter : 1)),
		areaKm2: 1,
		inSeason,
		excluded: new Uint8Array(days)
	};
}

describe('flowDoubleMass', () => {
	it('finds the break after 2009/10 and reads the annual runoff ratios (hand-worked)', () => {
		const dm = flowDoubleMass(input(0.4, 1))!;
		expect(dm.years).toHaveLength(20);
		const y0 = dm.years[0]!;
		expect(y0.rainMm).toBeCloseTo(2 * 365, 9);
		expect(y0.ratio).toBeCloseTo(0.1, 12);
		expect(dm.breaks).toHaveLength(1);
		const b = dm.breaks[0]!;
		expect(b.afterWaterYear).toBe(2009);
		expect(b.slopeBefore).toBeCloseTo(0.1, 12);
		expect(b.simulatedSlopeBefore).toBeCloseTo(0.1, 12);
		expect(b.simulatedSlopeAfter).toBeCloseTo(0.1, 12);
		// Dry days (about half) at 0.4: the ratio falls about 30 %, all of it the dry season's.
		expect(b.change).toBeCloseTo(-0.3, 1);
		expect(b.unexplained).toBeCloseTo(b.change, 12);
		expect(b.unexplainedDry).toBeCloseTo(-0.6, 12);
		expect(b.unexplainedWet).toBeCloseTo(0, 12);
		expect(b.hint).toBe('newUse');
		expect(flowDoubleMassWarning(dm)).toMatch(/after 2009\/10 \(runoff ratio 0\.100 → 0\.07\d.*points to new use upstream/);
	});

	it('puts a fall the wet season takes more of down to the gauge', () => {
		const dm = flowDoubleMass(input(1, 0.4))!;
		expect(dm.breaks[0]!.hint).toBe('gauge');
		expect(flowDoubleMassWarning(dm)).toMatch(/points to the gauge/);
	});

	it('puts a rise down to the gauge (new use cannot raise flow)', () => {
		const dm = flowDoubleMass(input(1.5, 1.5))!;
		expect(dm.breaks[0]!.change).toBeCloseTo(0.5, 12);
		expect(dm.breaks[0]!.hint).toBe('gauge');
		expect(flowDoubleMassWarning(dm)).toMatch(/a rise new use can't cause/);
	});

	it('does not warn about a break the model shows with the same rain', () => {
		const dm = flowDoubleMass(input(0.5, 0.5, 0.5))!;
		expect(dm.breaks).toHaveLength(1);
		expect(dm.breaks[0]).toMatchObject({ unexplained: expect.closeTo(0, 12), hint: 'rain' });
		expect(flowDoubleMassWarning(dm)).toBeNull();
	});

	it('finds no break on a steady record', () => {
		const dm = flowDoubleMass(input(1, 1))!;
		expect(dm.breaks).toEqual([]);
		expect(dm.segments).toHaveLength(1);
		expect(dm.wholeSlope).toBeCloseTo(0.1, 12);
		expect(flowDoubleMassWarning(dm)).toBeNull();
	});

	it('is null without a catchment area or with fewer than 10 judged years, and skips short years', () => {
		expect(flowDoubleMass({ ...input(1, 1), areaKm2: 0 })).toBeNull();
		const x = input(1, 1);
		const obs = x.observedM3s as (number | null)[];
		// Blank all but 100 days of the first 11 years: 9 judged years remain.
		for (let t = 0; t < days; t++) if (waterYearOf(start + t) <= 2010 && (t % 365) >= 100) obs[t] = null;
		expect(flowDoubleMass(x)).toBeNull();
		const y = input(1, 1);
		for (let t = 0; t < 200; t++) (y.observedM3s as (number | null)[])[t] = null;
		expect(flowDoubleMass(y)!.skippedYears).toEqual([2000]);
	});
});

describe('hintOf', () => {
	it('follows the documented rules', () => {
		expect(hintOf(null, null, null)).toBe('unclear');
		expect(hintOf(-0.19, -1, 0)).toBe('rain');
		expect(hintOf(0.3, null, null)).toBe('gauge');
		expect(hintOf(-0.3, null, -0.3)).toBe('unclear');
		expect(hintOf(-0.3, -0.4, -0.3)).toBe('newUse');
		expect(hintOf(-0.3, -0.3, -0.4)).toBe('gauge');
		expect(hintOf(-0.3, -0.35, -0.3)).toBe('unclear');
	});
});
