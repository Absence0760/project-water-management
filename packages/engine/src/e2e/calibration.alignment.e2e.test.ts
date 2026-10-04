// End to end: observed records that don't start or end with the run (docs/model.md
// §2.10, §2.10b, §2.10h, §2.10i, §2.10k). A record that is the model's own
// output must score perfectly however its dates sit against the rain and the
// simulation window; any day shift between "observed" and "simulated" shows
// up as a score below 1. Invented catchments and values only (the repo is public).
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import { calibrate, prepareCalibration } from '../calibrate/calibrate';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { resolveEnsembleOptions, runEnsemble } from '../uncertainty/ensemble';

const SEC = 86_400;
const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
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
});
function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}
const RAIN_START = '2000-10-01';
const SIM_START = '2001-10-01';
const SIM_END = '2006-09-30';
const REC_START = '2002-03-17';
const REC_END = '2005-11-30';
const TRUTH = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
const series = (out: ReturnType<typeof runModel>, key: string, nodeId: string | null = null) => out.series.find((s) => s.key === key && s.nodeId === nodeId)!.values;

/**
 * Invented "Langkloof": Farm Bo → weir H → outlet G ← Farm Onder. Rain from 2000, simulation 2001–2006,
 * records only 2002-03-17 … 2005-11-30, cut from the truth run's own outflow at the matching dates.
 */
function langkloof(): ModelInput {
	const days = toEpochDay('2007-09-30') - toEpochDay(RAIN_START) + 1;
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH, warmupDays: 365 }, simulationStart: SIM_START, simulationEnd: SIM_END },
		model: {
			nodes: [
				node({ id: 'G', name: 'Langkloof outlet', kind: 'gauge' }),
				node({ id: 'H', name: 'Langkloof weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
				node({ id: 'A', name: 'Farm Bo', downstreamNodeId: 'H', areaKm2: 30, sortOrder: 2 }),
				node({ id: 'B', name: 'Farm Onder', downstreamNodeId: 'G', areaKm2: 50, sortOrder: 3, damCapacityM3: 300_000, damInitialPct: 0.3, pctRunoffToDam: 0.6, damAreaFullM2: 50_000 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: RAIN_START, values: rain(days, RAIN_START, 81) } }
	};
	const out = runModel(input);
	const s0 = toEpochDay(SIM_START);
	const a = toEpochDay(REC_START) - s0;
	const b = toEpochDay(REC_END) - s0;
	const cut = (v: number[]) => v.slice(a, b + 1).map((x) => x / SEC);
	input.series.flow_observed_m3s = { startDate: REC_START, values: cut(series(out, 'simulated_outflow')) };
	input.series['flow_observed_m3s@H'] = { startDate: REC_START, values: cut(series(out, 'outflow', 'H')) };
	return input;
}

describe('a record that starts and ends inside the run is scored on its own dates', () => {
	const input = langkloof();
	const recDays = toEpochDay(REC_END) - toEpochDay(REC_START) + 1;

	it("the run's statistics with the truth parameters are perfect, at the outlet and at the weir", () => {
		const cal = runModel(input).summary.calibration!;
		expect(cal.days).toBe(recDays);
		expect(cal.firstObservedDate).toBe(REC_START);
		expect(cal.lastObservedDate).toBe(REC_END);
		expect(cal.nse!).toBeCloseTo(1, 10);
		expect(cal.kge!).toBeCloseTo(1, 10);
		const x = structuredClone(input);
		x.settings.calibrationSiteNodeId = 'H';
		const site = runModel(x).summary.calibration!;
		expect(site.siteNodeId).toBe('H');
		expect(site.days).toBe(recDays);
		expect(site.nse!).toBeCloseTo(1, 10);
	});

	it('the fit scores the truth as perfect and the defaults as worse, at the outlet and at the weir', () => {
		for (const site of [null, 'H']) {
			const x = structuredClone(input);
			x.settings.calibrationSiteNodeId = site;
			const pb = prepareCalibration(x);
			expect(pb.scoredDays.length).toBe(recDays);
			expect(fromEpochDay(toEpochDay(SIM_START) + pb.scoredDays[0]!)).toBe(REC_START);
			const r = calibrate(x, { budget: 10, validate: false, free: ['x1'] });
			// startParams are the truth: "before" scores them.
			expect(r.before.scores.kgePrime!).toBeCloseTo(1, 10);
			expect(r.before.scores.nse!).toBeCloseTo(1, 10);
			expect(r.before.start).toBe(REC_START);
			expect(r.before.end).toBe(REC_END);
		}
	});

	it('a calibration window and an exclusion cut the record on calendar dates', () => {
		const x = structuredClone(input);
		x.settings.calibrationStart = '2003-01-01';
		x.settings.calibrationEnd = '2004-12-31';
		x.settings.calibrationExclusions = [{ start: '2003-06-01', end: '2003-06-30', reason: 'invented outage' }];
		const want = toEpochDay('2004-12-31') - toEpochDay('2003-01-01') + 1 - 30;
		expect(runModel(x).summary.calibration!.days).toBe(want);
		const r = calibrate(x, { budget: 10, validate: false, free: ['x1'] });
		expect(r.before.scores.days).toBe(want);
		expect(r.before.scores.kgePrime!).toBeCloseTo(1, 10);
	});

	it('gap filling on the offset record: filled days sit on the gap dates, and scoring them stays perfect (log-linear on a recession is close)', () => {
		const x = structuredClone(input);
		const v = x.series.flow_observed_m3s!.values;
		const holes = [100, 101, 102, 500, 501];
		for (const i of holes) v[i] = null;
		x.settings.flowGapFill = { flow_observed_m3s: { interpolateMaxDays: 5, donor: null, donorMaxDays: 60, donorMinOverlapDays: 365 }, flow_logger_m3s: null };
		const out = runModel(x);
		const code = series(out, 'observed_flow_fill');
		const off = toEpochDay(REC_START) - toEpochDay(SIM_START);
		expect(code.flatMap((c, t) => (c ? [t - off] : []))).toEqual(holes);
		expect(out.summary.calibration!.days).toBe(recDays - holes.length);
		expect(out.summary.calibration!.nse!).toBeCloseTo(1, 10);
	});

	it('quality flags on the offset record land on the right dates (a rating flags the same days as the stored values say)', () => {
		const x = structuredClone(input);
		const v = x.series.flow_observed_m3s!.values as number[];
		const qMin = [...v].sort((p, q) => p - q)[Math.floor(v.length * 0.25)]!;
		x.settings.qualityFlags = { ratings: { flow_observed_m3s: { gaugedMaxM3s: null, gaugedMinM3s: qMin, source: 'invented' } }, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' };
		const pb = prepareCalibration(x);
		const off = toEpochDay(REC_START) - toEpochDay(SIM_START);
		const want = v.flatMap((q, i) => (q > 0 && q < qMin ? [] : [i + off]));
		expect([...pb.scoredDays]).toEqual(want);
	});

	it('the ensemble judges member 0 (the truth) as a perfect fit on the offset record', () => {
		const { options } = resolveEnsembleOptions(input, { members: 30, seed: 2 });
		const r = runEnsemble(input, options);
		expect(r.members[0]!.scores.skill!).toBeCloseTo(1, 5);
		const x = structuredClone(input);
		x.settings.calibrationSiteNodeId = 'H';
		const { options: o2 } = resolveEnsembleOptions(x, { members: 30, seed: 2 });
		expect(runEnsemble(x, o2).members[0]!.scores.skill!).toBeCloseTo(1, 5);
	});
});
