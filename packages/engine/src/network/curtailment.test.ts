import { describe, expect, it } from 'vitest';
import { computeCurtailment, type CurtailmentInput } from './curtailment';
import { excelRoundDown } from './round';
import { resolveReportWindow } from '../run';
import { toEpochDay } from '../calendar';

const farm = (id: string, demand: number[], supplied: number[], ewr: number[]): CurtailmentInput => ({
	nodeId: id,
	name: id,
	demand,
	supplied,
	ewrShortfallIncremental: ewr
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

	it('averages demand, supply and incremental EWR shortfall over the window, unrounded [H, I, R]', () => {
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
		// C: no demand, but the EWR shortfall it adds still counts against it.
		close(c!.totalChangeM3Day, -0.75);
		close(c!.totalChangeLs, -0.75 / 86.4); // a small cut stays visible (the sheet shows 0)
		close(c!.volumeLeftM3Day, -0.75);
		expect(c!.fractionOfDemandLeft).toBeNull();
	});

	it('totals are plain sums of the farm columns; redistribution nets to 0', () => {
		const t = out.totals;
		expect([t.demandM3Day, t.suppliedM3Day, t.deficitM3Day]).toEqual([300, 200, -100]);
		close(t.targetM3Day, 200);
		close(t.reduceGainM3Day, 0);
		close(t.reduceGainLs, 0);
		close(t.ewrShortfallM3Day, -5.75);
		close(t.totalChangeM3Day, -5.75);
		close(t.volumeLeftM3Day, 194.25);
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
		expect(dry.farms[0]).toMatchObject({ targetM3Day: 0, reduceGainM3Day: 0, totalChangeM3Day: -5, volumeLeftM3Day: -5 });
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
