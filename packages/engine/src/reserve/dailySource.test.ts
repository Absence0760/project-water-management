// The daily outlet EWR's source (engine ≥ 1.77.0, issue #455, docs/model.md
// §2.9f): the pragmatic EWR, the DRM TAB file, or the DRM percentile tables
// read day by day at the natural flow, each table scaled to the model by MAR
// or by area. Hand-worked numbers first, then whole runs on a synthetic
// network.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { testCatchment } from '../outlook/testCatchment';
import { buildNetworkPlan, naturalAtOutlet, OUTLET_EWR_LABELS, runModelWith, runModelWithoutChecks } from '../run';
import { prepareRun } from '../prepare';
import { diffInputs } from '../compare';
import { prepareCalibration } from '../calibrate/calibrate';
import { checkInvariants } from '../verify/checks';
import { checkResume } from '../testing/warmstartInvariants';
import {
	blankEwrDailySource,
	describeEwrDailySource,
	ewrDailyScale,
	ewrDailySourceChanges,
	ewrDailySourceIssues,
	ewrDailySourceNotes,
	EWR_PERCENTILE_POINTS,
	fillOutletEwr,
	naturalMarMm3,
	percentileReserveM3s,
	resolveEwrDailySource,
	type EwrDailySource
} from './dailySource';

const DAY = 86_400;
const N = [10, 8, 6, 5, 4, 3, 2, 1.5, 1, 0.5];
const R = [5, 4, 3, 2.5, 2, 1.5, 1, 0.8, 0.6, 0.4];
const twelve = <T>(row: T[]) => Array.from({ length: 12 }, () => [...row]);

describe('percentileReserveM3s: the day’s Reserve flow from the two tables', () => {
	it('at or above the wettest point: the wettest Reserve flow', () => {
		expect(percentileReserveM3s(12, N, R)).toBe(5);
		expect(percentileReserveM3s(10, N, R)).toBe(5);
	});

	it('between two points: linear in the natural flow (k = the last point with N ≥ q)', () => {
		// N₂ = 8 ≥ 7 > N₃ = 6: w = (8 − 7) ÷ (8 − 6) = 0.5, R = 4 + 0.5 × (3 − 4) = 3.5.
		expect(percentileReserveM3s(7, N, R)).toBe(3.5);
		// N₇ = 2 ≥ 1.8 > N₈ = 1.5: w = 0.2 ÷ 0.5 = 0.4, R = 1 + 0.4 × (0.8 − 1) = 0.92.
		expect(percentileReserveM3s(1.8, N, R)).toBeCloseTo(0.92, 12);
	});

	it('exactly on an inner point: that point’s Reserve flow', () => {
		N.forEach((n, i) => {
			if (i > 0 && i < N.length - 1) expect(percentileReserveM3s(n, N, R)).toBe(R[i]);
		});
	});

	it('at or below the driest point: the driest Reserve flow × q ÷ N₁₀', () => {
		expect(percentileReserveM3s(0.5, N, R)).toBe(0.4);
		expect(percentileReserveM3s(0.25, N, R)).toBeCloseTo(0.2, 12);
		expect(percentileReserveM3s(0, N, R)).toBe(0);
		// A negative natural flow reads as 0.
		expect(percentileReserveM3s(-3, N, R)).toBe(0);
	});

	it('a driest natural point of 0: the driest Reserve flow, not a division by 0', () => {
		const n0 = [...N.slice(0, 9), 0];
		expect(percentileReserveM3s(0, n0, R)).toBe(0.4);
		expect(percentileReserveM3s(-1, n0, R)).toBe(0.4);
		// Just above it, between N₉ = 1 and N₁₀ = 0: w = (1 − 0.25) ÷ 1, R = 0.6 + 0.75 × (0.4 − 0.6) = 0.45.
		expect(percentileReserveM3s(0.25, n0, R)).toBeCloseTo(0.45, 12);
	});

	it('a flat step: q on it takes the step’s last point; below it, between that point and the next', () => {
		const flat = [10, 8, 6, 6, 4, 3, 2, 1.5, 1, 0.5];
		expect(percentileReserveM3s(6, flat, R)).toBe(2.5);
		// N₄ = 6 ≥ 5 > N₅ = 4: w = 0.5, R = 2.5 + 0.5 × (2 − 2.5) = 2.25.
		expect(percentileReserveM3s(5, flat, R)).toBe(2.25);
		// A whole row flat at one value: at it or above, the wettest flow; below it, scaled from the driest.
		const level = new Array(10).fill(4);
		expect(percentileReserveM3s(4, level, R)).toBe(5);
		expect(percentileReserveM3s(2, level, R)).toBeCloseTo(0.2, 12);
	});

	it('never leaves the Reserve row’s range above the driest point, on a dense sweep', () => {
		for (let q = 0.5; q <= 12; q += 0.01) {
			const r = percentileReserveM3s(q, N, R);
			expect(r).toBeGreaterThanOrEqual(0.4 - 1e-12);
			expect(r).toBeLessThanOrEqual(5 + 1e-12);
		}
	});
});

describe('the scale factor', () => {
	it("'mar': the model's natural MAR (mean m³/day × 365.25 ÷ 10⁶) ÷ the table MAR", () => {
		const nat = new Float64Array(1000).fill(DAY); // 1 m³/s
		expect(naturalMarMm3(nat, 1000)).toBeCloseTo(31.5576, 10);
		const src: EwrDailySource = { ...blankEwrDailySource(), scaling: 'mar', method: 'tab', tabM3s: new Array(12).fill(1), tableMarMm3: 63.1152 };
		const info = ewrDailyScale(src, nat, 1000, 50);
		expect(info).toMatchObject({ method: 'tab', scaling: 'mar', tableMarMm3: 63.1152 });
		expect(info.scale).toBeCloseTo(0.5, 12);
		expect(info.modelMarMm3).toBeCloseTo(31.5576, 10);
		expect(info).not.toHaveProperty('modelAreaKm2');
	});

	it("'mar' reads only the historical days, so a forecast tail never moves it", () => {
		const nat = Float64Array.from({ length: 20 }, (_, t) => (t < 10 ? DAY : 100 * DAY));
		expect(naturalMarMm3(nat, 10)).toBeCloseTo(31.5576, 10);
		expect(naturalMarMm3(nat, 0)).toBe(0);
	});

	it("'area': the modelled area ÷ the table area", () => {
		const src: EwrDailySource = { ...blankEwrDailySource(), scaling: 'mar', method: 'tab', scaling: 'area', tabM3s: new Array(12).fill(1), tableAreaKm2: 120 };
		expect(ewrDailyScale(src, new Float64Array(5), 5, 30)).toEqual({ method: 'tab', scaling: 'area', scale: 0.25, modelAreaKm2: 30, tableAreaKm2: 120 });
	});
});

describe('fillOutletEwr', () => {
	// 1 Jan 2001 … 3 Jan 2001, then 1 Oct 2001.
	const month = Uint8Array.from([1, 1, 1, 10]);
	it('TAB: the month’s flow × s × 86 400', () => {
		const tab = [10, 11, 12, 2, 14, 15, 16, 17, 18, 19, 20, 21]; // Oct … Sep: January is 2 m³/s
		const out = new Float64Array(4);
		fillOutletEwr({ ...blankEwrDailySource(), scaling: 'mar', method: 'tab', tabM3s: tab, tableMarMm3: 1 }, 0.5, month, new Float64Array(4), out, 0, 4);
		expect([...out]).toEqual([DAY, DAY, DAY, 5 * DAY]);
	});

	it('percentile tables: each day on its own natural flow, rows × s, and only the days asked for', () => {
		const src: EwrDailySource = { ...blankEwrDailySource(), scaling: 'mar', method: 'percentile', naturalPctM3s: twelve(N), reservePctM3s: twelve(R), tableMarMm3: 1 };
		const out = new Float64Array(4).fill(-1);
		// s = 2: the rows become N × 2, R × 2. A natural flow of 14 m³/s sits between 16 and 12: R = 8 + 0.5 × (6 − 8) = 7.
		fillOutletEwr(src, 2, month, [14 * DAY, 30 * DAY, 0.5 * DAY, 0], out, 0, 3);
		expect(out[0]).toBeCloseTo(7 * DAY, 6);
		expect(out[1]).toBe(10 * DAY);
		// Below the driest scaled point (1): 0.8 × 0.5 ÷ 1.
		expect(out[2]).toBeCloseTo(0.4 * DAY, 6);
		expect(out[3]).toBe(-1);
	});

	it('a natural row that rises uses its running minimum, and the source notes say so', () => {
		const rising = [10, 8, 9, 5, 4, 3, 2, 1.5, 1, 0.5];
		const src: EwrDailySource = { ...blankEwrDailySource(), scaling: 'mar', method: 'percentile', naturalPctM3s: twelve(rising), reservePctM3s: twelve(R), tableMarMm3: 1 };
		const out = new Float64Array(1);
		fillOutletEwr(src, 1, [1], [7 * DAY], out, 0, 1);
		expect(out[0]).toBeCloseTo(percentileReserveM3s(7, [10, 8, 8, 5, 4, 3, 2, 1.5, 1, 0.5], R) * DAY, 6);
		expect(ewrDailySourceNotes(src)[0]).toMatch(/rises with the point in Oct, Nov/);
		expect(ewrDailySourceNotes({ ...src, naturalPctM3s: twelve(N) })).toEqual([]);
	});

	it('a Reserve flow above the natural flow at its point (on the running minimum) is noted: even natural flow fails there', () => {
		const src: EwrDailySource = { ...blankEwrDailySource(), scaling: 'mar', method: 'percentile', naturalPctM3s: twelve(N), reservePctM3s: twelve([12, ...R.slice(1)]), tableMarMm3: 1 };
		expect(ewrDailySourceNotes(src)).toEqual(['the total Reserve flow is above the natural flow at 12 points (Oct 10 %, Nov 10 %, Dec 10 %, Jan 10 %, …), so even natural flow fails there']);
	});
});

describe('ewrDailySourceIssues and resolveEwrDailySource', () => {
	const tab = (over: Partial<EwrDailySource> = {}): EwrDailySource => ({ ...blankEwrDailySource(), scaling: 'mar', method: 'tab', tabM3s: new Array(12).fill(1), tableMarMm3: 100, ...over });

	it('the blank source and a complete one are usable; pragmatic resolves to null (the pragmatic EWR)', () => {
		expect(ewrDailySourceIssues(blankEwrDailySource())).toEqual([]);
		expect(ewrDailySourceIssues(tab())).toEqual([]);
		expect(resolveEwrDailySource(blankEwrDailySource(), [])).toBeNull();
		expect(resolveEwrDailySource(null, [])).toBeNull();
		expect(resolveEwrDailySource(undefined, [])).toBeNull();
		expect(resolveEwrDailySource(tab(), [])).toEqual(tab());
	});

	it('a new source scales by area (the client hydrologist, issue #90 B2); a stored source keeps its own scaling', () => {
		expect(blankEwrDailySource().scaling).toBe('area');
		// Switching a blank source to a table method asks for the table area, not the MAR.
		expect(ewrDailySourceIssues({ ...blankEwrDailySource(), method: 'tab', tabM3s: new Array(12).fill(1) }).map((i) => i.field)).toEqual(['tableAreaKm2']);
		// A stored MAR-ratio source is read as stored: the default never reaches a saved source or a run.
		expect(resolveEwrDailySource(tab(), [])?.scaling).toBe('mar');
	});

	it('the pragmatic method keeps tables half entered without complaint', () => {
		expect(ewrDailySourceIssues({ ...blankEwrDailySource(), naturalPctM3s: twelve(N), tableAreaKm2: 5 })).toEqual([]);
	});

	it('refuses what the chosen method needs and lacks', () => {
		const fields = (v: unknown) => ewrDailySourceIssues(v).map((i) => i.field);
		expect(fields(tab({ tabM3s: null }))).toEqual(['tabM3s']);
		expect(fields(tab({ tableMarMm3: null }))).toEqual(['tableMarMm3']);
		expect(fields(tab({ scaling: 'area' }))).toEqual(['tableAreaKm2']);
		expect(fields({ ...tab(), method: 'percentile' })).toEqual(['naturalPctM3s', 'reservePctM3s']);
	});

	it('refuses values out of range, a wrong shape, unknown names and unknown fields', () => {
		const fields = (v: unknown) => ewrDailySourceIssues(v).map((i) => i.field);
		expect(fields(tab({ tabM3s: [1, 2] }))).toEqual(['tabM3s']);
		expect(fields(tab({ tabM3s: [...new Array(11).fill(1), -1] }))).toEqual(['tabM3s']);
		expect(fields(tab({ tableMarMm3: 0 }))).toEqual(['tableMarMm3']);
		expect(fields(tab({ tableAreaKm2: -2 }))).toEqual(['tableAreaKm2']);
		expect(fields(tab({ naturalPctM3s: twelve([1, 2, 3]) }))).toEqual(['naturalPctM3s']);
		expect(fields(tab({ reservePctM3s: twelve(R).slice(1) }))).toEqual(['reservePctM3s']);
		expect(fields({ ...tab(), method: 'monthly' })).toEqual(['method']);
		expect(fields({ ...tab(), scaling: 'volume' })).toEqual(['scaling']);
		expect(fields({ ...tab(), extra: 1 })).toEqual(['']);
		const { tableAreaKm2: _, ...missing } = tab();
		expect(fields(missing)).toEqual(['tableAreaKm2']);
		expect(fields('tab')).toEqual(['']);
	});

	it('an unusable source runs the pragmatic EWR and says why', () => {
		const w: string[] = [];
		expect(resolveEwrDailySource(tab({ tabM3s: null }), w)).toBeNull();
		expect(w[0]).toMatch(/daily EWR source ignored, so the outlet's daily EWR is the pragmatic EWR: Enter the TAB/);
	});
});

describe('ewrDailySourceChanges (run comparison)', () => {
	const tab: EwrDailySource = { ...blankEwrDailySource(), scaling: 'mar', method: 'tab', tabM3s: new Array(12).fill(1), tableMarMm3: 100 };
	it('pragmatic in any form is one source; tables kept under it are no change', () => {
		expect(ewrDailySourceChanges(undefined, null)).toEqual([]);
		expect(ewrDailySourceChanges(undefined, { ...blankEwrDailySource(), naturalPctM3s: twelve(N) })).toEqual([]);
		expect(ewrDailySourceChanges(undefined, tab)).toEqual(['the pragmatic EWR → the DRM TAB file']);
	});
	it('names the scaling, the divisor and the table values that changed', () => {
		const tab2 = { ...tab, tableMarMm3: 120, tabM3s: [2, ...new Array(11).fill(1)] };
		expect(ewrDailySourceChanges(tab, tab2)).toEqual(['table MAR 100 Mm³/a → 120 Mm³/a', 'TAB flows changed in Oct']);
		const pct = { ...tab, method: 'percentile' as const, naturalPctM3s: twelve(N), reservePctM3s: twelve(R) };
		const pct2 = { ...pct, scaling: 'area' as const, tableAreaKm2: 40, reservePctM3s: twelve(R).map((row, m) => (m === 0 ? row.map((v) => v + 1) : row)) };
		expect(ewrDailySourceChanges(pct, pct2)).toEqual(['scaled by MAR → by area', 'table area not entered → 40 km²', 'total Reserve flow percentile table: 10 values changed']);
	});
});

describe('describeEwrDailySource (a scenario change, issue #460)', () => {
	it('the pragmatic EWR in any form, the method with its scaling, and an unusable source as one', () => {
		expect(describeEwrDailySource(undefined)).toBe('the pragmatic EWR');
		expect(describeEwrDailySource(null)).toBe('the pragmatic EWR');
		expect(describeEwrDailySource({ ...blankEwrDailySource(), naturalPctM3s: twelve(N) })).toBe('the pragmatic EWR');
		const tab: EwrDailySource = { ...blankEwrDailySource(), scaling: 'mar', method: 'tab', tabM3s: new Array(12).fill(1), tableMarMm3: 12.5 };
		expect(describeEwrDailySource(tab)).toBe('the DRM TAB file, scaled by MAR (table 12.5 Mm³/a)');
		const pct: EwrDailySource = { ...tab, method: 'percentile', scaling: 'area', tableAreaKm2: 450, naturalPctM3s: twelve(N), reservePctM3s: twelve(R) };
		expect(describeEwrDailySource(pct)).toBe('the DRM percentile tables, scaled by area (table 450 km²)');
		expect(describeEwrDailySource({ ...tab, tabM3s: null })).toBe('an unusable source (the run uses the pragmatic EWR)');
	});
});

// ---------------------------------------------------------------------------
// Whole runs
// ---------------------------------------------------------------------------

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

const START = '2000-10-01';
const DAYS = toEpochDay('2003-09-30') - toEpochDay(START) + 1;
const natural = Array.from({ length: DAYS }, (_, t) => 20_000 + 15_000 * Math.sin(t / 29));
const monthOf = (t: number) => new Date((toEpochDay(START) + t) * DAY * 1000).getUTCMonth() + 1;
const wy = (t: number) => (monthOf(t) + 2) % 12;

/** out (gauge) ← a (a dam, irrigating), out ← b: 3 km² + 1 km², all of the catchment. */
function network(settings: Partial<ModelInput['settings']>): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: new Array(12).fill(5_000) as never, apanMm: new Array(12).fill(200) as never, ...settings },
		model: {
			nodes: [
				node('out', { kind: 'gauge' }),
				node('a', { downstreamNodeId: 'out', areaKm2: 3, damCapacityM3: 200_000, pctRunoffToDam: 0.8, damInitialPct: 0.5 }),
				node('b', { downstreamNodeId: 'out' })
			],
			crops: [{ id: 'c', name: 'crop', cropFactor: new Array(12).fill(1) }],
			cropAreas: [{ nodeId: 'a', cropId: 'c', areaM2: 80_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: new Array(DAYS).fill(0) } }
	};
}
const run = (input: ModelInput): ModelOutput => {
	const out = runModelWith(input, () => ({ naturalFlowM3Day: natural }));
	expect(checkInvariants(input, out)).toBeNull();
	return out;
};
const col = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;
const mean = natural.reduce((s, v) => s + v, 0) / DAYS;
const MODEL_MAR = (mean * 365.25) / 1e6;
// The tables' catchment: 4 × the modelled one, by MAR and by area.
const TAB = [0.05, 0.06, 0.08, 0.1, 0.12, 0.1, 0.08, 0.06, 0.05, 0.04, 0.04, 0.05];
const tabSource = (over: Partial<EwrDailySource> = {}): EwrDailySource => ({ ...blankEwrDailySource(), scaling: 'mar', method: 'tab', tabM3s: TAB, tableMarMm3: 4 * MODEL_MAR, tableAreaKm2: 16, ...over });
// Natural percentile rows around the run's natural flow × 4 (m³/s), and a Reserve that asks for 95 % to 45 % of them.
const NAT = [1.6, 1.4, 1.2, 1.05, 0.9, 0.8, 0.7, 0.55, 0.4, 0.3];
const RES = NAT.map((v, i) => v * (0.95 - (0.5 * i) / 9));
const pctSource = (over: Partial<EwrDailySource> = {}): EwrDailySource => ({ ...tabSource(), method: 'percentile', naturalPctM3s: twelve(NAT), reservePctM3s: twelve(RES), ...over });

describe('a run with each source', () => {
	const pragmatic = run(network({}));

	it('pragmatic is the default: the same run, byte for byte, absent, null, or chosen with tables kept', () => {
		for (const ewrDailySource of [null, blankEwrDailySource(), { ...pctSource(), method: 'pragmatic' as const }]) {
			expect(JSON.stringify(run(network({ ewrDailySource })))).toBe(JSON.stringify(pragmatic));
		}
		expect(pragmatic.summary.catchment.outletEwr).toBeUndefined();
		expect(pragmatic.series.find((s) => s.key === 'ewr')!.label).toBe('Pragmatic EWR');
	});

	it('TAB scaled by MAR: the month’s TAB flow × s × 86 400, with s, its inputs and the method in the summary and a warning', () => {
		const out = run(network({ ewrDailySource: tabSource() }));
		const info = out.summary.catchment.outletEwr!;
		expect(info).toMatchObject({ method: 'tab', scaling: 'mar', tableMarMm3: 4 * MODEL_MAR });
		expect(info.scale).toBeCloseTo(0.25, 12);
		expect(info.modelMarMm3).toBeCloseTo(MODEL_MAR, 9);
		const ewr = col(out, null, 'ewr')!;
		for (let t = 0; t < DAYS; t++) expect(ewr[t]).toBeCloseTo(TAB[wy(t)]! * info.scale * DAY, 6);
		expect(out.series.find((s) => s.key === 'ewr')!.label).toBe(OUTLET_EWR_LABELS.tab);
		expect(out.summary.warnings.find((w) => w.startsWith('the daily EWR at the outlet comes from the DRM TAB file'))).toMatch(/s = 0\.25 \(the model's natural MAR at the outlet, [\d.]+ Mm³\/a, ÷ the table's [\d.]+ Mm³\/a\)/);
	});

	it('TAB scaled by area: the units’ areas (4 km²) ÷ the table’s (16 km²)', () => {
		const out = run(network({ ewrDailySource: tabSource({ scaling: 'area' }) }));
		expect(out.summary.catchment.outletEwr).toEqual({ method: 'tab', scaling: 'area', scale: 0.25, modelAreaKm2: 4, tableAreaKm2: 16 });
		expect(col(out, null, 'ewr')![100]).toBeCloseTo(TAB[wy(100)]! * 0.25 * DAY, 6);
	});

	it('TAB scaled by area, with a catchment area set: the area the natural flow is made on, not the units’ sum', () => {
		const out = run(network({ ewrDailySource: tabSource({ scaling: 'area' }), calibration: { rainThresholdMm: 2, catchmentAreaKm2: 8 } }));
		expect(out.summary.catchment.outletEwr).toEqual({ method: 'tab', scaling: 'area', scale: 0.5, modelAreaKm2: 8, tableAreaKm2: 16 });
	});

	it('percentile tables: each day read at that day’s natural flow (m³/s), on the rows × s', () => {
		const out = run(network({ ewrDailySource: pctSource() }));
		const s = out.summary.catchment.outletEwr!.scale;
		expect(s).toBeCloseTo(0.25, 12);
		const ewr = col(out, null, 'ewr')!;
		const nat = NAT.map((v) => v * s);
		const res = RES.map((v) => v * s);
		let between = 0;
		for (let t = 0; t < DAYS; t++) {
			const q = natural[t]! / DAY;
			if (q < nat[0]! && q > nat[9]!) between++;
			expect(ewr[t]).toBeCloseTo(percentileReserveM3s(q, nat, res) * DAY, 6);
		}
		// Positive control: the natural flow crosses the table, so most days interpolate.
		expect(between).toBeGreaterThan(DAYS / 2);
		expect(out.series.find((x) => x.key === 'ewr')!.label).toBe(OUTLET_EWR_LABELS.percentile);
	});

	it('everything downstream follows the series: the outlet shortfall is the outflow against it', () => {
		const out = run(network({ ewrDailySource: pctSource() }));
		const ewr = col(out, null, 'ewr')!;
		const q = col(out, null, 'simulated_outflow')!;
		const short = col(out, null, 'ewr_shortfall')!;
		let notMet = 0;
		for (let t = 0; t < DAYS; t++) {
			const d = q[t]! - ewr[t]!;
			if (Math.abs(d) <= 1e-12 * Math.max(q[t]!, ewr[t]!)) continue;
			if (d < 0) notMet++;
			expect(short[t]).toBeCloseTo(Math.min(d, 0), 6);
		}
		expect(out.summary.catchment.ewrDaysNotMet).toBe(notMet);
		expect(notMet).toBeGreaterThan(0);
		expect(out.summary.catchment.ewrDaysNotMet).not.toBe(pragmatic.summary.catchment.ewrDaysNotMet);
	});

	it('the units’ fragmented EWRs add up to the outlet’s every day, with a non-zero EWR on most days (positive control)', () => {
		for (const src of [tabSource(), pctSource(), tabSource({ scaling: 'area' })]) {
			const out = run(network({ ewrDailySource: src }));
			const ewr = col(out, null, 'ewr')!;
			const a = col(out, 'a', 'ewr')!;
			const b = col(out, 'b', 'ewr')!;
			let positive = 0;
			for (let t = 0; t < DAYS; t++) {
				expect(a[t]! + b[t]!).toBeCloseTo(ewr[t]!, 6);
				if (ewr[t]! > 0) positive++;
			}
			expect(positive).toBeGreaterThan(DAYS * 0.9);
			// And the outlet's cumulative requirement is the whole EWR.
			expect(col(out, 'out', 'ewr_cumulative')![200]).toBeCloseTo(ewr[200]!, 6);
		}
	});

	it('an unusable source runs the pragmatic EWR with a warning', () => {
		const out = run(network({ ewrDailySource: tabSource({ tabM3s: null }) }));
		expect(col(out, null, 'ewr')).toEqual(col(pragmatic, null, 'ewr'));
		expect(out.summary.catchment.outletEwr).toBeUndefined();
		expect(out.summary.warnings.some((w) => w.startsWith('daily EWR source ignored'))).toBe(true);
	});

	it('a scale above 1 or of 0 warns', () => {
		const big = run(network({ ewrDailySource: tabSource({ scaling: 'area', tableAreaKm2: 2 }) }));
		expect(big.summary.warnings.some((w) => w.startsWith("the daily EWR's scale factor is above 1 (2.000)"))).toBe(true);
		const dry = runModelWith(network({ ewrDailySource: tabSource() }), () => ({ naturalFlowM3Day: new Array(DAYS).fill(0) }));
		expect(dry.summary.catchment.outletEwr!.scale).toBe(0);
		expect(dry.summary.warnings.some((w) => w.startsWith('the daily EWR at the outlet is 0 on every day'))).toBe(true);
	});

	it('run comparison names the change of source', () => {
		const snap = (x: ModelInput) => ({ settings: x.settings, model: x.model, series: {} }) as never;
		const a = snap(network({}));
		const changes = diffInputs(a, snap(network({ ewrDailySource: tabSource() })));
		expect(changes.map((c) => c.text)).toContain('Daily EWR at the outlet: the pragmatic EWR → the DRM TAB file');
		expect(diffInputs(a, snap(network({ ewrDailySource: blankEwrDailySource() })))).toEqual([]);
	});
});

describe('the natural flow the tables read, with bed losses on', () => {
	it('is the natural flow at the outlet net of the natural losses, as a rule table at the outlet reads it', () => {
		const input = network({ ewrDailySource: pctSource({ scaling: 'area' }) });
		input.model.nodes = input.model.nodes.map((n) => (n.id === 'a' ? { ...n, reachLossFrac: 0.4 } : n));
		const out = runModelWith(input, () => ({ naturalFlowM3Day: natural }));
		const prep = prepareRun(input);
		const nat = Float64Array.from(natural);
		const { plan, topo } = buildNetworkPlan(input, prep.settings, prep.days, prep.month, prep.aligned, nat, [], prep.start);
		const at = naturalAtOutlet(plan, topo.outflow, nat)!;
		expect(at).not.toBeNull();
		// Positive control: the losses take something off the natural flow.
		expect(at[50]!).toBeLessThan(natural[50]! * 0.95);
		const ewr = col(out, null, 'ewr')!;
		const s = out.summary.catchment.outletEwr!.scale;
		for (const t of [0, 50, 400, 900]) {
			expect(ewr[t]).toBeCloseTo(percentileReserveM3s(at[t]! / DAY, NAT.map((v) => v * s), RES.map((v) => v * s)) * DAY, 6);
		}
	});
});

describe('the scale factor in a resumed run and in calibration', () => {
	const withSource = (src: EwrDailySource) => {
		const x = testCatchment({ dailyApan: true });
		x.settings.ewrDailySource = src;
		return x;
	};

	it('a resumed run keeps the capture run’s scale factor (MAR over the whole record), so every series is the uninterrupted run’s to the bit', () => {
		const input = withSource(pctSource({ tableMarMm3: 3 }));
		const full = runModelWithoutChecks(input);
		expect(full.summary.catchment.outletEwr!.scaling).toBe('mar');
		const k = toEpochDay('2009-05-17') - toEpochDay(full.startDate);
		expect(checkResume(input, k, full)).toBeNull();
	});

	it('calibration reads the EWR off each candidate’s natural flow, as the run on it does', () => {
		// River diversions that leave the EWR in the river, so the outflow depends on the EWR.
		const calibrated = (src: EwrDailySource | null) => {
			const input = withSource(src ?? blankEwrDailySource());
			input.model.nodes = input.model.nodes.map((n) => (n.kind === 'farm' ? { ...n, pctUpstreamToDam: 0, divertCapacityM3Day: 20_000, handsOffEwr: true } : n));
			const rain = input.series.rain_catchment_mm!;
			input.series.flow_observed_m3s = { startDate: rain.startDate, values: rain.values.map((r, t) => 0.05 + (r ?? 0) / 50 + (t % 7) / 100) };
			return input;
		};
		const input = calibrated(pctSource({ tableMarMm3: 3 }));
		const problem = prepareCalibration(input);
		const sim = problem.simulate({ ...problem.startParams });
		const outflow = col(runModelWithoutChecks(input), null, 'simulated_outflow')!;
		const last = problem.scoredDays[problem.scoredDays.length - 1]!;
		for (let t = 0; t <= last; t++) expect(sim[t]).toBeCloseTo(outflow[t]!, 6);
		// Positive control: on the pragmatic EWR the outflow differs, so the EWR reaches it.
		const pragmatic = col(runModelWithoutChecks(calibrated(null)), null, 'simulated_outflow')!;
		expect(pragmatic.some((v, t) => Math.abs(v - outflow[t]!) > 1)).toBe(true);
	});
});

it('EWR_PERCENTILE_POINTS are the DRM’s ten points', () => {
	expect(EWR_PERCENTILE_POINTS).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99]);
});
