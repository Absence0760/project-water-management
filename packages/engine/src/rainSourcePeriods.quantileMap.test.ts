// A rain-source period's daily-intensity check and opt-in quantile map
// (engine ≥ 1.21.0, issue #66, docs/model.md §2.4e *Daily intensity*). Every
// record here is synthetic: a primary catchment series wet on about half the
// days with moderate (exponential) falls over water years 1990–2004, and an
// alternative automatic gauge from 2005 wet as often with the same mean fall
// but a far wider spread (chi-square: many small falls and a few big ones),
// except July, which is nearly dry at the gauge.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { diffInputs } from './compare';
import { prepareRun } from './prepare';
import { defaultProjectSettings, type DailySeries, type ModelInput, type RainSourcePeriod, type SeriesKind } from './project';
import {
	HEAVY_DAY_MM,
	QM_MIN_WET_DAYS,
	rainSourceError,
	rainSourceLines,
	rainSourcePeriodError,
	rainSourcePeriodWarnings,
	rainSourceText,
	resolveRainSource,
	seasonOf
} from './rainSourcePeriods';

const S = '1990-10-01';
const d0 = toEpochDay(S);
const DAYS = toEpochDay('2010-10-01') - d0;
/** Mean wet-day fall at the primary series, mm, by calendar month. */
const MEAN = [0, 9, 9, 8, 6, 5, 4, 4, 4, 4, 5, 7, 8];

function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s + 0.5) / 2 ** 32;
	};
}

function build() {
	const rnd = lcg(11);
	const c: (number | null)[] = [];
	const a: (number | null)[] = [];
	for (let i = 0; i < DAYS; i++) {
		const day = d0 + i;
		const m = monthOfEpochDay(day);
		const late = day >= toEpochDay('2005-10-01');
		const u1 = rnd();
		const u2 = rnd();
		const u3 = rnd();
		const u4 = rnd();
		const u5 = rnd();
		c.push(u1 < 0.5 ? -Math.log(u2) * MEAN[m]! : 0);
		const pWet = m === 7 ? 0.06 : 0.5;
		const z = Math.sqrt(-2 * Math.log(u4)) * Math.cos(2 * Math.PI * u5);
		a.push(late ? (u3 < pWet ? z * z * MEAN[m]! : 0) : null);
	}
	return { rain_catchment_mm: { startDate: S, values: c }, rain_catchment_alt_mm: { startDate: S, values: a } } as Partial<Record<SeriesKind, DailySeries>>;
}
const SERIES = build();

const input = (rainSource: unknown, extra: Partial<ModelInput['settings']> = {}): ModelInput => ({
	settings: {
		apanMm: new Array(12).fill(150) as unknown as Monthly,
		calibration: { ...defaultProjectSettings().calibration, catchmentAreaKm2: 10 },
		rainSource,
		...extra
	} as ModelInput['settings'],
	model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
	series: SERIES
});

const FACTORS = [1.1, 1, 1, 0.9, 0.9, 1, 1, 1.2, 1.2, 1, 1, 1];
const PLAIN: RainSourcePeriod = {
	start: '2005-10-01',
	end: '2010-09-30',
	series: 'rain_catchment_alt_mm',
	factors: FACTORS,
	provenance: { source: 'hydrologist', fittedFrom: '2005-10-01', fittedTo: '2010-09-30', method: 'overlap ratio' },
	reason: 'automatic station replaces the averaged gauges'
};
const MAPPED: RainSourcePeriod = { ...PLAIN, quantileMap: { fromWaterYear: 1990, toWaterYear: 2004, wetDayMm: 1 } };

/** The scaled series over the period by calendar month (water-year-ordered factors → calendar month). */
const factorOf = (day: number) => FACTORS[(monthOfEpochDay(day) + 2) % 12]!;
const alt = SERIES.rain_catchment_alt_mm!;
const scaled = (day: number) => alt.values[day - d0]! * factorOf(day);

function periodRainOf(inp: ModelInput) {
	const run = prepareRun(inp);
	const rain = run.aligned('rain_catchment_mm');
	const out = new Map<number, number>();
	for (let t = 0; t < rain.length; t++) {
		const day = run.start + t;
		if (day >= toEpochDay(PLAIN.start) && day <= toEpochDay(PLAIN.end)) out.set(day, rain[t]!);
	}
	return { run, out };
}

describe('daily intensity of a rain-source period', () => {
	it('by default the period runs on the series × factor exactly, and still reports its heavy-day share against the primary record', () => {
		const { run, out } = periodRainOf(input([PLAIN]));
		for (const [day, v] of out) expect(v).toBe(scaled(day));
		const p = run.rainSource!.info.periods[0]!;
		expect(p.quantileMap).toBeNull();
		const i = p.intensity!;
		expect(i.heavyDayMm).toBe(HEAVY_DAY_MM);
		// Fixed factors name no era: the whole trusted primary record, outside the period.
		expect(i.reference.era).toBeNull();
		expect(i.reference.window).toEqual({ fromWaterYear: 1990, toWaterYear: 2004 });
		// The gauge's heavier days put much more of its rain on heavy days.
		expect(i.scaled.share!).toBeGreaterThan(i.reference.share! + 0.1);
		expect(i.differs).toBe(true);
		expect(i.mapped).toBeNull();
		const warnings = rainSourcePeriodWarnings(run.rainSource!.info);
		expect(warnings).toHaveLength(2);
		expect(warnings[1]).toMatch(
			/^Daily intensity of the alternative catchment gauge over 2005-10-01 to 2010-09-30: \d+ % of its rain × factor fell on heavy days \(≥ 20 mm\), against \d+ % in the whole trusted primary catchment series \(1990\/91–2004\/05\); wet \(≥ 1 mm\) on \d+ % of days against \d+ %\. The heavy-day shares are more than 5 points apart/
		);
		expect(i.wetDayMm).toBe(1);
		expect(i.reference.wetDays).toBeGreaterThan(0);
		expect(i.scaled.days).toBeGreaterThan(1500);
		expect(warnings[1]).toMatch(/Consider quantile-mapping/);
	});

	it('says nothing more when the shares agree within the band', () => {
		// The primary itself as the gauge: the same distribution, so no intensity warning.
		const same = { ...SERIES, rain_catchment_alt_mm: { startDate: S, values: SERIES.rain_catchment_mm!.values.map((v, i) => (d0 + i >= toEpochDay('2005-10-01') ? SERIES.rain_catchment_mm!.values[i - 365 * 10]! : null)) } };
		const run = prepareRun({ ...input([{ ...PLAIN, factors: new Array(12).fill(1) }]), series: same });
		const p = run.rainSource!.info.periods[0]!;
		expect(p.intensity!.differs).toBe(false);
		expect(rainSourcePeriodWarnings(run.rainSource!.info)).toHaveLength(1);
	});
});

describe('quantile-mapping a period’s wet days (opt-in)', () => {
	const plain = periodRainOf(input([PLAIN]));
	const mapped = periodRainOf(input([MAPPED]));
	const p = mapped.run.rainSource!.info.periods[0]!;

	it('keeps every year-month’s total exactly as the monthly factor gives it (invariant)', () => {
		const totals = (m: Map<number, number>) => {
			const t = new Map<string, number>();
			for (const [day, v] of m) t.set(fromEpochDay(day).slice(0, 7), (t.get(fromEpochDay(day).slice(0, 7)) ?? 0) + v);
			return t;
		};
		const a = totals(plain.out);
		const b = totals(mapped.out);
		expect(b.size).toBe(60);
		for (const [ym, v] of a) expect(b.get(ym)!).toBeCloseTo(v, 9);
		// And so the period's total, and the run's.
		expect(p.seriesMm).toBeCloseTo(plain.run.rainSource!.info.periods[0]!.seriesMm, 6);
	});

	it('moves the heavy-day share towards the primary record’s', () => {
		const i = p.intensity!;
		expect(i.reference.era).toEqual({ fromWaterYear: 1990, toWaterYear: 2004 });
		expect(i.mapped).not.toBeNull();
		// Most of the gap closes; what is left comes from the gauge's fewer wet days (≥ 1 mm), which a
		// map that keeps each month's wet days and total can't change.
		expect(Math.abs(i.mapped!.share! - i.reference.share!)).toBeLessThan(0.7 * Math.abs(i.scaled.share! - i.reference.share!));
		expect(i.scaled.wetDays / i.scaled.days).toBeLessThan(i.reference.wetDays / i.reference.days);
		expect(i.mapped!.wetDays).toBeLessThanOrEqual(i.scaled.wetDays);
		// `differs` judges the unmapped series: what the map is for.
		expect(i.differs).toBe(true);
		expect(p.quantileMap!.mappedDays).toBeGreaterThan(300);
	});

	it('leaves dry days (below the wet-day threshold) and days outside the period alone', () => {
		for (const [day, v] of mapped.out) if (scaled(day) < 1) expect(v).toBe(scaled(day));
		const a = plain.run.aligned('rain_catchment_mm');
		const b = mapped.run.aligned('rain_catchment_mm');
		for (let t = 0; t < a.length; t++) if (plain.run.start + t < toEpochDay(PLAIN.start)) expect(b[t]).toBe(a[t]);
	});

	it('maps month by month, pools a thin month’s season, and says so', () => {
		const q = p.quantileMap!;
		expect(q.minWetDays).toBe(QM_MIN_WET_DAYS);
		expect(q.window).toEqual({ fromWaterYear: 1990, toWaterYear: 2004 });
		expect(q.months.find((m) => m.month === 1)!.basis).toBe('month');
		// July is nearly dry at the gauge: too few wet days of its own, so June–August together.
		const jul = q.months.find((m) => m.month === 7)!;
		expect(jul.basis).toBe('season');
		expect(seasonOf(7)).toEqual([6, 7, 8]);
		expect(seasonOf(12)).toEqual([12, 1, 2]);
		expect(seasonOf(2)).toEqual([12, 1, 2]);
		expect(seasonOf(11)).toEqual([9, 10, 11]);
		expect(jul.periodWetDays).toBeGreaterThanOrEqual(QM_MIN_WET_DAYS);
		const w = rainSourcePeriodWarnings(mapped.run.rainSource!.info);
		expect(w[1]).toMatch(/After the quantile map, \d+ % on heavy days: wet days \(≥ 1 mm\) quantile-mapped onto the primary catchment series over 1990\/91–2004\/05/);
		expect(w[1]).toMatch(/by season: Jul/);
		expect(w[0]).toMatch(/mm × monthly factor, wet days quantile-mapped\)/);
	});

	it('falls back to the monthly factor alone when even the season has too few wet days', () => {
		const short: RainSourcePeriod = { ...MAPPED, start: '2010-06-01' };
		const { run, out } = periodRainOf(input([short]));
		const q = run.rainSource!.info.periods[0]!.quantileMap!;
		// Four months of the gauge: about 20 wet days even over June–August.
		expect(q.months.every((m) => m.basis === null)).toBe(true);
		expect(q.mappedDays).toBe(0);
		for (const [day, v] of out) if (day >= toEpochDay(short.start)) expect(v).toBe(scaled(day));
		expect(rainSourcePeriodWarnings(run.rainSource!.info)[1]).toMatch(/not mapped \(fewer than 30 wet days even over the season\): Oct, Nov, Dec, Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep/);
	});

	it('gives a day the same rain whatever the run window (mapped over the whole period)', () => {
		const from = '2008-02-15';
		const { run } = periodRainOf(input([MAPPED], { simulationStart: from }));
		const rain = run.aligned('rain_catchment_mm');
		for (let t = 0; t < rain.length; t++) {
			const day = run.start + t;
			if (day > toEpochDay(PLAIN.end)) break;
			expect(rain[t]).toBe(mapped.out.get(day));
		}
		expect(run.start).toBe(toEpochDay(from));
	});
});

describe('settings, comparison and words', () => {
	it('validates the quantile map: era, threshold, no stray fields', () => {
		expect(rainSourcePeriodError(MAPPED)).toBeNull();
		expect(rainSourcePeriodError({ ...PLAIN, quantileMap: null })).toMatch(/quantileMap must be/);
		expect(rainSourcePeriodError({ ...PLAIN, quantileMap: { fromWaterYear: 2004, toWaterYear: 1990, wetDayMm: 1 } })).toMatch(/reference era of water years/);
		expect(rainSourcePeriodError({ ...PLAIN, quantileMap: { fromWaterYear: 1990, toWaterYear: 2004 } })).toMatch(/wet-day threshold must be 0\.1–10 mm/);
		expect(rainSourcePeriodError({ ...PLAIN, quantileMap: { fromWaterYear: 1990, toWaterYear: 2004, wetDayMm: 0 } })).toMatch(/wet-day threshold/);
		expect(rainSourcePeriodError({ ...PLAIN, quantileMap: { fromWaterYear: 1990, toWaterYear: 2004, wetDayMm: 11 } })).toMatch(/wet-day threshold/);
		expect(rainSourcePeriodError({ ...PLAIN, quantileMap: { ...MAPPED.quantileMap, season: true } })).toMatch(/quantileMap has unknown field season/);
		expect(rainSourceError([{ ...PLAIN, quantileMap: 'on' }])).toMatch(/^Rain-source period 1 quantileMap must be/);
		// The resolver keeps it, and only its fields.
		const w: string[] = [];
		expect(resolveRainSource([MAPPED], w)[0]!.quantileMap).toEqual({ fromWaterYear: 1990, toWaterYear: 2004, wetDayMm: 1 });
		expect(w).toEqual([]);
	});

	it('names the map in the settings diff and in the periods run comparison sets side by side', () => {
		expect(rainSourceText([PLAIN])).not.toMatch(/quantile/);
		expect(rainSourceText([MAPPED])).toMatch(/wet days \(≥ 1 mm\) quantile-mapped onto the catchment series 1990\/91–2004\/05 \(automatic station/);
		const diff = diffInputs({ settings: { rainSource: [PLAIN] } } as never, { settings: { rainSource: [MAPPED] } } as never);
		expect(JSON.stringify(diff)).toMatch(/quantile-mapped/);
		expect(rainSourceLines(plain().rainSource!.info)[0]).not.toMatch(/quantile/);
		expect(rainSourceLines(prepareRun(input([MAPPED])).rainSource!.info)[0]).toMatch(/; wet days \(≥ 1 mm\) quantile-mapped onto the primary catchment series over 1990\/91–2004\/05/);
	});
});

function plain() {
	return prepareRun(input([PLAIN]));
}
