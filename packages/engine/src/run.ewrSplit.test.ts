// The EWR split between the units (engine ≥ 1.105.0, issue #615, ./network/ewrSplit.ts,
// docs/model.md §2.5b): always by each unit's natural MAR over the run's complete water
// years, under both flow generation methods (Fragmentation runs GR4J per land unit on
// the Per unit forcing for the shares only), the same shares to the bit for the same
// inputs; units sharing a station; units on the catchment rain; the fallbacks; the
// retired setting; and that everything reading the split EWR (an EWR site's
// requirement, its shortfall, the charge) follows it.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { toEpochDay } from './calendar';
import { stationSeriesKey, UNIT_RAIN_SERIES, type ModelInput, type NetworkNode, type ProjectSettings } from './project';
import { runModel } from './run';
import { areaShares, ewrSplitDays, ewrSplitNote, fillPlanEwrShares, naturalMarShares } from './network/ewrSplit';
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
 * straight into G. A and B share station S (MAP 600); C and D take their §2.4h rule (C its own CHIRPS × its MAP, D,
 * with no record of its own and no gauge MAP, the catchment rain: rule 4). A irrigates, so G1 can fall short.
 * `perUnit` false is Fragmentation with the same Per unit setup kept (unitRain `catchment`).
 */
function catchment(settings: Partial<ProjectSettings> = {}, perUnit = true): ModelInput {
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: apan as never,
			ewrPragmaticM3PerDay: Array(12).fill(25_000) as never,
			unitRain: { mode: perUnit ? 'perUnit' : 'catchment' },
			rainStations: { units: { A: { stationId: 'S' }, B: { stationId: 'S' } }, sites: { S: { unitId: 'A' } } },
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
			'rain_chirps_mm@C': { startDate: START, values: rainOf(0.6, 5) },
			[stationSeriesKey('S')]: { startDate: START, values: rainOf(1.6, 1) }
		},
		stations: { S: { name: 'Station S', mapMm: 600, mapSource: 'invented', lat: null, lon: null } }
	};
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;
const farm = (out: Out, id: string) => out.summary.farms.find((f) => f.nodeId === id)!;
const UNITS = ['A', 'B', 'C', 'D'];

const PERIOD = { start: '2015-10-01', end: '2020-09-30', waterYears: 5 };
const FROM = toEpochDay('2015-10-01') - D0;
const TO = toEpochDay('2020-10-01') - D0;
const sumOf = (v: ArrayLike<number>, from = 0, to = v.length) => {
	let s = 0;
	for (let t = from; t < to; t++) s += v[t]!;
	return s;
};

describe('the split helpers', () => {
	it('the period: the complete water years of the historical days, else every historical day', () => {
		// 2015-01-01 … 2020-12-31: 2015/16 … 2019/20.
		expect(ewrSplitDays(D0, DAYS)).toEqual({ from: FROM, to: TO, waterYears: 5 });
		// A run that starts on 1 October and ends on 30 September is all complete years.
		const oct = toEpochDay('2015-10-01');
		expect(ewrSplitDays(oct, toEpochDay('2017-10-01') - oct)).toEqual({ from: 0, to: toEpochDay('2017-10-01') - oct, waterYears: 2 });
		// No complete water year (and no dates): the whole historical run.
		expect(ewrSplitDays(D0, 400)).toEqual({ from: 0, to: 400, waterYears: 0 });
		expect(ewrSplitDays(undefined, 400)).toEqual({ from: 0, to: 400, waterYears: 0 });
		// A forecast tail's days are never in it: only historyDays are.
		expect(ewrSplitDays(D0, toEpochDay('2016-10-01') - D0)).toEqual({ from: FROM, to: toEpochDay('2016-10-01') - D0, waterYears: 1 });
	});

	it('the shares: each unit’s runoff over the period ÷ the total, the same in any order; the area shares without runoff', () => {
		const a = { nodeId: 'a', runoffM3Day: [100, 1, 1, 100] };
		const b = { nodeId: 'b', runoffM3Day: [100, 3, -5, 100] };
		const s = naturalMarShares([b, a], 1, 3)!;
		// Over days 1–2: a 2, b 3 (its negative day counts 0).
		expect(s.get('a')).toBe(2 / 5);
		expect(s.get('b')).toBe(3 / 5);
		expect([...naturalMarShares([a, b], 0, 4)!]).toEqual([...naturalMarShares([b, a], 0, 4)!]);
		expect(naturalMarShares([{ nodeId: 'a', runoffM3Day: [0, 0] }], 0, 2)).toBeNull();
		// No runoff: the area shares (a farm without area takes 0); no area anywhere: nothing to split by.
		const nodes: { ewrShare?: number }[] = [{}, {}, {}];
		const farms = [
			{ index: 0, nodeId: 'a', areaKm2: 3, runoff: [0, 0] },
			{ index: 1, nodeId: 'b', areaKm2: 1, runoff: [0, 0] },
			{ index: 2, nodeId: 'c', areaKm2: 0, runoff: undefined }
		];
		expect(fillPlanEwrShares(nodes, { days: { from: 0, to: 2 }, farms })?.applied).toBe('area');
		expect(nodes.map((n) => n.ewrShare)).toEqual([0.75, 0.25, 0]);
		expect(areaShares([{ nodeId: 'a', areaKm2: 0 }])).toBeNull();
	});
});

describe('the same split under both flow generation methods (issue #615)', () => {
	it('splits the EWR by each unit’s own natural runoff over the complete water years, adding up to 1', () => {
		const out = runModel(catchment());
		expect(out.summary.ewrSplit).toEqual({ applied: 'naturalMar', period: PERIOD, runoffFrom: 'unitRain' });
		const vol = new Map(UNITS.map((id) => [id, sumOf(col(out, UNIT_RAIN_SERIES.runoff.key, id)!, FROM, TO)]));
		const total = [...vol.values()].reduce((s, v) => s + v, 0);
		let sum = 0;
		for (const id of UNITS) {
			const f = farm(out, id);
			expect(f.ewrShare).toBeCloseTo(vol.get(id)! / total, 12);
			sum += f.ewrShare!;
		}
		expect(sum).toBeCloseTo(1, 12);
		// A's MAP is the highest, so its share of the runoff (and of the EWR) is above its share of the area.
		expect(farm(out, 'A').ewrShare!).toBeGreaterThan(farm(out, 'A').flowShare!);
		// Every unit on its own rain: nothing to note (the summary records the split).
		expect(out.summary.warnings.filter((w) => w.includes('natural MAR'))).toEqual([]);
		expect(checkEwrSplit(catchment(), out)).toBeNull();
	});

	it('Fragmentation gives every unit the same share as Per unit, to the bit, while the flow stays the catchment run’s split by the flow share', () => {
		const per = runModel(catchment());
		const frag = runModel(catchment({}, false));
		for (const id of UNITS) expect(farm(frag, id).ewrShare, id).toBe(farm(per, id).ewrShare);
		expect(frag.summary.ewrSplit).toEqual({ applied: 'naturalMar', period: PERIOD, runoffFrom: 'shareRuns', catchmentRain: [{ nodeId: 'D', name: 'Unit D' }] });
		// The flow is Fragmentation's: no unit runoff columns, the catchment's one run, the flow share.
		expect(col(frag, UNIT_RAIN_SERIES.runoff.key, 'A')).toBeUndefined();
		expect(frag.summary.unitRain).toBeUndefined();
		// One note, naming the unit on the catchment rain, not a warning per unit, and none of the Per unit forcing's own warnings.
		const notes = frag.summary.warnings.filter((w) => w.includes('natural MAR'));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/^the EWR is split between the units by each unit’s natural MAR over the 5 complete water years 1 Oct 2015 – 30 Sep 2020: .*for these shares only/);
		expect(notes[0]).toMatch(/"Unit D" has no rain of its own .* its share follows its area/);
		expect(frag.summary.warnings.some((w) => w.startsWith('unit rain:'))).toBe(false);
		expect(checkEwrSplit(catchment({}, false), frag)).toBeNull();
	});

	it('units that all run on the catchment rain take their area shares', () => {
		// No station, no MAP, no CHIRPS of their own: every unit is on rule 4, so each makes the same runoff per km².
		const x = catchment({ rainStations: null }, false);
		for (const n of x.model.nodes) n.mapMm = null;
		delete x.series['rain_chirps_mm@A'];
		delete x.series['rain_chirps_mm@B'];
		delete x.series['rain_chirps_mm@C'];
		const out = runModel(x);
		expect(out.summary.ewrSplit?.applied).toBe('naturalMar');
		expect(out.summary.ewrSplit?.catchmentRain?.map((u) => u.nodeId)).toEqual(UNITS);
		const area: Record<string, number> = { A: 10, B: 6, C: 3, D: 1.5 };
		for (const id of UNITS) expect(Math.abs(farm(out, id).ewrShare! - area[id]! / 20.5), id).toBeLessThan(1e-12);
		expect(checkEwrSplit(x, out)).toBeNull();
	});

	it('Σ Y over the units is the outlet EWR every day, under both methods', () => {
		for (const perUnit of [true, false]) {
			const out = runModel(catchment({}, perUnit));
			const ewr = col(out, 'ewr')!;
			const ys = UNITS.map((id) => col(out, 'ewr', id)!);
			for (let t = 0; t < out.days; t++) {
				let y = 0;
				for (const v of ys) y += v[t]!;
				expect(Math.abs(y - ewr[t]!), `perUnit ${perUnit} day ${t}`).toBeLessThanOrEqual(1e-9 * Math.max(1, ewr[t]!));
			}
		}
	});

	it('two units sharing a station each take their own runoff’s share', () => {
		const out = runModel(catchment());
		const a = farm(out, 'A');
		const b = farm(out, 'B');
		// A and B both read station S, scaled to their MAPs (900 and 600) over their areas (10 and 6 km²): the shares differ.
		expect(a.ewrShare).not.toBe(b.ewrShare);
		const vol = (id: string) => sumOf(col(out, UNIT_RAIN_SERIES.runoff.key, id)!, FROM, TO);
		expect(a.ewrShare! / b.ewrShare!).toBeCloseTo(vol('A') / vol('B'), 10);
	});

	it('everything reading the split EWR follows it: a gauge site’s requirement is its units’ shares', () => {
		for (const perUnit of [true, false]) {
			const out = runModel(catchment({}, perUnit));
			const ewr = col(out, 'ewr')!;
			// G1's requirement is A's EWR share alone, the cumulative natural MAR there.
			const z = col(out, 'ewr_cumulative', 'G1')!;
			const k = farm(out, 'A').ewrShare!;
			for (let t = 0; t < out.days; t++) expect(z[t]).toBe(ewr[t]! * k);
			const sum = (v: ArrayLike<number>) => sumOf(v);
			expect(sum(col(out, 'ewr_charged', 'G1')!) + sum(col(out, 'ewr_natural', 'G1')!)).toBeCloseTo(sum(col(out, 'ewr_shortfall', 'G1')!), 0);
		}
	});

	it('holds every invariant, and a resumed run and a forecast tail keep the historical split, under both methods', () => {
		for (const perUnit of [true, false]) {
			expect(checkAll(catchment({}, perUnit)), `perUnit ${perUnit}`).toBeNull();
			for (const k of [0, 400, 1500]) expect(checkResume(catchment({}, perUnit), k), `perUnit ${perUnit} resume at ${k}`).toBeNull();
			expect(checkForecastPrefix(withForecastTail(catchment({}, perUnit), 7))).toBeNull();
		}
	});

	it('calibration refills each candidate’s shares from its own runoff, so a scored day is runModel’s to the bit, under both methods', () => {
		for (const perUnit of [true, false]) {
			const x = catchment({}, perUnit);
			const a = x.model.nodes.find((n) => n.id === 'A')!;
			// A hands-off EWR flow at A makes the outflow read A's EWR share, so a share that isn't the candidate's shows.
			Object.assign(a, { damCapacityM3: 50_000, damInitialPct: 0.5, pctRunoffToDam: 0.5, supplyRule: 'riverFirst', pumpCapacityM3Day: 1e6, handsOffEwr: true });
			x.series.flow_observed_m3s = { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) };
			const pb = prepareCalibration(x);
			for (const p of [pb.startParams, { ...pb.startParams, x1: (pb.startParams as { x1: number }).x1 * 1.6, x3: (pb.startParams as { x3: number }).x3 * 0.5 }]) {
				const want = runModel({ ...x, settings: { ...x.settings, gr4j: { ...(x.settings.gr4j ?? {}), ...p } as never } }).series.find((s) => s.nodeId === null && s.key === 'simulated_outflow')!.values;
				const got = pb.simulate(p);
				for (const t of pb.scoredDays) expect(got[t], `perUnit ${perUnit} day ${t}`).toBe(want[t]);
			}
		}
	});

	it('with no runoff over the period the area shares split the EWR; a snapshot pins that; without a land unit, the flow share', () => {
		// The plan as calibration first builds it, on units that made no runoff (GR4J always makes some from its stores).
		const x = catchment({}, false);
		const prep = prepareRun(x);
		const zeros = () => UNITS.map((nodeId) => ({ nodeId, runoffM3Day: new Float64Array(prep.days) }));
		const plan = (warm: Parameters<typeof buildNetworkPlan>[8] = {}) =>
			buildNetworkPlan(x, prep.settings, prep.days, prep.month, prep.aligned, new Float64Array(prep.days), [], prep.start, { shareRunoff: zeros(), ...warm }, prep.days);
		const fresh = plan();
		expect(fresh.ewrSplit.info).toEqual({ applied: 'area', why: 'noRunoff', period: PERIOD, runoffFrom: 'shareRuns' });
		expect(fresh.plan.nodes.flatMap((n) => (n.kind === 'farm' ? [n.ewrShare] : []))).toEqual([10 / 20.5, 6 / 20.5, 3 / 20.5, 1.5 / 20.5]);
		expect(ewrSplitNote(fresh.ewrSplit.info)).toMatch(/split between the units by their area/);
		// Resumed from that snapshot: the same shares and record, marked pinned.
		const resumed = plan({ ewrSplit: fresh.ewrSplit.pin! });
		expect(resumed.ewrSplit.info).toEqual({ ...fresh.ewrSplit.info, pinned: true });
		expect(resumed.plan.nodes.map((n) => n.ewrShare)).toEqual(fresh.plan.nodes.map((n) => n.ewrShare));
		// Resumed from a snapshot that pinned nothing: the flow share, never shares worked out on the resumed days alone.
		expect(plan({ ewrSplit: null }).ewrSplit.info).toEqual({ applied: 'flowShare', why: 'resumed' });
		// Natural flow supplied without the units' runoff (runModelWith): the flow share, as before 1.105.0, and no note.
		const bare = buildNetworkPlan(x, prep.settings, prep.days, prep.month, prep.aligned, new Float64Array(prep.days), [], prep.start, {}, prep.days);
		expect(bare.ewrSplit.info).toEqual({ applied: 'flowShare', why: 'noUnitRunoff' });
		expect(bare.plan.nodes.some((n) => n.ewrShare !== undefined)).toBe(false);
		expect(ewrSplitNote(bare.ewrSplit.info)).toBeNull();
		// No land unit: nothing to split by, the flow share (until #616), with a note.
		expect(ewrSplitNote({ applied: 'flowShare', why: 'noLandUnit' })).toMatch(/no unit has an area/);
	});

	it('a model with no unit area runs on the flow share, says so, and passes the check', () => {
		const x = catchment({ calibration: { rainThresholdMm: 0, catchmentAreaKm2: 20 } as never }, false);
		for (const n of x.model.nodes) n.areaKm2 = 0;
		Object.assign(x.settings, { flowShareMethod: 'manual' });
		for (const n of x.model.nodes) if (n.kind === 'farm') n.flowShareManual = 0.25;
		const out = runModel(x);
		expect(out.summary.ewrSplit).toEqual({ applied: 'flowShare', why: 'noLandUnit' });
		for (const id of UNITS) expect(farm(out, id).ewrShare).toBe(farm(out, id).flowShare);
		expect(checkEwrSplit(x, out)).toBeNull();
	});
});

describe('the retired setting (engine 1.94.0 – 1.104.x)', () => {
	it('a stored ewrSplit is ignored: the run is the one without it, to the bit', () => {
		for (const perUnit of [true, false]) {
			const plain = runModel(catchment({}, perUnit));
			for (const v of ['flowShare', 'naturalMar', 'byArea']) {
				const old = runModel(catchment({ ewrSplit: v } as never, perUnit));
				expect(sameOutput(plain, old), `perUnit ${perUnit} ${v}`).toBe(true);
			}
		}
	});

	it('a scenario’s settings.set ewrSplit is refused with a reason to delete it', () => {
		const sc = applyScenario(catchment(), [{ op: 'settings.set', path: 'ewrSplit', value: 'naturalMar' } as never]);
		expect(sc.problems).toHaveLength(1);
		expect(JSON.stringify(sc.problems[0])).toMatch(/removed in engine 1\.105\.0.*delete this change/);
	});

	it('an older run’s record still reads: its notes', () => {
		expect(ewrSplitNote({ method: 'flowShare', applied: 'flowShare' })).toBeNull();
		expect(ewrSplitNote({ applied: 'flowShare', why: 'resumed' })).toMatch(/resumes from a snapshot/);
	});
});

describe('the invariant check', () => {
	it('catches a share, a day, a sum, a period or a fallback that isn’t the run’s', () => {
		const x = catchment();
		const out = runModel(x);
		const broken = (edit: (o: Out) => void, input = x, base = out) => {
			const o = structuredClone(base);
			edit(o);
			return checkEwrSplit(input, o);
		};
		expect(checkEwrSplit(x, out)).toBeNull();
		expect(broken((o) => (o.summary.farms.find((f) => f.nodeId === 'A')!.ewrShare! *= 1.01))).toMatch(/A day 0: EWR share/);
		expect(
			broken((o) => {
				const y = o.series.find((s) => s.nodeId === 'B' && s.key === 'ewr')!.values;
				y[9] = y[9]! + 1;
			})
		).toMatch(/B day 9/);
		const scale = (o: Out, id: string, k: number) => {
			// Y kept consistent with a share that no longer adds up.
			const f = o.summary.farms.find((g) => g.nodeId === id)!;
			f.ewrShare = f.ewrShare! * k;
			const ewr = o.series.find((s) => s.nodeId === null && s.key === 'ewr')!.values;
			o.series.find((s) => s.nodeId === id && s.key === 'ewr')!.values = ewr.map((v) => v * f.ewrShare!);
		};
		expect(broken((o) => scale(o, 'C', 2))).toMatch(/add up to/);
		expect(broken((o) => (o.summary.ewrSplit!.period = { ...o.summary.ewrSplit!.period!, start: '2015-01-01' }))).toMatch(/isn't the run's complete water years/);
		expect(broken((o) => (o.summary.ewrSplit = { applied: 'flowShare', why: 'noLandUnit' }))).toMatch(/no land unit|flow share/);
		// Fragmentation: the units on the catchment rain must stand in the ratio of their areas.
		const fx = catchment({}, false);
		const frag = runModel(fx);
		expect(
			broken(
				(o) => {
					o.summary.ewrSplit!.catchmentRain = [
						{ nodeId: 'D', name: 'Unit D' },
						{ nodeId: 'A', name: 'Unit A' }
					];
				},
				fx,
				frag
			)
		).toMatch(/per km²/);
		// An older run's record (a retired method) is skipped.
		expect(broken((o) => (o.summary.ewrSplit = { method: 'naturalMar', applied: 'flowShare', why: 'catchmentRain' }))).toBeNull();
	});
});
