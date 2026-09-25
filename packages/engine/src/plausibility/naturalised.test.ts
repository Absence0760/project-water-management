import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { NATURALISED_MIN_DAYS, naturalisedCheck, naturalisedWarning, type NaturalisedInput } from './naturalised';

const start = toEpochDay('2001-10-01'); // water year 2001: 365 days

/** One water year of constant daily volumes (m³/day), observed in m³/s. */
function year(n: number, s: number, oM3s: number | null, dams = 0, lc = 0, days = 365): NaturalisedInput {
	return {
		flowKind: 'flow_observed_m3s',
		start,
		naturalM3Day: new Array(days).fill(n),
		simulatedM3Day: new Array(days).fill(s),
		observedM3s: new Array(days).fill(oM3s),
		damsM3Day: new Array(days).fill(dams),
		landCoverM3Day: lc ? new Array(days).fill(lc) : [],
		excluded: new Uint8Array(days)
	};
}

describe('naturalisedCheck', () => {
	it('fails a year whose record + abstraction implies more natural flow than simulated, beyond 10 % (hand-worked)', () => {
		// N = 10 000, S = 6 000 m³/day, so A = 4 000: dams 1 000, land cover 500, use 2 500.
		// O = 0.08 m³/s = 6 912 m³/day: O + A = 10 912 > N by 912 m³/day; 10 % of O is 691.2 m³/day.
		const c = naturalisedCheck(year(10_000, 6_000, 0.08, 1_000, 500))!;
		const y = c.years[0]!;
		expect(y).toMatchObject({ waterYear: 2001, days: 365, judged: true, passed: false });
		expect(y.naturalMm3).toBeCloseTo(3.65, 12);
		expect(y.observedMm3).toBeCloseTo((6_912 * 365) / 1e6, 12);
		expect(y.abstractionMm3).toBeCloseTo(1.46, 12);
		expect(y.damsMm3).toBeCloseTo(0.365, 12);
		expect(y.landCoverMm3).toBeCloseTo(0.1825, 12);
		expect(y.useMm3).toBeCloseTo(0.9125, 12);
		expect(y.naturalisedMm3).toBeCloseTo((10_912 * 365) / 1e6, 12);
		expect(y.gapMm3).toBeCloseTo((912 * 365) / 1e6, 12);
		expect(y.gapPct).toBeCloseTo(9.12, 12);
		expect(y.toleranceMm3).toBeCloseTo((691.2 * 365) / 1e6, 12);
		expect(c).toMatchObject({ judgedYears: 1, failedYears: [2001], tolerance: 0.1 });
		expect(naturalisedWarning(c)).toMatch(/Natural flow below observed \+ abstraction in 1 of 1 water years \(2001\/02\).*3\.98 Mm³ implied against 3\.65 Mm³ simulated/);
	});

	it('passes a year inside the tolerance: O = 0.075 m³/s leaves a 480 m³/day gap against 648 allowed', () => {
		const c = naturalisedCheck(year(10_000, 6_000, 0.075))!;
		expect(c.years[0]!.passed).toBe(true);
		expect(c.failedYears).toEqual([]);
		expect(naturalisedWarning(c)).toBeNull();
	});

	it('a near-dry year is held to 1 % of the record\'s mean volume, not 10 % of its own', () => {
		// Year 1: 1 m³/s observed and simulated. Year 2: 0.0001 m³/s observed, model dry.
		const days = 730;
		const x = year(86_400, 86_400, 1, 0, 0, days);
		for (let t = 365; t < days; t++) {
			(x.observedM3s as (number | null)[])[t] = 0.0001;
			(x.simulatedM3Day as number[])[t] = 0;
			(x.naturalM3Day as number[])[t] = 0;
		}
		const c = naturalisedCheck(x)!;
		const dry = c.years[1]!;
		// Gap 8.64 m³/day; 10 % of O is 0.864, but 1 % of the mean (≈ 43 204 m³/day) is ≈ 432.
		expect(dry.gapMm3).toBeCloseTo((8.64 * 365) / 1e6, 12);
		expect(dry.toleranceMm3).toBeCloseTo((0.01 * ((86_400 + 8.64) / 2) * 365) / 1e6, 12);
		expect(dry.passed).toBe(true);
		expect(dry.gapPct).toBeNull(); // no natural flow to take a share of
	});

	it('does not judge a year with fewer than 300 observed days, and skips missing, negative and excluded days', () => {
		const x = year(10_000, 1_000, 0.1);
		const o = x.observedM3s as (number | null)[];
		for (let t = 0; t < 40; t++) o[t] = null;
		o[40] = -1;
		o[41] = NaN;
		for (let t = 42; t < 70; t++) x.excluded[t] = 1;
		const c = naturalisedCheck(x)!;
		expect(c.years[0]!.days).toBe(365 - 70);
		expect(365 - 70).toBeLessThan(NATURALISED_MIN_DAYS);
		expect(c.years[0]).toMatchObject({ judged: false, passed: null });
		expect(c.judgedYears).toBe(0);
		expect(naturalisedWarning(c)).toBeNull();
	});

	it('names every failing year and, as the worst, the one furthest beyond its own tolerance', () => {
		// Year 1: O = 1 m³/s, S = 0.8 (gap 20 % of O, twice the tolerance). Year 2: O = 0.1, S = 0.05 (gap 50 % of O).
		const days = 730;
		const x = year(86_400, 0.8 * 86_400, 1, 0, 0, days);
		for (let t = 365; t < days; t++) {
			(x.observedM3s as (number | null)[])[t] = 0.1;
			(x.simulatedM3Day as number[])[t] = 0.05 * 86_400;
		}
		const w = naturalisedWarning(naturalisedCheck(x)!)!;
		expect(w).toMatch(/in 2 of 2 water years \(2001\/02, 2002\/03\)/);
		expect(w).toMatch(/worst 2002\/03:/);
	});

	it('is null when no day has an observation', () => {
		expect(naturalisedCheck(year(1, 1, null))).toBeNull();
		expect(naturalisedWarning(null)).toBeNull();
	});
});
