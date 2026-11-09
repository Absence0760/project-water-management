// The daily EWR at the outlet judged month by month (engine ≥ 1.116.0,
// docs/model.md §2.9h): hand-worked months, the part months left out, a
// forecast tail, the invariants on random series, and whole runs whose daily
// EWR comes from each source. vitest runs under a skewed TZ (CLAUDE.md rule
// 7, packages/engine/vitest.config.ts), so the month blocks are checked off
// the UTC calendar, not the machine's.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModelWith } from '../run';
import { assessDailyEwrMonths } from './dailyMonths';
import { blankEwrDailySource, type EwrDailySource } from './dailySource';

const DAY = 86_400;

describe('assessDailyEwrMonths: hand-worked months', () => {
	// 2001-01-15 … 2001-04-10: January and April are part months; February (28 days) and March (31) are whole.
	const start = '2001-01-15';
	const days = toEpochDay('2001-04-10') - toEpochDay(start) + 1;
	const feb = toEpochDay('2001-02-01') - toEpochDay(start);
	const mar = toEpochDay('2001-03-01') - toEpochDay(start);
	const ewr = new Array(days).fill(100);
	const sim = new Array(days).fill(0);
	// February: 120 m³ a day against 100 → met. March: 90 a day but one 400 m³ day → 30 × 90 + 400 = 3 100 = 31 × 100 → met at exactly R.
	for (let t = feb; t < mar; t++) sim[t] = 120;
	for (let t = mar; t < mar + 31; t++) sim[t] = 90;
	sim[mar + 10] = 400;

	it('assesses only the whole months, February and March, and judges each on its sums', () => {
		const r = assessDailyEwrMonths(start, days, ewr, sim);
		expect(r.months).toBe(2);
		expect(r.met).toBe(2);
		expect(r.rate).toBe(1);
		expect(r.deficitM3).toBe(0);
		expect(r.longestNotMetRun).toBe(0);
		const byMonth = Object.fromEntries(r.byMonth.map((m) => [m.month, m]));
		// Water-year order, October first.
		expect(r.byMonth.map((m) => m.month)).toEqual([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(byMonth[1]!.years).toBe(0);
		expect(byMonth[1]!.rate).toBeNull();
		expect(byMonth[1]!.meanRequiredM3s).toBeNull();
		expect(byMonth[4]!.years).toBe(0);
		expect(byMonth[2]).toMatchObject({ years: 1, met: 1, rate: 1, deficitM3: 0 });
		expect(byMonth[2]!.meanRequiredM3s).toBeCloseTo(100 / DAY, 15);
		expect(byMonth[2]!.meanSimulatedM3s).toBeCloseTo(120 / DAY, 15);
		expect(byMonth[3]!.meanSimulatedM3s).toBeCloseTo(3_100 / (31 * DAY), 15);
	});

	it('a short month counts its deficit, and consecutive short months make a run', () => {
		const low = sim.map(() => 50);
		const r = assessDailyEwrMonths(start, days, ewr, low);
		expect(r.met).toBe(0);
		expect(r.rate).toBe(0);
		expect(r.longestNotMetRun).toBe(2);
		// (100 − 50) × (28 + 31) days.
		expect(r.deficitM3).toBe(50 * 59);
		expect(r.byMonth.find((m) => m.month === 2)!.deficitM3).toBe(50 * 28);
	});

	it('a part month’s days change nothing', () => {
		const changed = [...sim];
		for (let t = 0; t < feb; t++) changed[t] = 0;
		for (let t = mar + 31; t < days; t++) changed[t] = 1e9;
		expect(assessDailyEwrMonths(start, days, ewr, changed)).toEqual(assessDailyEwrMonths(start, days, ewr, sim));
	});

	it('a month whose requirement is 0 is met, and counted as asking nothing', () => {
		const zero = ewr.map((v, t) => (t >= feb && t < mar ? 0 : v));
		const r = assessDailyEwrMonths(start, days, zero, sim.map(() => 0));
		expect(r.met).toBe(1);
		expect(r.zeroRequirementMonths).toBe(1);
		expect(r.byMonth.find((m) => m.month === 3)!.met).toBe(0);
	});

	it('a month a forecast tail starts inside isn’t assessed; one wholly in the tail is', () => {
		const r = assessDailyEwrMonths(start, days, ewr, sim, mar + 5);
		expect(r.byMonth.find((m) => m.month === 3)!.years).toBe(0);
		expect(r.months).toBe(1);
		expect(assessDailyEwrMonths(start, days, ewr, sim, mar).months).toBe(2);
	});

	it('no whole month: nothing assessed, rates null', () => {
		const r = assessDailyEwrMonths('2001-01-15', 20, new Array(20).fill(1), new Array(20).fill(0));
		expect(r).toMatchObject({ months: 0, met: 0, rate: null, deficitM3: 0, longestNotMetRun: 0, zeroRequirementMonths: 0 });
	});
});

describe('assessDailyEwrMonths: invariants on random series', () => {
	it('more flow never loses a month; the EWR itself as the flow meets every month', () => {
		const rng = new Rng(4242);
		for (let k = 0; k < 40; k++) {
			const start = `200${rng.int(0, 9)}-0${rng.int(1, 9)}-${String(rng.int(1, 28)).padStart(2, '0')}`;
			const days = rng.int(1, 900);
			const ewr = Array.from({ length: days }, () => (rng.bool(0.1) ? 0 : rng.float(0, 1e5)));
			const sim = Array.from({ length: days }, () => rng.float(0, 1.2e5));
			const more = sim.map((v) => v + rng.float(0, 5e4));
			const a = assessDailyEwrMonths(start, days, ewr, sim);
			const b = assessDailyEwrMonths(start, days, ewr, more);
			expect(b.met).toBeGreaterThanOrEqual(a.met);
			expect(b.deficitM3).toBeLessThanOrEqual(a.deficitM3 + 1e-6);
			const self = assessDailyEwrMonths(start, days, ewr, ewr);
			expect(self.met).toBe(self.months);
			expect(a.byMonth.reduce((s, m) => s + m.years, 0)).toBe(a.months);
			expect(a.byMonth.reduce((s, m) => s + m.met, 0)).toBe(a.met);
		}
	});
});

// A whole run: out (gauge) ← a (a dam, irrigating). Invented numbers.
const START = '2000-10-01';
const DAYS = toEpochDay('2002-09-30') - toEpochDay(START) + 1;
const natural = Array.from({ length: DAYS }, (_, t) => 20_000 + 15_000 * Math.sin(t / 29));

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

function network(ewrDailySource: EwrDailySource | null): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: new Array(12).fill(5_000) as never, apanMm: new Array(12).fill(200) as never, ewrDailySource },
		model: {
			nodes: [node('out', { kind: 'gauge' }), node('a', { downstreamNodeId: 'out', areaKm2: 3, damCapacityM3: 200_000, pctRunoffToDam: 0.8, damInitialPct: 0.5 }), node('b', { downstreamNodeId: 'out' })],
			crops: [{ id: 'c', name: 'crop', cropFactor: new Array(12).fill(1) }],
			cropAreas: [{ nodeId: 'a', cropId: 'c', areaM2: 80_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: new Array(DAYS).fill(0) } }
	};
}

describe('a run’s summary.ewrDailyMonths follows the daily EWR in use', () => {
	const run = (src: EwrDailySource | null) => runModelWith(network(src), () => ({ naturalFlowM3Day: natural }));
	const col = (out: ReturnType<typeof run>, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)!.values;

	it('is the run’s own `ewr` and outflow series judged by month, for the pragmatic EWR and the TAB file alike', () => {
		const tab: EwrDailySource = { ...blankEwrDailySource(), method: 'tab', scaling: 'area', tabM3s: new Array(12).fill(0.2), tableAreaKm2: 4 };
		for (const src of [null, tab]) {
			const out = run(src);
			expect(out.summary.ewrDailyMonths).toEqual(assessDailyEwrMonths(out.startDate, out.days, col(out, 'ewr'), col(out, 'simulated_outflow')));
			expect(out.summary.ewrDailyMonths!.months).toBe(24);
		}
		// The TAB file asks 0.2 m³/s (17 280 m³ a day at s = 1), far more than the pragmatic 5 000: fewer months met.
		const t = run(tab);
		expect(t.summary.ewrDailyMonths!.met).toBeGreaterThan(0);
		expect(t.summary.ewrDailyMonths!.met).toBeLessThan(run(null).summary.ewrDailyMonths!.met);
		expect(t.summary.ewrDailyMonths!.byMonth[0]!.meanRequiredM3s).toBeCloseTo(0.2 * t.summary.catchment.outletEwr!.scale, 9);
	});
});
