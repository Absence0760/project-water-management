// End-to-end: the CHIRPS fallback and its bias correction (docs/model.md
// §2.4b), through runModel on invented catchments. The expected factors are
// worked out here by hand (Σ catchment ÷ Σ CHIRPS per calendar month on the
// shared days, the 90-day / 50 mm minimum, pooled fallback, 0.25–4 clamp).
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { prepareRun } from '../prepare';
import { fromEpochDay, toEpochDay } from '../calendar';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const NODE = {
	sortOrder: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0
};
function catchment(series: ModelInput['series'], settings: Record<string, unknown> = {}): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, gr4j: { warmupDays: 0 }, ...settings } as unknown as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Outlet gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				{ ...NODE, id: 'F', name: 'Unit A', kind: 'farm', downstreamNodeId: 'G', areaKm2: 10 }
			] as never,
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series
	};
}
const col = (out: ModelOutput, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)?.values;
const monthOf = (day: number) => Number(fromEpochDay(day).slice(5, 7));

/** CHIRPS on epoch day d: always wet (no zero runs), 1–7 mm. */
const chirpsOn = (d: number) => 1 + (((d % 7) + 7) % 7);

/** Days from..to inclusive (ISO) as epoch days. */
function span(from: string, to: string): number[] {
	const a = toEpochDay(from);
	const b = toEpochDay(to);
	return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

describe('CHIRPS bias factors, worked by hand', () => {
	// Four water years 2018/19 … 2021/22 of CHIRPS; catchment = f(month) × CHIRPS, with a gap at the end.
	const days = span('2018-10-01', '2022-09-30');
	const f = (m: number) => 0.5 + 0.25 * m; // Jan 0.75 … Dec 3.5
	const gapFrom = toEpochDay('2022-07-01');

	it('each month own factor = Σ catchment ÷ Σ CHIRPS; gap days get CHIRPS × the month factor; catchment days are untouched', () => {
		const ch = days.map(chirpsOn);
		const c = days.map((d) => (d >= gapFrom ? null : f(monthOf(d)) * chirpsOn(d)));
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2018-10-01', values: c as never }, rain_chirps_mm: { startDate: '2018-10-01', values: ch } }));
		const corr = out.summary.chirpsCorrection!;
		for (let m = 1; m <= 12; m++) {
			expect(corr.months[m - 1]!.source).toBe('month');
			expect(corr.months[m - 1]!.factor).toBeCloseTo(f(m), 12);
		}
		const used = col(out, 'rain_used')!;
		const src = col(out, 'rain_source')!;
		for (let t = 0; t < days.length; t++) {
			const d = days[t]!;
			if (d >= gapFrom) {
				expect(used[t]).toBeCloseTo(chirpsOn(d) * f(monthOf(d)), 12);
				expect(src[t]).toBe(2);
			} else {
				expect(used[t]).toBeCloseTo(c[t]!, 12);
				expect(src[t]).toBe(0);
			}
		}
		expect(corr.fallbackDays).toBe(days.length - (gapFrom - days[0]!));
		expect(corr.correctedDays).toBe(corr.fallbackDays);
		// rain_chirps_corrected is CHIRPS × factor on every day, not only the gap.
		const cc = col(out, 'rain_chirps_corrected')!;
		expect(cc[0]).toBeCloseTo(chirpsOn(days[0]!) * f(10), 12);
	});

	it('a month short of 90 shared days takes the pooled factor; one above 4 is clamped; 29 Feb fills with the February factor', () => {
		// Catchment exists in February only in 2019 (28 days < 90) and reads 5× CHIRPS in December (clamped to 4).
		const fx = (m: number) => (m === 12 ? 5 : m === 2 ? 1.7 : 1.25);
		const c = days.map((d) => {
			const m = monthOf(d);
			if (m === 2 && !fromEpochDay(d).startsWith('2019-')) return null;
			return fx(m) * chirpsOn(d);
		});
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2018-10-01', values: c as never }, rain_chirps_mm: { startDate: '2018-10-01', values: days.map(chirpsOn) } }));
		const corr = out.summary.chirpsCorrection!;
		let sc = 0;
		let sh = 0;
		days.forEach((d, i) => {
			if (c[i] != null) {
				sc += c[i]!;
				sh += chirpsOn(d);
			}
		});
		const pooled = sc / sh;
		expect(corr.pooled.factor).toBeCloseTo(pooled, 12);
		expect(corr.months[1]!.source).toBe('pooled');
		expect(corr.months[1]!.factor).toBeCloseTo(pooled, 12);
		expect(corr.months[11]!.ownFactor).toBeCloseTo(5, 12);
		expect(corr.months[11]!.factor).toBe(4);
		expect(corr.months[11]!.clamped).toBe(true);
		const used = col(out, 'rain_used')!;
		const leap = toEpochDay('2020-02-29') - days[0]!;
		expect(used[leap]).toBeCloseTo(chirpsOn(toEpochDay('2020-02-29')) * pooled, 12);
	});

	it('the factors come from the whole stored record: a shorter simulation window gives the same gap rain', () => {
		const c = days.map((d) => (d >= gapFrom ? null : f(monthOf(d)) * chirpsOn(d)));
		const series = { rain_catchment_mm: { startDate: '2018-10-01', values: c as never }, rain_chirps_mm: { startDate: '2018-10-01', values: days.map(chirpsOn) } };
		const whole = runModel(catchment(series));
		const short = runModel(catchment(series, { simulationStart: '2022-08-15', simulationEnd: '2022-08-31' }));
		const off = toEpochDay('2022-08-15') - days[0]!;
		const a = col(whole, 'rain_used')!.slice(off, off + 17);
		expect(col(short, 'rain_used')).toEqual(a);
	});

	it("mode 'none' leaves CHIRPS raw; too little overlap leaves it raw and warns", () => {
		const c = days.map((d) => (d >= gapFrom ? null : 2 * chirpsOn(d)));
		const none = runModel(catchment({ rain_catchment_mm: { startDate: '2018-10-01', values: c as never }, rain_chirps_mm: { startDate: '2018-10-01', values: days.map(chirpsOn) } }, { chirpsBiasCorrection: 'none' }));
		const t = gapFrom - days[0]!;
		expect(col(none, 'rain_used')![t]).toBe(chirpsOn(gapFrom));
		// 60 shared days only: no own, no pooled factor.
		const few = days.slice(0, 200).map((d, i) => (i < 60 ? 2 * chirpsOn(d) : null));
		const raw = runModel(catchment({ rain_catchment_mm: { startDate: '2018-10-01', values: few as never }, rain_chirps_mm: { startDate: '2018-10-01', values: days.slice(0, 200).map(chirpsOn) } }));
		expect(col(raw, 'rain_used')![100]).toBe(chirpsOn(days[100]!));
		expect(raw.summary.chirpsCorrection!.pooled.factor).toBeNull();
	});

	it('listed fit ranges: each range fits on its own years; a gap year between them takes the nearer range, the later on a tie', () => {
		// WY 2010–2012 read 1.5 × CHIRPS, WY 2016–2018 read 3 ×; WY 2013–2015 are a gap.
		const all = span('2010-10-01', '2019-09-30');
		const wyOf = (d: number) => (monthOf(d) >= 10 ? Number(fromEpochDay(d).slice(0, 4)) : Number(fromEpochDay(d).slice(0, 4)) - 1);
		const c = all.map((d) => {
			const wy = wyOf(d);
			return wy <= 2012 ? 1.5 * chirpsOn(d) : wy >= 2016 ? 3 * chirpsOn(d) : null;
		});
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: '2010-10-01', values: c as never }, rain_chirps_mm: { startDate: '2010-10-01', values: all.map(chirpsOn) } },
				{
					chirpsFitPeriod: [
						{ fromWaterYear: 2010, toWaterYear: 2012, reason: 'invented era one' },
						{ fromWaterYear: 2016, toWaterYear: 2018, reason: 'invented era two' }
					]
				}
			)
		);
		const used = col(out, 'rain_used')!;
		const at = (iso: string) => used[toEpochDay(iso) - all[0]!]!;
		expect(at('2014-01-15')).toBeCloseTo(1.5 * chirpsOn(toEpochDay('2014-01-15')), 12); // WY 2013: nearer the first
		expect(at('2015-01-15')).toBeCloseTo(3 * chirpsOn(toEpochDay('2015-01-15')), 12); // WY 2014: tie → later
		expect(at('2016-01-15')).toBeCloseTo(3 * chirpsOn(toEpochDay('2016-01-15')), 12); // WY 2015: nearer the second
	});
});

describe('the CHIRPS fallback and the zero / missing / negative readings', () => {
	it('a zero catchment reading blocks the fallback; a listed missing period sets it aside and is left out of the fit', () => {
		const days = span('2018-10-01', '2022-09-30');
		const c = days.map((d) => 2 * chirpsOn(d));
		// A wildly wrong "missing" stretch: 10 × CHIRPS for a month. Listed missing → out of the fit, and filled.
		const bad0 = toEpochDay('2020-03-01');
		const bad1 = toEpochDay('2020-03-31');
		for (let d = bad0; d <= bad1; d++) c[d - days[0]!] = 10 * chirpsOn(d);
		const z = toEpochDay('2021-05-10');
		c[z - days[0]!] = 0;
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: '2018-10-01', values: c }, rain_chirps_mm: { startDate: '2018-10-01', values: days.map(chirpsOn) } },
				{ zeroRainRuns: { mode: 'missing', keepDry: [], missing: [{ start: '2020-03-01', end: '2020-03-31', reason: 'invented logger fault' }] } }
			)
		);
		const corr = out.summary.chirpsCorrection!;
		expect(corr.months[2]!.factor).toBeCloseTo(2, 12);
		const used = col(out, 'rain_used')!;
		expect(used[z - days[0]!]).toBe(0);
		expect(used[bad0 + 4 - days[0]!]).toBeCloseTo(2 * chirpsOn(bad0 + 4), 12);
		const flag = col(out, 'rain_catchment_missing')!;
		expect(flag[bad0 - days[0]!]).toBe(1);
		expect(flag[bad0 - 1 - days[0]!]).toBe(0);
	});

	it('forecast fills only a day with neither catchment nor CHIRPS, and is never bias-corrected', () => {
		const days = span('2018-10-01', '2022-09-30');
		const c = days.map((d) => 2 * chirpsOn(d));
		const n = days.length;
		c[n - 1] = null as never;
		const ch: (number | null)[] = days.map(chirpsOn);
		ch[n - 1] = null;
		const fc = [7, 7, 7];
		const out = runModel(
			catchment({ rain_catchment_mm: { startDate: '2018-10-01', values: c }, rain_chirps_mm: { startDate: '2018-10-01', values: ch as never }, rain_forecast_mm: { startDate: fromEpochDay(days[n - 2]!), values: fc } })
		);
		const used = col(out, 'rain_used')!;
		expect(out.days).toBe(n + 1);
		expect(used[n - 2]).toBe(c[n - 2]); // catchment wins over forecast
		expect(used[n - 1]).toBe(7); // forecast, raw (no ×2)
		expect(used[n]).toBe(7);
	});
});

describe('CHIRPS quantile map (opt-in), whole-month totals', () => {
	it('every whole calendar month of gap days keeps exactly the factor-corrected total; drizzle goes dry', () => {
		// 4 years: catchment wet ~1 day in 4 with heavier falls, CHIRPS wet every day with drizzle; same monthly total × 1.
		const days = span('2016-10-01', '2020-09-30');
		const c: number[] = [];
		const ch: number[] = [];
		for (const d of days) {
			const k = ((d % 4) + 4) % 4;
			c.push(k === 0 ? 12 + (d % 5) : 0);
			ch.push(k === 0 ? 6 + (d % 5) / 2 : 2 + (d % 3));
		}
		// Gap: the whole of WY 2019/20's January and February.
		const g0 = toEpochDay('2020-01-01');
		const g1 = toEpochDay('2020-02-29');
		const cg: (number | null)[] = c.map((v, i) => (days[i]! >= g0 && days[i]! <= g1 ? null : v));
		const series = { rain_catchment_mm: { startDate: '2016-10-01', values: cg as never }, rain_chirps_mm: { startDate: '2016-10-01', values: ch } };
		const off = runModel(catchment(series));
		const on = runModel(catchment(series, { chirpsQuantileMap: { wetDayMm: 1 } }));
		const uOff = col(off, 'rain_used')!;
		const uOn = col(on, 'rain_used')!;
		const sum = (a: number[], i0: number, i1: number) => a.slice(i0, i1 + 1).reduce((s, v) => s + v, 0);
		const jan0 = g0 - days[0]!;
		const jan1 = toEpochDay('2020-01-31') - days[0]!;
		const feb1 = g1 - days[0]!;
		expect(sum(uOn, jan0, jan1)).toBeCloseTo(sum(uOff, jan0, jan1), 8);
		expect(sum(uOn, jan1 + 1, feb1)).toBeCloseTo(sum(uOff, jan1 + 1, feb1), 8);
		// Map is monotone within the month: order of the wet days kept.
		const jan = uOff.slice(jan0, jan1 + 1).map((v, i) => [v, uOn[jan0 + i]!] as const);
		for (const [a1, b1] of jan) for (const [a2, b2] of jan) if (a1 < a2) expect(b1).toBeLessThanOrEqual(b2 + 1e-12);
		// Some drizzle went dry.
		expect(uOn.slice(jan0, feb1 + 1).some((v) => v === 0)).toBe(true);
		const qm = on.summary.chirpsCorrection!.quantileMap!;
		expect(qm.mappedMm).toBeCloseTo(qm.factorOnlyMm, 8);
	});

	it('the latest calendar month the CHIRPS record covers only in part is left to the factor alone (partialMonthDays)', () => {
		const days = span('2016-10-01', '2020-09-15'); // September 2020 is partial
		const c: (number | null)[] = [];
		const ch: number[] = [];
		for (const d of days) {
			const k = ((d % 4) + 4) % 4;
			c.push(d >= toEpochDay('2020-09-01') ? null : k === 0 ? 12 + (d % 5) : 0);
			ch.push(k === 0 ? 6 + (d % 5) / 2 : 2 + (d % 3));
		}
		const on = runModel(catchment({ rain_catchment_mm: { startDate: '2016-10-01', values: c as never }, rain_chirps_mm: { startDate: '2016-10-01', values: ch } }, { chirpsQuantileMap: { wetDayMm: 1 } }));
		const qm = on.summary.chirpsCorrection!.quantileMap!;
		expect(qm.partialMonthDays).toBe(15);
		const used = col(on, 'rain_used')!;
		const f = on.summary.chirpsCorrection!.months[8]!.factor!;
		const t = toEpochDay('2020-09-10') - days[0]!;
		expect(used[t]).toBeCloseTo(ch[t]! * f, 12);
	});
});

describe('CHIRPS quantile map: months the record covers in part', () => {
	const mk = (from: string, to: string, chFrom: string, trailingNulls = 0) => {
		const days = span(from, to);
		const c: (number | null)[] = days.map((d) => (((d % 4) + 4) % 4 === 0 ? 12 + (d % 5) : 0));
		const chDays = span(chFrom, to);
		const ch: (number | null)[] = chDays.map((d) => (((d % 4) + 4) % 4 === 0 ? 6 + (d % 5) / 2 : 2 + (d % 3)));
		for (let k = 0; k < trailingNulls; k++) ch[ch.length - 1 - k] = null;
		return { days, c, ch, chDays };
	};

	it('the first month, when CHIRPS starts mid-month, is left to the factor alone', () => {
		const { days, c, ch, chDays } = mk('2016-10-01', '2020-09-30', '2016-10-15');
		const g = toEpochDay('2016-10-20');
		c[g - days[0]!] = null;
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2016-10-01', values: c as never }, rain_chirps_mm: { startDate: '2016-10-15', values: ch as never } }, { chirpsQuantileMap: { wetDayMm: 1 } }));
		const f = out.summary.chirpsCorrection!.months[9]!.factor!;
		expect(col(out, 'rain_used')![g - days[0]!]).toBeCloseTo(ch[g - chDays[0]!]! * f, 12);
		expect(out.summary.chirpsCorrection!.quantileMap!.partialMonthDays).toBe(1);
	});

	it('nulls stored to the end of the last month do not make it whole', () => {
		const { days, c, ch, chDays } = mk('2016-10-01', '2020-09-30', '2016-10-01', 5);
		const g = toEpochDay('2020-09-10');
		c[g - days[0]!] = null;
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2016-10-01', values: c as never }, rain_chirps_mm: { startDate: '2016-10-01', values: ch as never } }, { chirpsQuantileMap: { wetDayMm: 1 } }));
		const f = out.summary.chirpsCorrection!.months[8]!.factor!;
		expect(col(out, 'rain_used')![g - days[0]!]).toBeCloseTo(ch[g - chDays[0]!]! * f, 12);
		expect(out.summary.chirpsCorrection!.quantileMap!.partialMonthDays).toBe(1);
	});
});

describe('prepareRun aligns CHIRPS to a window that starts or ends on a month boundary', () => {
	it('a run window starting on 1 Oct and ending 30 Sep covers every day once', () => {
		const days = span('2018-10-01', '2022-09-30');
		const prep = prepareRun(catchment({ rain_chirps_mm: { startDate: '2018-10-01', values: days.map(chirpsOn) } }, { simulationStart: '2019-10-01', simulationEnd: '2020-09-30' }));
		expect(prep.days).toBe(366);
		expect(prep.aligned('rain_chirps_mm')[0]).toBe(chirpsOn(toEpochDay('2019-10-01')));
		expect(prep.aligned('rain_chirps_mm')[365]).toBe(chirpsOn(toEpochDay('2020-09-30')));
	});
});
