// CHIRPS fit period / per-range factors (engine ≥ 0.29.0, issue #40 (a) and
// its amendments, docs/model.md §2.4b). Every record here is synthetic: a
// catchment series at a known ratio to CHIRPS that steps at a known water year.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { doubleMass, doubleMassCheck, doubleMassRunWarning, proposeChirpsFitRanges } from './doublemass';
import { defaultProjectSettings, type ChirpsFitPeriod, type RainSourcePeriod, type ChirpsFitRange, type DailySeries, type ModelInput, type SeriesKind, type ZeroRainSettings } from './project';
import {
	chirpsBiasFactors,
	chirpsCorrectionWarning,
	chirpsFactorOn,
	chirpsFactorSets,
	chirpsFitSegmentFor,
	CHIRPS_FACTOR_MAX,
	fitWindowLabels,
	resolveChirpsFitPeriod
} from './rain';
import { runModel } from './run';
import { prepareRun } from './prepare';

type Series = Partial<Record<SeriesKind, DailySeries>>;

const FIRST_WY = 1990;
const S = `${FIRST_WY}-10-01`;
const d0 = toEpochDay(S);
/** CHIRPS rain on every third day, mm, by calendar month (a winter-rainfall shape). */
const BASE = [0, 2, 2, 4, 6, 10, 12, 12, 10, 6, 4, 3, 2];
const repeat = (v: number, n: number) => new Array<number>(n).fill(v);
const wyOf = (i: number) => Number(fromEpochDay(d0 + i).slice(0, 4)) - (monthOfEpochDay(d0 + i) >= 10 ? 0 : 1);
const dayOf = (iso: string) => toEpochDay(iso) - d0;
const range = (fromWaterYear: number, toWaterYear: number, reason = 'station history'): ChirpsFitRange => ({ fromWaterYear, toWaterYear, reason });

/** A small deterministic generator (LCG), so every run sees the same "noise". */
function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/**
 * `ratios[k]` for water year FIRST_WY + k: CHIRPS with a year-to-year wetness
 * factor, catchment rain ratios[k] × CHIRPS with ±1 % noise per year.
 */
function build(ratios: number[], seed = 11) {
	const rnd = lcg(seed);
	const days = toEpochDay(`${FIRST_WY + ratios.length}-10-01`) - d0;
	const wet = ratios.map(() => 0.7 + 0.6 * rnd());
	const noise = ratios.map(() => 1 + 0.02 * (rnd() - 0.5));
	const h: (number | null)[] = [];
	const c: (number | null)[] = [];
	for (let i = 0; i < days; i++) {
		const k = wyOf(i) - FIRST_WY;
		const v = i % 3 === 0 ? BASE[monthOfEpochDay(d0 + i)]! * wet[k]! : 0;
		h.push(v);
		c.push(v * ratios[k]! * noise[k]!);
	}
	return { c, h, days };
}
const series = (c: (number | null)[], h: (number | null)[]): Series => ({
	rain_catchment_mm: { startDate: S, values: c },
	rain_chirps_mm: { startDate: S, values: h }
});
/** Blank the catchment rain over whole water years, so CHIRPS fills them. */
function blank(c: (number | null)[], ...years: number[]) {
	for (let i = 0; i < c.length; i++) if (years.includes(wyOf(i))) c[i] = null;
}
const input = (s: Series, chirpsFitPeriod?: ChirpsFitPeriod, zeroRainRuns?: ZeroRainSettings): ModelInput => ({
	settings: {
		apanMm: repeat(150, 12) as unknown as Monthly,
		calibration: { ...defaultProjectSettings().calibration, catchmentAreaKm2: 10 },
		...(chirpsFitPeriod !== undefined ? { chirpsFitPeriod } : {}),
		...(zeroRainRuns ? { zeroRainRuns } : {})
	},
	model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
	series: s
});
/** Rain CHIRPS filled into water year `wy`, over the raw CHIRPS there: the factor the fill used. */
function fillRatio(s: Series, wy: number, period?: ChirpsFitPeriod) {
	const run = prepareRun(input(s, period));
	const used = run.aligned('rain_chirps_mm');
	const catchment = run.aligned('rain_catchment_mm');
	const raw = s.rain_chirps_mm!.values;
	let a = 0;
	let b = 0;
	for (let t = 0; t < run.days; t++) {
		if (wyOf(run.start + t - d0) !== wy || catchment[t] != null) continue;
		a += used[t] ?? 0;
		b += raw[run.start + t - d0] ?? 0;
	}
	return { ratio: a / b, run };
}

/** A step from 2.0 to 1.2 × CHIRPS after water year 1999 (20 years). */
const STEP = [...repeat(2, 10), ...repeat(1.2, 10)];
/** The step's two eras as listed ranges. */
const ERAS: ChirpsFitPeriod = [range(1990, 1999, 'old gauge network'), range(2000, 2009, 'new gauge network')];

describe('chirpsFitPeriod: listed water-year ranges', () => {
	it('fills a gap in the later era with that era’s factors (within 2 %); the whole-record fit uses the blend', () => {
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const seg = fillRatio(s, 2006, ERAS);
		expect(seg.ratio / 1.2).toBeGreaterThan(0.98);
		expect(seg.ratio / 1.2).toBeLessThan(1.02);
		const fp = seg.run.chirpsCorrection!.fitPeriod!;
		expect(fp.period).toBe('ranges');
		expect(fp.segments.map((x) => [x.fromWaterYear, x.toWaterYear, x.fillFrom, x.fillTo, x.reason])).toEqual([
			[1990, 1999, null, 1999, 'old gauge network'],
			[2000, 2009, 2000, null, 'new gauge network']
		]);
		expect(fp.segments[1]!.months.every((m) => m.source === 'month')).toBe(true);
		expect(fp.segments[1]!.fallbackDays).toBe(365);
		expect(fp.segments[0]!.fallbackDays).toBe(0);
		// The reference windows: 2006 gave no shared day, so the later range fitted on 2000–2009 without it but still spans them.
		expect(fp.segments.map((x) => x.fitWindow)).toEqual([
			{ fromWaterYear: 1990, toWaterYear: 1999 },
			{ fromWaterYear: 2000, toWaterYear: 2009 }
		]);

		// 'all': the blend of both eras, as up to 0.28 (here about 1.6, a third off the later era's ratio).
		const all = fillRatio(s, 2006, 'all');
		const blend = all.run.chirpsCorrection!.pooled.ownFactor!;
		expect(blend).toBeGreaterThan(1.45);
		expect(blend).toBeLessThan(1.75);
		expect(all.ratio / blend).toBeGreaterThan(0.98);
		expect(all.ratio / blend).toBeLessThan(1.02);
		expect(all.run.chirpsCorrection!.fitPeriod).toEqual({ period: 'all', ranges: [], segments: [] });
		expect(all.run.chirpsCorrection!.fitWindow).toEqual({ fromWaterYear: 1990, toWaterYear: 2009 });
	});

	it('leaves the default unchanged: no setting runs exactly as “all”', () => {
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const a = runModel(input(s));
		const b = runModel(input(s, 'all'));
		expect(JSON.stringify(b.series)).toBe(JSON.stringify(a.series));
		expect(b.summary.chirpsCorrection).toEqual(a.summary.chirpsCorrection);
		// … and the ranges differ from it only on the filled days.
		const seg = runModel(input(s, ERAS));
		const used = (o: typeof a) => o.series.find((x) => x.key === 'rain_final')!.values;
		const ua = used(a);
		const us = used(seg);
		for (let t = 0; t < ua.length; t++) if (wyOf(t) !== 2006) expect(us[t]).toBe(ua[t]);
		expect(us.some((v, t) => wyOf(t) === 2006 && v !== ua[t])).toBe(true);
	});

	it('fits each range on its own years only, and fills a gap from the nearer range', () => {
		// Two eras, with two years between them at a wild ratio (e.g. a network in transition).
		const { c, h } = build([...repeat(2, 10), 5, 5, ...repeat(1.2, 8)]);
		blank(c, 1998, 2006);
		const s = series(c, h);
		const ranges: ChirpsFitPeriod = [range(2002, 2009, 'new gauge network'), range(1990, 1997, 'old gauge network')];
		const { run, ratio } = fillRatio(s, 2006, ranges);
		expect(ratio / 1.2).toBeGreaterThan(0.98);
		expect(ratio / 1.2).toBeLessThan(1.02);
		const fp = run.chirpsCorrection!.fitPeriod!;
		// Sorted, each with its reason; the years 1998–2001 between them split in half: 1998 and 1999 to the earlier, 2000 and 2001 to the later.
		expect(fp.segments.map((x) => [x.fromWaterYear, x.toWaterYear, x.fillFrom, x.fillTo, x.reason])).toEqual([
			[1990, 1997, null, 1999, 'old gauge network'],
			[2002, 2009, 2000, null, 'new gauge network']
		]);
		expect(fillRatio(s, 1998, ranges).ratio / 2).toBeCloseTo(1, 1);
		expect(chirpsFitSegmentFor(run.chirpsCorrection, 2001)!.reason).toBe('new gauge network');
		// Years outside every range stay out of every fit, the all-ranges fallback too: 1999 (2.0) and 2000–01 (5.0) are outside.
		const corr = run.chirpsCorrection!;
		expect(corr.outsideRangeDaysLeftOut).toBe(366 + 365 + 365);
		for (const g of corr.fitPeriod!.segments) for (const m of g.months) expect(m.factor!).toBeLessThan(2.05);
		// The all-ranges factor blends only the two ranges (8 years at 2.0, 8 at 1.2) …
		expect(corr.pooled.factor!).toBeGreaterThan(1.45);
		expect(corr.pooled.factor!).toBeLessThan(1.75);
		// … while the whole-record fit, the positive control, is pulled up by the two years at 5.
		expect(prepareRun(input(s, 'all')).chirpsCorrection!.pooled.factor! - corr.pooled.factor!).toBeGreaterThan(0.3);
		const w = chirpsCorrectionWarning(corr)!;
		expect(w).toMatch(/fitted per listed water-year range .*range 1990\/91–1997\/98 \(old gauge network\), fitted on 1990\/91–1997\/98, filling up to 1999\/00/);
		expect(w).toMatch(/1096 shared days outside the listed fit ranges stay out of every fit/);
	});

	it('gives a gap exactly between two ranges to the later one', () => {
		const { c, h } = build(STEP);
		blank(c, 2000);
		const corr = prepareRun(input(series(c, h), [range(1990, 1998, 'a'), range(2002, 2009, 'b')])).chirpsCorrection!;
		expect(chirpsFitSegmentFor(corr, 1999)!.reason).toBe('a');
		expect(chirpsFitSegmentFor(corr, 2000)!.reason).toBe('b');
		expect(chirpsFitSegmentFor(corr, 2001)!.reason).toBe('b');
		// Before the first and after the last: the nearest.
		expect(chirpsFitSegmentFor(corr, 1970)!.reason).toBe('a');
		expect(chirpsFitSegmentFor(corr, 2050)!.reason).toBe('b');
	});

	it('keeps the minimum sample per range: own month, else the range’s pooled factor, else the all-ranges factor', () => {
		const { c, h } = build(STEP);
		// A one-year range: each month has ~30 shared days (< 90), the year together 365, so every month takes the range's pooled factor.
		const one = chirpsBiasFactors(series(c, h), 'monthly', undefined, [], { fitPeriod: [range(1990, 1998, 'a'), range(2005, 2005, 'one year')] })!;
		const y = one.fitPeriod!.segments[1]!;
		expect(y.months.every((m) => m.source === 'pooled')).toBe(true);
		expect(y.pooled.days).toBe(365);
		expect(y.months[0]!.factor! / 1.2).toBeCloseTo(1, 1);
		// Catchment rain on only 60 days of that year: not even a pooled factor, so each month takes the all-ranges one.
		const thin = build(STEP);
		for (let i = 0; i < thin.c.length; i++) if (wyOf(i) === 2005 && i > dayOf('2005-11-29')) thin.c[i] = null;
		const t = chirpsBiasFactors(series(thin.c, thin.h), 'monthly', undefined, [], { fitPeriod: [range(1990, 1998, 'a'), range(2005, 2005, 'one year')] })!;
		const ts = t.fitPeriod!.segments[1]!;
		expect(ts.pooled.factor).toBeNull();
		expect(ts.months.every((m) => m.source === 'record' && m.factor === t.months[m.month - 1]!.factor)).toBe(true);
		expect(chirpsCorrectionWarning({ ...t, fallbackDays: 1, correctedDays: 1 })).toMatch(/\(all ranges\)/);
	});

	it('clamps each range’s factors', () => {
		const { c, h } = build([...repeat(2, 10), ...repeat(6, 10)]);
		const corr = chirpsBiasFactors(series(c, h), 'monthly', undefined, [], { fitPeriod: [range(2000, 2009, 'x')] })!;
		const seg = corr.fitPeriod!.segments[0]!;
		expect(seg.months.every((m) => m.factor === CHIRPS_FACTOR_MAX && m.clamped)).toBe(true);
	});

	it('shows each day’s own range factor in the chirps_factor column', () => {
		const { c, h } = build(STEP);
		blank(c, 2006);
		const out = runModel(input(series(c, h), ERAS));
		const f = out.series.find((x) => x.key === 'chirps_factor')!.values;
		const corr = out.summary.chirpsCorrection!;
		expect(f[dayOf('1995-01-15')]).toBe(chirpsFactorOn(corr, toEpochDay('1995-01-15')));
		expect(f[dayOf('2006-01-15')]).toBe(corr.fitPeriod!.segments[1]!.months[0]!.factor);
		expect(f[dayOf('2006-01-15')]).not.toBe(f[dayOf('1995-01-15')]);
	});

	it('gives the same factors at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const fit = () => JSON.stringify(prepareRun(input(s, ERAS)).chirpsCorrection);
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = fit();
			env.TZ = 'Pacific/Pago_Pago';
			const west = fit();
			env.TZ = 'UTC';
			expect(east).toBe(fit());
			expect(west).toBe(east);
		} finally {
			env.TZ = tz;
		}
	});
});

describe('replaced, missing and filled days stay out of every fit', () => {
	const ACC: Pick<ZeroRainSettings, 'accumulationMode' | 'keepReadings' | 'addAccumulations'> = { accumulationMode: 'spread', keepReadings: [], addAccumulations: [] };

	it('a missing period at a wildly different level leaves every range’s factors unchanged', () => {
		const ref = build(STEP);
		const wild = build(STEP);
		// 2003–2004 of the later era read 10 × CHIRPS: say, a period later replaced from another gauge.
		for (let i = 0; i < wild.c.length; i++) if (wyOf(i) === 2003 || wyOf(i) === 2004) wild.c[i] = wild.h[i]! * 10;
		const period = [{ start: '2003-10-01', end: '2005-09-30', reason: 'replaced from the automatic station' }];
		const zr: ZeroRainSettings = { ...ACC, mode: 'missing', keepDry: [], missing: period };
		const factors = (s: Series, z?: ZeroRainSettings) => {
			const corr = prepareRun(input(s, ERAS, z)).chirpsCorrection!;
			return { all: corr.months.map((m) => m.factor), ranges: corr.fitPeriod!.segments.map((g) => g.months.map((m) => m.factor)) };
		};
		const listed = factors(series(wild.c, wild.h), zr);
		// The same period listed missing over the reference record: the fits see exactly the same days.
		expect(listed).toEqual(factors(series(ref.c, ref.h), zr));
		// And the later range's factors are those of its 1.2 era.
		for (const f of listed.ranges[1]!) expect(f! / 1.2).toBeCloseTo(1, 1);
		// Positive control: not listed, the wild years pull the later range's factors up.
		const unlisted = factors(series(wild.c, wild.h));
		expect(unlisted.ranges[1]![0]! / listed.ranges[1]![0]!).toBeGreaterThan(1.5);
	});

	it('a rain-source period (engine ≥ 0.30.0) at a wildly different level leaves every range’s factors unchanged', () => {
		const ref = build(STEP);
		const wild = build(STEP);
		for (let i = 0; i < wild.c.length; i++) if (wyOf(i) === 2003 || wyOf(i) === 2004) wild.c[i] = wild.h[i]! * 10;
		// The real thing the missing-period test above stands in for: 2003–2004 replaced from an alternative gauge.
		const alt = { startDate: S, values: ref.h.map((v, i) => (wyOf(i) === 2003 || wyOf(i) === 2004 ? v! * 1.5 : null)) };
		const rainSource: RainSourcePeriod[] = [
			{
				start: '2003-10-01',
				end: '2005-09-30',
				series: 'rain_catchment_alt_mm',
				factors: repeat(0.8, 12),
				provenance: { source: 'hydrologist', fittedFrom: '2000-10-01', fittedTo: '2003-09-30', method: 'overlap ratio' },
				reason: 'replaced from the automatic station'
			}
		];
		const factors = (s: Series, periods?: RainSourcePeriod[]) => {
			const i = input({ ...s, rain_catchment_alt_mm: alt }, ERAS);
			const corr = prepareRun({ ...i, settings: { ...i.settings, ...(periods ? { rainSource: periods } : {}) } }).chirpsCorrection!;
			return { all: corr.months.map((m) => m.factor), ranges: corr.fitPeriod!.segments.map((g) => g.months.map((m) => m.factor)), left: corr.replacedDaysLeftOut };
		};
		const replaced = factors(series(wild.c, wild.h), rainSource);
		// Exactly the factors of the same record with those years blank: no replaced day reaches any fit.
		const blanked = build(STEP);
		blank(blanked.c, 2003, 2004);
		const { left: _l, ...got } = replaced;
		const { left: _b, ...want } = factors(series(blanked.c, blanked.h));
		expect(got).toEqual(want);
		expect(replaced.left).toBeGreaterThan(0);
		for (const f of replaced.ranges[1]!) expect(f! / 1.2).toBeCloseTo(1, 1);
		// And the alternative series never enters them either: a different alternative gives the same factors.
		const alt2 = { ...alt, values: alt.values.map((v) => (v === null ? null : v * 3)) };
		const i2 = input({ ...series(wild.c, wild.h), rain_catchment_alt_mm: alt2 }, ERAS);
		const c2 = prepareRun({ ...i2, settings: { ...i2.settings, rainSource } }).chirpsCorrection!;
		expect(c2.fitPeriod!.segments.map((g) => g.months.map((m) => m.factor))).toEqual(replaced.ranges);
		// Positive control: without the period, the wild years pull the later range's factors up.
		expect(factors(series(wild.c, wild.h)).ranges[1]![0]! / replaced.ranges[1]![0]!).toBeGreaterThan(1.5);
	});

	it('the days a flagged zero run leaves blank (then filled from CHIRPS) are not in the fit', () => {
		const zeroed = build(STEP);
		// 61 days of zeros over April–May 2005, both among the six wettest months here: a flagged zero run, treated as missing and
		// filled from CHIRPS by default. (Light months, so neither water year is also flagged far below CHIRPS, which would leave it out whole.)
		const from = dayOf('2005-04-01');
		for (let i = from; i < from + 61; i++) zeroed.c[i] = 0;
		const f = (s: Series) => prepareRun(input(s, ERAS)).chirpsCorrection!;
		const z = f(series(zeroed.c, zeroed.h));
		// 62: a dry day next to them already read 0, so it joins the run.
		expect(z.flaggedDaysLeftOut).toBe(62);
		expect(z.excludedWaterYears).toEqual([]);
		// Leaving the run's days out equals blanking them: the fit never sees the filled days.
		const blanked = build(STEP);
		for (let i = from; i < from + 61; i++) blanked.c[i] = null;
		const factors = (x: typeof z) => [x.months, ...x.fitPeriod!.segments.map((g) => g.months)].map((ms) => ms.map((m) => m.factor));
		expect(factors(z)).toEqual(factors(f(series(blanked.c, blanked.h))));
	});
});

describe('proposeChirpsFitRanges: the double-mass breaks only propose ranges', () => {
	it('proposes one range per segment, covering the years between, each marked as a proposal', () => {
		const { c, h } = build(STEP);
		const dm = doubleMass(series(c, h))!;
		const proposed = proposeChirpsFitRanges(dm);
		expect(proposed.map((r) => [r.fromWaterYear, r.toWaterYear])).toEqual([
			[1990, 1999],
			[2000, 2009]
		]);
		expect(proposed[1]!.reason).toMatch(/^proposed from the double-mass check \(catchment \/ CHIRPS 1\.20\): confirm against the station history$/);
		// It is valid as a setting as it stands …
		const w: string[] = [];
		expect(resolveChirpsFitPeriod(proposed, w)).toEqual(proposed);
		expect(w).toEqual([]);
		// … and nothing is applied until it is saved: a run without the setting fits the whole record.
		blank(c, 2006);
		expect(prepareRun(input(series(c, h))).chirpsCorrection!.fitPeriod!.period).toBe('all');
		expect(fillRatio(series(c, h), 2006, proposed).ratio / 1.2).toBeCloseTo(1, 1);
	});

	it('proposes nothing without a break or a result', () => {
		const { c, h } = build(repeat(2, 20));
		expect(proposeChirpsFitRanges(doubleMass(series(c, h)))).toEqual([]);
		expect(proposeChirpsFitRanges(null)).toEqual([]);
	});

	it('“segments” is not a fit period: a stored one runs as the whole record, with a warning', () => {
		const w: string[] = [];
		expect(resolveChirpsFitPeriod('segments', w)).toBe('all');
		expect(w).toEqual(['unknown CHIRPS fit period "segments"; using the whole record']);
	});
});

describe('resolveChirpsFitPeriod', () => {
	it('keeps the whole record and valid ranges, sorted and trimmed', () => {
		const w: string[] = [];
		expect(resolveChirpsFitPeriod(undefined, w)).toBe('all');
		expect(resolveChirpsFitPeriod('all', w)).toBe('all');
		expect(resolveChirpsFitPeriod([range(2005, 2010, ' b '), range(1990, 2004, 'a')], w)).toEqual([range(1990, 2004, 'a'), range(2005, 2010, 'b')]);
		expect(w).toEqual([]);
	});

	it('drops bad and overlapping ranges with a warning, and falls back to the whole record with none left', () => {
		const w: string[] = [];
		expect(
			resolveChirpsFitPeriod(
				[range(1990, 2000, 'a'), range(1995, 2005, 'overlaps'), range(2010, 2005, 'backwards'), range(2011, 2012, ''), range(2011.5, 2012, 'x')],
				w
			)
		).toEqual([range(1990, 2000, 'a')]);
		expect(w).toHaveLength(4);
		expect(w[0]).toMatch(/overlaps 1990\/91–2000\/01; ignored/);
		expect(w[2]).toMatch(/has no reason/);
		// Unknown fields and over-long reasons are dropped as the API refuses them (backend settings.test.ts holds the two together).
		const w3: string[] = [];
		expect(resolveChirpsFitPeriod([{ ...range(1990, 2000, 'a'), note: 'x' }, range(2001, 2002, 'y'.repeat(501)), range(2003, 2004, 'ok')], w3)).toEqual([range(2003, 2004, 'ok')]);
		expect(w3).toEqual(['CHIRPS fit range with unknown field note; ignored', 'CHIRPS fit range 2001/02–2002/03 has a reason longer than 500 characters; ignored']);
		const w2: string[] = [];
		expect(resolveChirpsFitPeriod([], w2)).toBe('all');
		expect(w2).toEqual(['the CHIRPS fit period lists no usable water-year range; using the whole record']);
	});

	it('reaches a run through its settings, with the warning', () => {
		const { c, h } = build(STEP);
		const out = runModel(input(series(c, h), 'yearly' as never));
		expect(out.summary.warnings).toContain('unknown CHIRPS fit period "yearly"; using the whole record');
		expect(out.summary.chirpsCorrection!.fitPeriod!.period).toBe('all');
	});
});

describe('double-mass run warning with a fit period', () => {
	it('names the range whose factors filled each gap', () => {
		const { c, h } = build(STEP);
		blank(c, 1995, 2006);
		const s = series(c, h);
		const out = runModel(input(s, ERAS));
		const w = out.summary.warnings.find((x) => x.startsWith('CHIRPS fills catchment-rain gaps'))!;
		expect(w).toBe(
			'CHIRPS fills catchment-rain gaps with factors fitted per listed water-year range (Settings → CHIRPS fit period): ' +
				'366 days up to 1999/00 with the factors of range 1990/91–1999/00 (old gauge network) (pooled catchment / CHIRPS 2.00); ' +
				"365 days from 2000/01 on with the factors of range 2000/01–2009/10 (new gauge network) (pooled catchment / CHIRPS 1.20). The Data tab's double-mass chart shows the segments."
		);
		// The data check says the factors follow the listed ranges.
		expect(out.summary.dataQuality!.seriesChecks!.find((x) => x.check === 'doublemass')!.text).toMatch(/fitted per listed water-year range/);
		// Whole-record factors: the old warning, naming the whole record, and pointing at the ranges.
		const all = runModel(input(s, 'all')).summary.warnings.find((x) => x.startsWith('CHIRPS fills catchment-rain gaps'))!;
		expect(all).toMatch(/with factors fitted on the whole record .*365 days from 2000\/01 on, where catchment rain reads 1\.20 × CHIRPS/);
		expect(all).toMatch(/propose ranges from these breaks\.$/);
		expect(doubleMassCheck(doubleMass(s))!.text).toMatch(/propose ranges from these breaks/);
	});

	it('flags a range whose factors fill a double-mass segment at a different ratio', () => {
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const dm = doubleMass(s)!;
		const run = prepareRun(input(s, [range(1990, 1999, 'trusted network')]));
		const w = doubleMassRunWarning(dm, run.chirpsCorrection, run.aligned('rain_catchment_mm'), s.rain_chirps_mm!.values.slice(0, run.days), run.start)!;
		expect(w).toMatch(/with the factors of range 1990\/91–1999\/00 \(trusted network\)/);
		expect(w).toMatch(/But the double-mass check finds the ratio differs from the factors that filled: 365 days from 2000\/01 on filled by range .*reads 1\.20 × CHIRPS \(−40 %\)/);
	});
});

describe('reference windows (fit provenance, run comparison)', () => {
	it('records one set of factors per range with the years it was fitted on, or the whole record', () => {
		const { c, h } = build(STEP);
		blank(c, 1990);
		const s = series(c, h);
		const whole = chirpsBiasFactors(s, 'monthly')!;
		expect(chirpsFactorSets(whole)!.map((x) => [x.label, x.fittedOn])).toEqual([['whole record', '1991/92–2009/10']]);
		expect(fitWindowLabels(whole)).toEqual(['whole record: 1991/92–2009/10']);
		const listed = chirpsBiasFactors(s, 'monthly', undefined, [], { fitPeriod: ERAS })!;
		const sets = chirpsFactorSets(listed)!;
		expect(sets.map((x) => [x.label, x.fittedOn])).toEqual([
			['range 1990/91–1999/00 (old gauge network), filling up to 1999/00', '1991/92–1999/00'],
			['range 2000/01–2009/10 (new gauge network), filling from 2000/01 on', '2000/01–2009/10']
		]);
		expect(sets[1]!.factors).toHaveLength(12);
		expect(fitWindowLabels(listed)).toEqual([
			'all ranges: 1991/92–2009/10',
			'range 1990/91–1999/00 (old gauge network): 1991/92–1999/00',
			'range 2000/01–2009/10 (new gauge network): 2000/01–2009/10'
		]);
		expect(chirpsFactorSets(chirpsBiasFactors(s, 'none'))).toBeNull();
		// A correction from before 0.29.0 has no windows.
		const { fitWindow: _w, ...old } = whole;
		expect(fitWindowLabels(old)).toEqual([]);
	});
});
