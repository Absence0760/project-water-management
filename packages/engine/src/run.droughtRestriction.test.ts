// The drought restriction rule (engine 1.46.0, WP-3.8, docs/model.md §2.7i):
// on each review date the level is decided from the farm dams' storage at the
// start of the day, as a share of their capacity, and each part of every
// unit's demand is cut by the level's share until the next review or lift
// date; a domestic or municipal object never goes below its basic-needs
// floor. Off by default: every run without the rule is what it was. Hand
// examples worked in the comments; random networks for the invariants.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { diffInputs, type RunInputsSnapshot } from './compare';
import { droughtRestrictionIssues, levelCut, restrictedObjectDemand, restrictionLevelFor, RESTRICTION_SERIES } from './network/restriction';
import type { CropArea, CropDef, DemandObject, DroughtRestrictionRule, ModelInput, ModelOutput, NetworkNode, RunSeries } from './project';
import { captureModelState, runModel, runModelFrom, runModelWith, runModelWithoutChecks, withVerification } from './run';
import { applyScenario, classifyOp, validateScenarioOps } from './scenario';
import { cloneInput, randomDroughtRestriction, randomInput, Rng } from './testing/fuzz';
import { checkForecastPrefix, withForecastTail } from './testing/forecastInvariants';
import { checkAll, sameOutput } from './testing/invariants';
import { checkDroughtRestriction, checkInvariants } from './verify/checks';
import { ENGINE_VERSION } from './version';

const flat = (v: number) => new Array(12).fill(v);

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 1,
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

// 1 000 people at 230 l a day: 230 m³/day, a basic-needs floor of 25 m³/day.
const village = (over: Partial<DemandObject> = {}): DemandObject => ({
	id: 'village',
	nodeId: 'A',
	name: 'Village',
	category: 'domestic',
	sizing: 'perUnit',
	monthlyM3Day: null,
	count: 1000,
	litresPerUnitDay: 230,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

/**
 * Unit A with a 1 000 m³ dam, full on 1 October 2020, no inflow, no dam
 * losses; its crop needs 100 m³/day in October (1 000 m² × A-pan 3 100 mm ÷ 31
 * days, crop factor 1, efficiency 1). It drains to gauge G. Ten days.
 */
function model(rule: DroughtRestrictionRule | null | undefined, over: { objects?: DemandObject[]; initialPct?: number; days?: number } = {}): ModelInput {
	const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: flat(1) }];
	const cropAreas: CropArea[] = [{ nodeId: 'A', cropId: 'c', areaM2: 1000 }];
	const days = over.days ?? 10;
	return {
		settings: {
			ewrPragmaticM3PerDay: flat(0) as unknown as Monthly,
			apanMm: flat(3100) as unknown as Monthly,
			lakeEvapFactor: 0,
			effectiveRainStoreMm: 0,
			...(rule !== undefined ? { droughtRestriction: rule } : {})
		},
		model: {
			nodes: [node('A', { downstreamNodeId: 'G', damCapacityM3: 1000, damInitialPct: over.initialPct ?? 1 }), node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 1 })],
			crops,
			cropAreas,
			transfers: [],
			...(over.objects ? { demandObjects: over.objects } : {})
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: new Array(days).fill(0) } }
	};
}

const run = (input: ModelInput) => withVerification(input, runModelWith(input, (ctx) => ({ naturalFlowM3Day: new Array(ctx.days).fill(0) })));
function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const passed = (out: ModelOutput) => expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);

// Reviewed on 5 October: below 70 % of capacity the crops are cut by half.
const halfBelow70: DroughtRestrictionRule = { reviewDates: ['10-05'], levels: [{ label: 'Level 1', belowPct: 0.7, cuts: { crops: 0.5 } }] };

describe('the drought restriction rule (engine 1.46.0)', () => {
	it('is engine 1.46.0 or later', () => {
		const [maj, min] = ENGINE_VERSION.split('.').map(Number);
		expect(maj! > 1 || (maj === 1 && min! >= 46)).toBe(true);
	});

	it('picks the deepest level whose threshold the storage share is below', () => {
		const t = [0.7, 0.4, 0.2];
		expect([1, 0.7, 0.69, 0.4, 0.39, 0.2, 0.1, 0].map((s) => restrictionLevelFor(s, t))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
		// A cut that leaves a town under its floor keeps MIN(floor, demand); without a cut the demand, to the bit.
		expect(restrictedObjectDemand(230, 1, 25)).toBe(25);
		expect(restrictedObjectDemand(20, 1, 25)).toBe(20);
		expect(restrictedObjectDemand(230, 0.5, 25)).toBe(115);
		expect(restrictedObjectDemand(0.1 + 0.2, 0, 25)).toBe(0.1 + 0.2);
		expect(restrictedObjectDemand(230, 0.5, null)).toBe(115);
	});

	describe('the hand example: a dam emptying at 100 m³/day, reviewed on 5 October', () => {
		const out = run(model(halfBelow70));
		it('decides on the review date from the storage at the start of the day, and holds it', () => {
			// Day 0 (1 October): the latest date before it is last year's review, so it is decided: full, level 0.
			// Days 0–3 take 100 each: 1 000 → 600. Day 4 (5 October) starts at 600, 60 % < 70 %: level 1 from then on.
			expect(get(out, null, RESTRICTION_SERIES.level.key)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
			expect(get(out, null, 'restriction_cut@crops')).toEqual([0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
			expect(get(out, 'A', RESTRICTION_SERIES.restricted.key)).toEqual([100, 100, 100, 100, 50, 50, 50, 50, 50, 50]);
			expect(get(out, 'A', 'supplied')).toEqual([100, 100, 100, 100, 50, 50, 50, 50, 50, 50]);
			expect(get(out, 'A', 'dam_storage')).toEqual([900, 800, 700, 600, 550, 500, 450, 400, 350, 300]);
			// The demand and the deficit stay the unrestricted demand's: the cut shows as a shortfall.
			expect(get(out, 'A', 'demand')).toEqual(new Array(10).fill(100));
			expect(get(out, 'A', 'deficit')).toEqual([0, 0, 0, 0, 50, 50, 50, 50, 50, 50]);
			passed(out);
		});
		it('reports the days per level, per water year and over the run, and each unit’s mean demands', () => {
			const s = out.summary.droughtRestriction!;
			expect(s.daysByLevel).toEqual([4, 6]);
			expect(s.years).toEqual([{ waterYear: 2020, days: 10, daysByLevel: [4, 6] }]);
			expect(s.reviews).toBe(2);
			// The cut on restricted days only: 50 a day, where the run mean (100 − 70) dilutes it to 30.
			expect(s.units).toEqual([{ nodeId: 'A', name: 'A', avgDemandM3Day: 100, avgRestrictedDemandM3Day: 70, avgSuppliedM3Day: 70, avgCutOnRestrictedDaysM3Day: 50 }]);
			expect(s.rule).toEqual(halfBelow70);
		});
		it('adds no column for a part no level cuts, and none on the gauge', () => {
			expect(out.series.filter((x) => x.key.startsWith(RESTRICTION_SERIES.cutPrefix)).map((x) => x.key)).toEqual(['restriction_cut@crops']);
			expect(out.series.some((x) => x.nodeId === 'G' && x.key === RESTRICTION_SERIES.restricted.key)).toBe(false);
		});
	});

	it('ends on a lift date, and a run that starts after a lift starts unrestricted whatever the storage', () => {
		// Lifted on 8 October (day 7): back to 100 a day from then.
		const lifted = run(model({ ...halfBelow70, liftDates: ['10-08'] }));
		expect(get(lifted, null, RESTRICTION_SERIES.level.key)).toEqual([0, 0, 0, 0, 1, 1, 1, 0, 0, 0]);
		expect(get(lifted, 'A', 'supplied')).toEqual([100, 100, 100, 100, 50, 50, 50, 100, 100, 100]);
		passed(lifted);
		// Half full from the start (50 % < 70 %), but the latest date before 1 October is a lift (30 September):
		// no level until the review on 5 October, which starts at 500 − 4 × 100 = 100 (10 %).
		const late = run(model({ ...halfBelow70, liftDates: ['09-30'] }, { initialPct: 0.5 }));
		expect(get(late, null, RESTRICTION_SERIES.level.key)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
		expect(late.summary.droughtRestriction!.reviews).toBe(1);
		passed(late);
		// Without the lift the first day is decided from the starting storage: 50 %, level 1 from day 0.
		const early = run(model(halfBelow70, { initialPct: 0.5 }));
		expect(get(early, null, RESTRICTION_SERIES.level.key)).toEqual(new Array(10).fill(1));
		expect(get(early, 'A', 'supplied').slice(0, 2)).toEqual([50, 50]);
		passed(early);
	});

	it('reads the storage at the start of the review day, never later: a review on 3 October sees 800 m³', () => {
		// Day 2 (3 October) starts at 800 (80 %) and ends at 700 (70 %). With a 75 % threshold the start of the day
		// gives no level (80 % isn't below 75 %), where the end of it would give level 1; with 85 %, level 1.
		const r = run(model({ reviewDates: ['10-03'], levels: [{ belowPct: 0.75, cuts: { crops: 0.5 } }] }));
		expect(get(r, null, RESTRICTION_SERIES.level.key)).toEqual(new Array(10).fill(0));
		const r2 = run(model({ reviewDates: ['10-03'], levels: [{ belowPct: 0.85, cuts: { crops: 0.5 } }] }));
		expect(get(r2, null, RESTRICTION_SERIES.level.key)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
		passed(r2);
	});

	it('never cuts a town below its basic-needs floor, and cuts each part by its own share', () => {
		// Two levels: below 70 % the crops lose half and the village 20 %; below 50 % the crops and the village everything.
		const rule: DroughtRestrictionRule = {
			reviewDates: ['10-01', '10-04', '10-07'],
			levels: [
				{ belowPct: 0.7, cuts: { crops: 0.5, domestic: 0.2 } },
				{ belowPct: 0.5, cuts: { crops: 1, domestic: 1 } }
			]
		};
		// 10 000 m³ dam at 60 %: 6 000. Day 0 (1 October) review: 60 % → level 1: crops 50, village 230 × 0.8 = 184.
		const input = model(rule, { objects: [village()], initialPct: 0.6 });
		input.model.nodes[0]!.damCapacityM3 = 10_000;
		const out = run(input);
		const lv = get(out, null, RESTRICTION_SERIES.level.key);
		expect(lv.slice(0, 3)).toEqual([1, 1, 1]);
		expect(get(out, 'A', RESTRICTION_SERIES.restricted.key)[0]).toBeCloseTo(50 + 184, 9);
		// Days 0–2 take 234 each: 6 000 → 5 298 (52.98 %): level 1 again on 4 October; then → 4 596 (45.96 %) on 7 October: level 2.
		expect(lv).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
		// Level 2 cuts the crops to nothing and the village to its floor, 25 m³/day, not 0.
		expect(get(out, 'A', RESTRICTION_SERIES.restricted.key)[6]).toBeCloseTo(25, 9);
		expect(get(out, 'A', 'object_supplied@village')[6]).toBeCloseTo(25, 9);
		expect(get(out, null, 'restriction_cut@domestic')[6]).toBe(1);
		passed(out);
	});

	describe('off by default', () => {
		it('a rule absent, null or cutting nothing changes no series and no summary, to the bit, on random networks', () => {
			for (let seed = 1; seed <= 12; seed++) {
				const base = randomInput(seed);
				base.settings.droughtRestriction = undefined;
				delete base.settings.droughtRestriction;
				let off: ModelOutput;
				try {
					off = runModel(base);
				} catch {
					continue;
				}
				expect(off.series.some((x) => x.key === RESTRICTION_SERIES.level.key || x.key === RESTRICTION_SERIES.restricted.key), `seed ${seed}`).toBe(false);
				expect(off.summary.droughtRestriction, `seed ${seed}`).toBeUndefined();
				const withNull = cloneInput(base);
				withNull.settings.droughtRestriction = null;
				expect(sameOutput(runModel(withNull), off), `seed ${seed}: null`).toBe(true);
				// A rule whose levels cut nothing: in force, but every other series and summary figure unchanged to the bit.
				const noCut = cloneInput(base);
				noCut.settings.droughtRestriction = { reviewDates: ['10-01', '04-01'], levels: [{ belowPct: 1, cuts: {} }] };
				const on = runModel(noCut);
				const extra = new Set<string>([RESTRICTION_SERIES.level.key, RESTRICTION_SERIES.restricted.key]);
				const kept = on.series.filter((x) => !extra.has(x.key));
				expect(kept.length, `seed ${seed}`).toBe(off.series.length);
				kept.forEach((x, i) => {
					const y = off.series[i]!;
					expect(`${x.nodeId}|${x.key}`).toBe(`${y.nodeId}|${y.key}`);
					for (let t = 0; t < x.values.length; t++) if (!Object.is(x.values[t], y.values[t])) throw new Error(`seed ${seed}: ${x.nodeId}|${x.key}[${t}] ${x.values[t]} vs ${y.values[t]}`);
				});
				const { droughtRestriction: _r, verification: _v, ...rest } = on.summary;
				const { verification: _w, ...restOff } = off.summary;
				expect(JSON.stringify(rest), `seed ${seed}`).toBe(JSON.stringify(restOff));
			}
		}, 120_000);
	});

	describe('random networks with a rule', () => {
		const withRule = (seed: number) => {
			const x = randomInput(seed);
			x.settings.droughtRestriction = randomDroughtRestriction(new Rng(seed ^ 0x2a));
			return x;
		};
		it('every invariant holds: the balance, the self-checks (the level, the cuts, the floor, supply within the restricted demand), order invariance, determinism', () => {
			const failures: string[] = [];
			let ran = 0;
			let restricted = 0;
			for (let seed = 1; seed <= 25 && failures.length < 3; seed++) {
				const x = withRule(seed);
				const bad = checkAll(x, seed);
				if (bad && !bad.startsWith('threw')) failures.push(`seed ${seed}: ${bad}`);
				if (bad) continue;
				ran++;
				// The seeds do restrict: some day at a level that cuts something.
				const out = runModelWithoutChecks(x);
				const cuts = out.series.filter((c) => c.key.startsWith(RESTRICTION_SERIES.cutPrefix));
				if (cuts.some((c) => c.values.some((v) => v > 0))) restricted++;
			}
			expect(failures).toEqual([]);
			expect(ran).toBeGreaterThan(10);
			expect(restricted).toBeGreaterThan(5);
		}, 300_000);
		it('is causal: a forecast tail changes no level (or anything else) on the historical days', () => {
			const failures: string[] = [];
			for (let seed = 1; seed <= 12; seed++) {
				const bad = checkForecastPrefix(withForecastTail(withRule(seed), seed));
				if (bad) failures.push(`seed ${seed}: ${bad}`);
			}
			expect(failures).toEqual([]);
		}, 120_000);
		it('is causal: a run cut short has the full run’s levels on its days', () => {
			for (let seed = 1; seed <= 12; seed++) {
				const x = withRule(seed);
				let full: ModelOutput;
				try {
					full = runModelWithoutChecks(x);
				} catch {
					continue;
				}
				if (full.days < 20) continue;
				const short = cloneInput(x);
				const end = new Date(Date.parse(full.startDate) + (Math.floor(full.days / 2) - 1) * 86_400_000).toISOString().slice(0, 10);
				short.settings.simulationStart = full.startDate;
				short.settings.simulationEnd = end;
				const part = runModelWithoutChecks(short);
				const a = get(full, null, RESTRICTION_SERIES.level.key);
				expect(get(part, null, RESTRICTION_SERIES.level.key), `seed ${seed}`).toEqual(a.slice(0, part.days));
			}
		}, 120_000);
		it('a run resumed from a snapshot keeps the level held since the last review', () => {
			const input = model(halfBelow70);
			const full = runModelWithoutChecks(input);
			// 7 October: level 1, decided on the 5th, isn't a review day: the snapshot must carry it.
			const snap = captureModelState(input, '2020-10-07');
			const tail = runModelFrom(snap, input);
			expect(get(tail, null, RESTRICTION_SERIES.level.key)).toEqual(get(full, null, RESTRICTION_SERIES.level.key).slice(6));
			expect(get(tail, 'A', 'supplied')).toEqual(get(full, 'A', 'supplied').slice(6));
			// From the run's first day: no level held yet, so the resumed run decides it as the capture run did.
			const first = runModelFrom(captureModelState(input, '2020-10-01'), input);
			expect(get(first, null, RESTRICTION_SERIES.level.key)).toEqual(get(full, null, RESTRICTION_SERIES.level.key));
		});
	});

	describe('the self-check', () => {
		const input = model(halfBelow70);
		const out = run(input);
		const tamper = (key: string, nodeId: string | null, t: number, v: number): ModelOutput => ({
			...out,
			series: out.series.map((x) => (x.nodeId === nodeId && x.key === key ? { ...x, values: x.values.map((y, i) => (i === t ? v : y)) } : x))
		});
		it('passes the run, and is in checkInvariants', () => {
			expect(checkDroughtRestriction(input, out)).toBeNull();
			expect(checkInvariants(input, out)).toBeNull();
			expect(out.summary.verification!.checks.find((c) => c.id === 'droughtRestriction')?.passed).toBe(true);
		});
		it('catches a level its review didn’t decide, a cut that isn’t the level’s and a restricted demand that isn’t the cut', () => {
			expect(checkDroughtRestriction(input, tamper(RESTRICTION_SERIES.level.key, null, 3, 1))).toMatch(/day 3: drought restriction level 1 ≠ 0/);
			expect(checkDroughtRestriction(input, tamper('restriction_cut@crops', null, 5, 0.4))).toMatch(/restriction_cut@crops 0\.4 ≠ level 1's cut 0\.5/);
			expect(checkDroughtRestriction(input, tamper(RESTRICTION_SERIES.restricted.key, 'A', 5, 60))).toMatch(/A day 5: restricted demand 60 ≠ 50/);
			expect(checkDroughtRestriction(input, tamper('supplied', 'A', 5, 55))).toMatch(/never raises supply/);
			// The check works the dates out itself: a rule whose review moved a day doesn't match the run's levels.
			const moved = { ...input, settings: { ...input.settings, droughtRestriction: { ...halfBelow70, reviewDates: ['10-06'] } } };
			expect(checkDroughtRestriction(moved, out)).toMatch(/day 4: drought restriction level 1 ≠ 0/);
		});
		it('refuses restriction columns without the rule', () => {
			const off = { ...input, settings: { ...input.settings, droughtRestriction: null } };
			expect(checkDroughtRestriction(off, out)).toMatch(/without a drought restriction rule/);
		});
	});

	describe('the rule’s own checks (the save, the scenario op and the form)', () => {
		it('accepts a good rule and names every problem of a bad one', () => {
			expect(droughtRestrictionIssues(halfBelow70)).toEqual([]);
			expect(droughtRestrictionIssues({ reviewDates: ['01-01'], liftDates: ['05-01'], levels: [{ belowPct: 1, cuts: {} }], source: 'WUA decision' })).toEqual([]);
			const msgs = (v: unknown) => droughtRestrictionIssues(v).map((i) => `${i.field}: ${i.message}`);
			expect(msgs(null)[0]).toMatch(/must be a rule/);
			expect(msgs({ reviewDates: [], levels: [] }).join('\n')).toMatch(/at least one review date[\s\S]*at least one level/);
			expect(msgs({ reviewDates: ['02-29'], levels: [{ belowPct: 0.5, cuts: {} }] })[0]).toMatch(/29 February/);
			expect(msgs({ reviewDates: ['01-01', '01-01'], levels: [{ belowPct: 0.5, cuts: {} }] })[0]).toMatch(/listed twice/);
			expect(msgs({ reviewDates: ['01-01'], liftDates: ['01-01'], levels: [{ belowPct: 0.5, cuts: {} }] })[0]).toMatch(/both a review date and a lift date/);
			expect(msgs({ reviewDates: ['01-01'], levels: [{ belowPct: 0, cuts: {} }] })[0]).toMatch(/above 0 and at most 1/);
			expect(msgs({ reviewDates: ['01-01'], levels: [{ belowPct: 0.5, cuts: {} }, { belowPct: 0.6, cuts: {} }] })[0]).toMatch(/must start below level 1's 50 %/);
			expect(msgs({ reviewDates: ['01-01'], levels: [{ belowPct: 0.5, cuts: { crops: 0.4 } }, { belowPct: 0.3, cuts: { crops: 0.2 } }] })[0]).toMatch(/cuts crops less than level 1/);
			expect(msgs({ reviewDates: ['01-01'], levels: [{ belowPct: 0.5, cuts: { crops: 0.4 } }, { belowPct: 0.3, cuts: {} }] })[0]).toMatch(/doesn't cut crops, which level 1 does/);
			expect(msgs({ reviewDates: ['01-01'], levels: [{ belowPct: 0.5, cuts: { trees: 0.4 } }] })[0]).toMatch(/"trees" is not a part of demand/);
			expect(msgs({ reviewDates: ['01-01'], levels: [{ belowPct: 0.5, cuts: { crops: 1.2 } }] })[0]).toMatch(/from 0 to 1/);
		});
		it('a run with a rule it can’t use runs without it and says why', () => {
			const out = run(model({ reviewDates: ['13-01'], levels: [{ belowPct: 0.5, cuts: {} }] }));
			expect(out.summary.warnings.join('\n')).toMatch(/drought restriction rule is not applied: reviewDates\[0\]/);
			expect(out.summary.droughtRestriction).toBeUndefined();
		});
		it('cuts by level and part', () => {
			expect(levelCut(halfBelow70, 0, 'crops')).toBe(0);
			expect(levelCut(halfBelow70, 1, 'crops')).toBe(0.5);
			expect(levelCut(halfBelow70, 1, 'domestic')).toBe(0);
		});
	});

	describe('as a scenario op and in the run comparison', () => {
		const base = model(null);
		it('settings.set droughtRestriction sets or clears the rule, is checked like a save, and is a baseline assumption', () => {
			const on = applyScenario(base, [{ op: 'settings.set', path: 'droughtRestriction', value: halfBelow70 }]);
			expect(on.problems).toEqual([]);
			expect(on.input.settings.droughtRestriction).toEqual(halfBelow70);
			expect(base.settings.droughtRestriction).toBeNull();
			const off = applyScenario(on.input, [{ op: 'settings.set', path: 'droughtRestriction', value: null }]);
			expect(off.input.settings.droughtRestriction).toBeNull();
			// Off over no rule changes nothing: no key written, no problem.
			const none = { ...base, settings: { ...base.settings } };
			delete none.settings.droughtRestriction;
			const same = applyScenario(none, [{ op: 'settings.set', path: 'droughtRestriction', value: null }]);
			expect(same.problems).toEqual([]);
			expect('droughtRestriction' in same.input.settings).toBe(false);
			const bad = applyScenario(base, [{ op: 'settings.set', path: 'droughtRestriction', value: { reviewDates: [], levels: [] } as unknown as DroughtRestrictionRule }]);
			expect(bad.problems[0]).toMatch(/droughtRestriction reviewDates needs at least one review date/);
			expect(validateScenarioOps([{ op: 'settings.set', path: 'droughtRestriction', value: halfBelow70 }]).errors).toEqual([]);
			expect(classifyOp({ op: 'settings.set', path: 'droughtRestriction', value: halfBelow70 }, ['A'], base)).toBe('baseline');
		});
		it('the run comparison lists what changed in the rule', () => {
			const snap = (rule: DroughtRestrictionRule | null): RunInputsSnapshot => ({ settings: { droughtRestriction: rule }, model: base.model, series: {} });
			const text = (a: DroughtRestrictionRule | null, b: DroughtRestrictionRule | null) => diffInputs(snap(a), snap(b)).filter((c) => c.subject === 'Drought restriction rule').map((c) => c.text);
			expect(text(null, null)).toEqual([]);
			expect(text(null, halfBelow70)).toEqual(['Drought restriction rule: off → reviewed 5 Oct; Level 1 (below 70 %): crops 50 %']);
			const deeper: DroughtRestrictionRule = { reviewDates: ['10-05', '01-01'], liftDates: ['05-01'], levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.5, municipal: 0.1 } }, { belowPct: 0.3, cuts: { crops: 1, municipal: 0.3 } }] };
			expect(text(halfBelow70, deeper)).toEqual([
				'Drought restriction rule: review dates 5 Oct → 1 Jan, 5 Oct',
				'Drought restriction rule: lift dates none → 1 May',
				'Drought restriction rule: level 1 starts below 70 % → 60 %',
				'Drought restriction rule: level 1 cut on municipal (town) demand objects 0 % → 10 %',
				'Drought restriction rule: added Level 2 (below 30 %): crops 100 %, municipal (town) demand objects 30 %'
			]);
			expect(text(deeper, null)[0]).toMatch(/^Drought restriction rule: reviewed 5 Oct, 1 Jan, lifted 1 May; .* → off$/);
		});
	});
});
