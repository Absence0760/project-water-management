// End to end: gap filling of the observed records (docs/model.md §2.10i) and
// the per-day quality flags with the flag-aware objective (§2.10h), on a
// synthetic catchment whose record is the model run with known parameters.
// Invented catchments and values only (the repo is public).
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import { calibrate } from '../calibrate/calibrate';
import { FLOW_FLAG_CODE } from '../calibrate/dayFlags';
import { fitScores } from '../calibrate/objective';
import { fillFlowGaps, FLOW_FILL_CODE, type FlowGapFillSpec } from '../flowGapFill';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';

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
const START = '2004-10-01';
const TRUTH = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
const series = (out: ReturnType<typeof runModel>, key: string, nodeId: string | null = null) => out.series.find((s) => s.key === key && s.nodeId === nodeId)?.values;

/** Invented "Sandspruit": one farm to the outlet gauge; the truth run's outflow in m³/s. */
function base(years = 5): { input: ModelInput; q: number[] } {
	const days = Math.round(years * 365.25);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH, warmupDays: 365 } },
		model: {
			nodes: [node({ id: 'G', name: 'Sandspruit weir', kind: 'gauge' }), node({ id: 'F', name: 'Farm Sand', downstreamNodeId: 'G', areaKm2: 35 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(days, START, 41) } }
	};
	const q = series(runModel(input), 'simulated_outflow')!.map((v) => v / SEC);
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	return { input, q };
}

const reading = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const spec = (over: Partial<FlowGapFillSpec> = {}): FlowGapFillSpec => ({ interpolateMaxDays: 5, donor: null, donorMaxDays: 60, donorMinOverlapDays: 365, ...over });

describe('gap filling (§2.10i)', () => {
	it('never alters a reading, fills only interior gaps of ≤ interpolateMaxDays by log-linear interpolation, and leaves lead-in, tail and longer gaps open', () => {
		const values: (number | null)[] = Array.from({ length: 60 }, (_, t) => 10 * 0.9 ** t);
		const gaps = { lead: [0, 1, 2], g1: [10], g5: [20, 21, 22, 23, 24], g6: [30, 31, 32, 33, 34, 35], tail: [57, 58, 59] };
		for (const t of Object.values(gaps).flat()) values[t] = null;
		values[45] = -3; // a negative reading is missing too
		const f = fillFlowGaps('flow_observed_m3s', { startDate: START, values }, spec());
		values.forEach((v, t) => {
			if (reading(v)) {
				expect(f.values[t]).toBe(v);
				expect(f.code[t]).toBe(FLOW_FILL_CODE.none);
			}
		});
		// Exponential recession: log-linear interpolation is exact.
		for (const t of [...gaps.g1, ...gaps.g5, 45]) {
			expect(f.code[t]).toBe(FLOW_FILL_CODE.interpolated);
			expect(f.values[t]!).toBeCloseTo(10 * 0.9 ** t, 10);
		}
		for (const t of [...gaps.lead, ...gaps.g6, ...gaps.tail]) {
			expect(f.code[t]).toBe(FLOW_FILL_CODE.none);
			expect(f.values[t]).toBeNull();
		}
		expect(f.summary.interpolatedDays).toBe(7);
		expect(f.summary.interpolatedGaps).toBe(3);
		expect(f.summary.openGaps).toBe(1);
		expect(f.summary.openDays).toBe(6);
		// interpolateMaxDays 0: nothing interpolated at all.
		const none = fillFlowGaps('flow_observed_m3s', { startDate: START, values }, spec({ interpolateMaxDays: 0 }));
		expect([...none.code].every((c) => c === 0)).toBe(true);
	});

	it('linear (not log-linear) across a gap next to a zero reading', () => {
		const f = fillFlowGaps('flow_observed_m3s', { startDate: START, values: [0, null, null, null, 4] }, spec());
		expect(f.values).toEqual([0, 1, 2, 3, 4]);
	});

	it('donor: fills gaps longer than the interpolation limit and up to donorMaxDays with donor × Σrecord/Σdonor, clamped to the record maximum', () => {
		const n = 900;
		const rng = new Rng(8);
		const donor = Array.from({ length: n }, (_, t) => 1 + Math.sin(t / 20) ** 2 + 0.1 * rng.next());
		const rec: (number | null)[] = donor.map((v) => 2 * v);
		// Gap of 10 (donor), gap of 61 (too long: open), gap of 3 (interpolated).
		for (let t = 100; t < 110; t++) rec[t] = null;
		for (let t = 300; t < 361; t++) rec[t] = null;
		for (let t = 500; t < 503; t++) rec[t] = null;
		// A donor flood far above anything the record holds, inside the donor gap.
		const flood = donor.slice();
		flood[105] = 50;
		const f = fillFlowGaps('flow_observed_m3s', { startDate: START, values: rec }, spec({ donor: 'flow_reference_m3s' }), { startDate: START, values: flood });
		let sr = 0;
		let sd = 0;
		rec.forEach((v, t) => {
			if (reading(v)) {
				sr += v;
				sd += flood[t]!;
			}
		});
		const ratio = sr / sd;
		expect(f.summary.donor!.ratio).toBeCloseTo(ratio, 12);
		expect(f.summary.donorRefused).toBeNull();
		const max = Math.max(...rec.filter(reading));
		for (let t = 100; t < 110; t++) {
			expect(f.code[t]).toBe(FLOW_FILL_CODE.donor);
			expect(f.values[t]!).toBeCloseTo(Math.min(flood[t]! * ratio, max), 12);
		}
		expect(f.values[105]).toBe(max);
		expect(f.summary.clampedDays).toBe(1);
		for (let t = 300; t < 361; t++) expect(f.code[t]).toBe(FLOW_FILL_CODE.none);
		for (let t = 500; t < 503; t++) expect(f.code[t]).toBe(FLOW_FILL_CODE.interpolated);
		rec.forEach((v, t) => reading(v) && expect(f.values[t]).toBe(v));
	});

	it('donor refused below the overlap or the correlation floor: nothing is filled from it', () => {
		const n = 500;
		const rng = new Rng(9);
		const rec: (number | null)[] = Array.from({ length: n }, () => 1 + rng.next());
		for (let t = 100; t < 120; t++) rec[t] = null;
		const unrelated = Array.from({ length: n }, () => 1 + rng.next());
		const f = fillFlowGaps('flow_observed_m3s', { startDate: START, values: rec }, spec({ donor: 'flow_logger_m3s' }), { startDate: START, values: unrelated });
		expect(f.summary.donorRefused).toMatch(/correlate/);
		for (let t = 100; t < 120; t++) expect(f.code[t]).toBe(0);
		const short = fillFlowGaps('flow_observed_m3s', { startDate: START, values: rec }, spec({ donor: 'flow_logger_m3s', donorMinOverlapDays: 1000 }), { startDate: START, values: rec.map((v) => (v === null ? 1 : v)) });
		expect(short.summary.donorRefused).toMatch(/share/);
	});

	it('in a run: the fill columns mark exactly the filled days, the stored record is untouched, and infilled days are scored only under "include"', () => {
		const { input, q } = base();
		const values: (number | null)[] = q.slice();
		const holes = [200, 201, 202, 650, 651, 652, 653, 900];
		for (const t of holes) values[t] = null;
		for (let t = 1000; t < 1010; t++) values[t] = null; // too long to interpolate, no donor
		input.series.flow_observed_m3s = { startDate: START, values };
		input.settings.flowGapFill = { flow_observed_m3s: spec(), flow_logger_m3s: null };
		const stored = structuredClone(values);
		const out = runModel(input);
		expect(input.series.flow_observed_m3s.values).toEqual(stored);
		const code = series(out, 'observed_flow_fill')!;
		const filled = code.flatMap((c, t) => (c ? [t] : []));
		expect(filled).toEqual(holes);
		const measured = values.filter(reading).length;
		expect(out.summary.calibration!.days).toBe(measured);
		// The quality column flags them infilled.
		const qual = series(out, 'observed_flow_quality')!;
		for (const t of holes) expect(qual[t]).toBe(FLOW_FLAG_CODE.infilled);
		const inc = structuredClone(input);
		inc.settings.qualityFlags = { ratings: {}, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'include' };
		const outInc = runModel(inc);
		expect(outInc.summary.calibration!.days).toBe(measured + holes.length);
		// The fit leaves them out by default, scores them under include.
		expect(calibrate(input, { budget: 10, validate: false }).fit.scores.days).toBe(measured);
		expect(calibrate(inc, { budget: 10, validate: false }).fit.scores.days).toBe(measured + holes.length);
	});
});

describe('quality flags and the flag-aware objective (§2.10h)', () => {
	/** Observed and simulated (m³/day) on given days by a plain run with the given parameters. */
	function pairsOn(input: ModelInput, params: Record<string, number>, days: number[]) {
		const x = structuredClone(input);
		x.settings.gr4j = { ...x.settings.gr4j!, ...params };
		const sim = series(runModel(x), 'simulated_outflow')!;
		const rec = x.series.flow_observed_m3s!.values;
		return { o: days.map((t) => rec[t]! * SEC), s: days.map((t) => sim[t]!) };
	}
	const yearsOf = (days: number[]) => days.map((t) => waterYearOf(toEpochDay(START) + t));

	it('a suspect (outlier) day is left out of the fit and only that day; fitAllDays scores it; the run statistics still score it', () => {
		const { input, q } = base();
		const values = q.slice();
		values[777] = q[777]! * 5000 + 500; // a typing error far above 10 × the 99th percentile
		input.series.flow_observed_m3s = { startDate: START, values };
		const r = calibrate(input, { budget: 60, seed: 1, validate: false });
		const all = values.map((_, t) => t);
		const kept = all.filter((t) => t !== 777);
		expect(r.fit.scores.days).toBe(kept.length);
		expect(r.fitAllDays!.scores.days).toBe(all.length);
		const p = pairsOn(input, r.params, kept);
		const want = fitScores(Float64Array.from(p.o), Float64Array.from(p.s), Int32Array.from(yearsOf(kept)));
		expect(r.fit.scores.kgePrime!).toBeCloseTo(want.kgePrime!, 9);
		expect(runModel(input).summary.calibration!.days).toBe(all.length);
		// With suspect days scored, the day counts again.
		const inc = structuredClone(input);
		inc.settings.qualityFlags = { ratings: {}, aboveRating: 'censor', belowRating: 'exclude', suspect: 'include', infilled: 'exclude' };
		expect(calibrate(inc, { budget: 10, validate: false }).fit.scores.days).toBe(all.length);
	});

	it('below the lowest gauging: exactly the days with 0 < Q < Q_min are left out; zero days are not', () => {
		const { input, q } = base();
		const values = q.slice();
		for (let t = 1200; t < 1215; t++) values[t] = 0; // a short dry spell
		input.series.flow_observed_m3s = { startDate: START, values };
		const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
		const qMin = sorted[Math.floor(sorted.length * 0.2)]!;
		input.settings.qualityFlags = { ratings: { flow_observed_m3s: { gaugedMaxM3s: null, gaugedMinM3s: qMin, source: 'invented rating' } }, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' };
		const r = calibrate(input, { budget: 30, seed: 2, validate: false });
		const kept = values.flatMap((v, t) => (v > 0 && v < qMin ? [] : [t]));
		expect(r.fit.scores.days).toBe(kept.length);
		const p = pairsOn(input, r.params, kept);
		expect(r.fit.scores.nse!).toBeCloseTo(fitScores(Float64Array.from(p.o), Float64Array.from(p.s)).nse!, 9);
		const qual = series(runModel(input), 'observed_flow_quality')!;
		values.forEach((v, t) => expect(qual[t]).toBe(v > 0 && v < qMin ? FLOW_FLAG_CODE.belowRating : FLOW_FLAG_CODE.inRange));
	});

	it('above the highest gauging, censored: o′ = s when s ≥ Q_g, else Q_g; excluded: those days are dropped', () => {
		const { input, q } = base();
		const sorted = [...q].sort((a, b) => a - b);
		const qMax = sorted[Math.floor(sorted.length * 0.97)]!;
		const rating = { gaugedMaxM3s: qMax, gaugedMinM3s: null, source: 'invented rating' };
		input.series.flow_observed_m3s = { startDate: START, values: q.slice() };
		input.settings.qualityFlags = { ratings: { flow_observed_m3s: rating }, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' };
		const r = calibrate(input, { budget: 30, seed: 4, validate: false });
		const all = q.map((_, t) => t);
		expect(r.fit.scores.days).toBe(all.length);
		const p = pairsOn(input, r.params, all);
		const g = qMax * SEC;
		const o = p.o.map((v, i) => (v > g ? (p.s[i]! >= g ? p.s[i]! : g) : v));
		expect(r.fit.scores.kgePrime!).toBeCloseTo(fitScores(Float64Array.from(o), Float64Array.from(p.s)).kgePrime!, 9);
		const ex = structuredClone(input);
		ex.settings.qualityFlags = { ...input.settings.qualityFlags!, aboveRating: 'exclude' };
		const rx = calibrate(ex, { budget: 10, validate: false });
		expect(rx.fit.scores.days).toBe(q.filter((v) => v <= qMax).length);
	});
});
