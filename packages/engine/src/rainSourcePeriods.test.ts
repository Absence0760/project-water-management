// Per-period forcing source (settings.rainSource, engine ≥ 0.30.0, issue #40
// (b) and its amendments, docs/model.md §2.4e). Every record here is
// synthetic: a "true" catchment rain at 2 × CHIRPS, a primary catchment
// series that reads it until water year 2004 and then stops representing the
// catchment, an alternative gauge that reads 20 % low from 2005, and a
// gauge-free reanalysis at 0.8 × CHIRPS.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { compareRuns, diffInputs } from './compare';
import { defaultProjectSettings, type DailySeries, type ModelInput, type RainSourcePeriod, type SeriesKind } from './project';
import {
	RAIN_SOURCE_CODE,
	rainSourceError,
	rainSourceLines,
	rainSourcePeriodError,
	rainSourceText,
	resolveRainSource
} from './rainSourcePeriods';
import { rainVsChirps } from './quality';
import { runModel } from './run';
import { prepareRun } from './prepare';

type Series = Partial<Record<SeriesKind, DailySeries>>;

const FIRST_WY = 1990;
const LAST_WY = 2009;
const S = `${FIRST_WY}-10-01`;
const d0 = toEpochDay(S);
const DAYS = toEpochDay(`${LAST_WY + 1}-10-01`) - d0;
/** CHIRPS on every third day, mm, by calendar month (a winter-rainfall shape). */
const BASE = [0, 2, 2, 4, 6, 10, 12, 12, 10, 6, 4, 3, 2];
const wyOf = (i: number) => Number(fromEpochDay(d0 + i).slice(0, 4)) - (monthOfEpochDay(d0 + i) >= 10 ? 0 : 1);
const idx = (iso: string) => toEpochDay(iso) - d0;
const PERIOD = { start: '2005-10-01', end: '2010-09-30' };

function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** The synthetic records. `primaryLate`: what the primary series reads × CHIRPS from 2005/06 on. */
function build(primaryLate = 0.9) {
	const rnd = lcg(7);
	const h: (number | null)[] = [];
	const c: (number | null)[] = [];
	const e: (number | null)[] = [];
	const a: (number | null)[] = [];
	for (let i = 0; i < DAYS; i++) {
		const wet = 0.7 + 0.6 * rnd();
		const v = i % 3 === 0 ? BASE[monthOfEpochDay(d0 + i)]! * wet : 0;
		const late = wyOf(i) >= 2005;
		h.push(v);
		// ±2 % day-to-day noise on the gauges.
		c.push(v * (late ? primaryLate : 2) * (1 + 0.04 * (rnd() - 0.5)));
		e.push(v * 0.8);
		a.push(late ? v * 1.6 * (1 + 0.04 * (rnd() - 0.5)) : null);
	}
	return { h, c, e, a };
}
const toSeries = (r: ReturnType<typeof build>, kinds: SeriesKind[] = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_reanalysis_mm', 'rain_catchment_alt_mm']): Series => {
	const all: Record<string, (number | null)[]> = { rain_catchment_mm: r.c, rain_chirps_mm: r.h, rain_reanalysis_mm: r.e, rain_catchment_alt_mm: r.a };
	const out: Series = {};
	for (const k of kinds) out[k] = { startDate: S, values: all[k]! };
	return out;
};
const input = (series: Series, rainSource?: unknown): ModelInput => ({
	settings: {
		apanMm: new Array(12).fill(150) as unknown as Monthly,
		calibration: { ...defaultProjectSettings().calibration, catchmentAreaKm2: 10 },
		...(rainSource !== undefined ? { rainSource } : {})
	} as ModelInput['settings'],
	model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
	series
});

const FIXED: RainSourcePeriod = {
	...PERIOD,
	series: 'rain_catchment_alt_mm',
	factors: new Array(12).fill(1.25),
	provenance: { source: 'hydrologist, issue #12 study', fittedFrom: '1995-10-01', fittedTo: '2005-09-30', method: 'catchment ÷ ERA5 over the reference era' },
	reason: 'automatic station replaces the gauge average'
};
const FIT: RainSourcePeriod = {
	...PERIOD,
	series: 'rain_catchment_alt_mm',
	factors: 'fit',
	fitReference: { series: 'rain_reanalysis_mm', fromWaterYear: 1995, toWaterYear: 2004 },
	reason: 'automatic station replaces the gauge average'
};

describe('settings.rainSource: rain from another series over a period', () => {
	it('uses the alternative × the monthly factor on every day it has a value, CHIRPS × the fit-period factors on its gaps, and marks each day', () => {
		// The primary reads 0.9 × CHIRPS from 2005/06, far below its usual 2 ×: only the replaced days, not whole water years, leave the fit.
		const r = build(0.9);
		// Gaps in the alternative gauge: every day of June 2007 and the first ten days of 2009.
		for (let i = idx('2007-06-01'); i <= idx('2007-06-30'); i++) r.a[i] = null;
		for (let i = idx('2009-01-01'); i <= idx('2009-01-10'); i++) r.a[i] = null;
		const run = prepareRun(input(toSeries(r), [FIXED]));
		const catchment = run.aligned('rain_catchment_mm');
		const chirps = run.aligned('rain_chirps_mm');
		const col = run.rainSource!.column;
		const corr = run.chirpsCorrection!;
		let alt = 0;
		let gaps = 0;
		for (let t = 0; t < run.days; t++) {
			const i = run.start + t - d0;
			if (i < idx(PERIOD.start)) {
				// Before the period: the primary series as recorded.
				expect(catchment[t]).toBe(r.c[i]);
				expect(col[t]).toBe(RAIN_SOURCE_CODE.catchment);
				continue;
			}
			if (r.a[i] != null) {
				alt++;
				expect(catchment[t]).toBeCloseTo(r.a[i]! * 1.25, 12);
				expect(col[t]).toBe(RAIN_SOURCE_CODE.series);
			} else {
				gaps++;
				expect(catchment[t]).toBeNull();
				// The whole-record CHIRPS factor for the month: the primary's 2 × over 1990–2004 only.
				const f = corr.months[monthOfEpochDay(d0 + i) - 1]!.factor!;
				expect(chirps[t]).toBeCloseTo(r.h[i]! * f, 12);
				expect(col[t]).toBe(RAIN_SOURCE_CODE.chirps);
			}
		}
		expect(alt).toBeGreaterThan(1500);
		expect(gaps).toBe(40);
		// The replaced primary days (0.9 × CHIRPS) never reach the CHIRPS fit: every factor is the early era's 2.
		for (const m of corr.months) expect(m.factor! / 2).toBeCloseTo(1, 2);
		expect(corr.replacedDaysLeftOut).toBeGreaterThan(0);
		// Judged without the replaced days, no water year is far below CHIRPS (the data checks still flag the recorded ones).
		expect(corr.lowVsChirpsYears).toEqual([]);
		expect(rainVsChirps(toSeries(r))!.flaggedYears).toEqual([2005, 2006, 2007, 2008, 2009]);
		const info = run.rainSource!.info.periods[0]!;
		expect(info).toMatchObject({ factorMode: 'fixed', seriesDays: alt, chirpsDays: 40, forecastDays: 0, noneDays: 0, fallback: 'chirps', provenance: FIXED.provenance });
		expect(info.factors).toEqual(new Array(12).fill(1.25));
	});

	it('writes the per-day rain_source column and the summary into a run, and warns with the period’s reason and factors', () => {
		const out = runModel(input(toSeries(build()), [FIXED]));
		const col = out.series.find((s) => s.key === 'rain_source')!;
		expect(col.values[0]).toBe(RAIN_SOURCE_CODE.catchment);
		expect(col.values.at(-1)).toBe(RAIN_SOURCE_CODE.series);
		expect(out.summary.rainSource!.periods).toHaveLength(1);
		const w = out.summary.warnings.find((x) => x.startsWith('Catchment rain from the alternative catchment gauge over 2005-10-01 to 2010-09-30'))!;
		expect(w).toContain('(automatic station replaces the gauge average)');
		expect(w).toContain('fixed, from hydrologist, issue #12 study, fitted on 1995-10-01 to 2005-09-30 by catchment ÷ ERA5 over the reference era');
		expect(w).toContain('Oct 1.25');
		// Without periods: no column, and summary.rainSource is null.
		const plain = runModel(input(toSeries(build())));
		expect(plain.series.some((s) => s.key === 'rain_source')).toBe(false);
		expect(plain.summary.rainSource).toBeNull();
	});

	it("'fit' measures the series against a gauge-free reference over the reference era (within 2 %), and records both windows", () => {
		const run = prepareRun(input(toSeries(build()), [FIT]));
		const p = run.rainSource!.info.periods[0]!;
		// (catchment ÷ reanalysis = 2 / 0.8) ÷ (alternative ÷ reanalysis = 1.6 / 0.8) = 1.25: the alternative lands at the primary's level.
		for (const f of p.factors) expect(f! / 1.25).toBeCloseTo(1, 1);
		for (const f of p.factors) expect(Math.abs(f! / 1.25 - 1)).toBeLessThan(0.02);
		expect(p.fit!.referenceWindow).toEqual({ fromWaterYear: 1995, toWaterYear: 2004 });
		expect(p.fit!.periodWindow).toEqual({ fromWaterYear: 2005, toWaterYear: 2009 });
		expect(p.fit!.reference).toEqual(FIT.fitReference);
		// Positive control: the era matters. A reference era ending in the bad years isn't possible (they're replaced), but a
		// series reading 10 % lower gets a 10 % bigger factor.
		const low = build();
		for (let i = 0; i < low.a.length; i++) if (low.a[i] != null) low.a[i] = low.a[i]! * 0.9;
		const q = prepareRun(input(toSeries(low), [FIT])).rainSource!.info.periods[0]!;
		expect(q.factors[0]! / p.factors[0]!).toBeCloseTo(1 / 0.9, 6);
	});

	it('leaves the replaced primary days out of the fit’s catchment ratio, whatever they read', () => {
		// Reference era overlapping the period: the period's own primary days (here 10 × CHIRPS) are left out.
		const era = { ...FIT, fitReference: { series: 'rain_reanalysis_mm' as const, fromWaterYear: 1995, toWaterYear: 2009 } };
		const tame = prepareRun(input(toSeries(build(0.9)), [era])).rainSource!.info.periods[0]!;
		const wild = prepareRun(input(toSeries(build(10)), [era])).rainSource!.info.periods[0]!;
		expect(wild.factors).toEqual(tame.factors);
		expect(wild.fit!.referenceWindow).toEqual({ fromWaterYear: 1995, toWaterYear: 2004 });
	});

	it('falls through to a named reanalysis fallback × its reference-era factors, never to CHIRPS', () => {
		const r = build();
		for (let i = idx('2007-06-01'); i <= idx('2007-06-30'); i++) r.a[i] = null;
		// And one day the reanalysis lacks too: it falls to forecast rain (none here), not CHIRPS.
		r.e[idx('2007-06-10')] = null;
		const period = { ...FIXED, fallback: { series: 'rain_reanalysis_mm' as const, fromWaterYear: 1990, toWaterYear: 2004 } };
		const run = prepareRun(input(toSeries(r), [period]));
		const catchment = run.aligned('rain_catchment_mm');
		const chirps = run.aligned('rain_chirps_mm');
		const col = run.rainSource!.column;
		const p = run.rainSource!.info.periods[0]!;
		const fb = p.fallback as Exclude<typeof p.fallback, 'chirps'>;
		// Catchment ÷ reanalysis = 2 / 0.8 = 2.5 over the reference era.
		for (const f of fb.factors) expect(f! / 2.5).toBeCloseTo(1, 2);
		for (let i = idx('2007-06-01'); i <= idx('2007-06-30'); i++) {
			const t = i + d0 - run.start;
			expect(chirps[t]).toBeNull();
			if (i === idx('2007-06-10')) {
				expect(catchment[t]).toBeNull();
				expect(Number.isNaN(col[t]!)).toBe(true);
			} else {
				expect(catchment[t]).toBeCloseTo(r.e[i]! * fb.factors[5]!, 12);
				expect(col[t]).toBe(RAIN_SOURCE_CODE.reanalysis);
			}
		}
		expect(p).toMatchObject({ reanalysisDays: 29, chirpsDays: 0, noneDays: 1 });
	});

	it('takes no reading from a flagged zero run or a missing period inside the period: the series gives its rain', () => {
		const r = build();
		// 90 zero days of the primary in the wet season of 2007, a missing period across the period's start.
		for (let i = idx('2007-05-01'); i < idx('2007-05-01') + 90; i++) r.c[i] = 0;
		const s = toSeries(r);
		const zeroRainRuns = { ...defaultProjectSettings().zeroRainRuns, missing: [{ start: '2005-09-01', end: '2005-10-31', reason: 'logger gap' }] };
		const run = prepareRun({ ...input(s, [FIXED]), settings: { ...input(s, [FIXED]).settings, zeroRainRuns } });
		const z = run.zeroRain!.infill;
		expect(z.periods.every((p) => p.source === 'listed')).toBe(true);
		// Only the missing period's September days, before the rain-source period.
		expect(z.days).toBe(30);
		const catchment = run.aligned('rain_catchment_mm');
		const t = idx('2007-06-01') + d0 - run.start;
		expect(catchment[t]).toBeCloseTo(r.a[idx('2007-06-01')]! * 1.25, 12);
	});

	it('extends the run window to the alternative series’ last day inside a period', () => {
		const r = build();
		// The primary and CHIRPS stop at 2008-09-30; the alternative runs on.
		const cut = idx('2008-10-01');
		const s = toSeries(r);
		s.rain_catchment_mm = { startDate: S, values: r.c.slice(0, cut) };
		s.rain_chirps_mm = { startDate: S, values: r.h.slice(0, cut) };
		s.rain_reanalysis_mm = { startDate: S, values: r.e.slice(0, cut) };
		expect(prepareRun(input(s)).end).toBe(d0 + cut - 1);
		expect(prepareRun(input(s, [FIXED])).end).toBe(toEpochDay('2010-09-30'));
		// A period ending earlier clips it.
		expect(prepareRun(input(s, [{ ...FIXED, end: '2009-06-30' }])).end).toBe(toEpochDay('2009-06-30'));
	});

	it('warns and falls through on every day when the project has no such series', () => {
		const out = runModel(input(toSeries(build(), ['rain_catchment_mm', 'rain_chirps_mm']), [FIXED]));
		expect(out.summary.warnings).toContainEqual(expect.stringMatching(/the project has no rain_catchment_alt_mm series, so all 1826 run days fall through to CHIRPS × the CHIRPS fit-period factors/));
		expect(out.summary.rainSource!.periods[0]).toMatchObject({ seriesPresent: false, seriesDays: 0, chirpsDays: 1826 });
	});

	it('gives the same factors and codes at UTC+14 and UTC−11 (date arithmetic is UTC)', () => {
		const tz = process.env.TZ;
		const fit = () => {
			const run = prepareRun(input(toSeries(build()), [FIT]));
			return JSON.stringify([run.rainSource!.info, Array.from(run.rainSource!.column.slice(-400))]);
		};
		try {
			process.env.TZ = 'Pacific/Kiritimati';
			const east = fit();
			process.env.TZ = 'Pacific/Pago_Pago';
			expect(fit()).toBe(east);
		} finally {
			process.env.TZ = tz;
		}
	});
});

describe('resolveRainSource and rainSourcePeriodError (the API schema’s twin)', () => {
	it('keeps valid periods, sorted and trimmed', () => {
		const w: string[] = [];
		const later = { ...FIXED, start: '2011-01-01', end: '2011-12-31', reason: '  later  ' };
		expect(resolveRainSource([later, FIT], w)).toEqual([FIT, { ...later, reason: 'later' }]);
		expect(w).toEqual([]);
		expect(resolveRainSource(undefined, w)).toEqual([]);
	});

	it('drops invalid and overlapping periods with a warning', () => {
		const bad: [unknown, RegExp][] = [
			[{ ...FIXED, reason: ' ' }, /needs a reason/],
			[{ ...FIXED, start: '2010-01-01', end: '2009-01-01' }, /ends before it starts/],
			[{ ...FIXED, series: 'rain_chirps_mm' }, /series must be one of rain_catchment_alt_mm/],
			[{ ...FIXED, factors: new Array(11).fill(1) }, /12 monthly values/],
			[{ ...FIXED, factors: [...new Array(11).fill(1), 5] }, /from 0.25 to 4/],
			[{ ...FIXED, provenance: undefined }, /need their provenance/],
			[{ ...FIXED, provenance: { ...FIXED.provenance!, fittedTo: '1990-01-01' } }, /fitted on/],
			[{ ...FIT, fitReference: undefined }, /needs a fitReference/],
			[{ ...FIT, provenance: FIXED.provenance }, /provenance is for fixed factors/],
			[{ ...FIT, fitReference: { series: 'rain_catchment_alt_mm', fromWaterYear: 1995, toWaterYear: 2004 } }, /fitReference series must be one of/],
			[{ ...FIXED, fitReference: FIT.fitReference }, /only for factors: 'fit'/],
			[{ ...FIXED, extra: 1 }, /unknown field extra/],
			[{ ...FIXED, fallback: { series: 'rain_chirps_mm', fromWaterYear: 1990, toWaterYear: 2004 } }, /fallback series must be one of rain_reanalysis_mm/]
		];
		for (const [p, re] of bad) {
			const w: string[] = [];
			expect(resolveRainSource([p], w)).toEqual([]);
			expect(w[0]).toMatch(re);
			expect(rainSourcePeriodError(p)).toMatch(re);
		}
		const w: string[] = [];
		expect(resolveRainSource([FIXED, { ...FIT, start: '2009-01-01', end: '2012-01-01' }], w)).toEqual([FIXED]);
		expect(w[0]).toMatch(/overlaps 2005-10-01 to 2010-09-30; ignored/);
		expect(rainSourceError([FIXED, { ...FIT, start: '2009-01-01', end: '2012-01-01' }])).toBe('Rain-source period 2 overlaps period 1');
		expect(rainSourceError([FIXED, FIT].map((p, i) => ({ ...p, start: `${2000 + i}-01-01`, end: `${2000 + i}-06-30` })))).toBeNull();
	});

	it("refuses CHIRPS as the fit reference, or as the fallback, when the period's gauge is in CHIRPS", () => {
		const viaChirps = { ...FIT, fitReference: { series: 'rain_chirps_mm' as const, fromWaterYear: 1995, toWaterYear: 2004 } };
		// Positive control: CHIRPS is a valid reference while the gauge isn't in it.
		expect(rainSourcePeriodError(viaChirps)).toBeNull();
		const fallback = { series: 'rain_reanalysis_mm' as const, fromWaterYear: 1995, toWaterYear: 2004 };
		expect(rainSourcePeriodError({ ...viaChirps, gaugeInChirps: true, fallback })).toMatch(/can't fit against CHIRPS: the period says CHIRPS ingests its gauge/);
		// Its gaps can't fall to CHIRPS either: a fallback must be named.
		expect(rainSourcePeriodError({ ...FIT, gaugeInChirps: true })).toMatch(/need a fallback that isn’t CHIRPS/);
		expect(rainSourcePeriodError({ ...FIT, gaugeInChirps: true, fallback })).toBeNull();
	});

	it('reaches a run through its settings, with the warning', () => {
		const out = runModel(input(toSeries(build()), [{ ...FIXED, reason: '' }]));
		expect(out.summary.warnings).toContainEqual(expect.stringMatching(/^rain-source period 2005-10-01 to 2010-09-30 needs a reason/));
		expect(out.summary.rainSource).toBeNull();
	});
});

describe('run comparison and words', () => {
	it('lists a change of periods among the settings, and sets each run’s periods, factors and reference windows side by side', () => {
		const s = toSeries(build());
		const run = (rainSource: RainSourcePeriod[]) => {
			const i = input(s, rainSource);
			const output = runModel(i);
			return { settings: i.settings, output };
		};
		const a = run([FIXED]);
		const b = run([{ ...FIT, fitReference: { ...FIT.fitReference!, fromWaterYear: 1992 } }]);
		const cmp = (x: typeof a, y: typeof a) => compareRuns({ ...x.output, label: 'A' }, { ...y.output, label: 'B' });
		const diff = cmp(a, b);
		expect(diff.rainSource!.changed).toBe(true);
		expect(diff.rainSource!.periodsA[0]).toMatch(/^2005-10-01 to 2010-09-30 \(automatic station replaces the gauge average\): alternative catchment gauge × Oct 1.25/);
		expect(diff.rainSource!.periodsB[0]).toContain('reference era 1992/93–2004/05');
		const snap = (x: typeof a) => ({ settings: x.settings, model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: {} }) as never;
		const change = diffInputs(snap(a), snap(b)).find((c) => c.subject === 'Rain-source periods')!;
		expect(change.text).toMatch(/^Rain-source periods: 2005-10-01 to 2010-09-30: alternative catchment gauge, fixed factors 1.25\/1.25/);
		// Positive control: the same run compares unchanged.
		expect(cmp(a, a).rainSource!.changed).toBe(false);
		expect(diffInputs(snap(a), snap(a))).toEqual([]);
		// A run saved before 0.30.0 had no periods: it compares as none.
		const { rainSource: _r, ...pre } = a.settings as Record<string, unknown>;
		const none = run([]);
		expect(diffInputs({ ...(snap(none) as object), settings: pre } as never, snap(none))).toEqual([]);
		expect(cmp(none, none).rainSource).toBeNull();
		expect(rainSourceLines(null)).toEqual([]);
		// The series' product label (032_series_provenance) is part of the line: another station product is another forcing.
		const labelled = toSeries(build());
		labelled.rain_catchment_alt_mm = { ...labelled.rain_catchment_alt_mm!, provenance: { product: 'SASSCAL AWS', version: '1' } };
		const info = runModel(input(labelled, [FIXED])).summary.rainSource!;
		expect(info.periods[0]!.seriesProvenance).toEqual({ product: 'SASSCAL AWS', version: '1' });
		expect(rainSourceLines(info)[0]).toContain('alternative catchment gauge (SASSCAL AWS v1) × Oct 1.25');
		expect(rainSourceText([])).toBe('none (the catchment series throughout)');
	});
});
