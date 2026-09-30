// allocationMode (engine 1.18.0, issue #72, docs/model.md §2.12a) on the
// invented outlook catchment (two farms on vines into one outlet). Random
// networks with allocations in every mode are in the engine fuzz
// (../testing/fuzz.ts randomAllocations) and the warm-start invariants.
import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { testCatchment } from '../outlook/testCatchment';
import type { ModelInput, ModelOutput } from '../project';
import { captureModelState, runModel, runModelChecked, runModelFrom, runModelWithoutChecks } from '../run';
import { applyScenario } from '../scenario';
import { checkResume } from '../testing/warmstartInvariants';
import type { AllocationEntry } from './compare';
import { checkAllocations } from '../verify/checks';
import { ALLOCATION_SERIES, dailyLimits, fullAllocationFactors, registeredOver, usableAllocations, yearBudgets } from './mode';

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

	it('a year with no demand on its historical days takes nothing on its tail days either', () => {
		const a: AllocationEntry[] = [{ id: 's', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 365 }];
		const demand = Float64Array.from({ length: 365 }, (_, t) => (t < 100 ? 0 : 2));
		const f = fullAllocationFactors(a, demand, toEpochDay('2001-10-01'), 365, undefined, 100);
		// As the run without the tail: no demand in the year, factor 0, listed as unscaled; the tail keeps it.
		expect([...new Set(f.factor)]).toEqual([0]);
		expect(f.unscaled).toEqual([2001]);
		expect(fullAllocationFactors(a, demand.subarray(0, 100), toEpochDay('2001-10-01'), 100).unscaled).toEqual([2001]);
	});
});

describe("allocationMode 'cap': licence conditions (engine 1.33.0, issue #72)", () => {
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
