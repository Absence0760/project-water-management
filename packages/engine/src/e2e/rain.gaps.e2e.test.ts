// End-to-end: zero-rain runs treated as missing (docs/model.md §2.4c) and
// multi-day accumulations (§2.4d), through runModel on invented catchments.
// Expected rain is worked out here from the documented rules.
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
const span = (from: string, to: string) => {
	const a = toEpochDay(from);
	return Array.from({ length: toEpochDay(to) - a + 1 }, (_, i) => a + i);
};
/** Summer-rainfall CHIRPS (Nov–Mar wet), never 0. */
const h = (d: number) => {
	const m = monthOf(d);
	const k = ((d % 5) + 5) % 5;
	return m >= 11 || m <= 3 ? 3 + k : 0.5 + 0.25 * (k % 3);
};
/** Catchment / CHIRPS ratio by calendar month. */
const ratio = (m: number) => (m === 9 ? 1.5 : m === 12 ? 2 : 1.2);

describe('zero-rain runs (§2.4c)', () => {
	const days = span('2015-10-01', '2020-09-30');
	const z0 = toEpochDay('2018-11-10');
	const z1 = toEpochDay('2019-01-31'); // 83 zero days in the wet season
	const base = days.map((d) => (d >= z0 && d <= z1 ? 0 : ratio(monthOf(d)) * h(d)));
	const series = { rain_catchment_mm: { startDate: fromEpochDay(days[0]!), values: base }, rain_chirps_mm: { startDate: fromEpochDay(days[0]!), values: days.map(h) } };

	it("mode 'missing' (default): a flagged wet-season zero run is filled from CHIRPS × factor, and its days stay out of the fit", () => {
		const out = runModel(catchment(series));
		const used = col(out, 'rain_used')!;
		const miss = col(out, 'rain_catchment_missing')!;
		const corr = out.summary.chirpsCorrection!;
		// Factors exact: every shared day but the flagged ones reads ratio × CHIRPS.
		for (const m of [11, 12, 1]) expect(corr.months[m - 1]!.factor).toBeCloseTo(ratio(m), 12);
		for (let d = z0; d <= z1; d++) {
			const t = d - days[0]!;
			expect(miss[t]).toBe(1);
			expect(used[t]).toBeCloseTo(ratio(monthOf(d)) * h(d), 12);
		}
		expect(miss[z0 - 1 - days[0]!]).toBe(0);
		expect(miss[z1 + 1 - days[0]!]).toBe(0);
		expect(out.summary.zeroRainInfill!.days).toBe(z1 - z0 + 1);
		// Its days are out of the fit: one by one, or with their whole water year when that year reads low vs CHIRPS.
		const wy = 2018;
		if (corr.excludedWaterYears.includes(wy)) expect(corr.lowVsChirpsYears).toContain(wy);
		else expect(corr.flaggedDaysLeftOut).toBe(z1 - z0 + 1);
	});

	it("mode 'asRecorded' runs them dry; a keep-dry period keeps its part dry and the rest is filled", () => {
		const rec = runModel(catchment(series, { zeroRainRuns: { mode: 'asRecorded', keepDry: [], missing: [] } }));
		const used = col(rec, 'rain_used')!;
		for (let d = z0; d <= z1; d++) expect(used[d - days[0]!]).toBe(0);
		const kd = runModel(catchment(series, { zeroRainRuns: { mode: 'missing', keepDry: [{ start: '2018-11-10', end: '2018-12-31', reason: 'invented: observer confirms dry' }], missing: [] } }));
		const u2 = col(kd, 'rain_used')!;
		expect(u2[toEpochDay('2018-12-31') - days[0]!]).toBe(0);
		const j = toEpochDay('2019-01-01');
		expect(u2[j - days[0]!]).toBeCloseTo(ratio(1) * h(j), 12);
	});

	it('a simulation window that starts inside a flagged run still fills its in-window days (runs come from the whole record)', () => {
		const out = runModel(catchment(series, { simulationStart: '2019-01-15', simulationEnd: '2019-02-15' }));
		const used = col(out, 'rain_used')!;
		const d = toEpochDay('2019-01-15');
		expect(used[0]).toBeCloseTo(ratio(1) * h(d), 12);
		expect(used[17]).toBeCloseTo(ratio(2) * h(d + 17), 12); // 1 Feb: a recorded reading again
	});
});

describe('the keep-dry guard (§2.4b)', () => {
	const days = span('2015-10-01', '2020-09-30');
	const d0 = days[0]!;
	const k0 = toEpochDay('2018-12-01');
	const k1 = toEpochDay('2019-02-03'); // 65 wet-season days of zeros, flagged
	const keepDry = { mode: 'missing', keepDry: [{ start: '2018-12-01', end: '2019-02-03', reason: 'invented: observer says dry' }], missing: [] };

	it('kept-dry days that CHIRPS rains heavily on are doubted: their water year leaves the fit, the days still run dry', () => {
		const c = days.map((d) => (d >= k0 && d <= k1 ? 0 : ratio(monthOf(d)) * h(d)));
		const out = runModel(catchment({ rain_catchment_mm: { startDate: fromEpochDay(d0), values: c }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: days.map(h) } }, { zeroRainRuns: keepDry }));
		const corr = out.summary.chirpsCorrection!;
		expect(corr.doubtfulKeepDry!.length).toBe(1);
		expect(corr.doubtfulKeepDry![0]!.waterYears).toEqual([2018]);
		expect(corr.excludedWaterYears).toContain(2018);
		for (const m of [12, 1, 2]) expect(corr.months[m - 1]!.factor).toBeCloseTo(ratio(m), 12);
		const used = col(out, 'rain_used')!;
		for (let d = k0; d <= k1; d++) expect(used[d - d0]).toBe(0);
	});

	it('kept-dry days CHIRPS barely rains on stay in the fit as confirmed zeros', () => {
		const ch = days.map((d) => (d >= k0 && d <= k1 ? 0.2 : h(d)));
		const c = days.map((d) => (d >= k0 && d <= k1 ? 0 : ratio(monthOf(d)) * h(d)));
		const out = runModel(catchment({ rain_catchment_mm: { startDate: fromEpochDay(d0), values: c }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: ch } }, { zeroRainRuns: keepDry }));
		const corr = out.summary.chirpsCorrection!;
		expect(corr.doubtfulKeepDry!.length).toBe(0);
		expect(corr.keptDryDaysInFit).toBe(k1 - k0 + 1);
		// December by hand: every December shared day is in the fit.
		let sc = 0;
		let sh = 0;
		days.forEach((d, i) => {
			if (monthOf(d) !== 12) return;
			sc += c[i]!;
			sh += ch[i]!;
		});
		expect(corr.months[11]!.factor).toBeCloseTo(sc / sh, 12);
	});
});

describe('multi-day accumulations (§2.4d)', () => {
	// Background: catchment = ratio × CHIRPS every day (no zeros), so the final factors are exact.
	const days = span('2015-10-01', '2020-09-30');
	const d0 = days[0]!;
	/** CHIRPS with a dry reading day ±1 and a wet run before it. */
	function withWindow(runFrom: string, reading: string, readingMm: number) {
		const a = toEpochDay(runFrom);
		const r = toEpochDay(reading);
		const ch = days.map(h);
		for (let d = a; d < r - 1; d++) ch[d - d0] = h(d) + 4; // CHIRPS saw the rain the gauge didn't read
		for (const d of [r - 1, r, r + 1]) ch[d - d0] = 0.1;
		const c: (number | null)[] = days.map((d) => ratio(monthOf(d)) * h(d));
		for (let d = a; d < r; d++) c[d - d0] = 0;
		c[a + 2 - d0] = null; // a blank day inside the run counts like a zero
		c[r - d0] = readingMm;
		c[r + 1 - d0] = ratio(monthOf(r + 1)) * 0.1; // keeps the day after on the month's ratio
		return { ch, c, a, r };
	}

	it('a window across the water-year boundary (Sep → Oct) is spread by CHIRPS × each month factor and sums to the reading', () => {
		const { ch, c, a, r } = withWindow('2017-09-24', '2017-10-06', 60);
		const out = runModel(catchment({ rain_catchment_mm: { startDate: fromEpochDay(d0), values: c as never }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: ch } }));
		const acc = out.summary.rainAccumulation!;
		expect(acc.windows.length).toBe(1);
		expect(acc.windows[0]!.start).toBe('2017-09-24');
		expect(acc.windows[0]!.end).toBe('2017-10-06');
		const used = col(out, 'rain_used')!;
		const w = (d: number) => ch[d - d0]! * ratio(monthOf(d));
		let sumW = 0;
		for (let d = a; d <= r; d++) sumW += w(d);
		let total = 0;
		for (let d = a; d <= r; d++) {
			total += used[d - d0]!;
			if (d < r) expect(used[d - d0]).toBeCloseTo((60 * w(d)) / sumW, 10);
		}
		expect(total).toBeCloseTo(60, 10);
		// The window's days are out of the fit, so September's and October's factors stay exact.
		expect(out.summary.chirpsCorrection!.months[8]!.factor).toBeCloseTo(1.5, 12);
		expect(out.summary.chirpsCorrection!.months[9]!.factor).toBeCloseTo(1.2, 12);
		const spread = col(out, 'rain_catchment_spread')!;
		expect(spread[a - d0]).toBe(1);
		expect(spread[a - 1 - d0]).toBe(0);
	});

	it('a window across the calendar-year boundary (Dec → Jan) keeps its total; the run is not also filled as a zero run', () => {
		const { ch, c, a, r } = withWindow('2017-12-20', '2018-01-05', 90);
		const out = runModel(catchment({ rain_catchment_mm: { startDate: fromEpochDay(d0), values: c as never }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: ch } }));
		const used = col(out, 'rain_used')!;
		let total = 0;
		for (let d = a; d <= r; d++) total += used[d - d0]!;
		expect(total).toBeCloseTo(90, 10);
		expect(out.summary.zeroRainInfill?.days ?? 0).toBe(0);
	});

	it("mode 'asRecorded' leaves the reading on its day; keepReadings keeps a detection as recorded", () => {
		const { ch, c, a, r } = withWindow('2017-12-20', '2018-01-05', 90);
		const series = { rain_catchment_mm: { startDate: fromEpochDay(d0), values: c as never }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: ch } };
		const rec = runModel(catchment(series, { zeroRainRuns: { mode: 'missing', keepDry: [], missing: [], accumulationMode: 'asRecorded' } }));
		const u = col(rec, 'rain_used')!;
		expect(u[r - d0]).toBe(90);
		expect(u[a - d0]).toBe(0);
		const kept = runModel(catchment(series, { zeroRainRuns: { mode: 'missing', keepDry: [], missing: [], keepReadings: [{ start: '2018-01-05', end: '2018-01-05', reason: 'invented thunderstorm' }] } }));
		expect(col(kept, 'rain_used')![r - d0]).toBe(90);
	});

	it('a window that starts before the run window: only its in-run days are used, at the whole-window shares', () => {
		const { ch, c, a, r } = withWindow('2017-12-20', '2018-01-05', 90);
		const series = { rain_catchment_mm: { startDate: fromEpochDay(d0), values: c as never }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: ch } };
		const whole = runModel(catchment(series));
		const part = runModel(catchment(series, { simulationStart: '2018-01-01', simulationEnd: '2018-01-31' }));
		const s = toEpochDay('2018-01-01');
		for (let d = s; d <= r; d++) expect(col(part, 'rain_used')![d - s]).toBeCloseTo(col(whole, 'rain_used')![d - d0]!, 12);
		expect(a).toBeLessThan(s);
	});

	it('a zero run longer than 92 days ending in an accumulation: the window takes the last 92 days, the zero-run fill the rest, no double count', () => {
		const ch = days.map(h);
		const c: number[] = days.map((d) => ratio(monthOf(d)) * h(d));
		const a = toEpochDay('2017-11-01');
		const r = toEpochDay('2018-03-01');
		for (const d of [r - 1, r, r + 1]) ch[d - d0] = 0.1;
		for (let d = a; d < r; d++) c[d - d0] = 0;
		c[r - d0] = 150;
		const out = runModel(catchment({ rain_catchment_mm: { startDate: fromEpochDay(d0), values: c }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: ch } }));
		const used = col(out, 'rain_used')!;
		const from = r - 92;
		let win = 0;
		for (let d = from; d <= r; d++) win += used[d - d0]!;
		expect(win).toBeCloseTo(150, 9);
		for (let d = a; d < from; d++) expect(used[d - d0]).toBeCloseTo(ratio(monthOf(d)) * h(d), 12);
		const miss = col(out, 'rain_catchment_missing')!;
		expect(miss[from - 1 - d0]).toBe(1);
		expect(miss[from - d0]).toBe(0);
	});
});

describe('accumulation detection thresholds, at their edges (§2.4d table)', () => {
	// A 30-day record: too little overlap for any CHIRPS factor, so detection reads raw CHIRPS (factor 1).
	function run(catchmentHead: number[], chirpsHead: number[]) {
		const c = [...catchmentHead, ...new Array(30 - catchmentHead.length).fill(1)];
		const ch = [...chirpsHead, ...new Array(30 - chirpsHead.length).fill(1)];
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2020-01-01', values: c }, rain_chirps_mm: { startDate: '2020-01-01', values: ch } }));
		return { out, windows: out.summary.rainAccumulation?.windows ?? [], used: col(out, 'rain_used')! };
	}

	it('20 mm after 3 zero days, CHIRPS 50 % over the run and < 25 % near the reading: detected and spread', () => {
		const { windows, used } = run([0, 0, 0, 20, 0.5], [5, 5, 4.9, 0, 0.09]);
		expect(windows.length).toBe(1);
		expect(windows[0]!.status).toBe('spread');
		const w = [5, 5, 4.9, 0];
		const s = 14.9;
		for (let t = 0; t < 3; t++) expect(used[t]).toBeCloseTo((20 * w[t]!) / s, 12);
		expect(used[0]! + used[1]! + used[2]! + used[3]!).toBeCloseTo(20, 12);
	});

	it('not detected: near-reading CHIRPS exactly 25 %, run CHIRPS just under 50 %, a reading just under 20 mm, or only 2 zero days', () => {
		expect(run([0, 0, 0, 20, 0.5], [5, 5, 4.9, 0, 0.1]).windows.length).toBe(0);
		expect(run([0, 0, 0, 20, 0.5], [5, 4.99, 4.9, 0, 0.09]).windows.length).toBe(0);
		expect(run([0, 0, 0, 19.99, 0.5], [5, 5, 4.9, 0, 0.09]).windows.length).toBe(0);
		expect(run([1, 0, 0, 20, 0.5], [5, 5, 4.9, 0, 0.09]).windows.length).toBe(0);
	});

	it('a reading day without a CHIRPS value is never judged', () => {
		const c = [0, 0, 0, 20, ...new Array(26).fill(1)];
		const ch: (number | null)[] = [5, 5, 4.9, null, 0.09, ...new Array(25).fill(1)];
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2020-01-01', values: c }, rain_chirps_mm: { startDate: '2020-01-01', values: ch as never } }));
		expect(out.summary.rainAccumulation?.windows ?? []).toEqual([]);
	});
});
