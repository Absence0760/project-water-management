// The reference gauge's monthly factors on every unit's CHIRPS (settings.unitRain.reference,
// engine ≥ 1.80.0, docs/model.md §2.4h *Reference gauge*, issue #500): the fit, its minimums
// and clamps, how every unit's CHIRPS takes it (then × unit MAP ÷ the reference unit's MAP,
// provisional decision 1a), the off switch, pinning, provenance and the paths that copy inputs.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { fitRecordFromReport, fitRecordStatus } from '../calibrate/provenance';
import { calibrate } from '../calibrate/calibrate';
import { diffInputs } from '../compare';
import { fromEpochDay, monthOfEpochDay, toEpochDay } from '../calendar';
import { referenceCellSeriesKey, resolveUnitRain, unitRainError, type ModelInput, type UnitRainSettings } from '../project';
import { prepareRun } from '../prepare';
import { runModel } from '../run';
import { checkInvariants } from '../testing/invariants';
import { checkResume } from '../testing/warmstartInvariants';
import { applyScenario } from '../scenario/overrides';
import { sensitivityPlan } from '../uncertainty/sensitivity';
import { SENSITIVITY_RANGES } from '../uncertainty/sensitivityVerdict';
import { ensembleContext, resolveEnsembleOptions } from '../uncertainty/ensemble';
import { referenceFit, unitRainFingerprintChanged, unitRainFingerprintError, unitRainFingerprintOfSummary } from './unitRain';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const START = '2015-01-01';
const D0 = toEpochDay(START);
const DAYS = toEpochDay('2021-01-01') - D0; // six whole calendar years
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));
const monthOf = (i: number) => monthOfEpochDay(D0 + i);
const yearOf = (i: number) => Number(fromEpochDay(D0 + i).slice(0, 4));

/**
 * A gauge with four land units above it (A–D) and a no-area farm E; the
 * catchment gauge over six calendar years. Every land unit has its own CHIRPS;
 * no gauge MAP, so the units run on rule 3 (their CHIRPS) throughout.
 */
function catchment(unitRain: UnitRainSettings | null | 'absent'): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const unit = (id: string, areaKm2: number, mapMm?: number) => ({ ...node, id, name: `Unit ${id}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2, ...(mapMm ? { mapMm, mapSource: 'invented' } : {}) });
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...(unitRain !== 'absent' ? { unitRain } : {}) },
		model: {
			nodes: [{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }, unit('A', 10, 3000), unit('B', 6, 900), unit('C', 3, 600), unit('D', 1.5), unit('E', 0, 500)],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 100_000 }],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: rainOf(1) },
			flow_observed_m3s: { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) },
			['rain_chirps_mm@A' as never]: { startDate: START, values: rainOf(0.7, 1) },
			['rain_chirps_mm@B' as never]: { startDate: START, values: rainOf(0.6, 2) },
			['rain_chirps_mm@C' as never]: { startDate: START, values: rainOf(0.5, 0) },
			['rain_chirps_mm@D' as never]: { startDate: START, values: rainOf(0.4, 3) }
		}
	};
}

/**
 * The reference cell under C: the gauge × 0.5 (factor 2), except July × 0.2
 * (factor 5, clamped to 4), March × 0.01 (under 50 mm of CHIRPS: factor 1),
 * and February blank in four of the six years (under 90 shared days: factor 1).
 */
const cellValues = (): (number | null)[] =>
	rainOf(1).map((g, i) => {
		const m = monthOf(i);
		if (m === 2 && yearOf(i) <= 2018) return null;
		return g * (m === 7 ? 0.2 : m === 3 ? 0.01 : 0.5);
	});

const REF = { gauge: 'rain_catchment_mm', unitId: 'C' };
function withReference(ref: UnitRainSettings['reference'] = REF): ModelInput {
	const x = catchment({ mode: 'perUnit', reference: ref });
	(x.series as Record<string, unknown>)[referenceCellSeriesKey('C')] = { startDate: START, values: cellValues() };
	return x;
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
const unitOf = (out: Out, id: string) => out.summary.unitRain!.units.find((u) => u.nodeId === id)!;
const chirpsOf = (x: ModelInput, id: string) => x.series[`rain_chirps_mm@${id}` as never]!.values as number[];

describe('the reference fit (§2.4h Reference gauge)', () => {
	const out = runModel(withReference());
	const fit = out.summary.unitRain!.reference!;

	it('fits each calendar month as Σ gauge ÷ Σ CHIRPS over the days both have a reading', () => {
		expect(fit).toMatchObject({ gauge: 'rain_catchment_mm', unitId: 'C', unitName: 'Unit C', mapMm: 600, cellKey: 'rain_chirps_cell_mm@C', pinned: false });
		const cell = cellValues();
		const gauge = rainOf(1);
		for (const m of [1, 4, 6, 10, 12]) {
			let n = 0;
			let g = 0;
			let c = 0;
			for (let i = 0; i < DAYS; i++)
				if (monthOf(i) === m && cell[i] !== null) {
					n++;
					g += gauge[i]!;
					c += cell[i]!;
				}
			const x = fit.months[m - 1]!;
			expect(x).toMatchObject({ month: m, sharedDays: n, fitted: true, clamped: false });
			expect(x.gaugeMm).toBeCloseTo(g, 9);
			expect(x.chirpsMm).toBeCloseTo(c, 9);
			expect(x.factor).toBeCloseTo(2, 12);
		}
	});

	it('clamps a factor past 0.25–4 and warns', () => {
		expect(fit.months[6]).toMatchObject({ month: 7, factor: 4, clamped: true, fitted: true });
		expect(fit.months[6]!.ownFactor).toBeCloseTo(5, 9);
		expect(out.summary.warnings.some((w) => /reference factor for Jul is 5 \(.*\), outside 0\.25–4; using 4 \(clamped\)/.test(w))).toBe(true);
	});

	it('a month under 90 shared days or 50 mm of CHIRPS takes 1, and the run names it', () => {
		expect(fit.months[1]).toMatchObject({ month: 2, factor: 1, ownFactor: null, fitted: false });
		expect(fit.months[1]!.sharedDays).toBeLessThan(90);
		expect(fit.months[1]!.chirpsMm).toBeGreaterThan(50);
		expect(fit.months[2]).toMatchObject({ month: 3, factor: 1, ownFactor: null, fitted: false });
		expect(fit.months[2]!.sharedDays).toBeGreaterThanOrEqual(90);
		expect(fit.months[2]!.chirpsMm).toBeLessThan(50);
		expect(out.summary.warnings.some((w) => /too little in common in Feb, Mar .* so those months’ factors are 1/.test(w))).toBe(true);
	});

	it('exactly 90 shared days and 50 mm fit; one day fewer does not', () => {
		// January of one year only: 31 days, so three Januaries of a gauge at 2 mm a day give 93 days and 186 mm.
		const base = withReference();
		const gaugeDays = Array.from({ length: DAYS }, (_, i) => (monthOf(i) === 1 ? 2 : 0));
		base.series.rain_catchment_mm = { startDate: START, values: gaugeDays };
		const cell = Array.from({ length: DAYS }, (_, i): number | null => (monthOf(i) === 1 && yearOf(i) <= 2017 ? 50 / 90 : null));
		const keep = (k: number) => {
			let left = k;
			return cell.map((v) => (v === null ? null : left-- > 0 ? v : null));
		};
		const fitOf = (vals: (number | null)[]) => {
			const x = structuredClone(base);
			(x.series as Record<string, unknown>)['rain_chirps_cell_mm@C'] = { startDate: START, values: vals };
			return referenceFit(x.settings.unitRain, x.series, x.model.nodes, [])!.months[0]!;
		};
		const at90 = fitOf(keep(90));
		expect(at90.sharedDays).toBe(90);
		expect(at90.chirpsMm).toBeCloseTo(50, 9);
		expect(at90.fitted).toBe(true);
		expect(fitOf(keep(89)).fitted).toBe(false);
	});

	it('negative values and blanks are not readings; the fit reads the whole stored records, not the run window', () => {
		const x = withReference();
		const cell = (x.series as Record<string, { values: (number | null)[] }>)['rain_chirps_cell_mm@C']!.values;
		const plain = referenceFit(x.settings.unitRain, x.series, x.model.nodes, [])!;
		const days = plain.months[0]!.sharedDays;
		const firstJan = cell.findIndex((v, i) => monthOf(i) === 1 && v !== null);
		cell[firstJan] = -9999;
		expect(referenceFit(x.settings.unitRain, x.series, x.model.nodes, [])!.months[0]!.sharedDays).toBe(days - 1);
		const short = withReference();
		short.settings.simulationStart = '2019-01-01';
		short.settings.simulationEnd = '2019-12-31';
		expect(runModel(short).summary.unitRain!.reference!.months).toEqual(fit.months);
	});

	it('with no gauge or no cell series every month is 1, and the run says which is missing', () => {
		const x = withReference({ gauge: 'rain_catchment_mm@D', unitId: 'C' });
		const w: string[] = [];
		const f = referenceFit(x.settings.unitRain, x.series, x.model.nodes, w)!;
		expect(f.months.every((m) => m.factor === 1 && !m.fitted && m.sharedDays === 0)).toBe(true);
		expect(w.join('\n')).toMatch(/every month .*there is no rain_catchment_mm@D series/);
		const y = catchment({ mode: 'perUnit', reference: REF });
		const w2: string[] = [];
		referenceFit(y.settings.unitRain, y.series, y.model.nodes, w2);
		expect(w2.join('\n')).toMatch(/no CHIRPS at the reference unit's cell \(rain_chirps_cell_mm@C\)/);
	});
});

describe('every unit’s CHIRPS takes the reference factors, then its MAP ÷ the reference unit’s MAP', () => {
	const x = withReference();
	const out = runModel(x);
	const factors = out.summary.unitRain!.reference!.months.map((m) => m.factor);

	it('rain_unit is CHIRPS × factor(month) × clamp(unit MAP ÷ reference MAP), on every unit', () => {
		const ratio: Record<string, number> = { A: 4, B: 1.5, C: 1, D: 1 };
		for (const id of ['A', 'B', 'C', 'D']) {
			const u = unitOf(out, id);
			expect(u.rule, id).toBe('unitChirps');
			expect(u.factorSource, id).toBe('chirpsReference');
			expect(u.factor, id).toBeNull();
			expect(u.chirps).toMatchObject({ source: 'reference', factors, mapRatio: ratio[id] });
			const rain = col(out, 'rain_unit', id);
			const ch = chirpsOf(x, id);
			for (let i = 0; i < DAYS; i++) expect(rain[i], `${id} day ${i}`).toBe(ch[i]! * factors[monthOf(i) - 1]! * ratio[id]!);
		}
	});

	it('a MAP ratio past the clamp is clamped and warns; a unit without a MAP takes the factors alone, and says so', () => {
		expect(unitOf(out, 'A').chirps).toMatchObject({ mapOwnRatio: 5, mapClamped: true });
		expect(out.summary.warnings).toContain('unit rain: "Unit A": its MAP ÷ the reference unit\'s MAP is 5 (3000 ÷ 600 mm), outside 0.25–4; using 4 (clamped)');
		expect(unitOf(out, 'D').chirps).toMatchObject({ mapOwnRatio: null, mapRatio: 1, mapClamped: false });
		expect(out.summary.warnings).toContain('unit rain: "Unit D": it has no MAP, so its CHIRPS takes the reference factors without a MAP ratio');
	});

	it('the reference unit without a MAP: no unit takes a MAP ratio, with one warning', () => {
		const y = withReference();
		const c = y.model.nodes.find((n) => n.id === 'C')!;
		delete c.mapMm;
		delete c.mapSource;
		const o = runModel(y);
		for (const id of ['A', 'B', 'C', 'D']) expect(unitOf(o, id).chirps, id).toMatchObject({ source: 'reference', mapRatio: 1, mapOwnRatio: null });
		expect(o.summary.warnings.filter((w) => /has no MAP, so no unit's CHIRPS is scaled by its MAP ÷ the reference unit's MAP/.test(w))).toHaveLength(1);
		expect(o.summary.unitRain!.reference!.mapMm).toBeNull();
	});

	it('it levels a gauge unit’s backup CHIRPS too, and leaves rule 2’s gauge × MAP ratio alone', () => {
		const y = withReference();
		y.settings.unitRain = { mode: 'perUnit', gaugeMapMm: 500, gaugeMapSource: 'invented', reference: REF };
		const gauge = rainOf(1.3, 2) as (number | null)[];
		for (const t of [10, 11, 400]) gauge[t] = null;
		(y.series as Record<string, unknown>)['rain_catchment_mm@D'] = { startDate: START, values: gauge };
		const o = runModel(y);
		expect(unitOf(o, 'D').rule).toBe('unitGauge');
		expect(unitOf(o, 'B').rule).toBe('gaugeMap');
		const d = col(o, 'rain_unit', 'D');
		for (const t of [10, 11, 400]) expect(d[t]).toBe(chirpsOf(y, 'D')[t]! * factors[monthOf(t) - 1]! * 1);
		const b = col(o, 'rain_unit', 'B');
		expect(b[0]).toBe(rainOf(1)[0]! * (900 / 500));
	});

	it('passes the run’s invariants and self-checks', () => {
		expect(checkInvariants(x, out)).toBeNull();
	});

	it('pinned factors replace the fit', () => {
		const pinned = Array.from({ length: 12 }, (_, m) => 0.5 + m * 0.1);
		const o = runModel(withReference({ ...REF, pinnedFactors: pinned }));
		expect(o.summary.unitRain!.reference!.pinned).toBe(true);
		expect(o.summary.unitRain!.reference!.months.map((m) => m.factor)).toEqual(pinned);
		expect(unitOf(o, 'B').chirps).toMatchObject({ source: 'reference', factors: pinned });
	});

	it('resumes from a snapshot to the bit', () => {
		for (const k of [0, 500, 1800]) expect(checkResume(x, k)).toBeNull();
	});
});

describe('off is unchanged', () => {
	it('without a reference the run is the same to the bit, the cell series in the input or not', () => {
		const plain = runModel(catchment({ mode: 'perUnit' }));
		for (const ref of [undefined, null]) {
			const y = withReference();
			if (ref === undefined) delete y.settings.unitRain!.reference;
			else y.settings.unitRain!.reference = null;
			expect(JSON.stringify(runModel(y))).toBe(JSON.stringify(plain));
		}
		expect(plain.summary.unitRain).not.toHaveProperty('reference');
		expect(unitOf(plain, 'B').chirps!.source).toBe('map');
	});

	it('a reference unit that is not a land unit warns and levels the CHIRPS as without one', () => {
		const plain = runModel(catchment({ mode: 'perUnit' }));
		for (const unitId of ['E', 'G', 'nowhere']) {
			const o = runModel(withReference({ gauge: 'rain_catchment_mm', unitId }));
			expect(JSON.stringify(o.series), unitId).toBe(JSON.stringify(plain.series));
			expect(o.summary.unitRain).not.toHaveProperty('reference');
			expect(o.summary.warnings.some((w) => /the reference unit .* is not a unit with land/.test(w)), unitId).toBe(true);
		}
	});

	it('per-unit rain off ignores a reference', () => {
		const plain = runModel(catchment('absent'));
		const y = withReference();
		y.settings.unitRain = { mode: 'catchment', reference: REF };
		expect(JSON.stringify(runModel(y))).toBe(JSON.stringify(plain));
	});
});

describe('the setting', () => {
	it('unitRainError: the gauge is the catchment gauge or a unit’s, the unit is named, pinned factors are 12 within the clamp', () => {
		const ok = (reference: unknown) => unitRainError({ mode: 'perUnit', reference });
		expect(ok(REF)).toBeNull();
		expect(ok({ gauge: 'rain_catchment_mm@C', unitId: 'C' })).toBeNull();
		expect(ok(null)).toBeNull();
		expect(ok({ gauge: 'rain_chirps_mm', unitId: 'C' })).toMatch(/reference gauge/);
		expect(ok({ gauge: 'rain_catchment_mm@', unitId: 'C' })).toMatch(/reference gauge/);
		expect(ok({ gauge: 'rain_catchment_mm', unitId: '' })).toMatch(/its unit/);
		expect(ok({ gauge: 'rain_catchment_mm' })).toMatch(/its unit/);
		expect(ok('C')).toMatch(/a gauge and a unit/);
		expect(ok({ ...REF, pinnedFactors: [1, 2] })).toMatch(/12 numbers/);
		expect(ok({ ...REF, pinnedFactors: Array(12).fill(5) })).toMatch(/12 numbers/);
		expect(resolveUnitRain({ mode: 'perUnit' }, [])).not.toHaveProperty('reference');
		expect(resolveUnitRain({ mode: 'perUnit', reference: REF }, [])!.reference).toEqual(REF);
	});

	it('run comparison names the reference, once', () => {
		const a = withReference();
		const b = withReference({ gauge: 'rain_catchment_mm', unitId: 'B' });
		const changes = diffInputs({ settings: a.settings, model: a.model, series: {} } as never, { settings: b.settings, model: b.model, series: {} } as never).map((c) => c.text);
		expect(changes).toEqual([
			'Runoff from each unit’s own rain: on (no gauge MAP; MAP period 1991-01-01 to 2020-12-31; reference gauge rain_catchment_mm at the unit C) → on (no gauge MAP; MAP period 1991-01-01 to 2020-12-31; reference gauge rain_catchment_mm at the unit B)'
		]);
	});

	it('the fit fingerprint records the reference and the monthly factors; a moved factor or another reference is a change', () => {
		const out = runModel(withReference());
		const fp = unitRainFingerprintOfSummary(out.summary.unitRain)!;
		expect(fp.reference).toEqual(REF);
		expect(fp.units.find((u) => u.nodeId === 'B')).toMatchObject({ chirpsSource: 'reference', chirpsFactor: 1.5, factorSource: 'chirpsReference' });
		expect(unitRainFingerprintError(JSON.parse(JSON.stringify(fp)))).toBeNull();
		const moved = structuredClone(fp);
		moved.units[1]!.chirpsFactors![5] = moved.units[1]!.chirpsFactors![5]! * 1.05;
		expect(unitRainFingerprintChanged(fp, moved)).toBe(true);
		const near = structuredClone(fp);
		near.units[1]!.chirpsFactors![5] = near.units[1]!.chirpsFactors![5]! * 1.01;
		expect(unitRainFingerprintChanged(fp, near)).toBe(false);
		expect(unitRainFingerprintChanged(fp, { ...fp, reference: { gauge: 'rain_catchment_mm', unitId: 'B' } })).toBe(true);
		expect(unitRainFingerprintChanged(fp, { ...structuredClone(fp), reference: undefined })).toBe(true);
	});

	it('a fit under a reference reads "forcing changed" when the reference is removed', () => {
		const x = withReference();
		const settings = prepareRun(x).settings;
		const ctx = { settings, validate: false, validationRecord: null, engineVersion: 'test', fittedAt: '2026-10-10T00:00:00Z' };
		const record = fitRecordFromReport(calibrate(x, { budget: 6, seed: 1 }), ctx);
		expect(record.forcing!.unitRain!.reference).toEqual(REF);
		expect(fitRecordStatus(settings, record).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...settings, unitRain: { mode: 'perUnit' } }, record).forcingChanged).toBe(true);
		expect(fitRecordStatus({ ...settings, unitRain: { mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: 'B' } } }, record).forcingChanged).toBe(true);
	});
});

describe('paths that copy the input', () => {
	it('the rain sensitivity scales the reference cell with the gauge, so every unit’s rain moves by its factor', () => {
		const input = withReference();
		const central = runModel(input);
		const plan = sensitivityPlan(input, central, SENSITIVITY_RANGES).plans.find((p) => p.factor === 'rain')!;
		const k = plan.high.setting;
		const high = runModel(plan.high.adjust!(applyScenario(input, plan.high.ops).input));
		expect(high.summary.unitRain!.reference!.months.map((m) => m.factor)).toEqual(central.summary.unitRain!.reference!.months.map((m) => m.factor));
		for (const u of central.summary.unitRain!.units) expect(unitOf(high, u.nodeId).rainMm, u.nodeId).toBeCloseTo(u.rainMm * k, 6);
	});

	it('the ensemble’s CHIRPS-only member pins the base input’s reference factors (it has no gauge to fit on)', () => {
		const input = withReference();
		(input.series as Record<string, unknown>).rain_chirps_mm = { startDate: START, values: rainOf(0.6) };
		const base = runModel(input);
		const { options } = resolveEnsembleOptions(input, { members: 30, rainSources: ['recorded', 'chirps'] });
		const ctx = ensembleContext(input, options);
		expect(ctx.chirps!.series.rain_catchment_mm).toBeUndefined();
		const member = runModel(ctx.chirps!);
		expect(member.summary.unitRain!.reference!.pinned).toBe(true);
		expect(unitOf(member, 'B').chirps).toEqual(unitOf(base, 'B').chirps);
	});
});
