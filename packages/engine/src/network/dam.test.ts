// Dam survey curves, releases, monthly lake factors and the seepage
// destination (WP-3.5, docs/model.md §2.7a): hand-worked cases on a fixed
// natural flow, the defaults leaving a run unchanged, and the invariants.
import { describe, expect, it } from 'vitest';
import type { Borehole, DamCurvePoint, ModelInput, NetworkNode, Transfer } from '../project';
import { runModelWith, withVerification } from '../run';
import { checkInvariants, checkTransferLimits } from '../verify/checks';
import { modelRuleProblems } from '../modelRules';
import { applyScenario } from '../scenario/overrides';
import { sameOutput } from '../testing/invariants';
import { curveAreaAt, resolveDamCurve, resolveRelease, seepageReturnOf } from './dam';
import { damCurveProblem } from './damCurve';

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
		pctUpstreamToDam: 1,
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

const flat = (v: number) => new Array(12).fill(v) as number[];

/** A synthetic survey: 100 000 m³ at 5 m, 30 000 m² full, a bowl that widens as it fills. */
const SURVEY: DamCurvePoint[] = [
	{ levelM: 100, areaM2: 0, volumeM3: 0 },
	{ levelM: 101, areaM2: 8_000, volumeM3: 4_000 },
	{ levelM: 102, areaM2: 14_000, volumeM3: 15_000 },
	{ levelM: 103, areaM2: 20_000, volumeM3: 32_000 },
	{ levelM: 104, areaM2: 25_000, volumeM3: 55_000 },
	{ levelM: 105, areaM2: 30_000, volumeM3: 100_000 }
];

/**
 * A run from 1 January of `days` dry days: an upstream farm U (runoff only,
 * no dam) drains into farm A, which has a 100 000 m³ dam taking all its
 * inflow, then the outlet gauge G. A needs `need` m³/day; the A-pan is a
 * Western Cape-like summer.
 */
function input(a: Partial<NetworkNode>, opts: { days?: number; need?: number; ewr?: number; settings?: ModelInput['settings'] } = {}): ModelInput {
	const days = opts.days ?? 60;
	// Oct–Sep A-pan (mm/month): a dry Mediterranean summer, ~9 mm/day in January.
	const apanMm = [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130];
	return {
		settings: {
			apanMm: apanMm as never,
			effectiveRainFraction: 0,
			ewrPragmaticM3PerDay: flat(opts.ewr ?? 0) as never,
			...(opts.settings ?? {})
		},
		model: {
			nodes: [
				node('G', 'gauge', null),
				node('A', 'farm', 'G', { damCapacityM3: 100_000, damInitialPct: 0.8, damAreaFullM2: 30_000, ...a }),
				node('U', 'farm', 'A', { pctUpstreamToDam: 0, pctRunoffToDam: 0 })
			],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			// The crop area sized so January's gross demand is `need` m³/day.
			cropAreas: opts.need ? [{ nodeId: 'A', cropId: 'c', areaM2: (opts.need * 31_000) / 285 }] : [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const passed = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);

describe('survey curve helpers', () => {
	it('interpolates area linearly in volume, anchored at an empty dam, flat above the top row', () => {
		const c = resolveDamCurve({ damCurve: SURVEY.slice(1).reverse() })!;
		// Rows are sorted and (0, 0) is added below the lowest one.
		expect(Array.from(c.volume)).toEqual([0, 4_000, 15_000, 32_000, 55_000, 100_000]);
		expect(curveAreaAt(c, 2_000)).toEqual({ area: 4_000, slope: 2 });
		expect(curveAreaAt(c, 15_000).area).toBe(14_000);
		expect(curveAreaAt(c, 77_500).area).toBe(27_500);
		expect(curveAreaAt(c, 120_000)).toEqual({ area: 30_000, slope: 0 });
	});

	it('rejects a curve that is too short, non-monotone or has no area', () => {
		expect(damCurveProblem(null)).toBeNull();
		expect(damCurveProblem([])).toBeNull();
		expect(damCurveProblem(SURVEY)).toBeNull();
		expect(damCurveProblem([SURVEY[1]!])).toMatch(/two rows/);
		expect(damCurveProblem([SURVEY[1]!, { ...SURVEY[2]!, volumeM3: 4_000 }])).toMatch(/same volume/);
		expect(damCurveProblem([SURVEY[1]!, { ...SURVEY[2]!, areaM2: 100 }])).toMatch(/area falls/);
		expect(damCurveProblem([SURVEY[1]!, { ...SURVEY[2]!, levelM: 50 }])).toMatch(/level falls/);
		expect(damCurveProblem([{ levelM: 0, areaM2: 0, volumeM3: 0 }, { levelM: 1, areaM2: 0, volumeM3: 5 }])).toMatch(/no surface area/);
		expect(damCurveProblem([SURVEY[1]!, { ...SURVEY[2]!, areaM2: Number.NaN }])).toMatch(/level, an area and a volume/);
		expect(resolveDamCurve({ damCurve: [SURVEY[1]!] })).toBeNull();
	});

	it('resolves release rules and the seepage share', () => {
		const w: string[] = [];
		const farm = node('A', 'farm', 'G', { damCapacityM3: 1000 });
		expect(resolveRelease(farm, w)).toBeNull();
		expect(resolveRelease({ ...farm, damReleaseRule: 'fixed' }, w)).toBeNull();
		expect(resolveRelease({ ...farm, damReleaseRule: 'passInflow' }, w)).toEqual({ rule: 1, m3DayByMonth: null, outletM3Day: Infinity });
		const fixed = resolveRelease({ ...farm, damReleaseRule: 'fixed', damReleaseM3Day: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], damOutletCapacityM3Day: 50 }, w)!;
		// Water-year month 0 is October (calendar 10), month 3 is January.
		expect(fixed.m3DayByMonth![10]).toBe(1);
		expect(fixed.m3DayByMonth![1]).toBe(4);
		expect(fixed.outletM3Day).toBe(50);
		// No dam, no release.
		expect(resolveRelease({ ...farm, damCapacityM3: 0, damReleaseRule: 'passInflow' }, w)).toBeNull();
		expect(w).toEqual([]);
		expect(seepageReturnOf({})).toBe(1);
		expect(seepageReturnOf({ damSeepageReturnPct: 0.25 })).toBe(0.25);
		expect(seepageReturnOf({ damSeepageReturnPct: 7 })).toBe(1);
	});
});

describe('dam storage (WP-3.5)', () => {
	const natural = Array.from({ length: 60 }, (_, t) => (t % 10 === 0 ? 4_000 : 300));

	it('the defaults, written out, run exactly as a node without the fields', () => {
		const bare = run(input({ damSeepagePerDay: 0.002 }, { need: 800, ewr: 200 }), natural);
		const explicit = run(
			input(
				{ damSeepagePerDay: 0.002, damCurve: null, damReleaseRule: 'none', damReleaseM3Day: null, damOutletCapacityM3Day: null, damSeepageReturnPct: 1 },
				{ need: 800, ewr: 200, settings: { lakeEvapFactorMonthly: null } }
			),
			natural
		);
		passed(bare);
		expect(sameOutput(bare, explicit)).toBe(true);
		expect(col(bare, 'A', 'dam_release')).toBeUndefined();
		expect(col(bare, 'A', 'dam_seepage_lost')).toBeUndefined();
		expect(bare.summary.waterBalance!.total.damSeepageLostM3).toBeUndefined();
		// Monthly factors all equal to the one factor are the one factor, to the bit.
		const monthly = run(input({ damSeepagePerDay: 0.002 }, { need: 800, ewr: 200, settings: { lakeEvapFactorMonthly: flat(0.75) as never } }), natural);
		expect(sameOutput(bare, monthly)).toBe(true);
	});

	it('a 100 000 m³ dam on a survey curve loses 150–240 m³/day to evaporation in a Western Cape-like summer (engine-audit N2)', () => {
		const o = run(input({ damCurve: SURVEY, damInitialPct: 1 }, { days: 31 }), new Array(31).fill(0));
		passed(o);
		const ev = col(o, 'A', 'dam_evaporation')!;
		// Day 1, full: 0.75 × 285 mm ÷ 31 days × 30 000 m² = 206.9 m³.
		expect(ev[0]).toBeCloseTo((0.75 * 285 * 30_000) / 31 / 1000, 9);
		const mean = sum(ev) / ev.length;
		expect(mean).toBeGreaterThan(150);
		expect(mean).toBeLessThan(240);
		// The area follows the curve, not the power law.
		const area = col(o, 'A', 'dam_area')!;
		const q = col(o, 'A', 'dam_storage')!;
		const c = resolveDamCurve({ damCurve: SURVEY })!;
		for (let t = 1; t < 31; t++) expect(area[t]).toBeCloseTo(curveAreaAt(c, q[t - 1]!).area, 6);
		expect(o.summary.warnings.join('\n')).not.toMatch(/no full-supply area/);
	});

	it('an unusable curve warns and runs on the power law', () => {
		const bad = run(input({ damCurve: [SURVEY[1]!] }), natural);
		const none = run(input({}), natural);
		passed(bad);
		expect(bad.summary.warnings.join('\n')).toMatch(/survey curve not used \(a survey curve needs at least two rows\)/);
		expect(col(bad, 'A', 'dam_area')).toEqual(col(none, 'A', 'dam_area'));
	});

	it('warns when the survey tops out more than 1 % away from the capacity', () => {
		const within = run(input({ damCurve: SURVEY, damCapacityM3: 100_900 }), natural);
		const off = run(input({ damCurve: SURVEY, damCapacityM3: 105_000 }), natural);
		passed(off);
		expect(within.summary.warnings.join('\n')).not.toMatch(/tops out/);
		expect(off.summary.warnings.join('\n')).toMatch(/farm "A": the dam survey curve tops out at 100000 m³ but the capacity is 105000 m³/);
	});

	it('the model rules refuse a curve the run could not use, or one on a node without a dam', () => {
		const m = input({ damCurve: [SURVEY[1]!, { ...SURVEY[2]!, areaM2: 1 }] }).model;
		expect(modelRuleProblems(m)).toEqual(['"A": dam survey curve: the survey area falls from 8000 to 1 m² as the volume rises']);
		const g = input({}).model;
		g.nodes[0]!.damCurve = SURVEY;
		expect(modelRuleProblems(g)).toEqual(['"G": dam survey curve: only a farm has a dam']);
		expect(modelRuleProblems(input({ damCurve: SURVEY }).model)).toEqual([]);
	});

	it('a scenario can add a dam with a survey curve and set its release rule, but not break the curve rule', () => {
		const base = input({});
		const dam = { ...node('N', 'farm', 'A', { damCapacityM3: 100_000, damCurve: SURVEY }), sortOrder: 5 };
		const ok = applyScenario(base, [
			{ op: 'node.add', node: dam },
			{ op: 'node.set', nodeId: 'A', field: 'damReleaseRule', value: 'passInflow' },
			{ op: 'node.set', nodeId: 'A', field: 'damSeepageReturnPct', value: 0.5 },
			{ op: 'settings.set', path: 'lakeEvapFactorMonthly', value: flat(0.8) }
		]);
		expect(ok.problems).toEqual([]);
		expect(ok.input.model.nodes.find((n) => n.id === 'N')!.damCurve).toEqual(SURVEY);
		const bad = applyScenario(base, [{ op: 'node.add', node: { ...dam, damCurve: [SURVEY[1]!] } }]);
		expect(bad.problems.join()).toMatch(/dam survey curve: a survey curve needs at least two rows/);
		const junk = applyScenario(base, [{ op: 'node.add', node: { ...dam, damCurve: 'steep' as never } }]);
		expect(junk.problems.join()).toMatch(/damCurve must be up to 200 rows/);
	});

	it('monthly lake factors move evaporation month by month', () => {
		const k = flat(0.75);
		k[3] = 1.0; // January
		const o = run(input({}, { days: 31, settings: { lakeEvapFactorMonthly: k as never } }), new Array(31).fill(0));
		const base = run(input({}, { days: 31 }), new Array(31).fill(0));
		passed(o);
		expect(col(o, 'A', 'dam_evaporation')![0]).toBeCloseTo((col(base, 'A', 'dam_evaporation')![0]! * 1.0) / 0.75, 9);
		// A bad row warns and falls back to the one factor.
		const bad = run(input({}, { days: 31, settings: { lakeEvapFactorMonthly: [1, 2] as never } }), new Array(31).fill(0));
		expect(bad.summary.warnings.join('\n')).toMatch(/monthly dam evaporation factors/);
		expect(sameOutput({ ...bad, summary: base.summary }, base)).toBe(true);
	});

	it('a larger lake factor never raises storage or supply', () => {
		let prevQ: number[] | null = null;
		let prevG: number[] | null = null;
		for (const f of [0, 0.5, 0.75, 1, 1.5]) {
			const o = run(input({ damCurve: SURVEY, damSeepagePerDay: 0.001 }, { need: 900, settings: { lakeEvapFactor: f } }), natural);
			passed(o);
			const q = col(o, 'A', 'dam_storage')!;
			const g = col(o, 'A', 'supplied')!;
			if (prevQ && prevG) for (let t = 0; t < q.length; t++) {
				expect(q[t]!).toBeLessThanOrEqual(prevQ[t]! + 1e-9);
				expect(g[t]!).toBeLessThanOrEqual(prevG[t]! + 1e-9);
			}
			prevQ = q;
			prevG = g;
		}
	});

	it('seepage is split into returned and lost, and the lost share leaves the balance', () => {
		const all = run(input({ damSeepagePerDay: 0.01 }), natural);
		const quarter = run(input({ damSeepagePerDay: 0.01, damSeepageReturnPct: 0.25 }), natural);
		passed(quarter);
		const sp = col(quarter, 'A', 'dam_seepage')!;
		const lost = col(quarter, 'A', 'dam_seepage_lost')!;
		for (let t = 0; t < sp.length; t++) expect(lost[t]).toBeCloseTo(sp[t]! * 0.75, 9);
		// The dam behaves the same; only the river below it loses the lost share.
		expect(col(quarter, 'A', 'dam_storage')).toEqual(col(all, 'A', 'dam_storage'));
		const uAll = col(all, 'A', 'outflow')!;
		const uQ = col(quarter, 'A', 'outflow')!;
		for (let t = 0; t < uAll.length; t++) expect(uQ[t]).toBeCloseTo(uAll[t]! - lost[t]!, 9);
		const wb = quarter.summary.waterBalance!.total;
		expect(wb.damSeepageLostM3).toBeCloseTo(sum(lost), 6);
		expect(Math.abs(wb.residualM3)).toBeLessThan(1e-6 * sum(natural));
		// Nothing lost: the catchment sees all of it.
		const none = run(input({ damSeepagePerDay: 0.01, damSeepageReturnPct: 0 }), natural);
		passed(none);
		expect(sum(col(none, 'A', 'dam_seepage_lost')!)).toBeCloseTo(sum(col(none, 'A', 'dam_seepage')!), 6);
	});

	it('a fixed release leaves the dam before irrigation, above dead storage and within the outlet', () => {
		const rel = flat(500);
		const o = run(input({ damReleaseRule: 'fixed', damReleaseM3Day: rel, damOutletCapacityM3Day: 400, damMinPct: 0.3, damInitialPct: 0.4 }, { need: 600, settings: { lakeEvapFactor: 0 } }), new Array(60).fill(0));
		passed(o);
		const x = col(o, 'A', 'dam_release')!;
		const q = col(o, 'A', 'dam_storage')!;
		const g = col(o, 'A', 'supplied')!;
		// The outlet caps 500 at 400 while the dam has water above dead storage (30 000 m³).
		expect(x[0]).toBe(400);
		for (let t = 0; t < x.length; t++) {
			expect(x[t]!).toBeLessThanOrEqual(400);
			expect(x[t]!).toBeGreaterThanOrEqual(0);
			// Neither release nor irrigation draws the dam below dead storage (no inflow, no rain, no evaporation: dead storage still evaporates).
			expect(q[t]!).toBeGreaterThanOrEqual(30_000 - 1e-6);
		}
		// Release comes first: once the dam is down to dead storage both stop, and on the way the release got its full 400 while irrigation took the rest.
		const last = x.findIndex((v) => v < 400);
		expect(last).toBeGreaterThan(0);
		expect(g[last - 1]).toBeGreaterThan(0);
		expect(x.at(-1)).toBe(0);
		expect(g.at(-1)).toBe(0);
	});

	it('a transfer into a full dam with a fixed release refills what it releases (engine 1.29.0)', () => {
		// U holds 50 000 m³ and sends to A (full, no demand, 400 m³/day fixed release) up to 864 m³/day.
		const i = input({ damInitialPct: 1, damReleaseRule: 'fixed', damReleaseM3Day: flat(400) }, { settings: { lakeEvapFactor: 0 } });
		i.model.nodes = i.model.nodes.map((n) => (n.id === 'U' ? { ...n, damCapacityM3: 50_000, damInitialPct: 1 } : n));
		i.model.transfers = [{ id: 't', fromNodeId: 'U', toNodeId: 'A', months: [1, 2, 3], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }];
		const o = run(i, new Array(60).fill(0));
		passed(o);
		const moved = col(o, 'A', 'transfer')!;
		const q = col(o, 'A', 'dam_storage')!;
		const spill = col(o, 'A', 'spill')!;
		for (let t = 0; t < moved.length; t++) {
			// The room is the release: 400 in, 400 out, the dam stays full and nothing spills.
			expect(moved[t]).toBeCloseTo(400, 9);
			expect(q[t]).toBeCloseTo(100_000, 6);
			expect(spill[t]).toBeCloseTo(0, 9);
		}
		// The check holds the engine to that room: one m³ more than the release fails it.
		const over = structuredClone(o);
		over.series.find((s) => s.nodeId === 'A' && s.key === 'transfer')!.values[3] = 401;
		over.series.find((s) => s.nodeId === 'U' && s.key === 'transfer')!.values[3] = -401;
		expect(checkTransferLimits(i, over)).toMatch(/received 401 > its room/);
		// Positive control: pass inflow (at most the inflow, which the room doesn't count) leaves the room at 0.
		const pass = run({ ...i, model: { ...i.model, nodes: i.model.nodes.map((n) => (n.id === 'A' ? { ...n, damReleaseRule: 'passInflow' as const } : n)) } }, new Array(60).fill(0));
		passed(pass);
		expect(sum(col(pass, 'A', 'transfer')!)).toBe(0);
	});

	it('a dam that also sends later the same day releases less than the floor only down to dead storage, and never overfills', () => {
		// A: full, fixed release 400, dead storage 0. U → A up to 300 m³/day at priority 0, then A → B uncapped at priority 1.
		const i = input({ damInitialPct: 1, damReleaseRule: 'fixed', damReleaseM3Day: flat(400) }, { settings: { lakeEvapFactor: 0 } });
		i.model.nodes = [
			...i.model.nodes.map((n) => (n.id === 'U' ? { ...n, damCapacityM3: 50_000, damInitialPct: 1 } : n)),
			node('B', 'farm', 'G', { damCapacityM3: 1_000_000, pctUpstreamToDam: 0, pctRunoffToDam: 0 })
		];
		const tr = { months: [1, 2, 3], minStoragePct: 0, enabled: true, dailyCapM3: null };
		i.model.transfers = [
			{ ...tr, id: 'u', fromNodeId: 'U', toNodeId: 'A', maxRateM3s: 300 / 86_400, priority: 0 },
			{ ...tr, id: 'b', fromNodeId: 'A', toNodeId: 'B', maxRateM3s: 1e3, priority: 1 }
		];
		const o = run(i, new Array(60).fill(0));
		passed(o);
		const q = col(o, 'A', 'dam_storage')!;
		const rel = col(o, 'A', 'dam_release')!;
		// Day 0: A takes 300 (its room counted the 400 floor), sends all it holds to B, and releases only the 300 left.
		expect(col(o, 'A', 'transfer')![0]).toBeCloseTo(300 - 100_000, 6);
		expect(rel[0]).toBeCloseTo(300, 6);
		expect(q[0]).toBeCloseTo(0, 6);
		for (const v of col(o, 'A', 'spill')!) expect(v).toBeCloseTo(0, 9);
	});

	it('pass inflow: the dam passes MIN(inflow, what the river below still needs, outlet), and fewer EWR days are missed', () => {
		const ewr = 500;
		const base = run(input({ damInitialPct: 0.1 }, { need: 300, ewr }), natural);
		const pass = run(input({ damInitialPct: 0.1, damReleaseRule: 'passInflow' }, { need: 300, ewr }), natural);
		const capped = run(input({ damInitialPct: 0.1, damReleaseRule: 'passInflow', damOutletCapacityM3Day: 100 }, { need: 300, ewr }), natural);
		for (const o of [base, pass, capped]) passed(o);
		const x = col(pass, 'A', 'dam_release')!;
		const z = col(pass, 'A', 'ewr_cumulative')!;
		const inflow = col(pass, 'A', 'inflow_upstream')!;
		const runoff = col(pass, 'A', 'runoff')!;
		for (let t = 0; t < x.length; t++) {
			// Everything enters the dam (S = 0), so the release is MIN(K + M, Z).
			expect(x[t]).toBeCloseTo(Math.min(inflow[t]! + runoff[t]!, z[t]!), 9);
			expect(col(capped, 'A', 'dam_release')![t]).toBeCloseTo(Math.min(inflow[t]! + runoff[t]!, z[t]!, 100), 9);
		}
		const notMet = (o: ReturnType<typeof run>) => col(o, 'A', 'ewr_shortfall')!.filter((v) => v < 0).length;
		expect(notMet(base)).toBeGreaterThan(0);
		expect(notMet(pass)).toBeLessThan(notMet(base));
		// A monthly amount replaces the EWR as the target.
		const fixedTarget = run(input({ damInitialPct: 0.1, damReleaseRule: 'passInflow', damReleaseM3Day: flat(50) }, { need: 300, ewr }), natural);
		passed(fixedTarget);
		for (const v of col(fixedTarget, 'A', 'dam_release')!) expect(v).toBeLessThanOrEqual(50);
		expect(fixedTarget.summary.waterBalance!.total.damReleaseM3).toBeCloseTo(sum(col(fixedTarget, 'A', 'dam_release')!), 6);
	});

	it('the self-checks catch a release that breaks its rule', () => {
		const i = input({ damReleaseRule: 'fixed', damReleaseM3Day: flat(100) }, { need: 300 });
		const o = runModelWith(i, () => ({ naturalFlowM3Day: natural }));
		expect(checkInvariants(i, o)).toBeNull();
		const x = o.series.find((s) => s.nodeId === 'A' && s.key === 'dam_release')!;
		x.values[5] = 150;
		expect(checkInvariants(i, o)).toMatch(/release|balance|outflow/);
	});
});

describe('transfer room (audit N4, issue #200)', () => {
	// W (a full 50 000 m³ dam, no demand) sends to A (full, needs 300 m³/day) up to 864 m³/day, no evaporation.
	const withTransfer = (a: Partial<NetworkNode> = {}, days = 30, need = 300): ModelInput => {
		const i = input({ damInitialPct: 1, ...a }, { need, days, settings: { lakeEvapFactor: 0 } });
		i.model.nodes = [...i.model.nodes, node('W', 'farm', 'G', { damCapacityM3: 50_000, damInitialPct: 1, pctUpstreamToDam: 0, pctRunoffToDam: 0 })];
		i.model.transfers = [{ id: 't', fromNodeId: 'W', toNodeId: 'A', months: [1, 2, 3, 9, 10, 11, 12], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }];
		return i;
	};
	const primary = (over: Partial<Borehole> = {}): Borehole => ({ id: 'b1', nodeId: 'A', name: 'BH1', capacityM3Day: 200, annualCapM3: 2_000, mode: 'primary', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0, ...over });
	/** Tamper with day t's transfer, W → A, and return what checkTransferLimits says. */
	const moved = (i: ModelInput, o: ReturnType<typeof run>, t: number, v: number) => {
		const x = structuredClone(o);
		x.series.find((s) => s.nodeId === 'A' && s.key === 'transfer')!.values[t] = v;
		x.series.find((s) => s.nodeId === 'W' && s.key === 'transfer')!.values[t] = -v;
		return checkTransferLimits(i, x);
	};

	it('a full dam with no other source takes back its demand, and nothing spills (positive control)', () => {
		const i = withTransfer();
		const o = run(i, new Array(30).fill(0));
		passed(o);
		const d = col(o, 'A', 'demand')!;
		const got = col(o, 'A', 'transfer')!;
		for (let t = 0; t < d.length; t++) {
			expect(d[t]).toBeGreaterThan(250);
			expect(got[t]).toBeCloseTo(d[t]!, 9);
		}
		for (const v of col(o, 'A', 'spill')!) expect(v).toBeCloseTo(0, 9);
	});

	it('a primary borehole: the room counts only the demand the dam meets, until its annual cap runs out', () => {
		const i = withTransfer();
		i.model.boreholes = [primary()];
		const o = run(i, new Array(30).fill(0));
		passed(o);
		const d = col(o, 'A', 'demand')!;
		const got = col(o, 'A', 'transfer')!;
		const gw = col(o, 'A', 'groundwater_used')!;
		for (let t = 0; t < d.length; t++) {
			// 200 a day for the first 10 days (2 000 m³ a year), then nothing: the dam meets the rest.
			expect(gw[t]).toBeCloseTo(t < 10 ? 200 : 0, 9);
			expect(got[t]).toBeCloseTo(d[t]! - gw[t]!, 9);
		}
		for (const v of col(o, 'A', 'spill')!) expect(v).toBeCloseTo(0, 9);
		// The old room (the full demand) sent the borehole's 200 too, and it spilled: the check now refuses it.
		expect(moved(i, o, 3, d[3]!)).toMatch(/received .* > its room/);
		expect(moved(i, o, 3, d[3]! - 200)).toBeNull();
	});

	it("the primary borehole's annual volume clears on 1 October before the transfers are settled, whatever the time zone (rule 7)", () => {
		const tz = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati';
		try {
			// A January need of 600 m³/day is ~280 in September and ~380 in October, above the borehole's 200.
			const i = withTransfer({}, 20, 600);
			i.series.rain_catchment_mm!.startDate = '2021-09-21';
			i.model.boreholes = [primary()];
			const o = run(i, new Array(20).fill(0));
			passed(o);
			const d = col(o, 'A', 'demand')!;
			const got = col(o, 'A', 'transfer')!;
			const gw = col(o, 'A', 'groundwater_used')!;
			// 21–30 September use the 2 000 m³; 1 October (day 10) pumps again, and the room already knows it.
			for (let t = 0; t < d.length; t++) expect(d[t]).toBeGreaterThan(200);
			expect(gw[9]).toBeCloseTo(200, 9);
			expect(gw[10]).toBeCloseTo(200, 9);
			for (let t = 0; t < d.length; t++) expect(got[t]).toBeCloseTo(d[t]! - gw[t]!, 9);
			for (const v of col(o, 'A', 'spill')!) expect(v).toBeCloseTo(0, 9);
		} finally {
			if (tz === undefined) delete process.env.TZ;
			else process.env.TZ = tz;
		}
	});

	it("an allocation cap: once the surface volume is used, the dam isn't drawn and the transfer stops", () => {
		const i = withTransfer();
		i.settings.allocationMode = 'cap';
		i.model.allocations = [{ id: 's', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 3_000 }];
		const o = run(i, new Array(30).fill(0));
		passed(o);
		const d = col(o, 'A', 'demand')!;
		const got = col(o, 'A', 'transfer')!;
		const room = col(o, 'A', 'allocation_room_surface')!;
		for (let t = 0; t < d.length; t++) expect(got[t]).toBeCloseTo(Math.min(d[t]!, room[t]!), 9);
		// Both sides of the cap are exercised: days with room for the whole demand, and days with none.
		expect(room.some((r, t) => r >= d[t]!)).toBe(true);
		const spent = room.findIndex((r) => r === 0);
		expect(spent).toBeGreaterThan(0);
		for (const v of col(o, 'A', 'spill')!) expect(v).toBeCloseTo(0, 9);
		expect(moved(i, o, spent, d[spent]!)).toMatch(/received .* > its room/);
	});

	it('river off-take water is still counted as unknown: it arrives after the transfers are settled (docs/model.md §2.6)', () => {
		// U's runoff reaches A both down the river (not into A's dam) and through a 300 m³/day off-take, used first.
		const i = withTransfer({ pctUpstreamToDam: 0, pctRunoffToDam: 0 });
		const ot: Transfer = { id: 'o', fromNodeId: 'U', toNodeId: 'A', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 300 / 86_400, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, source: 'river', handsOffM3Day: null, handsOffEwr: false, lossPct: 0, sizing: 'capacity', topUpDam: false };
		i.model.transfers = [...i.model.transfers, ot];
		const o = run(i, new Array(30).fill(5_000));
		passed(o);
		const d = col(o, 'A', 'demand')!;
		const used = col(o, 'A', 'offtake_used')!;
		const got = col(o, 'A', 'transfer')!;
		const spill = col(o, 'A', 'spill')!;
		// The off-take meets the whole demand, the transfer still brings it, and it spills the same day.
		for (let t = 0; t < d.length; t++) {
			expect(used[t]).toBeCloseTo(d[t]!, 9);
			expect(got[t]).toBeCloseTo(d[t]!, 9);
			expect(spill[t]).toBeCloseTo(d[t]!, 6);
		}
	});
});
