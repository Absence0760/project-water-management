// The EWR split between the units (engine ≥ 1.94.0, issue #553, settings.ewrSplit,
// ./network/ewrSplit.ts, docs/model.md §2.5b): the flow share (the default, to the
// bit as before) or each unit's natural MAR under runoff from each unit's own rain,
// over the run's complete water years; units sharing a station; the fallbacks; and
// that everything reading the split EWR (an EWR site's requirement, its shortfall,
// the charge) follows it.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { toEpochDay } from './calendar';
import { stationSeriesKey, UNIT_RAIN_SERIES, type ModelInput, type NetworkNode, type ProjectSettings } from './project';
import { runModel } from './run';
import { ewrSplitDays, ewrSplitNote, fillPlanEwrShares, naturalMarShares, resolveEwrSplit } from './network/ewrSplit';
import { checkEwrSplit } from './verify/checks';
import { checkAll, sameOutput } from './testing/invariants';
import { checkResume } from './testing/warmstartInvariants';
import { checkForecastPrefix, withForecastTail } from './testing/forecastInvariants';
import { applyScenario } from './scenario/overrides';
import { prepareCalibration } from './calibrate/calibrate';
import { prepareRun } from './prepare';
import { buildNetworkPlan } from './run';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const START = '2015-01-01';
const D0 = toEpochDay(START);
const DAYS = toEpochDay('2021-01-01') - D0; // six calendar years: water years 2015/16 … 2019/20 complete
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));

const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
const unit = (id: string, areaKm2: number, mapMm: number, downstreamNodeId = 'G'): NetworkNode => ({ ...node, id, name: `Unit ${id}`, kind: 'farm', downstreamNodeId, areaKm2, mapMm, mapSource: 'invented' }) as NetworkNode;

/**
 * Units A (10 km², MAP 900) above G1, an EWR site, above the outlet G, with B (6, 600), C (3, 750) and D (1.5, 600)
 * straight into G. A and B share station S (MAP 600); C and D take their §2.4h rule. A irrigates, so G1 can fall short.
 */
function catchment(settings: Partial<ProjectSettings> = {}, perUnit = true): ModelInput {
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: apan as never,
			ewrPragmaticM3PerDay: Array(12).fill(25_000) as never,
			...(perUnit ? { unitRain: { mode: 'perUnit' }, rainStations: { units: { A: { stationId: 'S' }, B: { stationId: 'S' } }, sites: { S: { unitId: 'A' } } } } : {}),
			...settings
		},
		model: {
			nodes: [
				{ ...node, id: 'G', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 } as NetworkNode,
				{ ...node, id: 'G1', name: 'Gauge 1', kind: 'gauge', downstreamNodeId: 'G', areaKm2: 0 } as NetworkNode,
				unit('A', 10, 900, 'G1'),
				unit('B', 6, 600),
				unit('C', 3, 750),
				unit('D', 1.5, 600)
			],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 400_000 }],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: rainOf(1) },
			rain_chirps_mm: { startDate: START, values: rainOf(0.7, 2) },
			'rain_chirps_mm@A': { startDate: START, values: rainOf(0.8, 1) },
			'rain_chirps_mm@B': { startDate: START, values: rainOf(0.5, 3) },
			[stationSeriesKey('S')]: { startDate: START, values: rainOf(1.6, 1) }
		},
		stations: { S: { name: 'Station S', mapMm: 600, mapSource: 'invented', lat: null, lon: null } }
	};
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;
const farm = (out: Out, id: string) => out.summary.farms.find((f) => f.nodeId === id)!;
const UNITS = ['A', 'B', 'C', 'D'];

describe('the split helpers', () => {
	it('the period: the complete water years of the historical days, else every historical day', () => {
		// 2015-01-01 … 2020-12-31: 2015/16 … 2019/20.
		expect(ewrSplitDays(D0, DAYS)).toEqual({ from: toEpochDay('2015-10-01') - D0, to: toEpochDay('2020-10-01') - D0, waterYears: 5 });
		// A run that starts on 1 October and ends on 30 September is all complete years.
		const oct = toEpochDay('2015-10-01');
		expect(ewrSplitDays(oct, toEpochDay('2017-10-01') - oct)).toEqual({ from: 0, to: toEpochDay('2017-10-01') - oct, waterYears: 2 });
		// No complete water year (and no dates): the whole historical run.
		expect(ewrSplitDays(D0, 400)).toEqual({ from: 0, to: 400, waterYears: 0 });
		expect(ewrSplitDays(undefined, 400)).toEqual({ from: 0, to: 400, waterYears: 0 });
		// A forecast tail's days are never in it: only historyDays are.
		expect(ewrSplitDays(D0, toEpochDay('2016-10-01') - D0)).toEqual({ from: toEpochDay('2015-10-01') - D0, to: toEpochDay('2016-10-01') - D0, waterYears: 1 });
	});

	it('the shares: each unit’s runoff over the period ÷ the total, the same in any order; none without runoff', () => {
		const a = { nodeId: 'a', runoffM3Day: [100, 1, 1, 100] };
		const b = { nodeId: 'b', runoffM3Day: [100, 3, -5, 100] };
		const s = naturalMarShares([b, a], 1, 3)!;
		// Over days 1–2: a 2, b 3 (its negative day counts 0).
		expect(s.get('a')).toBe(2 / 5);
		expect(s.get('b')).toBe(3 / 5);
		expect([...naturalMarShares([a, b], 0, 4)!]).toEqual([...naturalMarShares([b, a], 0, 4)!]);
		expect(naturalMarShares([{ nodeId: 'a', runoffM3Day: [0, 0] }], 0, 2)).toBeNull();
		// No runoff clears the plan's shares, so the flow share splits the EWR.
		const nodes: { ewrShare?: number }[] = [{ ewrShare: 0.3 }];
		expect(fillPlanEwrShares(nodes, { days: { from: 0, to: 2 }, farms: [{ index: 0, nodeId: 'a', runoff: [0, 0] }] })).toBeNull();
		expect(nodes[0]).toEqual({});
	});

	it('an unknown value splits by the flow share, with a warning', () => {
		const w: string[] = [];
		expect(resolveEwrSplit(undefined, w)).toBe('flowShare');
		expect(resolveEwrSplit('naturalMar', w)).toBe('naturalMar');
		expect(w).toEqual([]);
		expect(resolveEwrSplit('byArea', w)).toBe('flowShare');
		expect(w).toEqual(['unknown EWR split "byArea"; splitting the EWR by the flow share']);
	});
});

describe('the flow share (the default)', () => {
	it('every unit’s EWR is the EWR × its flow share, to the bit, with the setting absent or set, per unit and fragmented', () => {
		for (const perUnit of [true, false]) {
			const absent = runModel(catchment({}, perUnit));
			const set = runModel(catchment({ ewrSplit: 'flowShare' }, perUnit));
			expect(sameOutput(absent, set), `perUnit ${perUnit}`).toBe(true);
			const ewr = col(absent, 'ewr')!;
			for (const id of UNITS) {
				const f = farm(absent, id);
				expect(f.ewrShare).toBe(f.flowShare);
				const y = col(absent, 'ewr', id)!;
				for (let t = 0; t < absent.days; t++) expect(y[t]).toBe(ewr[t]! * f.flowShare!);
			}
			expect(absent.summary.ewrSplit).toEqual({ method: 'flowShare', applied: 'flowShare' });
			expect(absent.summary.warnings.some((w) => w.includes('natural MAR'))).toBe(false);
			expect(checkEwrSplit(catchment({}, perUnit), absent)).toBeNull();
		}
	});

	it('under Fragmentation the natural MAR split is the flow share: the same run, with a note', () => {
		const flow = runModel(catchment({}, false));
		const mar = runModel(catchment({ ewrSplit: 'naturalMar' }, false));
		for (const s of flow.series) expect(col(mar, s.key, s.nodeId), `${s.nodeId}/${s.key}`).toEqual(s.values);
		expect(mar.summary.ewrSplit).toEqual({ method: 'naturalMar', applied: 'flowShare', why: 'catchmentRain' });
		expect(mar.summary.warnings).toContain(ewrSplitNote(mar.summary.ewrSplit!));
		for (const id of UNITS) expect(farm(mar, id).ewrShare).toBe(farm(flow, id).flowShare);
	});
});

describe('each unit’s natural MAR (per unit)', () => {
	const input = () => catchment({ ewrSplit: 'naturalMar' });

	it('splits the EWR by each unit’s own natural runoff over the complete water years, adding up to 1', () => {
		const out = runModel(input());
		expect(out.summary.ewrSplit).toEqual({ method: 'naturalMar', applied: 'naturalMar', period: { start: '2015-10-01', end: '2020-09-30', waterYears: 5 } });
		const from = toEpochDay('2015-10-01') - D0;
		const to = toEpochDay('2020-10-01') - D0;
		const vol = new Map(UNITS.map((id) => [id, col(out, UNIT_RAIN_SERIES.runoff.key, id)!.slice(from, to).reduce((s, v) => s + v, 0)]));
		const total = [...vol.values()].reduce((s, v) => s + v, 0);
		let sum = 0;
		for (const id of UNITS) {
			const f = farm(out, id);
			expect(f.ewrShare).toBeCloseTo(vol.get(id)! / total, 12);
			sum += f.ewrShare!;
			// Recorded beside the flow share, which still splits nothing else here.
			expect(f.flowShare).toBeCloseTo(({ A: 10, B: 6, C: 3, D: 1.5 } as Record<string, number>)[id]! / 20.5, 12);
		}
		expect(sum).toBeCloseTo(1, 12);
		// A's MAP is the highest, so its share of the runoff (and now of the EWR) is above its share of the area.
		expect(farm(out, 'A').ewrShare!).toBeGreaterThan(farm(out, 'A').flowShare!);
		expect(out.summary.warnings.find((w) => w.startsWith('the EWR is split between the units by each unit’s natural MAR over the 5 complete water years 1 Oct 2015 – 30 Sep 2020'))).toBeDefined();
		expect(checkEwrSplit(input(), out)).toBeNull();
	});

	it('two units sharing a station each take their own runoff’s share', () => {
		const out = runModel(input());
		const a = farm(out, 'A');
		const b = farm(out, 'B');
		// A and B both read station S, scaled to their MAPs (900 and 600) over their areas (10 and 6 km²): the shares differ.
		expect(a.ewrShare).not.toBe(b.ewrShare);
		const from = toEpochDay('2015-10-01') - D0;
		const to = toEpochDay('2020-10-01') - D0;
		const vol = (id: string) => col(out, UNIT_RAIN_SERIES.runoff.key, id)!.slice(from, to).reduce((s, v) => s + v, 0);
		expect(a.ewrShare! / b.ewrShare!).toBeCloseTo(vol('A') / vol('B'), 10);
	});

	it('everything reading the split EWR follows it: a gauge site’s requirement and shortfall, and the charge', () => {
		const flow = runModel(catchment());
		const mar = runModel(input());
		const ewr = col(mar, 'ewr')!;
		// G1's requirement is A's EWR share alone.
		for (const [out, k] of [
			[flow, farm(flow, 'A').flowShare!],
			[mar, farm(mar, 'A').ewrShare!]
		] as const) {
			const z = col(out, 'ewr_cumulative', 'G1')!;
			for (let t = 0; t < out.days; t++) expect(z[t]).toBe(ewr[t]! * k);
		}
		expect(col(mar, 'ewr_cumulative', 'G1')![400]).toBeGreaterThan(col(flow, 'ewr_cumulative', 'G1')![400]!);
		// A larger requirement at G1: more days short there, and the attribution splits each larger shortfall.
		const short = (out: Out) => col(out, 'ewr_shortfall', 'G1')!.filter((v) => v < 0).length;
		expect(short(mar)).toBeGreaterThan(short(flow));
		const sum = (v: ArrayLike<number>) => Array.from(v).reduce((s, x) => s + x, 0);
		for (const out of [flow, mar]) expect(sum(col(out, 'ewr_charged', 'G1')!) + sum(col(out, 'ewr_natural', 'G1')!)).toBeCloseTo(sum(col(out, 'ewr_shortfall', 'G1')!), 0);
		expect(sum(col(mar, 'ewr_shortfall', 'G1')!)).toBeLessThan(sum(col(flow, 'ewr_shortfall', 'G1')!));
		// The outlet's requirement is the whole EWR either way (the shares add up to 1 here), so its days are the same.
		expect(mar.summary.catchment.ewrDaysNotMet).toBe(flow.summary.catchment.ewrDaysNotMet);
	});

	it('holds every invariant, and a resumed run and a forecast tail keep the historical split', () => {
		expect(checkAll(input())).toBeNull();
		for (const k of [0, 400, 1500]) expect(checkResume(input(), k), `resume at ${k}`).toBeNull();
		expect(checkForecastPrefix(withForecastTail(input(), 7))).toBeNull();
	});

	it('a hands-off EWR flow keeps the unit’s split requirement: the river pump leaves more under the larger share', () => {
		const withPump = (x: ModelInput): ModelInput => {
			const a = x.model.nodes.find((n) => n.id === 'A')!;
			Object.assign(a, { damCapacityM3: 50_000, damInitialPct: 0.5, pctRunoffToDam: 0.5, supplyRule: 'riverFirst', pumpCapacityM3Day: 1e6, handsOffEwr: true });
			return x;
		};
		const flow = runModel(withPump(catchment()));
		const mar = runModel(withPump(input()));
		const take = (out: Out) => col(out, 'river_abstraction', 'A')!.reduce((s, v) => s + v, 0);
		expect(farm(mar, 'A').ewrShare!).toBeGreaterThan(farm(flow, 'A').ewrShare!);
		expect(take(mar)).toBeLessThan(take(flow));
		expect(checkAll(withPump(input()))).toBeNull();
	});

	it('calibration refills each candidate’s shares from its own runoff, so a scored day is runModel’s to the bit', () => {
		const x = input();
		const a = x.model.nodes.find((n) => n.id === 'A')!;
		Object.assign(a, { damCapacityM3: 50_000, damInitialPct: 0.5, pctRunoffToDam: 0.5, supplyRule: 'riverFirst', pumpCapacityM3Day: 1e6, handsOffEwr: true });
		x.series.flow_observed_m3s = { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) };
		const pb = prepareCalibration(x);
		for (const p of [pb.startParams, { ...pb.startParams, x1: (pb.startParams as { x1: number }).x1 * 1.6, x3: (pb.startParams as { x3: number }).x3 * 0.5 }]) {
			const want = runModel({ ...x, settings: { ...x.settings, gr4j: { ...(x.settings.gr4j ?? {}), ...p } as never } }).series.find((s) => s.nodeId === null && s.key === 'simulated_outflow')!.values;
			const got = pb.simulate(p);
			for (const t of pb.scoredDays) expect(got[t], `day ${t}`).toBe(want[t]);
		}
	});

	it('with no runoff over the period the flow share splits the EWR; a snapshot pins that, and a resume without a pin keeps the flow share', () => {
		// The plan as calibration first builds it, on units that made no runoff (GR4J always makes some from its stores).
		const x = input();
		const prep = prepareRun(x);
		const zeros = () => ['A', 'B', 'C', 'D'].map((nodeId) => ({ nodeId, runoffM3Day: new Float64Array(prep.days) }));
		const plan = (warm: Parameters<typeof buildNetworkPlan>[8] = {}) =>
			buildNetworkPlan(x, prep.settings, prep.days, prep.month, prep.aligned, new Float64Array(prep.days), [], prep.start, { unitRunoff: zeros(), ...warm }, prep.days);
		const fresh = plan();
		expect(fresh.ewrSplit.info).toEqual({ method: 'naturalMar', applied: 'flowShare', why: 'noRunoff' });
		expect(fresh.ewrSplit.pin).toEqual({ period: { start: '2015-10-01', end: '2020-09-30', waterYears: 5 }, shares: [] });
		expect(fresh.plan.nodes.some((n) => n.ewrShare !== undefined)).toBe(false);
		// Resumed from that snapshot: the flow share, marked pinned, even if its own days had runoff.
		const resumed = plan({ ewrSplit: fresh.ewrSplit.pin! });
		expect(resumed.ewrSplit.info).toEqual({ method: 'naturalMar', applied: 'flowShare', why: 'noRunoff', pinned: true });
		// Resumed from a snapshot that pinned nothing: the flow share, never shares worked out on the resumed days alone.
		expect(plan({ ewrSplit: null }).ewrSplit.info).toEqual({ method: 'naturalMar', applied: 'flowShare', why: 'resumed' });
		expect(ewrSplitNote({ method: 'naturalMar', applied: 'flowShare', why: 'resumed' })).toMatch(/resumes from a snapshot/);
	});

	it('a scenario can switch the split, and an unknown method is a problem, not a throw', () => {
		const base = catchment();
		const sc = applyScenario(base, [{ op: 'settings.set', path: 'ewrSplit', value: 'naturalMar' }]);
		expect(sc.problems).toEqual([]);
		expect(runModel(sc.input).summary.ewrSplit?.applied).toBe('naturalMar');
		const bad = applyScenario(base, [{ op: 'settings.set', path: 'ewrSplit', value: 'mar' as never }]);
		expect(bad.problems).toHaveLength(1);
		expect(bad.input.settings.ewrSplit).toBeUndefined();
	});

	it('the invariant check catches a share, a day, a sum, a period or a method that isn’t the run’s', () => {
		const x = input();
		const out = runModel(x);
		const broken = (edit: (o: Out) => void) => {
			const o = structuredClone(out);
			edit(o);
			return checkEwrSplit(x, o);
		};
		expect(checkEwrSplit(x, out)).toBeNull();
		expect(broken((o) => (o.summary.farms.find((f) => f.nodeId === 'A')!.ewrShare! *= 1.01))).toMatch(/A day 0: EWR share/);
		expect(
			broken((o) => {
				const y = o.series.find((s) => s.nodeId === 'B' && s.key === 'ewr')!.values;
				y[9] = y[9]! + 1;
			})
		).toMatch(/B day 9/);
		expect(
			broken((o) => {
				// Y kept consistent with a share that no longer adds up.
				const f = o.summary.farms.find((g) => g.nodeId === 'C')!;
				f.ewrShare = f.ewrShare! * 2;
				const ewr = o.series.find((s) => s.nodeId === null && s.key === 'ewr')!.values;
				o.series.find((s) => s.nodeId === 'C' && s.key === 'ewr')!.values = ewr.map((v) => v * f.ewrShare!);
			})
		).toMatch(/add up to/);
		expect(broken((o) => (o.summary.ewrSplit!.period = { ...o.summary.ewrSplit!.period!, start: '2015-01-01' }))).toMatch(/isn't the run's complete water years/);
		expect(broken((o) => (o.summary.ewrSplit = { method: 'flowShare', applied: 'flowShare' }))).toMatch(/settings ask for naturalMar/);
		expect(broken((o) => (o.summary.ewrSplit = { method: 'naturalMar', applied: 'flowShare', why: 'catchmentRain' }))).toMatch(/flow share/);
	});
});
