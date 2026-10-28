// The reference gauge's monthly factors on every unit's CHIRPS (settings.unitRain.reference,
// engine ≥ 1.80.0, docs/model.md §2.4h *Reference gauge*, issue #500): the fit, its minimums
// and clamps, how every unit's CHIRPS takes it (then × k_unit, the rescale to the unit's own
// MAP, decision 1a, engine ≥ 1.85.0), the 0.5–2 warning band (decision 2), a CHIRPS-GEFS
// forecast levelled per unit (decision 5), the off switch, pinning, provenance and the paths
// that copy inputs.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { fitRecordFromReport, fitRecordStatus } from '../calibrate/provenance';
import { calibrate } from '../calibrate/calibrate';
import { diffInputs } from '../compare';
import { fromEpochDay, monthOfEpochDay, toEpochDay } from '../calendar';
import { AREAL_RAIN_FACTOR_MAX, AREAL_RAIN_FACTOR_MIN, referenceCellSeriesKey, resolveUnitRain, unitRainError, type ModelInput, type UnitChirpsLevel, type UnitRainSettings } from '../project';
import { prepareRun } from '../prepare';
import { runModel } from '../run';
import { checkInvariants } from '../testing/invariants';
import { checkResume } from '../testing/warmstartInvariants';
import { applyScenario } from '../scenario/overrides';
import { sensitivityPlan } from '../uncertainty/sensitivity';
import { SENSITIVITY_RANGES } from '../uncertainty/sensitivityVerdict';
import { ensembleContext, resolveEnsembleOptions } from '../uncertainty/ensemble';
import { checkForecastPrefix } from '../testing/forecastInvariants';
import { chirpsMeanAnnual, referenceFit, unitRainFingerprintChanged, unitRainFingerprintError, unitRainFingerprintOfSummary } from './unitRain';

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
	const node = { sortOrder: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
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
		expect(fit).toMatchObject({ gauge: 'rain_catchment_mm', unitId: 'C', unitName: 'Unit C', mapMm: 600, cellKey: 'rain_chirps_cell_mm@C', cellReason: 'referenceUnitCentre', pinned: false });
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
		expect(fit.months[6]).toMatchObject({ month: 7, factor: 4, clamped: true, fitted: true, outsideBand: true });
		expect(fit.months[6]!.ownFactor).toBeCloseTo(5, 9);
		expect(out.summary.warnings.some((w) => /reference factor for Jul is 5 \(.*\), outside 0\.25–4; using 4 \(clamped\)/.test(w))).toBe(true);
	});

	it('a fitted factor outside 0.5–2 but inside 0.25–4 warns and is used as it is; one inside the band is quiet', () => {
		// The cell × 0.5 everywhere fits 2 (on the band's edge: inside); a cell × (1 ÷ 2.5) in October fits 2.5.
		const x = withReference();
		const cell = (x.series as Record<string, { values: (number | null)[] }>)['rain_chirps_cell_mm@C']!.values;
		const g = rainOf(1);
		for (let i = 0; i < DAYS; i++) if (monthOf(i) === 10) cell[i] = g[i]! / 2.5;
		for (let i = 0; i < DAYS; i++) if (monthOf(i) === 11) cell[i] = g[i]! / 0.4;
		const w: string[] = [];
		const f = referenceFit(x.settings.unitRain, x.series, x.model.nodes, w)!;
		expect(f.months[9]).toMatchObject({ month: 10, clamped: false, outsideBand: true, fitted: true });
		expect(f.months[9]!.factor).toBeCloseTo(2.5, 9);
		expect(f.months[9]!.factor).toBe(f.months[9]!.ownFactor);
		expect(f.months[10]).toMatchObject({ month: 11, clamped: false, outsideBand: true });
		expect(f.months[10]!.factor).toBeCloseTo(0.4, 9);
		expect(f.months[0]).toMatchObject({ month: 1, outsideBand: false, clamped: false });
		expect(w.filter((m) => /reference factor for Oct is 2\.5 \(.*\), outside 0\.5–2: used as it is/.test(m))).toHaveLength(1);
		expect(w.filter((m) => /reference factor for Nov is 0\.4 \(.*\), outside 0\.5–2: used as it is/.test(m))).toHaveLength(1);
		expect(w.some((m) => /reference factor for Jan/.test(m))).toBe(false);
		// The unfitted months take 1 and are never outside the band; pinned factors never warn.
		expect(f.months[1]).toMatchObject({ fitted: false, outsideBand: false });
		const w2: string[] = [];
		const pinned = referenceFit({ ...x.settings.unitRain!, reference: { ...REF, pinnedFactors: Array(12).fill(3) } }, x.series, x.model.nodes, w2)!;
		expect(pinned.months.every((m) => !m.outsideBand && !m.clamped)).toBe(true);
		expect(w2).toEqual([]);
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

/** A unit's reference level from a run's summary. */
const refLevel = (out: Out, id: string) => unitOf(out, id).chirps as Extract<UnitChirpsLevel, { source: 'reference' }>;
/** The mean annual of `values` × the factor of each day's month over whole calendar years 2015–2020 (the fixture's six). */
const meanAnnual = (values: readonly (number | null)[], factors: readonly number[] = Array(12).fill(1)) => {
	let mm = 0;
	for (let i = 0; i < DAYS; i++) mm += (values[i] ?? 0) * factors[monthOf(i) - 1]!;
	return mm / 6;
};

describe('every unit’s CHIRPS takes the reference factors, then k_unit: the rescale to its own MAP', () => {
	const x = withReference();
	const out = runModel(x);
	const factors = out.summary.unitRain!.reference!.months.map((m) => m.factor);

	it('rain_unit is CHIRPS × factor(month) × k_unit, k_unit = clamp(unit MAP ÷ the mean annual CHIRPS × factor), on every unit', () => {
		for (const id of ['A', 'B', 'C']) {
			const u = unitOf(out, id);
			expect(u.rule, id).toBe('unitChirps');
			expect(u.factorSource, id).toBe('chirpsReference');
			expect(u.factor, id).toBeNull();
			const k = refLevel(out, id).kUnit!;
			const mean = meanAnnual(chirpsOf(x, id), factors);
			expect(k.meanAnnualMm, id).toBeCloseTo(mean, 9);
			expect(k.ownFactor, id).toBeCloseTo(u.mapMm! / mean, 12);
			expect(k.factor, id).toBe(Math.min(AREAL_RAIN_FACTOR_MAX, Math.max(AREAL_RAIN_FACTOR_MIN, k.ownFactor)));
			// Six complete years, fewer than the ten the MAP period wants: every complete year of the record, with a warning.
			expect(k, id).toMatchObject({ years: [2015, 2016, 2017, 2018, 2019, 2020], inPeriod: false });
			expect(refLevel(out, id).factors, id).toEqual(factors);
			const rain = col(out, 'rain_unit', id);
			const ch = chirpsOf(x, id);
			for (let i = 0; i < DAYS; i++) expect(rain[i], `${id} day ${i}`).toBe(ch[i]! * factors[monthOf(i) - 1]! * k.factor);
		}
		expect(out.summary.warnings).toContain(
			'unit rain: "Unit B": its CHIRPS has fewer than 10 complete calendar years in the MAP period 1 Jan 1991 to 31 Dec 2020, so its k_unit averages every complete year of the record (6, 2015–2020, still fewer than 10)'
		);
	});

	it('k_unit makes an unclamped unit’s long-term mean annual rain its MAP, whatever its raw CHIRPS level (no double count)', () => {
		for (const id of ['A', 'B', 'C']) {
			const k = refLevel(out, id).kUnit!;
			expect(k.clamped, id).toBe(false);
			expect(meanAnnual(col(out, 'rain_unit', id)), id).toBeCloseTo(unitOf(out, id).mapMm!, 6);
		}
		// Doubling a unit's raw CHIRPS halves its k_unit and leaves its rain where it was: the level is its MAP's, not its CHIRPS's.
		const y = withReference();
		y.series['rain_chirps_mm@B' as never]!.values = chirpsOf(y, 'B').map((v) => v * 2);
		const o = runModel(y);
		expect(refLevel(o, 'B').kUnit!.factor).toBeCloseTo(refLevel(out, 'B').kUnit!.factor / 2, 12);
		const a = col(o, 'rain_unit', 'B');
		col(out, 'rain_unit', 'B').forEach((v, i) => expect(a[i]).toBeCloseTo(v, 9));
	});

	it('a clamped month is made up in the yearly total: k_unit comes after the factors', () => {
		// July's factor is held at 4 (own 5): the mean annual × f reads 4, so k_unit lifts every month to reach the MAP.
		const k = refLevel(out, 'C').kUnit!;
		expect(meanAnnual(chirpsOf(x, 'C'), factors) * k.factor).toBeCloseTo(600, 6);
	});

	it('k_unit past 0.25–4 is clamped and warns; outside 0.5–2 it warns and is used as it is', () => {
		// A: MAP 3000 over a mean annual CHIRPS × f of about 1400: k_unit about 2.1, unchanged, with the band's warning.
		const a = refLevel(out, 'A').kUnit!;
		expect(a.ownFactor).toBeGreaterThan(2);
		expect(a).toMatchObject({ clamped: false, outsideBand: true });
		expect(a.factor).toBe(a.ownFactor);
		expect(out.summary.warnings.some((w) => /^unit rain: "Unit A": its k_unit .* is 2\.\d+ \(3000 ÷ \d+ mm\), outside 0\.5–2: used as it is/.test(w))).toBe(true);
		const b = refLevel(out, 'B').kUnit!;
		expect(b).toMatchObject({ clamped: false, outsideBand: false });
		expect(out.summary.warnings.some((w) => /"Unit B": its k_unit/.test(w) && /outside/.test(w))).toBe(false);
		const y = withReference();
		y.model.nodes.find((n) => n.id === 'A')!.mapMm = 9000;
		const o = runModel(y);
		const k = refLevel(o, 'A').kUnit!;
		expect(k).toMatchObject({ factor: 4, clamped: true, outsideBand: true });
		expect(k.ownFactor).toBeGreaterThan(4);
		expect(o.summary.warnings.some((w) => /^unit rain: "Unit A": its k_unit .* \(9000 ÷ \d+ mm\), outside 0\.25–4; using 4 \(clamped\)/.test(w))).toBe(true);
	});

	it('a unit without a MAP takes the factors alone (kUnit null), and says so; the reference unit’s MAP plays no part', () => {
		expect(refLevel(out, 'D')).toMatchObject({ source: 'reference', kUnit: null });
		expect(out.summary.warnings).toContain('unit rain: "Unit D": it has no MAP, so its CHIRPS takes the reference factors without k_unit to level it');
		const rain = col(out, 'rain_unit', 'D');
		chirpsOf(x, 'D').forEach((v, i) => expect(rain[i]).toBe(v * factors[monthOf(i) - 1]!));
		const y = withReference();
		const c = y.model.nodes.find((n) => n.id === 'C')!;
		delete c.mapMm;
		delete c.mapSource;
		const o = runModel(y);
		for (const id of ['A', 'B']) expect(refLevel(o, id).kUnit, id).toEqual(refLevel(out, id).kUnit);
		expect(refLevel(o, 'C').kUnit).toBeNull();
		expect(o.summary.unitRain!.reference!.mapMm).toBeNull();
	});

	it('a unit with no complete calendar year keeps the factors without k_unit, and says so', () => {
		const y = withReference();
		const b = chirpsOf(y, 'B') as (number | null)[];
		for (const yr of [2015, 2016, 2017, 2018, 2019, 2020]) b[toEpochDay(`${yr}-06-15`) - D0] = null;
		const o = runModel(y);
		expect(refLevel(o, 'B')).toMatchObject({ source: 'reference', kUnit: null });
		expect(o.summary.warnings).toContain('unit rain: "Unit B": its CHIRPS has no complete calendar year to compare its MAP with, so it takes the reference factors without k_unit to level it');
	});

	it('with ten complete years in the MAP period k_unit averages those alone, in period; with nine every complete year, and warns', () => {
		// B's CHIRPS from 2005: sixteen whole years. A mean over 2006–2015 (ten) vs one over all sixteen differs: 2005–2009 are wetter.
		const long = (from: string) => {
			const d0 = toEpochDay(from);
			const n = toEpochDay('2021-01-01') - d0;
			return Array.from({ length: n }, (_, i) => (fromEpochDay(d0 + i) < '2010-01-01' ? 2 : 1) * ((i % 13 === 0 ? 30 : i % 4 === 0 ? 2 : 0) * 0.6));
		};
		const at = (start: string, end: string) => {
			const y = withReference();
			y.settings.unitRain!.mapPeriod = { start, end };
			y.series['rain_chirps_mm@B' as never] = { startDate: '2005-01-01', values: long('2005-01-01') };
			return runModel(y);
		};
		const ten = refLevel(at('2006-01-01', '2015-12-31'), 'B').kUnit!;
		expect(ten).toMatchObject({ years: [2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015], inPeriod: true });
		const f = at('2006-01-01', '2015-12-31').summary.unitRain!.reference!.months.map((m) => m.factor);
		const s = { startDate: '2005-01-01', values: long('2005-01-01') };
		expect(ten.meanAnnualMm).toBeCloseTo(chirpsMeanAnnual(s, { start: '2006-01-01', end: '2015-12-31' }, (d) => f[monthOfEpochDay(d) - 1]!)!.meanAnnualMm, 9);
		const nine = at('2006-01-01', '2014-12-31');
		expect(refLevel(nine, 'B').kUnit).toMatchObject({ inPeriod: false });
		expect(refLevel(nine, 'B').kUnit!.years).toHaveLength(16);
		expect(nine.summary.warnings.some((w) => /"Unit B": its CHIRPS has fewer than 10 complete calendar years in the MAP period 1 Jan 2006 to 31 Dec 2014, so its k_unit averages every complete year of the record \(16, 2005–2020\)$/.test(w))).toBe(true);
	});

	it('rule 2’s gaps on a unit with the factors but no k_unit keep its MAP ratio: no step where a gap starts or ends', () => {
		// B: MAP 900 under a gauge MAP of 500 (ratio 1.8); its CHIRPS is the gauge × 0.5 (the reference cell's level, so the
		// January factor 2 brings it back to the gauge) with a blank each June, so no complete year and no k_unit.
		const y = withReference();
		y.settings.unitRain = { mode: 'perUnit', gaugeMapMm: 500, gaugeMapSource: 'invented', reference: REF };
		const b = rainOf(0.5) as (number | null)[];
		for (const yr of [2015, 2016, 2017, 2018, 2019, 2020]) b[toEpochDay(`${yr}-06-15`) - D0] = null;
		y.series['rain_chirps_mm@B' as never] = { startDate: START, values: b };
		const gapDays = [8, 13, 26, 377, 390].filter((t) => monthOf(t) === 1);
		expect(gapDays.length).toBeGreaterThan(3);
		const gauge = y.series.rain_catchment_mm!.values;
		const g = [...gauge] as number[];
		for (const t of gapDays) gauge[t] = null;
		const o = runModel(y);
		expect(unitOf(o, 'B')).toMatchObject({ rule: 'gaugeMap', gaugeMapFactor: 1.8 });
		expect(refLevel(o, 'B').kUnit).toBeNull();
		expect(o.summary.unitRain!.reference!.months[0]!.factor).toBeCloseTo(2, 12);
		const rain = col(o, 'rain_unit', 'B');
		for (const t of gapDays) {
			expect(g[t]).toBeGreaterThan(0);
			expect(rain[t], `day ${t}`).toBeCloseTo(g[t]! * 1.8, 9);
		}
		expect(rain[1]).toBe(g[1]! * 1.8);
		// Positive control: C (MAP 600, ratio 1.2) has k_unit, which already brings it to its MAP: its gap days take f × k_unit alone.
		const c = refLevel(o, 'C').kUnit!.factor;
		for (const t of gapDays) expect(col(o, 'rain_unit', 'C')[t]).toBeCloseTo(chirpsOf(y, 'C')[t]! * 2 * c, 9);
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
		// D has no MAP: the factors alone (kUnit null).
		for (const t of [10, 11, 400]) expect(d[t]).toBe(chirpsOf(y, 'D')[t]! * factors[monthOf(t) - 1]!);
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

	it('per-unit rain off runs no reference into the flow; the EWR shares read it, as Per unit’s do (issue #615)', () => {
		const plain = runModel(catchment('absent'));
		const y = withReference();
		y.settings.unitRain = { ...y.settings.unitRain!, mode: 'catchment', reference: REF };
		const out = runModel(y);
		expect(out.series.find((s) => s.nodeId === null && s.key === 'natural_flow')!.values).toEqual(plain.series.find((s) => s.nodeId === null && s.key === 'natural_flow')!.values);
		expect(out.summary.unitRain).toBeUndefined();
		const per = runModel(withReference());
		for (const f of per.summary.farms) expect(out.summary.farms.find((g) => g.nodeId === f.nodeId)!.ewrShare, f.nodeId).toBe(f.ewrShare);
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
			'Runoff from each unit’s own rain: on (no gauge MAP; MAP period 1 Jan 1991 to 31 Dec 2020; reference gauge rain_catchment_mm at the unit C) → on (no gauge MAP; MAP period 1 Jan 1991 to 31 Dec 2020; reference gauge rain_catchment_mm at the unit B)'
		]);
	});

	it('the fit fingerprint records the reference and the monthly factors; a moved factor or another reference is a change', () => {
		const out = runModel(withReference());
		const fp = unitRainFingerprintOfSummary(out.summary.unitRain)!;
		expect(fp.reference).toEqual(REF);
		expect(fp.units.find((u) => u.nodeId === 'B')).toMatchObject({ chirpsSource: 'reference', chirpsFactor: refLevel(out, 'B').kUnit!.factor, factorSource: 'chirpsReference' });
		expect(fp.units.find((u) => u.nodeId === 'D')).toMatchObject({ chirpsSource: 'reference', chirpsFactor: null });
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

describe('the forecast on the reference factors (decision 5)', () => {
	const tail = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? 0 : 4 + i));
	const withTail = (source?: ModelInput['forecastRainSource']): ModelInput => {
		const x = withReference();
		x.series.rain_forecast_mm = { startDate: '2021-01-01', values: tail };
		return source === undefined ? x : { ...x, forecastRainSource: source };
	};

	it('a CHIRPS-GEFS forecast takes each unit’s factor(month) × k_unit, the level its CHIRPS history reads at: no step at the forecast start', () => {
		const o = runModel(withTail('chirps_gefs'));
		const factors = o.summary.unitRain!.reference!.months.map((m) => m.factor);
		for (const id of ['A', 'B', 'C', 'D']) {
			const level = factors[0]! * (refLevel(o, id).kUnit?.factor ?? 1); // January
			const rain = col(o, 'rain_unit', id);
			expect(rain.slice(DAYS), id).toEqual(tail.map((v) => v * level));
			// The last January history day with CHIRPS is levelled by the same multiplier: the forecast continues it.
			const t = DAYS - 1 - 30 + chirpsOf(withReference(), id).slice(DAYS - 31).findIndex((v) => v > 0);
			expect(monthOf(t)).toBe(12);
			const dec = factors[11]! * (refLevel(o, id).kUnit?.factor ?? 1);
			expect(rain[t]! / chirpsOf(withReference(), id)[t]!, id).toBeCloseTo(dec, 12);
			expect(unitOf(o, id).days.forecast, id).toBe(20);
		}
	});

	it('a unit on the factors without k_unit keeps its gauge MAP ratio on the forecast: factor(month) × the ratio, no step', () => {
		// B: MAP 900 under a gauge MAP of 500 (ratio 1.8, rule 2), and a CHIRPS with no complete calendar year: no k_unit.
		const x = withTail('chirps_gefs');
		x.settings.unitRain = { ...x.settings.unitRain!, gaugeMapMm: 500, gaugeMapSource: 'invented' };
		const b = chirpsOf(x, 'B') as (number | null)[];
		for (const yr of [2015, 2016, 2017, 2018, 2019, 2020]) b[toEpochDay(`${yr}-06-15`) - D0] = null;
		const o = runModel(x);
		expect(unitOf(o, 'B')).toMatchObject({ rule: 'gaugeMap', gaugeMapFactor: 1.8 });
		expect(refLevel(o, 'B').kUnit).toBeNull();
		const jan = o.summary.unitRain!.reference!.months[0]!.factor;
		col(o, 'rain_unit', 'B').slice(DAYS).forEach((v, i) => expect(v, `day ${i}`).toBeCloseTo(tail[i]! * jan * 1.8, 9));
		// C has k_unit: the level alone, not × its ratio too.
		const c = refLevel(o, 'C').kUnit!.factor;
		col(o, 'rain_unit', 'C').slice(DAYS).forEach((v, i) => expect(v, `C day ${i}`).toBeCloseTo(tail[i]! * jan * c, 9));
	});

	it('an uploaded forecast, or one of unknown source, keeps the MAP ratio (× 1 here: no gauge MAP)', () => {
		for (const source of [undefined, null, 'other'] as const) {
			const o = runModel(withTail(source));
			for (const id of ['A', 'B']) expect(col(o, 'rain_unit', id).slice(DAYS), `${id} ${source}`).toEqual(tail);
		}
	});

	it('the history is the same whatever the forecast’s source, and the forecast prefix holds', () => {
		const a = runModel(withTail('chirps_gefs'));
		const b = runModel(withTail('other'));
		for (const id of ['A', 'B', 'C', 'D']) expect(col(a, 'rain_unit', id).slice(0, DAYS), id).toEqual(col(b, 'rain_unit', id).slice(0, DAYS));
		expect(checkForecastPrefix(withTail('chirps_gefs'))).toBeNull();
	});

	it('the run’s CHIRPS-only ensemble member and the forecast keep k_unit: a member reads its unit CHIRPS at the base run’s level', () => {
		const input = withReference();
		(input.series as Record<string, unknown>).rain_chirps_mm = { startDate: START, values: rainOf(0.6) };
		const base = runModel(input);
		const { options } = resolveEnsembleOptions(input, { members: 30, rainSources: ['recorded', 'chirps'] });
		const member = runModel(ensembleContext(input, options).chirps!);
		for (const id of ['A', 'B', 'C', 'D']) expect(refLevel(member, id).kUnit, id).toEqual(refLevel(base, id).kUnit);
	});
});

describe('an unusable CHIRPS under a reference (decision 7a)', () => {
	it('is skipped to the catchment rain, not levelled to 0 mm days', () => {
		const x = withReference();
		x.series['rain_chirps_mm@B' as never]!.values = new Array(DAYS).fill(0);
		const o = runModel(x);
		expect(unitOf(o, 'B').chirps).toEqual({ source: 'unusable', meanAnnualMm: 0, years: [2015, 2016, 2017, 2018, 2019, 2020] });
		expect(unitOf(o, 'B').rule).toBe('catchment');
		expect(col(o, 'rain_unit', 'B')).toEqual(rainOf(1));
		expect(unitRainFingerprintError(JSON.parse(JSON.stringify(unitRainFingerprintOfSummary(o.summary.unitRain))))).toBeNull();
		expect(checkInvariants(x, o)).toBeNull();
	});
});
