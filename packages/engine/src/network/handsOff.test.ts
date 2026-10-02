// Hands-off flow and River to dam by month (engine ≥ 1.32.0, WP-3.8, issue
// #204, docs/model.md §2.7h): hand-worked cases on a fixed natural flow, the
// resolver's validation, the new self-check catching broken series, and the
// defaults (no fields, or fields that change nothing) running exactly as before.
import { describe, expect, it } from 'vitest';
import { OPERATING_DEFAULTS, type ModelInput, type ModelOutput, type NetworkNode } from '../project';
import { runModel, runModelWith, withVerification } from '../run';
import { randomInput } from '../testing/fuzz';
import { sameOutput } from '../testing/invariants';
import { checkInvariants, checkOperatingRules, checkWorkings } from '../verify/checks';
import { divertCapacityToday, handsOffToday, operatingOf } from './supply';

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

const flat = (v: number) => new Array(12).fill(v) as number[];

/**
 * Dry days from `start`. Farm A, the only farm (so its runoff I is the natural
 * flow and its EWR share is 1), needs `need` m³/day in every month (31 000 m²
 * of a crop with factor 1, the A-pan set to the need, efficiency 1, no
 * effective rain, a dam with no surface so no evaporation), and drains into
 * the outlet gauge G. The pragmatic EWR is `ewr` m³/day all year.
 */
function input(a: Partial<NetworkNode>, need: number, days: number, opts: { start?: string; ewr?: number } = {}): ModelInput {
	const start = opts.start ?? '2021-01-01';
	// A-pan mm per month such that 31 000 m² × apan ÷ 1000 ÷ days in month = need m³/day.
	const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	const apanMm = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => (need * dim[m - 1]! * 1000) / 31_000);
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(opts.ewr ?? 0) as never },
		model: {
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', a)],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: start, values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ModelOutput, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values;
const passed = (o: ModelOutput) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification!.checks.filter((c) => !c.passed))).toBe(true);
const near = (xs: readonly number[] | undefined, want: number[]) => {
	expect(xs).toHaveLength(want.length);
	want.forEach((w, t) => expect(xs![t]!, `day ${t}`).toBeCloseTo(w, 9));
};

// A 10 000 m³ dam starting at 5000, half the farm's runoff into it (M), half below it (S).
const dam = { damCapacityM3: 10_000, damInitialPct: 0.5, pctRunoffToDam: 0.5 };

describe('the hands-off flow and the river pump (issue #204)', () => {
	it('the pump takes only the flow below the dam above the hands-off flow', () => {
		// S = 500, 2000, 0. Without it the pump takes MIN(5000, S); with 700 kept, MAX(0, S − 700).
		const natural = [1000, 4000, 0];
		const open = run(input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 5000 }, 2000, 3), natural);
		const kept = run(input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 5000, handsOffM3Day: flat(700) }, 2000, 3), natural);
		passed(open);
		passed(kept);
		expect(col(open, 'A', 'river_abstraction')).toEqual([500, 2000, 0]);
		expect(col(kept, 'A', 'river_abstraction')).toEqual([0, 1300, 0]);
		// The dam covers the rest of the 2000 demand: 5000 + 500 − 2000; + 2000 − 700; + 0 − 2000.
		expect(col(kept, 'A', 'dam_storage')).toEqual([3500, 4800, 2800]);
		// What passes: all of S on the dry day (less than the 700), the 700 on the wet one.
		expect(col(kept, 'A', 'outflow')).toEqual([500, 700, 0]);
	});

	it('with handsOffEwr the pump leaves the EWR required at the farm (Z)', () => {
		const natural = [1000, 4000, 0];
		const o = run(input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 5000, handsOffEwr: true }, 2000, 3, { ewr: 600 }), natural);
		passed(o);
		expect(col(o, 'A', 'ewr_cumulative')).toEqual([600, 600, 600]);
		expect(col(o, 'A', 'river_abstraction')).toEqual([0, 1400, 0]);
		// The larger of the fixed amount and the EWR is kept.
		const both = run(input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 5000, handsOffEwr: true, handsOffM3Day: flat(900) }, 2000, 3, { ewr: 600 }), natural);
		passed(both);
		expect(col(both, 'A', 'river_abstraction')).toEqual([0, 1100, 0]);
		// Without the flag the EWR isn't the pump's to keep (as before, §2.7e).
		const off = run(input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 5000 }, 2000, 3, { ewr: 600 }), natural);
		expect(col(off, 'A', 'river_abstraction')).toEqual([500, 2000, 0]);
	});

	it('run of river: the pump stops at the hands-off flow and the rest is a deficit', () => {
		const o = run(input({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 1500, handsOffM3Day: flat(800) }, 2000, 3), [1000, 4000, 500]);
		passed(o);
		expect(col(o, 'A', 'river_abstraction')).toEqual([200, 1500, 0]);
		expect(col(o, 'A', 'deficit')).toEqual([1800, 500, 2000]);
		expect(col(o, 'A', 'outflow')).toEqual([800, 2500, 500]);
	});
});

describe('the hands-off flow and River to dam (issue #204)', () => {
	// All the runoff passes below the dam (N = the natural flow); River to dam takes up to 3000 of it back.
	const div = { damCapacityM3: 1e6, divertCapacityM3Day: 3000 };

	it('River to dam diverts only what flows above the hands-off flow', () => {
		const natural = [1000, 4000, 0];
		const open = run(input(div, 0, 3), natural);
		const kept = run(input({ ...div, handsOffM3Day: flat(800) }, 0, 3), natural);
		passed(open);
		passed(kept);
		expect(col(open, 'A', 'diverted_to_dam')).toEqual([1000, 3000, 0]);
		// The dry day: only 200 above the 800; the wet day: 3200 above it, so the capacity binds.
		expect(col(kept, 'A', 'diverted_to_dam')).toEqual([200, 3000, 0]);
		expect(col(kept, 'A', 'below_dam_not_diverted')).toEqual([800, 1000, 0]);
		expect(col(kept, 'A', 'dam_storage')).toEqual([200, 3200, 3200]);
	});

	it('keeps the EWR with handsOffEwr, and never cuts what the dam split sends into the dam (K, M)', () => {
		const o = run(input({ ...div, pctRunoffToDam: 0.5, handsOffEwr: true }, 0, 2, { ewr: 450 }), [1000, 4000]);
		passed(o);
		// M = 500, 2000 into the dam as before; of N = 500, 2000, River to dam leaves 450.
		expect(col(o, 'A', 'runoff_to_dam')).toEqual([500, 2000]);
		expect(col(o, 'A', 'diverted_to_dam')).toEqual([50, 1550]);
		expect(col(o, 'A', 'below_dam_not_diverted')).toEqual([450, 450]);
	});

	it('River to dam by month: 0 in summer fills the dam in winter only', () => {
		// 30 March – 2 April 2021. Winter only: April–September (water-year months 7–12) 500 m³/day, the rest 0.
		const winter = [0, 0, 0, 0, 0, 0, 500, 500, 500, 500, 500, 500];
		const o = run(input({ damCapacityM3: 1e6, divertCapacityM3Day: 99_999, divertMonthlyM3Day: winter }, 0, 4, { start: '2021-03-30' }), [1000, 1000, 1000, 1000]);
		passed(o);
		expect(col(o, 'A', 'diverted_to_dam')).toEqual([0, 0, 500, 500]);
		// A hands-off flow by month binds only in its own month: April keeps 700, March nothing.
		const handsOff = flat(0);
		handsOff[6] = 700;
		const k = run(input({ damCapacityM3: 1e6, divertMonthlyM3Day: winter, handsOffM3Day: handsOff }, 0, 4, { start: '2021-03-30' }), [1000, 1000, 1000, 1000]);
		passed(k);
		expect(col(k, 'A', 'diverted_to_dam')).toEqual([0, 0, 300, 300]);
	});

	it('the senior users’ pass and the hands-off flow together keep the larger of the two below the dam', () => {
		// A senior user below A wants 600; A diverts up to 3000 and keeps 400 hands-off. MAX(600, 400) passes.
		const i = input({ ...div, handsOffM3Day: flat(400) }, 0, 2);
		i.model.nodes.push(node('U', 'user', 'G', { userDemandM3Day: flat(600), userPriority: 'senior' }));
		i.model.nodes.find((n) => n.id === 'A')!.downstreamNodeId = 'U';
		const o = run(i, [1000, 300]);
		passed(o);
		near(col(o, 'A', 'diverted_to_dam'), [400, 0]);
		near(col(o, 'A', 'below_dam_not_diverted'), [600, 300]);
	});
});

describe('the hands-off flow on a farm without a dam (issue #204)', () => {
	// With no dam, what the split and River to dam send "into the dam" (K, M, O) is irrigated straight from
	// the river (b023's stand-in for a river pump), so the hands-off flow cuts all three: O first, then K and M.

	it('upstream inflow routed to an absent dam leaves the hands-off flow (H = 1000, D = 2000, 700 kept)', () => {
		// B, upstream, has no crops and passes its runoff to A; A has no area of its own, so H = 1000, I = 0.
		const mk = (a: Partial<NetworkNode>) => {
			const i = input({ areaKm2: 0, pctUpstreamToDam: 1, ...a }, 2000, 1);
			i.model.nodes.push(node('B', 'farm', 'A'));
			return i;
		};
		const open = run(mk({}), [1000]);
		const kept = run(mk({ handsOffM3Day: flat(700) }), [1000]);
		passed(open);
		passed(kept);
		expect(col(kept, 'A', 'inflow_upstream')).toEqual([1000]);
		// Before: all 1000 went into the absent dam and was irrigated, and nothing flowed on.
		expect(col(open, 'A', 'supplied')).toEqual([1000]);
		expect(col(open, 'A', 'outflow')).toEqual([0]);
		// Now K is cut to 300 and 700 passes.
		expect(col(kept, 'A', 'upstream_to_dam')).toEqual([300]);
		expect(col(kept, 'A', 'supplied')).toEqual([300]);
		expect(col(kept, 'A', 'outflow')).toEqual([700]);
	});

	it('cuts O first, then M, and takes nothing (exactly) when less than the hands-off flow flows', () => {
		// Half the runoff to the absent dam, River to dam up to 3000 of the rest, 700 kept.
		const o = run(input({ pctRunoffToDam: 0.5, divertCapacityM3Day: 3000, handsOffM3Day: flat(700) }, 2000, 3), [1000, 4000, 300]);
		passed(o);
		// Day 0: M = 500, O = 500 took everything; O goes to 0 and M to 300. Day 1: O alone is cut, 2000 → 1300.
		// Day 2: 300 < 700 flows, so all of it passes: M and O exactly 0.
		expect(col(o, 'A', 'diverted_to_dam')).toEqual([0, 1300, 0]);
		expect(col(o, 'A', 'runoff_to_dam')).toEqual([300, 2000, 0]);
		expect(col(o, 'A', 'below_dam_not_diverted')).toEqual([700, 700, 300]);
		expect(col(o, 'A', 'supplied')).toEqual([300, 2000, 0]);
	});

	it('a dam out of service (capacity 0 today) is none', () => {
		// The same farm with a 10 000 m³ dam that isn't in service until after the run: as without a dam.
		const o = run(input({ pctRunoffToDam: 1, damCapacityM3: 10_000, damInServiceFrom: '2030-01-01', handsOffM3Day: flat(700) }, 2000, 1), [1000]);
		passed(o);
		expect(col(o, 'A', 'runoff_to_dam')).toEqual([300]);
		expect(col(o, 'A', 'outflow')).toEqual([700]);
	});

	it('checkOperatingRules holds a farm without a dam to H + I − (K + M + O) ≥ MIN(H + I, keep)', () => {
		const i = input({ pctRunoffToDam: 1, handsOffM3Day: flat(700) }, 2000, 1);
		const out = runModelWith(i, () => ({ naturalFlowM3Day: [1000] }));
		expect(checkOperatingRules(i, out)).toBeNull();
		// M of 1000 and S of 0 (the run before the fix): nothing left for the river.
		const bad = structuredClone(out);
		const set = (key: string, v: number) => (bad.series.find((s) => s.nodeId === 'A' && s.key === key)!.values[0] = v);
		set('runoff_to_dam', 1000);
		set('runoff_below_dam', 0);
		set('below_dam_not_diverted', 0);
		expect(checkOperatingRules(i, bad)).toMatch(/with no dam, what it took into the dam and River to dam left 0 in the river, less than MIN\(the 1000 reaching it, the hands-off flow 700\)/);
	});
});

describe('operatingOf (issue #204)', () => {
	const farm = (over: Partial<NetworkNode>) => node('F', 'farm', 'G', over);
	it('none by default, and a hands-off flow of 0 in every month without the EWR is none', () => {
		const w: string[] = [];
		expect(operatingOf(farm({}), w)).toEqual({});
		expect(operatingOf(farm({ ...OPERATING_DEFAULTS }), w)).toEqual({});
		expect(operatingOf(farm({ handsOffM3Day: flat(0) }), w)).toEqual({});
		expect(w).toEqual([]);
	});

	it('resolves the months to calendar months, and the EWR flag', () => {
		const wy = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // Oct–Sep holding their calendar month numbers
		const r = operatingOf(farm({ handsOffM3Day: wy, handsOffEwr: true, divertMonthlyM3Day: wy.map((m) => m * 100) }), []);
		for (let m = 1; m <= 12; m++) {
			expect(r.handsOff!.m3DayByMonth![m]).toBe(m);
			expect(divertCapacityToday({ divertCapacityM3Day: 5, divertM3DayByMonth: r.divertM3DayByMonth! }, m)).toBe(m * 100);
		}
		expect(r.handsOff!.ewr).toBe(true);
		expect(handsOffToday(r.handsOff!, 3, 2)).toBe(3);
		expect(handsOffToday(r.handsOff!, 3, 7)).toBe(7);
		expect(handsOffToday({ m3DayByMonth: null, ewr: false }, 3, 7)).toBe(0);
		expect(divertCapacityToday({ divertCapacityM3Day: 5 }, 3)).toBe(5);
	});

	it('runs a bad month as 0 and a short row with its missing months 0, with a warning; ignores them on a gauge or user', () => {
		const w: string[] = [];
		const r = operatingOf(farm({ handsOffM3Day: [100, -1, Number.NaN], divertMonthlyM3Day: [...flat(50).slice(0, 11), -5] }), w);
		expect(r.handsOff!.m3DayByMonth![10]).toBe(100); // October
		expect(r.handsOff!.m3DayByMonth![11]).toBe(0);
		expect(r.handsOff!.m3DayByMonth![1]).toBe(0);
		expect(r.divertM3DayByMonth![9]).toBe(0); // September, −5
		expect(r.divertM3DayByMonth![8]).toBe(50);
		expect(w).toEqual([
			'unit "F": hands-off flow should have 12 monthly values, has 3; missing months are 0',
			'unit "F": hands-off flow has a month that is not a size ≥ 0 m³/day; that month is 0',
			'unit "F": River to dam by month has a month that is not a size ≥ 0 m³/day; that month is 0'
		]);
		const g: string[] = [];
		expect(operatingOf(node('U', 'user', 'G', { handsOffEwr: true }), g)).toEqual({});
		expect(g).toEqual(['user "U": only a unit has a hands-off flow and River to dam by month; ignored']);
	});
});

describe('the defaults run exactly as before (issue #204)', () => {
	it('fields absent, set to their defaults, or set so they change nothing, give the same output to the bit', () => {
		for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
			const base = randomInput(seed, { maxDays: 300 });
			for (const n of base.model.nodes) {
				delete n.handsOffM3Day;
				delete n.handsOffEwr;
				delete n.divertMonthlyM3Day;
			}
			const a = runModel(base);
			const explicit = structuredClone(base);
			for (const n of explicit.model.nodes) Object.assign(n, OPERATING_DEFAULTS);
			expect(sameOutput(a, runModel(explicit)), `seed ${seed}: defaults`).toBe(true);
			// A hands-off flow of 0 in every month, and River to dam by month equal to the one value every month.
			const inert = structuredClone(base);
			for (const n of inert.model.nodes) if (n.kind === 'farm') Object.assign(n, { handsOffM3Day: flat(0), handsOffEwr: false, divertMonthlyM3Day: flat(n.divertCapacityM3Day) });
			expect(sameOutput(a, runModel(inert)), `seed ${seed}: inert`).toBe(true);
		}
	});
});

describe('checkOperatingRules (issue #204)', () => {
	it('the random networks set hands-off flows and River to dam by month, and every invariant holds there', () => {
		let found = 0;
		let changed = 0;
		for (let seed = 1; seed < 400 && found < 6; seed++) {
			const x = randomInput(seed, { maxDays: 300 });
			if (!x.model.nodes.some((n) => n.handsOffM3Day || n.handsOffEwr || n.divertMonthlyM3Day)) continue;
			found++;
			const out = runModel(x);
			expect(checkInvariants(x, out), `seed ${seed}`).toBeNull();
			expect(checkOperatingRules(x, out), `seed ${seed}`).toBeNull();
			// The rules bind somewhere: without them the run is different.
			const without = structuredClone(x);
			for (const n of without.model.nodes) Object.assign(n, OPERATING_DEFAULTS);
			if (!sameOutput(out, runModel(without))) changed++;
		}
		expect(found).toBe(6);
		expect(changed).toBeGreaterThan(0);
	});

	const edit = (out: ModelOutput, key: string, f: (v: number[]) => void) => {
		const o = structuredClone(out);
		f(o.series.find((s) => s.nodeId === 'A' && s.key === key)!.values);
		return o;
	};

	it('catches a pump above its capacity or into the hands-off flow', () => {
		const i = input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 1500, handsOffM3Day: flat(700) }, 2000, 3);
		const out = runModelWith(i, () => ({ naturalFlowM3Day: [1000, 4000, 0] }));
		expect(checkOperatingRules(i, out)).toBeNull();
		// Day 1: S = 2000, the pump took 1300; 1600 is over the pump's 1500.
		expect(checkOperatingRules(i, edit(out, 'river_abstraction', (v) => (v[1] = 1600)))).toMatch(/the river pump took 1600, outside \[0, its capacity 1500\]/);
		// Day 0: S = 500, all of it must stay; taking 100 leaves 400 < MIN(500, 700).
		expect(checkOperatingRules(i, edit(out, 'river_abstraction', (v) => (v[0] = 100)))).toMatch(/the river pump left 400 in the river, less than MIN\(the 500 before it, the hands-off flow 700\)/);
	});

	it('catches River to dam into the hands-off flow or above the month’s capacity', () => {
		const winter = [0, 0, 0, 0, 0, 0, 500, 500, 500, 500, 500, 500];
		const i = input({ damCapacityM3: 1e6, divertMonthlyM3Day: winter, handsOffM3Day: flat(700) }, 0, 4, { start: '2021-03-30' });
		const out = runModelWith(i, () => ({ naturalFlowM3Day: [1000, 1000, 1000, 1000] }));
		expect(checkOperatingRules(i, out)).toBeNull();
		// March has no capacity: any diversion then is above it.
		expect(checkOperatingRules(i, edit(out, 'diverted_to_dam', (v) => (v[0] = 10)))).toMatch(/River to dam diverted 10, outside \[0, its capacity that month 0\]/);
		// April: 1000 before it, 700 must stay; S of 600 is too little.
		expect(checkOperatingRules(i, edit(out, 'below_dam_not_diverted', (v) => (v[2] = 600)))).toMatch(/River to dam left 600 below it, less than MIN\(the 1000 before it, the hands-off flow 700\)/);
		// The whole run's self-checks report it.
		const o = withVerification(i, edit(out, 'diverted_to_dam', (v) => (v[0] = 10)));
		expect(o.summary.verification!.checks.find((c) => c.id === 'operatingRules')!.passed).toBe(false);
	});

	it('checkWorkings replays River to dam, so a diversion cut to 0 is caught (the one-sided checks let it through)', () => {
		const i = input({ damCapacityM3: 1e6, divertCapacityM3Day: 3000, handsOffM3Day: flat(800) }, 0, 3);
		const out = runModelWith(i, () => ({ naturalFlowM3Day: [1000, 4000, 0] }));
		expect(checkWorkings(i, out)).toBeNull();
		// Day 1: 4000 below the dam, 800 kept, so River to dam takes its full 3000. O = 0 (S untouched) keeps
		// every bound checkOperatingRules holds, but not the replay.
		const tampered = edit(out, 'diverted_to_dam', (v) => (v[1] = 0));
		expect(checkOperatingRules(i, tampered)).toBeNull();
		expect(checkWorkings(i, tampered)).toMatch(/A day 1: diverted 0 ≠ 3000 \(MIN\(capacity 3000, L \+ N\) less what passes for the hands-off flow 800\)/);
	});

	it('the pump taking into the hands-off flow is reported under workings too', () => {
		const i = input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 1500, handsOffM3Day: flat(700) }, 2000, 3);
		const out = runModelWith(i, () => ({ naturalFlowM3Day: [1000, 4000, 0] }));
		const o = withVerification(i, edit(out, 'river_abstraction', (v) => (v[0] = 100)));
		const w = o.summary.verification!.checks.find((c) => c.id === 'workings')!;
		expect(w.passed).toBe(false);
		expect(w.detail).toMatch(/pumped 100 from the river, more than the 500 below the dam less the 700 that must pass/);
	});
});
