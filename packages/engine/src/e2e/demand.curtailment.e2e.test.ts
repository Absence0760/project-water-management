// End-to-end: the curtailment table (docs/model.md §2.11) over a reporting
// window, from the demand and supply runModel produced, with the
// m³/day → l/s conversion and the basic-needs floor (§2.7f). No EWR, so
// every EWR column is 0 and the table is the equitable-share arithmetic
// alone. Invented names and values.
import { describe, expect, it } from 'vitest';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { runModel, withVerification } from '../run';

const DAY = 86_400_000;
const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const flat = (v: number) => new Array(12).fill(v);
/** A-pan = 100 mm × the days in each month (28.25 in February): 1 000 m² of factor-1 crop wants 100 m³/day every day. */
const APAN = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30].map((d) => d * 100);

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
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const village: DemandObject = {
	id: 'v',
	nodeId: 'B',
	name: 'Village (invented)',
	category: 'domestic',
	sizing: 'perUnit',
	monthlyM3Day: null,
	count: 1000,
	litresPerUnitDay: 100, // 100 m³/day
	population: 20_000, // floor 500 m³/day, capped each day at the demand: 100
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: ''
};

/**
 * A: 500 m² (50 m³/day), a dam far larger than it needs: always supplied.
 * B: 1 000 m² (100 m³/day) + the village (100 m³/day), no dam: never supplied.
 */
function input(settings: Record<string, unknown>, objects = true): ModelInput {
	const start = '2024-02-20';
	const days = 20;
	return {
		settings: { apanMm: APAN as never, ewrPragmaticM3PerDay: flat(0) as never, lakeEvapFactor: 0, effectiveRainStoreMm: 0, simulationStart: start, simulationEnd: '2024-03-10', ...settings },
		model: {
			nodes: [unit('A', { damCapacityM3: 1e9 }), unit('B'), unit('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0 })],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: [
				{ nodeId: 'A', cropId: 'c', areaM2: 500 },
				{ nodeId: 'B', cropId: 'c', areaM2: 1000 }
			],
			transfers: [],
			...(objects ? { demandObjects: [village] } : {})
		},
		series: { rain_catchment_mm: { startDate: start, values: new Array(days).fill(0) } }
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

describe('curtailment table end to end (§2.11)', () => {
	it('window means, the equitable share, reduce/gain in m³/day and l/s, and the totals', () => {
		const out = run(input({ reportStart: '2024-02-28', reportEnd: '2024-03-02' }, false));
		const c = out.summary.curtailment!;
		expect(c.reportStart).toBe('2024-02-28');
		expect(c.reportEnd).toBe('2024-03-02');
		// 28, 29 Feb, 1, 2 Mar: four days.
		expect(c.days).toBe(4);
		const a = c.farms.find((f) => f.nodeId === 'A')!;
		const b = c.farms.find((f) => f.nodeId === 'B')!;
		// H: A 50, B 100. I: A 50, B 0. K_tot = 50 ÷ 150.
		expect(a.demandM3Day).toBeCloseTo(50, 9);
		expect(b.demandM3Day).toBeCloseTo(100, 9);
		expect(a.suppliedM3Day).toBeCloseTo(50, 9);
		expect(b.suppliedM3Day).toBe(0);
		expect(c.equitableFraction).toBeCloseTo(1 / 3, 12);
		expect(a.targetM3Day).toBeCloseTo(50 / 3, 9);
		expect(b.targetM3Day).toBeCloseTo(100 / 3, 9);
		expect(a.reduceGainM3Day).toBeCloseTo(50 / 3 - 50, 9);
		expect(b.reduceGainM3Day).toBeCloseTo(100 / 3, 9);
		// l/s = m³/day ÷ 86.4.
		expect(a.reduceGainLs).toBeCloseTo((50 / 3 - 50) / 86.4, 12);
		expect(b.totalChangeLs).toBeCloseTo(100 / 3 / 86.4, 12);
		expect(a.fractionSupplied).toBeCloseTo(1, 12);
		expect(b.fractionSupplied).toBe(0);
		expect(a.targetFraction).toBeCloseTo(1 / 3, 12);
		// No EWR: S = N, U = MAX(M, 0), V = U ÷ H.
		expect(a.totalChangeM3Day).toBeCloseTo(a.reduceGainM3Day, 12);
		expect(b.volumeLeftM3Day).toBeCloseTo(100 / 3, 9);
		expect(b.fractionOfDemandLeft).toBeCloseTo(1 / 3, 12);
		// N sums to 0; the totals are plain sums.
		expect(Math.abs(c.totals.reduceGainM3Day)).toBeLessThan(1e-9);
		expect(c.totals.demandM3Day).toBeCloseTo(150, 9);
		expect(c.totals.suppliedM3Day).toBeCloseTo(50, 9);
		expect(c.totals.deficitM3Day).toBeCloseTo(-100, 9);
		// The farm rows agree with the daily series over the window.
		const from = epoch('2024-02-28') - epoch('2024-02-20');
		const mean = (v: number[]) => v.slice(from, from + 4).reduce((s, x) => s + x, 0) / 4;
		expect(a.demandM3Day).toBeCloseTo(mean(get(out, 'A', 'demand')), 12);
		expect(b.suppliedM3Day).toBeCloseTo(mean(get(out, 'B', 'supplied')), 12);
	});

	it('a basic-needs floor bounds the volume left from below and the total change, and reports what it held', () => {
		const out = run(input({}));
		const c = out.summary.curtailment!;
		expect(c.days).toBe(20);
		const b = c.farms.find((f) => f.nodeId === 'B')!;
		// H_A 50, H_B 200, I_A 50, I_B 0 → K_tot 0.2, M_B 40. B's floor: MIN(500, 100) = 100 m³/day.
		expect(c.equitableFraction).toBeCloseTo(0.2, 12);
		expect(b.targetM3Day).toBeCloseTo(40, 9);
		expect(b.basicNeedsM3Day).toBeCloseTo(100, 9);
		expect(b.volumeLeftM3Day).toBeCloseTo(100, 9);
		expect(b.basicNeedsHeldM3Day).toBeCloseTo(60, 9);
		// S = MAX(N, B − I) = MAX(40, 100) = 100.
		expect(b.totalChangeM3Day).toBeCloseTo(100, 9);
		expect(get(out, 'B', 'basic_needs').every((v) => Math.abs(v - 100) < 1e-9)).toBe(true);
		expect(c.totals.basicNeedsM3Day).toBeCloseTo(100, 9);
	});

	it('a window clipped to the run says so and covers the run’s days only', () => {
		const out = run(input({ reportStart: '2024-01-01', reportEnd: '2024-12-31' }, false));
		const c = out.summary.curtailment!;
		expect(c.reportStart).toBe('2024-02-20');
		expect(c.reportEnd).toBe('2024-03-10');
		expect(c.days).toBe(20);
		expect(out.summary.warnings.some((w) => /report/i.test(w) && /clip|outside|run/i.test(w))).toBe(true);
	});
});
