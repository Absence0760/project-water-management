// End-to-end: drought restrictions (docs/model.md §2.7i) through runModel.
// Unit A's dam (1 000 m³, full on day 0, no inflow, no losses) is drawn
// down by its own abstraction only, so the storage the level reads at the
// start of each day can be worked by hand. Invented names and values.
import { describe, expect, it } from 'vitest';
import type { DemandObject, DroughtRestrictionRule, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { runModel, withVerification } from '../run';

const DAY = 86_400_000;
const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const flat = (v: number) => new Array(12).fill(v);

function unit(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
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
		damCapacityM3: 1000,
		damInitialPct: 1,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.5,
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const gauge = (): NetworkNode => unit('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0, damCapacityM3: 0, damInitialPct: 0, sortOrder: 9 });

/**
 * A crop needing F = 100 m³/day in every month at an A-pan of 100 mm per
 * day-in-month (a 3 100 mm October ÷ 31 …): area 1 000 m² × factor 1 × A-pan
 * ÷ 1000 ÷ days = 100 when A-pan = 100 × days. February uses 28.25 days.
 */
const APAN = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30].map((d) => d * 100);

function input(rule: DroughtRestrictionRule | null, o: { start: string; days: number; units?: NetworkNode[]; objects?: DemandObject[] }): ModelInput {
	return {
		settings: {
			apanMm: APAN as never,
			ewrPragmaticM3PerDay: flat(0) as never,
			lakeEvapFactor: 0,
			effectiveRainStoreMm: 0,
			simulationStart: o.start,
			simulationEnd: iso(epoch(o.start) + o.days - 1),
			...(rule ? { droughtRestriction: rule } : {})
		},
		model: {
			nodes: [...(o.units ?? [unit('A')]), gauge()],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: (o.units ?? [unit('A')]).map((u) => ({ nodeId: u.id, cropId: 'c', areaM2: 1000 })),
			transfers: [],
			...(o.objects ? { demandObjects: o.objects } : {})
		},
		series: { rain_catchment_mm: { startDate: o.start, values: new Array(o.days).fill(0) } }
	};
}

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
function run(i: ModelInput): ModelOutput {
	const out = withVerification(i, runModel(i));
	if (!out.summary.verification) throw new Error("no self-checks ran");
	const bad = out.summary.verification.checks.filter((c) => !c.passed) ?? [];
	if (bad.length) throw new Error(`self-check failed: ${JSON.stringify(bad).slice(0, 2000)}`);
	return out;
}
const round = (a: number[], dp = 9) => a.map((v) => +v.toFixed(dp));

/**
 * The independent model of this one-dam catchment: each day the level is
 * decided on a review (storage at the start of the day ÷ capacity, strictly
 * below a threshold), cleared on a lift, held otherwise; D′ = F(1 − c) ÷ e;
 * G = MIN(storage, D′).
 */
function simulate(o: { start: string; days: number; reviews: string[]; lifts?: string[]; thresholds: number[]; cuts: number[]; e?: number; capacity?: number; startLevel?: number }) {
	const e = o.e ?? 0.5;
	const cap = o.capacity ?? 1000;
	let q = cap;
	let level = o.startLevel ?? 0;
	const levels: number[] = [];
	const restricted: number[] = [];
	const supplied: number[] = [];
	const storage: number[] = [];
	const d0 = epoch(o.start);
	for (let t = 0; t < o.days; t++) {
		const md = iso(d0 + t).slice(5);
		if (o.reviews.includes(md)) {
			const share = q / cap;
			level = 0;
			while (level < o.thresholds.length && share < o.thresholds[level]!) level++;
		} else if (o.lifts?.includes(md)) level = 0;
		const c = level ? o.cuts[level - 1]! : 0;
		const Dr = (100 * (1 - c)) / e;
		const G = Math.min(q, Dr);
		q -= G;
		levels.push(level);
		restricted.push(Dr);
		supplied.push(G);
		storage.push(q);
	}
	return { levels, restricted, supplied, storage };
}

describe('drought restriction end to end (§2.7i)', () => {
	it('a share exactly at the threshold is not below it; the next review below it cuts; demand and deficit keep the unrestricted demand', () => {
		// D = 200/day. Start of day: 1 Oct 1000, 2 Oct 800, 3 Oct 600 (review: 0.6, not < 0.6), 4 Oct 400, 5 Oct 200 (review: 0.2 < 0.6).
		const rule: DroughtRestrictionRule = { reviewDates: ['10-03', '10-05'], levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.5 } }] };
		const out = run(input(rule, { start: '2021-10-01', days: 7 }));
		const ref = simulate({ start: '2021-10-01', days: 7, reviews: rule.reviewDates, thresholds: [0.6], cuts: [0.5] });
		expect(ref.levels).toEqual([0, 0, 0, 0, 1, 1, 1]);
		expect(get(out, null, 'restriction_level')).toEqual(ref.levels);
		expect(round(get(out, 'A', 'restricted_demand'))).toEqual(round(ref.restricted));
		expect(round(get(out, 'A', 'supplied'))).toEqual(round(ref.supplied));
		expect(round(get(out, 'A', 'dam_storage'))).toEqual(round(ref.storage));
		expect(get(out, 'A', 'demand')).toEqual(new Array(7).fill(200));
		const D = get(out, 'A', 'demand');
		const G = get(out, 'A', 'supplied');
		expect(round(get(out, 'A', 'deficit'))).toEqual(round(D.map((d, t) => d - G[t]!)));
		expect(get(out, null, 'restriction_cut@crops')).toEqual(ref.levels.map((l) => (l ? 0.5 : 0)));
	});

	it('two levels, a lift date, and the summary’s days per level per water year', () => {
		const rule: DroughtRestrictionRule = {
			reviewDates: ['09-29', '10-02', '10-04'],
			liftDates: ['10-06'],
			levels: [
				{ label: 'Level 1', belowPct: 0.9, cuts: { crops: 0.25 } },
				{ label: 'Level 2', belowPct: 0.5, cuts: { crops: 0.75 } }
			]
		};
		const start = '2021-09-28';
		const days = 10;
		const out = run(input(rule, { start, days, units: [unit('A', { damCapacityM3: 2000 })] }));
		const ref = simulate({ start, days, reviews: rule.reviewDates, lifts: rule.liftDates, thresholds: [0.9, 0.5], cuts: [0.25, 0.75], capacity: 2000 });
		expect(get(out, null, 'restriction_level')).toEqual(ref.levels);
		expect(round(get(out, 'A', 'restricted_demand'))).toEqual(round(ref.restricted));
		expect(round(get(out, 'A', 'supplied'))).toEqual(round(ref.supplied));
		const s = out.summary.droughtRestriction!;
		const count = (from: number, to: number, l: number) => ref.levels.slice(from, to).filter((x) => x === l).length;
		// 28–30 Sep belong to water year 2020, 1–7 Oct to 2021.
		expect(s.years).toEqual([
			{ waterYear: 2020, days: 3, daysByLevel: [0, 1, 2].map((l) => count(0, 3, l)) },
			{ waterYear: 2021, days: 7, daysByLevel: [0, 1, 2].map((l) => count(3, 10, l)) }
		]);
		expect(s.daysByLevel).toEqual([0, 1, 2].map((l) => count(0, days, l)));
		expect(s.reviews).toBe(3);
		const u = s.units.find((x) => x.nodeId === 'A')!;
		const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
		expect(u.avgRestrictedDemandM3Day).toBeCloseTo(mean(ref.restricted), 9);
		expect(u.avgSuppliedM3Day).toBeCloseTo(mean(ref.supplied), 9);
		const restrictedDays = ref.levels.map((l, t) => [l, t] as const).filter(([l]) => l > 0);
		expect(u.avgCutOnRestrictedDaysM3Day).toBeCloseTo(restrictedDays.reduce((a, [, t]) => a + (200 - ref.restricted[t]!), 0) / restrictedDays.length, 9);
	});

	it('a run that starts between a review and the next lift decides its first day from the starting storage; one after a lift starts unrestricted', () => {
		const rule: DroughtRestrictionRule = { reviewDates: ['10-01'], liftDates: ['12-01'], levels: [{ label: 'L1', belowPct: 0.5, cuts: { crops: 1 } }] };
		const between = run(input(rule, { start: '2021-11-15', days: 3, units: [unit('A', { damInitialPct: 0.4 })] }));
		expect(get(between, null, 'restriction_level')).toEqual([1, 1, 1]);
		expect(get(between, 'A', 'supplied')).toEqual([0, 0, 0]);
		expect(between.summary.droughtRestriction!.reviews).toBe(1);
		const after = run(input(rule, { start: '2021-12-15', days: 3, units: [unit('A', { damInitialPct: 0.4 })] }));
		expect(get(after, null, 'restriction_level')).toEqual([0, 0, 0]);
		expect(after.summary.droughtRestriction!.reviews).toBe(0);
	});

	it('a run that starts on 29 February looks back past it to a 28 February review', () => {
		const rule: DroughtRestrictionRule = { reviewDates: ['02-28'], levels: [{ label: 'L1', belowPct: 0.5, cuts: { crops: 0.5 } }] };
		const out = run(input(rule, { start: '2024-02-29', days: 3, units: [unit('A', { damInitialPct: 0.4 })] }));
		expect(get(out, null, 'restriction_level')).toEqual([1, 1, 1]);
		expect(get(out, 'A', 'restricted_demand')[0]).toBeCloseTo(100, 9);
	});

	it('a restriction on objects holds the basic-needs floor, cuts each category by its own share and leaves uncut parts alone', () => {
		const village: DemandObject = {
			id: 'v',
			nodeId: 'A',
			name: 'Village',
			category: 'domestic',
			sizing: 'perUnit',
			monthlyM3Day: null,
			count: 1000,
			litresPerUnitDay: 100, // 100 m³/day, floor 25
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0,
			priority: 'first',
			destination: 'internal',
			enabled: true,
			note: ''
		};
		const mill: DemandObject = { ...village, id: 'm', name: 'Mill', category: 'industrial', sizing: 'monthly', monthlyM3Day: flat(40), count: null, litresPerUnitDay: null, priority: 'last' };
		const stock: DemandObject = { ...mill, id: 's', name: 'Stock', category: 'livestock', monthlyM3Day: flat(10) };
		const rule: DroughtRestrictionRule = { reviewDates: ['10-01'], levels: [{ label: 'Severe', belowPct: 1, cuts: { crops: 0.6, domestic: 0.9, industrial: 0.5 } }] };
		// Starts at 99 % full: below 100 %, so the level is 1 from day 0.
		const out = run(input(rule, { start: '2021-10-01', days: 1, objects: [village, mill, stock], units: [unit('A', { damCapacityM3: 1e6, damInitialPct: 0.99 })] }));
		// D′ = 100 × 0.4 ÷ 0.5 + MAX(100 × 0.1, MIN(25, 100)) + 40 × 0.5 + 10 = 80 + 25 + 20 + 10 = 135.
		expect(get(out, 'A', 'restricted_demand')[0]).toBeCloseTo(135, 9);
		expect(get(out, 'A', 'supplied')[0]).toBeCloseTo(135, 9);
		expect(get(out, 'A', 'object_supplied@v')[0]).toBeCloseTo(25, 9);
		expect(get(out, 'A', 'object_supplied@m')[0]).toBeCloseTo(20, 9);
		expect(get(out, 'A', 'object_supplied@s')[0]).toBeCloseTo(10, 9);
		// The demand stays the unrestricted one: 200 + 100 + 40 + 10.
		expect(get(out, 'A', 'demand')[0]).toBeCloseTo(350, 9);
		expect(get(out, 'A', 'object_demand@v')[0]).toBeCloseTo(100, 9);
	});

	it('the "own" basis gives each unit its own level; a unit outside nodeIds is never cut', () => {
		const rule: DroughtRestrictionRule = { reviewDates: ['10-01'], basis: 'own', nodeIds: ['A', 'B'], levels: [{ label: 'L1', belowPct: 0.5, cuts: { crops: 0.5 } }] };
		const units = [unit('A', { damInitialPct: 0.3 }), unit('B', { damInitialPct: 0.8 }), unit('C', { damInitialPct: 0.1 })];
		const out = run(input(rule, { start: '2021-10-01', days: 2, units }));
		expect(get(out, 'A', 'restriction_level')).toEqual([1, 1]);
		expect(get(out, 'B', 'restriction_level')).toEqual([0, 0]);
		expect(out.series.some((s) => s.nodeId === 'C' && s.key === 'restricted_demand')).toBe(false);
		// A: D′ = 100 ÷ 0.5 × 0.5 = 100, from 300 m³: 100 then 100. C uncut: 200 a day from 100 m³.
		expect(round(get(out, 'A', 'supplied'))).toEqual([100, 100]);
		expect(round(get(out, 'C', 'supplied'))).toEqual([100, 0]);
		// The catchment level is the deepest any unit is at.
		expect(get(out, null, 'restriction_level')).toEqual([1, 1]);
	});

	it('the total basis reads Σ storage ÷ Σ capacity over every farm dam', () => {
		// A: 300 of 1 000, B: 900 of 1 000 → 1 200 ÷ 2 000 = 0.6, not below 0.6; with B at 899 it is.
		const rule: DroughtRestrictionRule = { reviewDates: ['10-01'], levels: [{ label: 'L1', belowPct: 0.6, cuts: { crops: 0.5 } }] };
		const at = run(input(rule, { start: '2021-10-01', days: 1, units: [unit('A', { damInitialPct: 0.3 }), unit('B', { damInitialPct: 0.9 })] }));
		expect(get(at, null, 'restriction_level')).toEqual([0]);
		const below = run(input(rule, { start: '2021-10-01', days: 1, units: [unit('A', { damInitialPct: 0.3 }), unit('B', { damInitialPct: 0.899 })] }));
		expect(get(below, null, 'restriction_level')).toEqual([1]);
		expect(get(below, 'A', 'restricted_demand')[0]).toBeCloseTo(100, 9);
		expect(get(below, 'B', 'restricted_demand')[0]).toBeCloseTo(100, 9);
	});

	it('the EWR trigger raises the level on a review day after a day the outlet’s EWR wasn’t met; never on a fresh run’s first day', () => {
		const rule: DroughtRestrictionRule = { reviewDates: ['10-03'], ewrTrigger: { siteNodeId: null, level: 1 }, levels: [{ label: 'L1', belowPct: 0.01, cuts: { crops: 0.5 } }] };
		const withEwr = (i: ModelInput): ModelInput => ({ ...i, settings: { ...i.settings, ewrPragmaticM3PerDay: flat(1e9) as never } });
		const out = run(withEwr(input(rule, { start: '2021-10-01', days: 5, units: [unit('A', { damCapacityM3: 1e6 })] })));
		expect(get(out, null, 'restriction_level')).toEqual([0, 0, 1, 1, 1]);
		expect(out.summary.droughtRestriction!.ewrReviews).toBe(1);
		const first = run(withEwr(input(rule, { start: '2021-10-03', days: 3, units: [unit('A', { damCapacityM3: 1e6 })] })));
		expect(get(first, null, 'restriction_level')).toEqual([0, 0, 0]);
	});
});
