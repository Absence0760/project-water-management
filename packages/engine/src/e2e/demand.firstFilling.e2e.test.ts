// End-to-end: a new dam's first filling and the drought restriction rule
// (docs/model.md §2.7g, §2.7i; issue #90 Q30, engine ≥ 1.70.0).
//
// The rule: a dam that comes into service after the first day of the run
// (of the record a resumed run continues) starts empty and is left out of
// the storage a review reads, both its storage and its capacity, until it
// first starts a day holding the mildest level's share of its capacity (its
// belowPct; full for a rule with no level). From that day on it counts like
// any other dam. Under the per-unit basis its unit isn't restricted by
// storage while it fills; the EWR trigger still applies. A dam in service on
// the run's first day is an existing dam and always counts.
//
// Worked by hand on small invented networks fed natural flow directly
// (runModelWith): no rain, no evaporation, no seepage, so each dam holds
// what flows in less what is drawn, and every run passes the self-checks
// and the water balance. Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { DemandObject, DroughtRestrictionRule, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { captureModelState, runModelFrom, runModelWith, runModelWithoutChecks, withVerification } from '../run';
import { checkDroughtRestriction, checkInvariants } from '../verify/checks';
import { testCatchment } from '../outlook/testCatchment';
import { checkResume } from '../testing/warmstartInvariants';
import { randomInput, Rng } from '../testing/fuzz';

const flat = (v: number) => new Array(12).fill(v);
const START = '2021-10-01';

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
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const gauge = (): NetworkNode => unit('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0, sortOrder: 9 });
const irrigation = (nodeId: string, m3Day: number): DemandObject => ({
	id: `irr${nodeId}`,
	nodeId,
	name: `Irrigation ${nodeId}`,
	category: 'irrigation',
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
// Level 1 below 60 % cuts irrigation by half, level 2 below 30 % in full.
const LEVELS: DroughtRestrictionRule['levels'] = [
	{ label: 'L1', belowPct: 0.6, cuts: { irrigation: 0.5 } },
	{ label: 'L2', belowPct: 0.3, cuts: { irrigation: 1 } }
];
/** Every day from 1 October on as a review date ("10-01" …), at most 12. */
const daily = (from: number, n: number) => Array.from({ length: n }, (_, i) => `10-${String(from + i).padStart(2, '0')}`);

function build(units: NetworkNode[], rule: DroughtRestrictionRule, o: { objects?: DemandObject[]; days: number; ewr?: number }): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(o.ewr ?? 0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, droughtRestriction: rule } as ModelInput['settings'],
		model: { nodes: [...units, gauge()], crops: [], cropAreas: [], transfers: [], demandObjects: o.objects ?? [] },
		series: { rain_catchment_mm: { startDate: START, values: new Array(o.days).fill(0) } }
	};
}
const run = (input: ModelInput, natural: number[]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));
function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}; have ${out.series.filter((x) => x.nodeId === nodeId).map((x) => x.key).join(', ')}`);
	return s.values;
}
const near = (a: number[], b: number[], digits = 9) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, digits));
};
function passes(input: ModelInput, out: ModelOutput) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	expect(out.summary.waterBalance!.total.residualM3).toBeCloseTo(0, 6);
}

describe('the all-dams basis: a new empty dam no longer drags every unit into restriction', () => {
	// 12 days from Friday 1 October 2021. Three units of 1 km² each share the catchment's 300 m³/day: 100 each.
	// A: an existing dam, 1 000 m³ at 70 %, its runoff passing it by (it holds 700 throughout). B: a new dam of
	// 1 000 m³ in service from 4 October, catching all its 100 m³/day. C: no dam, an irrigation object of 90 m³/day
	// taken from its own runoff. Reviews on 4, 8 and 12 October; the run's first day is decided too (the latest
	// date before it, 12 October last year, is a review).
	const A = unit('A', { damCapacityM3: 1000, damInitialPct: 0.7 });
	const B = (over: Partial<NetworkNode> = {}) => unit('B', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2021-10-04', ...over });
	// C takes its runoff to its crop (no dam: what would go into one goes to the demand, the rest passes).
	const C = unit('C', { pctRunoffToDam: 1 });
	const rule: DroughtRestrictionRule = { reviewDates: ['10-04', '10-08', '10-12'], levels: LEVELS };
	const natural = new Array(12).fill(300);
	const input = build([A, B(), C], rule, { objects: [irrigation('C', 90)], days: 12 });
	const out = run(input, natural);

	it('B fills 100 m³ a day from 4 October and starts 10 October at 600 m³, 60 %: it joins the reviews that day', () => {
		near(get(out, 'B', 'dam_storage'), [0, 0, 0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
		expect(out.summary.droughtRestriction!.filling).toEqual([{ nodeId: 'B', inServiceFrom: '2021-10-04', joinedOn: '2021-10-10' }]);
		passes(input, out);
	});

	it('every review reads A alone while B fills (70 %: no level), then A and B: no unit is restricted', () => {
		// 1 Oct: A only (B has no capacity): 70 %. 4 Oct: B starts empty, filling: A only, 70 % (before 1.70.0:
		// 700 ÷ 2 000 = 35 %, level 1). 8 Oct: B holds 400, still filling: 70 % (before: 1 100 ÷ 2 000 = 55 %,
		// level 1). 12 Oct: B counts, (700 + 900) ÷ 2 000 = 80 %.
		expect(get(out, null, 'restriction_level')).toEqual(new Array(12).fill(0));
		near(get(out, 'C', 'restricted_demand'), new Array(12).fill(90));
		near(get(out, 'C', 'supplied'), new Array(12).fill(90));
	});

	it('positive control: the same dam as an existing one (no in-service date, starting empty) counts from the first day and restricts C', () => {
		const x = build([A, B({ damInServiceFrom: null }), C], rule, { objects: [irrigation('C', 90)], days: 12 });
		const o = run(x, natural);
		passes(x, o);
		// B fills from 1 October: 100, 200, … 1 Oct: (700 + 0) ÷ 2 000 = 35 %: level 1. 4 Oct: (700 + 300) ÷ 2 000 =
		// 50 %: level 1. 8 Oct: (700 + 700) ÷ 2 000 = 70 %: none.
		expect(get(o, null, 'restriction_level')).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
		near(get(o, 'C', 'restricted_demand'), [45, 45, 45, 45, 45, 45, 45, 90, 90, 90, 90, 90]);
		expect(o.summary.droughtRestriction!.filling).toBeUndefined();
	});

	it('a dam in service on the run’s first day is an existing dam: not filling, the same run as without the date, to the bit', () => {
		const onDay0 = build([A, B({ damInServiceFrom: START }), C], rule, { objects: [irrigation('C', 90)], days: 12 });
		const without = build([A, B({ damInServiceFrom: null }), C], rule, { objects: [irrigation('C', 90)], days: 12 });
		const a = run(onDay0, natural);
		const b = run(without, natural);
		passes(onDay0, a);
		expect(a.summary.droughtRestriction!.filling).toBeUndefined();
		expect(get(a, null, 'restriction_level')).toEqual(get(b, null, 'restriction_level'));
		for (const k of ['dam_storage', 'restricted_demand', 'supplied', 'outflow']) for (const id of ['B', 'C']) {
			const s = a.series.find((x) => x.nodeId === id && x.key === k);
			if (s) expect(s.values, `${id}:${k}`).toEqual(get(b, id, k));
		}
	});
});

describe('a part-filled dam’s water counts: each review reads the filling dams out and in, and takes the milder', () => {
	// A existing at 20 % (200 of 1 000, its runoff passing by); B new from 4 October, catching its runoff;
	// C no dam. Daily reviews 4 … 12 October. B's runoff: 500 m³ on 4 October, 400 on 9 October, else none
	// (the catchment's flow is 3 × that, shared in thirds). So B starts 5 … 9 October at 500 (50 %, below
	// 60 %: filling) and 10 October at 900 (90 %): it joins on 10 October.
	const A = unit('A', { damCapacityM3: 1000, damInitialPct: 0.2 });
	const B = unit('B', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2021-10-04' });
	const rule: DroughtRestrictionRule = { reviewDates: daily(4, 9), levels: LEVELS };
	const natural = [0, 0, 0, 1500, 0, 0, 0, 0, 1200, 0, 0, 0];
	const input = build([A, B, unit('C')], rule, { objects: [irrigation('C', 90)], days: 12 });
	const out = run(input, natural);

	it('4 Oct: out 20 %, in 10 %, both level 2; 5–9 Oct: out 20 % (level 2), in (200 + 500) ÷ 2 000 = 35 % (level 1): the milder, 1; from 10 Oct B counts: 55 %, level 1', () => {
		passes(input, out);
		near(get(out, 'B', 'dam_storage'), [0, 0, 0, 500, 500, 500, 500, 500, 900, 900, 900, 900]);
		// The first day: A alone (B has no capacity), 20 %: level 2, held to 4 October.
		expect(get(out, null, 'restriction_level')).toEqual([2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
		expect(out.summary.droughtRestriction!.filling).toEqual([{ nodeId: 'B', inServiceFrom: '2021-10-04', joinedOn: '2021-10-10' }]);
		// C is cut in full on level 2, by half on level 1.
		near(get(out, 'C', 'restricted_demand'), [0, 0, 0, 0, 45, 45, 45, 45, 45, 45, 45, 45]);
	});

	it('the self-check redoes both readings: a level read with B left out only (2 on 5 October) fails it', () => {
		const tampered = { ...out, series: out.series.map((x) => (x.nodeId === null && x.key === 'restriction_level' ? { ...x, values: x.values.map((v, t) => (t === 4 ? 2 : v)) } : x)) };
		expect(checkDroughtRestriction(input, tampered)).toMatch(/day 4: drought restriction level 2 ≠ 1/);
	});

	it('a rule with one level at 100 %: the dam joins only once full', () => {
		const full: DroughtRestrictionRule = { reviewDates: daily(4, 9), levels: [{ label: 'Any', belowPct: 1, cuts: { irrigation: 0.5 } }] };
		const x = build([A, B, unit('C')], full, { objects: [irrigation('C', 90)], days: 12 });
		// B reaches 900 then 1 000 (the rest spills) on 10 October with 1 500 more: full from 11 October.
		const o = run(x, [0, 0, 0, 1500, 0, 0, 0, 0, 1200, 300, 0, 0]);
		passes(x, o);
		near(get(o, 'B', 'dam_storage'), [0, 0, 0, 500, 500, 500, 500, 500, 900, 1000, 1000, 1000]);
		expect(o.summary.droughtRestriction!.filling![0]!.joinedOn).toBe('2021-10-11');
	});
});

describe('the exemption ends exactly on the day the dam starts at its fill share', () => {
	// A existing at 70 % (700, runoff passing, no demand); B new from 4 October, catching v m³ of runoff on 4 October
	// only, and drawing 100 m³/day for its irrigation. The rule cuts A only, so B's draw doesn't depend on the level.
	// Daily reviews 4 … 12 October. With v = 700, B ends 4 October at 600 and starts 5 October at 60 %: it joins and
	// from then counts alone, its fall included. With v = 699 it starts at 599: it never joins, and the milder of
	// the two readings keeps A's 70 % (level 0) throughout.
	const A = unit('A', { damCapacityM3: 1000, damInitialPct: 0.7 });
	const B = unit('B', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2021-10-04' });
	const rule: DroughtRestrictionRule = { reviewDates: daily(4, 9), levels: LEVELS, nodeIds: ['A'] };
	const make = () => build([A, B], rule, { objects: [irrigation('B', 100)], days: 12 });
	const flow = (v: number) => [0, 0, 0, 2 * v, 0, 0, 0, 0, 0, 0, 0, 0];

	it('v = 700: joins 5 October; 5–6 Oct 65 %, 60 %: none; 7 Oct (700 + 400) ÷ 2 000 = 55 %: level 1, as B drains', () => {
		const input = make();
		const out = run(input, flow(700));
		passes(input, out);
		near(get(out, 'B', 'dam_storage'), [0, 0, 0, 600, 500, 400, 300, 200, 100, 0, 0, 0]);
		expect(out.summary.droughtRestriction!.filling).toEqual([{ nodeId: 'B', inServiceFrom: '2021-10-04', joinedOn: '2021-10-05' }]);
		// 4 Oct: B filling at 0: out 70 % (none), in 35 % (level 1): the milder, none.
		expect(get(out, null, 'restriction_level')).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
	});

	it('v = 699: one m³ short of 60 %, it never joins; out 70 % is the milder on every review: no level, and the run warns', () => {
		const input = make();
		const out = run(input, flow(699));
		passes(input, out);
		expect(out.summary.droughtRestriction!.filling![0]!.joinedOn).toBeNull();
		expect(get(out, null, 'restriction_level')).toEqual(new Array(12).fill(0));
		expect(out.summary.warnings.join('\n')).toMatch(/never reached 60 % of its capacity/);
	});
});

describe('the per-unit basis: a unit whose dam is filling isn’t restricted by storage; the EWR trigger still applies', () => {
	// A: an existing dam at 20 %, its runoff passing by, no demand. B: a new dam from 4 October catching its 300 m³/day,
	// an irrigation object of 100 m³/day from it. Daily reviews 4 … 12 October, each unit on its own dam.
	const A = unit('A', { damCapacityM3: 1000, damInitialPct: 0.2 });
	const B = unit('B', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2021-10-04' });
	const rule: DroughtRestrictionRule = { reviewDates: daily(4, 9), levels: LEVELS, basis: 'own' };
	const natural = new Array(12).fill(600);

	it('B is never restricted: filling to 7 October (0, 20, 40 %), then at 60 % and up', () => {
		const input = build([A, B], rule, { objects: [irrigation('B', 100)], days: 12 });
		const out = run(input, natural);
		passes(input, out);
		// B: 300 in, 100 out a day from 4 October: 200, 400, 600 … B starts 7 October at 600: it joins then.
		near(get(out, 'B', 'dam_storage'), [0, 0, 0, 200, 400, 600, 800, 1000, 1000, 1000, 1000, 1000]);
		expect(out.summary.droughtRestriction!.filling).toEqual([{ nodeId: 'B', inServiceFrom: '2021-10-04', joinedOn: '2021-10-07' }]);
		// Before 1.70.0 B read 0 % on 4 October and 20 % on 5 October (level 2), 40 % on 6 October (level 1).
		expect(get(out, 'B', 'restriction_level')).toEqual(new Array(12).fill(0));
		near(get(out, 'B', 'restricted_demand'), new Array(12).fill(100));
		// A, at 20 % on its own dam, is at level 2 throughout (the first day decided too); the catchment column is the deepest.
		expect(get(out, 'A', 'restriction_level')).toEqual(new Array(12).fill(2));
		expect(get(out, null, 'restriction_level')).toEqual(new Array(12).fill(2));
	});

	it('with an EWR trigger (level 1 at the outlet, never met) B is raised to level 1 from the first review, filling or not', () => {
		const withEwr: DroughtRestrictionRule = { ...rule, ewrTrigger: { siteNodeId: null, level: 1 } };
		const input = build([A, B], withEwr, { objects: [irrigation('B', 100)], days: 12, ewr: 1e6 });
		const out = run(input, natural);
		passes(input, out);
		// The first day has no day before: not raised, and B has no dam: level 0, held to the 4 October review.
		expect(get(out, 'B', 'restriction_level')).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
		near(get(out, 'B', 'restricted_demand'), [100, 100, 100, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
		// Filling with 300 in and 50 out: 250 a day; it starts 7 October at 750 (≥ 60 %).
		expect(out.summary.droughtRestriction!.filling![0]!.joinedOn).toBe('2021-10-07');
	});
});

describe('several new dams with different in-service dates, and one that never fills', () => {
	// A existing at 50 %, runoff passing. B new from 3 October, C new from 6 October, each catching 100 m³/day.
	// Reviews daily 3 … 14 October; the first day is decided too (14 October last year is a review).
	const A = unit('A', { damCapacityM3: 1000, damInitialPct: 0.5 });
	const B = unit('B', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2021-10-03' });
	const C = unit('C', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2021-10-06' });
	const rule: DroughtRestrictionRule = { reviewDates: daily(3, 12), levels: LEVELS };

	it('B joins on 9 October, C on 12 October, each at 600 m³; the share reads only the dams that have joined', () => {
		const input = build([A, B, C], rule, { days: 14 });
		const out = run(input, new Array(14).fill(300));
		passes(input, out);
		near(get(out, 'B', 'dam_storage'), [0, 0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1000, 1000]);
		near(get(out, 'C', 'dam_storage'), [0, 0, 0, 0, 0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
		expect(out.summary.droughtRestriction!.filling).toEqual([
			{ nodeId: 'B', inServiceFrom: '2021-10-03', joinedOn: '2021-10-09' },
			{ nodeId: 'C', inServiceFrom: '2021-10-06', joinedOn: '2021-10-12' }
		]);
		// 1–8 Oct: A alone, 50 %: level 1. 9 Oct: (500 + 600) ÷ 2 000 = 55 %: level 1. 10 Oct: 1 200 ÷ 2 000 = 60 %:
		// none. 12 Oct: (500 + 900 + 600) ÷ 3 000 = 66.7 %: none. (Counting the filling dams from their in-service days,
		// as before 1.70.0, 3 Oct would read (500 + 0) ÷ 2 000 = 25 %: level 2.)
		expect(get(out, null, 'restriction_level')).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
	});

	it('a dam that never fills in the run is left out of every review, and the run says so', () => {
		const input = build([A, B, C], rule, { days: 14 });
		// 60 m³/day each: B starts 13 October at 10 × 60 = 600 and joins; C holds 8 × 60 = 480 by the end, never 600.
		const out = run(input, new Array(14).fill(180));
		passes(input, out);
		expect(out.summary.droughtRestriction!.filling).toEqual([
			{ nodeId: 'B', inServiceFrom: '2021-10-03', joinedOn: '2021-10-13' },
			{ nodeId: 'C', inServiceFrom: '2021-10-06', joinedOn: null }
		]);
		expect(out.summary.warnings.join('\n')).toMatch(/the dam of "Unit C" \(in service from 2021-10-06\) never reached 60 % of its capacity in the run/);
		expect(out.summary.warnings.join('\n')).not.toMatch(/"Unit B"\) never/);
		// A alone (50 %, level 1) to 12 Oct; 13 Oct (500 + 600) ÷ 2 000 = 55 %, 14 Oct 58 %: still level 1.
		expect(get(out, null, 'restriction_level')).toEqual(new Array(14).fill(1));
	});

	it('a dam in service after the run is never in service: it isn’t listed as filling', () => {
		const late = unit('C', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2030-01-01' });
		const input = build([A, B, late], rule, { days: 14 });
		const out = run(input, new Array(14).fill(300));
		passes(input, out);
		// It "comes into service after the first day", so it is filling, but it never has capacity, so never joins.
		expect(out.summary.droughtRestriction!.filling!.find((f) => f.nodeId === 'C')).toEqual({ nodeId: 'C', inServiceFrom: '2030-01-01', joinedOn: null });
	});
});

describe('a dam that silts empty (ER-15’s no-dam days) is an existing dam, not a filling one', () => {
	// A: surveyed 3 October 2016 at 1 000 m³, losing 20 % a year: 1 − 0.2 × 1 824 ÷ 365.25 = 0.12 % of it on
	// 1 October 2021, nothing from 4 October. B: an existing dam at 70 %. Daily reviews 1 … 6 October.
	const A = unit('A', { damCapacityM3: 1000, damInitialPct: 0.1, damSurveyDate: '2016-10-03', damSedimentPctPerYear: 0.2 });
	const B = unit('B', { damCapacityM3: 1000, damInitialPct: 0.7 });
	const rule: DroughtRestrictionRule = { reviewDates: daily(1, 6), levels: LEVELS };
	it('it drops out of the reviews when its capacity is gone, without being listed as filling; B alone reads 70 %', () => {
		const input = build([A, B], rule, { days: 6 });
		const out = run(input, new Array(6).fill(0));
		passes(input, out);
		near(get(out, 'A', 'dam_capacity').slice(3), [0, 0, 0]);
		expect(out.summary.droughtRestriction!.filling).toBeUndefined();
		expect(get(out, null, 'restriction_level')).toEqual([0, 0, 0, 0, 0, 0]);
	});
});

describe('monotone: a fuller existing dam never deepens a level, a wetter new dam never joins later', () => {
	const B = unit('B', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2021-10-04' });
	const rule: DroughtRestrictionRule = { reviewDates: daily(4, 9), levels: LEVELS };

	it('A from 0 % to 100 % in steps of 5 %: every day’s level is no deeper than at the step below', () => {
		let prev: number[] | null = null;
		for (let p = 0; p <= 20; p++) {
			const input = build([unit('A', { damCapacityM3: 1000, damInitialPct: p / 20 }), B, unit('C')], rule, { objects: [irrigation('C', 90)], days: 12 });
			const out = run(input, new Array(12).fill(240));
			passes(input, out);
			const lv = get(out, null, 'restriction_level');
			if (prev) lv.forEach((v, t) => expect(v, `A at ${p * 5} %, day ${t}`).toBeLessThanOrEqual(prev![t]!));
			prev = lv;
		}
	});

	it('B’s runoff from 20 to 200 m³/day: it joins no later, and is never in a review before it holds 60 %', () => {
		let prevJoin = Infinity;
		for (let r = 20; r <= 200; r += 20) {
			const input = build([unit('A', { damCapacityM3: 1000, damInitialPct: 0.5 }), B, unit('C')], rule, { days: 12 });
			const out = run(input, new Array(12).fill(3 * r));
			passes(input, out);
			const on = out.summary.droughtRestriction!.filling![0]!.joinedOn;
			const at = on === null ? Infinity : toEpochDay(on) - toEpochDay(START);
			expect(at, `runoff ${r}`).toBeLessThanOrEqual(prevJoin);
			if (at !== Infinity) expect(get(out, 'B', 'dam_storage')[at - 1]!).toBeGreaterThanOrEqual(600 - 1e-9);
			prevJoin = at;
		}
	});
});

describe('resumed runs carry the dams still filling (§2.16)', () => {
	// The invented test catchment, Farm B's dam in service from 1 March 2004, a total-basis rule reviewed monthly.
	const X = testCatchment({ start: '2002-10-01', end: '2005-09-30', seed: 31, ewrM3Day: 600 });
	const input: ModelInput = {
		...X,
		settings: { ...X.settings, droughtRestriction: { reviewDates: ['01-01', '02-01', '03-01', '04-01', '05-01', '06-01', '07-01', '08-01', '09-01', '10-01', '11-01', '12-01'], levels: LEVELS } },
		model: { ...X.model, nodes: X.model.nodes.map((n) => (n.id === 'b' ? { ...n, damInServiceFrom: '2004-03-01' } : n)) }
	};
	const full = runModelWithoutChecks(input);
	const f = full.summary.droughtRestriction!.filling!;

	it('the uninterrupted run: B fills and joins after its in-service day', () => {
		expect(f).toHaveLength(1);
		expect(f[0]!.nodeId).toBe('b');
		expect(f[0]!.joinedOn).not.toBeNull();
		expect(f[0]!.joinedOn! > '2004-03-01').toBe(true);
		expect(withVerification(input, full).summary.verification!.passed).toBe(true);
	});

	it('resumed on the day before service, the in-service day, while filling, the join day and after: the uninterrupted run’s days to the bit, self-checked', () => {
		const join = f[0]!.joinedOn!;
		const d0 = toEpochDay(full.startDate);
		const at = ['2004-02-29', '2004-03-01', fromEpochDay(toEpochDay(join) - 1), join, fromEpochDay(toEpochDay(join) + 1), '2005-01-01'];
		for (const d of at) {
			expect(checkResume(input, toEpochDay(d) - d0, full), d).toBeNull();
			const snap = captureModelState(input, d);
			const resumed = runModelFrom(snap, input);
			expect(checkDroughtRestriction(input, resumed), d).toBeNull();
			// A snapshot of the join day's start still has B filling: the resumed run joins it on its first day.
			const filling = d <= join;
			expect(resumed.summary.droughtRestriction!.start!.fillingBefore ?? [], d).toEqual(filling ? ['b'] : []);
			expect(resumed.summary.droughtRestriction!.filling ?? [], d).toEqual(filling ? [{ nodeId: 'b', inServiceFrom: '2004-03-01', joinedOn: join }] : []);
		}
	});
});

describe('property: with dams filling, a review is never deeper than with them counted, nor than with them left out', () => {
	/**
	 * For every review day of a shared-basis run, the level read from the run's own columns with the dams filling
	 * that day all left out and all counted; a filling dam is one listed in `filling` that hasn't joined yet.
	 */
	function readings(input: ModelInput, out: ModelOutput): { t: number; level: number; out: number; in: number }[] {
		const rule = input.settings.droughtRestriction!;
		const thr = rule.levels.map((l) => l.belowPct);
		const levelFor = (share: number) => {
			let k = 0;
			while (k < thr.length && share < thr[k]!) k++;
			return k;
		};
		const d0 = toEpochDay(out.startDate);
		const reviews = new Set(rule.reviewDates);
		const dams = input.model.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
		const joinOf = new Map((out.summary.droughtRestriction!.filling ?? []).map((f) => [f.nodeId, f.joinedOn === null ? Infinity : toEpochDay(f.joinedOn) - d0]));
		const LV = get(out, null, 'restriction_level');
		const rows: { t: number; level: number; out: number; in: number }[] = [];
		for (let t = 1; t < out.days; t++) {
			if (!reviews.has(fromEpochDay(d0 + t).slice(5))) continue;
			let q = 0, c = 0, qa = 0, ca = 0;
			for (const n of dams) {
				const capCol = out.series.find((x) => x.nodeId === n.id && x.key === 'dam_capacity')?.values;
				const cap = capCol ? capCol[t]! : n.damCapacityM3;
				if (!(cap > 0)) continue;
				const s = get(out, n.id, 'dam_storage')[t - 1]!;
				qa += s;
				ca += cap;
				if ((joinOf.get(n.id) ?? -1) > t) continue;
				q += s;
				c += cap;
			}
			rows.push({ t, level: LV[t]!, out: c > 0 ? levelFor(q / c) : 0, in: ca > 0 ? levelFor(qa / ca) : 0 });
		}
		return rows;
	}

	it('on a sweep of the hand network (A 0–100 %, B’s runoff 0–300 m³/day): the level is the milder of the two readings on every review', () => {
		const B = unit('B', { damCapacityM3: 1000, pctRunoffToDam: 1, damInServiceFrom: '2021-10-04' });
		const rule: DroughtRestrictionRule = { reviewDates: daily(2, 11), levels: LEVELS };
		let deeperIfOut = 0;
		let deeperIfIn = 0;
		for (let p = 0; p <= 10; p++)
			for (const r of [0, 30, 60, 100, 150, 300]) {
				const input = build([unit('A', { damCapacityM3: 1000, damInitialPct: p / 10 }), B, unit('C', { pctRunoffToDam: 1 })], rule, { objects: [irrigation('C', 90)], days: 12 });
				const out = run(input, new Array(12).fill(3 * r));
				passes(input, out);
				for (const x of readings(input, out)) {
					expect(x.level, `A ${p * 10} %, B ${r}/day, day ${x.t}`).toBe(Math.min(x.out, x.in));
					if (x.out > x.in) deeperIfOut++;
					if (x.in > x.out) deeperIfIn++;
				}
			}
		// Both ways bite somewhere in the sweep: the rule isn't just one of the two readings.
		expect(deeperIfOut).toBeGreaterThan(0);
		expect(deeperIfIn).toBeGreaterThan(0);
	});

	it('on random networks with dams coming into service and a shared-basis rule reviewed monthly', () => {
		let checked = 0;
		for (let seed = 1; seed <= 40; seed++) {
			const x = randomInput(seed);
			const span = runModelWithoutChecks(x);
			const g = new Rng(seed ^ 0x77);
			x.model.nodes = x.model.nodes.map((n) => (n.kind === 'farm' && n.damCapacityM3 > 0 && g.bool(0.6) ? { ...n, damInServiceFrom: fromEpochDay(toEpochDay(span.startDate) + 1 + g.int(0, Math.max(1, Math.floor(span.days / 2)))) } : n));
			x.settings.droughtRestriction = {
				reviewDates: ['01-01', '02-01', '03-01', '04-01', '05-01', '06-01', '07-01', '08-01', '09-01', '10-01', '11-01', '12-01'],
				levels: [
					{ label: 'L1', belowPct: g.float(0.5, 0.9), cuts: { crops: 0.3 } },
					{ label: 'L2', belowPct: g.float(0.1, 0.45), cuts: { crops: 0.6 } }
				]
			};
			const out = withVerification(x, runModelWithoutChecks(x));
			expect(out.summary.verification!.passed, `seed ${seed}`).toBe(true);
			if (!out.summary.droughtRestriction?.filling?.length) continue;
			checked++;
			for (const r of readings(x, out)) {
				expect(r.level, `seed ${seed} day ${r.t}`).toBeLessThanOrEqual(r.in);
				expect(r.level, `seed ${seed} day ${r.t}`).toBeLessThanOrEqual(r.out);
			}
		}
		expect(checked).toBeGreaterThan(10);
	}, 300_000);
});
