// Cross end-to-end: a full allocation's water year with no licence in force
// (#90 Q24, docs/model.md §2.12a) under demand levels applied after the
// allocation's factor (#90 Q29, §2.12a, §2.15). Engine ≥ 1.70.0; both are
// provisional answers pending the hydrologist.
//
// The composition, as documented: D′ = f × k × D₀, with k = 1 in a year no
// licence is in force on its days. So in such a year a level f still applies,
// to the modelled demand (f × D₀), as it does to a unit with no volume at all,
// while a licensed year asks f × its registered volume. The factor column k
// never carries f.
//
//   - by hand: unit A (an irrigation object of 100 m³/day, no rain, ample
//     river) with licences to 30 Sep 2021 (18 250 m³ a year) and from
//     1 Oct 2022 (9 125), and a water user U (40 m³/day) licensed only from
//     1 Oct 2022 (14 600): k = 0.5, 1, 0.25 for A and 1, 1, 1 for U;
//   - a factor from a date inside the gap year (an outlook member's);
//   - the seasonal outlook on the invented catchment with farm a's licence
//     ended before the decision year: a's members ask level × its modelled
//     demand, b's level × its volume, and a hindcast from mid-season fits the
//     same (the pre-snapshot factor of a year with no licence is 1).
// Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import { toEpochDay } from '../calendar';
import type { AllocationEntry } from '../allocations/compare';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { runModelWith, runModelWithoutChecks, withVerification } from '../run';
import { checkInvariants } from '../verify/checks';
import { applyScenario, type ScenarioOp } from '../scenario';
import { testCatchment } from '../outlook/testCatchment';
import { runSeasonalOutlook, type OutlookLevel } from '../outlook/outlook';

const flat = (v: number) => new Array(12).fill(v);
const START = '2020-10-01';
const YEAR = 365;
const DAYS = 3 * YEAR;
const FA_WARN = 'full allocation: no licence in force, so modelled demand is used, uncapped (as for a unit with no licence; check the licence dates): ';

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const sum = (a: readonly number[], from = 0, to = a.length) => a.slice(from, to).reduce((x, y) => x + y, 0);
const perYear = (a: readonly number[]) => [0, 1, 2].map((y) => sum(a, y * YEAR, (y + 1) * YEAR));
function passes(input: ModelInput, out: ModelOutput) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
}
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
const irrigation: DemandObject = {
	id: 'irr',
	nodeId: 'A',
	name: 'irr',
	category: 'irrigation',
	sizing: 'monthly',
	monthlyM3Day: flat(100),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: ''
};
const ALLOCS: AllocationEntry[] = [
	{ id: 'a1', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 18_250, validTo: '2021-09-30' },
	{ id: 'a2', nodeId: 'A', waterSource: 'groundwater', volumeM3PerYear: 9_125, validFrom: '2022-10-01' },
	{ id: 'u1', nodeId: 'U', waterSource: 'surface', volumeM3PerYear: 14_600, validFrom: '2022-10-01' }
];
function handNet(settings: Record<string, unknown> = {}): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, allocationMode: 'fullAllocation', ...settings } as ModelInput['settings'],
		model: {
			nodes: [
				node('A', { downstreamNodeId: 'U' }),
				node('U', { kind: 'user', downstreamNodeId: 'G', areaKm2: 0, sortOrder: 1, userDemandM3Day: flat(40), userReturnPct: 0, userPriority: 'junior' }),
				node('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0, sortOrder: 2 })
			],
			crops: [],
			cropAreas: [],
			transfers: [],
			demandObjects: [irrigation],
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

describe('Q24 × Q29 by hand: a gap year keeps the modelled demand, and a level applies to it', () => {
	it('no level: A asks 18 250, 36 500 (no licence), 9 125 m³; U 14 600 (no licence), 14 600, 14 600', () => {
		const input = handNet();
		const out = runHand(input);
		passes(input, out);
		const kA = get(out, 'A', 'allocation_demand_factor');
		expect([kA[0], kA[YEAR], kA[2 * YEAR]]).toEqual([0.5, 1, 0.25]);
		get(out, 'U', 'allocation_demand_factor').forEach((v) => expect(v).toBe(1));
		perYear(get(out, 'A', 'demand')).forEach((v, y) => expect(v, `A ${y}`).toBeCloseTo([18_250, 36_500, 9_125][y]!, 6));
		perYear(get(out, 'U', 'demand')).forEach((v, y) => expect(v, `U ${y}`).toBeCloseTo(14_600, 6));
		// Only the scaled years are listed; the warning names the unlicensed ones, by node id.
		expect(out.summary.allocations!.nodes.find((n) => n.nodeId === 'A')!.scaled!.map((r) => r.waterYear)).toEqual([2020, 2022]);
		expect(out.summary.allocations!.nodes.find((n) => n.nodeId === 'U')!.scaled!.map((r) => r.waterYear)).toEqual([2022]);
		expect(out.summary.warnings.filter((w) => w.includes('no licence in force'))).toEqual([`${FA_WARN}"Unit A" in water year 2021; "Unit U" in water years 2020–2021`]);
	});

	for (const f of [0.6, 0.8, 1.2]) {
		it(`demand.scale ${f}: every year asks ${f} × what it asked without the level; k is unchanged`, () => {
			const input = scaled(handNet(), [
				{ op: 'demand.scale', factor: f },
				{ op: 'demand.scale', factor: f, category: 'user' }
			]);
			const out = runHand(input);
			passes(input, out);
			const kA = get(out, 'A', 'allocation_demand_factor');
			expect([kA[0], kA[YEAR], kA[2 * YEAR]]).toEqual([0.5, 1, 0.25]);
			// The gap year: f × 100 m³/day, the modelled demand at the level, as a unit with no volume.
			get(out, 'A', 'demand')
				.slice(YEAR, 2 * YEAR)
				.forEach((v, t) => expect(v, `gap day ${t}`).toBeCloseTo(f * 100, 12));
			perYear(get(out, 'A', 'demand')).forEach((v, y) => expect(v, `A ${y}`).toBeCloseTo(f * [18_250, 36_500, 9_125][y]!, 6));
			perYear(get(out, 'U', 'demand')).forEach((v, y) => expect(v, `U ${y}`).toBeCloseTo(f * 14_600, 6));
		});
	}

	it('the gap year at a level is the same unit with no volume at that level, day by day', () => {
		const ops: ScenarioOp[] = [{ op: 'demand.scale', factor: 0.7 }];
		const fa = runHand(scaled(handNet(), ops));
		const bare = handNet();
		const none = runHand(scaled({ ...bare, model: { ...bare.model, allocations: [] } }, ops));
		const a = get(fa, 'A', 'demand').slice(YEAR, 2 * YEAR);
		const b = get(none, 'A', 'demand').slice(YEAR, 2 * YEAR);
		a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, 12));
	});

	it('a factor from 1 April 2022, inside the gap year (an outlook member’s): 100 m³/day to 31 March, 0.6 × 100 after; the next year 0.6 × 25', () => {
		const input = scaled(handNet({ demandFactorFrom: '2022-04-01' }), [{ op: 'demand.scale', factor: 0.6 }]);
		const out = runHand(input);
		passes(input, out);
		const D = get(out, 'A', 'demand');
		const apr = toEpochDay('2022-04-01') - toEpochDay(START);
		expect(apr - YEAR).toBe(182);
		// 2020/21 is before the factor: 50 m³/day. Gap year: 182 × 100 + 183 × 60 = 29 180. 2022/23: 0.6 × 0.25 × 100 = 15.
		expect(D[0]).toBeCloseTo(50, 12);
		expect(D[apr - 1]).toBeCloseTo(100, 12);
		expect(D[apr]).toBeCloseTo(60, 12);
		expect(D[2 * YEAR]).toBeCloseTo(15, 12);
		perYear(D).forEach((v, y) => expect(v, `year ${y}`).toBeCloseTo([18_250, 29_180, 0.6 * 9_125][y]!, 6));
	});
});

// ---------------------------------------------------------------------------
// The seasonal outlook on the invented catchment (13 water years). Farm a's
// licence ends on 30 Sep 2008, so the decision year 2008/09 has none in force
// for a; farm b is licensed throughout (120 000 m³ a year).
// ---------------------------------------------------------------------------
const RAW = testCatchment({ start: '1996-10-01', end: '2009-09-30', seed: 7, ewrM3Day: 900 });
const VB = 120_000;
const withMode = (mode: 'fullAllocation' | 'none'): ModelInput => ({
	...RAW,
	settings: { ...RAW.settings, allocationMode: mode },
	model: {
		...RAW.model,
		allocations: [
			{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 200_000, validTo: '2008-09-30' },
			{ id: 'b1', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: VB }
		]
	}
});
const FA = withMode('fullAllocation');
const NONE = withMode('none');
const FACTORS = [0.6, 0.8, 1, 1.2];
const LEVELS: OutlookLevel[] = FACTORS.map((f) => ({ id: String(f), label: `${f * 100} %`, ops: f === 1 ? [] : [{ op: 'demand.scale', factor: f }] }));

describe('Q24 × Q29: the seasonal outlook with a farm whose licence ended before the decision year', () => {
	const season = { decisionDate: '2008-10-01', seasonEnd: '2009-04-30' };
	const years = [1999, 2002, 2005];
	const fa = runSeasonalOutlook(FA, { ...season, levels: LEVELS, analogueYears: years, baseRun: runModelWithoutChecks(FA) });
	const none = runSeasonalOutlook(NONE, { ...season, levels: LEVELS, analogueYears: years });

	it('every level ran in every analogue year, with no problem', () => {
		for (const l of fa.levels) {
			expect(l.problems).toEqual([]);
			expect(l.nYears).toBe(years.length);
		}
	});

	it('farm a (no licence in force) asks level × its modelled demand: the compare-only outlook’s, member by member', () => {
		for (const [i, l] of fa.levels.entries())
			for (const [k, y] of l.years.entries()) expect(y.farms.a!.demandM3, `${l.label} ${y.label}`).toBeCloseTo(none.levels[i]!.years[k]!.farms.a!.demandM3, 6);
		// And the level bites on it: 0.6 : 0.8 : 1 : 1.2 of the 100 % member.
		for (const [i, l] of fa.levels.entries())
			for (const [k, y] of l.years.entries()) expect(y.farms.a!.demandM3).toBeCloseTo(FACTORS[i]! * fa.levels[2]!.years[k]!.farms.a!.demandM3, 6);
		expect(fa.levels[2]!.years[0]!.farms.a!.demandM3).toBeGreaterThan(0);
	});

	it('farm b (licensed) asks level × its volume over the season: 0.6 × 120 000 × 212 ÷ 365 for the lowest', () => {
		for (const [i, l] of fa.levels.entries())
			for (const y of l.years) expect(y.farms.b!.demandM3, `${l.label} ${y.label}`).toBeCloseTo((FACTORS[i]! * VB * 212) / 365, 4);
	});

	it('a hindcast from 15 December: a’s pre-snapshot factor is 1, so its members still match the compare-only outlook’s', () => {
		const mid = { decisionDate: '2008-12-15', seasonEnd: '2009-04-30' };
		const a = runSeasonalOutlook(FA, { ...mid, levels: LEVELS, analogueYears: years, baseRun: runModelWithoutChecks(FA) });
		const b = runSeasonalOutlook(NONE, { ...mid, levels: LEVELS, analogueYears: years });
		for (const [i, l] of a.levels.entries())
			for (const [k, y] of l.years.entries()) expect(y.farms.a!.demandM3, `${l.label} ${y.label}`).toBeCloseTo(b.levels[i]!.years[k]!.farms.a!.demandM3, 6);
	});

	it('the full-allocation run itself: a’s factor is 1 in 2008/09 and scaled before; the run warns about that year only', () => {
		const out = runModelWithoutChecks(FA);
		const k = get(out, 'a', 'allocation_demand_factor');
		const d0 = toEpochDay(out.startDate);
		expect(k[toEpochDay('2008-10-01') - d0]).toBe(1);
		expect(k[toEpochDay('2007-10-01') - d0]).not.toBe(1);
		expect(out.summary.warnings.filter((w) => w.includes('no licence in force'))).toEqual([`${FA_WARN}"${RAW.model.nodes.find((n) => n.id === 'a')!.name}" in water year 2008`]);
		expect(checkInvariants(FA, out)).toBeNull();
	});
});
