// Observed vs modelled irrigation use (./compare.ts, docs/model.md §2.10o):
// dekad boundaries (the 21st to the month's end, February, leap years) under
// a skewed TZ, dekads the run covers only in part, a low valid share left
// out, the two comparisons and their bands, the seasons, and each source on
// its own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareEt, dekadSpan, ET_OBSERVED, seasonOf, totals, within, type EtObservationIn, type ModelledIn } from './compare.js';

const zone = process.env.TZ;
beforeAll(() => {
	// UTC+14 (CLAUDE.md rule 7): a local-time date would land on the next day.
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	process.env.TZ = zone;
});

const obs = (dekad: string, etaMmDay: number, extra: Partial<EtObservationIn> = {}): EtObservationIn => ({
	source: 'wapor',
	dekad,
	etaMmDay,
	validShare: 1,
	areaM2: 100_000,
	mask: 'cropland',
	...extra
});
/** A run of `days` days from `startDate`, each day's value constant. */
const run = (startDate: string, days: number, v: { gross: number; rain: number; F?: number; D?: number; G?: number }, extra: Partial<ModelledIn> = {}): ModelledIn => {
	const F = v.F ?? Math.max(0, v.gross - v.rain);
	const D = v.D ?? F / 0.8;
	const G = v.G ?? D;
	const fill = (x: number) => Array.from({ length: days }, () => x);
	return { startDate, grossDemand: fill(v.gross), effectiveRain: fill(v.rain), cropRequirement: fill(F), demand: fill(D), supplied: fill(G), ...extra };
};
const A = 100_000; // 10 ha

describe('dekadSpan', () => {
	it('gives 10, 10 and the rest of the month, under a skewed TZ', () => {
		expect(dekadSpan('2020-01-01')).toEqual({ end: '2020-01-10', days: 10 });
		expect(dekadSpan('2020-01-11')).toEqual({ end: '2020-01-20', days: 10 });
		expect(dekadSpan('2020-01-21')).toEqual({ end: '2020-01-31', days: 11 });
		expect(dekadSpan('2020-04-21')).toEqual({ end: '2020-04-30', days: 10 });
		expect(dekadSpan('2020-02-21')).toEqual({ end: '2020-02-29', days: 9 });
		expect(dekadSpan('2021-02-21')).toEqual({ end: '2021-02-28', days: 8 });
		expect(dekadSpan('2020-12-21')).toEqual({ end: '2020-12-31', days: 11 });
	});
	it('refuses a day that starts no dekad', () => {
		expect(() => dekadSpan('2020-01-05')).toThrow(RangeError);
	});
});

describe('seasonOf', () => {
	it('splits the water year at April: Oct–Mar is summer, Apr–Sep winter', () => {
		expect(seasonOf('2019-10-01')).toMatchObject({ waterYear: 2019, half: 'summer', label: 'Oct 2019 – Mar 2020' });
		expect(seasonOf('2020-03-21')).toMatchObject({ waterYear: 2019, half: 'summer' });
		expect(seasonOf('2020-04-01')).toMatchObject({ waterYear: 2019, half: 'winter', label: 'Apr 2020 – Sep 2020' });
		expect(seasonOf('2020-09-21')).toMatchObject({ waterYear: 2019, half: 'winter' });
	});
});

describe('within', () => {
	it('agrees within the share of the larger, or within the depth floor', () => {
		expect(within(100_000, 125_000, A, 10)).toBe(true); // 25 000 ≤ 0.25 × 125 000
		expect(within(100_000, 140_000, A, 10)).toBe(false);
		// Floor: 0.5 mm/day × 10 days × 10 ha = 500 m³.
		expect(within(100, 600, A, 10)).toBe(true);
		expect(within(100, 700, A, 10)).toBe(false);
	});
});

describe('compareEt', () => {
	it('puts ETa on the planted area and sums the run over the dekad’s days', () => {
		// 2020-01-21 is 11 days; 5 mm/day over 10 ha = 500 m³/day.
		const r = compareEt({ observations: [obs('2020-01-21', 5)], modelled: run('2020-01-01', 60, { gross: 600, rain: 100 }), plantedAreaM2: A });
		const p = r.sources[0]!.points[0]!;
		expect(p).toMatchObject({ dekad: '2020-01-21', end: '2020-01-31', days: 11, compared: true, skip: null });
		expect(p.observedEtM3).toBeCloseTo(5500, 9);
		// Fully supplied: the crop's ET as supplied (rain + e·G) is its whole requirement.
		expect(p.modelledEtM3).toBeCloseTo(6600, 9);
		expect(p.requirementM3).toBeCloseTo(6600, 9);
		expect(p.effectiveRainM3).toBeCloseTo(1100, 9);
		expect(p.observedIrrigationM3).toBeCloseTo(4400, 9);
		// F = 500, D = F / 0.8, G = D: the crop gets all of F.
		expect(p.modelledIrrigationM3).toBeCloseTo(5500, 9);
		expect(p.suppliedM3).toBeCloseTo((500 / 0.8) * 11, 9);
		expect(p.etWithin).toBe(true); // 1100 ≤ 0.25 × 6600
		expect(p.irrigationWithin).toBe(true);
	});

	it('gives the crop only e × G: a half-supplied day delivers half its requirement', () => {
		const m = run('2020-01-01', 30, { gross: 500, rain: 0, F: 500, D: 625, G: 312.5 });
		const p = compareEt({ observations: [obs('2020-01-01', 5)], modelled: m, plantedAreaM2: A }).sources[0]!.points[0]!;
		expect(p.modelledIrrigationM3).toBeCloseTo(2500, 9);
		expect(p.observedIrrigationM3).toBeCloseTo(5000, 9);
		// The crop ET the run supplied, not the requirement: a dry dam isn't a crop-factor error.
		expect(p.modelledEtM3).toBeCloseTo(2500, 9);
		expect(p.requirementM3).toBeCloseTo(5000, 9);
		expect(p.irrigationWithin).toBe(false);
	});

	it('counts a negative gross (a bad crop factor) as no requirement, as the engine does', () => {
		const m = run('2020-01-01', 30, { gross: -50, rain: 0, F: 0, D: 0, G: 0 });
		const p = compareEt({ observations: [obs('2020-01-01', 1)], modelled: m, plantedAreaM2: A }).sources[0]!.points[0]!;
		expect(p.requirementM3).toBe(0);
		expect(p.modelledEtM3).toBe(0);
	});

	it('says a run without the columns (an older engine) needs running again', () => {
		const p = compareEt({ observations: [obs('2020-01-01', 5)], modelled: null, plantedAreaM2: null, seriesMissing: true }).sources[0]!.points[0]!;
		expect(p.skip).toBe('no-series');
	});

	it('takes the demand objects off before the share', () => {
		// D = 625 irrigation + 100 objects; G = 625 + 100: irrigation fully supplied.
		const m = run('2020-01-01', 30, { gross: 500, rain: 0, F: 500, D: 725, G: 725 }, { objectDemand: Array(30).fill(100), objectSupplied: Array(30).fill(100) });
		const p = compareEt({ observations: [obs('2020-01-01', 5)], modelled: m, plantedAreaM2: A }).sources[0]!.points[0]!;
		expect(p.modelledIrrigationM3).toBeCloseTo(5000, 9);
		expect(p.suppliedM3).toBeCloseTo(6250, 9);
	});

	it('never lets observed irrigation go below zero when the rain covered more than the ET', () => {
		const p = compareEt({ observations: [obs('2020-01-01', 1)], modelled: run('2020-01-01', 30, { gross: 300, rain: 300 }), plantedAreaM2: A }).sources[0]!.points[0]!;
		expect(p.observedIrrigationM3).toBe(0);
		expect(p.modelledIrrigationM3).toBe(0);
		expect(p.irrigationWithin).toBe(true);
	});

	it('leaves out a dekad under the valid share, and says so', () => {
		const r = compareEt({
			observations: [obs('2020-01-01', 5, { validShare: ET_OBSERVED.minValidShare - 0.01 }), obs('2020-01-11', 5, { validShare: ET_OBSERVED.minValidShare })],
			modelled: run('2020-01-01', 60, { gross: 500, rain: 0 }),
			plantedAreaM2: A
		});
		const [a, b] = r.sources[0]!.points;
		expect(a).toMatchObject({ compared: false, skip: 'partly-seen', etWithin: null });
		expect(b).toMatchObject({ compared: true });
		expect(r.sources[0]!.summary).toMatchObject({ compared: 1, skipped: 1 });
	});

	it('compares only dekads the run covers whole: a run starting or ending inside one, or its forecast, makes it partial', () => {
		// The run: 2020-01-05 … 2020-02-14 (41 days).
		const m = run('2020-01-05', 41, { gross: 500, rain: 0 });
		const r = compareEt({
			observations: ['2019-12-21', '2020-01-01', '2020-01-11', '2020-01-21', '2020-02-01', '2020-02-11', '2020-02-21'].map((d) => obs(d, 5)),
			modelled: m,
			plantedAreaM2: A
		});
		expect(r.sources[0]!.points.map((p) => [p.dekad, p.skip])).toEqual([
			['2019-12-21', 'outside-run'],
			['2020-01-01', 'partial-dekad'],
			['2020-01-11', null],
			['2020-01-21', null],
			['2020-02-01', null],
			['2020-02-11', 'partial-dekad'],
			['2020-02-21', 'outside-run']
		]);
		// The forecast from 2020-01-25: the third dekad is partly forecast, February all of it.
		const f = compareEt({ observations: ['2020-01-11', '2020-01-21', '2020-02-01'].map((d) => obs(d, 5)), modelled: m, plantedAreaM2: A, forecastFrom: '2020-01-25' });
		expect(f.sources[0]!.points.map((p) => p.skip)).toEqual([null, 'partial-dekad', 'outside-run']);
	});

	it('takes the last day of a dekad ending the run, and not the day after', () => {
		// Exactly 2020-01-11 … 2020-01-20.
		const m = run('2020-01-11', 10, { gross: 500, rain: 0 });
		expect(compareEt({ observations: [obs('2020-01-11', 5)], modelled: m, plantedAreaM2: A }).sources[0]!.points[0]!.compared).toBe(true);
		const short = run('2020-01-11', 9, { gross: 500, rain: 0 });
		expect(compareEt({ observations: [obs('2020-01-11', 5)], modelled: short, plantedAreaM2: A }).sources[0]!.points[0]!.skip).toBe('partial-dekad');
	});

	it('treats a missing day in the run as a partial dekad', () => {
		const m = run('2020-01-01', 30, { gross: 500, rain: 0 });
		(m.grossDemand as (number | null)[])[3] = null;
		const r = compareEt({ observations: [obs('2020-01-01', 5), obs('2020-01-11', 5)], modelled: m, plantedAreaM2: A });
		expect(r.sources[0]!.points.map((p) => p.skip)).toEqual(['partial-dekad', null]);
	});

	it('lists the observations without a run or a planted area, compared with nothing', () => {
		const none = compareEt({ observations: [obs('2020-01-01', 5)], modelled: null, plantedAreaM2: null });
		expect(none.sources[0]!.points[0]).toMatchObject({ compared: false, skip: 'no-run', observedEtM3: null, modelledEtM3: null });
		expect(none.sources[0]!.summary).toMatchObject({ compared: 0, etBiasPct: null, etWithinShare: null });
		const bare = compareEt({ observations: [obs('2020-01-01', 5)], modelled: run('2020-01-01', 30, { gross: 0, rain: 0 }), plantedAreaM2: 0 });
		expect(bare.sources[0]!.points[0]).toMatchObject({ skip: 'no-area', observedEtM3: null });
		expect(bare.sources[0]!.area).toMatchObject({ ratioToPlanted: null, differs: false });
	});

	it('returns no source without observations', () => {
		expect(compareEt({ observations: [], modelled: run('2020-01-01', 30, { gross: 1, rain: 0 }), plantedAreaM2: A }).sources).toEqual([]);
	});

	it('compares each source on its own, WaPOR first, oldest first', () => {
		const r = compareEt({
			observations: [obs('2020-01-11', 4, { source: 'ssebop' }), obs('2020-01-11', 5), obs('2020-01-01', 5)],
			modelled: run('2020-01-01', 60, { gross: 500, rain: 0 }),
			plantedAreaM2: A
		});
		expect(r.sources.map((s) => [s.source, s.points.map((p) => p.dekad)])).toEqual([
			['wapor', ['2020-01-01', '2020-01-11']],
			['ssebop', ['2020-01-11']]
		]);
	});

	it('gives the bias as modelled over observed (+ the model uses more) and the share within the band', () => {
		// Modelled 600 m³/day, observed 4 then 6 mm/day over 10 ha (400, 600 m³/day).
		const r = compareEt({ observations: [obs('2020-01-01', 4), obs('2020-01-11', 6)], modelled: run('2020-01-01', 30, { gross: 600, rain: 0 }), plantedAreaM2: A });
		const s = r.sources[0]!.summary;
		expect(s.observedEtM3).toBeCloseTo(10_000, 9);
		expect(s.modelledEtM3).toBeCloseTo(12_000, 9);
		expect(s.etBiasPct).toBeCloseTo(20, 9);
		// 4000 vs 6000: 2000 > 0.25 × 6000 and > the 500 m³ floor; 6000 vs 6000 agrees.
		expect(s.etWithinShare).toBe(0.5);
	});

	it('groups the dekads into half water years, oldest first', () => {
		const days = 400;
		const r = compareEt({
			observations: ['2019-09-21', '2019-10-01', '2020-03-21', '2020-04-01'].map((d) => obs(d, 5)),
			modelled: run('2019-09-01', days, { gross: 500, rain: 0 }),
			plantedAreaM2: A
		});
		expect(r.sources[0]!.seasons.map((s) => [s.label, s.compared])).toEqual([
			['Apr 2019 – Sep 2019', 1],
			['Oct 2019 – Mar 2020', 2],
			['Apr 2020 – Sep 2020', 1]
		]);
	});

	it('flags an observed area far from the planted area, either way', () => {
		const m = run('2020-01-01', 30, { gross: 500, rain: 0 });
		const big = compareEt({ observations: [obs('2020-01-01', 5, { areaM2: 160_000 })], modelled: m, plantedAreaM2: A }).sources[0]!.area!;
		expect(big).toMatchObject({ areaM2: 160_000, mask: 'cropland', differs: true });
		expect(big.ratioToPlanted).toBeCloseTo(1.6, 12);
		expect(compareEt({ observations: [obs('2020-01-01', 5, { areaM2: 60_000 })], modelled: m, plantedAreaM2: A }).sources[0]!.area!.differs).toBe(true);
		expect(compareEt({ observations: [obs('2020-01-01', 5, { areaM2: 140_000 })], modelled: m, plantedAreaM2: A }).sources[0]!.area!.differs).toBe(false);
	});

	it('totals nothing to null', () => {
		expect(totals([])).toMatchObject({ compared: 0, skipped: 0, etBiasPct: null, irrigationBiasPct: null, etWithinShare: null });
	});
});
