// CHIRPS as a unit's driver rainfall (settings.unitRain.chirpsUnits, engine ≥ 1.114.0,
// docs/model.md §2.4h *CHIRPS as a unit's driver*, the operator 2026-11-03): `raw` is the
// unit's own CHIRPS × k_unit and never bias-corrected, even with a reference gauge or the
// catchment's §2.4b factors; `bias` is corrected against the reference gauge, else the §2.4b
// factors (then × k_unit), else falls back to raw levelled to the unit's MAP with a warning;
// either replaces the unit's own gauge as its record; a unit left out runs as before, to the bit.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { calibrate } from '../calibrate/calibrate';
import { fitRecordFromReport, fitRecordStatus } from '../calibrate/provenance';
import { diffInputs } from '../compare';
import { fromEpochDay, monthOfEpochDay, toEpochDay } from '../calendar';
import { AREAL_RAIN_FACTOR_MAX, AREAL_RAIN_FACTOR_MIN, referenceCellSeriesKey, resolveUnitRain, unitRainError, type ModelInput, type UnitRainSettings } from '../project';
import { prepareRun } from '../prepare';
import { chirpsFactorOn } from '../rain';
import { runModel } from '../run';
import { unitChirpsChoiceNotes } from '../runReady';
import { checkInvariants } from '../testing/invariants';
import { checkResume } from '../testing/warmstartInvariants';
import { unitChirpsChoicePreview } from './unitChirpsPreview';
import { unitRainFingerprintChanged, unitRainFingerprintError, unitRainFingerprintOfSummary, unitRainRecipes } from './unitRain';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const START = '2015-01-01';
const D0 = toEpochDay(START);
const DAYS = toEpochDay('2021-01-01') - D0; // six whole calendar years
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));
const monthOf = (i: number) => monthOfEpochDay(D0 + i);
const yearOf = (i: number) => Number(fromEpochDay(D0 + i).slice(0, 4));

/**
 * A gauge with three land units above it: A (its own gauge and CHIRPS, MAP 800), B (CHIRPS, MAP 900) and C (CHIRPS, no
 * MAP). The catchment gauge over six calendar years, no gauge MAP, so B and C run on rule 3 and A on rule 1 when not set.
 * `catchmentChirps` adds the catchment's CHIRPS, so §2.4b fits its monthly factors; `reference` the reference gauge at B.
 */
function catchment(opts: { chirpsUnits?: UnitRainSettings['chirpsUnits']; catchmentChirps?: boolean; reference?: boolean } = {}): ModelInput {
	const node = { sortOrder: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const unit = (id: string, areaKm2: number, mapMm?: number) => ({ ...node, id, name: `Unit ${id}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2, ...(mapMm ? { mapMm, mapSource: 'invented' } : {}) });
	const unitRain: UnitRainSettings = {
		mode: 'perUnit',
		...(opts.reference ? { reference: { gauge: 'rain_catchment_mm', unitId: 'B' } } : {}),
		...(opts.chirpsUnits !== undefined ? { chirpsUnits: opts.chirpsUnits } : {})
	};
	const series: Record<string, unknown> = {
		rain_catchment_mm: { startDate: START, values: rainOf(1) },
		flow_observed_m3s: { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) },
		'rain_catchment_mm@A': { startDate: START, values: rainOf(0.9, 2) },
		'rain_chirps_mm@A': { startDate: START, values: rainOf(0.7, 1) },
		'rain_chirps_mm@B': { startDate: START, values: rainOf(0.6, 2) },
		'rain_chirps_mm@C': { startDate: START, values: rainOf(0.5, 0) }
	};
	// The catchment's CHIRPS: the gauge × a monthly bias (0.5 in the wet months, 0.8 in the rest), so §2.4b fits 2 and 1.25.
	if (opts.catchmentChirps) series.rain_chirps_mm = { startDate: START, values: rainOf(1).map((v, i) => v * ([5, 6, 7, 8].includes(monthOf(i)) ? 0.5 : 0.8)) };
	// The reference cell under B: the gauge × 0.5 (factor 2) in every month.
	if (opts.reference) series[referenceCellSeriesKey('B')] = { startDate: START, values: rainOf(1).map((v) => v * 0.5) };
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, unitRain },
		model: {
			nodes: [{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }, unit('A', 4, 800), unit('B', 6, 900), unit('C', 3)],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 100_000 }],
			transfers: []
		},
		series: series as ModelInput['series']
	};
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
const unitOf = (out: Out, id: string) => out.summary.unitRain!.units.find((u) => u.nodeId === id)!;
const chirpsOf = (x: ModelInput, id: string) => x.series[`rain_chirps_mm@${id}` as never]!.values as number[];
const clamp = (k: number) => Math.min(AREAL_RAIN_FACTOR_MAX, Math.max(AREAL_RAIN_FACTOR_MIN, k));
/** The mean of the six calendar years' totals of `values` × `scale(i)`. */
const meanAnnual = (values: readonly (number | null)[], scale: (i: number) => number = () => 1) => {
	const t = new Map<number, number>();
	values.forEach((v, i) => t.set(yearOf(i), (t.get(yearOf(i)) ?? 0) + (v ?? 0) * scale(i)));
	return [...t.values()].reduce((a, b) => a + b, 0) / t.size;
};

describe('not set: the rule as before, to the bit', () => {
	it('an empty or null map runs exactly as a setting without it', () => {
		for (const extra of [{ catchmentChirps: true }, { reference: true }, {}]) {
			const base = JSON.stringify(runModel(catchment(extra)));
			expect(JSON.stringify(runModel(catchment({ ...extra, chirpsUnits: {} })))).toBe(base);
			expect(JSON.stringify(runModel(catchment({ ...extra, chirpsUnits: null })))).toBe(base);
		}
	});

	it('a choice for one unit leaves the other units’ rain as it was', () => {
		const base = runModel(catchment({ reference: true }));
		const out = runModel(catchment({ reference: true, chirpsUnits: { A: { correction: 'raw' } } }));
		for (const id of ['B', 'C']) expect(col(out, 'rain_unit', id)).toEqual(col(base, 'rain_unit', id));
		expect(unitOf(base, 'B').chirpsChoice).toBeUndefined();
	});
});

describe('raw CHIRPS: × k_unit, never bias-corrected', () => {
	it('ignores the reference gauge: the unit’s raw CHIRPS × clamp(MAP ÷ its raw mean annual)', () => {
		const x = catchment({ reference: true, chirpsUnits: { B: { correction: 'raw' } } });
		const out = runModel(x);
		const u = unitOf(out, 'B');
		expect(u).toMatchObject({ rule: 'unitChirps', factorSource: 'chirpsMap', chirpsChoice: 'raw' });
		expect(u.chirps?.source).toBe('map');
		const mean = meanAnnual(chirpsOf(x, 'B'));
		const k = clamp(900 / mean);
		expect(u.factor).toBeCloseTo(k, 12);
		const rain = col(out, 'rain_unit', 'B');
		const ch = chirpsOf(x, 'B');
		for (let i = 0; i < DAYS; i++) expect(rain[i], `day ${i}`).toBe(ch[i]! * u.factor!);
		expect(meanAnnual(rain)).toBeCloseTo(900, 6);
		// The other units keep the reference factors.
		expect(unitOf(out, 'C').chirps?.source).toBe('reference');
	});

	it('ignores the catchment’s §2.4b factors, even without a MAP to level it: raw as published, with a warning', () => {
		const x = catchment({ catchmentChirps: true, chirpsUnits: { C: { correction: 'raw' } } });
		const out = runModel(x);
		expect(unitOf(runModel(catchment({ catchmentChirps: true })), 'C').chirps?.source).toBe('bias');
		const u = unitOf(out, 'C');
		expect(u).toMatchObject({ rule: 'unitChirps', factorSource: 'chirpsRaw', factor: 1, chirpsChoice: 'raw', chirps: { source: 'raw' } });
		expect(col(out, 'rain_unit', 'C')).toEqual(chirpsOf(x, 'C'));
		expect(out.summary.warnings).toContain('unit rain: "Unit C": its CHIRPS runs raw: it has no MAP to level it, and its driver is raw CHIRPS, which is never bias-corrected');
	});

	it('replaces the unit’s own gauge: CHIRPS is its record, the gauge isn’t read', () => {
		const x = catchment({ chirpsUnits: { A: { correction: 'raw' } } });
		expect(unitOf(runModel(catchment()), 'A').rule).toBe('unitGauge');
		const out = runModel(x);
		const u = unitOf(out, 'A');
		expect(u).toMatchObject({ rule: 'unitChirps', rainKey: 'rain_chirps_mm@A', chirpsChoice: 'raw' });
		expect(u.days.unitGauge).toBe(0);
		expect(u.days.unitChirps).toBe(DAYS);
		const rain = col(out, 'rain_unit', 'A');
		chirpsOf(x, 'A').forEach((v, i) => expect(rain[i]).toBe(v * u.factor!));
	});
});

describe('bias-corrected CHIRPS', () => {
	it('with a reference gauge: the reference factors × k_unit, as rule 3 levels it when not set', () => {
		const base = runModel(catchment({ reference: true }));
		const out = runModel(catchment({ reference: true, chirpsUnits: { B: { correction: 'bias' } } }));
		expect(unitOf(out, 'B')).toMatchObject({ rule: 'unitChirps', factorSource: 'chirpsReference', chirpsChoice: 'bias' });
		expect(unitOf(out, 'B').chirps).toEqual(unitOf(base, 'B').chirps);
		expect(col(out, 'rain_unit', 'B')).toEqual(col(base, 'rain_unit', 'B'));
	});

	it('without one, the catchment’s §2.4b factors then k_unit: CHIRPS × f(day) × clamp(MAP ÷ the mean annual CHIRPS × f)', () => {
		const x = catchment({ catchmentChirps: true, chirpsUnits: { B: { correction: 'bias' } } });
		const out = runModel(x);
		const prep = prepareRun(x);
		const f = (i: number) => chirpsFactorOn(prep.chirpsCorrection, D0 + i) ?? 1;
		expect(f(0)).toBeCloseTo(1.25, 6);
		expect(f(150)).toBeCloseTo(2, 6);
		const u = unitOf(out, 'B');
		expect(u).toMatchObject({ rule: 'unitChirps', factorSource: 'chirpsBias', factor: null, chirpsChoice: 'bias' });
		const level = u.chirps as Extract<NonNullable<typeof u.chirps>, { source: 'bias' }>;
		expect(level.source).toBe('bias');
		const mean = meanAnnual(chirpsOf(x, 'B'), f);
		expect(level.kUnit!.meanAnnualMm).toBeCloseTo(mean, 9);
		expect(level.kUnit!.factor).toBeCloseTo(clamp(900 / mean), 12);
		expect(level.kUnit).toMatchObject({ years: [2015, 2016, 2017, 2018, 2019, 2020], inPeriod: false, clamped: false });
		const rain = col(out, 'rain_unit', 'B');
		const ch = chirpsOf(x, 'B');
		for (let i = 0; i < DAYS; i++) expect(rain[i], `day ${i}`).toBe(ch[i]! * (f(i) * level.kUnit!.factor));
		expect(meanAnnual(rain)).toBeCloseTo(900, 6);
		// Not set, the same unit reads its MAP factor alone (§2.4b only stands in without a MAP): unchanged.
		expect(unitOf(runModel(catchment({ catchmentChirps: true })), 'B').chirps?.source).toBe('map');
	});

	it('without a MAP, the §2.4b factors alone, as rule 3 does when not set', () => {
		const base = runModel(catchment({ catchmentChirps: true }));
		const out = runModel(catchment({ catchmentChirps: true, chirpsUnits: { C: { correction: 'bias' } } }));
		expect(unitOf(out, 'C').chirps).toEqual({ source: 'bias' });
		expect(col(out, 'rain_unit', 'C')).toEqual(col(base, 'rain_unit', 'C'));
	});

	it('with no point record to correct against, falls back to raw levelled to the unit’s MAP, and warns naming the unit', () => {
		const x = catchment({ chirpsUnits: { B: { correction: 'bias' }, C: { correction: 'bias' } } });
		const out = runModel(x);
		const raw = runModel(catchment({ chirpsUnits: { B: { correction: 'raw' }, C: { correction: 'raw' } } }));
		const u = unitOf(out, 'B');
		expect(u).toMatchObject({ rule: 'unitChirps', factorSource: 'chirpsMap', chirpsChoice: 'bias' });
		expect(col(out, 'rain_unit', 'B')).toEqual(col(raw, 'rain_unit', 'B'));
		expect(out.summary.warnings).toContain(
			`unit rain: "Unit B": its driver is CHIRPS, bias-corrected, but there is no point rainfall record to correct it against (no reference gauge, and the catchment has no CHIRPS bias factors), so it runs on its raw CHIRPS levelled to its MAP (× ${Math.round(u.factor! * 1000) / 1000})`
		);
		// No MAP either: raw as published, as raw would.
		expect(col(out, 'rain_unit', 'C')).toEqual(chirpsOf(x, 'C'));
		expect(out.summary.warnings.some((w) => w.startsWith('unit rain: "Unit C": its CHIRPS runs raw: it has no MAP to level it'))).toBe(true);
	});
});

describe('a choice that can’t apply', () => {
	it('a unit with no CHIRPS of its own runs as without the choice, with a warning', () => {
		const x = catchment({ chirpsUnits: { A: { correction: 'bias' } } });
		delete (x.series as Record<string, unknown>)['rain_chirps_mm@A'];
		const y = catchment();
		delete (y.series as Record<string, unknown>)['rain_chirps_mm@A'];
		const out = runModel(x);
		expect(unitOf(out, 'A').rule).toBe('unitGauge');
		expect(unitOf(out, 'A').chirpsChoice).toBeUndefined();
		expect(col(out, 'rain_unit', 'A')).toEqual(col(runModel(y), 'rain_unit', 'A'));
		expect(out.summary.warnings).toContain('unit rain: "Unit A": its driver is CHIRPS (bias-corrected), but it has no CHIRPS series of its own, so it runs on the rain it would without the choice');
	});

	it('a unit with a station assignment ignores the choice, with a warning', () => {
		const x = catchment({ chirpsUnits: { B: { correction: 'raw' } } });
		x.settings.rainStations = { units: { B: { stationId: 'nowhere' } } };
		const warnings: string[] = [];
		const r = unitRainRecipes({ settings: prepareRun(x).settings, series: x.series, nodes: x.model.nodes, chirpsCorrection: null, stationInputs: {} }, warnings)!;
		expect(r.find((u) => u.nodeId === 'B')!.chirpsChoice).toBeUndefined();
		expect(warnings).toContain('unit rain: "Unit B": it has both a rainfall station and CHIRPS as its driver, so the CHIRPS choice is ignored');
	});
});

describe('the setting, the fit and the copies', () => {
	it('unitRainError refuses a malformed map; resolveUnitRain keeps a usable one, in unit order', () => {
		expect(unitRainError({ mode: 'perUnit', chirpsUnits: { A: { correction: 'raw' }, B: { correction: 'bias' } } })).toBeNull();
		expect(unitRainError({ mode: 'perUnit', chirpsUnits: [] })).toMatch(/map of unit/);
		expect(unitRainError({ mode: 'perUnit', chirpsUnits: { A: { correction: 'quantile' } } })).toMatch(/bias, raw/);
		expect(unitRainError({ mode: 'perUnit', chirpsUnits: { A: 'raw' } })).toMatch(/bias, raw/);
		expect(resolveUnitRain({ mode: 'perUnit', chirpsUnits: { B: { correction: 'bias' }, A: { correction: 'raw' } } }, []).chirpsUnits).toEqual({ A: { correction: 'raw' }, B: { correction: 'bias' } });
		expect('chirpsUnits' in resolveUnitRain({ mode: 'perUnit', chirpsUnits: {} }, [])).toBe(false);
		// The retired catchment mode keeps it, as it keeps the rest of the setting.
		expect(resolveUnitRain({ mode: 'catchment', chirpsUnits: { A: { correction: 'raw' } } }, []).chirpsUnits).toEqual({ A: { correction: 'raw' } });
	});

	it('the fingerprint records the choice: another choice, or one on a side only, is “Forcing changed since fit”', () => {
		const fp = (c: UnitRainSettings['chirpsUnits']) => unitRainFingerprintOfSummary(runModel(catchment({ reference: true, chirpsUnits: c })).summary.unitRain);
		const none = fp(null)!;
		const bias = fp({ B: { correction: 'bias' } })!;
		expect(bias.units.find((u) => u.nodeId === 'B')!.chirpsChoice).toBe('bias');
		expect(unitRainFingerprintError(bias)).toBeNull();
		expect(unitRainFingerprintError({ ...bias, units: [{ ...bias.units[0]!, chirpsChoice: 'quantile' }] })).toMatch(/CHIRPS driver/);
		// Same rain as not set (rule 3, reference factors × k_unit), but the choice is recorded, so it reads changed.
		expect(unitRainFingerprintChanged(none, bias)).toBe(true);
		expect(unitRainFingerprintChanged(bias, fp({ B: { correction: 'bias' } }))).toBe(false);
		expect(unitRainFingerprintChanged(bias, fp({ B: { correction: 'raw' } }))).toBe(true);
	});

	it('a fit reads “Forcing changed since fit” from the settings alone when a unit’s choice changes', () => {
		const x = catchment({ reference: true, chirpsUnits: { B: { correction: 'raw' } } });
		const settings = prepareRun(x).settings;
		const ctx = { settings, validate: false, validationRecord: null, engineVersion: 'test', fittedAt: '2026-11-03T00:00:00Z' };
		const record = fitRecordFromReport(calibrate(x, { budget: 6, seed: 1 }), ctx);
		expect(record.forcing!.unitRain!.units.find((u) => u.nodeId === 'B')!.chirpsChoice).toBe('raw');
		const status = (c: UnitRainSettings['chirpsUnits']) => fitRecordStatus({ ...settings, unitRain: { ...settings.unitRain!, chirpsUnits: c } }, record).forcingChanged;
		expect(status({ B: { correction: 'raw' } })).toBe(false);
		expect(status({ B: { correction: 'bias' } })).toBe(true);
		expect(status(null)).toBe(true);
		// A choice for a unit that had no usable CHIRPS at the fit (none ran) isn't a change from the settings alone.
		const y = catchment({ reference: true });
		delete (y.series as Record<string, unknown>)['rain_chirps_mm@A'];
		const r2 = fitRecordFromReport(calibrate(y, { budget: 6, seed: 1 }), { ...ctx, settings: prepareRun(y).settings });
		expect(fitRecordStatus({ ...prepareRun(y).settings, unitRain: { ...prepareRun(y).settings.unitRain!, chirpsUnits: { A: { correction: 'raw' } } } }, r2).forcingChanged).toBe(false);
	});

	it('every invariant holds, and a resumed run is the uninterrupted one', () => {
		const x = catchment({ catchmentChirps: true, reference: false, chirpsUnits: { A: { correction: 'raw' }, B: { correction: 'bias' }, C: { correction: 'bias' } } });
		expect(checkInvariants(x, runModel(x))).toBeNull();
		expect(checkResume(x, Math.floor(DAYS / 2))).toBeNull();
	});

	it('the run comparison names the change', () => {
		const a = catchment();
		const b = catchment({ chirpsUnits: { B: { correction: 'raw' } } });
		const changes = diffInputs({ settings: a.settings, model: a.model, series: {} } as never, { settings: b.settings, model: b.model, series: {} } as never).map((c) => c.text);
		expect(changes.some((t) => t.includes('CHIRPS as the driver of the unit B (raw)'))).toBe(true);
	});
});

describe('Run readiness notes (unitChirpsChoiceNotes)', () => {
	const nodes = [
		{ id: 'a', name: 'A', kind: 'farm' as const, areaKm2: 1, mapMm: 600, mapSource: 'x' },
		{ id: 'b', name: 'B', kind: 'farm' as const, areaKm2: 1, mapMm: null, mapSource: null },
		{ id: 'c', name: 'C', kind: 'farm' as const, areaKm2: 1, mapMm: 500, mapSource: 'x' },
		{ id: 'd', name: 'D', kind: 'farm' as const, areaKm2: 0, mapMm: 500, mapSource: 'x' }
	];
	const chirps = (id: string) => ({ kind: 'rain_chirps_mm', siteNodeId: id });
	const choices = { a: { correction: 'bias' }, b: { correction: 'bias' }, c: { correction: 'raw' }, d: { correction: 'bias' } };
	it('names the units with no CHIRPS of their own, and the bias-corrected ones with no point record', () => {
		const n = unitChirpsChoiceNotes(nodes, { unitRain: { chirpsUnits: choices } }, [chirps('a'), chirps('c')]);
		expect(n.noChirps.map((x) => x.id)).toEqual(['b']);
		expect(n.rawInstead.map((x) => x.id)).toEqual(['a']);
	});
	it('a reference gauge, or a catchment gauge and CHIRPS for §2.4b, is a point record; a station unit isn’t listed', () => {
		const series = [chirps('a'), chirps('b')];
		expect(unitChirpsChoiceNotes(nodes, { unitRain: { chirpsUnits: choices, reference: { gauge: 'rain_catchment_mm', unitId: 'a' } } }, series).rawInstead).toEqual([]);
		const withBias = [...series, { kind: 'rain_catchment_mm', siteNodeId: null }, { kind: 'rain_chirps_mm', siteNodeId: null }];
		expect(unitChirpsChoiceNotes(nodes, { unitRain: { chirpsUnits: choices } }, withBias).rawInstead).toEqual([]);
		expect(unitChirpsChoiceNotes(nodes, { unitRain: { chirpsUnits: choices }, chirpsBiasCorrection: 'none' }, withBias).rawInstead.map((x) => x.id)).toEqual(['a', 'b']);
		expect(unitChirpsChoiceNotes(nodes, { unitRain: { chirpsUnits: choices }, rainStations: { units: { a: { stationId: 's' } } } }, series).rawInstead.map((x) => x.id)).toEqual(['b']);
	});
});

describe('the form’s preview (unitChirpsChoicePreview)', () => {
	it('gives each chosen unit the level a run gives it, from the stored input with the draft choices', () => {
		const x = catchment({ reference: true });
		const draft = { B: { correction: 'raw' as const }, C: { correction: 'bias' as const }, G: { correction: 'raw' as const } };
		const p = unitChirpsChoicePreview(x, draft);
		const run = runModel(catchment({ reference: true, chirpsUnits: draft }));
		expect(Object.keys(p)).toEqual(['B', 'C']);
		expect(p.B!.level).toEqual(unitOf(run, 'B').chirps);
		expect(p.C!.level).toEqual(unitOf(run, 'C').chirps);
		expect(p.B!.applies).toBe(true);
		// A unit without CHIRPS of its own: the choice can't apply, and the run's warning says so.
		delete (x.series as Record<string, unknown>)['rain_chirps_mm@B'];
		const q = unitChirpsChoicePreview(x, draft).B!;
		expect(q).toMatchObject({ applies: false, level: null });
		expect(q.warnings.some((w) => w.includes('no CHIRPS series of its own'))).toBe(true);
	});

	it('the form’s unsaved unit-rain setting replaces the stored one: a reference gauge added in the draft corrects', () => {
		const x = catchment({ reference: true });
		const stored = { ...x, settings: { ...x.settings, unitRain: { mode: 'perUnit' as const } } };
		expect(unitChirpsChoicePreview(stored, { B: { correction: 'bias' } }).B!.level?.source).toBe('map');
		const q = unitChirpsChoicePreview(stored, { B: { correction: 'bias' } }, undefined, x.settings.unitRain).B!;
		expect(q.level?.source).toBe('reference');
	});

	it('a unit the stored setting gives a station previews as the form will save it, on CHIRPS', () => {
		const x = catchment();
		x.settings.rainStations = { units: { B: { stationId: 'nowhere' } } };
		expect(unitChirpsChoicePreview(x, { B: { correction: 'raw' } }).B).toMatchObject({ applies: true, level: { source: 'map' } });
	});
});
