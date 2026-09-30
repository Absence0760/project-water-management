// Assurance of supply, stress classes and the water account (WP-3.4,
// docs/model.md §2.11a–b): hand-worked cases, so every number below can be
// redone on paper.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModelWith, withVerification } from '../run';
import { checkReliability, checkWaterAccount } from '../testing/invariants';
import { stressClassOf, supplyAssurance, type SupplyAssuranceInput } from './reliability';

const zeros = (n: number) => new Array<number>(n).fill(0);

/**
 * One farm over six days that cross the water-year boundary: 29 and 30
 * September 2001 (water year 2000), then 1–4 October (water year 2001).
 */
function pure(): SupplyAssuranceInput {
	const days = 6;
	return {
		startDate: '2001-09-29',
		days,
		window: { from: 0, to: days - 1, reportStart: '2001-09-29', reportEnd: '2001-10-04' },
		annualThreshold: 0.7,
		demandNodes: [{ nodeId: 'A', name: 'Farm A', kind: 'farm', demand: [10, 10, 0, 10, 10, 10], supplied: [10, 5, 0, 10, 0, 4] }],
		accountNodes: [],
		natural: zeros(days),
		outflow: zeros(days),
		rainMm: null,
		areaKm2: null,
		sites: []
	};
}

describe('reliability (hand-worked)', () => {
	it('time-based, volumetric and annual reliability, resilience and vulnerability', () => {
		const [r] = supplyAssurance(pure()).reliability;
		// Demand days: all but day 2 (5); fully met: days 0 and 3.
		expect(r!.demandDays).toBe(5);
		expect(r!.metDays).toBe(2);
		expect(r!.timeReliability).toBe(0.4);
		// Σ supplied 29 / Σ demand 50.
		expect(r!.volumetricReliability).toBe(29 / 50);
		// Failure runs: day 1 (deficit 5; the no-demand day 2 ends it), then days 4–5 (10 + 6).
		expect(r!.failureRuns).toBe(2);
		expect(r!.meanFailureDays).toBe(1.5);
		expect(r!.longestFailureDays).toBe(2);
		expect(r!.meanFailureDeficitM3).toBe(10.5);
		expect(r!.maxFailureDeficitM3).toBe(16);
		// Both water years are part years (engine ≥ 1.11.0): the annual measure counts neither.
		expect(r!.waterYears).toBe(0);
		expect(r!.partWaterYears).toBe(2);
		expect(r!.waterYearsMet).toBe(0);
		expect(r!.annualReliability).toBeNull();
		// By month: September (index 11) 1 of 2 days, October (index 0) 1 of 3.
		expect(r!.months[11]).toMatchObject({ demandDays: 2, metDays: 1, demandM3: 20, suppliedM3: 15, timeReliability: 0.5, volumetricReliability: 0.75 });
		expect(r!.months[0]).toMatchObject({ demandDays: 3, metDays: 1, demandM3: 30, suppliedM3: 14, volumetricReliability: 14 / 30 });
		expect(r!.months[1]).toMatchObject({ demandDays: 0, timeReliability: null, volumetricReliability: null });
	});

	it('reliability is 1 exactly when every deficit is 0, and null without demand', () => {
		const x = pure();
		const full = [10, 10, 0, 10, 10, 10];
		x.demandNodes[0]!.supplied = full;
		const [r] = supplyAssurance(x).reliability;
		expect([r!.timeReliability, r!.volumetricReliability, r!.annualReliability]).toEqual([1, 1, null]);
		expect(r!.failureRuns).toBe(0);
		expect(r!.meanFailureDays).toBeNull();
		expect(r!.maxFailureDeficitM3).toBe(0);
		// One unit short on one day and it is no longer 1.
		full[4] = 9;
		expect(supplyAssurance(x).reliability[0]!.timeReliability).toBe(0.8);
		const none = pure();
		none.demandNodes[0]!.demand = zeros(6);
		none.demandNodes[0]!.supplied = zeros(6);
		const [n] = supplyAssurance(none).reliability;
		expect([n!.timeReliability, n!.volumetricReliability, n!.annualReliability]).toEqual([null, null, null]);
	});

	it('the annual measure counts complete water years only, and says how many part years it left out (engine ≥ 1.11.0)', () => {
		// 29–30 Sep 2000 (part of water year 1999), all of water year 2000 (365 days), 1–4 Oct 2001 (part of 2001).
		const days = 2 + 365 + 4;
		const demand = new Array<number>(days).fill(10);
		// The part years get nothing; the complete year gets 8 of 10 every day.
		const supplied = demand.map((_, t) => (t < 2 || t >= 367 ? 0 : 8));
		const x: SupplyAssuranceInput = {
			...pure(),
			startDate: '2000-09-29',
			days,
			window: { from: 0, to: days - 1, reportStart: '2000-09-29', reportEnd: '2001-10-04' },
			demandNodes: [{ nodeId: 'A', name: 'Farm A', kind: 'farm', demand, supplied }],
			natural: zeros(days),
			outflow: zeros(days)
		};
		const [r] = supplyAssurance(x).reliability;
		// 0.8 ≥ 0.7 in water year 2000; counting the two failed part years would have made it 1 of 3.
		expect(r).toMatchObject({ waterYears: 1, partWaterYears: 2, waterYearsMet: 1, annualReliability: 1 });
		// A window that starts on 1 October and ends on 30 September has no part year.
		const whole = supplyAssurance({ ...x, window: { from: 2, to: 366, reportStart: '2000-10-01', reportEnd: '2001-09-30' } }).reliability[0]!;
		expect(whole).toMatchObject({ waterYears: 1, partWaterYears: 0, waterYearsMet: 1, annualReliability: 1 });
		// One day short of the year at the end makes it a part year.
		const short = supplyAssurance({ ...x, window: { from: 2, to: 365, reportStart: '2000-10-01', reportEnd: '2001-09-29' } }).reliability[0]!;
		expect(short).toMatchObject({ waterYears: 0, partWaterYears: 1, annualReliability: null });
	});

	it('a leap water year is complete at 366 days', () => {
		// Water year 2003 (1 Oct 2003 … 30 Sep 2004) holds 29 Feb 2004.
		const days = 366;
		const demand = new Array<number>(days).fill(10);
		const x: SupplyAssuranceInput = {
			...pure(),
			startDate: '2003-10-01',
			days,
			window: { from: 0, to: days - 1, reportStart: '2003-10-01', reportEnd: '2004-09-30' },
			demandNodes: [{ nodeId: 'A', name: 'Farm A', kind: 'farm', demand, supplied: demand }],
			natural: zeros(days),
			outflow: zeros(days)
		};
		expect(supplyAssurance(x).reliability[0]).toMatchObject({ waterYears: 1, partWaterYears: 0, annualReliability: 1 });
	});

	// Failure-run edges of the day loop (tallyWindow, issue #192).
	const runs = (demand: number[], supplied: number[], window?: { from: number; to: number }) => {
		const x = pure();
		x.demandNodes[0] = { ...x.demandNodes[0]!, demand, supplied };
		if (window) x.window = { ...window, reportStart: '2001-09-29', reportEnd: '2001-10-04' };
		return supplyAssurance(x).reliability[0]!;
	};

	it('a failure run still open on the window’s last day counts: runs, longest and largest deficit', () => {
		// Met, met, then short on the last four days (deficits 1, 2, 3, 4): one run, never ended by a met day.
		expect(runs([10, 10, 10, 10, 10, 10], [10, 10, 9, 8, 7, 6])).toMatchObject({ failureRuns: 1, longestFailureDays: 4, meanFailureDays: 4, maxFailureDeficitM3: 10, meanFailureDeficitM3: 10 });
	});

	it('a day without demand ends a failure run, and is neither met nor failed', () => {
		// Short, short, no demand, short, met, met: two runs (2 days, deficit 3; 1 day, deficit 5).
		expect(runs([10, 10, 0, 10, 10, 10], [9, 8, 0, 5, 10, 10])).toMatchObject({ demandDays: 5, metDays: 2, failureRuns: 2, longestFailureDays: 2, meanFailureDays: 1.5, maxFailureDeficitM3: 5, meanFailureDeficitM3: 4 });
	});

	it('a window that starts inside a failure run counts only its days in the window', () => {
		// Short on days 0–3, met after; the window starts on day 2: one run of 2 days (deficits 3 + 4).
		expect(runs([10, 10, 10, 10, 10, 10], [9, 8, 7, 6, 10, 10], { from: 2, to: 5 })).toMatchObject({ demandDays: 4, failureRuns: 1, longestFailureDays: 2, maxFailureDeficitM3: 7, meanFailureDeficitM3: 7 });
	});

	it('only the reporting window counts', () => {
		const x = pure();
		x.window = { from: 3, to: 5, reportStart: '2001-10-02', reportEnd: '2001-10-04' };
		const a = supplyAssurance(x);
		expect(a.days).toBe(3);
		expect(a.reliability[0]!.demandDays).toBe(3);
		expect(a.reliability[0]!.volumetricReliability).toBe(14 / 30);
	});
});

describe('stress classes (model.md §4 thresholds)', () => {
	it('classes the supply ratio at ≥ 95 / 85 / 70 / 50 %', () => {
		expect([0.95, 0.9499, 0.85, 0.8499, 0.7, 0.6999, 0.5, 0.4999, 0].map(stressClassOf)).toEqual([
			'low',
			'moderate',
			'moderate',
			'high',
			'high',
			'severe',
			'severe',
			'critical',
			'critical'
		]);
		expect(stressClassOf(null)).toBeNull();
		expect(stressClassOf(1)).toBe('low');
	});

	it('grids each water-year month from Σ supplied ÷ Σ demand, over the whole run', () => {
		const s = supplyAssurance(pure()).stress;
		expect(s.waterYears).toEqual([2000, 2001]);
		expect(s.days[0]![11]).toBe(2);
		expect(s.days[1]![0]).toBe(4);
		const g = s.nodes[0]!;
		expect(g.ratio[0]![11]).toBe(0.75);
		expect(g.stressClass[0]![11]).toBe('high');
		expect(g.ratio[1]![0]).toBe(14 / 30);
		expect(g.stressClass[1]![0]).toBe('critical');
		// Months outside the run have no ratio and no class.
		expect(g.ratio[0]![0]).toBeNull();
		expect(g.stressClass[0]![0]).toBeNull();
		expect(s.system.ratio).toEqual(g.ratio);
	});

	it('the water-year boundary does not move under a skewed TZ', () => {
		const tz = process.env.TZ;
		try {
			process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: a local-time slip would move 1 October into September
			const a = supplyAssurance(pure());
			process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11
			const b = supplyAssurance(pure());
			expect(a).toEqual(b);
			expect(a.stress.days[0]![11]).toBe(2);
			expect(a.reliability[0]!.months[0]!.demandDays).toBe(3);
		} finally {
			process.env.TZ = tz;
		}
	});
});

// --- whole runs on a fixed natural flow --------------------------------------

const DAYS = 4;
const NATURAL = [1000, 10_000, 3000, 0];
const flat = (v: number) => new Array(12).fill(v) as number[];

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** A four-day January run, no rain; farm A needs 2000 m³/day (A-pan hack as in users.test.ts), no dam evaporation. */
function input(nodes: NetworkNode[], settings: Partial<ModelInput['settings']> = {}): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = 2000;
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, lakeEvapFactor: 0, ewrPragmaticM3PerDay: flat(500) as never, ...settings },
		model: {
			nodes,
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(DAYS).fill(0) } }
	};
}

const run = (i: ModelInput) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: NATURAL })));

describe('the water account (hand-worked)', () => {
	it('a dam-less farm and a junior user: natural = irrigation + other use + outflow; EWR required vs met', () => {
		// A (needs 2000) → U (junior, wants 800, returns 25 %) → G.
		const o = run(input([node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800), userReturnPct: 0.25, userPriority: 'junior' }), node('A', 'farm', 'U')]));
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		const w = o.summary.supplyAssurance!.waterAccount;
		expect(w.years.map((y) => y.waterYear)).toEqual([2020]);
		const t = w.total;
		// A takes [1000, 2000, 2000, 0]; U [0, 800, 800, 0] and returns [0, 200, 200, 0].
		expect(t.naturalFlowM3).toBe(14_000);
		expect(t.consumptiveIrrigationM3).toBe(5000);
		expect(t.otherUseM3).toBe(1200);
		expect(t.outflowM3).toBe(7800);
		expect(t.storageChangeM3).toBe(0);
		expect(t.residualM3).toBe(0);
		expect(t.inM3).toBe(14_000);
		expect(t.outM3).toBe(14_000);
		// Outlet EWR 500/day: outflow [0, 7400, 400, 0] meets [0, 500, 400, 0].
		expect(t.ewr).toEqual([{ nodeId: null, name: 'G', requiredM3: 2000, metM3: 900, daysNotMet: 3 }]);
		expect(checkWaterAccount(o)).toBeNull();
		expect(checkReliability(o)).toBeNull();

		// Farm A: met on days 1 and 2; short 1000 on day 0 and 2000 on day 3.
		const [a, u] = o.summary.supplyAssurance!.reliability;
		expect(a).toMatchObject({ nodeId: 'A', kind: 'farm', timeReliability: 0.5, volumetricReliability: 5000 / 8000, failureRuns: 2, meanFailureDays: 1, meanFailureDeficitM3: 1500, maxFailureDeficitM3: 2000, waterYears: 0, partWaterYears: 1, waterYearsMet: 0, annualReliability: null });
		expect(u).toMatchObject({ nodeId: 'U', kind: 'user', timeReliability: 0.5, volumetricReliability: 0.5 });
		// January is water-year month 3: 0.625 → Severe.
		expect(o.summary.supplyAssurance!.stress.nodes[0]!.stressClass[0]![3]).toBe('severe');
	});

	it('a farm dam: storage change and spill close the account', () => {
		// A with a 5000 m³ dam, empty at the start: supplied [1000, 2000, 2000, 2000], spill [0, 3000, 1000, 0], closing 3000.
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 5000 })]));
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		const t = o.summary.supplyAssurance!.waterAccount.total;
		expect(t.consumptiveIrrigationM3).toBe(7000);
		expect(t.outflowM3).toBe(4000);
		expect(t.openingStorageM3).toBe(0);
		expect(t.closingStorageM3).toBe(3000);
		expect(t.storageChangeM3).toBe(3000);
		expect(t.residualM3).toBe(0);
		expect(checkWaterAccount(o)).toBeNull();
		const [a] = o.summary.supplyAssurance!.reliability;
		expect(a).toMatchObject({ timeReliability: 0.75, volumetricReliability: 7000 / 8000 });
	});

	it('a release and seepage lost from the catchment (WP-3.5): the lost share is an out term, the release a memo', () => {
		// A full 5000 m³ dam seeping 10 %/day, 40 % of it returning below the wall, releasing 300 m³/day first.
		const dam = { damCapacityM3: 5000, damInitialPct: 1, damSeepagePerDay: 0.1, damSeepageReturnPct: 0.4, damReleaseRule: 'fixed' as const, damReleaseM3Day: flat(300) };
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', dam)]));
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		const t = o.summary.supplyAssurance!.waterAccount.total;
		expect(t.damSeepageLostM3!).toBeGreaterThan(0);
		// damSeepageM3 is the returning part: lost ÷ returned = 0.6 ÷ 0.4.
		expect(t.damSeepageLostM3! / t.damSeepageM3).toBeCloseTo(1.5, 9);
		expect(t.damReleaseM3!).toBeGreaterThan(0);
		expect(t.outM3).toBeCloseTo(t.landCoverM3 + t.unallocatedM3 + t.consumptiveIrrigationM3 + t.otherUseM3 + t.damEvaporationM3 + t.damSeepageLostM3! + t.streamDepletionM3 + t.outflowM3, 6);
		expect(Math.abs(t.residualM3)).toBeLessThanOrEqual(1e-10 * t.scaleM3);
		expect(checkWaterAccount(o)).toBeNull();
		// With every drop of seepage returning, nothing is lost and the account still closes.
		const back = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { ...dam, damSeepageReturnPct: 1 })])).summary.supplyAssurance!.waterAccount.total;
		expect(back.damSeepageLostM3).toBe(0);
		expect(Math.abs(back.residualM3)).toBeLessThanOrEqual(1e-10 * back.scaleM3);
	});

	it('groundwater pumped into the dam (WP-3.9) comes in with the groundwater, and the account closes', () => {
		const i = input([node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 5000, damMinPct: 0.2 })]);
		i.model.boreholes = [{ id: 'b1', nodeId: 'A', name: 'BH-1', capacityM3Day: 400, annualCapM3: null, mode: 'primary', emergencyBelowPct: 0.3, target: 'dam', depletionFactor: 0 }];
		const o = run(i);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		const toDam = o.summary.groundwaterAnnualUse!.reduce((s, y) => s + y.toDamM3, 0);
		expect(toDam).toBeGreaterThan(0);
		const t = o.summary.supplyAssurance!.waterAccount.total;
		expect(t.groundwaterM3).toBeCloseTo(o.summary.groundwaterAnnualUse!.reduce((s, y) => s + y.abstractionM3, 0), 6);
		expect(Math.abs(t.residualM3)).toBeLessThanOrEqual(1e-10 * t.scaleM3);
		expect(checkWaterAccount(o)).toBeNull();
	});

	it('settings.assuranceAnnualThreshold sets the annual test; a bad value warns and falls back to 0.9', () => {
		// One complete water year (2020/21): A needs 2000 m³/day in January only and gets the 1750 m³/day natural flow, so its year's ratio is 0.875.
		const days = 365;
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G')];
		const year = (settings: Partial<ModelInput['settings']> = {}) => {
			const i = input(nodes, settings);
			i.series = { rain_catchment_mm: { startDate: '2020-10-01', values: new Array(days).fill(0) } };
			return withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: new Array(days).fill(1750) })));
		};
		const def = year().summary.supplyAssurance!.reliability[0]!;
		expect(def).toMatchObject({ waterYears: 1, partWaterYears: 0 });
		expect(def.volumetricReliability).toBeCloseTo(0.875, 12);
		// Met at 0.85, not at the default 0.9.
		expect(def.annualReliability).toBe(0);
		const low = year({ assuranceAnnualThreshold: 0.85 }).summary.supplyAssurance!;
		expect(low.annualThreshold).toBe(0.85);
		expect(low.reliability[0]!.annualReliability).toBe(1);
		const bad = run(input(nodes, { assuranceAnnualThreshold: 1.5 }));
		expect(bad.summary.supplyAssurance!.annualThreshold).toBe(0.9);
		expect(bad.summary.warnings.some((w) => w.startsWith('annual assurance threshold "1.5"'))).toBe(true);
	});

});
