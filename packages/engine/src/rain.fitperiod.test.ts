// CHIRPS fit period / per-segment factors (engine ≥ 0.29.0, issue #40 (a),
// docs/model.md §2.4b). Every record here is synthetic: a catchment series at a
// known ratio to CHIRPS that steps at a known water year.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { doubleMass, doubleMassRunWarning } from './doublemass';
import { defaultProjectSettings, type ChirpsFitPeriod, type DailySeries, type ModelInput, type SeriesKind } from './project';
import {
	chirpsBiasFactors,
	chirpsCorrectionWarning,
	chirpsFactorOn,
	chirpsFactorSets,
	chirpsFitSegmentFor,
	CHIRPS_FACTOR_MAX,
	resolveChirpsFitPeriod
} from './rain';
import { prepareRun, runModel } from './run';

type Series = Partial<Record<SeriesKind, DailySeries>>;

const FIRST_WY = 1990;
const S = `${FIRST_WY}-10-01`;
const d0 = toEpochDay(S);
/** CHIRPS rain on every third day, mm, by calendar month (a winter-rainfall shape). */
const BASE = [0, 2, 2, 4, 6, 10, 12, 12, 10, 6, 4, 3, 2];
const repeat = (v: number, n: number) => new Array<number>(n).fill(v);
const wyOf = (i: number) => Number(fromEpochDay(d0 + i).slice(0, 4)) - (monthOfEpochDay(d0 + i) >= 10 ? 0 : 1);
const dayOf = (iso: string) => toEpochDay(iso) - d0;

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
const input = (s: Series, chirpsFitPeriod?: ChirpsFitPeriod): ModelInput => ({
	settings: {
		apanMm: repeat(150, 12) as unknown as Monthly,
		calibration: { ...defaultProjectSettings().calibration, catchmentAreaKm2: 10 },
		...(chirpsFitPeriod !== undefined ? { chirpsFitPeriod } : {})
	},
	model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
	series: s
});
/** Rain CHIRPS filled into water year `wy`, over the raw CHIRPS there: the factor the fill used. */
function fillRatio(s: Series, wy: number, period?: ChirpsFitPeriod) {
	const run = prepareRun(input(s, period));
	const used = run.aligned('rain_chirps_mm');
	const raw = s.rain_chirps_mm!.values;
	let a = 0;
	let b = 0;
	for (let t = 0; t < run.days; t++) {
		if (wyOf(run.start + t - d0) !== wy || run.aligned('rain_catchment_mm')[t] != null) continue;
		a += used[t] ?? 0;
		b += raw[run.start + t - d0] ?? 0;
	}
	return { ratio: a / b, run };
}

/** A step from 2.0 to 1.2 × CHIRPS after water year 1999 (20 years). */
const STEP = [...repeat(2, 10), ...repeat(1.2, 10)];

describe('chirpsFitPeriod: double-mass segments', () => {
	it('fills a gap in the later segment with that segment’s factors; the whole-record fit uses the blend', () => {
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const seg = fillRatio(s, 2006, 'segments');
		expect(seg.ratio / 1.2).toBeGreaterThan(0.98);
		expect(seg.ratio / 1.2).toBeLessThan(1.02);
		const fp = seg.run.chirpsCorrection!.fitPeriod!;
		expect(fp.period).toBe('segments');
		expect(fp.segments.map((x) => [x.fromWaterYear, x.fillFrom, x.fillTo])).toEqual([
			[1990, null, 1999],
			[2000, 2000, null]
		]);
		expect(fp.segments[1]!.months.every((m) => m.source === 'month')).toBe(true);
		expect(fp.segments[1]!.fallbackDays).toBe(365);
		expect(fp.segments[0]!.fallbackDays).toBe(0);

		// 'all': the blend of both eras, as up to 0.28 (here about 1.6, a third off the later era's ratio).
		const all = fillRatio(s, 2006, 'all');
		const blend = all.run.chirpsCorrection!.pooled.ownFactor!;
		expect(blend).toBeGreaterThan(1.45);
		expect(blend).toBeLessThan(1.75);
		expect(all.ratio / blend).toBeGreaterThan(0.98);
		expect(all.ratio / blend).toBeLessThan(1.02);
		expect(all.run.chirpsCorrection!.fitPeriod).toEqual({ period: 'all', ranges: [], segments: [], note: null });
	});

	it('leaves the default unchanged: no setting runs exactly as “all”', () => {
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const a = runModel(input(s));
		const b = runModel(input(s, 'all'));
		expect(JSON.stringify(b.series)).toBe(JSON.stringify(a.series));
		expect(b.summary.chirpsCorrection).toEqual(a.summary.chirpsCorrection);
		// … and the segments differ from it only on the filled days.
		const seg = runModel(input(s, 'segments'));
		const used = (o: typeof a) => o.series.find((x) => x.key === 'rain_final')!.values;
		const ua = used(a);
		const us = used(seg);
		for (let t = 0; t < ua.length; t++) if (wyOf(t) !== 2006) expect(us[t]).toBe(ua[t]);
		expect(us.some((v, t) => wyOf(t) === 2006 && v !== ua[t])).toBe(true);
	});

	it('fills a gap before the first judged year and after the last from the nearest segment', () => {
		const { c, h } = build(STEP);
		blank(c, 1990, 2009);
		const s = series(c, h);
		expect(fillRatio(s, 1990, 'segments').ratio / 2).toBeCloseTo(1, 1);
		expect(fillRatio(s, 2009, 'segments').ratio / 1.2).toBeCloseTo(1, 1);
		const corr = fillRatio(s, 1990, 'segments').run.chirpsCorrection!;
		expect(chirpsFitSegmentFor(corr, 1970)!.fromWaterYear).toBe(1991); // first judged year: 1990 has no shared day
		expect(chirpsFitSegmentFor(corr, 2050)!.fromWaterYear).toBe(2000);
	});

	it('falls back to the whole record without a break, and says so', () => {
		const { c, h } = build(repeat(2, 20));
		blank(c, 2006);
		const s = series(c, h);
		const seg = fillRatio(s, 2006, 'segments');
		const all = fillRatio(s, 2006, 'all');
		expect(seg.run.chirpsCorrection!.fitPeriod).toMatchObject({ period: 'segments', segments: [], note: 'noBreak' });
		expect(seg.ratio).toBe(all.ratio);
		expect(chirpsCorrectionWarning(seg.run.chirpsCorrection)).toMatch(/double-mass check finds no break, so one set of factors fits the whole record/);
		// Too short a record for the check at all.
		const short = build(repeat(2, 6));
		blank(short.c, 1994);
		expect(fillRatio(series(short.c, short.h), 1994, 'segments').run.chirpsCorrection!.fitPeriod!.note).toBe('noDoubleMass');
	});

	it('gives the same factors at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const fit = () => JSON.stringify(prepareRun(input(s, 'segments')).chirpsCorrection);
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

describe('chirpsFitPeriod: listed water-year ranges', () => {
	/** Two eras, with two years between them at a wild ratio (e.g. a network in transition). */
	const RATIOS = [...repeat(2, 10), 5, 5, ...repeat(1.2, 8)];

	it('fits each range on its own years only, and fills a gap from the nearer range', () => {
		const { c, h } = build(RATIOS);
		blank(c, 1998, 2006);
		const s = series(c, h);
		const ranges: ChirpsFitPeriod = [
			{ fromWaterYear: 2002, toWaterYear: 2009, reason: 'new gauge network' },
			{ fromWaterYear: 1990, toWaterYear: 1997, reason: 'old gauge network' }
		];
		const { run, ratio } = fillRatio(s, 2006, ranges);
		expect(ratio / 1.2).toBeGreaterThan(0.98);
		expect(ratio / 1.2).toBeLessThan(1.02);
		const fp = run.chirpsCorrection!.fitPeriod!;
		expect(fp.period).toBe('ranges');
		// Sorted, each with its reason; the years 1998–2001 between them split in half: 1998 and 1999 to the earlier, 2000 and 2001 to the later.
		expect(fp.segments.map((x) => [x.fitFrom, x.fitTo, x.fillFrom, x.fillTo, x.reason])).toEqual([
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
		expect(chirpsCorrectionWarning(corr)).toMatch(/fitted per listed water-year range .*listed range 1990\/91–1997\/98 \(old gauge network\), filling up to 1999\/00/);
		expect(chirpsCorrectionWarning(corr)).toMatch(/1096 shared days outside the listed fit ranges stay out of every fit/);
	});

	it('gives a gap exactly between two ranges to the later one', () => {
		const { c, h } = build(STEP);
		blank(c, 2000);
		const ranges: ChirpsFitPeriod = [
			{ fromWaterYear: 1990, toWaterYear: 1998, reason: 'a' },
			{ fromWaterYear: 2002, toWaterYear: 2009, reason: 'b' }
		];
		const corr = prepareRun(input(series(c, h), ranges)).chirpsCorrection!;
		expect(chirpsFitSegmentFor(corr, 1999)!.reason).toBe('a');
		expect(chirpsFitSegmentFor(corr, 2000)!.reason).toBe('b');
		expect(chirpsFitSegmentFor(corr, 2001)!.reason).toBe('b');
	});

	it('keeps the minimum sample per segment: own month, else the segment’s pooled factor, else the all-ranges factor', () => {
		const { c, h } = build(STEP);
		// A one-year range: each month has ~30 shared days (< 90), the year together 365, so every month takes the segment's pooled factor.
		const one = chirpsBiasFactors(series(c, h), 'monthly', undefined, [], {
			fitPeriod: [
				{ fromWaterYear: 1990, toWaterYear: 1998, reason: 'a' },
				{ fromWaterYear: 2005, toWaterYear: 2005, reason: 'one year' }
			]
		})!;
		const y = one.fitPeriod!.segments[1]!;
		expect(y.months.every((m) => m.source === 'pooled')).toBe(true);
		expect(y.pooled.days).toBe(365);
		expect(y.months[0]!.factor! / 1.2).toBeCloseTo(1, 1);
		// Catchment rain on only 60 days of that year: not even a pooled factor, so each month takes the all-ranges one.
		const thin = build(STEP);
		for (let i = 0; i < thin.c.length; i++) if (wyOf(i) === 2005 && i > dayOf('2005-11-29')) thin.c[i] = null;
		const t = chirpsBiasFactors(series(thin.c, thin.h), 'monthly', undefined, [], {
			fitPeriod: [
				{ fromWaterYear: 1990, toWaterYear: 1998, reason: 'a' },
				{ fromWaterYear: 2005, toWaterYear: 2005, reason: 'one year' }
			]
		})!;
		const ts = t.fitPeriod!.segments[1]!;
		expect(ts.pooled.factor).toBeNull();
		expect(ts.months.every((m) => m.source === 'record' && m.factor === t.months[m.month - 1]!.factor)).toBe(true);
		expect(chirpsCorrectionWarning({ ...t, fallbackDays: 1, correctedDays: 1 })).toMatch(/\(all ranges\)/);
	});

	it('clamps each segment’s factors', () => {
		const { c, h } = build([...repeat(2, 10), ...repeat(6, 10)]);
		const corr = chirpsBiasFactors(series(c, h), 'monthly', undefined, [], { fitPeriod: [{ fromWaterYear: 2000, toWaterYear: 2009, reason: 'x' }] })!;
		const seg = corr.fitPeriod!.segments[0]!;
		expect(seg.months.every((m) => m.factor === CHIRPS_FACTOR_MAX && m.clamped)).toBe(true);
	});

	it('shows each day’s own segment factor in the chirps_factor column', () => {
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const out = runModel(input(s, 'segments'));
		const f = out.series.find((x) => x.key === 'chirps_factor')!.values;
		const corr = out.summary.chirpsCorrection!;
		expect(f[dayOf('1995-01-15')]).toBe(chirpsFactorOn(corr, toEpochDay('1995-01-15')));
		expect(f[dayOf('2006-01-15')]).toBe(corr.fitPeriod!.segments[1]!.months[0]!.factor);
		expect(f[dayOf('2006-01-15')]).not.toBe(f[dayOf('1995-01-15')]);
	});
});

describe('resolveChirpsFitPeriod', () => {
	it('keeps the modes and valid ranges, sorted', () => {
		const w: string[] = [];
		expect(resolveChirpsFitPeriod(undefined, w)).toBe('all');
		expect(resolveChirpsFitPeriod('segments', w)).toBe('segments');
		expect(
			resolveChirpsFitPeriod(
				[
					{ fromWaterYear: 2005, toWaterYear: 2010, reason: ' b ' },
					{ fromWaterYear: 1990, toWaterYear: 2004, reason: 'a' }
				],
				w
			)
		).toEqual([
			{ fromWaterYear: 1990, toWaterYear: 2004, reason: 'a' },
			{ fromWaterYear: 2005, toWaterYear: 2010, reason: 'b' }
		]);
		expect(w).toEqual([]);
	});

	it('drops bad and overlapping ranges with a warning, and falls back to the whole record with none left', () => {
		const w: string[] = [];
		expect(resolveChirpsFitPeriod('latest', w)).toBe('all');
		expect(
			resolveChirpsFitPeriod(
				[
					{ fromWaterYear: 1990, toWaterYear: 2000, reason: 'a' },
					{ fromWaterYear: 1995, toWaterYear: 2005, reason: 'overlaps' },
					{ fromWaterYear: 2010, toWaterYear: 2005, reason: 'backwards' },
					{ fromWaterYear: 2011, toWaterYear: 2012, reason: '' },
					{ fromWaterYear: 2011.5, toWaterYear: 2012, reason: 'x' }
				],
				w
			)
		).toEqual([{ fromWaterYear: 1990, toWaterYear: 2000, reason: 'a' }]);
		expect(w).toHaveLength(5);
		expect(w[1]).toMatch(/overlaps 1990\/91–2000\/01; ignored/);
		expect(w[3]).toMatch(/has no reason/);
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
	it('names the segment whose factors filled each gap', () => {
		const { c, h } = build(STEP);
		blank(c, 1995, 2006);
		const s = series(c, h);
		const out = runModel(input(s, 'segments'));
		const w = out.summary.warnings.find((x) => x.startsWith('CHIRPS fills catchment-rain gaps'))!;
		expect(w).toMatch(
			/^CHIRPS fills catchment-rain gaps with factors fitted per double-mass segment \(Settings → CHIRPS fit period\): 366 days up to 1999\/00 with the factors of double-mass segment 1990\/91–1999\/00 \(pooled catchment \/ CHIRPS 2\.00\); 365 days from 2000\/01 on with the factors of double-mass segment 2000\/01–2009\/10 \(pooled catchment \/ CHIRPS 1\.20\)\. The Data tab's double-mass chart shows the segments\.$/
		);
		// Whole-record factors: the old warning, naming the whole record.
		const all = runModel(input(s, 'all')).summary.warnings.find((x) => x.startsWith('CHIRPS fills catchment-rain gaps'))!;
		expect(all).toMatch(/with factors fitted on the whole record .*365 days from 2000\/01 on, where catchment rain reads 1\.20 × CHIRPS/);
	});

	it('flags a listed range whose factors fill a double-mass segment at a different ratio', () => {
		const { c, h } = build(STEP);
		blank(c, 2006);
		const s = series(c, h);
		const dm = doubleMass(s)!;
		const corr = chirpsBiasFactors(s, 'monthly', undefined, [], { fitPeriod: [{ fromWaterYear: 1990, toWaterYear: 1999, reason: 'trusted network' }], doubleMass: dm })!;
		const run = prepareRun(input(s, [{ fromWaterYear: 1990, toWaterYear: 1999, reason: 'trusted network' }]));
		const w = doubleMassRunWarning(dm, run.chirpsCorrection, run.aligned('rain_catchment_mm'), s.rain_chirps_mm!.values.slice(0, run.days), run.start)!;
		expect(corr.fitPeriod!.segments[0]!.pooled.ownFactor! / 2).toBeCloseTo(1, 1);
		expect(w).toMatch(/with the factors of listed range 1990\/91–1999\/00 \(trusted network\)/);
		expect(w).toMatch(/But the double-mass check finds the ratio differs from the factors that filled: 365 days from 2000\/01 on filled by listed range .*reads 1\.20 × CHIRPS \(−40 %\)/);
	});
});

describe('chirpsFactorSets (fit provenance)', () => {
	it('records one set per fit segment, or the whole record', () => {
		const { c, h } = build(STEP);
		const s = series(c, h);
		const dm = doubleMass(s);
		expect(chirpsFactorSets(chirpsBiasFactors(s, 'monthly'))!.map((x) => x.label)).toEqual(['whole record']);
		const sets = chirpsFactorSets(chirpsBiasFactors(s, 'monthly', undefined, [], { fitPeriod: 'segments', doubleMass: dm }))!;
		expect(sets.map((x) => x.label)).toEqual(['double-mass segment 1990/91–1999/00, filling up to 1999/00', 'double-mass segment 2000/01–2009/10, filling from 2000/01 on']);
		expect(sets[1]!.factors).toHaveLength(12);
		expect(chirpsFactorSets(chirpsBiasFactors(s, 'none'))).toBeNull();
	});
});
