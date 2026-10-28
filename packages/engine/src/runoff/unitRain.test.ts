// Runoff from each unit's own rain (settings.unitRain `perUnit`, engine ≥
// 1.78.0, docs/model.md §2.4h, issue #482): the forcing rule per land unit,
// GR4J per unit, the off switch, provenance and the outputs.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { calibrate, prepareCalibration } from '../calibrate/calibrate';
import { fitRecordFromReport, fitRecordStatus } from '../calibrate/provenance';
import { diffInputs } from '../compare';
import { fromEpochDay, toEpochDay } from '../calendar';
import { prepareYield } from '../network/yield';
import { prepareRun } from '../prepare';
import { type ArealRain, type ModelInput, type UnitRainSettings } from '../project';
import { runModel, runModelChecked } from '../run';
import { checkForecastPrefix, withForecastTail } from '../testing/forecastInvariants';
import { checkInvariants, checkOrderInvariance, sameOutput } from '../testing/invariants';
import { checkResume } from '../testing/warmstartInvariants';
import { applyScenario } from '../scenario/overrides';
import { sensitivityPlan, sensitivityRuns } from '../uncertainty/sensitivity';
import { SENSITIVITY_RANGES } from '../uncertainty/sensitivityVerdict';
import { ensembleContext, resolveEnsembleOptions } from '../uncertainty/ensemble';
import { validateScenarioOps } from '../scenario/ops';
import { runModelCapturing, runModelFrom } from '../run';
import { ModelStateMismatchError } from '../warmstart/snapshot';
import { randomInput, withUnitRain as withUnitRainRecords } from '../testing/fuzz';
import { gr4j } from './gr4j';
import { simulateRunoff, runoffForcing } from './simulate';
import { chirpsMeanAnnual, unitRainFingerprintChanged, unitRainFingerprintError, unitRainFingerprintOfSummary } from './unitRain';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const START = '2015-01-01';
const DAYS = toEpochDay('2021-01-01') - toEpochDay(START); // six whole calendar years
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));

/**
 * A gauge with four land units above it (A–D, no dams) and a no-area farm E.
 * Catchment gauge rain over six calendar years, observed flow at the outlet.
 * Each test adds the unit records and MAPs it needs.
 */
/** `unitRain` 'absent' leaves the setting out. */
function catchment(unitRain: UnitRainSettings | null | 'absent' = { mode: 'perUnit' }): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const unit = (id: string, areaKm2: number) => ({ ...node, id, name: `Unit ${id}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2 });
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...(unitRain !== 'absent' ? { unitRain } : {}) },
		model: {
			nodes: [{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }, unit('A', 10), unit('B', 6), unit('C', 3), unit('D', 1.5), unit('E', 0)],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 100_000 }],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: rainOf(1) },
			flow_observed_m3s: { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) }
		}
	};
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;
const unitOf = (out: Out, id: string) => out.summary.unitRain!.units.find((u) => u.nodeId === id)!;
const set = (x: ModelInput, key: string, values: (number | null)[], startDate = START) => ((x.series as Record<string, unknown>)[key] = { startDate, values });
const gaps = (v: number[]): (number | null)[] => v;

/** Every rule at once: A its own gauge (with gaps), B a MAP under a gauge MAP, C its own CHIRPS with a MAP, D nothing. */
function everyRule(): ModelInput {
	const x = catchment({ mode: 'perUnit', gaugeMapMm: 500, gaugeMapSource: 'invented gauge MAP' });
	const gauge = gaps(rainOf(1.3, 2));
	for (const t of [10, 11, 12, 400]) gauge[t] = null;
	set(x, 'rain_catchment_mm@A', gauge);
	set(x, 'rain_chirps_mm@A', rainOf(0.8, 1));
	Object.assign(x.model.nodes[2]!, { mapMm: 700, mapSource: 'invented' });
	Object.assign(x.model.nodes[3]!, { mapMm: 750, mapSource: 'invented isohyet' });
	set(x, 'rain_chirps_mm@C', rainOf(0.5, 3));
	Object.assign(x.model.nodes[4]!, { mapMm: 600, mapSource: 'invented' });
	return x;
}

describe('settings.unitRain off', () => {
	it('absent, null and catchment mode give the same output to the bit; unit records move only the EWR shares (issue #615)', () => {
		const plain = runModel(catchment('absent'));
		for (const u of [null, { mode: 'catchment' as const }, { mode: 'catchment' as const, gaugeMapMm: 500, gaugeMapSource: 'x' }]) {
			const o = runModel(catchment(u));
			const diff = o.series.find((s, i) => JSON.stringify(s) !== JSON.stringify(plain.series[i]));
			expect(diff?.key ?? null, JSON.stringify(u)).toBeNull();
			expect(JSON.stringify(o.summary.warnings)).toBe(JSON.stringify(plain.summary.warnings));
			expect(JSON.stringify(o.summary), JSON.stringify(u)).toBe(JSON.stringify(plain.summary));
			expect(JSON.stringify(o), JSON.stringify(u)).toBe(JSON.stringify(plain));
		}
		// Fragmentation reads the Per unit setup for the EWR shares only (engine ≥ 1.105.0, §2.5b): the flow is the same
		// to the bit, and each unit's EWR share is the Per unit run's.
		const withRecords = everyRule();
		withRecords.settings.unitRain = { ...withRecords.settings.unitRain!, mode: 'catchment' };
		const frag = runModel(withRecords);
		for (const key of ['natural_flow', 'rain_used', 'simulated_outflow']) expect(col(frag, key), key).toEqual(col(plain, key));
		expect(frag.summary.unitRain).toBeUndefined();
		const per = runModel(everyRule());
		for (const f of per.summary.farms) expect(frag.summary.farms.find((g) => g.nodeId === f.nodeId)!.ewrShare, f.nodeId).toBe(f.ewrShare);
		expect(frag.summary.farms.find((f) => f.nodeId === 'A')!.ewrShare).not.toBe(plain.summary.farms.find((f) => f.nodeId === 'A')!.ewrShare);
		expect(plain.summary.unitRain).toBeUndefined();
		expect(plain.series.some((s) => s.key === 'rain_unit' || s.key === 'runoff_natural')).toBe(false);
	});

	it('an unusable setting runs the catchment rain, with a warning', () => {
		const out = runModel(catchment({ mode: 'everywhere' } as never));
		expect(out.summary.unitRain).toBeUndefined();
		expect(out.summary.warnings.some((w) => /per-unit rain setting is ignored/.test(w))).toBe(true);
		expect(sameOutput({ ...out, summary: { ...out.summary, warnings: [] } }, { ...runModel(catchment('absent')), summary: { ...runModel(catchment('absent')).summary, warnings: [] } })).toBe(true);
	});

	it('perUnit with no land unit warns and runs the catchment rain', () => {
		const x = catchment();
		for (const n of x.model.nodes) n.areaKm2 = 0;
		x.settings.calibration = { rainThresholdMm: 0, catchmentAreaKm2: 20 };
		const out = runModel(x);
		expect(out.summary.unitRain).toBeUndefined();
		expect(out.summary.warnings.some((w) => /no unit has an area/.test(w))).toBe(true);
	});
});

describe('the forcing rule (§2.4h)', () => {
	const out = runModelChecked(everyRule());
	const g = everyRule().series.rain_catchment_mm!.values as number[];

	it('picks one rule per land unit, in node-id order, and leaves out the farm with no area', () => {
		expect(out.summary.unitRain!.units.map((u) => [u.nodeId, u.rule, u.factorSource])).toEqual([
			['A', 'unitGauge', 'gauge'],
			['B', 'gaugeMap', 'gaugeMap'],
			['C', 'gaugeMap', 'gaugeMap'],
			['D', 'gaugeMap', 'gaugeMap']
		]);
		expect(out.summary.verification!.checks.every((c) => c.passed)).toBe(true);
	});

	it('rule 1: the unit’s own gauge as recorded, its gaps filled by its CHIRPS', () => {
		const rain = col(out, 'rain_unit', 'A')!;
		const gauge = everyRule().series['rain_catchment_mm@A']!.values;
		expect(rain[0]).toBe(gauge[0]);
		expect(rain[13]).toBe(gauge[13]);
		// A has no MAP: its CHIRPS fills raw (the catchment has no CHIRPS to fit bias factors on).
		const chirps = everyRule().series['rain_chirps_mm@A']!.values;
		expect(rain[12]).toBe(chirps[12]);
		expect(unitOf(out, 'A').days).toMatchObject({ unitGauge: DAYS - 4, unitChirps: 4, none: 0 });
	});

	it('rule 2: the catchment gauge × unit MAP ÷ gauge MAP, clamped to 0.25–4', () => {
		expect(unitOf(out, 'B')).toMatchObject({ rule: 'gaugeMap', rainKey: 'rain_catchment_mm', factor: 700 / 500, gaugeMapClamped: false });
		const rain = col(out, 'rain_unit', 'B')!;
		for (const t of [0, 4, 13, 1000]) expect(rain[t]).toBe(g[t]! * (700 / 500));
		// The MAP ratio wins over C's own CHIRPS (rule 2 before rule 3), which fills only where the gauge has no value.
		expect(unitOf(out, 'C').chirps?.source).toBe('map');
	});

	it('rule 2 clamps a MAP ratio past 4 and warns', () => {
		const x = everyRule();
		x.model.nodes[2]!.mapMm = 2600;
		const o = runModel(x);
		expect(unitOf(o, 'B')).toMatchObject({ factor: 4, gaugeMapOwnFactor: 2600 / 500, gaugeMapClamped: true });
		expect(o.summary.warnings.some((w) => /"Unit B": its MAP ÷ the gauge's MAP is 5\.2/.test(w) && /clamped/.test(w))).toBe(true);
	});

	it('rule 3: the unit’s CHIRPS × unit MAP ÷ its mean annual rain over the MAP period’s complete years (ten of them)', () => {
		const x = everyRule();
		delete x.settings.unitRain!.gaugeMapMm;
		delete x.settings.unitRain!.gaugeMapSource;
		// C's CHIRPS from 2005, sixteen whole years; the period 2006–2015 holds ten of them.
		const from = toEpochDay('2005-01-01');
		const long = Array.from({ length: toEpochDay('2021-01-01') - from }, (_, i) => (fromEpochDay(from + i) < '2010-01-01' ? 2 : 1) * ((i + 3) % 13 === 0 ? 15 : (i + 3) % 4 === 0 ? 1 : 0));
		set(x, 'rain_chirps_mm@C', long, '2005-01-01');
		x.settings.unitRain!.mapPeriod = { start: '2006-01-01', end: '2015-12-31' };
		const o = runModel(x);
		const c = unitOf(o, 'C');
		const chirps = x.series['rain_chirps_mm@C']!;
		const mean = chirpsMeanAnnual(chirps, { start: '2006-01-01', end: '2015-12-31' })!;
		expect(mean).toMatchObject({ years: [2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015], inPeriod: true });
		expect(c).toMatchObject({ rule: 'unitChirps', rainKey: 'rain_chirps_mm@C', factorSource: 'chirpsMap' });
		expect(c.factor).toBeCloseTo(750 / mean.meanAnnualMm, 12);
		expect(c.chirps).toMatchObject({ source: 'map', years: mean.years, inPeriod: true, outsideBand: false, clamped: false });
		expect(o.summary.warnings.some((w) => /"Unit C": its CHIRPS has fewer than/.test(w))).toBe(false);
		const rain = col(o, 'rain_unit', 'C')!;
		const day0 = toEpochDay(START) - from;
		expect(rain[0]).toBe((chirps.values[day0] as number) * c.factor!);
		// B and D have a MAP but no record of their own and no gauge MAP: the catchment rain as it is (rule 4).
		expect(unitOf(o, 'D')).toMatchObject({ rule: 'catchment', factorSource: 'catchment', rainKey: null });
		expect(o.summary.warnings.some((w) => /"Unit D" has no rain of its own/.test(w))).toBe(true);
		// Nine years in the period are too few: every complete year of the record (sixteen), with a warning.
		x.settings.unitRain!.mapPeriod = { start: '2006-01-01', end: '2014-12-31' };
		const nine = runModel(x);
		expect(unitOf(nine, 'C').chirps).toMatchObject({ source: 'map', inPeriod: false });
		expect((unitOf(nine, 'C').chirps as { years: number[] }).years).toHaveLength(16);
		expect(nine.summary.warnings).toContain(
			'unit rain: "Unit C": its CHIRPS has fewer than 10 complete calendar years in the MAP period 1 Jan 2006 to 31 Dec 2014, so its MAP factor averages every complete year of the record (16, 2005–2020)'
		);
	});

	it('rule 3 with fewer than ten complete years in the period uses every complete year of the record, and warns', () => {
		const x = everyRule();
		delete x.settings.unitRain!.gaugeMapMm;
		x.settings.unitRain!.mapPeriod = { start: '2018-01-01', end: '2030-12-31' };
		const o = runModel(x);
		expect(unitOf(o, 'C').chirps).toMatchObject({ source: 'map', years: [2015, 2016, 2017, 2018, 2019, 2020], inPeriod: false });
		expect(o.summary.warnings.some((w) => /"Unit C": its CHIRPS has fewer than 10 complete calendar years in the MAP period .*\(6, 2015–2020, still fewer than 10\)/.test(w))).toBe(true);
	});

	it('the 0.5–2 band: a MAP factor or gauge MAP ratio outside it warns and is used as it is; past 0.25–4 it is clamped', () => {
		const x = everyRule();
		x.model.nodes[2]!.mapMm = 1100; // B: 1100 ÷ 500 = 2.2
		x.model.nodes[4]!.mapMm = 200; // D: 200 ÷ 500 = 0.4
		const o = runModel(x);
		expect(unitOf(o, 'B')).toMatchObject({ factor: 2.2, gaugeMapOwnFactor: 2.2, gaugeMapClamped: false, gaugeMapOutsideBand: true });
		expect(unitOf(o, 'D')).toMatchObject({ factor: 0.4, gaugeMapClamped: false, gaugeMapOutsideBand: true });
		expect(unitOf(o, 'C')).toMatchObject({ gaugeMapOutsideBand: false });
		expect(o.summary.warnings).toContain('unit rain: "Unit B": its MAP ÷ the gauge\'s MAP is 2.2 (1100 ÷ 500 mm), outside 0.5–2: used as it is, but check the records it comes from');
		expect(o.summary.warnings.some((w) => /"Unit C": its MAP ÷ the gauge's MAP/.test(w))).toBe(false);
		expect(col(o, 'rain_unit', 'B')![0]).toBe(g[0]! * 2.2);
		// Exactly 2 is inside the band.
		x.model.nodes[2]!.mapMm = 1000;
		expect(unitOf(runModel(x), 'B').gaugeMapOutsideBand).toBe(false);
		// Rule 3's MAP factor: C's MAP 4 × its CHIRPS mean warns, unchanged; 5 × is clamped to 4.
		const y = everyRule();
		delete y.settings.unitRain!.gaugeMapMm;
		const mean = chirpsMeanAnnual(y.series['rain_chirps_mm@C']!, { start: '1991-01-01', end: '2020-12-31' })!.meanAnnualMm;
		y.model.nodes[3]!.mapMm = Math.round(mean * 3);
		const band = unitOf(runModel(y), 'C').chirps as { factor: number; ownFactor: number; clamped: boolean; outsideBand: boolean };
		expect(band).toMatchObject({ clamped: false, outsideBand: true });
		expect(band.factor).toBe(band.ownFactor);
		y.model.nodes[3]!.mapMm = Math.round(mean * 5);
		const out5 = runModel(y);
		expect(unitOf(out5, 'C').chirps).toMatchObject({ factor: 4, clamped: true, outsideBand: true });
		expect(out5.summary.warnings.some((w) => /"Unit C": its MAP ÷ its CHIRPS mean annual rain is 5(\.\d+)? \(\d+ ÷ \d+ mm\), outside 0\.25–4; using 4 \(clamped\)/.test(w))).toBe(true);
	});

	it('a unit CHIRPS whose complete years all total 0 mm is unusable: skipped to the next link, with a warning', () => {
		const zeros = () => new Array<number>(DAYS).fill(0);
		// C on rule 3 (no gauge MAP): nothing else of its own, so the catchment rain (rule 4), not 0 mm days.
		const x = everyRule();
		delete x.settings.unitRain!.gaugeMapMm;
		set(x, 'rain_chirps_mm@C', zeros());
		const o = runModel(x);
		const c = unitOf(o, 'C');
		expect(c.chirps).toEqual({ source: 'unusable', meanAnnualMm: 0, years: [2015, 2016, 2017, 2018, 2019, 2020] });
		expect(c).toMatchObject({ rule: 'catchment', factorSource: 'catchment' });
		expect(col(o, 'rain_unit', 'C')).toEqual(col(o, 'rain_unit', 'D'));
		expect(c.rainMm).toBeGreaterThan(0);
		expect(o.summary.warnings).toContain(
			'unit rain: "Unit C": its CHIRPS totals 0 mm in every complete calendar year (6, 2015–2020), which looks broken: it is not used, and the unit\'s days fall to the next source of its rule'
		);
		expect(o.summary.warnings.some((w) => /"Unit C" has no usable rain of its own/.test(w))).toBe(true);
		// A gauge unit's zero CHIRPS is skipped on the gauge's gaps too: they fall to the catchment's rain, not 0 mm.
		const y = everyRule();
		set(y, 'rain_chirps_mm@A', zeros());
		const a = runModel(y);
		expect(unitOf(a, 'A').chirps!.source).toBe('unusable');
		expect(unitOf(a, 'A').days).toMatchObject({ unitGauge: DAYS - 4, unitChirps: 0, catchment: 4 });
		expect(col(a, 'rain_unit', 'A')![12]).toBe(g[12]!);
		// Zeros with no complete year yet are not judged: the old path (raw here) stands.
		const z = everyRule();
		delete z.settings.unitRain!.gaugeMapMm;
		set(z, 'rain_chirps_mm@C', zeros().slice(0, 200));
		expect(unitOf(runModel(z), 'C').chirps!.source).toBe('raw');
	});

	it('rule 3 without a MAP: the catchment’s §2.4b monthly factors when there are any, else raw with a warning', () => {
		const x = everyRule();
		delete x.settings.unitRain!.gaugeMapMm;
		delete x.model.nodes[3]!.mapMm;
		const raw = runModel(x);
		expect(unitOf(raw, 'C')).toMatchObject({ factorSource: 'chirpsRaw', factor: 1 });
		expect(raw.summary.warnings.some((w) => /"Unit C": its CHIRPS runs raw/.test(w))).toBe(true);
		// With a catchment CHIRPS series the catchment's factors exist (gauge ÷ CHIRPS = 2), and C's CHIRPS takes them.
		set(x, 'rain_chirps_mm', rainOf(0.5));
		const biased = runModel(x);
		const c = unitOf(biased, 'C');
		expect(c).toMatchObject({ factorSource: 'chirpsBias', factor: null });
		const factor = biased.summary.chirpsCorrection!.months[0]!.factor!;
		expect(factor).toBeCloseTo(2, 9);
		expect(col(biased, 'rain_unit', 'C')![0]).toBeCloseTo((x.series['rain_chirps_mm@C']!.values[0] as number) * factor, 12);
	});

	it('rule 2’s gaps: the unit’s CHIRPS scaled to its MAP, else the catchment’s infilled rain × the MAP ratio', () => {
		const x = everyRule();
		const gauge = x.series.rain_catchment_mm!.values;
		for (const t of [26, 52]) gauge[t] = null;
		set(x, 'rain_chirps_mm', rainOf(0.9));
		const o = runModel(x);
		const c = unitOf(o, 'C');
		const k = (c.chirps as { factor: number }).factor;
		expect(col(o, 'rain_unit', 'C')![26]).toBe((x.series['rain_chirps_mm@C']!.values[26] as number) * k);
		// B has no CHIRPS of its own: the catchment's corrected CHIRPS × B's MAP ratio.
		const final = col(o, 'rain_final')!;
		expect(col(o, 'rain_unit', 'B')![26]).toBeCloseTo(final[26]! * (700 / 500), 12);
		expect(unitOf(o, 'B').days.catchment).toBe(2);
		expect(o.summary.warnings.some((w) => /"Unit B" ran 2 of its \d+ days on the catchment's rain × its MAP ratio 1\.4/.test(w))).toBe(true);
	});

	it('rule 2’s gaps on a unit levelled by the §2.4b factors keep its MAP ratio: no step where a gap starts or ends', () => {
		// C: MAP 750 under a gauge MAP of 500 (ratio 1.5); its CHIRPS is the gauge × 0.5 over a part of 2015 only (no complete
		// year), so it takes the catchment's §2.4b factors (gauge ÷ CHIRPS = 2), which bring it to the gauge, not to C's MAP.
		const x = everyRule();
		set(x, 'rain_chirps_mm', rainOf(0.5));
		const gauge = x.series.rain_catchment_mm!.values;
		const from = 60;
		set(x, 'rain_chirps_mm@C', rainOf(0.5).slice(from, from + 200), fromEpochDay(toEpochDay(START) + from));
		const gapDays = [65, 78, 91, 104, 117, 130];
		for (const t of gapDays) gauge[t] = null;
		const o = runModel(x);
		expect(unitOf(o, 'C')).toMatchObject({ rule: 'gaugeMap', gaugeMapFactor: 1.5 });
		expect(unitOf(o, 'C').chirps).toEqual({ source: 'bias' });
		const rain = col(o, 'rain_unit', 'C')!;
		// A gap day reads what the gauge would have given × 1.5, as the gauge days around it do: CHIRPS × 2 × 1.5.
		for (const t of gapDays) {
			expect(g[t]).toBeGreaterThan(0);
			expect(rain[t], `day ${t}`).toBeCloseTo(g[t]! * 1.5, 9);
		}
		for (const t of [64, 66, 77, 79]) expect(rain[t]).toBe(g[t]! * 1.5);
		expect(unitOf(o, 'C').days.unitChirps).toBe(gapDays.length);
		// Positive control: a CHIRPS levelled to the unit's MAP (its MAP factor, everyRule's C) fills alone, without the ratio.
		const y = everyRule();
		for (const t of gapDays) y.series.rain_catchment_mm!.values[t] = null;
		const p = runModel(y);
		const k = (unitOf(p, 'C').chirps as { source: string; factor: number }).factor;
		expect(unitOf(p, 'C').chirps!.source).toBe('map');
		for (const t of gapDays) expect(col(p, 'rain_unit', 'C')![t]).toBe((y.series['rain_chirps_mm@C']!.values[t] as number) * k);
	});

	it('forecast days after the record: the catchment forecast × the MAP ratio on rule 2, × 1 on the unit’s own path', () => {
		const x = everyRule();
		const tail = Array.from({ length: 10 }, (_, i) => 5 + i);
		set(x, 'rain_forecast_mm', tail, '2021-01-01');
		// A's own records end with the catchment's.
		const o = runModel(x);
		expect(o.days).toBe(DAYS + 10);
		expect(col(o, 'rain_unit', 'B')!.slice(DAYS)).toEqual(tail.map((v) => v * (700 / 500)));
		expect(col(o, 'rain_unit', 'A')!.slice(DAYS)).toEqual(tail);
		expect(unitOf(o, 'A').days.forecast).toBe(10);
		// An uploaded forecast ('other') is the same as one of unknown source.
		const other = runModel({ ...x, forecastRainSource: 'other' });
		expect(JSON.stringify(other)).toBe(JSON.stringify(o));
	});

	it('a CHIRPS-GEFS forecast takes each unit’s own CHIRPS level, so a CHIRPS unit has no step where the forecast starts', () => {
		const x = everyRule();
		const tail = Array.from({ length: 10 }, (_, i) => 5 + i);
		set(x, 'rain_forecast_mm', tail, '2021-01-01');
		const o = runModel({ ...x, forecastRainSource: 'chirps_gefs' });
		// C (rule 2, a CHIRPS levelled by its MAP): its forecast × its MAP factor, the level its CHIRPS fills at, not × its gauge MAP ratio.
		const k = (unitOf(o, 'C').chirps as { factor: number }).factor;
		expect(k).not.toBeCloseTo(750 / 500, 3);
		expect(col(o, 'rain_unit', 'C')!.slice(DAYS)).toEqual(tail.map((v) => v * k));
		// B has no CHIRPS of its own: the MAP ratio as before. A's CHIRPS runs raw (no level known): × 1 as before.
		expect(col(o, 'rain_unit', 'B')!.slice(DAYS)).toEqual(tail.map((v) => v * (700 / 500)));
		expect(col(o, 'rain_unit', 'A')!.slice(DAYS)).toEqual(tail);
		// The history is untouched.
		const hist = runModel(x);
		for (const id of ['A', 'B', 'C', 'D']) expect(col(o, 'rain_unit', id)!.slice(0, DAYS), id).toEqual(col(hist, 'rain_unit', id)!.slice(0, DAYS));
		expect(checkForecastPrefix({ ...withForecastTail(everyRule(), 7), forecastRainSource: 'chirps_gefs' })).toBeNull();
	});

	it('warns when a unit’s own CHIRPS is shadowed by a longer series of that unit, and computes nothing else differently; a scenario carries it (issue #561)', () => {
		const x = everyRule();
		// C's own CHIRPS: its last 30 days only; another series of C's (named, not read) spans the whole run.
		const own = x.series['rain_chirps_mm@C']!;
		const from = toEpochDay(START) + DAYS - 30 - toEpochDay(own.startDate);
		set(x, 'rain_chirps_mm@C', own.values.slice(from, from + 30), fromEpochDay(toEpochDay(START) + DAYS - 30));
		const seriesChoice = { unitChirps: { C: { name: 'C short', others: [{ name: 'C long', firstDay: START, lastDay: fromEpochDay(toEpochDay(START) + DAYS - 1) }] } } };
		const told = runModel({ ...x, seriesChoice });
		const unitWarned = (o: ReturnType<typeof runModel>) => o.summary.warnings.filter((w) => w.startsWith('for the unit'));
		expect(unitWarned(told)).toEqual([expect.stringMatching(/^for the unit “Unit C”, the run read the CHIRPS series “C short” \(2 Dec 2020 to 31 Dec 2020\), which spans 30 of its 2192 days, but “C long” \(1 Jan 2015 to 31 Dec 2020\) spans 2192:/)]);
		const plain = runModel(x);
		const forUnit = (w: string) => w.startsWith('for the unit');
		const strip = (o: ReturnType<typeof runModel>) => ({
			...o,
			summary: { ...o.summary, warnings: o.summary.warnings.filter((w) => !forUnit(w)), warningCodes: o.summary.warningCodes?.filter((c) => !forUnit(c.text)) }
		});
		expect(sameOutput(strip(plain), strip(told))).toBe(true);
		// A scenario on it reads the same series, so it warns the same; one that removes no unit keeps C's pick.
		expect(unitWarned(runModel(applyScenario({ ...x, seriesChoice }, []).input))).toEqual(unitWarned(told));
	});

	it('a scenario on a CHIRPS-GEFS forecast input keeps its source, so its units’ forecast days keep their CHIRPS level (engine 1.90.0, issue #561)', () => {
		const x = everyRule();
		const tail = Array.from({ length: 10 }, (_, i) => 5 + i);
		set(x, 'rain_forecast_mm', tail, '2021-01-01');
		const base = { ...x, forecastRainSource: 'chirps_gefs' as const };
		const { input, applied } = applyScenario(base, []);
		expect(applied).toEqual([]);
		// Before 1.90.0 applyScenario rebuilt the input from settings, model and series only: the source was dropped, and
		// C's forecast days fell back to its gauge MAP ratio.
		expect(input.forecastRainSource).toBe('chirps_gefs');
		expect(JSON.stringify(runModel(input))).toBe(JSON.stringify(runModel(base)));
		const k = (unitOf(runModel(input), 'C').chirps as { factor: number }).factor;
		expect(col(runModel(input), 'rain_unit', 'C')!.slice(DAYS)).toEqual(tail.map((v) => v * k));
	});

	it('a CHIRPS-GEFS forecast on a unit whose CHIRPS level is the catchment’s §2.4b factors keeps its MAP ratio on top: no step', () => {
		// C has a MAP and a gauge MAP ratio (750 ÷ 500), but its CHIRPS holds no complete calendar year, so it is levelled by the
		// catchment's §2.4b factors (gauge ÷ CHIRPS = 2), which bring it to the catchment gauge, not to C's MAP.
		const x = everyRule();
		set(x, 'rain_chirps_mm', rainOf(0.5));
		const from = toEpochDay('2015-03-01') - toEpochDay(START);
		set(x, 'rain_chirps_mm@C', rainOf(0.5, 3).slice(from, from + 200), '2015-03-01');
		const tail = Array.from({ length: 10 }, (_, i) => 5 + i);
		set(x, 'rain_forecast_mm', tail, '2021-01-01');
		const o = runModel({ ...x, forecastRainSource: 'chirps_gefs' });
		expect(unitOf(o, 'C')).toMatchObject({ rule: 'gaugeMap', gaugeMapFactor: 1.5 });
		expect(unitOf(o, 'C').chirps).toEqual({ source: 'bias' });
		// History: gauge × 1.5. Forecast: GEFS × the bias factor (2) × 1.5, the same level, not × 2 alone.
		const rain = col(o, 'rain_unit', 'C')!;
		expect(rain[0]).toBe(g[0]! * 1.5);
		rain.slice(DAYS).forEach((v, i) => expect(v, `day ${i}`).toBeCloseTo(tail[i]! * 2 * 1.5, 9));
		expect(checkForecastPrefix({ ...withForecastTail(x, 7), forecastRainSource: 'chirps_gefs' })).toBeNull();
	});

	it('the areal correction applies to rule-4 units only', () => {
		const areal: ArealRain = { factors: new Array(12).fill(2) as never, method: 'map', source: 'invented' };
		const x = everyRule();
		delete x.settings.unitRain!.gaugeMapMm;
		x.settings.arealRain = areal;
		const o = runModel(x);
		expect(unitOf(o, 'D').rule).toBe('catchment');
		expect(col(o, 'rain_unit', 'D')![0]).toBe(g[0]! * 2);
		expect(col(o, 'rain_unit', 'A')![0]).toBe(x.series['rain_catchment_mm@A']!.values[0]);
		const before = o.summary.runoff!.arealRain!.rainBeforeMm;
		expect(before).toBeLessThan(o.summary.runoff!.rainMm);
	});
});

describe('GR4J per unit', () => {
	const input = everyRule();
	const out = runModelChecked(input);

	it('each unit runs GR4J on its own rain over its own area; natural flow is their sum', () => {
		const prep = prepareRun(input);
		const pet = runoffForcing(prep.settings, prep).petMm;
		const natural = col(out, 'natural_flow')!;
		const sum = new Float64Array(out.days);
		for (const u of out.summary.unitRain!.units) {
			const rain = Float64Array.from(col(out, 'rain_unit', u.nodeId)!);
			const tr = simulateRunoff(gr4j, out.summary.runoff!.params as never, { rainMm: rain, petMm: pet }, { warmupDays: 365 });
			const runoff = col(out, 'runoff_natural', u.nodeId)!;
			for (const t of [0, 100, 1000, out.days - 1]) expect(runoff[t]).toBe(tr.qMm[t]! * u.areaKm2 * 1000);
			// No land cover: the unit's runoff into the network is its own runoff.
			expect(col(out, 'runoff', u.nodeId)).toEqual(runoff);
			runoff.forEach((v, t) => (sum[t] = sum[t]! + v));
			expect(u.runoffCoefficient).toBeCloseTo(u.flowMm / u.rainMm, 12);
			expect(u.rainMm - u.aetMm - u.flowMm + u.exchangeMm).toBeCloseTo(u.storageEndMm - u.storageStartMm, 6);
		}
		expect(Array.from(sum)).toEqual(natural);
		// The farm with no area gets no runoff of its own.
		expect(col(out, 'runoff', 'E')!.every((v) => v === 0)).toBe(true);
		expect(out.summary.runoff!.areaKm2).toBe(20.5);
	});

	it('closes the catchment’s runoff balance over the units’ areas, and the self-checks catch a unit’s runoff off by a bit', () => {
		expect(checkInvariants(input, out)).toBeNull();
		const bad = structuredClone(out);
		bad.series.find((s) => s.nodeId === 'B' && s.key === 'runoff_natural')!.values[5]! += 1;
		expect(checkInvariants(input, bad)).toMatch(/per-unit runoff/);
	});

	it('doesn’t depend on the order the units are listed in', () => {
		expect(checkOrderInvariance(input, runModel(input), 3)).toBeNull();
		const reversed = structuredClone(input);
		reversed.model.nodes.reverse();
		expect(JSON.stringify(runModelChecked(reversed).summary.unitRain)).toBe(JSON.stringify(out.summary.unitRain));
	});

	it('ignores the calibration area override and says so', () => {
		const x = everyRule();
		x.settings.calibration = { rainThresholdMm: 0, catchmentAreaKm2: 40 };
		const o = runModel(x);
		expect(o.summary.runoff!.areaKm2).toBe(20.5);
		expect(o.summary.warnings.some((w) => /runs on the units' areas \(20\.5 km²\), not the catchment area set in Calibration → Flow calibration \(40 km²\)/.test(w))).toBe(true);
	});

	it('resumes from a snapshot to the bit, each unit from its own state', () => {
		for (const k of [0, 400, 1500]) expect(checkResume(input, k)).toBeNull();
	});

	it('a forecast tail changes no historical day', () => {
		expect(checkForecastPrefix(withForecastTail(everyRule(), 7))).toBeNull();
	});

	it('firm yield and calibration see the run’s natural flow', () => {
		expect(Array.from(prepareYield(input).plan.naturalFlow)).toEqual(col(out, 'natural_flow'));
		const pb = prepareCalibration(input);
		const sim = pb.simulate(pb.startParams);
		expect(Array.from(pb.natural.subarray(0, 2000))).toEqual(col(out, 'natural_flow')!.slice(0, 2000));
		expect(sim[1500]).toBe(col(out, 'simulated_outflow')![1500]);
		expect(pb.unitRain?.units.map((u) => u.rule)).toEqual(['unitGauge', 'gaugeMap', 'gaugeMap', 'gaugeMap']);
	});
});

describe('fit provenance and run comparison', () => {
	const input = everyRule();
	const report = calibrate(input, { budget: 30, seed: 1 });
	const ctx = { settings: prepareRun(input).settings, validate: false, validationRecord: null, engineVersion: 'test', fittedAt: '2026-10-09T00:00:00Z' };
	const record = fitRecordFromReport(report, ctx);

	it('records each unit’s rule, record and factors; a fit under catchment rain records none', () => {
		expect(record.forcing!.unitRain!.units.map((u) => [u.nodeId, u.rule, u.factor])).toEqual([
			['A', 'unitGauge', 1],
			['B', 'gaugeMap', 1.4],
			['C', 'gaugeMap', 1.5],
			['D', 'gaugeMap', 1.2]
		]);
		expect(unitRainFingerprintError(record.forcing!.unitRain)).toBeNull();
		const plain = catchment('absent');
		expect(fitRecordFromReport(calibrate(plain, { budget: 10, seed: 1 }), { ...ctx, settings: prepareRun(plain).settings }).forcing!.unitRain).toBeUndefined();
	});

	it('marks a gauge unit’s checked gauge (engine ≥ 1.85.0), so a fit from before the checks reads "forcing changed"', () => {
		const fp = record.forcing!.unitRain!;
		expect(fp.units.find((u) => u.nodeId === 'A')).toMatchObject({ rule: 'unitGauge', gaugeChecked: true });
		expect(fp.units.filter((u) => u.nodeId !== 'A').every((u) => u.gaugeChecked === undefined)).toBe(true);
		expect(unitRainFingerprintError(JSON.parse(JSON.stringify(fp)))).toBeNull();
		expect(unitRainFingerprintError({ ...fp, units: [{ ...fp.units[0]!, gaugeChecked: false }] })).toMatch(/gauge checks marker/);
		// A fit made by 1.78.0–1.84.0 recorded no marker: its gauge was read as recorded.
		const old = structuredClone(fp);
		delete old.units[0]!.gaugeChecked;
		expect(unitRainFingerprintChanged(fp, old)).toBe(true);
		expect(unitRainFingerprintChanged(old, fp)).toBe(true);
		expect(unitRainFingerprintChanged(fp, structuredClone(fp))).toBe(false);
		const settings = prepareRun(input).settings;
		expect(fitRecordStatus(settings, { ...record, forcing: { ...record.forcing!, unitRain: old } }, { unitRain: unitRainFingerprintOfSummary(runModel(input).summary.unitRain) }).forcingChanged).toBe(true);
		expect(fitRecordStatus(settings, record, { unitRain: unitRainFingerprintOfSummary(runModel(input).summary.unitRain) }).forcingChanged).toBe(false);
	});

	it('flags the forcing as changed when per-unit rain is turned on or off, or a unit’s factor moves', () => {
		const now = (x: ModelInput) => ({ unitRain: unitRainFingerprintOfSummary(runModel(x).summary.unitRain) });
		const settings = (x: ModelInput) => prepareRun(x).settings;
		expect(fitRecordStatus(settings(input), record, now(input)).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...settings(input), unitRain: { mode: 'catchment' } }, record).forcingChanged).toBe(true);
		const moved = everyRule();
		moved.model.nodes[2]!.mapMm = 900;
		expect(fitRecordStatus(settings(moved), record).forcingChanged).toBe(false); // the settings alone don't say
		expect(fitRecordStatus(settings(moved), record, now(moved)).forcingChanged).toBe(true);
		const plain = catchment('absent');
		const old = fitRecordFromReport(calibrate(plain, { budget: 10, seed: 1 }), { ...ctx, settings: prepareRun(plain).settings });
		expect(fitRecordStatus(settings(input), old).forcingChanged).toBe(true);
		expect(fitRecordStatus(settings(plain), old).forcingChanged).toBe(false);
		expect(unitRainFingerprintChanged(null, null)).toBe(false);
	});

	it('run comparison lists the setting and a unit’s MAP', () => {
		const a = catchment('absent');
		const b = everyRule();
		const changes = diffInputs({ settings: a.settings, model: a.model, series: {} } as never, { settings: b.settings, model: b.model, series: {} } as never).map((c) => c.text);
		expect(changes, changes.join('\n')).toContain('Runoff from each unit’s own rain: off → on (gauge MAP 500 mm (invented gauge MAP); MAP period 1 Jan 1991 to 31 Dec 2020)');
		expect(changes).toContain('Unit B: MAP none → 700 mm');
	});
});

describe('scenarios and sensitivity reach a unit’s own rain', () => {
	it('series.scale scales a unit’s rain record, and the rain sensitivity scales every rain record', () => {
		const input = everyRule();
		const r = applyScenario(input, [{ op: 'series.scale', kind: 'rain_catchment_mm@A', factor: 2 }]);
		expect(r.problems).toEqual([]);
		expect(r.input.series['rain_catchment_mm@A']!.values[0]).toBe((input.series['rain_catchment_mm@A']!.values[0] as number) * 2);
		expect(applyScenario(input, [{ op: 'series.scale', kind: 'rain_chirps_mm@nowhere' as never, factor: 2 }]).problems).toHaveLength(1);
		const rain = sensitivityRuns(input).factors.find((f) => f.factor === 'rain')!;
		expect(rain.notes).toEqual(['4 rain series scaled', '3 unit MAPs scaled with them']);
	});

	it('the rain sensitivity moves every unit’s rain by its factor, a MAP-levelled CHIRPS included', () => {
		const input = everyRule();
		delete input.settings.unitRain!.gaugeMapMm; // C on rule 3, levelled by its MAP
		const central = runModel(input);
		expect(unitOf(central, 'C').factorSource).toBe('chirpsMap');
		const plan = sensitivityPlan(input, central, SENSITIVITY_RANGES).plans.find((p) => p.factor === 'rain')!;
		const k = plan.high.setting;
		const high = runModel(plan.high.adjust!(applyScenario(input, plan.high.ops).input));
		for (const u of central.summary.unitRain!.units) expect(unitOf(high, u.nodeId).rainMm, u.nodeId).toBeCloseTo(u.rainMm * k, 6);
	});

	it('series.scale takes a unit’s own record and refuses other keyed series', () => {
		const { errors } = validateScenarioOps([
			{ op: 'series.scale', kind: 'rain_catchment_mm@A', factor: 1.1 },
			{ op: 'series.scale', kind: 'rain_chirps_mm@B', factor: 1.1 },
			{ op: 'series.scale', kind: 'rain_catchment_mm@', factor: 1.1 },
			{ op: 'series.scale', kind: 'flow_observed_m3s@G', factor: 1.1 }
		]);
		expect(errors.map((e) => e.slice(0, 13))).toEqual(['ops[2].kind: ', 'ops[3].kind: ']);
	});

	it('the ensemble’s CHIRPS-only member drops the units’ own gauges', () => {
		const input = everyRule();
		set(input, 'rain_chirps_mm', rainOf(0.6));
		const { options } = resolveEnsembleOptions(input, { members: 30, rainSources: ['recorded', 'chirps'] });
		const ctx = ensembleContext(input, options);
		expect(Object.keys(ctx.chirps!.series).filter((k) => k.includes('@'))).toEqual(['rain_chirps_mm@A', 'rain_chirps_mm@C']);
		// A keeps its rule, pinned (engine ≥ 1.95.0); with no gauge its days fall to its CHIRPS.
		const a = unitOf(runModel(ctx.chirps!), 'A');
		expect(a.rule).toBe('unitGauge');
		expect(a.days.unitGauge).toBe(0);
	});

	it('the CHIRPS-only member keeps each unit’s gauge MAP ratio: a rule-2 unit and a short CHIRPS on the §2.4b factors read at the base level', () => {
		// The catchment CHIRPS is the gauge × 0.5, so its §2.4b factors are 2 and the member's corrected CHIRPS is the gauge
		// exactly: every unit without a gauge of its own must read the same rain in the member as in the base run.
		// B: rule 2 (MAP 700 ÷ gauge MAP 500 = 1.4), no CHIRPS. C: MAP 750 (ratio 1.5) but CHIRPS over 200 days only, so the
		// base levels it by the §2.4b factors × its ratio. D: rule 2 too (600 ÷ 500). Before engine 1.95.0 the member lost the
		// ratio on all three, and C's §2.4b factors.
		const input = everyRule();
		set(input, 'rain_chirps_mm', rainOf(0.5));
		set(input, 'rain_chirps_mm@C', rainOf(0.5).slice(60, 260), fromEpochDay(toEpochDay(START) + 60));
		const base = runModel(input);
		expect(unitOf(base, 'B')).toMatchObject({ rule: 'gaugeMap', gaugeMapFactor: 1.4 });
		expect(unitOf(base, 'C')).toMatchObject({ rule: 'gaugeMap', gaugeMapFactor: 1.5, chirps: { source: 'bias' } });
		const member = runModel(ensembleContext(input, resolveEnsembleOptions(input, { members: 30, rainSources: ['recorded', 'chirps'] }).options).chirps!);
		for (const id of ['B', 'C', 'D']) {
			expect(unitOf(member, id).rule, id).toBe(unitOf(base, id).rule);
			const want = col(base, 'rain_unit', id)!;
			const got = col(member, 'rain_unit', id)!;
			for (let t = 0; t < want.length; t++) expect(got[t], `${id} day ${t}`).toBeCloseTo(want[t]!, 9);
		}
	});

	it('the CHIRPS-only member keeps a unit’s CHIRPS on the catchment’s §2.4b factors: the base run’s level, not raw', () => {
		// C: its own CHIRPS and no MAP, so the base run levels it by the catchment's §2.4b factors (gauge ÷ CHIRPS = 2). The
		// member's catchment CHIRPS carries those factors, so C's must too, else the member reads it at half the base level.
		const input = everyRule();
		set(input, 'rain_chirps_mm', rainOf(0.5));
		delete input.model.nodes[3]!.mapMm;
		const base = runModel(input);
		expect(unitOf(base, 'C')).toMatchObject({ rule: 'unitChirps', chirps: { source: 'bias' } });
		const { options } = resolveEnsembleOptions(input, { members: 30, rainSources: ['recorded', 'chirps'] });
		const member = runModel(ensembleContext(input, options).chirps!);
		expect(unitOf(member, 'C').rule).toBe('unitChirps');
		const want = col(base, 'rain_unit', 'C')!;
		const got = col(member, 'rain_unit', 'C')!;
		expect(got.length).toBe(want.length);
		for (let t = 0; t < want.length; t++) expect(got[t], `day ${t}`).toBeCloseTo(want[t]!, 9);
		// Positive control: C levelled by its own MAP (everyRule's 750 mm) keeps its CHIRPS as stored, and reads the same in both.
		const mapped = everyRule();
		set(mapped, 'rain_chirps_mm', rainOf(0.5));
		const ctx = ensembleContext(mapped, resolveEnsembleOptions(mapped, { members: 30, rainSources: ['recorded', 'chirps'] }).options);
		expect((ctx.chirps!.series as Record<string, unknown>)['rain_chirps_mm@C']).toBe((mapped.series as Record<string, unknown>)['rain_chirps_mm@C']);
		expect(unitOf(runModel(ctx.chirps!), 'C').chirps).toEqual(unitOf(runModel(mapped), 'C').chirps);
	});
});

describe('more of the per-unit run', () => {
	it('the catchment runoff coefficient is the units’ runoff over their rain', () => {
		const out = runModel(everyRule());
		const units = out.summary.unitRain!.units;
		const runoff = units.reduce((a, u) => a + u.runoffM3, 0);
		const rain = units.reduce((a, u) => a + u.rainMm * u.areaKm2 * 1000, 0);
		expect(out.summary.catchment.runoffCoefficient).toBeCloseTo(runoff / rain, 9);
	});

	it('land cover reduces a unit’s own runoff; the share still sets its low-flow threshold', () => {
		const x = everyRule();
		x.model.landCover = [{ id: 'lc', nodeId: 'B', coverClass: 'pine', areaKm2: 3, densityPct: 1, factors: null }];
		const out = runModelChecked(x);
		expect(out.summary.verification!.checks.every((c) => c.passed)).toBe(true);
		const own = col(out, 'runoff_natural', 'B')!;
		const red = col(out, 'landcover_reduction', 'B')!;
		const I = col(out, 'runoff', 'B')!;
		expect(red.some((v) => v > 0)).toBe(true);
		for (const t of [0, 50, 900]) expect(I[t]! + red[t]!).toBeCloseTo(own[t]!, 6);
	});

	it('a resume refuses a snapshot from the other forcing, as a model-state mismatch', () => {
		const per = everyRule();
		const { snapshot } = runModelCapturing(per, '2017-01-01');
		const catchmentRain = everyRule();
		catchmentRain.settings.unitRain = { mode: 'catchment' };
		expect(() => runModelFrom(snapshot, catchmentRain)).toThrow(ModelStateMismatchError);
		const { snapshot: plain } = runModelCapturing(catchmentRain, '2017-01-01');
		expect(() => runModelFrom(plain, per)).toThrow(ModelStateMismatchError);
	});

	it('a fit records how a gauge unit’s backup CHIRPS is levelled, so a moved MAP factor flags the forcing', () => {
		const a = everyRule();
		a.model.nodes[1]!.mapMm = 650; // A: its own gauge, its CHIRPS levelled by its MAP on the gauge's gaps
		a.model.nodes[1]!.mapSource = 'invented';
		delete a.settings.unitRain!.gaugeMapMm;
		const b = structuredClone(a);
		b.model.nodes[1]!.mapMm = 900;
		const fa = unitRainFingerprintOfSummary(runModel(a).summary.unitRain)!;
		const fb = unitRainFingerprintOfSummary(runModel(b).summary.unitRain)!;
		expect(fa.units[0]).toMatchObject({ rule: 'unitGauge', factor: 1, chirpsSource: 'map' });
		expect(unitRainFingerprintChanged(fa, fb)).toBe(true);
		expect(unitRainFingerprintChanged(fa, structuredClone(fa))).toBe(false);
	});

	it('off runs the same flow to the bit on random networks, unit records and MAPs in the input or not (they move only the EWR shares)', () => {
		for (let seed = 1; seed <= 25; seed++) {
			const plain = randomInput(seed);
			let before: string;
			try {
				before = JSON.stringify(runModel(plain));
			} catch {
				continue;
			}
			const flow = (o: Out) => JSON.stringify(o.series.filter((s) => s.key === 'natural_flow' || s.key === 'rain_used'));
			const plainFlow = flow(JSON.parse(before) as Out);
			let last: string | null = null;
			for (const unitRain of [null, { mode: 'catchment' as const }]) {
				const off = withUnitRainRecords(randomInput(seed), seed);
				off.settings.unitRain = unitRain;
				const out = runModel(off);
				expect(flow(out), `seed ${seed}`).toBe(plainFlow);
				// Null and `catchment` are the same setting: the same run to the bit, EWR shares too.
				const all = JSON.stringify(out);
				if (last !== null) expect(all, `seed ${seed}`).toBe(last);
				last = all;
			}
		}
	}, 120_000);
});

describe('chirpsMeanAnnual', () => {
	it('averages complete calendar years only', () => {
		const s = { startDate: '2015-03-01', values: Array.from({ length: toEpochDay('2018-01-01') - toEpochDay('2015-03-01') }, () => 1) };
		expect(chirpsMeanAnnual(s, { start: '1991-01-01', end: '2020-12-31' })).toEqual({ meanAnnualMm: 365.5, years: [2016, 2017], inPeriod: false });
		s.values[toEpochDay('2016-06-01') - toEpochDay('2015-03-01')] = null as never;
		expect(chirpsMeanAnnual(s, { start: '1991-01-01', end: '2020-12-31' })!.years).toEqual([2017]);
		expect(chirpsMeanAnnual({ startDate: '2015-03-01', values: [1, 2] }, { start: '1991-01-01', end: '2020-12-31' })).toBeNull();
		expect(fromEpochDay(toEpochDay('2016-01-01'))).toBe('2016-01-01');
	});
});
