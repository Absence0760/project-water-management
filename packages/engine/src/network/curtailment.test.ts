import { describe, expect, it } from 'vitest';
import { computeCurtailment, DEMAND_PCT_FLOOR_M3_DAY, demandPctNote, type CurtailmentInput } from './curtailment';
import { excelRoundDown } from './round';
import { resolveReportWindow } from '../run';
import { toEpochDay } from '../calendar';

const farm = (id: string, demand: number[], supplied: number[], ewr: number[]): CurtailmentInput => ({
	nodeId: id,
	name: id,
	demand,
	supplied,
	ewrCharge: ewr
});
const win = (from: number, to: number) => ({ from, to, reportStart: 'S', reportEnd: 'E' });

describe('computeCurtailment — b023 [Shortfalls]', () => {
	// A is fully supplied, B gets half its demand, C has no demand but an EWR shortfall.
	// Σ demand 300, Σ supplied 200 → every farm's equitable share is 2/3 of its demand.
	const farms = [
		farm('A', [100, 100, 100, 100], [100, 100, 100, 100], [0, 0, -10, -10]),
		farm('B', [200, 200, 200, 200], [100, 100, 100, 100], [0, 0, 0, 0]),
		farm('C', [0, 0, 0, 0], [0, 0, 0, 0], [-3, 0, 0, 0])
	];
	const out = computeCurtailment(farms, win(0, 3));
	const [a, b, c] = out.farms;

	const close = (got: number | null | undefined, want: number) => expect(got).toBeCloseTo(want, 9);

	it('averages demand, supply and the EWR charge over the window, unrounded [H, I, R]', () => {
		expect([a!.demandM3Day, a!.suppliedM3Day, a!.ewrShortfallM3Day]).toEqual([100, 100, -5]);
		expect([b!.demandM3Day, b!.suppliedM3Day, b!.ewrShortfallM3Day]).toEqual([200, 100, 0]);
		// The sheet shows ROUND(-0.75) = -1; the engine keeps the mean (audit R1).
		expect([c!.demandM3Day, c!.suppliedM3Day, c!.ewrShortfallM3Day]).toEqual([0, 0, -0.75]);
		expect(out.days).toBe(4);
	});

	it('deficit is supplied − demand and % supply is null without demand [J, K]', () => {
		expect(a!.deficitM3Day).toBe(0);
		expect(b!.deficitM3Day).toBe(-100);
		expect(b!.fractionSupplied).toBe(0.5);
		expect(c!.fractionSupplied).toBeNull();
	});

	it('targets the catchment-wide supply fraction for every farm [K total, M, P]', () => {
		close(out.equitableFraction, 2 / 3);
		close(a!.targetM3Day, 200 / 3);
		close(b!.targetM3Day, 400 / 3);
		expect(c!.targetM3Day).toBe(0);
		close(a!.targetFraction, 2 / 3);
		close(b!.targetFraction, 2 / 3);
		expect(c!.targetFraction).toBeNull();
	});

	it('reduce (−) / gain (+) is target − supplied, and l/s is ÷ 86.4, not truncated [N, O] (audit Q15)', () => {
		close(a!.reduceGainM3Day, -100 / 3);
		close(b!.reduceGainM3Day, 100 / 3);
		close(a!.reduceGainLs, -100 / 3 / 86.4); // -0.386 (the sheet truncates to -0.3)
		close(b!.reduceGainLs, 100 / 3 / 86.4);
		expect(Object.is(c!.reduceGainLs, 0)).toBe(true); // never -0
	});

	it('adds the EWR shortfall for the total change and the volume left [S, T, U, V]', () => {
		close(a!.totalChangeM3Day, -100 / 3 - 5);
		close(a!.totalChangeLs, (-100 / 3 - 5) / 86.4);
		close(a!.volumeLeftM3Day, 200 / 3 - 5);
		close(a!.fractionOfDemandLeft, (200 / 3 - 5) / 100);
		close(b!.totalChangeM3Day, 100 / 3);
		close(b!.volumeLeftM3Day, 400 / 3);
		// C: no demand, but a charge given as all irrigation (no split, the old AB way) still counts against it.
		close(c!.totalChangeM3Day, -0.75);
		close(c!.totalChangeLs, -0.75 / 86.4); // a small cut stays visible (the sheet shows 0)
		// Volume left never goes below 0 (Q13, engine 0.17.0; the sheet shows −0.75); the excess is flagged.
		expect(c!.volumeLeftM3Day).toBe(0);
		close(c!.ewrCutBeyondShareM3Day, 0.75);
		expect(c!.fractionOfDemandLeft).toBeNull();
		expect(a!.ewrCutBeyondShareM3Day).toBe(0);
	});

	it('totals are plain sums of the farm columns; redistribution nets to 0', () => {
		const t = out.totals;
		expect([t.demandM3Day, t.suppliedM3Day, t.deficitM3Day]).toEqual([300, 200, -100]);
		close(t.targetM3Day, 200);
		close(t.reduceGainM3Day, 0);
		close(t.reduceGainLs, 0);
		close(t.ewrShortfallM3Day, -5.75);
		close(t.totalChangeM3Day, -5.75);
		close(t.volumeLeftM3Day, 195);
	});

	it('uses only the days inside the window', () => {
		const late = computeCurtailment(farms, win(2, 3));
		expect(late.farms[0]!.ewrShortfallM3Day).toBe(-10);
		expect(late.farms[2]!.ewrShortfallM3Day).toBe(0);
		expect(late.days).toBe(2);
	});

	it('with no demand anywhere the equitable fraction is null (workbook: #DIV/0!) and targets are 0', () => {
		const dry = computeCurtailment([farm('X', [0, 0], [0, 0], [-4, -6])], win(0, 1));
		expect(dry.equitableFraction).toBeNull();
		expect(dry.farms[0]).toMatchObject({ targetM3Day: 0, reduceGainM3Day: 0, totalChangeM3Day: -5, volumeLeftM3Day: 0, ewrCutBeyondShareM3Day: 5 });
	});

	it('everyone fully supplied → no reductions except the EWR', () => {
		const ok = computeCurtailment(
			[farm('P', [800, 800], [800, 800], [0, 0]), farm('Q', [2500, 2500], [2500, 2500], [-12, -12])],
			win(0, 1)
		);
		expect(ok.equitableFraction).toBe(1);
		expect(ok.farms.map((f) => [f.targetM3Day, f.reduceGainM3Day, f.totalChangeM3Day, f.totalChangeLs, f.fractionOfDemandLeft])).toEqual([
			[800, 0, 0, 0, 1],
			[2500, 0, -12, -12 / 86.4, 2488 / 2500]
		]);
	});

	it('a lone farm gets exactly its own supply as target: no floating-point "gain" of 1e-16', () => {
		// H × (I / H) − I is −1.1e-16 for these values; the UI would call that a gain.
		const lone = computeCurtailment([farm('L', [8 / 7], [5 / 7], [0])], win(0, 0));
		expect(lone.farms[0]!.reduceGainM3Day).toBe(0);
		expect(lone.farms[0]!.totalChangeM3Day).toBe(0);
	});

	it('splits R into irrigation and storage parts, and the supply cut ΔG = R_irr ÷ k (Q17)', () => {
		// Charge −10 a day, of which −6 is irrigation; k = 1 − β(1 − e) = 0.75 → ΔG = 8.
		const f: CurtailmentInput = { ...farm('F', [100, 100], [50, 50], [-10, -10]), ewrChargeIrrigation: [-6, -6], consumptivePerSupplied: 0.75, ewrBindingSiteId: 'g1' };
		const r = computeCurtailment([f], win(0, 1)).farms[0]!;
		expect(r.ewrShortfallM3Day).toBe(-10);
		expect(r.ewrChargeIrrigationM3Day).toBe(-6);
		expect(r.ewrChargeStorageM3Day).toBe(-4);
		close(r.ewrSupplyCutM3Day, -8);
		close(r.ewrSupplyCutLs, -8 / 86.4);
		expect(r.ewrBindingSiteId).toBe('g1');
	});

	it('without an irrigation split the whole charge is irrigation, with k = 1', () => {
		const r = computeCurtailment([farm('F', [100], [50], [-10])], win(0, 0)).farms[0]!;
		expect([r.ewrChargeIrrigationM3Day, r.ewrChargeStorageM3Day, r.ewrSupplyCutM3Day, r.ewrBindingSiteId]).toEqual([-10, 0, -10, null]);
	});

	it('summarises each EWR site over the window: days not met, shortfall, charged and natural (Q17)', () => {
		const k = computeCurtailment([farm('F', [1, 1, 1], [1, 1, 1], [0, 0, 0])], win(1, 2), [
			{ nodeId: 'out', name: 'Outlet', isOutlet: true, farmCount: 3, shortfall: [-9, -10, 0], charged: [-9, -4, 0], natural: [0, -6, 0] }
		]);
		expect(k.ewrAttribution).toBe('netImpactProRata');
		expect(k.ewrSites).toEqual([
			{ nodeId: 'out', name: 'Outlet', isOutlet: true, farmCount: 3, daysNotMet: 1, shortfallM3Day: -5, chargedM3Day: -2, naturalM3Day: -3 }
		]);
	});

	it('Q13: a farm with no demand gets no irrigation cut; its charge is store less / pass inflow', () => {
		const z: CurtailmentInput = { ...farm('Z', [0, 0], [0, 0], [-10, -10]), ewrChargeIrrigation: [0, 0], consumptivePerSupplied: 0.8 };
		const r = computeCurtailment([z, farm('W', [100, 100], [50, 50], [0, 0])], win(0, 1)).farms[0]!;
		expect([r.ewrShortfallM3Day, r.ewrChargeIrrigationM3Day, r.ewrChargeStorageM3Day, r.ewrSupplyCutM3Day]).toEqual([-10, 0, -10, 0]);
		// The total change and the volume left count only what irrigation can deliver.
		expect([r.totalChangeM3Day, r.volumeLeftM3Day, r.ewrCutBeyondShareM3Day, r.fractionOfDemandLeft]).toEqual([0, 0, 0, null]);
	});

	it('Q13: volume left = MAX(target − supply cut, 0), demand left stays in 0–1, and a cut beyond the equitable share is flagged', () => {
		// One farm: H 100, I 10 → target 10. Charge −40, all irrigation, k = 0.8 → ΔG = 50.
		const f: CurtailmentInput = { ...farm('F', [100], [10], [-40]), ewrChargeIrrigation: [-40], consumptivePerSupplied: 0.8 };
		const r = computeCurtailment([f], win(0, 0)).farms[0]!;
		close(r.ewrSupplyCutM3Day, -50);
		close(r.totalChangeM3Day, -50); // N 0 − ΔG
		expect(r.volumeLeftM3Day).toBe(0);
		close(r.ewrCutBeyondShareM3Day, 40);
		expect(r.fractionOfDemandLeft).toBe(0);
		// A cut within the share leaves target − ΔG.
		const g = computeCurtailment([{ ...f, ewrCharge: [-4], ewrChargeIrrigation: [-4] }], win(0, 0)).farms[0]!;
		close(g.volumeLeftM3Day, 5);
		close(g.fractionOfDemandLeft, 0.05);
		expect(g.ewrCutBeyondShareM3Day).toBe(0);
	});

	it('Q13: demand_pct_note marks no demand and demand below the 1 m³/day floor', () => {
		expect(DEMAND_PCT_FLOOR_M3_DAY).toBe(1);
		expect([demandPctNote(0), demandPctNote(0.4), demandPctNote(1), demandPctNote(250)]).toEqual(['no_demand', 'below_floor', '', '']);
	});

	it('rejects an empty window', () => {
		expect(() => computeCurtailment(farms, win(3, 2))).toThrow(/empty/);
	});
});

describe('excelRoundDown (test helper for replaying workbook cells)', () => {
	it('truncates toward zero and tolerates binary representation error', () => {
		expect(excelRoundDown(0.38541, 1)).toBe(0.3);
		expect(excelRoundDown(-0.38541, 1)).toBe(-0.3);
		expect(excelRoundDown(8.64 / 86.4, 1)).toBe(0.1);
		expect(excelRoundDown(2.9999, 0)).toBe(2);
		expect(Object.is(excelRoundDown(-0.05, 1), 0)).toBe(true);
	});
});

describe('resolveReportWindow', () => {
	const runStart = toEpochDay('2020-01-01');
	const days = 31; // 2020-01-01 … 2020-01-31

	it('defaults to the whole run', () => {
		const w: string[] = [];
		expect(resolveReportWindow({ reportStart: null, reportEnd: null }, runStart, days, w)).toEqual({
			from: 0,
			to: 30,
			reportStart: '2020-01-01',
			reportEnd: '2020-01-31'
		});
		expect(w).toEqual([]);
	});

	it('maps an inside window to day indices (inclusive)', () => {
		const w: string[] = [];
		expect(resolveReportWindow({ reportStart: '2020-01-10', reportEnd: '2020-01-12' }, runStart, days, w)).toMatchObject({
			from: 9,
			to: 11
		});
		expect(w).toEqual([]);
	});

	it('clips a window that overhangs the run, with a warning', () => {
		const w: string[] = [];
		expect(resolveReportWindow({ reportStart: '2019-12-01', reportEnd: '2020-01-05' }, runStart, days, w)).toMatchObject({
			from: 0,
			to: 4,
			reportStart: '2020-01-01'
		});
		expect(w[0]).toMatch(/clipped/);
	});

	it('falls back to the whole run for a disjoint, reversed or malformed window', () => {
		for (const s of [
			{ reportStart: '2021-01-01', reportEnd: '2021-02-01' },
			{ reportStart: '2020-01-20', reportEnd: '2020-01-10' },
			{ reportStart: 'soon', reportEnd: null }
		]) {
			const w: string[] = [];
			expect(resolveReportWindow(s, runStart, days, w)).toMatchObject({ from: 0, to: 30 });
			expect(w.length).toBeGreaterThan(0);
		}
	});
});

describe('computeCurtailment — the basic-needs floor (engine 1.44.0, issue #123)', () => {
	// A: demand 100, supplied 100, a heavy EWR charge; B: demand 100, supplied 20.
	// Σ supplied / Σ demand = 0.6, so M_A = 60; A's supply cut −80 leaves MAX(60 − 80, 0) = 0.
	const a = (basicNeeds?: number[]): CurtailmentInput => ({ ...farm('A', [100, 100], [100, 100], [-80, -80]), ...(basicNeeds ? { basicNeeds } : {}) });
	const b = farm('B', [100, 100], [20, 20], [0, 0]);

	it('never leaves a unit less than its floor: U = MAX(M − ΔG, 0, floor), S = MAX(N − ΔG, floor − I)', () => {
		const without = computeCurtailment([a(), b], win(0, 1)).farms[0]!;
		expect(without.volumeLeftM3Day).toBe(0);
		expect(without.basicNeedsM3Day).toBeUndefined();
		expect(without.basicNeedsHeldM3Day).toBeUndefined();
		const out = computeCurtailment([a([20, 30]), b], win(0, 1));
		const row = out.farms[0]!;
		expect(row.basicNeedsM3Day).toBe(25);
		expect(row.volumeLeftM3Day).toBe(25);
		expect(row.basicNeedsHeldM3Day).toBe(25);
		// N − ΔG = −40 − 80 = −120; floor − I = 25 − 100 = −75: the floor holds the cut to 75.
		expect(without.totalChangeM3Day).toBe(-120);
		expect(row.totalChangeM3Day).toBe(-75);
		expect(row.fractionOfDemandLeft).toBe(0.25);
		// The EWR charge and its supply cut stay as they were: the floor holds water back, it doesn't hide the charge.
		expect(row.ewrSupplyCutM3Day).toBe(without.ewrSupplyCutM3Day);
		expect(row.ewrCutBeyondShareM3Day).toBe(without.ewrCutBeyondShareM3Day);
		expect(out.totals.basicNeedsM3Day).toBe(25);
		expect(out.totals.basicNeedsHeldM3Day).toBe(25);
	});

	it('holds nothing back when the volume left is above the floor already', () => {
		const out = computeCurtailment([a([20, 30]), { ...b, basicNeeds: [5, 5] }], win(0, 1));
		const rowB = out.farms[1]!;
		expect(rowB.volumeLeftM3Day).toBe(rowB.targetM3Day);
		expect(rowB.basicNeedsHeldM3Day).toBe(0);
		expect(rowB.totalChangeM3Day).toBe(rowB.reduceGainM3Day);
	});

	it('adds no totals without a floor anywhere', () => {
		const out = computeCurtailment([a(), b], win(0, 1));
		expect(out.totals.basicNeedsM3Day).toBeUndefined();
		expect('basicNeedsHeldM3Day' in out.totals).toBe(false);
	});
});
