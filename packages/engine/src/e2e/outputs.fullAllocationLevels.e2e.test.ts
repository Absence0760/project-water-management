// End-to-end: demand levels and demand factors on a full-allocation run
// (docs/model.md §2.12a, §2.15, §2.3 step 4a; issue #90 Q29, engine ≥ 1.70.0).
//
// The rule: a full allocation's factor k is fitted on each unit's demand
// BEFORE its demand factors (a scenario's demand.scale, an outlook's or a
// sweep's level, the abstraction sensitivity case), and the factors then
// apply to the scaled demand: D = f × k × D₀. So a level of 0.8 asks for
// 80 % of the registered volume. Before 1.70.0, k was fitted on f × D₀ and a
// uniform level cancelled out: every level's members were identical.
//
//   - a hand-worked network (no rain, demand from demand objects and a water
//     user's monthly row, ample river): each factor's demand to the m³;
//   - outside full allocation nothing moves (none, cap), and a full
//     allocation with factors of 1 is the run without them, to the bit;
//   - the seasonal outlook on the invented test catchment: levels 0.6 / 0.8 /
//     1.0 / 1.2 give distinct members, each asking level × the volume
//     prorated over the season, monotone in demand and storage; the ER-23
//     hindcast factor (§2.15, engine ≥ 1.69.0) still reads no day on or after
//     the decision date, at every level; and the review triggers alike;
//   - the abstraction sensitivity case (§2.10g) moves a full-allocation run.
// Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import { toEpochDay, waterYearOf } from '../calendar';
import type { AllocationEntry } from '../allocations/compare';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { runModel, runModelWith, runModelWithoutChecks, withVerification } from '../run';
import { checkInvariants } from '../verify/checks';
import { applyScenario, type ScenarioOp } from '../scenario';
import { testCatchment } from '../outlook/testCatchment';
import { runSeasonalOutlook, type OutlookLevel } from '../outlook/outlook';
import { runReviewTriggers } from '../outlook/triggers';
import { sensitivityPlan, sensitivityRuns, SENSITIVITY_RANGES } from '../uncertainty';

const flat = (v: number) => new Array(12).fill(v);

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}; have ${out.series.filter((x) => x.nodeId === nodeId).map((x) => x.key).join(', ')}`);
	return s.values;
}
const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
function passes(input: ModelInput, out: ModelOutput) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	expect(out.summary.waterBalance!.total.residualM3).toBeCloseTo(0, 6);
}

// ---------------------------------------------------------------------------
// A hand-worked network. Water year 2021/22 (1 Oct 2021 … 30 Sep 2022, 365
// days), no rain, no dam. Unit A (no crops) has one demand object, an
// irrigation object of 100 m³/day: D₀ = 100 m³/day, 36 500 m³ a year, with
// 18 250 m³ registered: k = 0.5. A town on it (a municipal object, 2 000
// people: a floor of 50 m³/day) is added where a case needs it. Water user U
// downstream asks 40 m³/day (14 600 m³ a year) with 29 200 registered: k = 2.
// The river carries 10 000 m³/day, so every demand is met.
// ---------------------------------------------------------------------------
const START = '2021-10-01';
const DAYS = 365;
const node = (id: string, over: Partial<NetworkNode> = {}): NetworkNode => ({
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
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});
const object = (id: string, category: DemandObject['category'], m3Day: number, over: Partial<DemandObject> = {}): DemandObject => ({
	id,
	nodeId: 'A',
	name: id,
	category,
	sizing: 'monthly',
	monthlyM3Day: flat(m3Day),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});
const ALLOCS: AllocationEntry[] = [
	{ id: 'a', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 18_250 },
	{ id: 'u', nodeId: 'U', waterSource: 'surface', volumeM3PerYear: 29_200 }
];
function handNet(o: { mode?: 'none' | 'cap' | 'fullAllocation'; objects?: DemandObject[]; settings?: Record<string, unknown> } = {}): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, allocationMode: o.mode ?? 'fullAllocation', ...o.settings } as ModelInput['settings'],
		model: {
			nodes: [
				node('A', { downstreamNodeId: 'U' }),
				node('U', { kind: 'user', downstreamNodeId: 'G', areaKm2: 0, sortOrder: 1, userDemandM3Day: flat(40), userReturnPct: 0, userPriority: 'junior' }),
				node('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0, sortOrder: 2 })
			],
			crops: [],
			cropAreas: [],
			transfers: [],
			demandObjects: o.objects ?? [object('irr', 'irrigation', 100)],
			allocations: ALLOCS
		},
		series: { rain_catchment_mm: { startDate: START, values: new Array(DAYS).fill(0) } }
	};
}
const runHand = (input: ModelInput) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: new Array(DAYS).fill(10_000) })));
const scaled = (input: ModelInput, ops: ScenarioOp[]) => {
	const r = applyScenario(input, ops);
	expect(r.problems).toEqual([]);
	return r.input;
};
const day = (iso: string) => toEpochDay(iso) - toEpochDay(START);

describe('Q29 by hand: a demand factor on a full-allocation run scales the registered use (§2.12a, engine ≥ 1.70.0)', () => {
	it('no factor: A asks 100 × 0.5 = 50 m³/day (its 18 250 m³), U 40 × 2 = 80 (its 29 200)', () => {
		const input = handNet();
		const out = runHand(input);
		passes(input, out);
		get(out, 'A', 'allocation_demand_factor').forEach((v) => expect(v).toBe(0.5));
		get(out, 'U', 'allocation_demand_factor').forEach((v) => expect(v).toBe(2));
		get(out, 'A', 'demand').forEach((v) => expect(v).toBeCloseTo(50, 12));
		get(out, 'U', 'demand').forEach((v) => expect(v).toBeCloseTo(80, 12));
		expect(sum(get(out, 'A', 'demand'))).toBeCloseTo(18_250, 6);
		expect(sum(get(out, 'U', 'demand'))).toBeCloseTo(29_200, 6);
	});

	for (const f of [0.6, 0.8, 1, 1.2]) {
		it(`demand.scale ${f} on every unit and user: A asks ${f} × 18 250 m³, U ${f} × 29 200; k stays 0.5 and 2`, () => {
			const input = scaled(handNet(), [
				{ op: 'demand.scale', factor: f },
				{ op: 'demand.scale', factor: f, category: 'user' }
			]);
			const out = runHand(input);
			passes(input, out);
			// k is fitted on D₀, not on f × D₀: it is the factor-free run's.
			get(out, 'A', 'allocation_demand_factor').forEach((v) => expect(v).toBe(0.5));
			get(out, 'U', 'allocation_demand_factor').forEach((v) => expect(v).toBe(2));
			get(out, 'A', 'demand').forEach((v) => expect(v).toBeCloseTo(100 * 0.5 * f, 12));
			get(out, 'U', 'demand').forEach((v) => expect(v).toBeCloseTo(40 * 2 * f, 12));
			expect(sum(get(out, 'A', 'demand'))).toBeCloseTo(f * 18_250, 6);
			expect(sum(get(out, 'U', 'demand'))).toBeCloseTo(f * 29_200, 6);
			// The summary's scaled rows: the demand before its factor and the volume it was scaled to.
			const row = out.summary.allocations!.nodes.find((n) => n.nodeId === 'A')!.scaled![0]!;
			expect(row.waterYear).toBe(2021);
			expect(row.demandM3).toBeCloseTo(36_500, 6);
			expect(row.registeredM3).toBeCloseTo(18_250, 6);
		});
	}

	it('a factor from a date (settings.demandFactorFrom 1 April, as an outlook member’s): 50 m³/day to 31 March, 0.6 × 50 = 30 after; k still fitted on the whole year’s D₀', () => {
		const input = scaled(handNet({ settings: { demandFactorFrom: '2022-04-01' } }), [{ op: 'demand.scale', factor: 0.6 }]);
		const out = runHand(input);
		passes(input, out);
		const D = get(out, 'A', 'demand');
		const apr = day('2022-04-01');
		expect(apr).toBe(182);
		D.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(t < apr ? 50 : 30, 12));
		// 182 × 50 + 183 × 30 = 14 590 m³.
		expect(sum(D)).toBeCloseTo(14_590, 6);
	});

	it('months only (Nov–Jan × 0.5): those 92 days at 25 m³/day, the other 273 at 50; the year asks 16 000 m³, less than its 18 250', () => {
		const input = scaled(handNet(), [{ op: 'demand.scale', factor: 0.5, months: [11, 12, 1] }]);
		const out = runHand(input);
		passes(input, out);
		const D = get(out, 'A', 'demand');
		const [nov, feb] = [day('2021-11-01'), day('2022-02-01')];
		D.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(t >= nov && t < feb ? 25 : 50, 12));
		expect(feb - nov).toBe(92);
		expect(sum(D)).toBeCloseTo(92 * 25 + 273 * 50, 6);
	});

	it('a part and the whole stack: irrigation × 0.5, then the unit × 0.8: 100 × 0.5 × 0.8 × 0.5 = 20 m³/day', () => {
		const input = scaled(handNet(), [
			{ op: 'demand.scale', factor: 0.5, part: 'irrigation' },
			{ op: 'demand.scale', factor: 0.8 }
		]);
		const out = runHand(input);
		passes(input, out);
		get(out, 'A', 'object_demand@irr').forEach((v) => expect(v).toBeCloseTo(20, 12));
		get(out, 'A', 'allocation_demand_factor').forEach((v) => expect(v).toBe(0.5));
	});

	it('a cut never takes a town below MIN(floor, k × its demand): the town 100 → k 0.25 → 25; the floor of 50 is above it, so 25 stays; with k = 1, MAX(100 × 0.2, MIN(50, 100)) = 50', () => {
		// A: irrigation 100 + town 100 (2 000 people: floor 50) = D₀ 200 m³/day. Registered 18 250: k = 0.25.
		const objects = [object('irr', 'irrigation', 100), object('town', 'municipal', 100, { population: 2000 })];
		const quarter = scaled(handNet({ objects }), [{ op: 'demand.scale', factor: 0.2 }]);
		const q = runHand(quarter);
		passes(quarter, q);
		get(q, 'A', 'allocation_demand_factor').forEach((v) => expect(v).toBe(0.25));
		get(q, 'A', 'object_demand@irr').forEach((v) => expect(v).toBeCloseTo(100 * 0.25 * 0.2, 12));
		get(q, 'A', 'object_demand@town').forEach((v) => expect(v).toBeCloseTo(25, 12));
		// Registered 73 000 m³ (200 × 365): k = 1. The cut to 0.2 holds the town at its floor, 50.
		const whole: ModelInput = { ...quarter, model: { ...quarter.model, allocations: [{ ...ALLOCS[0]!, volumeM3PerYear: 73_000 }, ALLOCS[1]!] } };
		const w = runHand(whole);
		passes(whole, w);
		get(w, 'A', 'allocation_demand_factor').forEach((v) => expect(v).toBe(1));
		get(w, 'A', 'object_demand@town').forEach((v) => expect(v).toBeCloseTo(50, 12));
		get(w, 'A', 'object_demand@irr').forEach((v) => expect(v).toBeCloseTo(20, 12));
	});

	it('a senior user passes its scaled demand to the unit above: f × k × D₀ = 0.8 × 2 × 40 = 64 m³/day', () => {
		const base = handNet();
		const senior: ModelInput = { ...base, model: { ...base.model, nodes: base.model.nodes.map((n) => (n.id === 'U' ? { ...n, userPriority: 'senior' } : n)) } };
		const input = scaled(senior, [{ op: 'demand.scale', factor: 0.8, category: 'user' }]);
		const out = runHand(input);
		passes(input, out);
		get(out, 'U', 'demand').forEach((v) => expect(v).toBeCloseTo(64, 12));
		get(out, 'A', 'senior_requirement').forEach((v) => expect(v).toBeCloseTo(64, 12));
	});
});

describe('Q29: outside full allocation nothing changes', () => {
	for (const mode of ['none', 'cap'] as const) {
		it(`${mode}: demand.scale 0.8 asks 0.8 × the modelled demand (80 and 32 m³/day), whatever is registered`, () => {
			const input = scaled(handNet({ mode }), [
				{ op: 'demand.scale', factor: 0.8 },
				{ op: 'demand.scale', factor: 0.8, category: 'user' }
			]);
			const out = runHand(input);
			passes(input, out);
			get(out, 'A', 'demand').forEach((v) => expect(v).toBeCloseTo(80, 12));
			get(out, 'U', 'demand').forEach((v) => expect(v).toBeCloseTo(32, 12));
			expect(out.series.some((s) => s.key === 'allocation_demand_factor')).toBe(false);
		});
	}

	it('none: a run with allocations is the run without them on every series, a demand factor and a factor date included', () => {
		const withAllocs = scaled(handNet({ mode: 'none', settings: { demandFactorFrom: '2022-02-15' } }), [{ op: 'demand.scale', factor: 0.7 }]);
		const without: ModelInput = { ...withAllocs, model: { ...withAllocs.model, allocations: [] } };
		const a = runHand(withAllocs);
		const b = runHand(without);
		expect(a.series.map((s) => [s.nodeId, s.key, s.values])).toEqual(b.series.map((s) => [s.nodeId, s.key, s.values]));
	});

	it('full allocation with a demand factor of 1 in every month is the run without one, to the bit (the invented catchment, both farms registered)', () => {
		const raw = testCatchment({ start: '2002-10-01', end: '2006-09-30', seed: 23, ewrM3Day: 600 });
		const fa: ModelInput = {
			...raw,
			settings: { ...raw.settings, allocationMode: 'fullAllocation' },
			model: { ...raw.model, allocations: [{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 150_000 }, { id: 'b1', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 90_000 }] }
		};
		const ones: ModelInput = { ...fa, model: { ...fa.model, nodes: fa.model.nodes.map((n) => (n.kind === 'farm' ? { ...n, demandFactor: flat(1) } : n)) } };
		const a = runModelWithoutChecks(fa);
		const b = runModelWithoutChecks(ones);
		expect(b.series.map((s) => [s.nodeId, s.key, s.values])).toEqual(a.series.map((s) => [s.nodeId, s.key, s.values]));
	});
});

// ---------------------------------------------------------------------------
// The seasonal outlook on the invented test catchment (13 water years), both
// farms registered: A 200 000 m³ a year, B 120 000.
// ---------------------------------------------------------------------------
const RAW = testCatchment({ start: '1996-10-01', end: '2009-09-30', seed: 7, ewrM3Day: 900 });
const V = { a: 200_000, b: 120_000 } as const;
const FA: ModelInput = {
	...RAW,
	settings: { ...RAW.settings, allocationMode: 'fullAllocation' },
	model: { ...RAW.model, allocations: [{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: V.a }, { id: 'b1', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: V.b }] }
};
const FACTORS = [0.6, 0.8, 1, 1.2];
const LEVELS: OutlookLevel[] = FACTORS.map((f) => ({ id: String(f), label: `${f * 100} %`, ops: f === 1 ? [] : [{ op: 'demand.scale', factor: f }] }));

describe('Q29: the seasonal outlook under full allocation (§2.15, engine ≥ 1.70.0)', () => {
	const baseRun = runModelWithoutChecks(FA);
	// The default season: 1 October 2008 … 30 April 2009, 212 days. From 1 October each member fits its own part
	// year (ER-23, §2.15), on its demand before the level: each farm asks level × V × 212 ÷ 365.
	const season = { decisionDate: '2008-10-01', seasonEnd: '2009-04-30' };
	const DAYS_S = 212;
	const out = runSeasonalOutlook(FA, { ...season, levels: LEVELS, baseRun });

	it('every level ran in every analogue year (12), with no problem', () => {
		expect(out.nYears).toBe(12);
		for (const l of out.levels) {
			expect(l.problems).toEqual([]);
			expect(l.nYears).toBe(12);
		}
	});

	it('each member asks exactly level × its farms’ volume over the season (to 10⁻⁹): 0.6 × 200 000 × 212 ÷ 365 = 69 698.6 m³ for A', () => {
		const bad: string[] = [];
		for (const [i, l] of out.levels.entries()) {
			const f = FACTORS[i]!;
			for (const y of l.years) {
				for (const id of ['a', 'b'] as const) {
					const want = (f * V[id] * DAYS_S) / 365;
					if (Math.abs(y.farms[id]!.demandM3 - want) > 1e-9 * want) bad.push(`${l.label} ${y.label} ${id}: ${y.farms[id]!.demandM3} ≠ ${want}`);
				}
			}
		}
		expect(bad).toEqual([]);
		expect((0.6 * V.a * DAYS_S) / 365).toBeCloseTo(69_698.63, 2);
	});

	it('the levels give distinct members (before 1.70.0 they were identical): mean season demand 0.6 : 0.8 : 1 : 1.2', () => {
		const means = out.levels.map((l) => l.meanDemandM3!);
		expect(new Set(means).size).toBe(4);
		const unit = ((V.a + V.b) * DAYS_S) / 365;
		means.forEach((m, i) => expect(m).toBeCloseTo(FACTORS[i]! * unit, 4));
		// The planning figure ranks by demand: 120 % first.
		expect(out.planning.ranked.map((r) => r.levelId)).toEqual(['1.2', '1', '0.8', '0.6']);
	});

	it('level 1.0 is the plain full-allocation member: the same as a level of demand.scale 1, to the bit', () => {
		const one = runSeasonalOutlook(FA, { ...season, levels: [{ id: 'x', label: 'x', ops: [{ op: 'demand.scale', factor: 1 }] }], baseRun });
		expect(one.levels[0]!.years).toEqual(out.levels[2]!.years);
	});

	it('monotone, year by year: a higher level never asks for less and never ends the season with more in either dam', () => {
		const bad: string[] = [];
		for (let i = 1; i < out.levels.length; i++) {
			const lo = out.levels[i - 1]!;
			const hi = out.levels[i]!;
			for (const [k, y] of hi.years.entries()) {
				const x = lo.years[k]!;
				if (y.demandM3 < x.demandM3) bad.push(`${hi.label} ${y.label}: demand ${y.demandM3} < ${x.demandM3}`);
				for (const id of ['a', 'b']) {
					if (y.storageM3ByDam[id]! > x.storageM3ByDam[id]! + 1e-6) bad.push(`${hi.label} ${y.label} dam ${id}: ${y.storageM3ByDam[id]} > ${x.storageM3ByDam[id]}`);
				}
				if (y.suppliedM3 + 1e-6 < x.suppliedM3) bad.push(`${hi.label} ${y.label}: supplied ${y.suppliedM3} < ${x.suppliedM3}`);
			}
		}
		expect(bad).toEqual([]);
		// And the levels do bite on the storage: some year ends fuller at 60 % than at 120 %.
		const lowest = out.levels[0]!.years;
		const highest = out.levels[3]!.years;
		expect(lowest.some((y, k) => y.seasonEndStorageM3! > highest[k]!.seasonEndStorageM3! + 1)).toBe(true);
	});

	it('outside full allocation the outlook is the same with or without the registered volumes (mode none)', () => {
		const none: ModelInput = { ...FA, settings: { ...FA.settings, allocationMode: 'none' } };
		const bare: ModelInput = { ...none, model: { ...none.model, allocations: [] } };
		const a = runSeasonalOutlook(none, { ...season, levels: LEVELS, analogueYears: [1998, 2001, 2004] });
		const b = runSeasonalOutlook(bare, { ...season, levels: LEVELS, analogueYears: [1998, 2001, 2004] });
		expect(a.levels.map((l) => l.years)).toEqual(b.levels.map((l) => l.years));
	});

	describe('a hindcast from 15 December (the ER-23 factor fitted on the decision year’s days before it, §2.15)', () => {
		const mid = { decisionDate: '2008-12-15', seasonEnd: '2009-04-30' };
		const years = [2000, 2001, 2002];
		const warm = runSeasonalOutlook(FA, { ...mid, levels: LEVELS, analogueYears: years, baseRun });

		it('every level asks level × the 100 % member’s demand, farm by farm (the decision year’s factor is pinned, the level applies after it)', () => {
			const ref = warm.levels[2]!;
			for (const [i, l] of warm.levels.entries()) {
				for (const [k, y] of l.years.entries()) {
					for (const id of ['a', 'b']) expect(y.farms[id]!.demandM3, `${l.label} ${y.label} ${id}`).toBeCloseTo(FACTORS[i]! * ref.years[k]!.farms[id]!.demandM3, 6);
				}
			}
		});

		it('the snapshot path’s members ask what the older re-run path’s do, at every level', () => {
			const cold = runSeasonalOutlook(FA, { ...mid, levels: LEVELS, analogueYears: years, baseRun, warmStart: false });
			const bad: string[] = [];
			for (const [i, l] of warm.levels.entries()) {
				for (const [k, y] of l.years.entries()) {
					const z = cold.levels[i]!.years[k]!;
					if (Math.abs(y.demandM3 - z.demandM3) > 1e-6 * z.demandM3) bad.push(`${l.label} ${y.label}: warm ${y.demandM3} vs cold ${z.demandM3}`);
				}
			}
			expect(bad).toEqual([]);
		});

		it('a member reads no day on or after the decision date, at every level: two records that differ only after it give the same members', () => {
			const rain = FA.series.rain_catchment_mm!;
			const cut = toEpochDay(mid.decisionDate) - toEpochDay(rain.startDate);
			const other: ModelInput = { ...FA, series: { rain_catchment_mm: { startDate: rain.startDate, values: rain.values.map((v, t) => (t >= cut && v !== null ? v * 3 + 2 : v)) } } };
			const a = runSeasonalOutlook(FA, { ...mid, levels: LEVELS, analogueYears: years });
			const b = runSeasonalOutlook(other, { ...mid, levels: LEVELS, analogueYears: years });
			expect(b.levels.map((l) => l.years.map((y) => y.demandM3))).toEqual(a.levels.map((l) => l.years.map((y) => y.demandM3)));
		});
	});

	it('the review triggers: each band’s members ask level × the 100 % level’s demand (the level after the factor), and the band rows differ by level', () => {
		const t = runReviewTriggers(FA, { reviewDate: '2009-01-01', seasonEnd: '2009-04-30', levels: LEVELS, edgesM3: [150_000], analogueYears: [2000, 2001, 2002] });
		expect(t.rows).toHaveLength(2);
		for (const r of t.rows) {
			const ref = r.outlook.levels[2]!;
			for (const [i, l] of r.outlook.levels.entries()) {
				for (const [k, y] of l.years.entries()) expect(y.demandM3, `band ${r.band.fromM3} ${l.label} ${y.label}`).toBeCloseTo(FACTORS[i]! * ref.years[k]!.demandM3, 6);
			}
			expect(new Set(r.outlook.levels.map((l) => l.meanDemandM3)).size).toBe(4);
		}
	});
});

describe('Q29: the abstraction sensitivity case under full allocation (§2.10g)', () => {
	// No loss return (β = 0): demand then only takes water out, so more of it can't add water to the river on a
	// dry day (§2.15's invariants; with β > 0 dam water returned on dry days can lower the shortfall).
	const X = testCatchment({ start: '2002-10-01', end: '2006-09-30', seed: 29, ewrM3Day: 700 });
	const input: ModelInput = {
		...X,
		settings: { ...X.settings, allocationMode: 'fullAllocation' },
		model: { ...X.model, nodes: X.model.nodes.map((n) => ({ ...n, lossReturnFraction: 0 })), allocations: [{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: V.a }, { id: 'b1', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: V.b }] }
	};

	it('its low and high ask 0.7 and 1.3 × the registered volume in every whole water year', () => {
		const central = runModel(input);
		const plan = sensitivityPlan(input, central, SENSITIVITY_RANGES).plans.find((p) => p.factor === 'abstraction')!;
		for (const c of [plan.low, plan.high]) {
			const run = runModel(applyScenario(input, c.ops).input);
			const d0 = toEpochDay(run.startDate);
			for (const id of ['a', 'b'] as const) {
				const byYear = new Map<number, number>();
				get(run, id, 'demand').forEach((v, t) => byYear.set(waterYearOf(d0 + t), (byYear.get(waterYearOf(d0 + t)) ?? 0) + v));
				for (const [wy, d] of byYear) expect(d, `${c.label} ${id} ${wy}`).toBeCloseTo(c.setting * V[id], 4);
			}
		}
	});

	it('so the case moves the EWR shortfall: more abstraction, a shortfall at least as large (before 1.70.0 both ends were the central run)', () => {
		const r = sensitivityRuns(input, { skip: ['rain', 'pan', 'lakeEvap', 'damStorage'] });
		const f = r.factors.find((x) => x.factor === 'abstraction')!;
		const low = f.low.values[0]!.shortfallMm3!;
		const high = f.high.values[0]!.shortfallMm3!;
		expect(high).toBeGreaterThan(low);
		expect(high).toBeGreaterThanOrEqual(r.central[0]!.shortfallMm3! - 1e-12);
		expect(low).toBeLessThanOrEqual(r.central[0]!.shortfallMm3! + 1e-12);
	});
});
