// A fixed restriction % for Priority users (engine 1.86.0, issue #523 B3,
// docs/model.md §2.7c and §2.7i): off by default (absent, null and 0 run to
// the bit as before); with a drought restriction rule, a Priority user's
// demand is cut by its fixed % on every day its level cuts some part of a
// unit's demand (a "watch" level, every cut 0 %, restricts nobody:
// engine-audit.md P2, decided 2026-10-12), with no basic-needs floor, and the farms upstream pass its claim at the restricted
// demand; in the curtailment table it is curtailed by at most that share of
// its demand, the rest of its EWR charge standing. Hand cases on a fixed
// natural flow, then random networks for the invariants.
import { describe, expect, it } from 'vitest';
import type { DroughtRestrictionRule, ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModel, runModelWith, runModelWithoutChecks, withVerification } from '../run';
import { cloneInput, randomDroughtRestriction, randomInput, Rng } from '../testing/fuzz';
import { checkAll, sameOutput } from '../testing/invariants';
import { checkResume } from '../testing/warmstartInvariants';
import { otherUserCurtailment } from './curtailment';
import { RESTRICTION_SERIES, userRestrictionShare } from './restriction';

const DAYS = 4;
const NATURAL = new Array<number>(DAYS).fill(1000);
const flat = (v: number) => new Array<number>(12).fill(v);

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/**
 * Unit A (a 1 000 m³ dam, half full, no crops, all the natural flow of
 * 1 000 m³/day) drains into Priority user U (wants 200 m³/day), then gauge G.
 * Four days from 1 January 2021, no rain, no dam losses.
 */
function input(user: Partial<NetworkNode>, rule: DroughtRestrictionRule | null, ewr = 0): ModelInput {
	return {
		settings: { apanMm: flat(0) as never, lakeEvapFactor: 0, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(ewr) as never, ...(rule ? { droughtRestriction: rule } : {}) },
		model: {
			nodes: [node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(200), userPriority: 'senior', ...user }), node('A', 'farm', 'U', { damCapacityM3: 1000, damInitialPct: 0.5 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(DAYS).fill(0) } }
	};
}

const run = (i: ModelInput) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: NATURAL })));
const col = (o: ModelOutput, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values;
const passed = (o: ModelOutput) => expect(o.summary.verification?.passed, JSON.stringify(o.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);

// Reviewed on 1 January (the run's first day): one level, in force whenever the dams aren't full, cutting the units'
// crops by 20 % (A has none, so its own water doesn't change): a level that cuts some part of a unit's demand.
const always: DroughtRestrictionRule = { reviewDates: ['01-01'], levels: [{ belowPct: 1, cuts: { crops: 0.2 } }] };
// The same level as a "watch" level: every cut 0 % (or none named), so it warns and restricts nobody (engine-audit.md P2).
const watch: DroughtRestrictionRule = { reviewDates: ['01-01'], levels: [{ label: 'Watch', belowPct: 1, cuts: {} }] };

describe('a fixed restriction % for Priority users (engine 1.86.0)', () => {
	it('reads the share: 0 for none, for a Non-priority user and for a value that is not a share, with a warning', () => {
		const w: string[] = [];
		expect(userRestrictionShare({ kind: 'user', userRestrictionPct: 0.3 }, w)).toBe(0.3);
		expect(userRestrictionShare({ kind: 'user', userPriority: 'senior', userRestrictionPct: 1 }, w)).toBe(1);
		expect(userRestrictionShare({ kind: 'user', userRestrictionPct: null }, w)).toBe(0);
		expect(userRestrictionShare({ kind: 'user' }, w)).toBe(0);
		expect(userRestrictionShare({ kind: 'farm', userRestrictionPct: 0.3 }, w)).toBe(0);
		expect(w).toEqual([]);
		expect(userRestrictionShare({ kind: 'user', name: 'Mill', userPriority: 'junior', userRestrictionPct: 0.3 }, w)).toBe(0);
		expect(userRestrictionShare({ kind: 'user', name: 'Town', userRestrictionPct: 1.5 }, w)).toBe(0);
		expect(w).toHaveLength(2);
		expect(w[0]).toMatch(/Priority users only/);
	});

	it('cuts the user’s demand by its % while the rule’s level is in force, and the farm upstream passes the restricted claim', () => {
		const off = run(input({}, always));
		const on = run(input({ userRestrictionPct: 0.3 }, always));
		passed(off);
		passed(on);
		// Without the %: the user takes its 200, which A passes below its dam before filling it.
		expect(col(off, 'U', 'supplied')).toEqual([200, 200, 200, 200]);
		expect(col(off, 'A', 'senior_requirement')).toEqual([200, 200, 200, 200]);
		expect(col(off, 'U', RESTRICTION_SERIES.restricted.key)).toBeUndefined();
		// With 30 %: level 1 decided on day 0 (the dam half full) and held, so the user asks for 200 × 0.7 = 140 and
		// A passes 140; the demand and the deficit stay the unrestricted demand's.
		expect(col(on, 'U', RESTRICTION_SERIES.restricted.key)).toEqual([140, 140, 140, 140]);
		expect(col(on, 'U', 'supplied')).toEqual([140, 140, 140, 140]);
		expect(col(on, 'U', 'demand')).toEqual([200, 200, 200, 200]);
		expect(col(on, 'U', 'deficit')).toEqual([60, 60, 60, 60]);
		expect(col(on, 'A', 'senior_requirement')).toEqual([140, 140, 140, 140]);
		// The water the user didn't take stays in the river: A's full dam spills the 60 it no longer passes, and it
		// flows on below the user.
		expect(col(on, 'U', 'outflow')![0]! - col(off, 'U', 'outflow')![0]!).toBeCloseTo(60, 9);
		const s = on.summary.droughtRestriction!;
		expect(s.users).toEqual([{ nodeId: 'U', name: 'U', restrictionPct: 0.3, avgDemandM3Day: 200, avgRestrictedDemandM3Day: 140, avgSuppliedM3Day: 140, avgCutOnRestrictedDaysM3Day: 60, daysByLevel: [0, 4] }]);
		expect(s.units.map((u) => u.nodeId)).toEqual(['A']);
		expect(off.summary.droughtRestriction!.users).toBeUndefined();
	});

	it('without a rule the % cuts nothing in the run; a lifted level cuts nothing', () => {
		const noRule = run(input({ userRestrictionPct: 0.3 }, null));
		passed(noRule);
		expect(col(noRule, 'U', 'supplied')).toEqual([200, 200, 200, 200]);
		expect(col(noRule, 'U', RESTRICTION_SERIES.restricted.key)).toBeUndefined();
		// Lifted on 3 January: the user asks for its whole demand again.
		const lifted = run(input({ userRestrictionPct: 0.5 }, { ...always, liftDates: ['01-03'] }));
		passed(lifted);
		expect(col(lifted, 'U', RESTRICTION_SERIES.restricted.key)).toEqual([100, 100, 200, 200]);
		expect(col(lifted, 'U', 'supplied')).toEqual([100, 100, 200, 200]);
		expect(col(lifted, 'A', 'senior_requirement')).toEqual([100, 100, 200, 200]);
		expect(lifted.summary.droughtRestriction!.users![0]!.daysByLevel).toEqual([2, 2]);
	});

	it("under the 'own' basis a user has no dam to read: only the EWR trigger restricts it", () => {
		// A's own dam is half full: A is at level 1 from day 0. The EWR (10 million m³/day) fails every day, so the
		// review on 3 January (day 2) raises the user to the trigger's level 1; day 0 has no day before to read.
		const rule: DroughtRestrictionRule = { reviewDates: ['01-01', '01-03'], levels: [{ belowPct: 1, cuts: { crops: 0.2 } }], basis: 'own', ewrTrigger: { siteNodeId: null, level: 1 } };
		const out = run(input({ userRestrictionPct: 0.3 }, rule, 1e7));
		passed(out);
		expect(col(out, 'U', RESTRICTION_SERIES.restricted.key)).toEqual([200, 200, 140, 140]);
		expect(col(out, 'U', 'supplied')).toEqual([200, 200, 140, 140]);
		expect(out.summary.droughtRestriction!.users![0]!.daysByLevel).toEqual([2, 2]);
		// No level column on the user: it isn't a unit.
		expect(col(out, 'U', RESTRICTION_SERIES.level.key)).toBeUndefined();
		const noTrigger = run(input({ userRestrictionPct: 0.3 }, { ...rule, ewrTrigger: undefined }, 1e7));
		passed(noTrigger);
		expect(col(noTrigger, 'U', 'supplied')).toEqual([200, 200, 200, 200]);
	});

	it('a watch level (every cut 0 %) leaves the user’s demand whole; a deeper level that cuts some part of a unit’s demand applies the %', () => {
		// Engine-audit.md P2, decided 2026-10-12: the % applies only at a level that cuts some part of a unit's demand.
		for (const cuts of [{}, { crops: 0, domestic: 0, livestock: 0 }]) {
			const out = run(input({ userRestrictionPct: 0.3 }, { ...watch, levels: [{ label: 'Watch', belowPct: 1, cuts }] }));
			passed(out);
			// The level is in force all four days, and the user still asks for, takes and passes its whole demand.
			expect(col(out, null, RESTRICTION_SERIES.level.key)).toEqual([1, 1, 1, 1]);
			expect(col(out, 'U', RESTRICTION_SERIES.restricted.key)).toEqual([200, 200, 200, 200]);
			expect(col(out, 'U', 'supplied')).toEqual([200, 200, 200, 200]);
			expect(col(out, 'U', 'deficit')).toEqual([0, 0, 0, 0]);
			expect(col(out, 'A', 'senior_requirement')).toEqual([200, 200, 200, 200]);
			const u = out.summary.droughtRestriction!.users![0]!;
			expect(u).toMatchObject({ avgRestrictedDemandM3Day: 200, avgSuppliedM3Day: 200, avgCutOnRestrictedDaysM3Day: 0, daysByLevel: [0, 4] });
		}
		// A watch level above a level that cuts: the half-full dam (50 %) sits at the deeper level only once it falls
		// below 60 %; at 'Watch' (below 100 %) the user is whole, at 'Cut' (below 60 %) it asks for 200 × 0.7.
		const twoLevels = (pct: number) => {
			const x = input({ userRestrictionPct: 0.3 }, { reviewDates: ['01-01'], levels: [{ label: 'Watch', belowPct: 1, cuts: {} }, { label: 'Cut', belowPct: 0.6, cuts: { livestock: 0.1 } }] });
			x.model.nodes.find((n) => n.id === 'A')!.damInitialPct = pct;
			return run(x);
		};
		const atCut = twoLevels(0.5);
		passed(atCut);
		expect(col(atCut, null, RESTRICTION_SERIES.level.key)).toEqual([2, 2, 2, 2]);
		expect(col(atCut, 'U', RESTRICTION_SERIES.restricted.key)).toEqual([140, 140, 140, 140]);
		expect(col(atCut, 'A', 'senior_requirement')).toEqual([140, 140, 140, 140]);
		const atWatch = twoLevels(0.8);
		passed(atWatch);
		expect(col(atWatch, null, RESTRICTION_SERIES.level.key)).toEqual([1, 1, 1, 1]);
		expect(col(atWatch, 'U', RESTRICTION_SERIES.restricted.key)).toEqual([200, 200, 200, 200]);
		expect(col(atWatch, 'A', 'senior_requirement')).toEqual([200, 200, 200, 200]);
	});

	it('at a watch level the curtailment cut takes the user’s whole % (the rule took nothing of it)', () => {
		const out = run(input({ userRestrictionPct: 0.3 }, watch, 1500));
		passed(out);
		const row = out.summary.curtailment!.otherUsers!.find((u) => u.nodeId === 'U')!;
		expect(row).toMatchObject({ curtailed: true, restrictionPct: 0.3 });
		expect(row.supplyCutM3Day).toBeCloseTo(-60, 9);
	});

	it('a Non-priority user’s % is ignored, with a warning', () => {
		const out = run(input({ userPriority: 'junior', userRestrictionPct: 0.3 }, always));
		passed(out);
		expect(col(out, 'U', RESTRICTION_SERIES.restricted.key)).toBeUndefined();
		expect(out.summary.warnings.some((w) => /Priority users only/.test(w))).toBe(true);
	});

	it('in the curtailment table a Priority user is curtailed by at most its % of demand; the rest of its charge stands', () => {
		const ones = (v: number) => [v, v];
		const base = { name: 'Town', senior: true, demand: ones(100), supplied: ones(100), returned: ones(0), ewrCharge: ones(-50), consumptivePerSupplied: 1 };
		const window = { from: 0, to: 1, reportStart: '2021-01-01', reportEnd: '2021-01-02' };
		const [none, fixed, small, junior] = otherUserCurtailment(
			[
				{ ...base, nodeId: 'a' },
				{ ...base, nodeId: 'b', restrictionPct: 0.3 },
				{ ...base, nodeId: 'c', restrictionPct: 0.3, ewrCharge: ones(-10) },
				{ ...base, nodeId: 'd', senior: false, restrictionPct: 0.3 }
			],
			window
		);
		// No %: not curtailed, the whole charge stands (as before 1.86.0).
		expect(none).toMatchObject({ curtailed: false, supplyCutM3Day: 0, uncurtailedChargeM3Day: -50 });
		expect(none!.restrictionPct).toBeUndefined();
		// 30 % of 100: cut 30, 20 of the 50 stands (never moved onto the farms).
		expect(fixed).toMatchObject({ curtailed: true, supplyCutM3Day: -30, uncurtailedChargeM3Day: -20, restrictionPct: 0.3 });
		// A charge under the %: cut just the charge.
		expect(small).toMatchObject({ curtailed: true, supplyCutM3Day: -10, uncurtailedChargeM3Day: 0 });
		// A Non-priority user is curtailed for its whole charge; the % doesn't apply.
		expect(junior).toMatchObject({ curtailed: true, supplyCutM3Day: -50, uncurtailedChargeM3Day: 0 });
		expect(junior!.restrictionPct).toBeUndefined();
	});

	it('what the drought restriction rule took counts against the %: the two never cut more than c × H together', () => {
		const ones = (v: number) => [v, v];
		const base = { name: 'Town', senior: true, demand: ones(100), returned: ones(0), ewrCharge: ones(-30), consumptivePerSupplied: 1, restrictionPct: 0.2 };
		const window = { from: 0, to: 1, reportStart: '2021-01-01', reportEnd: '2021-01-02' };
		const [whole, half, control] = otherUserCurtailment(
			[
				// Restricted the whole window (D′ = 80): the rule took the whole 20 %, so the cut is 0 and it keeps 80, not 60.
				{ ...base, nodeId: 'a', supplied: ones(80), restrictedDemand: ones(80) },
				// Restricted one day of two: the rule took 10 of the 20, the cut takes the other 10.
				{ ...base, nodeId: 'b', supplied: [80, 100], restrictedDemand: [80, 100] },
				// Control, no rule: the cut is the full 20 %.
				{ ...base, nodeId: 'c', supplied: ones(100) }
			],
			window
		);
		expect(whole).toMatchObject({ curtailed: true, supplyCutM3Day: 0, uncurtailedChargeM3Day: -30, restrictionPct: 0.2 });
		expect(whole!.suppliedM3Day + whole!.supplyCutM3Day).toBe(80);
		expect(half).toMatchObject({ supplyCutM3Day: -10, uncurtailedChargeM3Day: -20 });
		expect(half!.suppliedM3Day + half!.supplyCutM3Day).toBe(80);
		expect(control).toMatchObject({ supplyCutM3Day: -20, uncurtailedChargeM3Day: -10 });
		expect(control!.suppliedM3Day + control!.supplyCutM3Day).toBe(80);
	});

	it('the curtailment table in a run carries the % and passes the self-check', () => {
		// An EWR of 1 500 m³/day at the outlet the 1 000 m³/day can't meet: the user is charged.
		const out = run(input({ userRestrictionPct: 0.25 }, null, 1500));
		passed(out);
		const row = out.summary.curtailment!.otherUsers!.find((u) => u.nodeId === 'U')!;
		expect(row.curtailed).toBe(true);
		expect(row.restrictionPct).toBe(0.25);
		expect(row.supplyCutM3Day).toBeCloseTo(-50, 9);
	});

	it('in a run with the rule, the curtailment cut takes only what of the % the rule left, and the self-check redoes it', () => {
		// Restricted all four days (D′ = 0.7 × 200 = 140): the rule took the whole 30 %, so the charged user isn't cut again.
		const out = run(input({ userRestrictionPct: 0.3 }, always, 1500));
		passed(out);
		const row = out.summary.curtailment!.otherUsers!.find((u) => u.nodeId === 'U')!;
		expect(row.ewrChargeM3Day).toBeLessThan(0);
		expect(row).toMatchObject({ curtailed: true, restrictionPct: 0.3, supplyCutM3Day: 0 });
		expect(row.uncurtailedChargeM3Day).toBe(row.ewrChargeM3Day);
	});

	describe('random networks', () => {
		/** The seeds whose networks have a Priority user. */
		const withUsers = (n: number) => {
			const out: number[] = [];
			for (let seed = 1; out.length < n && seed <= 400; seed++) if (randomInput(seed).model.nodes.some((x) => x.kind === 'user' && x.userPriority !== 'junior')) out.push(seed);
			return out;
		};
		const restricted = (seed: number) => {
			const x = randomInput(seed);
			x.settings.droughtRestriction = randomDroughtRestriction(new Rng(seed ^ 0x2a), x.model.nodes);
			const g = new Rng(seed ^ 0x5b3);
			for (const n of x.model.nodes) if (n.kind === 'user') n.userRestrictionPct = g.pick([g.float(0.01, 0.5), 1, g.frac()]);
			return x;
		};

		it('off by default: a % absent, null or 0 changes no series and no summary, to the bit', () => {
			for (const seed of withUsers(8)) {
				const base = restricted(seed);
				for (const n of base.model.nodes) delete n.userRestrictionPct;
				let off: ModelOutput;
				try {
					off = runModel(base);
				} catch {
					continue;
				}
				for (const v of [null, 0] as const) {
					const x = cloneInput(base);
					for (const n of x.model.nodes) n.userRestrictionPct = v;
					expect(sameOutput(runModel(x), off), `seed ${seed}: ${v}`).toBe(true);
				}
			}
		}, 120_000);

		it('every invariant holds with the % and a rule: the balance, the self-checks, order invariance, determinism; and a resumed run is the run', () => {
			const failures: string[] = [];
			let cut = 0;
			let ran = 0;
			for (const seed of withUsers(12)) {
				const x = restricted(seed);
				const bad = checkAll(x, seed);
				if (bad && !bad.startsWith('threw')) failures.push(`seed ${seed}: ${bad}`);
				if (bad) continue;
				ran++;
				const out = runModelWithoutChecks(x);
				const users = x.model.nodes.filter((n) => n.kind === 'user');
				if (users.some((u) => (col(out, u.id, RESTRICTION_SERIES.restricted.key) ?? []).some((v, t) => v < col(out, u.id, 'demand')![t]!))) cut++;
				const resumed = checkResume(x, Math.floor(out.days / 2), out);
				if (resumed) failures.push(`seed ${seed} resumed: ${resumed}`);
			}
			expect(failures).toEqual([]);
			expect(ran).toBeGreaterThan(6);
			expect(cut).toBeGreaterThan(1);
		}, 300_000);
	});
});
