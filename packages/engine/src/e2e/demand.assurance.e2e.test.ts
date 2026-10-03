// End-to-end: the assurance-of-supply summary (docs/model.md §2.11a) read
// back against the daily demand and supplied series it summarises, on a
// unit whose dam runs dry on a known day in a leap water year. Invented
// names and values.
//
// Unit A wants exactly 100 m³/day every day (crop factor 1 on 1 000 m², the
// monthly A-pan = 100 mm × the days in the month, 28.25 in February), from
// a dam holding 100 × N + 50 m³ and getting nothing more: fully supplied for
// N days, 50 m³ on day N, nothing after.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { runModel, withVerification } from '../run';

const DAY = 86_400_000;
const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const flat = (v: number) => new Array(12).fill(v);
const APAN = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30].map((d) => d * 100);
const wyOf = (day: number) => {
	const d = new Date(day * DAY);
	return d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

function unit(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 1,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 1,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const START = '2019-08-01';
const END = '2021-11-30';
const DAYS = epoch(END) - epoch(START) + 1;
const DRY = '2020-06-14'; // the day the dam runs out (gets 50 of 100)
const N = epoch(DRY) - epoch(START);

function input(settings: Record<string, unknown> = {}): ModelInput {
	return {
		settings: {
			apanMm: APAN as never,
			ewrPragmaticM3PerDay: flat(0) as never,
			lakeEvapFactor: 0,
			effectiveRainStoreMm: 0,
			simulationStart: START,
			simulationEnd: END,
			...settings
		},
		model: {
			nodes: [unit('A', { damCapacityM3: 100 * N + 50 }), unit('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0 })],
			crops: [{ id: 'c', name: 'Lucerne (invented)', cropFactor: flat(1) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 1000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: new Array(DAYS).fill(0) } }
	};
}

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
function run(i: ModelInput): ModelOutput {
	const out = withVerification(i, runModel(i));
	if (!out.summary.verification) throw new Error('no self-checks ran');
	const bad = out.summary.verification.checks.filter((c) => !c.passed);
	if (bad.length) throw new Error(`self-check failed: ${JSON.stringify(bad).slice(0, 2000)}`);
	return out;
}

describe('assurance of supply from the daily series (§2.11a)', () => {
	it('the demand and supply are what the set-up says', () => {
		const out = run(input());
		const D = get(out, 'A', 'demand');
		const G = get(out, 'A', 'supplied');
		expect(D.every((d) => Math.abs(d - 100) < 1e-9)).toBe(true);
		expect(G[N - 1]).toBeCloseTo(100, 9);
		expect(G[N]).toBeCloseTo(50, 9);
		expect(G[N + 1]).toBe(0);
	});

	it('time-based, volumetric, annual (complete water years only), resilience and vulnerability over the whole run', () => {
		const out = run(input({ assuranceAnnualThreshold: 0.6 }));
		const r = out.summary.supplyAssurance!.reliability.find((x) => x.nodeId === 'A')!;
		expect(r.demandDays).toBe(DAYS);
		expect(r.metDays).toBe(N);
		expect(r.timeReliability).toBeCloseTo(N / DAYS, 12);
		expect(r.demandM3).toBeCloseTo(100 * DAYS, 6);
		expect(r.suppliedM3).toBeCloseTo(100 * N + 50, 6);
		expect(r.volumetricReliability).toBeCloseTo((100 * N + 50) / (100 * DAYS), 12);
		// Complete water years: 2019/20 (366 days, leap) and 2020/21; Aug–Sep 2019 and Oct–Nov 2021 are part years.
		expect(r.waterYears).toBe(2);
		expect(r.partWaterYears).toBe(2);
		// 2019/20: 1 Oct 2019 … 13 Jun 2020 in full (257 days) + 50 m³: 25 750 ÷ 36 600 = 0.7036 ≥ 0.6. 2020/21: 0.
		const full1920 = epoch(DRY) - epoch('2019-10-01');
		expect(full1920).toBe(257);
		expect((100 * full1920 + 50) / 36_600).toBeGreaterThan(0.6);
		expect(r.waterYearsMet).toBe(1);
		expect(r.annualReliability).toBeCloseTo(0.5, 12);
		// One failure run, from the dry day to the end.
		expect(r.failureRuns).toBe(1);
		expect(r.longestFailureDays).toBe(DAYS - N);
		expect(r.meanFailureDays).toBe(DAYS - N);
		expect(r.maxFailureDeficitM3).toBeCloseTo(100 * (DAYS - N) - 50, 6);
	});

	it('a reporting window that holds no complete water year has no annual figure; its sums are the window’s', () => {
		const out = run(input({ reportStart: '2020-01-01', reportEnd: '2020-12-31' }));
		const a = out.summary.supplyAssurance!;
		expect(a.reportStart).toBe('2020-01-01');
		expect(a.reportEnd).toBe('2020-12-31');
		expect(a.days).toBe(366);
		const r = a.reliability.find((x) => x.nodeId === 'A')!;
		const from = epoch('2020-01-01') - epoch(START);
		const G = get(out, 'A', 'supplied').slice(from, from + 366);
		expect(r.demandM3).toBeCloseTo(36_600, 6);
		expect(r.suppliedM3).toBeCloseTo(G.reduce((s, v) => s + v, 0), 6);
		expect(r.metDays).toBe(epoch(DRY) - epoch('2020-01-01'));
		expect(r.waterYears).toBe(0);
		expect(r.annualReliability).toBeNull();
	});

	it('the monthly stress classes follow Σ G ÷ Σ D per water-year month over the whole run', () => {
		const out = run(input());
		const st = out.summary.supplyAssurance!.stress;
		const grid = st.nodes.find((g) => g.nodeId === 'A');
		expect(grid).toBeTruthy();
		const D = get(out, 'A', 'demand');
		const G = get(out, 'A', 'supplied');
		const d0 = epoch(START);
		const wy0 = wyOf(d0);
		const sums = new Map<string, [number, number]>();
		for (let t = 0; t < DAYS; t++) {
			const m = (new Date((d0 + t) * DAY).getUTCMonth() + 1 + 2) % 12;
			const k = `${wyOf(d0 + t) - wy0}:${m}`;
			const s = sums.get(k) ?? [0, 0];
			s[0] += G[t]!;
			s[1] += D[t]!;
			sums.set(k, s);
		}
		expect(st.waterYears).toEqual([2018, 2019, 2020, 2021]);
		for (const [k, [g, d]] of sums) {
			const [row, col] = k.split(':').map(Number) as [number, number];
			expect(grid!.ratio[row]![col]).toBeCloseTo(g / d, 12);
		}
		// June 2020: 13 full days + 50 m³ of 30 days' demand → 0.45 → Critical.
		expect(grid!.ratio[1]![8]).toBeCloseTo((13 * 100 + 50) / 3000, 12);
		// A month outside the run has no ratio.
		expect(grid!.ratio[0]![0]).toBeNull();
		expect(grid!.stressClass[1]![8]).toBe('critical');
		// With one demand node the system grid is the node's.
		expect(st.system.ratio).toEqual(grid!.ratio);
	});
});
