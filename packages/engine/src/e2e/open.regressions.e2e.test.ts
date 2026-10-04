// Open questions from round 1 of the engine end-to-end tests that were bugs
// (the engine contradicted docs/model.md or a physical invariant), fixed in
// engine 1.69.0. Each test asserts the correct behaviour; the comment above
// each names the doc section and the root cause it had.
// Invented catchments and values only.
import { describe, expect, it } from 'vitest';
import { compareAllocations } from '../allocations/compare';
import { calibrate } from '../calibrate/calibrate';
import { calibrationFitStatus, fitRecordFromReport } from '../calibrate/provenance';
import { resolveCalibrationRules } from '../calibrate/rulesSettings';
import { fromEpochDay, toEpochDay } from '../calendar';
import { mergeSettings } from '../prepare';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, RunSeries, Transfer } from '../project';
import type { EwrRuleTable } from '../reserve/rules';
import { runModel, runModelWith } from '../run';
import { ENGINE_VERSION } from '../version';

const flat = (v: number) => new Array(12).fill(v);
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
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
const gauge = (id = 'G', over: Partial<NetworkNode> = {}) => farm(id, { kind: 'gauge', downstreamNodeId: null, sortOrder: 99, ...over });
const town = (nodeId: string, m3Day: number): DemandObject => ({
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
const rule = (id: string, from: string, to: string, cap: number, over: Partial<Transfer> = {}): Transfer => ({
	id,
	fromNodeId: from,
	toNodeId: to,
	months: ALL,
	maxRateM3s: 1,
	dailyCapM3: cap,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	...over
});
function network(nodes: NetworkNode[], opts: { transfers?: Transfer[]; objects?: DemandObject[]; days: number; start?: string; settings?: Record<string, unknown> }): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0), apanMm: flat(0), ...opts.settings } as unknown as ModelInput['settings'],
		model: { nodes, crops: [], cropAreas: [], transfers: opts.transfers ?? [], demandObjects: opts.objects ?? [] },
		series: { rain_catchment_mm: { startDate: opts.start ?? '2021-01-01', values: new Array(opts.days).fill(0) } }
	};
}
const withFlow = (input: ModelInput, natural: number[]) => runModelWith(input, () => ({ naturalFlowM3Day: natural }));
const ser = (out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] | undefined => {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	return s ? Array.from(s.values) : undefined;
};
const get = (out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] => {
	const s = ser(out, nodeId, key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s;
};

// ── Item 2 ──────────────────────────────────────────────────────────────────
// §2.6a: a 'demand'-sized off-take takes need = D_dst + [topUpDam] room_dst.
// Dam transfers (§2.6) are settled before the river is routed, so the room the
// off-take sizes its top-up to is already known to be taken by them. The engine
// reads the room from yesterday's storage only (network/simulate.ts:1097,
// `need += Math.max(0, dstCap - (q + g.Pd - g.E - g.Sp))`), ignoring
// `jToday[o.to]`, so the off-take pulls river water into a dam the transfer
// has just filled and it spills straight back: the source reach loses flow
// for nothing. §2.6 lists only the reverse case (transfers not knowing today's
// river) as a known limitation, because the river isn't known when transfers
// settle; here the transfers ARE known.
// Fix: subtract today's net dam transfers into the destination from the room:
//   need += Math.max(0, dstCap - (q + g.Pd - g.E - g.Sp) - jToday[o.to]!)
describe('fixed in 1.69.0, item 2: a top-up off-take ignores the same day’s dam transfers into its destination (§2.6a)', () => {
	// S: river source (all the runoff). A: a full 10 000 m³ dam sending to D. D: a 1 000 m³ dam half full, no demand.
	const nodes = [gauge(), farm('S', { areaKm2: 1 }), farm('A', { damCapacityM3: 10_000, damInitialPct: 1 }), farm('D', { damCapacityM3: 1000, damInitialPct: 0.5 })];
	const offtake = rule('o', 'S', 'D', 5000, { source: 'river', sizing: 'demand', topUpDam: true, lossPct: 0, handsOffM3Day: null, handsOffEwr: false });
	const damRule = rule('a', 'A', 'D', 10_000);

	it('positive control: each alone fills D’s 500 m³ of room and nothing spills', () => {
		const onlyDam = withFlow(network(nodes, { transfers: [damRule], days: 2 }), [2000, 2000]);
		expect(get(onlyDam, 'A', 'transfer_rule@a')[0]).toBeCloseTo(500, 9);
		expect(get(onlyDam, 'D', 'spill')[0]).toBeCloseTo(0, 9);
		const onlyRiver = withFlow(network(nodes, { transfers: [offtake], days: 2 }), [2000, 2000]);
		expect(get(onlyRiver, 'S', 'transfer_rule@o')[0]).toBeCloseTo(500, 9);
		expect(get(onlyRiver, 'D', 'spill')[0]).toBeCloseTo(0, 9);
	});

	it('both: the dam transfer fills the room first, so the off-take takes nothing and the river passes S untouched', () => {
		const out = withFlow(network(nodes, { transfers: [damRule, offtake], days: 2 }), [2000, 2000]);
		expect(get(out, 'A', 'transfer_rule@a')[0]).toBeCloseTo(500, 9);
		// Today: the off-take takes 500 m³ and D spills 500 m³ the same day.
		expect(get(out, 'S', 'transfer_rule@o')[0]).toBeCloseTo(0, 9);
		expect(get(out, 'D', 'spill')[0]).toBeCloseTo(0, 9);
		expect(get(out, 'S', 'outflow')[0]).toBeCloseTo(2000, 9);
	});
});

// ── Item 3 ──────────────────────────────────────────────────────────────────
// A dam transfer from a unit to itself: the API refuses it on save
// (modelRules.ts:158 `trSelf`), and a river off-take from a unit to itself is
// skipped with a warning (network/offtake.ts:187), but buildNetworkPlan plans
// a dam rule A → A like any other (run.ts:1408–1434: no `from === to` check).
// It moves nothing (net 0), yet it publishes a phantom volume
// (transfer_rule@a) and takes a pro-rata share of the source's free water and
// of its own room, cutting a real rule from the same dam: here b moves 667 m³
// instead of 800, and A keeps 133 m³ more for its own demand.
// Fix: in run.ts buildNetworkPlan, after the unit-kind check (~line 1420):
//   if (from === to) { warnings.push(`transfer ${nodes[from]!.name} → itself: …; skipped`); continue; }
describe('fixed in 1.69.0, item 3: a dam transfer from a unit to itself runs silently (modelRules trSelf; off-takes skip it)', () => {
	const nodes = [gauge(), farm('A', { damCapacityM3: 1000, damInitialPct: 1 }), farm('B', { damCapacityM3: 1000, damInitialPct: 0 })];
	const objects = [town('A', 400)];

	it('positive control: the real rule alone moves its 800 m³ limit', () => {
		const out = withFlow(network(nodes, { transfers: [rule('b', 'A', 'B', 800)], objects, days: 1 }), [0]);
		expect(get(out, 'A', 'transfer_rule@b')[0]).toBeCloseTo(800, 9);
	});

	it('the self rule is skipped with a warning: no phantom volume, the real rule unchanged', () => {
		const out = withFlow(network(nodes, { transfers: [rule('a', 'A', 'A', 800), rule('b', 'A', 'B', 800)], objects, days: 1 }), [0]);
		expect(out.summary.warnings.some((w) => /Unit A/.test(w) && /itself/i.test(w))).toBe(true);
		expect(ser(out, 'A', 'transfer_rule@a') ?? [0]).toEqual([0]);
		expect(get(out, 'A', 'transfer_rule@b')[0]).toBeCloseTo(800, 9);
	});
});

// ── Item 5 ──────────────────────────────────────────────────────────────────
// §2.9d: high flows are judged "per complete water year (1 Oct … 30 Sep inside
// the run; a part year at either end is not assessed)". §2.4f (engine ≥
// 1.28.0) leaves out only the *month* a forecast tail starts inside, because
// the duration curves rank the history's complete months. assessSite builds
// `inRun` without that straddling month (reserve/assurance.ts:494) and passes
// it to the high flows too (reserve/assurance.ts:655), so completeWaterYears
// (reserve/assurance.ts:732) finds no 12 consecutive months and the whole
// water year disappears from highFlows[].years. A tail starting on the 1st
// keeps the year; one starting on the 15th drops it, though the year's
// November freshet is wholly historical. High flows count events day by day
// and never read the curves, so the straddling month needn't be dropped.
// Fix: reserve/assurance.ts:655 pass `completeMonths(startDate, days)` (the
// run's complete months, unfiltered) instead of `inRun` to assessHighFlow.
describe('fixed in 1.69.0, item 5: a high-flow year disappears when a forecast tail starts mid-month (§2.9d, §2.4f)', () => {
	const start = '2002-10-01';
	const days = toEpochDay('2004-09-30') - toEpochDay(start) + 1;
	const d0 = toEpochDay(start);
	// A November freshet each year: 20, 12, 8, 6 m³/s on a 1 m³/s base flow.
	const peak: Record<string, number> = { '11-10': 20, '11-11': 12, '11-12': 8, '11-13': 6 };
	const flow = Array.from({ length: days }, (_, t) => (peak[fromEpochDay(d0 + t).slice(5)] ?? 1) * 86_400);
	const rows = (r: number[]) => Array.from({ length: 12 }, () => [...r]);
	const table = {
		siteNodeId: null,
		source: 'Invented test table',
		component: 'total',
		unit: 'mcm',
		points: [10, 90],
		ewr: rows([0.1, 0.05]),
		naturalSource: 'table',
		natural: rows([2, 1]),
		scale: 1,
		highFlows: [{ label: 'November freshet', months: [11], peakM3s: 10, durationDays: 4, perYear: 1 }]
	} as unknown as EwrRuleTable;
	const years = (tail: string) => {
		const rec = toEpochDay(tail) - d0;
		const input: ModelInput = {
			settings: { ewrPragmaticM3PerDay: flat(0), apanMm: flat(0), ewrRules: [table] } as unknown as ModelInput['settings'],
			model: { nodes: [farm('A', { downstreamNodeId: 'Z', areaKm2: 1 }), gauge('Z')], crops: [], cropAreas: [], transfers: [] },
			series: { rain_catchment_mm: { startDate: start, values: new Array(rec).fill(1) }, rain_forecast_mm: { startDate: tail, values: new Array(days - rec).fill(1) } }
		};
		return withFlow(input, flow).summary.ewrAssurance![0]!.highFlows![0]!.years.map((y) => [y.waterYear, y.natural, y.actual, y.met]);
	};

	it('positive control: a tail from 1 July 2004 keeps both water years', () => {
		expect(years('2004-07-01')).toEqual([
			[2002, 1, 1, true],
			[2003, 1, 1, true]
		]);
	});

	it('a tail from 15 July 2004 keeps 2003/04 too (its freshet, in November 2003, is historical)', () => {
		expect(years('2004-07-15')).toEqual([
			[2002, 1, 1, true],
			[2003, 1, 1, true]
		]);
	});
});

// ── Item 6 ──────────────────────────────────────────────────────────────────
// allocations/compare.ts documents the storage comparison as "`none` when the
// run models no dam capacity for the node" (compare.ts:155) and "No modelled
// dam (a water user, or a farm without one) is no comparison, not a dam of
// 0 m³" (compare.ts:330), but it tests only `capacity === null`
// (compare.ts:319/331). The backend's comparison passes every farm's
// `damCapacityM3`, 0 included (backend/src/allocations/runUse.ts:50), so a
// farm with no dam but registered storage reads 'under' (a dam smaller than
// registered) with a −50 000 m³ difference.
// Fix: compare.ts:319
//   const capacity = n.kind === 'farm' && (n.damCapacityM3 ?? 0) > 0 ? n.damCapacityM3! : null;
// (If the hydrologist wants "registered dam not modelled" surfaced, give it its own status
// rather than 'under'; see the report.)
describe('fixed in 1.69.0, item 6: a farm without a dam but with registered storage reads storage status “under”', () => {
	it('the storage comparison of a farm with no dam is “none”, as compare.ts documents', () => {
		const days = 365;
		const input = network([gauge(), farm('F', { areaKm2: 1 })], { objects: [town('F', 100)], days, start: '2021-10-01' });
		input.model.allocations = [{ id: 'L1', nodeId: 'F', waterSource: 'surface', volumeM3PerYear: 36_500, storageM3: 50_000 }];
		const out = withFlow(input, new Array(days).fill(5000));
		const f = input.model.nodes[1]!;
		// As the backend's run comparison builds it (runUse.ts): the run's series and the node's dam capacity.
		const cmp = compareAllocations({
			startDate: '2021-10-01',
			allocations: input.model.allocations,
			nodes: [{ nodeId: 'F', name: f.name, kind: 'farm', supplied: get(out, 'F', 'supplied'), groundwater: null, damCapacityM3: f.damCapacityM3 }]
		});
		expect(cmp.nodes[0]!.storage.registeredM3).toBe(50_000);
		expect(cmp.nodes[0]!.storage.status).toBe('none');
	});
});

// ── Item 8 ──────────────────────────────────────────────────────────────────
// §2.10 "In-sample or not": fitStatus is `fitted` only with "the same
// calibration window and exclusions" as the fit; §2.10j's exclusion rule
// leaves its years out of every fit "on top of settings.calibrationExclusions".
// calibrate() records every exclusion it ran with in report.exclusions
// (calibrate.ts:250), but fitRecordFromReport stores only the settings' list
// (calibrate/provenance.ts:421), so the record claims the stored exclusions,
// calibrationFitStatus (provenance.ts:818) sees no change and a run labels as
// in-sample a year the fit never saw. (Automated calibration's rule
// exclusions sit in record.auto.ruleExclusions, which the status never reads.)
// Fix: provenance.ts:421 record the exclusions the fit actually ran with
// beyond the stored ones (e.g. `extraExclusions` from report.exclusions minus the
// settings' ranges, or auto.ruleExclusions), and have calibrationFitStatus
// return 'otherPeriod' while the settings don't exclude them too.
describe('fixed in 1.69.0, item 8: a run scoring years an automated fit left out read as in-sample (§2.10, §2.10j)', () => {
	it('a run scoring a water year the fit left out is not labelled in-sample', () => {
		const start = '2014-10-01';
		const days = 1826;
		const node = (id: string, over: Partial<NetworkNode>) => farm(id, { downstreamNodeId: null, ...over });
		const rain = Array.from({ length: days }, (_, t) => ((t * 7919) % 13 === 0 ? 25 : t % 9 === 0 ? 6 : 0));
		const obs = Array.from({ length: days }, (_, t) => 0.2 + 0.1 * Math.sin(t / 40) + ((t * 7919) % 13 === 1 ? 1 : 0));
		const input: ModelInput = {
			settings: { runoffModel: 'gr4j', apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100], gr4j: { warmupDays: 365 } } as unknown as ModelInput['settings'],
			model: { nodes: [node('G', { kind: 'gauge' }), node('F', { downstreamNodeId: 'G', areaKm2: 50 })], crops: [], cropAreas: [], transfers: [] },
			series: { rain_catchment_mm: { startDate: start, values: rain }, flow_observed_m3s: { startDate: start, values: obs } }
		};
		// As automated calibration does (calibrate/auto.ts runAutoCase): a rule's year passed as an extra exclusion.
		const report = calibrate(input, { model: 'gr4j', budget: 60, starts: 1, seed: 1, validate: false, exclusions: [{ start: '2016-10-01', end: '2017-09-30' }] });
		expect(report.exclusions).toEqual([{ start: '2016-10-01', end: '2017-09-30' }]);
		const settings = mergeSettings(input.settings, []);
		// The automated fit's record names the year its rule left out (FitRecord.auto.ruleExclusions, §2.10j).
		const auto = { rules: resolveCalibrationRules(undefined, []), ruleExclusions: [{ waterYear: 2016, reason: 'Rule (calibration rules, exclusions): invented' }], chosen: 0, cases: [] };
		const record = fitRecordFromReport(report, { settings, validate: false, validationRecord: null, engineVersion: ENGINE_VERSION, fittedAt: '2026-10-02T00:00:00.000Z', auto });
		const applied = { ...input.settings, gr4j: { ...settings.gr4j, ...report.params }, fitRecord: record } as unknown as ModelInput['settings'];
		const out: ModelOutput = runModel({ ...input, settings: applied });
		// The run scores 2016/17 (the settings don't exclude it), which the fit never saw.
		expect(out.summary.calibration?.fitStatus).toBe('otherPeriod');
		expect(calibrationFitStatus(applied, 'flow_observed_m3s')).toBe('otherPeriod');
		// Positive control: with the year excluded in the settings too, the run's statistics are the fit's own days.
		const excluded = { ...applied, calibrationExclusions: [{ waterYear: 2016, reason: 'invented' }] } as unknown as ModelInput['settings'];
		expect(calibrationFitStatus(excluded, 'flow_observed_m3s')).not.toBe('otherPeriod');
	});
});

// ── Item 9 ──────────────────────────────────────────────────────────────────
// The API refuses node fractions outside 0–1 (backend/src/model/validate.ts:5
// `frac`, migration 001 CHECKs, scenario/ops.ts:246), but the engine takes them
// as given (run.ts:1552–1556). A dam entered in percent (damInitialPct: 20 for
// 20 %) starts at 20 × its capacity and spills 19 × capacity on day 1: water
// that never existed, with every self-check passing (the initial storage is
// taken as given). pctRunoffToDam: 80 is clamped to 100 % silently
// (network/simulate.ts:1214 MIN(I × pct, I)). §2.2 "Settings out of range"
// (engine ≥ 1.69.0) already holds *settings* to the API's ranges with a
// warning "so an input saved some other way can't run nonsense"; node fields
// have no such guard.
// Fix: in run.ts buildNetworkPlan (~line 1545), clamp each node fraction
// (pctUpstreamToDam, pctRunoffToDam, damInitialPct, damMinPct, flowShareManual,
// returnFlowFraction) to [0, 1] with a warning naming the unit and field, as
// §2.2 does for settings; and extend §2.2 to say so.
describe('fixed in 1.69.0, item 9: percent-style dam fractions ran as given, creating water', () => {
	const run = (pct: number, init: number) => {
		const input = network([farm('F', { areaKm2: 1, damCapacityM3: 10_000, damInitialPct: init, pctRunoffToDam: pct }), gauge()], { days: 3 });
		return withFlow(input, [1000, 1000, 1000]);
	};

	it('positive control: fractions 0.8 and 0.2 fill the dam from 2 000 m³ with 800 m³ a day, no spill', () => {
		const out = run(0.8, 0.2);
		expect(get(out, 'F', 'dam_storage')).toEqual([2800, 3600, 4400]);
		expect(get(out, 'F', 'spill')).toEqual([0, 0, 0]);
	});

	it('80 or 20 (percent) is refused, naming the unit and the field (engine ≥ 1.69.0), as the API refuses it', () => {
		// Before: storage started at 200 000 m³ in a 10 000 m³ dam and spilled 191 000 m³ on day 1.
		expect(() => run(0.8, 20)).toThrow(/unit "Unit F": damInitialPct is 20, not a share from 0 to 1/);
		expect(() => run(80, 0.2)).toThrow(/unit "Unit F": pctRunoffToDam is 80, not a share from 0 to 1/);
	});
});
