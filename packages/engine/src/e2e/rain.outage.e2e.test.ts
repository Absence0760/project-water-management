// End-to-end: blank days, logger outages and multi-day accumulations
// (docs/model.md §2.4d, engine ≥ 1.70.0, Q31 in issue #90, issue #393),
// through runModel on invented catchments. A blank stretch counts towards an
// accumulation only up to 7 days; a longer one is an outage that ends the
// run, and a ≥ 20 mm reading straight after one that passes the CHIRPS tests
// is set aside as missing. Expected rain is worked out here from the rules.
//
// The background: catchment = ratio(month) × CHIRPS on every ordinary day, so
// every CHIRPS factor is exactly ratio(month) as long as the suspect days stay
// out of the fit, and a filled day reads ratio(month) × CHIRPS exactly.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
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
const D0 = toEpochDay('2015-10-01');
const DAYS = toEpochDay('2020-09-30') - D0 + 1;
/** Summer-rainfall CHIRPS (Nov–Mar wet), never 0. */
const h = (d: number) => {
	const m = monthOf(d);
	const k = ((d % 5) + 5) % 5;
	return m >= 11 || m <= 3 ? 3 + k : 0.5 + 0.25 * (k % 3);
};
/** Catchment / CHIRPS ratio by calendar month. */
const ratio = (m: number) => (m === 9 ? 1.5 : m === 12 ? 2 : m === 1 ? 1.4 : 1.2);
const zrs = (over: Record<string, unknown> = {}) => ({ zeroRainRuns: { mode: 'missing', keepDry: [], missing: [], ...over } });

type V = number | null;
/**
 * A record whose catchment reads `gap` from `from` (each entry 'B' blank or 0)
 * and then `readingMm` on the next day, the reading day. CHIRPS is 0.1 on the
 * reading day and the days either side (dry, under a quarter of any reading
 * here), and h + 4 on the gap days but the last (it saw the rain).
 */
function fixture(from: string, gap: ('B' | 0)[], readingMm: number) {
	const a = toEpochDay(from);
	const r = a + gap.length;
	const ch: number[] = Array.from({ length: DAYS }, (_, i) => h(D0 + i));
	for (let d = a; d < r - 1; d++) ch[d - D0] = h(d) + 4;
	for (const d of [r - 1, r, r + 1]) ch[d - D0] = 0.1;
	const c: V[] = Array.from({ length: DAYS }, (_, i) => ratio(monthOf(D0 + i)) * ch[i]!);
	gap.forEach((g, k) => (c[a + k - D0] = g === 'B' ? null : 0));
	c[r - D0] = readingMm;
	const series = { rain_catchment_mm: { startDate: fromEpochDay(D0), values: c as never }, rain_chirps_mm: { startDate: fromEpochDay(D0), values: ch } };
	/** Bias-corrected CHIRPS on a day, as the fill and the spreading read it. */
	const fill = (d: number) => ratio(monthOf(d)) * ch[d - D0]!;
	return { a, r, c, ch, series, fill, t: (d: number) => d - D0 };
}
const B = 'B' as const;
const blanks = (n: number) => new Array<'B'>(n).fill(B);
const zeros = (n: number) => new Array<0>(n).fill(0);
const sumUsed = (out: ModelOutput, from: number, to: number) => {
	const u = col(out, 'rain_used')!;
	let s = 0;
	for (let d = from; d <= to; d++) s += u[d - D0]!;
	return s;
};

describe('the holiday gauge: unread for two weeks over Christmas, the total read on 3 January', () => {
	// 14 blank days 2017-12-20 … 2018-01-02, then the gauge's 90 mm on 2018-01-03.
	const f = fixture('2017-12-20', blanks(14), 90);
	const out = runModel(catchment(f.series));

	it('the reading is set aside: the 15 days get the CHIRPS fill and nothing else (no double count, no 90 mm storm)', () => {
		const acc = out.summary.rainAccumulation!;
		expect(acc.windows).toHaveLength(1);
		expect(acc.windows[0]).toMatchObject({ start: '2018-01-03', end: '2018-01-03', status: 'setAside', outageDays: 14, readingMm: 90 });
		let fill = 0;
		for (let d = f.a; d <= f.r; d++) {
			fill += f.fill(d);
			expect(col(out, 'rain_used')![f.t(d)]).toBeCloseTo(f.fill(d), 12);
			expect(col(out, 'rain_source')![f.t(d)]).toBe(2);
		}
		// The window's rain is the CHIRPS fill exactly: the 90 mm is not added on top of it.
		expect(sumUsed(out, f.a, f.r)).toBeCloseTo(fill, 10);
		// The fill (~223 mm here) is far more than the gauge's 90 mm: an unread gauge loses catch, and the run trusts CHIRPS over it.
		expect(fill).toBeGreaterThan(90);
		expect(acc.windows[0]!.usedMm).toBeCloseTo(ratio(1) * 0.1, 12);
	});

	it('it stays out of the CHIRPS fit: January and December factors are exactly their ratios', () => {
		const corr = out.summary.chirpsCorrection!;
		expect(corr.months[0]!.factor).toBeCloseTo(ratio(1), 12);
		expect(corr.months[11]!.factor).toBeCloseTo(ratio(12), 12);
		expect(corr.accumulationDaysLeftOut).toBe(1);
	});

	it('the run warns, naming the reading, the outage and what stood in for it', () => {
		const w = out.summary.warnings.find((x) => x.includes('after a blank outage set aside as missing'))!;
		expect(w).toContain('2018-01-03 (90 mm read after 14 blank days; 0 mm used instead)');
		expect(w).toContain('more than 7 blank days');
		// Nothing was spread, and no zero run was set aside: §2.4c is not involved.
		expect(col(out, 'rain_catchment_spread')).toBeUndefined();
		expect(out.summary.zeroRainInfill?.days ?? 0).toBe(0);
	});

	it('keepReadings keeps it as one day\'s rain: the 90 mm runs on its day and joins the fit (January moves off 1.4)', () => {
		const kept = runModel(catchment(f.series, zrs({ keepReadings: [{ start: '2018-01-03', end: '2018-01-03', reason: 'invented: farm records a storm' }] })));
		expect(kept.summary.rainAccumulation!.windows[0]!.status).toBe('kept');
		expect(col(kept, 'rain_used')![f.t(f.r)]).toBe(90);
		expect(kept.summary.chirpsCorrection!.months[0]!.factor).toBeGreaterThan(ratio(1));
		expect(kept.summary.warnings.some((x) => x.includes('after a blank outage set aside'))).toBe(false);
	});

	it('addAccumulations spreads it over the days the modeller lists, in proportion to bias-corrected CHIRPS, adding up to 90', () => {
		const listed = runModel(catchment(f.series, zrs({ addAccumulations: [{ start: '2017-12-20', end: '2018-01-03', reason: 'invented: observer away, station log' }] })));
		const acc = listed.summary.rainAccumulation!;
		expect(acc.windows.map((w) => [w.source, w.status])).toEqual([['listed', 'spread']]);
		let W = 0;
		for (let d = f.a; d <= f.r; d++) W += f.fill(d);
		for (let d = f.a; d <= f.r; d++) expect(col(listed, 'rain_used')![f.t(d)]).toBeCloseTo((90 * f.fill(d)) / W, 10);
		expect(sumUsed(listed, f.a, f.r)).toBeCloseTo(90, 10);
		expect(col(listed, 'rain_catchment_spread')![f.t(f.a)]).toBe(1);
	});

	it("mode 'asRecorded': the reading stays on its day, the outage is still CHIRPS-filled, and the run says that may count it twice", () => {
		const rec = runModel(catchment(f.series, zrs({ accumulationMode: 'asRecorded' })));
		expect(col(rec, 'rain_used')![f.t(f.r)]).toBe(90);
		expect(col(rec, 'rain_used')![f.t(f.a)]).toBeCloseTo(f.fill(f.a), 12);
		expect(rec.summary.warnings.find((x) => x.includes('run as recorded'))).toContain('may be counted twice (2018-01-03)');
	});

	it('the stored series is never changed', () => {
		const before = structuredClone(f.series);
		runModel(catchment(f.series));
		expect(f.series).toEqual(before);
	});

	it('a run that starts on the reading day fills it the same way', () => {
		const part = runModel(catchment(f.series, { simulationStart: '2018-01-03', simulationEnd: '2018-01-31' }));
		expect(col(part, 'rain_used')![0]).toBeCloseTo(col(out, 'rain_used')![f.t(f.r)]!, 12);
	});
});

describe('7 blank days count, 8 break the window (ACC_MAX_BLANK_DAYS)', () => {
	it('7 blanks then 40 mm: one 8-day window, spread by CHIRPS × factor, adding up to 40', () => {
		const f = fixture('2017-12-27', blanks(7), 40);
		const out = runModel(catchment(f.series));
		const acc = out.summary.rainAccumulation!;
		expect(acc.windows.map((w) => [w.start, w.end, w.status, w.outageDays])).toEqual([['2017-12-27', '2018-01-03', 'spread', null]]);
		let W = 0;
		for (let d = f.a; d <= f.r; d++) W += f.fill(d);
		for (let d = f.a; d <= f.r; d++) expect(col(out, 'rain_used')![f.t(d)]).toBeCloseTo((40 * f.fill(d)) / W, 10);
		expect(sumUsed(out, f.a, f.r)).toBeCloseTo(40, 10);
		const spread = col(out, 'rain_catchment_spread')!;
		for (let d = f.a - 1; d <= f.r + 1; d++) expect(spread[f.t(d)]).toBe(d >= f.a && d <= f.r ? 1 : 0);
		expect(acc.spreadDays).toBe(8);
	});

	it('8 blanks then 40 mm: set aside, the 9 days CHIRPS-filled', () => {
		const f = fixture('2017-12-26', blanks(8), 40);
		const out = runModel(catchment(f.series));
		expect(out.summary.rainAccumulation!.windows.map((w) => [w.end, w.status, w.outageDays])).toEqual([['2018-01-03', 'setAside', 8]]);
		for (let d = f.a; d <= f.r; d++) expect(col(out, 'rain_used')![f.t(d)]).toBeCloseTo(f.fill(d), 12);
	});

	it('zeros and short blank stretches mixed (5 + 0 + 5 + 0 0): one window over all 13 days', () => {
		const f = fixture('2017-12-22', [...blanks(5), 0, ...blanks(5), 0, 0], 60);
		const out = runModel(catchment(f.series));
		expect(out.summary.rainAccumulation!.windows.map((w) => [w.start, w.status])).toEqual([['2017-12-22', 'spread']]);
		expect(sumUsed(out, f.a, f.r)).toBeCloseTo(60, 10);
	});
});

describe('a long outage, then days of 0 or blank, then the reading', () => {
	it('5 days after a 30-day outage: the window is those 5 days and the reading; the outage is CHIRPS-filled', () => {
		const f = fixture('2017-12-01', [...blanks(30), ...zeros(5)], 50);
		const out = runModel(catchment(f.series));
		const w0 = f.r - 5;
		expect(out.summary.rainAccumulation!.windows.map((w) => [w.start, w.end, w.status, w.runDays])).toEqual([[fromEpochDay(w0), '2018-01-05', 'spread', 5]]);
		let W = 0;
		for (let d = w0; d <= f.r; d++) W += f.fill(d);
		for (let d = w0; d <= f.r; d++) expect(col(out, 'rain_used')![f.t(d)]).toBeCloseTo((50 * f.fill(d)) / W, 10);
		expect(sumUsed(out, w0, f.r)).toBeCloseTo(50, 10);
		const spread = col(out, 'rain_catchment_spread')!;
		const source = col(out, 'rain_source')!;
		for (let d = f.a; d < w0; d++) {
			expect(col(out, 'rain_used')![f.t(d)]).toBeCloseTo(f.fill(d), 12);
			expect(spread[f.t(d)]).toBe(0);
			expect(source[f.t(d)]).toBe(2);
		}
	});

	it('2 days after it: no window and nothing set aside; the reading stays on its day and the zeros stay 0', () => {
		const f = fixture('2017-12-01', [...blanks(30), ...zeros(2)], 50);
		const out = runModel(catchment(f.series));
		// The 50 mm (2 January) stays in the fit, so January's factor moves off 1.4; the outage's last day (30 December) reads December's.
		const months = out.summary.chirpsCorrection!.months;
		expect(months[0]!.factor!).toBeGreaterThan(ratio(1));
		const dec = months[11]!.factor!;
		expect(out.summary.rainAccumulation?.windows ?? []).toEqual([]);
		expect(col(out, 'rain_used')![f.t(f.r)]).toBe(50);
		expect(col(out, 'rain_used')![f.t(f.r - 1)]).toBe(0);
		expect(col(out, 'rain_used')![f.t(f.r - 2)]).toBe(0);
		expect(col(out, 'rain_used')![f.t(f.r - 3)]).toBeCloseTo(dec * f.ch[f.t(f.r - 3)]!, 12);
		expect(out.summary.warnings.some((x) => x.includes('accumulation') || x.includes('blank outage'))).toBe(false);
	});

	it('an outage in the middle of a flagged zero run: §2.4c fills the zeros before it, CHIRPS the outage, the window takes the zeros after it', () => {
		// 70 zeros (Nov–Jan, flagged: 60+ wet-season days), 10 blanks, 20 zeros, then 80 mm.
		const f = fixture('2017-11-01', [...zeros(70), ...blanks(10), ...zeros(20)], 80);
		const out = runModel(catchment(f.series));
		const w0 = f.r - 20;
		expect(out.summary.rainAccumulation!.windows.map((w) => [w.start, w.status])).toEqual([[fromEpochDay(w0), 'spread']]);
		expect(sumUsed(out, w0, f.r)).toBeCloseTo(80, 10);
		const miss = col(out, 'rain_catchment_missing')!;
		const spread = col(out, 'rain_catchment_spread')!;
		for (let d = f.a; d < f.a + 70; d++) {
			expect(miss[f.t(d)]).toBe(1);
			expect(spread[f.t(d)]).toBe(0);
			expect(col(out, 'rain_used')![f.t(d)]).toBeCloseTo(f.fill(d), 12);
		}
		for (let d = f.a + 70; d < w0; d++) {
			expect(miss[f.t(d)]).toBe(0); // blank, not a zero: CHIRPS fills it as any blank day
			expect(col(out, 'rain_used')![f.t(d)]).toBeCloseTo(f.fill(d), 12);
		}
		for (let d = w0; d <= f.r; d++) {
			expect(miss[f.t(d)]).toBe(0);
			expect(spread[f.t(d)]).toBe(1);
		}
		expect(out.summary.zeroRainInfill!.days).toBe(70);
	});

	it('listing a window day as missing still drops the detection (the listed period wins)', () => {
		const f = fixture('2017-12-01', [...blanks(30), ...zeros(5)], 50);
		const out = runModel(catchment(f.series, zrs({ missing: [{ start: '2018-01-02', end: '2018-01-02', reason: 'invented: bad day' }] })));
		expect(out.summary.rainAccumulation?.windows ?? []).toEqual([]);
		expect(col(out, 'rain_used')![f.t(f.r)]).toBe(50);
	});
});

describe('property: random outages in a 5-year record (40 seeds)', () => {
	/** A small seeded generator (mulberry32), local so the fixture never moves. */
	const rng = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) >>> 0;
		let t = seed;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	it('every spread window adds up to its recorded total, holds no day above it, set-aside days read the CHIRPS fill, other days are untouched', () => {
		let spreads = 0;
		let asides = 0;
		for (let seed = 1; seed <= 40; seed++) {
			const g = rng(seed);
			const ch: number[] = Array.from({ length: DAYS }, (_, i) => h(D0 + i));
			const c: V[] = Array.from({ length: DAYS }, (_, i) => ratio(monthOf(D0 + i)) * ch[i]!);
			// Ten gaps of zeros and blanks, each ended by a reading CHIRPS was nearly dry around.
			for (let k = 0; k < 10; k++) {
				const len = 3 + Math.floor(g() * 40);
				const a = 400 + k * 140 + Math.floor(g() * 60);
				const r = a + len;
				for (let i = a; i < r; i++) c[i] = g() < 0.5 ? null : 0;
				// Often a long blank stretch: at the gap's start (a window may follow it) or its end (the reading ends it).
				const kind = g();
				const long = 8 + Math.floor(g() * 20);
				if (kind < 0.35) for (let i = a; i < Math.min(r, a + long); i++) c[i] = null;
				else if (kind < 0.7) for (let i = Math.max(a, r - long); i < r; i++) c[i] = null;
				for (const i of [r - 1, r, r + 1]) ch[i] = 0.05;
				c[r] = 20 + g() * 100;
			}
			const series = { rain_catchment_mm: { startDate: fromEpochDay(D0), values: c as never }, rain_chirps_mm: { startDate: fromEpochDay(D0), values: ch } };
			const before = structuredClone(series);
			const out = runModel(catchment(series));
			expect(series).toEqual(before);
			const used = col(out, 'rain_used')!;
			const corr = out.summary.chirpsCorrection!;
			const fill = (i: number) => corr.months[monthOf(D0 + i) - 1]!.factor! * ch[i]!;
			const inWindow = new Uint8Array(DAYS);
			for (const w of out.summary.rainAccumulation!.windows) {
				const a = toEpochDay(w.start) - D0;
				const r = toEpochDay(w.end) - D0;
				for (let i = a; i <= r; i++) inWindow[i] = 1;
				if (w.status === 'setAside') {
					asides++;
					expect(a).toBe(r);
					expect(used[r]).toBeCloseTo(fill(r), 9);
					expect(w.usedMm).toBeCloseTo(fill(r), 9);
					continue;
				}
				expect(w.status, `seed ${seed}`).toBe('spread');
				spreads++;
				let s = 0;
				for (let i = a; i <= r; i++) {
					expect(used[i]).toBeLessThanOrEqual(w.totalMm + 1e-9);
					s += used[i]!;
				}
				expect(s, `seed ${seed} ${w.start}`).toBeCloseTo(w.totalMm, 9);
			}
			// Ordinary readings run as recorded; blanks outside every window read the CHIRPS fill (no zero runs here are flagged: all < 60 days).
			for (let i = 0; i < DAYS; i++) {
				if (inWindow[i]) continue;
				const v = c[i];
				if (v === null) expect(used[i]).toBeCloseTo(fill(i), 9);
				else if (out.summary.zeroRainInfill?.days === 0) expect(used[i]).toBe(v);
			}
		}
		expect(spreads).toBeGreaterThan(50);
		expect(asides).toBeGreaterThan(30);
	});
});
