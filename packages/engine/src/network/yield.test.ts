import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { firmYield, prepareYield, storageYieldCapacities, storageYieldCurve, yieldPatternDaily } from './yield';

const zeros = new Array(12).fill(0) as unknown as Monthly;

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
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
		damSeepagePerDay: 0,
		...over
	};
}

/** One dam taking all of a constant natural flow, full at the start, no losses, draining to a gauge. */
function singleDam(inflow: number, cap: number, days: number, over: Partial<NetworkNode> = {}): { input: ModelInput; natural: number[] } {
	const input: ModelInput = {
		settings: { ewrPragmaticM3PerDay: zeros },
		model: {
			nodes: [
				node('dam', { downstreamNodeId: 'g', pctRunoffToDam: 1, damCapacityM3: cap, damInitialPct: 1, irrigationEfficiency: 0.8, ...over }),
				node('g', { kind: 'gauge', areaKm2: 0 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2001-10-01', values: new Array(days).fill(0) } }
	};
	return { input, natural: new Array(days).fill(inflow) };
}

describe('firmYield', () => {
	it('a single dam with a constant inflow: yield = inflow + capacity ÷ days, within the tolerance', () => {
		const days = 3 * 365;
		const { input, natural } = singleDam(100, 36_500, days);
		const p = prepareYield(input, () => ({ naturalFlowM3Day: natural }));
		const tol = 0.001;
		const y = firmYield(p, 'dam', { tolerance: tol });
		const analytic = 100 + 36_500 / days;
		expect(y.yieldM3Day).toBeLessThanOrEqual(analytic * (1 + 1e-9));
		expect(y.yieldM3Day).toBeGreaterThanOrEqual(analytic * (1 - tol));
		expect(y.failureDays).toBe(0);
		expect(y.failsAtM3Day!).toBeLessThanOrEqual(y.yieldM3Day * (1 + tol) + 1e-6);
		expect(y.boundM3Day).toBeCloseTo(analytic, 9);
		expect(y.yieldM3Year).toBeCloseTo(y.yieldM3Day * 365.25, 6);
		expect(y.probes).toBeLessThan(30);
	});

	it('at capacity 0 the yield is the smallest daily inflow', () => {
		const days = 400;
		const { input } = singleDam(0, 10_000, days);
		const natural = Array.from({ length: days }, (_, t) => 50 + 40 * Math.sin(t / 20));
		const p = prepareYield(input, () => ({ naturalFlowM3Day: natural }));
		const y = firmYield(p, 'dam', { capacityM3: 0, tolerance: 1e-4 });
		const min = Math.min(...natural);
		expect(y.yieldM3Day).toBeLessThanOrEqual(min * (1 + 1e-9));
		expect(y.yieldM3Day).toBeGreaterThan(min * (1 - 1e-4));
	});

	it('scales the draft by a monthly pattern, normalised to a mean of 1 over the record', () => {
		const days = 365;
		const { input, natural } = singleDam(100, 0, days);
		const p = prepareYield(input, () => ({ naturalFlowM3Day: natural }));
		// Twice as much in Oct–Mar as in Apr–Sep.
		const pattern = [2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
		const daily = yieldPatternDaily(p, 'dam', pattern);
		expect(daily.reduce((a, b) => a + b, 0) / days).toBeCloseTo(1, 12);
		// Without storage the peak month's draft is the binding one: yield × max factor = inflow.
		const y = firmYield(p, 'dam', { pattern, tolerance: 1e-5 });
		expect(y.yieldM3Day * Math.max(...daily)).toBeCloseTo(100, 1);
		expect(y.yieldM3Day * Math.max(...daily)).toBeLessThanOrEqual(100 * (1 + 1e-9));
	});

	it('refuses an all-zero pattern, a bad assurance and a gauge', () => {
		const { input, natural } = singleDam(100, 1000, 30);
		const p = prepareYield(input, () => ({ naturalFlowM3Day: natural }));
		expect(() => firmYield(p, 'dam', { pattern: new Array(12).fill(0) })).toThrow(/zero in every month/);
		expect(() => firmYield(p, 'dam', { pattern: 'demand' })).toThrow(/no irrigation demand/);
		expect(() => firmYield(p, 'dam', { assurance: 0.2 })).toThrow(/assurance/);
		expect(() => firmYield(p, 'g')).toThrow(/farm or dam/);
		expect(() => firmYield(p, 'nope')).toThrow(/not found/);
	});

	it('a lower assurance never gives a lower yield, and fails at most (1 − p) of the water years', () => {
		const days = 10 * 365;
		const { input } = singleDam(0, 5_000, days);
		// A dry spell in years 3 and 7 only.
		const natural = Array.from({ length: days }, (_, t) => (Math.floor(t / 365) % 4 === 3 && t % 365 > 200 ? 5 : 80));
		const p = prepareYield(input, () => ({ naturalFlowM3Day: natural }));
		const firm = firmYield(p, 'dam');
		const at80 = firmYield(p, 'dam', { assurance: 0.8 });
		expect(at80.yieldM3Day).toBeGreaterThanOrEqual(firm.yieldM3Day);
		expect(at80.failedYears).toBeLessThanOrEqual(Math.floor(0.2 * p.years + 1e-9));
		expect(at80.yieldM3Day).toBeGreaterThan(firm.yieldM3Day * 1.5);
	});

	it('reports progress after each probe', () => {
		const { input, natural } = singleDam(100, 1000, 100);
		const seen: number[] = [];
		firmYield(prepareYield(input, () => ({ naturalFlowM3Day: natural })), 'dam', { onProbe: (d) => seen.push(d) });
		expect(seen.length).toBeGreaterThan(3);
		expect(seen).toEqual(seen.map((_, k) => k + 1));
	});
});

describe('storageYieldCurve', () => {
	it('11 capacities from 0 to 2× the dam, yield non-decreasing, the analytic line at each', () => {
		const days = 2 * 365;
		const { input, natural } = singleDam(40, 20_000, days);
		const curve = storageYieldCurve(prepareYield(input, () => ({ naturalFlowM3Day: natural })), 'dam');
		expect(curve.points.map((q) => q.capacityM3)).toEqual(storageYieldCapacities(20_000));
		expect(curve.points).toHaveLength(11);
		expect(curve.points.at(-1)!.capacityM3).toBe(40_000);
		expect(curve.monotone).toBe(true);
		for (const q of curve.points) {
			const analytic = 40 + q.capacityM3 / days;
			expect(q.yieldM3Day).toBeGreaterThanOrEqual(analytic * (1 - 0.001));
			expect(q.yieldM3Day).toBeLessThanOrEqual(analytic * (1 + 1e-9));
		}
	});

	it('scales a survey curve with the dam (WP-3.5): a linear curve resizes exactly like the power law with exponent 1', () => {
		const days = 2 * 365;
		const cap = 20_000;
		const areaFull = 8_000;
		const evap = { apanMm: new Array(12).fill(200) as unknown as Monthly, lakeEvapFactor: 0.75 };
		const withEvap = (over: Partial<NetworkNode>) => {
			const { input, natural } = singleDam(40, cap, days, over);
			input.settings = { ...input.settings, ...evap };
			return storageYieldCurve(prepareYield(input, () => ({ naturalFlowM3Day: natural })), 'dam', { points: 5 });
		};
		const power = withEvap({ damAreaFullM2: areaFull, damAreaExponent: 1 });
		const curve = withEvap({
			damAreaFullM2: 0,
			damCurve: [
				{ levelM: 0, areaM2: 0, volumeM3: 0 },
				{ levelM: 3, areaM2: areaFull, volumeM3: cap }
			]
		});
		const lossless = withEvap({});
		for (let k = 0; k < power.points.length; k++) {
			const [a, b] = [power.points[k]!, curve.points[k]!];
			expect(b.capacityM3).toBe(a.capacityM3);
			expect(b.yieldM3Day).toBeCloseTo(a.yieldM3Day, 6);
			expect(b.boundM3Day).toBeCloseTo(a.boundM3Day, 9);
			// The curve's surface evaporates: every dam above capacity 0 yields less than a lossless one.
			if (k > 0) expect(b.yieldM3Day).toBeLessThan(lossless.points[k]!.yieldM3Day);
		}
	});

	it('refuses a node with no dam', () => {
		const { input, natural } = singleDam(40, 0, 50);
		expect(() => storageYieldCurve(prepareYield(input, () => ({ naturalFlowM3Day: natural })), 'dam')).toThrow(/capacity above 0/);
	});
});
