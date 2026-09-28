import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { EwrAssuranceSite } from '../reserve/assurance';
import { rainSourceEwr, rainSourceWarnings, type RainSourceInput } from './rainSource';

const start = toEpochDay('2001-10-01'); // water years 2001 and 2002: 365 days each
const days = 730;

/** Year 1 all station, year 2 all fallback (CHIRPS); `notMet` days not met in each. */
function input(notMet: [number, number], over: Partial<RainSourceInput> = {}): RainSourceInput {
	const station = new Uint8Array(days);
	for (let t = 0; t < 365; t++) station[t] = 1;
	const short = new Array(days).fill(0);
	for (let t = 0; t < notMet[0]; t++) short[t] = -1;
	for (let t = 0; t < notMet[1]; t++) short[365 + t] = -1;
	return { start, rainMm: new Array(days).fill(2), station, hasStation: true, ewrShortfall: short, reserve: [], ...over };
}

describe('rainSourceEwr', () => {
	it('splits EWR days not met by good-rain and fallback-rain years (hand-worked)', () => {
		const r = rainSourceEwr(input([10, 100]))!;
		expect(r.years.map((y) => [y.waterYear, y.fallback, y.stationDays, y.fallbackRainShare, y.ewrDaysNotMet])).toEqual([
			[2001, false, 365, 0, 10],
			[2002, true, 0, 1, 100]
		]);
		expect(r.good).toEqual({ years: 1, days: 365, ewrDaysNotMet: 10, fractionNotMet: 10 / 365 });
		expect(r.fallback).toEqual({ years: 1, days: 365, ewrDaysNotMet: 100, fractionNotMet: 100 / 365 });
		// 27 % vs 3 %: 25 points apart, over the 10-point limit.
		const w = rainSourceWarnings(r);
		expect(w).toHaveLength(1);
		expect(w[0]).toMatch(/27 % of days in the 1 fallback-rain water year \(2002\/03\) against 3 % in the 1 good-rain year/);
	});

	it('does not warn when the groups are within 10 points of each other', () => {
		expect(rainSourceWarnings(rainSourceEwr(input([10, 40]))!)).toEqual([]);
	});

	it('calls a year fallback when more than half its rain fell on fallback days, even with most days read', () => {
		// 300 station days of 0 mm, 65 fallback days of 10 mm: 100 % of the rain is fallback, 18 % of the days.
		const x = input([0, 0]);
		const rain = x.rainMm as (number | null)[];
		for (let t = 0; t < 365; t++) rain[t] = t < 300 ? 0 : 10;
		for (let t = 300; t < 365; t++) x.station[t] = 0;
		const y = rainSourceEwr(x)!.years[0]!;
		expect(y.fallbackRainShare).toBe(1);
		expect(y.fallbackDayShare).toBeCloseTo(65 / 365, 12);
		expect(y.fallback).toBe(true);
	});

	it('calls a year of blanks run as dry a fallback year, though it has no fallback rain', () => {
		const x = input([0, 0]);
		for (let t = 0; t < 200; t++) {
			x.station[t] = 0;
			(x.rainMm as (number | null)[])[t] = null;
		}
		const y = rainSourceEwr(x)!.years[0]!;
		expect(y.fallbackRainMm).toBe(0);
		expect(y.fallbackDayShare).toBeCloseTo(200 / 365, 12);
		expect(y.fallback).toBe(true);
	});

	it('keeps a year at exactly half fallback a good-rain year (more than half is needed)', () => {
		const x: RainSourceInput = { start, rainMm: [1, 1, 1, 1], station: Uint8Array.from([1, 1, 0, 0]), hasStation: true, ewrShortfall: [0, 0, 0, 0], reserve: [] };
		expect(rainSourceEwr(x)!.years[0]!.fallback).toBe(false);
	});

	it('splits the Reserve months met by the same years', () => {
		const month = (waterYear: number, met: boolean) => ({ waterYear, met }) as EwrAssuranceSite['months'][number];
		const site = { nodeId: null, name: 'Outlet', isOutlet: true, months: [month(2001, true), month(2001, true), month(2002, false), month(2002, true)] } as unknown as EwrAssuranceSite;
		const r = rainSourceEwr(input([0, 0], { reserve: [site] }))!;
		expect(r.reserve).toEqual([{ nodeId: null, name: 'Outlet', isOutlet: true, good: { months: 2, met: 2, rate: 1 }, fallback: { months: 2, met: 1, rate: 0.5 } }]);
		expect(rainSourceWarnings(r)).toEqual([expect.stringMatching(/Reserve compliance at the outlet \(Outlet\) differs by rain source: 50 % of months met in fallback-rain years against 100 %/)]);
	});

	it('warns when every year is a fallback year and the project has a station; not for a CHIRPS-only project', () => {
		const all = input([0, 0], { station: new Uint8Array(days) });
		expect(rainSourceWarnings(rainSourceEwr(all)!)).toEqual([expect.stringMatching(/^Every water year of the run is a fallback-rain year/)]);
		expect(rainSourceWarnings(rainSourceEwr({ ...all, hasStation: false })!)).toEqual([]);
	});

	it('is null for a run with no days', () => {
		expect(rainSourceEwr({ start, rainMm: [], station: new Uint8Array(0), hasStation: false, ewrShortfall: [], reserve: [] })).toBeNull();
		expect(rainSourceWarnings(null)).toEqual([]);
	});
});
