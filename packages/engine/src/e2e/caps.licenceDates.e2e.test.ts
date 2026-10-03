// End-to-end: an allocation cap around its licences' dates (docs/model.md
// §2.12a, engine ≥ 1.70.0, issue #393, #90 Q24, a provisional answer pending
// the hydrologist). In cap mode a day on which none of a unit's allocations
// of a source is in force (before the first starts, after the last ends, or
// between two) isn't capped for that source, as a unit with no allocation of
// the source isn't, and its use doesn't count against the water year's
// budget; the budget stays prorated to the licences' days. A full allocation
// keeps a unit's modelled demand (factor 1) in a water year with no licence
// in force on its days. One run warning names the units, sources and days
// (years for a full allocation). Before 1.70.0 a cap gave a year with none
// in force a budget of 0 and counted the use before a licence's start in its
// first year, and a full allocation scaled such a year's demand to 0.
//
// The catchment: a unit F with a 10⁹ m³ dam that starts full and loses
// nothing (no A-pan, no seepage, no rain), so it can always give its demand,
// a town of 100 m³/day, and the dam is the only surface source. Three whole
// water years, 1 Oct 2020 … 30 Sep 2023, 365 days each (no 29 February), so a
// year's demand is 36 500 m³ and day t of a year is the year's day t.
//
// A year's surface use is G − GW (§2.12a); with no borehole it is G. Hand
// values below follow from model.md §2.12a's budget formula
//   budget(y) = Σ V(a) × |L(y) ∩ [validFrom, validTo]| ÷ |L(y)|
// and the room MAX(0, budget − use so far on capped days), drawn at 100 m³ a
// day from the first capped day.
// Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { AllocationEntry } from '../allocations/compare';
import type { Monthly } from '../calendar';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { Borehole, DemandObject, ModelInput, ModelOutput, NetworkNode, ProjectSettings, RunSeries } from '../project';
import { captureModelState, runModel, runModelFrom, runModelWith, withVerification } from '../run';
import { applyScenario } from '../scenario';
import { testCatchment } from '../outlook/testCatchment';

const flat = (v: number) => new Array(12).fill(v) as number[];
const START = '2020-10-01';
const DAYS = 3 * 365;
const YEAR = 365;
const WARN = "allocation cap: no licence in force, so modelled demand is used, uncapped (as for a unit with no licence; check the licence dates), and that use doesn't count against the water year's volume: ";
const FA_WARN = 'full allocation: no licence in force, so modelled demand is used, uncapped (as for a unit with no licence; check the licence dates): ';

function farm(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 1e9,
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
const gauge = (): NetworkNode => farm('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 99, damCapacityM3: 0, damInitialPct: 0 });
const town = (nodeId: string, m3Day = 100): DemandObject => ({
	id: `town-${nodeId}`,
	nodeId,
	name: `Town at ${nodeId}`,
	category: 'municipal',
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
	note: ''
});
const surface = (id: string, volumeM3PerYear: number, validFrom: string | null = null, validTo: string | null = null, nodeId = 'F'): AllocationEntry => ({ id, nodeId, waterSource: 'surface', volumeM3PerYear, validFrom, validTo });

function build(b: { allocations?: AllocationEntry[]; nodes?: NetworkNode[]; objects?: DemandObject[]; boreholes?: Borehole[]; settings?: Partial<ProjectSettings> }): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, allocationMode: 'cap', ...b.settings } as ModelInput['settings'],
		model: {
			nodes: b.nodes ?? [gauge(), farm('F')],
			crops: [],
			cropAreas: [],
			transfers: [],
			demandObjects: b.objects ?? [town('F')],
			...(b.boreholes ? { boreholes: b.boreholes } : {}),
			...(b.allocations ? { allocations: b.allocations } : {})
		},
		series: { rain_catchment_mm: { startDate: START, values: new Array(DAYS).fill(0) } }
	};
}
const run = (input: ModelInput) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: new Array(DAYS).fill(0) })));
function get(out: { series: RunSeries[] }, nodeId: string, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const has = (out: { series: RunSeries[] }, nodeId: string, key: string) => out.series.some((x) => x.nodeId === nodeId && x.key === key);
const sum = (a: number[], from: number, to: number) => a.slice(from, to).reduce((x, y) => x + y, 0);
/** Each water year's total of a series, in run order. */
const perYear = (a: number[]) => [0, 1, 2].map((y) => sum(a, y * YEAR, (y + 1) * YEAR));
function passes(out: ModelOutput) {
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
}
const capWarnings = (out: ModelOutput) => out.summary.warnings.filter((w) => w.includes('no licence in force'));
const sourceOf = (out: ModelOutput, nodeId: string, s: 'surface' | 'groundwater') => out.summary.allocations!.nodes.find((n) => n.nodeId === nodeId)!.sources.find((x) => x.waterSource === s)!;
const near = (a: number[], b: number[], digits = 6) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, t) => expect(v, `#${t}`).toBeCloseTo(b[t]!, digits));
};

describe('caps: a licence that starts partway through the run (§2.12a, engine ≥ 1.70.0)', () => {
	// 18 250 m³ a year from 1 Oct 2021. 2020/21 has no allocation in force: uncapped, so F takes its whole 36 500 m³.
	// 2021/22 and 2022/23: budget 18 250 (the licence covers the whole year), drawn 100 a day: days 0–181 take 100
	// (18 200), day 182 takes the 50 left, days 183–364 nothing.
	const out = run(build({ allocations: [surface('L', 18_250, '2021-10-01')] }));
	const plain = run(build({}));
	const G = get(out, 'F', 'supplied');

	it('the year before is uncapped (36 500 m³), the years after hold to the 18 250 m³ budget', () => {
		near(perYear(G), [36_500, 18_250, 18_250]);
		expect(G[YEAR + 181]).toBeCloseTo(100, 9);
		expect(G[YEAR + 182]).toBeCloseTo(50, 9);
		expect(G[YEAR + 183]).toBe(0);
		passes(out);
	});

	it('the uncapped year is the run with no allocation at all, day by day, to the bit', () => {
		// Positive control for "same as a unit with no allocation": the run without any allocation has no cap.
		expect(has(plain, 'F', 'allocation_room_surface')).toBe(false);
		expect(G.slice(0, YEAR)).toEqual(get(plain, 'F', 'supplied').slice(0, YEAR));
		expect(get(out, 'F', 'dam_storage').slice(0, YEAR)).toEqual(get(plain, 'F', 'dam_storage').slice(0, YEAR));
		expect(get(out, 'F', 'deficit').slice(0, YEAR).every((v) => v === 0)).toBe(true);
	});

	it('the room column is blank (NaN) in the uncapped year and the budget less the use after', () => {
		const room = get(out, 'F', 'allocation_room_surface');
		expect(room.slice(0, YEAR).every((v) => Number.isNaN(v))).toBe(true);
		expect(room[YEAR]).toBe(18_250);
		expect(room[YEAR + 1]).toBeCloseTo(18_150, 9);
		expect(room[YEAR + 182]).toBeCloseTo(50, 9);
		expect(room[YEAR + 183]).toBe(0);
		expect(room[2 * YEAR]).toBe(18_250);
	});

	it('capReached and limitBound list only the capped years', () => {
		const src = sourceOf(out, 'F', 'surface');
		expect(src.capReached!.map((r) => r.waterYear)).toEqual([2021, 2022]);
		for (const r of src.capReached!) expect(r.budgetM3).toBe(18_250);
		// Days 182–364 the room was all taken and F went short: 183 days, the volume's.
		expect(src.limitBound).toEqual([
			{ waterYear: 2021, days: 183, volumeDays: 183, rateDays: 0, monthsDays: 0 },
			{ waterYear: 2022, days: 183, volumeDays: 183, rateDays: 0, monthsDays: 0 }
		]);
	});

	it('one warning names the unit, the source and the year', () => {
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2020-10-01 to 2021-09-30`]);
		expect(capWarnings(plain)).toEqual([]);
	});
});

describe('caps: a licence that ends partway through the run', () => {
	// 9 125 m³ a year until 30 Sep 2021: 2020/21 capped at 9 125 (91 days × 100 + 25 on day 91), then uncapped.
	const out = run(build({ allocations: [surface('L', 9_125, null, '2021-09-30')] }));
	it('the years after it ends are uncapped: 9 125, 36 500, 36 500 m³; the warning gives the days', () => {
		near(perYear(get(out, 'F', 'supplied')), [9_125, 36_500, 36_500]);
		expect(get(out, 'F', 'allocation_room_surface').slice(YEAR).every((v) => Number.isNaN(v))).toBe(true);
		expect(sourceOf(out, 'F', 'surface').capReached!.map((r) => r.waterYear)).toEqual([2020]);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2021-10-01 to 2023-09-30`]);
		passes(out);
	});
});

describe('caps: several licences with staggered dates', () => {
	it('two licences starting a year apart: uncapped, then the first, then both (7 300, then 7 300 + 3 650)', () => {
		const out = run(build({ allocations: [surface('A', 7_300, '2021-10-01'), surface('B', 3_650, '2022-10-01')] }));
		near(perYear(get(out, 'F', 'supplied')), [36_500, 7_300, 10_950]);
		const room = get(out, 'F', 'allocation_room_surface');
		expect(room[YEAR]).toBe(7_300);
		expect(room[2 * YEAR]).toBeCloseTo(10_950, 9);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2020-10-01 to 2021-09-30`]);
		passes(out);
	});

	it('a gap year between two licences is uncapped; the years either side are capped', () => {
		const out = run(build({ allocations: [surface('A', 7_300, null, '2021-09-30'), surface('B', 3_650, '2022-10-01')] }));
		near(perYear(get(out, 'F', 'supplied')), [7_300, 36_500, 3_650]);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2021-10-01 to 2022-09-30`]);
		passes(out);
	});

	it('a licence from 1 April: October–March uncapped and not counted, April–September capped at 183/365 of its volume', () => {
		// 36 500 m³ a year from 1 Apr 2022. 2021/22: 1 Oct–31 Mar (182 days) uncapped, 18 200 m³; from 1 April the
		// budget is 36 500 × 183 ÷ 365 = 18 300, with none of it spent (the use before the start doesn't count), and
		// the 183 days ask for exactly 18 300. 2020/21 uncapped; 2022/23 36 500. Before 1.70.0 the 18 300 was spent
		// from 1 October and April–September took nothing: 18 300 for the year.
		const out = run(build({ allocations: [surface('L', 36_500, '2022-04-01')] }));
		const G = get(out, 'F', 'supplied');
		near(perYear(G), [36_500, 36_500, 36_500]);
		const room = get(out, 'F', 'allocation_room_surface');
		expect(room[YEAR + 181]).toBeNaN();
		expect(room[YEAR + 182]).toBeCloseTo(18_300, 9);
		expect(room[2 * YEAR - 1]).toBeCloseTo(100, 6);
		expect(sourceOf(out, 'F', 'surface').capReached!.map((r) => [r.waterYear, r.budgetM3])).toEqual([
			[2021, 18_300],
			[2022, 36_500]
		]);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2020-10-01 to 2022-03-31`]);
		passes(out);
	});

	it('a licence from 1 September: October–August uncapped, September capped at 30/365 (the use before not counted)', () => {
		// 18 250 m³ a year from 1 Sep 2021. 2020/21: 1 Oct–31 Aug (335 days) uncapped, 33 500 m³; September's budget is
		// 18 250 × 30 ÷ 365 = 1 500, all of it left on 1 September: 1–15 September take 100 (1 500), 16–30 nothing.
		// 35 000 for the year. Then 18 250 a year. Before 1.70.0 the 1 500 was spent in the first 15 days of October
		// and the year took 1 500.
		const out = run(build({ allocations: [surface('L', 18_250, '2021-09-01')] }));
		const G = get(out, 'F', 'supplied');
		near(perYear(G), [35_000, 18_250, 18_250]);
		const sep1 = toEpochDay('2021-09-01') - toEpochDay(START);
		const room = get(out, 'F', 'allocation_room_surface');
		expect(room[sep1 - 1]).toBeNaN();
		expect(room[sep1]).toBeCloseTo(1_500, 9);
		expect(G[sep1 + 14]).toBeCloseTo(100, 9);
		expect(G[sep1 + 15]).toBe(0);
		const src = sourceOf(out, 'F', 'surface');
		expect(src.capReached![0]).toEqual({ waterYear: 2020, budgetM3: expect.closeTo(1_500, 9), usedM3: expect.closeTo(1_500, 9) });
		// 16–30 September: the room was all taken and F went short.
		expect(src.limitBound![0]).toEqual({ waterYear: 2020, days: 15, volumeDays: 15, rateDays: 0, monthsDays: 0 });
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2020-10-01 to 2021-08-31`]);
		passes(out);
	});

	it('a licence ending on 31 March: its 182/365 share capped to then, April–September uncapped and not counted', () => {
		// 18 250 m³ a year to 31 Mar 2021: budget 18 250 × 182 ÷ 365 = 9 100, taken in the first 91 days; 1 Jan–31 Mar
		// (days 91–181) nothing; 1 Apr–30 Sep (183 days) uncapped, 18 300. 27 400 for 2020/21, then 36 500 a year.
		// Before 1.70.0 the year stayed capped at 9 100 to 30 September.
		const out = run(build({ allocations: [surface('L', 18_250, null, '2021-03-31')] }));
		const G = get(out, 'F', 'supplied');
		near(perYear(G), [27_400, 36_500, 36_500]);
		expect(G[90]).toBeCloseTo(100, 9);
		expect(G[91]).toBe(0);
		expect(G[181]).toBe(0);
		expect(G[182]).toBeCloseTo(100, 9);
		const src = sourceOf(out, 'F', 'surface');
		expect(src.capReached).toEqual([{ waterYear: 2020, budgetM3: 9_100, usedM3: expect.closeTo(9_100, 9) }]);
		expect(src.limitBound).toEqual([{ waterYear: 2020, days: 91, volumeDays: 91, rateDays: 0, monthsDays: 0 }]);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2021-04-01 to 2023-09-30`]);
		passes(out);
	});

	it('a gap inside a water year between two licences: uncapped and not counted; the share either side is one budget', () => {
		// A (18 250) to 31 Dec 2020 and B (18 250) from 1 Jul 2021, each in force 92 days of 2020/21: budget 2 × 4 600 =
		// 9 200, which October–December's 92 × 100 use up. January–June (181 days) uncapped, 18 100; July–September
		// nothing left. 27 300 for the year; 2021/22 and 2022/23 are B's 18 250.
		const out = run(build({ allocations: [surface('A', 18_250, null, '2020-12-31'), surface('B', 18_250, '2021-07-01')] }));
		const G = get(out, 'F', 'supplied');
		near(perYear(G), [27_300, 18_250, 18_250]);
		const jul1 = toEpochDay('2021-07-01') - toEpochDay(START);
		const room = get(out, 'F', 'allocation_room_surface');
		expect(room[91]).toBeCloseTo(100, 9);
		expect(room[92]).toBeNaN();
		expect(room[jul1]).toBeCloseTo(0, 9);
		expect(G[jul1]).toBe(0);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2021-01-01 to 2021-06-30`]);
		passes(out);
	});

	it('a licence of 0 m³ in force is a cap of 0, not "not in force": the year takes nothing and no warning names it', () => {
		const out = run(build({ allocations: [surface('Z', 0, null, '2021-09-30'), surface('L', 18_250, '2021-10-01')] }));
		near(perYear(get(out, 'F', 'supplied')), [0, 18_250, 18_250]);
		expect(get(out, 'F', 'allocation_room_surface')[0]).toBe(0);
		expect(capWarnings(out)).toEqual([]);
		passes(out);
	});

	it('a licence in force for one day of a year caps that day only, at its one day’s share', () => {
		// Valid to 1 Oct 2021, the first day of 2021/22: that day's budget is 36 500 × 1 ÷ 365 = 100 m³ (its demand);
		// the other 364 days are uncapped. Before 1.70.0 the year was capped at 100.
		const out = run(build({ allocations: [surface('L', 36_500, null, '2021-10-01')] }));
		near(perYear(get(out, 'F', 'supplied')), [36_500, 36_500, 36_500]);
		expect(get(out, 'F', 'allocation_room_surface')[YEAR]).toBeCloseTo(100, 9);
		expect(get(out, 'F', 'allocation_room_surface')[YEAR + 1]).toBeNaN();
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2021-10-02 to 2023-09-30`]);
		passes(out);
	});
});

describe('caps: each source on its own', () => {
	// F also has a primary borehole of 1 000 m³/day (pumps first, §2.7d), so with no cap its groundwater meets the
	// whole 100 m³/day and the dam gives nothing.
	const bore: Borehole = { id: 'bh', nodeId: 'F', name: 'Bore', capacityM3Day: 1000, annualCapM3: null, mode: 'primary', emergencyBelowPct: 0, target: 'direct', depletionFactor: 0 };

	it('a groundwater licence from 1 Oct 2021 beside a surface one in force throughout: only groundwater is uncapped in 2020/21', () => {
		// Groundwater 7 300 from 2021-10-01. 2020/21: groundwater uncapped, the bore gives 36 500. 2021/22 and 2022/23:
		// the bore gives 7 300 (73 days), then the dam the other 29 200, within its 1e6 surface volume.
		const out = run(build({ boreholes: [bore], allocations: [surface('S', 1e6), { id: 'W', nodeId: 'F', waterSource: 'groundwater', volumeM3PerYear: 7_300, validFrom: '2021-10-01' }] }));
		const GW = get(out, 'F', 'groundwater_used');
		const G = get(out, 'F', 'supplied');
		near(perYear(GW), [36_500, 7_300, 7_300]);
		near(perYear(G), [36_500, 36_500, 36_500]);
		near(
			perYear(G.map((g, t) => g - GW[t]!)),
			[0, 29_200, 29_200]
		);
		expect(get(out, 'F', 'allocation_room_groundwater').slice(0, YEAR).every((v) => Number.isNaN(v))).toBe(true);
		expect(get(out, 'F', 'allocation_room_surface').every((v) => Number.isFinite(v))).toBe(true);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" groundwater 2020-10-01 to 2021-09-30`]);
		passes(out);
	});

	it('a surface licence only: groundwater isn’t capped at all (its own warning), surface only from its start', () => {
		// Surface 3 650 from 1 Oct 2021, no groundwater volume: the bore meets the demand every year, so surface use is
		// 0 throughout and the cap never binds; the two warnings say why each source is uncapped.
		const out = run(build({ boreholes: [bore], allocations: [surface('S', 3_650, '2021-10-01')] }));
		near(perYear(get(out, 'F', 'groundwater_used')), [36_500, 36_500, 36_500]);
		expect(has(out, 'F', 'allocation_room_groundwater')).toBe(false);
		expect(out.summary.warnings).toContain(`allocation cap: "Unit F" has no groundwater volume registered, so its boreholes aren't capped`);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" surface water 2020-10-01 to 2021-09-30`]);
		passes(out);
	});
});

describe('caps: several units, one warning', () => {
	it('two units with late licences and one with none: one grouped warning for the first two, the "no registered volume" one for the third', () => {
		const nodes = [gauge(), farm('A'), farm('B'), farm('C')];
		const out = run(
			build({
				nodes,
				objects: [town('A'), town('B'), town('C')],
				allocations: [surface('a', 18_250, '2021-10-01', null, 'A'), surface('b', 18_250, '2022-10-01', null, 'B')]
			})
		);
		near(perYear(get(out, 'A', 'supplied')), [36_500, 18_250, 18_250]);
		near(perYear(get(out, 'B', 'supplied')), [36_500, 36_500, 18_250]);
		near(perYear(get(out, 'C', 'supplied')), [36_500, 36_500, 36_500]);
		expect(capWarnings(out)).toEqual([`${WARN}"Unit A" surface water 2020-10-01 to 2021-09-30; "Unit B" surface water 2020-10-01 to 2022-09-30`]);
		expect(out.summary.warnings.some((w) => w.includes('1 unit has no registered volume') && w.includes('Unit C'))).toBe(true);
		passes(out);
	});

	it('compare-only never warns about it; full allocation warns in its own words, by water year', () => {
		const none = run(build({ allocations: [surface('L', 18_250, '2021-10-01')], settings: { allocationMode: 'none' } }));
		expect(capWarnings(none)).toEqual([]);
		const full = run(build({ allocations: [surface('L', 18_250, '2021-10-01')], settings: { allocationMode: 'fullAllocation' } }));
		expect(capWarnings(full)).toEqual([`${FA_WARN}"Unit F" in water year 2020`]);
	});
});

describe('full allocation: a water year with no licence in force keeps the modelled demand (engine ≥ 1.70.0, #90 Q24)', () => {
	const fa = { allocationMode: 'fullAllocation' } as const;
	it('a licence from 1 Oct 2021: 2020/21 asks for its modelled 36 500 m³ (factor 1), then 18 250 a year (factor ½)', () => {
		// Before 1.70.0 2020/21 had nothing registered over its days and was scaled to 0.
		const out = run(build({ allocations: [surface('L', 18_250, '2021-10-01')], settings: fa }));
		near(perYear(get(out, 'F', 'supplied')), [36_500, 18_250, 18_250]);
		const k = get(out, 'F', 'allocation_demand_factor');
		expect([k[0], k[YEAR], k[2 * YEAR]]).toEqual([1, 0.5, 0.5]);
		// Only the scaled years are listed.
		expect(out.summary.allocations!.nodes[0]!.scaled!.map((y) => y.waterYear)).toEqual([2021, 2022]);
		passes(out);
	});

	it('a gap year between two licences keeps its modelled demand; the years either side are scaled', () => {
		const out = run(build({ allocations: [surface('A', 18_250, null, '2021-09-30'), surface('B', 9_125, '2022-10-01')], settings: fa }));
		near(perYear(get(out, 'F', 'supplied')), [18_250, 36_500, 9_125]);
		expect(capWarnings(out)).toEqual([`${FA_WARN}"Unit F" in water year 2021`]);
		passes(out);
	});

	it('either source in force scales the year: a groundwater licence alone counts (both sources together, §2.12a)', () => {
		const out = run(build({ allocations: [{ id: 'W', nodeId: 'F', waterSource: 'groundwater', volumeM3PerYear: 18_250, validTo: '2021-09-30' }, surface('S', 18_250, '2022-10-01')], settings: fa }));
		near(perYear(get(out, 'F', 'supplied')), [18_250, 36_500, 18_250]);
		expect(capWarnings(out)).toEqual([`${FA_WARN}"Unit F" in water year 2021`]);
	});

	it('a year a licence starts inside is still scaled whole, to the volume over its in-force days (open, model.md §2.12a)', () => {
		// From 1 Apr 2021: 2020/21 registers 18 250 × 183 ÷ 365 = 9 150 over its days, and its whole demand is scaled to
		// that (factor 9 150 ÷ 36 500), the October–March days included. Pinned: whether those days should keep their
		// modelled demand, as the cap now leaves them uncapped, is a question of its own.
		const out = run(build({ allocations: [surface('L', 18_250, '2021-04-01')], settings: fa }));
		near(perYear(get(out, 'F', 'supplied')), [9_150, 18_250, 18_250]);
		expect(capWarnings(out)).toEqual([]);
	});
});

describe('caps: invariants across licence dates on a rain-driven catchment', () => {
	// testCatchment: two farms a (upstream) and b with crops, dams and GR4J runoff. Licences start and end inside
	// the run; every year's use is held to its budget where some licence is in force, and the uncapped years of a
	// unit equal the no-allocation run's while the units upstream of it behave the same in both.
	const base = testCatchment({ start: '2001-10-01', end: '2006-09-30', seed: 23 });
	const allocations: AllocationEntry[] = [
		{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 60_000, validFrom: '2003-10-01' },
		{ id: 'b1', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 40_000, validFrom: '2002-10-01', validTo: '2004-09-30' }
	];
	const withCaps = (mode: 'cap' | 'none'): ModelInput => ({ ...base, settings: { ...base.settings, allocationMode: mode }, model: { ...base.model, allocations } });
	const cap = withVerification(withCaps('cap'), runModel(withCaps('cap')));
	const none = runModel(withCaps('none'));
	const d0 = toEpochDay(cap.startDate);
	const wyOf = (t: number) => {
		const d = fromEpochDay(d0 + t);
		const y = Number(d.slice(0, 4));
		return Number(d.slice(5, 7)) >= 10 ? y : y - 1;
	};

	it('passes every self-check, the water balance included', () => {
		expect(cap.summary.verification?.passed, JSON.stringify(cap.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	});

	it('capped use never exceeds the budget; uncapped years have a blank room', () => {
		const budgets: Record<string, Record<number, number | null>> = {
			a: { 2001: null, 2002: null, 2003: 60_000, 2004: 60_000, 2005: 60_000 },
			b: { 2001: null, 2002: 40_000, 2003: 40_000, 2004: null, 2005: null }
		};
		for (const id of ['a', 'b']) {
			const G = get(cap, id, 'supplied');
			const room = get(cap, id, 'allocation_room_surface');
			const used = new Map<number, number>();
			for (let t = 0; t < cap.days; t++) {
				const wy = wyOf(t);
				const b = budgets[id]![wy]!;
				if (b === null) expect(room[t], `${id} ${fromEpochDay(d0 + t)}`).toBeNaN();
				else expect(room[t]!, `${id} ${fromEpochDay(d0 + t)}`).toBeCloseTo(Math.max(0, b - (used.get(wy) ?? 0)), 6);
				used.set(wy, (used.get(wy) ?? 0) + G[t]!);
			}
			for (const [wy, u] of used) if (budgets[id]![wy] !== null) expect(u, `${id} ${wy}`).toBeLessThanOrEqual(budgets[id]![wy]! * (1 + 1e-12));
		}
		// Positive control: the cap binds for a in some year (else this proves little).
		expect(sourceOf(cap, 'a', 'surface').capReached!.length).toBeGreaterThan(0);
	});

	it('the upstream unit’s uncapped years equal the compare-only run’s, to the bit', () => {
		// a is upstream of b, so nothing b does reaches it: in a's years before its licence (2001/02, 2002/03) the cap
		// run and the compare-only run are the same model.
		const before = toEpochDay('2003-10-01') - d0;
		for (const key of ['supplied', 'dam_storage', 'outflow', 'deficit']) expect(get(cap, 'a', key).slice(0, before), key).toEqual(get(none, 'a', key).slice(0, before));
	});

	it('the warning names both units and their uncapped years', () => {
		expect(capWarnings(cap)).toEqual([
			`${WARN}"${base.model.nodes.find((n) => n.id === 'a')!.name}" surface water 2001-10-01 to 2003-09-30; "${base.model.nodes.find((n) => n.id === 'b')!.name}" surface water 2001-10-01 to 2002-09-30, 2004-10-01 to 2006-09-30`
		]);
	});

	it('a run resumed inside or at the end of an uncapped year is the uninterrupted run’s tail (§2.16)', () => {
		const input = withCaps('cap');
		for (const at of ['2002-06-15', '2002-10-01', '2004-10-01', '2005-03-01']) {
			const snap = JSON.parse(JSON.stringify(captureModelState(input, at)));
			const resumed = runModelFrom(snap, input);
			const k = toEpochDay(at) - d0;
			for (const id of ['a', 'b'])
				for (const key of ['supplied', 'allocation_room_surface', 'dam_storage']) {
					const full = get(cap, id, key).slice(k);
					const tail = get(resumed, id, key);
					expect(tail.length, `${at} ${id} ${key}`).toBe(full.length);
					tail.forEach((v, t) => (Number.isNaN(full[t]!) ? expect(v, `${at} ${id} ${key} +${t}`).toBeNaN() : expect(v, `${at} ${id} ${key} +${t}`).toBeCloseTo(full[t]!, 9)));
				}
		}
	});
});

describe('caps: a scenario that adds a licence (allocation.set)', () => {
	it('a licence added from 1 Oct 2022 leaves the earlier years as the base, caps the last, and warns', () => {
		const base = build({ allocations: [surface('S', 36_500)] });
		const r = applyScenario(base, [{ op: 'allocation.set', allocation: { id: 'new', nodeId: 'F', waterSource: 'groundwater', volumeM3PerYear: 3_650, validFrom: '2022-10-01' } }]);
		expect(r.problems).toEqual([]);
		// The unit has no borehole, so its groundwater use is 0 and the new volume changes no supply; the run names
		// the years before it as uncapped groundwater all the same.
		const out = run(r.input);
		const b = run(base);
		expect(get(out, 'F', 'supplied')).toEqual(get(b, 'F', 'supplied'));
		expect(capWarnings(out)).toEqual([`${WARN}"Unit F" groundwater 2020-10-01 to 2022-09-30`]);
		passes(out);
	});

	it('a scenario that moves a surface licence’s start a year later frees that year', () => {
		const base = build({ allocations: [surface('L', 18_250, '2021-10-01')] });
		const r = applyScenario(base, [{ op: 'allocation.set', allocation: surface('L', 18_250, '2022-10-01') }]);
		const out = run(r.input);
		near(perYear(get(out, 'F', 'supplied')), [36_500, 36_500, 18_250]);
		near(perYear(get(run(base), 'F', 'supplied')), [36_500, 18_250, 18_250]);
		passes(out);
	});
});
