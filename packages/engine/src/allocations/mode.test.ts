// allocationMode (engine 1.18.0, issue #72, docs/model.md §2.12a) on the
// invented outlook catchment (two farms on vines into one outlet). Random
// networks with allocations in every mode are in the engine fuzz
// (../testing/fuzz.ts randomAllocations) and the warm-start invariants.
import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { testCatchment } from '../outlook/testCatchment';
import type { AllocationLimitBound, ModelInput, ModelOutput } from '../project';
import { captureModelState, runModel, runModelChecked, runModelFrom, runModelWithoutChecks } from '../run';
import { applyScenario } from '../scenario';
import { checkResume } from '../testing/warmstartInvariants';
import type { AllocationEntry } from './compare';
import { checkAllocations } from '../verify/checks';
import { ALLOCATION_SERIES, dailyLimits, fullAllocationFactors, limitBoundKind, matchAllocations, outsideMonths, planAllocations, rateShortfall, registeredOver, uncappedYears, usableAllocations, waterYearList, yearBudgets } from './mode';

const col = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;

/** Σ of a daily column per water year of the run. */
function perYear(out: ModelOutput, values: readonly number[]): Map<number, number> {
	const d0 = toEpochDay(out.startDate);
	const m = new Map<number, number>();
	values.forEach((v, t) => m.set(waterYearOf(d0 + t), (m.get(waterYearOf(d0 + t)) ?? 0) + v));
	return m;
}

const withAllocations = (allocations: AllocationEntry[], mode?: 'none' | 'cap' | 'fullAllocation', edit?: (x: ModelInput) => void): ModelInput => {
	const x = testCatchment();
	x.model.allocations = allocations;
	if (mode) x.settings.allocationMode = mode;
	edit?.(x);
	return x;
};

// Farm A's mean surface use per water year without any cap, the scale every volume below is set from.
const base = runModelWithoutChecks(testCatchment());
const meanA = [...perYear(base, col(base, 'a', 'supplied')!).values()].reduce((s, v, _, a) => s + v / a.length, 0);

describe("allocationMode 'none' (the default)", () => {
	it('changes no series: the allocations only add the summary', () => {
		const out = runModelWithoutChecks(withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2 }]));
		expect(out.series).toEqual(base.series);
		expect(out.summary.warnings).toEqual(base.summary.warnings);
		expect(base.summary.allocations).toBeUndefined();
		const s = out.summary.allocations!;
		expect(s.mode).toBe('none');
		expect(s.tolerance).toBe(0.1);
		expect(s.nodes.map((n) => [n.nodeId, n.sources.map((x) => x.waterSource)])).toEqual([['a', ['surface']]]);
		// Every whole year uses about twice the volume: over.
		const src = s.nodes[0]!.sources[0]!;
		expect(src.yearsOver).toBeGreaterThan(src.wholeYears / 2);
		expect(src.capReached).toBeUndefined();
	});

	it('reads settings.allocationTolerance, and warns about a bad one', () => {
		// A volume at the mean use: some years above it by more than 10 %, none by more than 99 %.
		const at = (tolerance: number) => runModelWithoutChecks(withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA }], 'none', (x) => (x.settings.allocationTolerance = tolerance))).summary.allocations!;
		expect(at(0.99).tolerance).toBe(0.99);
		expect(at(0.99).nodes[0]!.sources[0]!.yearsOver).toBe(0);
		expect(at(0.1).nodes[0]!.sources[0]!.yearsOver).toBeGreaterThan(0);
		const bad = runModelWithoutChecks(withAllocations([], 'none', (x) => (x.settings.allocationTolerance = 2)));
		expect(bad.summary.warnings.some((w) => /allocation tolerance "2"/.test(w))).toBe(true);
	});
});

describe("allocationMode 'cap'", () => {
	const volume = meanA / 2;
	const input = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume }], 'cap');
	const out = runModelChecked(input);

	it('keeps each water year’s surface use within the registered volume, and the run passes every self-check', () => {
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		for (const [wy, used] of perYear(out, col(out, 'a', 'supplied')!)) expect(used, String(wy)).toBeLessThanOrEqual(volume * (1 + 1e-9));
		// It binds: every year of the record needs more than half its mean.
		const reached = out.summary.allocations!.nodes[0]!.sources[0]!.capReached!;
		expect(reached.length).toBeGreaterThan(5);
		for (const r of reached) expect(r.usedM3).toBeCloseTo(volume, 3);
	});

	it('a storage-only (s21b) allocation caps nothing: a dam’s registered storage is not a take (engine 1.59.0, issue #72)', () => {
		const dam: AllocationEntry = { id: 'dam', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 0, waterUse: '21b', storageM3: 50_000 };
		const alone = runModelChecked(withAllocations([dam], 'cap'));
		expect(col(alone, 'a', 'supplied')).toEqual(col(base, 'a', 'supplied'));
		expect(alone.summary.allocations).toMatchObject({ used: 0, notMatched: 0, nodes: [] });
		// Beside a take, the take caps exactly as without it.
		const both = runModelChecked(withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume }, dam], 'cap'));
		expect(col(both, 'a', 'supplied')).toEqual(col(out, 'a', 'supplied'));
		expect(both.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
	});

	it('publishes the room at the start of each day, falling by the day’s use and full again on 1 October', () => {
		const room = col(out, 'a', ALLOCATION_SERIES.surfaceRoom.key)!;
		const G = col(out, 'a', 'supplied')!;
		const k = toEpochDay('2003-10-01') - toEpochDay(out.startDate);
		expect(room[k]).toBeCloseTo(volume, 6);
		expect(room[k + 1]).toBeCloseTo(volume - G[k]!, 6);
		expect(col(out, 'a', ALLOCATION_SERIES.groundwaterRoom.key)).toBeUndefined();
		// Farm B has no allocation: no cap, no column, and a warning names it.
		expect(col(out, 'b', ALLOCATION_SERIES.surfaceRoom.key)).toBeUndefined();
		expect(out.summary.warnings.some((w) => /no registered volume, so nothing caps their use \(Farm B\)/.test(w))).toBe(true);
	});

	it('leaves a farm the cap doesn’t touch as it was, and the dam holds what the capped farm didn’t take', () => {
		expect(col(out, 'b', 'supplied')).toEqual(col(base, 'b', 'supplied'));
		const before = col(base, 'a', 'dam_storage')!;
		const after = col(out, 'a', 'dam_storage')!;
		expect(after.reduce((s, v) => s + v, 0)).toBeGreaterThan(before.reduce((s, v) => s + v, 0));
	});

	it('lets the boreholes supply what the capped surface can’t, within the groundwater volume', () => {
		const gwVolume = meanA / 4;
		const x = withAllocations(
			[
				{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume },
				{ id: 'g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: gwVolume }
			],
			'cap',
			(m) => (m.model.boreholes = [{ id: 'bh', nodeId: 'a', name: 'Borehole', capacityM3Day: 1e6, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0, target: 'direct', depletionFactor: 0.5 }])
		);
		const r = runModelChecked(x);
		expect(r.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const gw = col(r, 'a', 'groundwater_used')!;
		const G = col(r, 'a', 'supplied')!;
		for (const [wy, used] of perYear(r, gw)) expect(used, String(wy)).toBeLessThanOrEqual(gwVolume * (1 + 1e-9));
		for (const [wy, used] of perYear(r, G.map((g, t) => g - gw[t]!))) expect(used, String(wy)).toBeLessThanOrEqual(volume * (1 + 1e-9));
		// With a supplemental borehole uncapped by capacity, the groundwater volume is what binds it.
		const reached = r.summary.allocations!.nodes[0]!.sources.find((s) => s.waterSource === 'groundwater')!.capReached!;
		expect(reached.length).toBeGreaterThan(0);
	});

	it('counts the whole water year’s volume even when the run starts inside it', () => {
		const budgets = yearBudgets([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 3650 }], 'surface', toEpochDay('2002-04-01'), 400);
		expect(budgets![0]).toBeCloseTo(3650, 9);
		// A licence valid from 1 April is prorated to its days of the year (183 of 365).
		const late = yearBudgets([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 3650, validFrom: '2002-04-01' }], 'surface', toEpochDay('2001-10-01'), 10);
		expect(late![0]).toBeCloseTo(1830, 9);
		expect(yearBudgets([{ id: 'g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: 1 }], 'surface', 0, 10)).toBeNull();
	});

	describe('a water year with no allocation of the source in force (engine 1.70.0, #90 Q24)', () => {
		const s = (over: Partial<AllocationEntry>): AllocationEntry => ({ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 3650, ...over });
		// Run: 1 Oct 2001 … 30 Sep 2004, three whole water years of 365, 366 and 365 days.
		const start = toEpochDay('2001-10-01');
		const days = toEpochDay('2004-10-01') - start;
		const at = (iso: string) => toEpochDay(iso) - start;
		it('yearBudgets: Infinity (not capped) before the first starts, after the last ends and between two; prorated where in force', () => {
			const b = yearBudgets([s({ validFrom: '2002-10-01', validTo: '2002-12-31' }), s({ id: 't', validFrom: '2003-10-02' })], 'surface', start, days)!;
			expect(b[0]).toBe(Infinity);
			expect(b[at('2002-09-30')]).toBe(Infinity);
			// 2002/03: 92 days of 365 in force; 2003/04: 365 of 366.
			expect(b[at('2002-10-01')]).toBeCloseTo((3650 * 92) / 365, 9);
			expect(b[at('2003-10-01')]).toBeCloseTo((3650 * 365) / 366, 9);
			// The same number every day of a year, the days before the licence's start included.
			expect(b[at('2003-10-01')]).toBe(b[at('2004-09-30')]);
			const end = yearBudgets([s({ validTo: '2002-09-30' })], 'surface', start, days)!;
			expect([end[0], end[at('2002-10-01')], end[at('2003-10-01')]]).toEqual([3650, Infinity, Infinity]);
		});
		it('a 0 m³ allocation in force is a budget of 0, not Infinity; one day in force is a capped year', () => {
			expect(yearBudgets([s({ volumeM3PerYear: 0 })], 'surface', start, 3)!.every((v) => v === 0)).toBe(true);
			const one = yearBudgets([s({ validFrom: '2002-09-30', validTo: '2002-09-30' })], 'surface', start, days)!;
			expect(one[0]).toBeCloseTo(3650 / 365, 9);
			expect(one[at('2002-10-01')]).toBe(Infinity);
		});
		it('a run that starts or ends inside an uncapped year: only the year matters, not the run’s days of it', () => {
			const b = yearBudgets([s({ validFrom: '2002-09-30' })], 'surface', toEpochDay('2002-04-01'), 10)!;
			// 2001/02 has its last day in force, so it is capped (at 10 m³) though the run's ten days precede it.
			expect(b[0]).toBeCloseTo(10, 9);
		});
		it('uncappedYears lists exactly the Infinity years, per source; none for a source without allocations', () => {
			const allocs = [s({ validFrom: '2003-10-01' }), { ...s({ id: 'g', waterSource: 'groundwater', validTo: '2001-12-31' }) }];
			expect(uncappedYears(allocs, 'surface', start, days)).toEqual([2001, 2002]);
			expect(uncappedYears(allocs, 'groundwater', start, days)).toEqual([2002, 2003]);
			expect(uncappedYears([s({})], 'surface', start, days)).toEqual([]);
			expect(uncappedYears([s({})], 'groundwater', start, days)).toEqual([]);
			expect(uncappedYears(allocs, 'surface', start, 0)).toEqual([]);
		});
		it('waterYearList groups consecutive years', () => {
			expect(waterYearList([2001])).toBe('2001');
			expect(waterYearList([2001, 2002, 2003, 2007, 2009, 2010])).toBe('2001–2003, 2007, 2009–2010');
			expect(waterYearList([])).toBe('');
		});
		it('planAllocations: one cap warning for every unit and source, none in the other modes', () => {
			const nodes = [
				{ id: 'a', name: 'Farm A', kind: 'farm' },
				{ id: 'b', name: 'Farm B', kind: 'farm' }
			];
			const allocs = [s({ validFrom: '2003-10-01' }), s({ id: 'g', nodeId: 'b', waterSource: 'groundwater', validTo: '2001-12-31' }), s({ id: 'h', nodeId: 'b' })];
			const plan = () => nodes.map(() => ({ demand: new Float64Array(days), irrigationEfficiency: 1 }));
			const warn = (mode: 'cap' | 'fullAllocation' | 'none') => {
				const w: string[] = [];
				planAllocations(matchAllocations(allocs, mode, nodes, w), nodes, plan(), start, days, w);
				return w.filter((x) => x.includes('is in force'));
			};
			expect(warn('cap')).toEqual([
				`allocation cap: none of a unit's licences of a source is in force in some water years, so its use of that source isn't capped there, as for a unit with no licence of it (check the licence dates): "Farm A" surface water in water years 2001–2002; "Farm B" groundwater in water years 2002–2003`
			]);
			expect(warn('fullAllocation')).toEqual([]);
			expect(warn('none')).toEqual([]);
		});
		it('the self-check holds the room blank exactly in the uncapped years', () => {
			// A licence from 1 Oct 2003 with a rate, so the left column is stored too.
			const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 50_000, validFrom: '2003-10-01', maxRateM3s: 0.01 }], 'cap');
			const out = runModelWithoutChecks(x);
			expect(checkAllocations(x, out)).toBeNull();
			const d0 = toEpochDay(out.startDate);
			const first = Math.max(0, toEpochDay('2003-10-01') - d0);
			expect(first).toBeGreaterThan(0);
			const tamper = (key: string, t: number, v: number) => {
				const bad = structuredClone(out);
				bad.series.find((c) => c.nodeId === 'a' && c.key === key)!.values[t] = v;
				return checkAllocations(x, bad);
			};
			expect(tamper(ALLOCATION_SERIES.surfaceRoom.key, first - 1, 5)).toMatch(/in a water year none of its surface allocations is in force in, which isn't capped \(blank\)/);
			expect(tamper(ALLOCATION_SERIES.surfaceLeft.key, 0, 5)).toMatch(/which isn't capped \(blank\)/);
			expect(tamper(ALLOCATION_SERIES.surfaceRoom.key, first, NaN)).toMatch(/is not a number in a capped water year/);
			expect(tamper(ALLOCATION_SERIES.surfaceLeft.key, first + 3, NaN)).toMatch(/is not a number in a capped water year/);
		});
		it('limitBoundKind: no room limit at all never binds', () => {
			expect(limitBoundKind(Infinity, Infinity, false, 500, 600, 100, Infinity)).toBeNull();
			expect(limitBoundKind(Infinity, Infinity, false, 0, 600, 600, Infinity)).toBeNull();
		});
	});

	for (const at of ['2004-02-29', '2006-10-01', '2009-05-17']) {
		it(`resumed from a snapshot on ${at}, every series is the uninterrupted capped run’s to the bit`, () => {
			const full = runModelWithoutChecks(input);
			expect(checkResume(input, toEpochDay(at) - toEpochDay(full.startDate), full)).toBeNull();
		});
	}

	it('a run resumed inside a water year counts the year’s use before the snapshot in its cap summary', () => {
		const full = runModelWithoutChecks(input);
		const tail = runModelFrom(captureModelState(input, '2009-05-17'), input);
		const reached = (o: ModelOutput) => o.summary.allocations!.nodes[0]!.sources[0]!.capReached!;
		// 2008/09 bound in the uninterrupted run; the resumed run, 4½ months from its end, still says so, with the same use.
		const y2008 = reached(full).find((r) => r.waterYear === 2008)!;
		expect(y2008).toBeDefined();
		const resumed = reached(tail).find((r) => r.waterYear === 2008)!;
		expect(resumed.usedM3).toBeCloseTo(y2008.usedM3, 6);
		expect(reached(tail).map((r) => r.waterYear)).toEqual(reached(full).map((r) => r.waterYear).filter((y) => y >= 2008));
	});
});

describe("allocationMode 'fullAllocation'", () => {
	const volume = meanA * 1.5;
	const input = withAllocations(
		[
			{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume * 0.8 },
			{ id: 'g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: volume * 0.2 }
		],
		'fullAllocation'
	);
	const out = runModelChecked(input);

	it('scales the demand to the registered volume in every water year, keeping its seasonal pattern', () => {
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const D = col(out, 'a', 'demand')!;
		for (const [wy, d] of perYear(out, D)) expect(d, String(wy)).toBeCloseTo(volume, 3);
		// The pattern: in whole years the scaled demand is the unscaled one × one factor.
		const D0 = col(base, 'a', 'demand')!;
		const k = col(out, 'a', ALLOCATION_SERIES.demandFactor.key)!;
		for (let t = 0; t < D.length; t += 97) expect(D[t]).toBeCloseTo(D0[t]! * k[t]!, 6);
		const scaled = out.summary.allocations!.nodes[0]!.scaled!;
		expect(scaled.every((y) => Math.abs(y.registeredM3 - volume) < 1e-6 * volume)).toBe(true);
	});

	it('a storage-only (s21b) row scales nothing: the unit keeps its modelled demand and has no factor (engine 1.59.0)', () => {
		const r = runModelChecked(withAllocations([{ id: 'dam', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 0, waterUse: '21b', storageM3: 50_000 }], 'fullAllocation'));
		expect(col(r, 'a', 'demand')).toEqual(col(base, 'a', 'demand'));
		expect(col(r, 'a', ALLOCATION_SERIES.demandFactor.key)).toBeUndefined();
	});

	it('leaves a unit without a volume as modelled, with a warning', () => {
		expect(col(out, 'b', 'demand')).toEqual(col(base, 'b', 'demand'));
		expect(out.summary.warnings.some((w) => /their demand is left as modelled \(Farm B\)/.test(w))).toBe(true);
	});

	it('scales a senior water user before its demand is passed to the farms upstream', () => {
		const x = withAllocations([{ id: 'u', nodeId: 'u', waterSource: 'surface', volumeM3PerYear: 5000 }], 'fullAllocation', (m) => {
			// A senior user at the outlet, the farms above it.
			const g = m.model.nodes.find((n) => n.id === 'g')!;
			m.model.nodes.push({ ...g, id: 'u', name: 'Town', kind: 'user', sortOrder: 3, downstreamNodeId: null, userDemandM3Day: new Array(12).fill(103), userReturnPct: 0, userPriority: 'senior' });
			g.downstreamNodeId = 'u';
		});
		const r = runModelChecked(x);
		expect(r.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const D = col(r, 'u', 'demand')!;
		for (const [wy, d] of perYear(r, D)) expect(d, String(wy)).toBeCloseTo(5000, 6);
		// The farms upstream pass the scaled demand, in their shares: Σ of their claims is the user's demand.
		const Zs = col(r, 'g', 'senior_requirement')!;
		for (let t = 0; t < D.length; t += 101) expect(Zs[t]).toBeCloseTo(D[t]!, 9);
	});

	it('takes none of a volume in a year its unit has no demand, with a warning', () => {
		const f = fullAllocationFactors([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 100 }], new Float64Array(400), toEpochDay('2001-10-01'), 400);
		expect([...new Set(f.factor)]).toEqual([0]);
		expect(f.unscaled).toEqual([2001, 2002]);
	});

	it('fits the year a forecast tail starts in on its historical days, and the tail keeps that factor (engine 1.28.0, K1)', () => {
		const a: AllocationEntry[] = [{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 365 }];
		const start = toEpochDay('2001-10-01');
		// Demand 1 a day for the first 100 days, then 3 a day: the tail's days would pull the factor down.
		const demand = Float64Array.from({ length: 365 }, (_, t) => (t < 100 ? 1 : 3));
		const cut = fullAllocationFactors(a, demand, start, 365, undefined, 100);
		// 100 historical days: 100 m³ registered over 100 m³ of demand.
		expect(cut.factor[0]).toBeCloseTo(1, 12);
		expect(cut.factor[364]).toBe(cut.factor[0]);
		expect(cut.years).toEqual([{ waterYear: 2001, demandM3: 100 + 3 * 265, registeredM3: cut.factor[0]! * (100 + 3 * 265) }]);
		// Positive control: the whole year fitted, as a run without a tail does.
		const whole = fullAllocationFactors(a, demand, start, 365);
		expect(whole.factor[0]).toBeCloseTo(365 / (100 + 3 * 265), 12);
		expect(whole.years[0]!.registeredM3).toBeCloseTo(365, 9);
	});

	it('asOf: fits the water year in progress on its days before that day only, as a tail starting there would (engine 1.69.0, §2.15)', () => {
		const a: AllocationEntry[] = [{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 365 }];
		const start = toEpochDay('2000-10-01');
		// Two water years; the second's demand is 1 a day for 75 days, then 3 a day.
		const demand = Float64Array.from({ length: 730 }, (_, t) => (t < 365 + 75 ? 1 : 3));
		const f = fullAllocationFactors(a, demand, start, 730, undefined, 730, 0, 365 + 75);
		// The whole year's factor is unchanged; `before` reads the 75 days only (75 m³ registered over 75 m³).
		expect(f.factor[365]).toBeCloseTo(365 / (75 + 3 * 290), 12);
		expect(f.before).toBeCloseTo(1, 12);
		expect(f.before).toBe(fullAllocationFactors(a, demand, start, 730, undefined, 365 + 75).factor[365 + 75]);
		// On a water year's first day nothing of the year is known: no `before`.
		expect(fullAllocationFactors(a, demand, start, 730, undefined, 730, 0, 365).before).toBeUndefined();
		expect(fullAllocationFactors(a, demand, start, 730).before).toBeUndefined();
	});

	it('a year with no demand on its historical days takes nothing on its tail days either', () => {
		const a: AllocationEntry[] = [{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 365 }];
		const demand = Float64Array.from({ length: 365 }, (_, t) => (t < 100 ? 0 : 2));
		const f = fullAllocationFactors(a, demand, toEpochDay('2001-10-01'), 365, undefined, 100);
		// As the run without the tail: no demand in the year, factor 0, listed as unscaled; the tail keeps it.
		expect([...new Set(f.factor)]).toEqual([0]);
		expect(f.unscaled).toEqual([2001]);
		const noTail = fullAllocationFactors(a, demand.subarray(0, 100), toEpochDay('2001-10-01'), 100);
		expect(noTail.unscaled).toEqual([2001]);
		// Its summary row lists the volume registered over the historical days (100 of 365 m³), as the run
		// without the tail does, not k × demand = 0 (engine 1.57.0, verify/ probe scaled-no-demand-tail-year).
		expect(f.years).toEqual([{ waterYear: 2001, demandM3: 2 * 265, registeredM3: registeredOver(a, 2001, toEpochDay('2001-10-01'), toEpochDay('2001-10-01') + 99) }]);
		expect(f.years[0]!.registeredM3).toBeCloseTo(100, 9);
		expect(noTail.years[0]!.registeredM3).toBe(f.years[0]!.registeredM3);
	});

	it('a year with no demand lists the volume registered over its run days, with a tail or without (engine 1.57.0)', () => {
		const a: AllocationEntry[] = [{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 365 }];
		// Two water years, the second all zero demand; the tail starts 100 days into the second.
		const demand = Float64Array.from({ length: 730 }, (_, t) => (t < 365 ? 1 : 0));
		const f = fullAllocationFactors(a, demand, toEpochDay('2001-10-01'), 730, undefined, 465);
		expect(f.unscaled).toEqual([2002]);
		expect(f.years[0]!.registeredM3).toBeCloseTo(365, 9);
		expect(f.years[1]!.demandM3).toBe(0);
		expect(f.years[1]!.registeredM3).toBeCloseTo(100, 9);
		// Positive control: without the tail the same year lists its whole volume.
		expect(fullAllocationFactors(a, demand, toEpochDay('2001-10-01'), 730).years[1]!.registeredM3).toBeCloseTo(365, 9);
	});
});

describe("allocationMode 'cap': licence conditions (engine 1.37.0, issue #72)", () => {
	// A volume far above any year's use, so only the conditions bind.
	const volume = meanA * 10;
	const summer = [10, 11, 12, 1, 2, 3];
	const monthOf = (out: ModelOutput, t: number) => monthOfEpochDay(toEpochDay(out.startDate) + t);

	it('takes nothing outside the months of use, and as before inside them', () => {
		const out = runModelChecked(withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume, months: summer }], 'cap'));
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const G = col(out, 'a', 'supplied')!;
		const room = col(out, 'a', ALLOCATION_SERIES.surfaceRoom.key)!;
		const G0 = col(base, 'a', 'supplied')!;
		let offBefore = 0;
		let on = 0;
		for (let t = 0; t < G.length; t++) {
			if (summer.includes(monthOf(out, t))) {
				on += G[t]!;
				continue;
			}
			offBefore += G0[t]!;
			expect(G[t], `day ${t}`).toBe(0);
			expect(room[t], `day ${t}`).toBe(0);
		}
		// Positive controls: the farm irrigates in April to September without the condition, and still does in its months.
		expect(offBefore).toBeGreaterThan(0);
		expect(on).toBeGreaterThan(0);
		// Farm B has no allocation: untouched by A's licence.
		expect(col(out, 'b', 'supplied')).toEqual(col(base, 'b', 'supplied'));
	});

	it('takes at most the maximum rate × 86 400 a day, and the rate binds', () => {
		const G0 = col(base, 'a', 'supplied')!;
		const perDay = Math.max(...G0) / 2;
		const out = runModelChecked(withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume, maxRateM3s: perDay / 86_400 }], 'cap'));
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const G = col(out, 'a', 'supplied')!;
		for (let t = 0; t < G.length; t++) expect(G[t]!, `day ${t}`).toBeLessThanOrEqual(perDay * (1 + 1e-12));
		expect(G.filter((g) => Math.abs(g - perDay) <= perDay * 1e-9).length).toBeGreaterThan(10);
		// The room column is the day's limit while the year's volume is far off.
		expect(col(out, 'a', ALLOCATION_SERIES.surfaceRoom.key)!.every((r) => r <= perDay * (1 + 1e-12))).toBe(true);
	});

	it('the self-check catches a room above the licence limit (negative control)', () => {
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume, months: summer }], 'cap');
		const out = runModelWithoutChecks(x);
		expect(checkAllocations(x, out)).toBeNull();
		const bad = structuredClone(out);
		const room = bad.series.find((s) => s.nodeId === 'a' && s.key === ALLOCATION_SERIES.surfaceRoom.key)!.values;
		const april = room.findIndex((_, t) => monthOf(out, t) === 4);
		room[april] = 1000;
		expect(checkAllocations(x, bad)).toMatch(/surface allocation room 1000 outside \[0, the year's registered [\d.e+]+ and the licence's 0 today\]/);
	});

	it('resumed from a snapshot inside the months of use, every series is the uninterrupted run’s to the bit', () => {
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2, months: summer, maxRateM3s: Math.max(...col(base, 'a', 'supplied')!) / 2 / 86_400 }], 'cap');
		const full = runModelChecked(x);
		expect(full.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		expect(checkResume(x, toEpochDay('2006-01-15') - toEpochDay(full.startDate), runModelWithoutChecks(x))).toBeNull();
	});

	const borehole = (target: 'direct' | 'dam', mode: 'supplemental' | 'primary') => (m: ModelInput) =>
		(m.model.boreholes = [{ id: 'bh', nodeId: 'a', name: 'Borehole', capacityM3Day: 1e6, annualCapM3: null, mode, emergencyBelowPct: 0, target, depletionFactor: 0.5 }]);
	const winter = [4, 5, 6, 7, 8, 9];

	it('keeps the boreholes to the groundwater licence’s months, and they pump in them', () => {
		// A trickle of surface water, so a supplemental borehole carries the farm; groundwater only April to September.
		const x = withAllocations(
			[
				{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1 },
				{ id: 'g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: volume, months: winter }
			],
			'cap',
			borehole('direct', 'supplemental')
		);
		const out = runModelChecked(x);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const gw = col(out, 'a', 'groundwater_used')!;
		let inMonths = 0;
		for (let t = 0; t < gw.length; t++) {
			if (winter.includes(monthOf(out, t))) inMonths += gw[t]!;
			else expect(gw[t], `day ${t}`).toBe(0);
		}
		expect(inMonths).toBeGreaterThan(0);
	});

	it('holds a dam-target borehole’s pumping into the dam to the groundwater rate', () => {
		const G0 = col(base, 'a', 'supplied')!;
		const perDay = Math.max(...G0) / 4;
		const x = withAllocations([{ id: 'g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: volume, maxRateM3s: perDay / 86_400 }], 'cap', borehole('dam', 'primary'));
		const out = runModelChecked(x);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const gd = col(out, 'a', 'groundwater_to_dam')!;
		const gw = col(out, 'a', 'groundwater_used') ?? gd.map(() => 0);
		for (let t = 0; t < gd.length; t++) expect(gd[t]! + gw[t]!, `day ${t}`).toBeLessThanOrEqual(perDay * (1 + 1e-12));
		// The rate binds: without it the borehole pumps more on some day.
		const free = runModelWithoutChecks(withAllocations([{ id: 'g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: volume }], 'cap', borehole('dam', 'primary')));
		expect(Math.max(...col(free, 'a', 'groundwater_to_dam')!)).toBeGreaterThan(perDay * 1.01);
		expect(gd.some((v, t) => Math.abs(v + gw[t]! - perDay) <= perDay * 1e-9)).toBe(true);
	});

	it('keeps a water user’s river take to its months of use', () => {
		const x = withAllocations([{ id: 'u', nodeId: 'u', waterSource: 'surface', volumeM3PerYear: 1e9, months: summer }], 'cap', (m) => {
			const g = m.model.nodes.find((n) => n.id === 'g')!;
			m.model.nodes.push({ ...g, id: 'u', name: 'Town', kind: 'user', sortOrder: 3, downstreamNodeId: null, userDemandM3Day: new Array(12).fill(103), userReturnPct: 0, userPriority: 'senior' });
			g.downstreamNodeId = 'u';
		});
		const out = runModelChecked(x);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const G = col(out, 'u', 'supplied')!;
		let inMonths = 0;
		for (let t = 0; t < G.length; t++) {
			if (summer.includes(monthOf(out, t))) inMonths += G[t]!;
			else expect(G[t], `day ${t}`).toBe(0);
		}
		expect(inMonths).toBeGreaterThan(0);
	});

	it('the self-check catches a room left at the licence limit once the year’s volume is used (negative control)', () => {
		// Both bind: half the mean volume, at half the busiest day's rate.
		const perDay = Math.max(...col(base, 'a', 'supplied')!) / 2;
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2, maxRateM3s: perDay / 86_400 }], 'cap');
		const out = runModelWithoutChecks(x);
		expect(checkAllocations(x, out)).toBeNull();
		const room = out.series.find((s) => s.nodeId === 'a' && s.key === ALLOCATION_SERIES.surfaceRoom.key)!.values;
		// A day the year's volume is spent (not a 1 October, where the room starts again).
		const spent = room.findIndex((r, t) => r === 0 && monthOf(out, t) !== 10);
		expect(spent).toBeGreaterThan(0);
		const bad = structuredClone(out);
		bad.series.find((s) => s.nodeId === 'a' && s.key === ALLOCATION_SERIES.surfaceRoom.key)!.values[spent] = perDay;
		expect(checkAllocations(x, bad)).toMatch(/is more than the year's registered .* less the .* it has taken this water year/);
	});

	it('warns in a cap run when a licence’s rate can’t deliver its volume, and names a rate of 0', () => {
		expect(rateShortfall({ id: 'z', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 100, maxRateM3s: 0 })).toMatch(/maximum rate is 0/);
		// 0.001 m³/s is 31 536 m³ a year, 15 811 m³ in April–September.
		expect(rateShortfall({ id: 'r', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 100_000, maxRateM3s: 0.001 })).toMatch(/at most 31536 m³ in a year, less than its 100000 m³/);
		expect(rateShortfall({ id: 'w', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 20_000, maxRateM3s: 0.001, months: winter })).toMatch(/at most 15811 m³ in its months of use/);
		expect(rateShortfall({ id: 'ok', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 30_000, maxRateM3s: 0.001 })).toBeNull();
		const list: AllocationEntry[] = [{ id: 'z', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 100, maxRateM3s: 0 }];
		expect(runModelWithoutChecks(withAllocations(list, 'cap')).summary.warnings.some((w) => /maximum rate is 0/.test(w))).toBe(true);
		expect(runModelWithoutChecks(withAllocations(list, 'none')).summary.warnings.some((w) => /maximum rate is 0/.test(w))).toBe(false);
	});

	it('a scenario’s allocation.set brings its months of use and maximum rate into the cap, and allocation.remove takes them out', () => {
		const rate = Math.max(...col(base, 'a', 'supplied')!) / 2 / 86_400;
		const bare: AllocationEntry = { id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume };
		const licensed: AllocationEntry = { ...bare, months: [3, 1, 2, 12, 11, 10], maxRateM3s: rate };
		const x = withAllocations([bare], 'cap');
		const set = applyScenario(x, [{ op: 'allocation.set', allocation: licensed }]);
		expect(set.problems).toEqual([]);
		// The months as a sorted set, as the backend stores them; the run is the one on the same licence entered directly.
		expect(set.input.model.allocations).toEqual([{ ...licensed, months: summer.slice().sort((p, q) => p - q) }]);
		const viaScenario = runModelChecked(set.input);
		expect(viaScenario.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const direct = runModelWithoutChecks(withAllocations([licensed], 'cap'));
		expect(col(viaScenario, 'a', 'supplied')).toEqual(col(direct, 'a', 'supplied'));
		const G = col(viaScenario, 'a', 'supplied')!;
		for (let t = 0; t < G.length; t++) {
			if (!summer.includes(monthOf(viaScenario, t))) expect(G[t], `day ${t}`).toBe(0);
			expect(G[t]!, `day ${t}`).toBeLessThanOrEqual(rate * 86_400 * (1 + 1e-12));
		}
		// Positive control: without the conditions the farm takes water outside those months.
		const free = runModelWithoutChecks(x);
		expect(col(free, 'a', 'supplied')!.some((g, t) => g > 0 && !summer.includes(monthOf(free, t)))).toBe(true);
		// Removing the licensed volume leaves the farm uncapped: the base run's supply.
		const removed = applyScenario(withAllocations([licensed], 'cap'), [{ op: 'allocation.remove', allocationId: 's' }]);
		expect(removed.problems).toEqual([]);
		expect(col(runModelWithoutChecks(removed.input), 'a', 'supplied')).toEqual(col(base, 'a', 'supplied'));
		// A condition that doesn't read is refused, not dropped.
		expect(applyScenario(x, [{ op: 'allocation.set', allocation: { ...bare, months: [13] } }]).problems[0]).toMatch(/months/);
		expect(applyScenario(x, [{ op: 'allocation.set', allocation: { ...bare, maxRateM3s: -1 } }]).problems[0]).toMatch(/maxRateM3s/);
	});

	describe('dailyLimits', () => {
		const start = toEpochDay('2001-10-01');
		it('is null when no allocation of the source states a condition', () => {
			expect(dailyLimits([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1 }], 'surface', start, 10)).toBeNull();
			expect(dailyLimits([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, months: [] }], 'surface', start, 10)).toBeNull();
			expect(dailyLimits([{ id: 'g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: 1, maxRateM3s: 1 }], 'surface', start, 10)).toBeNull();
		});

		it('sums the in-force allocations whose months include the day; one with no rate lifts the limit', () => {
			const a: AllocationEntry[] = [
				{ id: 'oct', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, months: [10], maxRateM3s: 1 },
				{ id: 'any', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, maxRateM3s: 0.5 }
			];
			const l = dailyLimits(a, 'surface', start, 40)!;
			expect(l[0]).toBeCloseTo(1.5 * 86_400, 9); // 1 October: both
			expect(l[31]).toBeCloseTo(0.5 * 86_400, 9); // 1 November: the second only
			const open = dailyLimits([...a, { id: 'free', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1 }], 'surface', start, 40)!;
			expect(open[0]).toBe(Infinity);
		});

		it('gives 0 in a month no in-force allocation may use, and no limit on a day none is in force', () => {
			const a: AllocationEntry[] = [{ id: 'm', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, months: [11], validTo: '2001-11-15' }];
			const l = dailyLimits(a, 'surface', start, 60)!;
			expect(l[0]).toBe(0); // October: outside its months
			expect(l[31]).toBe(Infinity); // November, no rate stated
			expect(l[50]).toBe(Infinity); // after it ends: nothing in force, the year's budget alone binds
		});

		it('gives the same limits at UTC+14 and UTC−11 (date arithmetic is UTC)', () => {
			const tz = process.env.TZ;
			const a: AllocationEntry[] = [{ id: 'm', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, months: [10, 3], maxRateM3s: 0.1, validFrom: '2001-10-15', validTo: '2002-03-10' }];
			const limits = () => Array.from(dailyLimits(a, 'surface', start, 366)!);
			try {
				process.env.TZ = 'Pacific/Kiritimati';
				const east = limits();
				process.env.TZ = 'Pacific/Pago_Pago';
				expect(limits()).toEqual(east);
				// 14 October is before it is in force, 15 October in it, 1 November outside its months, 10 March its last day.
				expect([east[13], east[14], east[31], east[160], east[161]]).toEqual([Infinity, 0.1 * 86_400, 0, 0.1 * 86_400, Infinity]);
			} finally {
				process.env.TZ = tz;
			}
		});

		it('a rate of 0 allows nothing', () => {
			expect(dailyLimits([{ id: 'z', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, maxRateM3s: 0 }], 'surface', start, 3)).toEqual(new Float64Array(3));
		});
	});
});

describe('the allocations a run reads', () => {
	it('leaves out a row whose volume, source or dates don’t read, with a warning', () => {
		const w: string[] = [];
		const ok = usableAllocations(
			[
				{ id: 'ok', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1 },
				{ id: 'neg', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: -1 },
				{ id: 'src', nodeId: 'a', waterSource: 'rain' as never, volumeM3PerYear: 1 },
				{ id: 'date', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, validFrom: '2001-02-30' },
				{ id: 'order', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, validFrom: '2002-01-01', validTo: '2001-01-01' }
			],
			w
		);
		expect(ok.map((a) => a.id)).toEqual(['ok']);
		expect(w).toHaveLength(4);
	});

	it('leaves out an unknown water use, and ignores a volume on a storage-only row, with warnings (engine 1.59.0)', () => {
		const w: string[] = [];
		const ok = usableAllocations(
			[
				{ id: 'c', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, waterUse: '21c' as never },
				{ id: 'b', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 120_000, waterUse: '21b', storageM3: 5 }
			],
			w
		);
		expect(ok).toEqual([{ id: 'b', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 0, waterUse: '21b', storageM3: 5 }]);
		expect(w).toEqual([expect.stringMatching(/allocation c left out: its water use "21c"/), expect.stringMatching(/allocation b: it is storage only \(21b\)/)]);
	});

	it('drops a licence condition that doesn’t read, keeping the volume, with a warning', () => {
		const w: string[] = [];
		const ok = usableAllocations(
			[
				{ id: 'm', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, months: [0, 13] },
				{ id: 'r', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, maxRateM3s: -1 },
				{ id: 'fine', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, months: [1, 12], maxRateM3s: 0.2 }
			],
			w
		);
		expect(ok.map((a) => [a.id, a.months ?? null, a.maxRateM3s ?? null])).toEqual([
			['m', null, null],
			['r', null, null],
			['fine', [1, 12], 0.2]
		]);
		expect(w).toHaveLength(2);
	});

	it('an unknown mode only compares, with a warning', () => {
		const out = runModel(withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1 }], 'bogus' as never));
		expect(out.summary.allocations!.mode).toBe('none');
		expect(out.summary.warnings.some((w) => /allocationMode "bogus"/.test(w))).toBe(true);
	});

	it('registeredOver prorates each allocation by its valid days in the water year', () => {
		const a: AllocationEntry[] = [{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 365, validTo: '2001-10-10' }];
		expect(registeredOver(a, 2001, toEpochDay('2001-10-01'), toEpochDay('2002-09-30'))).toBeCloseTo(10, 12);
	});

	it('a scenario can switch the mode (settings.set allocationMode)', () => {
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2 }]);
		const r = applyScenario(x, [{ op: 'settings.set', path: 'allocationMode', value: 'cap' }]);
		expect(r.problems).toEqual([]);
		expect(r.input.settings.allocationMode).toBe('cap');
		expect(applyScenario(x, [{ op: 'settings.set', path: 'allocationMode', value: 'nope' as never }]).problems[0]).toMatch(/allocationMode/);
	});
});

describe("allocationMode 'cap': the days the licence limit bound (engine 1.40.0)", () => {
	const volume = meanA * 10;
	const summer = [10, 11, 12, 1, 2, 3];
	const monthOf = (out: ModelOutput, t: number) => monthOfEpochDay(toEpochDay(out.startDate) + t);
	const source = (out: ModelOutput, nodeId = 'a', waterSource = 'surface') => out.summary.allocations!.nodes.find((n) => n.nodeId === nodeId)!.sources.find((x) => x.waterSource === waterSource)!;
	const total = (ys: readonly AllocationLimitBound[], k: 'days' | 'volumeDays' | 'rateDays' | 'monthsDays') => ys.reduce((a, y) => a + y[k], 0);
	/** Days the farm went short, per water year: `pick` days only. */
	const shortDays = (out: ModelOutput, pick: (t: number) => boolean) => {
		const W = col(out, 'a', 'deficit')!;
		const D = col(out, 'a', 'demand')!;
		return perYear(out, W.map((w, t) => (pick(t) && w > 1e-9 * Math.max(D[t]!, 1) ? 1 : 0)));
	};

	it('counts the days outside the months of use a short farm could take nothing, and only those', () => {
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume, months: summer }], 'cap');
		const out = runModelChecked(x);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const lb = source(out).limitBound!;
		// Every day it was short outside its months is a bound day; the volume and rate never bind.
		const want = shortDays(out, (t) => !summer.includes(monthOf(out, t)));
		expect(lb.map((y) => [y.waterYear, y.monthsDays])).toEqual([...want].filter(([, n]) => n > 0));
		expect(total(lb, 'monthsDays')).toBeGreaterThan(0);
		expect(total(lb, 'volumeDays') + total(lb, 'rateDays')).toBe(0);
		for (const y of lb) expect(y.days).toBe(y.volumeDays + y.rateDays + y.monthsDays);
		// The volume isn't reached: capReached alone read "never".
		expect(source(out).capReached).toEqual([]);
	});

	it('counts the days the maximum rate held a short farm back as rate days', () => {
		const perDay = Math.max(...col(base, 'a', 'supplied')!) / 2;
		const out = runModelChecked(withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: volume, maxRateM3s: perDay / 86_400 }], 'cap'));
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const lb = source(out).limitBound!;
		const G = col(out, 'a', 'supplied')!;
		const atRate = shortDays(out, (t) => Math.abs(G[t]! - perDay) <= perDay * 1e-9);
		expect(total(lb, 'rateDays')).toBe([...atRate.values()].reduce((a, n) => a + n, 0));
		expect(total(lb, 'rateDays')).toBeGreaterThan(0);
		expect(total(lb, 'monthsDays') + total(lb, 'volumeDays')).toBe(0);
	});

	it('counts volume days once the year’s volume is used, with no allocation_left column without conditions', () => {
		const out = runModelChecked(withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2 }], 'cap'));
		const src = source(out);
		expect(total(src.limitBound!, 'volumeDays')).toBeGreaterThan(0);
		expect(total(src.limitBound!, 'rateDays') + total(src.limitBound!, 'monthsDays')).toBe(0);
		// Every year that reached the cap and then went short has bound days.
		for (const r of src.capReached!) expect(src.limitBound!.some((y) => y.waterYear === r.waterYear), String(r.waterYear)).toBe(true);
		expect(col(out, 'a', ALLOCATION_SERIES.surfaceLeft.key)).toBeUndefined();
	});

	it('stores what is left of the year’s volume beside the room when the licence states conditions', () => {
		const perDay = Math.max(...col(base, 'a', 'supplied')!) / 2;
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2, months: summer, maxRateM3s: perDay / 86_400 }], 'cap');
		const out = runModelChecked(x);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		const left = col(out, 'a', ALLOCATION_SERIES.surfaceLeft.key)!;
		const room = col(out, 'a', ALLOCATION_SERIES.surfaceRoom.key)!;
		const G = col(out, 'a', 'supplied')!;
		const k = toEpochDay('2003-10-01') - toEpochDay(out.startDate);
		expect(left[k]).toBeCloseTo(meanA / 2, 6);
		expect(left[k + 1]).toBeCloseTo(meanA / 2 - G[k]!, 6);
		// Outside the months the room is 0 while volume is left: the column the room hides.
		const hidden = left.findIndex((l, t) => !summer.includes(monthOf(out, t)) && l > 0);
		expect(hidden).toBeGreaterThanOrEqual(0);
		expect(room[hidden]).toBe(0);
		for (let t = 0; t < left.length; t++) expect(room[t]).toBeLessThanOrEqual(left[t]!);
		// All three limits bind somewhere in the record.
		const lb = source(out).limitBound!;
		expect(total(lb, 'volumeDays')).toBeGreaterThan(0);
		expect(total(lb, 'rateDays')).toBeGreaterThan(0);
		expect(total(lb, 'monthsDays')).toBeGreaterThan(0);
		// Not for a farm without conditions, nor in another mode.
		expect(col(out, 'b', ALLOCATION_SERIES.surfaceLeft.key)).toBeUndefined();
		const none = runModelWithoutChecks({ ...x, settings: { ...x.settings, allocationMode: 'none' } });
		expect(col(none, 'a', ALLOCATION_SERIES.surfaceLeft.key)).toBeUndefined();
		expect(source(none).limitBound).toBeUndefined();
	});

	it('counts a water user’s days outside its months, and a groundwater licence’s', () => {
		const u = withAllocations([{ id: 'u', nodeId: 'u', waterSource: 'surface', volumeM3PerYear: 1e9, months: summer }], 'cap', (m) => {
			const g = m.model.nodes.find((n) => n.id === 'g')!;
			m.model.nodes.push({ ...g, id: 'u', name: 'Town', kind: 'user', sortOrder: 3, downstreamNodeId: null, userDemandM3Day: new Array(12).fill(103), userReturnPct: 0, userPriority: 'senior' });
			g.downstreamNodeId = 'u';
		});
		const ou = runModelChecked(u);
		expect(ou.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		expect(total(source(ou, 'u').limitBound!, 'monthsDays')).toBeGreaterThan(0);
		const winter = [4, 5, 6, 7, 8, 9];
		const g = withAllocations(
			[
				{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1 },
				{ id: 'g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: volume, months: winter }
			],
			'cap',
			(m) => (m.model.boreholes = [{ id: 'bh', nodeId: 'a', name: 'Borehole', capacityM3Day: 1e6, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0, target: 'direct', depletionFactor: 0.5 }])
		);
		const og = runModelChecked(g);
		expect(og.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		expect(total(source(og, 'a', 'groundwater').limitBound!, 'monthsDays')).toBeGreaterThan(0);
		expect(col(og, 'a', ALLOCATION_SERIES.groundwaterLeft.key)).toBeDefined();
		// The surface trickle has no conditions: its limit is its volume.
		expect(col(og, 'a', ALLOCATION_SERIES.surfaceLeft.key)).toBeUndefined();
		expect(total(source(og).limitBound!, 'volumeDays')).toBeGreaterThan(0);
	});

	it('a resumed run counts the same bound days in its water years as the uninterrupted one', () => {
		const perDay = Math.max(...col(base, 'a', 'supplied')!) / 2;
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2, months: summer, maxRateM3s: perDay / 86_400 }], 'cap');
		const full = runModelWithoutChecks(x);
		const tail = runModelFrom(captureModelState(x, '2006-10-01'), x);
		const fromFull = source(full).limitBound!.filter((y) => y.waterYear >= 2006);
		expect(source(tail).limitBound).toEqual(fromFull);
	});

	it('a run resumed inside a water year counts that year’s bound days on its own days only, the later years as the uninterrupted run', () => {
		const perDay = Math.max(...col(base, 'a', 'supplied')!) / 2;
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2, months: summer, maxRateM3s: perDay / 86_400 }], 'cap');
		const full = runModelWithoutChecks(x);
		const at = '2007-01-15';
		const tail = runModelFrom(captureModelState(x, at), x);
		const k = toEpochDay(at) - toEpochDay(full.startDate);
		const lb = (o: ModelOutput) => source(o).limitBound!;
		expect(lb(tail).filter((y) => y.waterYear > 2006)).toEqual(lb(full).filter((y) => y.waterYear > 2006));
		const y2006 = (o: ModelOutput) => lb(o).find((y) => y.waterYear === 2006)?.days ?? 0;
		expect(y2006(tail)).toBeLessThanOrEqual(y2006(full));
		// Positive control: the full run has bound days in 2006/07 before the resume day.
		const W = col(full, 'a', 'deficit')!;
		const first = toEpochDay('2006-10-01') - toEpochDay(full.startDate);
		expect(W.slice(first, k).some((w) => w > 0)).toBe(true);
		expect(checkAllocations(x, tail)).toBeNull();
	});

	it('the self-check catches bound days that don’t follow from the columns, and a wrong allocation_left (negative controls)', () => {
		const perDay = Math.max(...col(base, 'a', 'supplied')!) / 2;
		const x = withAllocations([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: meanA / 2, months: summer, maxRateM3s: perDay / 86_400 }], 'cap');
		const out = runModelWithoutChecks(x);
		expect(checkAllocations(x, out)).toBeNull();
		const bad = structuredClone(out);
		const y = source(bad).limitBound![0]!;
		y.monthsDays++;
		y.days++;
		expect(checkAllocations(x, bad)).toMatch(/the days the licence limit bound .* don't follow from the run's own columns/);
		const bad2 = structuredClone(out);
		const left = bad2.series.find((s) => s.nodeId === 'a' && s.key === ALLOCATION_SERIES.surfaceLeft.key)!.values;
		const april = toEpochDay('2004-04-10') - toEpochDay(out.startDate);
		left[april] = left[april]! + 1000;
		expect(checkAllocations(x, bad2)).toMatch(/what is left of the surface volume is/);
		const bad3 = structuredClone(out);
		bad3.series = bad3.series.filter((s) => !(s.nodeId === 'a' && s.key === ALLOCATION_SERIES.surfaceLeft.key));
		expect(checkAllocations(x, bad3)).toMatch(/no allocation_left_surface column for a surface volume with licence conditions/);
	});

	it('limitBoundKind and outsideMonths', () => {
		// Short, took all its room: which limit set it.
		expect(limitBoundKind(100, Infinity, false, 100, 150, 50, 1000)).toBe('volumeDays');
		expect(limitBoundKind(0, 0, true, 0, 150, 150, 1000)).toBe('volumeDays');
		expect(limitBoundKind(100, 0, true, 0, 150, 150, 1000)).toBe('monthsDays');
		expect(limitBoundKind(100, 0, false, 0, 150, 150, 1000)).toBe('rateDays');
		expect(limitBoundKind(100, 40, false, 40, 150, 110, 1000)).toBe('rateDays');
		// A volume used up to summing noise is used up, even outside the months.
		expect(limitBoundKind(1e-10, 0, true, 0, 150, 150, 1000)).toBe('volumeDays');
		expect(limitBoundKind(1e-3, 0, true, 0, 150, 150, 1000)).toBe('monthsDays');
		// Not short, or took less than its room: didn't bind.
		expect(limitBoundKind(100, 0, true, 0, 0, 0, 1000)).toBeNull();
		// A noise-level deficit doesn't count: below 10⁻⁹ of the demand, and below 10⁻⁹ m³ on a demand
		// under 1 m³ (verify random seed 145: a 1.4e-12 m³ demand; engine 1.57.0 no longer makes one).
		expect(limitBoundKind(0, 0, false, 0, 1.4e-12, 1.4e-12, 1000)).toBeNull();
		expect(limitBoundKind(0, 0, false, 0, 0.5, 2e-9, 1000)).toBe('volumeDays');
		expect(limitBoundKind(100, 40, false, 30, 150, 120, 1000)).toBeNull();
		const start = toEpochDay('2003-09-30');
		const a: AllocationEntry[] = [{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, months: [10] }];
		expect(Array.from(outsideMonths(a, 'surface', start, 2)!)).toEqual([1, 0]);
		// Another licence in force that states no months: every month may be used.
		expect(Array.from(outsideMonths([...a, { id: 't', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1 }], 'surface', start, 2)!)).toEqual([0, 0]);
		// Not in force yet: no limit, not outside.
		expect(Array.from(outsideMonths([{ ...a[0]!, validFrom: '2003-10-01' }], 'surface', start, 2)!)).toEqual([0, 0]);
		expect(outsideMonths([{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, maxRateM3s: 1 }], 'surface', start, 2)).toBeNull();
	});
});
