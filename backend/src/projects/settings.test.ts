import { readFileSync } from 'node:fs';
import { defaultProjectSettings, PE_SOURCE_MAX, resolveChirpsFitPeriod, resolveRainSource, RETIRED_CALIBRATION_KEYS } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { mergeSettings, patchSettings, remapSettingNodeIds, SettingsPatch, FitRecord } from './settings.js';

describe('SettingsPatch.dataQuality', () => {
	const ok = (dataQuality: unknown) => SettingsPatch.safeParse({ dataQuality }).success;

	it('accepts the defaults, any subset, and the boundary values', () => {
		expect(ok(defaultProjectSettings().dataQuality)).toBe(true);
		expect(ok({})).toBe(true);
		expect(ok({ agreementMinRatio: 1, agreementMaxRatio: 1 })).toBe(true);
		expect(ok({ agreementMinDays: 1 })).toBe(true);
		expect(ok({ agreementMinDays: 366, agreementMaxRatio: 100 })).toBe(true);
	});

	it('rejects ratios on the wrong side of 1, fractional or out-of-range days, and unknown keys', () => {
		for (const bad of [
			{ agreementMinRatio: 0 },
			{ agreementMinRatio: -0.5 },
			{ agreementMinRatio: 1.01 },
			{ agreementMaxRatio: 0.99 },
			{ agreementMaxRatio: 101 },
			{ agreementMinDays: 0 },
			{ agreementMinDays: 90.5 },
			{ agreementMinDays: 367 },
			{ agreementMinRatio: '0.5' },
			{ minRatio: 0.5 },
			null,
			[0.5]
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});
});

describe('mergeSettings', () => {
	it('fills dataQuality from the defaults for settings stored before it existed, and field by field', () => {
		expect(mergeSettings({}).dataQuality).toEqual({ agreementMinRatio: 2 / 3, agreementMaxRatio: 1.5, agreementMinDays: 90 });
		expect(mergeSettings({ dataQuality: { agreementMinDays: 30 } }).dataQuality).toEqual({
			agreementMinRatio: 2 / 3,
			agreementMaxRatio: 1.5,
			agreementMinDays: 30
		});
	});
});

describe('SettingsPatch.runoffModel', () => {
	const ok = (runoffModel: unknown) => SettingsPatch.safeParse({ runoffModel }).success;

	it('accepts the models the engine has (GR4J), and nothing else, naming why legacy is refused', () => {
		expect(ok(defaultProjectSettings().runoffModel)).toBe(true);
		expect(ok('gr4j')).toBe(true);
		for (const bad of ['legacy', 'pitman', '', null, 1]) expect(ok(bad), JSON.stringify(bad)).toBe(false);
		const legacy = SettingsPatch.safeParse({ runoffModel: 'legacy' });
		expect(legacy.success ? '' : legacy.error.issues[0]!.message).toMatch(/legacy runoff model was removed in engine 1\.0\.0/);
	});

	it('defaults to GR4J when none is stored', () => {
		expect(mergeSettings({}).runoffModel).toBe('gr4j');
	});
});

describe('what the legacy runoff model left in stored settings (engine 1.0.0, issue #16)', () => {
	const legacyCalibration = { a: 0.2, b: 1.4, summerMonths: [1, 2], recessionFactors: [0.9], rainThresholdMm: 3, catchmentAreaKm2: 12 };

	it('mergeSettings reads a project still stored as legacy as GR4J, without the legacy keys or a legacy fit', () => {
		const s = mergeSettings({ runoffModel: 'legacy', calibration: legacyCalibration, fitRecord: { model: 'legacy', free: ['a'], params: { a: 0.2 } } }) as unknown as Record<string, unknown>;
		expect(s.runoffModel).toBe('gr4j');
		expect(s.calibration).toEqual({ rainThresholdMm: 3, catchmentAreaKm2: 12 });
		expect(s.fitRecord).toBeNull();
		// Positive control: a GR4J fit is kept.
		const fit = { model: 'gr4j', free: ['x1'], params: { x1: 400 } };
		expect((mergeSettings({ fitRecord: fit }) as unknown as Record<string, unknown>).fitRecord).toEqual(fit);
	});

	it('SettingsPatch drops the legacy calibration keys (an older export) and checks the two that are left', () => {
		const r = SettingsPatch.safeParse({ calibration: legacyCalibration });
		expect(r.success && r.data.calibration).toEqual({ rainThresholdMm: 3, catchmentAreaKm2: 12 });
		expect(SettingsPatch.safeParse({ calibration: { rainThresholdMm: -1 } }).success).toBe(false);
		expect(SettingsPatch.safeParse({ calibration: { catchmentAreaKm2: null } }).success).toBe(true);
		expect(SettingsPatch.safeParse({ calibration: { somethingElse: 1 } }).success).toBe(false);
	});

	it('migration 064 drops exactly the engine’s RETIRED_CALIBRATION_KEYS', () => {
		const sql = readFileSync(new URL('../../migrations/064_remove_legacy_runoff.sql', import.meta.url), 'utf8');
		const arrays = [...sql.matchAll(/ARRAY\[([^\]]+)\]::text\[\]/g)].map((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((k) => k[1]).sort());
		expect(arrays).toHaveLength(2);
		for (const keys of arrays) expect(keys).toEqual([...RETIRED_CALIBRATION_KEYS].sort());
	});
});

describe('SettingsPatch.chirpsBiasCorrection', () => {
	const ok = (chirpsBiasCorrection: unknown) => SettingsPatch.safeParse({ chirpsBiasCorrection }).success;

	it('accepts monthly and none, and nothing else', () => {
		expect(ok('monthly')).toBe(true);
		expect(ok('none')).toBe(true);
		for (const bad of ['yearly', '', null, true, 1]) expect(ok(bad), JSON.stringify(bad)).toBe(false);
	});

	it('defaults to monthly for settings stored before it existed', () => {
		expect(mergeSettings({}).chirpsBiasCorrection).toBe('monthly');
		expect(mergeSettings({ chirpsBiasCorrection: 'none' }).chirpsBiasCorrection).toBe('none');
	});
});

describe('SettingsPatch.chirpsFitPeriod (engine ≥ 0.29.0)', () => {
	const ok = (chirpsFitPeriod: unknown) => SettingsPatch.safeParse({ chirpsFitPeriod }).success;
	const r = (fromWaterYear: number, toWaterYear: number, reason = 'new network') => ({ fromWaterYear, toWaterYear, reason });

	it('accepts the whole record and non-overlapping water-year ranges, each with a reason', () => {
		expect(ok('all')).toBe(true);
		expect(ok([r(1990, 2004), r(2005, 2019)])).toBe(true);
		expect(ok([r(2005, 2005)])).toBe(true);
	});

	it('refuses anything the engine would drop', () => {
		// 'segments' is not a mode: the double-mass breaks only propose ranges.
		for (const bad of ['segments', 'latest', '', null, 1, [], [r(2005, 2004)], [r(1990, 2004, ' ')], [r(1990, 2004), r(2004, 2010)], [r(1799, 1800)], [{ ...r(1990, 1999), extra: 1 }], [r(1990.5, 1999)]]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('defaults to the whole record for settings stored before it existed', () => {
		expect(mergeSettings({}).chirpsFitPeriod).toBe('all');
		expect(mergeSettings({ chirpsFitPeriod: [r(1990, 2004)] }).chirpsFitPeriod).toEqual([r(1990, 2004)]);
	});

	// The API schema and the engine's resolver must agree on what a valid fit period is, so a value the
	// API stores is never silently changed by a run, and one the engine would drop is refused up front.
	it('agrees with the engine’s resolveChirpsFitPeriod on a table of valid and invalid values', () => {
		const table: [string, unknown][] = [
			['whole record', 'all'],
			['one range', [r(1990, 2004)]],
			['two ranges, unsorted', [r(2005, 2019), r(1990, 2004)]],
			['a one-year range', [r(2005, 2005)]],
			['the year bounds', [r(1800, 1800), r(2200, 2200)]],
			['a reason padded with spaces', [r(1990, 2004, '  network  ')]],
			['a reason of 500 characters', [r(1990, 2004, 'x'.repeat(500))]],
			['100 ranges', Array.from({ length: 100 }, (_, i) => r(1800 + i, 1800 + i))],
			['segments (not a mode)', 'segments'],
			['an unknown mode', 'latest'],
			['an empty string', ''],
			['a number', 1990],
			['an object', { fromWaterYear: 1990, toWaterYear: 2004, reason: 'x' }],
			['an empty list', []],
			['a range ending before it starts', [r(2005, 2004)]],
			['a blank reason', [r(1990, 2004, '   ')]],
			['a missing reason', [{ fromWaterYear: 1990, toWaterYear: 2004 }]],
			['a reason of 501 characters', [r(1990, 2004, 'x'.repeat(501))]],
			['a fractional year', [r(1990.5, 2004)]],
			['a year as a string', [{ fromWaterYear: '1990', toWaterYear: 2004, reason: 'x' }]],
			['a year before 1800', [r(1799, 1800)]],
			['a year after 2200', [r(2200, 2201)]],
			['an extra field', [{ ...r(1990, 2004), note: 'x' }]],
			['a null entry', [null]],
			['overlapping ranges', [r(1990, 2004), r(2004, 2010)]],
			['one range inside another', [r(1990, 2010), r(1995, 2000)]],
			['101 ranges', Array.from({ length: 101 }, (_, i) => r(1800 + i, 1800 + i))]
		];
		for (const [name, value] of table) {
			const warnings: string[] = [];
			const resolved = resolveChirpsFitPeriod(value, warnings);
			// The engine keeps a value as it is (up to order and trimming) exactly when it has nothing to warn about.
			const engineOk = warnings.length === 0;
			if (engineOk && Array.isArray(value)) expect((resolved as unknown[]).length, name).toBe(value.length);
			expect(SettingsPatch.safeParse({ chirpsFitPeriod: value }).success, name).toBe(engineOk);
		}
	});
});

describe('SettingsPatch.rainSource (engine ≥ 0.30.0)', () => {
	const ok = (rainSource: unknown) => SettingsPatch.safeParse({ rainSource }).success;
	const fixed = {
		start: '2012-10-01',
		end: '2019-09-30',
		series: 'rain_catchment_alt_mm',
		factors: new Array(12).fill(1.1),
		provenance: { source: 'hydrologist', fittedFrom: '2012-10-01', fittedTo: '2015-09-30', method: 'overlap with the old gauges' },
		reason: 'automatic station'
	};
	const fit = { ...fixed, factors: 'fit', provenance: undefined, fitReference: { series: 'rain_reanalysis_mm', fromWaterYear: 1995, toWaterYear: 2011 } };
	const { provenance: _p, ...fitNoProv } = fit;
	const fallback = { series: 'rain_reanalysis_mm', fromWaterYear: 1995, toWaterYear: 2011 };

	it('accepts none, fixed factors with provenance, and a fit against a gauge-free reference', () => {
		expect(ok([])).toBe(true);
		expect(ok([fixed])).toBe(true);
		expect(ok([fitNoProv])).toBe(true);
		expect(ok([{ ...fitNoProv, gaugeInChirps: true, fallback }])).toBe(true);
		expect(mergeSettings({}).rainSource).toEqual([]);
	});

	// The API schema and the engine's resolver must agree, so a stored value never runs differently from what was validated.
	it('agrees with the engine’s resolveRainSource on a table of valid and invalid values', () => {
		const table: [string, unknown][] = [
			['none', []],
			['fixed', [fixed]],
			['fit', [fitNoProv]],
			['two periods, unsorted', [{ ...fixed, start: '2020-01-01', end: '2020-12-31' }, fitNoProv]],
			['a reanalysis fallback', [{ ...fixed, fallback }]],
			['CHIRPS as the fit reference, gauge not in CHIRPS', [{ ...fitNoProv, fitReference: { ...fitNoProv.fitReference, series: 'rain_chirps_mm' } }]],
			['CHIRPS as the fit reference, gauge in CHIRPS', [{ ...fitNoProv, gaugeInChirps: true, fallback, fitReference: { ...fitNoProv.fitReference, series: 'rain_chirps_mm' } }]],
			['gauge in CHIRPS without a named fallback', [{ ...fitNoProv, gaugeInChirps: true }]],
			['fixed factors without provenance', [{ ...fixed, provenance: undefined }]],
			['a factor out of range', [{ ...fixed, factors: [...new Array(11).fill(1), 4.5] }]],
			['11 factors', [{ ...fixed, factors: new Array(11).fill(1) }]],
			['a fit without a reference', [{ ...fitNoProv, fitReference: undefined }]],
			['overlapping periods', [fixed, { ...fitNoProv, start: '2019-01-01', end: '2021-01-01' }]],
			['a blank reason', [{ ...fixed, reason: ' ' }]],
			['an unknown series', [{ ...fixed, series: 'rain_catchment_mm' }]],
			['an extra field', [{ ...fixed, note: 'x' }]],
			['a bad date', [{ ...fixed, end: '2019-02-30' }]],
			['not a list', { ...fixed }],
			['101 periods', Array.from({ length: 101 }, (_, i) => ({ ...fixed, start: `${1800 + i}-01-01`, end: `${1800 + i}-06-30` }))]
		];
		for (const [name, value] of table) {
			const warnings: string[] = [];
			const resolved = resolveRainSource(value, warnings);
			const engineOk = warnings.length === 0;
			if (engineOk && Array.isArray(value)) expect(resolved.length, name).toBe(value.length);
			expect(ok(value), name).toBe(engineOk);
		}
	});

	it('is recorded in a fit record’s forcing, optionally', () => {
		expect(FitRecord.shape.forcing.unwrap().shape.rainSource.safeParse([fixed]).success).toBe(true);
		expect(FitRecord.shape.forcing.unwrap().shape.rainSource.safeParse([{ ...fixed, reason: '' }]).success).toBe(false);
	});
});

describe('SettingsPatch.panCoefficientSource (engine ≥ 0.31.1, issue #39)', () => {
	const parse = (v: unknown) => SettingsPatch.safeParse({ panCoefficientSource: v });

	it('accepts a note up to the limit, and empty (none); trims it', () => {
		expect(parse('FAO-56 Table 5, Case A, 10 m green crop fetch').success).toBe(true);
		expect(parse('').success).toBe(true);
		expect(parse('x'.repeat(PE_SOURCE_MAX)).success).toBe(true);
		const r = parse('  FAO-56 Table 5  ');
		expect(r.success && r.data.panCoefficientSource).toBe('FAO-56 Table 5');
		expect(mergeSettings({}).panCoefficientSource).toBe('');
	});

	it('rejects a too-long note or a non-string', () => {
		expect(parse('x'.repeat(PE_SOURCE_MAX + 1)).success).toBe(false);
		expect(parse(7).success).toBe(false);
		expect(parse(null).success).toBe(false);
	});

	it('is recorded in a fit record’s forcing, optionally', () => {
		const forcing = FitRecord.shape.forcing.unwrap().shape;
		expect(forcing.panCoefficientSource.safeParse('FAO-56 Table 5').success).toBe(true);
		expect(forcing.panCoefficientSource.safeParse(undefined).success).toBe(true);
	});
});

describe('SettingsPatch.pe (engine ≥ 0.31.0, issue #39)', () => {
	const parse = (pe: unknown) => SettingsPatch.safeParse({ pe });
	const ok = (pe: unknown) => parse(pe).success;
	const monthlyPe = { kind: 'monthly', mm: [90, 120, 150, 170, 150, 130, 90, 60, 45, 45, 55, 70], source: 'Station ET₀ (FAO-56) × 1.0' };

	it('accepts both kinds, the 0 and 10 000 mm bounds, a zero row, and a source at the limit; trims the source', () => {
		expect(ok({ kind: 'pan' })).toBe(true);
		expect(ok(monthlyPe)).toBe(true);
		expect(ok({ ...monthlyPe, mm: new Array(12).fill(0) })).toBe(true);
		expect(ok({ ...monthlyPe, mm: new Array(12).fill(10_000) })).toBe(true);
		expect(ok({ ...monthlyPe, source: 'x'.repeat(PE_SOURCE_MAX) })).toBe(true);
		const r = parse({ ...monthlyPe, source: '  ERA5 ET₀  ' });
		expect(r.success && (r.data.pe as { source: string }).source).toBe('ERA5 ET₀');
		expect(mergeSettings({}).pe).toEqual({ kind: 'pan' });
		expect(mergeSettings({ pe: monthlyPe }).pe).toEqual(monthlyPe);
	});

	it('rejects an unknown kind, a bad row, a missing/blank/too-long source, and extra keys', () => {
		for (const [name, bad] of [
			['unknown kind', { kind: 'et0' }],
			['no kind', { mm: monthlyPe.mm, source: 'x' }],
			['pan with a row', { kind: 'pan', mm: monthlyPe.mm }],
			['11 values', { ...monthlyPe, mm: monthlyPe.mm.slice(1) }],
			['13 values', { ...monthlyPe, mm: [...monthlyPe.mm, 1] }],
			['a negative month', { ...monthlyPe, mm: [...monthlyPe.mm.slice(1), -1] }],
			['over 10 000 mm', { ...monthlyPe, mm: [...monthlyPe.mm.slice(1), 10_001] }],
			['NaN', { ...monthlyPe, mm: [...monthlyPe.mm.slice(1), NaN] }],
			['Infinity', { ...monthlyPe, mm: [...monthlyPe.mm.slice(1), Infinity] }],
			['a string month', { ...monthlyPe, mm: [...monthlyPe.mm.slice(1), '50'] }],
			['no source', { kind: 'monthly', mm: monthlyPe.mm }],
			['a blank source', { ...monthlyPe, source: '   ' }],
			['a too-long source', { ...monthlyPe, source: 'x'.repeat(PE_SOURCE_MAX + 1) }],
			['an extra key', { ...monthlyPe, factor: 1 }],
			['null', null],
			['a bare string', 'pan']
		] as [string, unknown][]) {
			expect(ok(bad), name).toBe(false);
		}
	});

	it('is replaced whole by a patch, so switching back to pan drops the monthly row', () => {
		const stored = patchSettings({}, { pe: monthlyPe });
		expect(stored.pe).toEqual(monthlyPe);
		expect(patchSettings(stored, { pe: { kind: 'pan' } }).pe).toEqual({ kind: 'pan' });
		expect(patchSettings(stored, { lakeEvapFactor: 0.8 }).pe).toEqual(monthlyPe);
	});

	it('is recorded in a fit record’s forcing, optionally', () => {
		const forcing = FitRecord.shape.forcing.unwrap();
		const base = { panCoefficient: new Array(12).fill(0.7), apanMm: new Array(12).fill(150) };
		expect(forcing.safeParse(base).success).toBe(true);
		expect(forcing.safeParse({ ...base, pe: { kind: 'pan' } }).success).toBe(true);
		expect(forcing.safeParse({ ...base, pe: monthlyPe }).success).toBe(true);
		expect(forcing.safeParse({ ...base, pe: { ...monthlyPe, source: '' } }).success).toBe(false);
	});
});

describe('SettingsPatch.arealRain (engine ≥ 1.13.0)', () => {
	const ok = (arealRain: unknown) => SettingsPatch.safeParse({ arealRain }).success;
	const areal = { factors: new Array(12).fill(1.9), method: 'map', source: 'invented MAP 560 mm ÷ the forcing’s mean annual rain' };

	it('accepts none, 12 factors within 0.25–4 with a method and a source, and trims the source', () => {
		expect(ok(null)).toBe(true);
		expect(ok(areal)).toBe(true);
		expect(ok({ ...areal, factors: [0.25, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], method: 'stations' })).toBe(true);
		expect(ok({ ...areal, method: 'fitted' })).toBe(true);
		const r = SettingsPatch.safeParse({ arealRain: { ...areal, source: '  MAP  ' } });
		expect(r.success && (r.data.arealRain as { source: string }).source).toBe('MAP');
		expect(mergeSettings({}).arealRain).toBeNull();
		expect(mergeSettings({ arealRain: areal }).arealRain).toEqual(areal);
	});

	it('rejects a bad row, an unknown method, a missing/blank/too-long source, and extra keys', () => {
		for (const [name, bad] of [
			['11 factors', { ...areal, factors: areal.factors.slice(1) }],
			['below 0.25', { ...areal, factors: [...areal.factors.slice(1), 0.2] }],
			['above 4', { ...areal, factors: [...areal.factors.slice(1), 4.1] }],
			['NaN', { ...areal, factors: [...areal.factors.slice(1), NaN] }],
			['unknown method', { ...areal, method: 'guess' }],
			['no source', { factors: areal.factors, method: 'map' }],
			['a blank source', { ...areal, source: '  ' }],
			['a too-long source', { ...areal, source: 'x'.repeat(PE_SOURCE_MAX + 1) }],
			['an extra key', { ...areal, mapMm: 560 }],
			['a bare number', 1.9]
		] as [string, unknown][]) {
			expect(ok(bad), name).toBe(false);
		}
	});

	it('is replaced whole by a patch, and recorded in a fit record’s forcing, optionally', () => {
		const stored = patchSettings({}, { arealRain: areal });
		expect(stored.arealRain).toEqual(areal);
		expect(patchSettings(stored, { arealRain: null }).arealRain).toBeNull();
		expect(patchSettings(stored, { lakeEvapFactor: 0.8 }).arealRain).toEqual(areal);
		const forcing = FitRecord.shape.forcing.unwrap();
		const base = { panCoefficient: new Array(12).fill(0.7), apanMm: new Array(12).fill(150) };
		expect(forcing.safeParse(base).success).toBe(true);
		expect(forcing.safeParse({ ...base, arealRain: null }).success).toBe(true);
		expect(forcing.safeParse({ ...base, arealRain: areal }).success).toBe(true);
		expect(forcing.safeParse({ ...base, arealRain: { ...areal, source: '' } }).success).toBe(false);
	});
});

describe('SettingsPatch.gr4j and panCoefficient', () => {
	const ok = (patch: unknown) => SettingsPatch.safeParse(patch).success;

	it('accepts the defaults, any subset, and the bounds', () => {
		expect(ok({ gr4j: defaultProjectSettings().gr4j, panCoefficient: defaultProjectSettings().panCoefficient })).toBe(true);
		expect(ok({ gr4j: {} })).toBe(true);
		expect(ok({ gr4j: { x1: 10, x2: -5, x3: 1, x4: 0.5, warmupDays: 0 } })).toBe(true);
		expect(ok({ gr4j: { x1: 3000, x2: 3, x3: 1000, x4: 10, warmupDays: 3650 } })).toBe(true);
	});

	it('rejects values outside the bounds, fractional warm-ups, unknown keys and bad pan coefficients', () => {
		for (const bad of [
			{ gr4j: { x1: 9 } },
			{ gr4j: { x2: 3.5 } },
			{ gr4j: { x3: 0 } },
			{ gr4j: { x4: 11 } },
			{ gr4j: { warmupDays: 1.5 } },
			{ gr4j: { warmupDays: -1 } },
			{ gr4j: { x5: 1 } },
			{ gr4j: { x1: '350' } },
			{ panCoefficient: [0.7] },
			{ panCoefficient: new Array(12).fill(-0.1) },
			{ panCoefficient: new Array(12).fill(2.1) }
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('fills GR4J parameters field by field for settings stored before them', () => {
		expect(mergeSettings({}).gr4j).toEqual({ x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 });
		expect(mergeSettings({ gr4j: { x1: 500 } }).gr4j.x1).toBe(500);
		expect(mergeSettings({ gr4j: { x1: 500 } }).gr4j.x3).toBe(90);
		expect(mergeSettings({}).panCoefficient).toEqual(new Array(12).fill(0.7));
	});
});

describe('SettingsPatch.wr2012', () => {
	const ok = (wr2012: unknown) => SettingsPatch.safeParse({ wr2012 }).success;
	const issues = (wr2012: unknown) => {
		const r = SettingsPatch.safeParse({ wr2012 });
		return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
	};
	// Synthetic: an invented quaternary and round numbers.
	const monthly = (mar: number) => [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30].map((d) => (mar * d) / 365.25);
	const reference = {
		quaternary: 'Z99A',
		areaKm2: 100,
		marMm3: 10,
		monthlyMm3: monthly(10),
		periodStart: 1990,
		periodEnd: 2009,
		mapMm: 600,
		source: 'Synthetic table'
	};

	it('accepts the defaults, a full reference, any subset of the groups, and clearing the reference', () => {
		expect(ok(defaultProjectSettings().wr2012)).toBe(true);
		expect(ok({ ...defaultProjectSettings().wr2012, reference })).toBe(true);
		expect(ok({ reference: { ...reference, mapMm: null } })).toBe(true);
		expect(ok({ reference: null })).toBe(true);
		expect(ok({ scaling: 'areaRain', lowFlowMonths: [12, 1, 2] })).toBe(true);
		expect(ok({ calibrationPenalty: { enabled: true, weight: 10, marLowMm3: null, marHighMm3: null } })).toBe(true);
		expect(ok({ calibrationPenalty: { enabled: true, weight: 10, marLowMm3: 5, marHighMm3: 5 } })).toBe(true); // equal bounds: a zero-width band
		expect(ok({})).toBe(true);
	});

	it('rejects a MAR larger than the rain volume over the quaternary (MAP × area)', () => {
		// 600 mm × 100 km² = 60 Mm³ a year of rain.
		expect(ok({ reference: { ...reference, marMm3: 60, monthlyMm3: monthly(60) } })).toBe(true);
		expect(issues({ reference: { ...reference, marMm3: 61, monthlyMm3: monthly(61) } })).toEqual(['wr2012.reference.marMm3']);
	});

	it('rejects monthly means (Mm³ per month) whose sum is more than 5 % off the MAR, e.g. values typed in m³/s', () => {
		expect(ok({ reference: { ...reference, monthlyMm3: monthly(10.4) } })).toBe(true);
		expect(issues({ reference: { ...reference, monthlyMm3: monthly(10.6) } })).toEqual(['wr2012.reference.monthlyMm3']);
		// 10 Mm³/a is ~0.317 m³/s; typed per month in m³/s the sum is ~3.8, not 10.
		expect(issues({ reference: { ...reference, monthlyMm3: new Array(12).fill(0.317) } })).toEqual(['wr2012.reference.monthlyMm3']);
	});

	it('rejects incomplete or malformed references, bad thresholds, months and weights', () => {
		const { source: _source, ...noSource } = reference;
		for (const bad of [
			{ reference: { ...reference, quaternary: '' } },
			{ reference: { ...reference, source: ' ' } },
			{ reference: { ...reference, areaKm2: 0 } },
			{ reference: { ...reference, monthlyMm3: [1, 2] } },
			{ reference: { ...reference, periodStart: 2010, periodEnd: 2000 } },
			{ reference: { ...reference, periodStart: 1990.5 } },
			{ reference: { ...reference, mapMm: 0 } },
			{ reference: { ...reference, extra: 1 } },
			{ reference: noSource },
			{ scaling: 'rain' },
			{ lowFlowMonths: [0] },
			{ lowFlowMonths: [] },
			{ flags: { notePct: 10, queryPct: 25, queryWetterPct: 15 } },
			{ flags: { notePct: 30, queryPct: 25, queryWetterPct: 15, unusablePct: 50 } },
			{ flags: { notePct: 10, queryPct: 25, queryWetterPct: 30, unusablePct: 50 } },
			{ flags: { notePct: 0, queryPct: 25, queryWetterPct: 15, unusablePct: 50 } },
			{ calibrationPenalty: { enabled: true, weight: 11 } },
			{ calibrationPenalty: { enabled: 'yes', weight: 1 } },
			{ calibrationPenalty: { enabled: true, weight: 1 } }, // missing the (now required) band fields
			{ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: 10, marHighMm3: 5 } }, // low > high
			{ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: 5, marHighMm3: null } }, // one-sided
			{ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: null, marHighMm3: 5 } },
			{ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: -1, marHighMm3: 5 } },
			{ penalty: true }
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('defaults to no reference, area scaling, 10/25/15/50 % thresholds and the penalty off', () => {
		expect(mergeSettings({}).wr2012).toEqual({
			reference: null,
			scaling: 'area',
			lowFlowMonths: null,
			flags: { notePct: 10, queryPct: 25, queryWetterPct: 15, unusablePct: 50 },
			calibrationPenalty: { enabled: false, weight: 0.5, marLowMm3: null, marHighMm3: null }
		});
	});

	it('accepts a valid MAR band', () => {
		expect(ok({ calibrationPenalty: { enabled: true, weight: 2, marLowMm3: 5, marHighMm3: 10 } })).toBe(true);
		expect(
			SettingsPatch.safeParse({ wr2012: { calibrationPenalty: { enabled: true, weight: 2, marLowMm3: 5, marHighMm3: 10 } } }).data?.wr2012
				?.calibrationPenalty
		).toEqual({ enabled: true, weight: 2, marLowMm3: 5, marHighMm3: 10 });
	});
});

describe('patchSettings', () => {
	it('merges nested groups one level deep, so a partial patch keeps the other stored fields', () => {
		const stored = { gr4j: { x1: 500, x3: 40 }, dataQuality: { agreementMinDays: 30 } };
		const s = patchSettings(stored, { gr4j: { x4: 2 }, dataQuality: { agreementMinRatio: 0.9 } });
		expect(s.gr4j).toMatchObject({ x1: 500, x3: 40, x4: 2 });
		expect(s.dataQuality).toEqual({ agreementMinRatio: 0.9, agreementMaxRatio: 1.5, agreementMinDays: 30 });
	});

	it('replaces top-level values and whole WR2012 groups (the reference is never half-merged)', () => {
		const ref = { quaternary: 'Z99A', areaKm2: 1, marMm3: 1, monthlyMm3: new Array(12).fill(1 / 12), periodStart: 1990, periodEnd: 2000, mapMm: null, source: 's' };
		const stored = { effectiveRainFraction: 0.5, wr2012: { reference: ref, scaling: 'areaRain' } };
		const s = patchSettings(stored, { effectiveRainFraction: 0.7, wr2012: { calibrationPenalty: { enabled: true, weight: 1 } } });
		expect(s.effectiveRainFraction).toBe(0.7);
		expect(s.wr2012.reference).toEqual(ref);
		expect(s.wr2012.scaling).toBe('areaRain');
		expect(s.wr2012.calibrationPenalty).toEqual({ enabled: true, weight: 1 });
		expect(patchSettings(stored, { wr2012: { reference: null } }).wr2012.reference).toBeNull();
	});
});

describe('SettingsPatch.calibrationFlowKind', () => {
	const ok = (calibrationFlowKind: unknown) => SettingsPatch.safeParse({ calibrationFlowKind }).success;

	it('accepts the gauge and logger records', () => {
		for (const k of ['flow_observed_m3s', 'flow_logger_m3s', null]) expect(ok(k), String(k)).toBe(true);
	});

	it('no longer accepts Pitman flow, which engine 0.10.0 removed (audit P1)', () => {
		expect(ok('flow_pitman_m3s')).toBe(false);
	});

	it('never accepts a reference gauge (another catchment) as the calibration record', () => {
		expect(ok('flow_reference_m3s')).toBe(false);
		expect(ok('rain_catchment_mm')).toBe(false);
	});
});

describe('SettingsPatch.calibrationExclusions', () => {
	const ok = (calibrationExclusions: unknown) => SettingsPatch.safeParse({ calibrationExclusions }).success;

	it('accepts whole water years and date ranges, each with a reason, and none', () => {
		expect(ok([])).toBe(true);
		expect(ok([{ waterYear: 2015, reason: 'suspect rain year' }, { start: '2017-01-01', end: '2017-01-01', reason: 'gauge outage' }])).toBe(true);
		const parsed = SettingsPatch.parse({ calibrationExclusions: [{ waterYear: 2015, reason: '  padded  ' }] });
		expect(parsed.calibrationExclusions).toEqual([{ waterYear: 2015, reason: 'padded' }]);
	});

	it('rejects a missing or blank reason, fractional years, bad or reversed dates, extra keys and too many', () => {
		for (const bad of [
			[{ waterYear: 2015 }],
			[{ waterYear: 2015, reason: '   ' }],
			[{ waterYear: 2015, reason: 'x'.repeat(501) }],
			[{ waterYear: 2015.5, reason: 'x' }],
			[{ waterYear: '2015', reason: 'x' }],
			[{ start: '2017-02-30', end: '2017-03-01', reason: 'x' }],
			[{ start: '2017-03-01', end: '2017-02-01', reason: 'x' }],
			[{ start: '2017-03-01', reason: 'x' }],
			[{ waterYear: 2015, reason: 'x', note: 'y' }],
			[{ waterYear: 2015, reason: 'x' }, { waterYear: 2015, reason: 'again' }],
			new Array(101).fill({ waterYear: 2015, reason: 'x' }),
			{ waterYear: 2015, reason: 'x' },
			null
		]) {
			expect(ok(bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
		}
	});
});

describe('SettingsPatch.zeroRainRuns (CR-20)', () => {
	const ok = (zeroRainRuns: unknown) => SettingsPatch.safeParse({ zeroRainRuns }).success;

	it('accepts the defaults, either mode, and dated periods with reasons; any subset may be patched', () => {
		expect(ok(defaultProjectSettings().zeroRainRuns)).toBe(true);
		expect(ok({ mode: 'asRecorded' })).toBe(true);
		expect(ok({ keepDry: [{ start: '2003-05-01', end: '2003-08-31', reason: 'real drought' }] })).toBe(true);
		expect(ok({ missing: [{ waterYear: 1999, reason: 'gauge offline' }] })).toBe(true);
	});

	it('rejects an unknown mode, unknown keys, and periods the calibration exclusions would reject', () => {
		for (const bad of [
			{ mode: 'sometimes' },
			{ mode: 'missing', note: 'x' },
			{ keepDry: [{ start: '2003-05-01', end: '2003-04-01', reason: 'x' }] },
			{ keepDry: [{ start: '2003-05-01', end: '2003-08-31' }] },
			{ missing: [{ waterYear: 1999, reason: 'a' }, { waterYear: 1999, reason: 'b' }] },
			{ missing: new Array(101).fill({ waterYear: 1999, reason: 'x' }) },
			{ missing: { waterYear: 1999, reason: 'x' } }
		]) {
			expect(ok(bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
		}
		const r = SettingsPatch.safeParse({ zeroRainRuns: { keepDry: [{ start: '2003-05-01', end: '2003-05-02', reason: '  ' }] } });
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error!.issues)).toContain('a keep-dry period needs a reason');
	});

	it('merges one level deep: patching the mode keeps the stored lists', () => {
		const stored = { zeroRainRuns: { mode: 'missing', keepDry: [{ waterYear: 2003, reason: 'real' }], missing: [] } };
		expect(patchSettings(stored, { zeroRainRuns: { mode: 'asRecorded' } }).zeroRainRuns).toEqual({
			...defaultProjectSettings().zeroRainRuns,
			mode: 'asRecorded',
			keepDry: [{ waterYear: 2003, reason: 'real' }],
			missing: []
		});
		expect(mergeSettings({}).zeroRainRuns).toEqual(defaultProjectSettings().zeroRainRuns);
		// Settings stored before engine 0.20.0 get the accumulation defaults merged in.
		expect(mergeSettings({ zeroRainRuns: { mode: 'asRecorded', keepDry: [], missing: [] } }).zeroRainRuns).toMatchObject({
			mode: 'asRecorded',
			accumulationMode: 'spread',
			keepReadings: [],
			addAccumulations: []
		});
	});

	it('accepts the accumulation fields (engine ≥ 0.20.0, B4) and validates their periods like the others', () => {
		expect(ok({ accumulationMode: 'asRecorded' })).toBe(true);
		expect(ok({ keepReadings: [{ start: '2003-06-10', end: '2003-06-10', reason: 'thunderstorm, farm records agree' }] })).toBe(true);
		expect(ok({ addAccumulations: [{ start: '2003-07-01', end: '2003-07-09', reason: 'observer away' }] })).toBe(true);
		for (const bad of [
			{ accumulationMode: 'smear' },
			{ keepReadings: [{ start: '2003-06-10', end: '2003-06-10' }] },
			{ addAccumulations: [{ start: '2003-07-09', end: '2003-07-01', reason: 'x' }] },
			{ addAccumulations: [{ waterYear: 2003, reason: 'a' }, { waterYear: 2003, reason: 'b' }] }
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
		const r = SettingsPatch.safeParse({ zeroRainRuns: { addAccumulations: [{ start: '2003-07-01', end: '2003-07-09', reason: ' ' }] } });
		expect(JSON.stringify(r.error!.issues)).toContain('a listed accumulation needs a reason');
		expect(patchSettings({}, { zeroRainRuns: { accumulationMode: 'asRecorded' } }).zeroRainRuns).toEqual({
			...defaultProjectSettings().zeroRainRuns,
			accumulationMode: 'asRecorded'
		});
	});
});

describe('SettingsPatch.fitRecord', () => {
	const period = { start: '2012-10-01', end: '2014-09-30', waterYears: [2012, 2013], scores: { days: 730, kgePrime: 0.8, kgeYearly: null } };
	const record = {
		fittedAt: '2026-09-24T10:00:00.000Z',
		engineVersion: '0.6.0',
		model: 'gr4j',
		objective: 'kgePrime',
		bounds: 'wide',
		seed: 7,
		budget: 300,
		evaluations: 900,
		cancelled: false,
		free: ['x1', 'x3', 'x4'],
		params: { x1: 512, x2: 0, x3: 61, x4: 2.2 },
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_logger_m3s',
		simulatedKey: 'simulated_outflow',
		calibrationStart: null,
		calibrationEnd: null,
		exclusions: [{ waterYear: 2015, reason: 'suspect rain' }],
		validate: true,
		validationRecord: 'flow_observed_m3s',
		fit: period,
		before: period,
		splitSample: { params: { x1: 500 }, calibration: period, validation: period },
		differential: { params: { x1: 500 }, calibration: period, validation: period, dryYears: [2012], wetYears: [2013], wetDryRatio: 1.8 },
		independentRecord: {
			params: { x1: 512 },
			calibration: period,
			validation: period,
			flowKind: 'flow_observed_m3s',
			simulatedKey: 'simulated_outflow',
			overlapDays: 10
		},
		notes: ['A note.'],
		editedParams: []
	};
	const ok = (fitRecord: unknown) => SettingsPatch.safeParse({ fitRecord }).success;

	it('accepts a full record, and null (no fit)', () => {
		expect(ok(record)).toBe(true);
		expect(ok(null)).toBe(true);
		expect(ok({ ...record, splitSample: null, differential: null, independentRecord: null, notes: [] })).toBe(true);
		const marPenalty = {
			weight: 0.5,
			targetMarMm3: 12,
			marLowMm3: null,
			marHighMm3: null,
			basis: 'overlap',
			marRatio: 1.05,
			unpenalised: { params: { x1: 400 }, fit: period, marRatio: 1.4 }
		};
		expect(ok({ ...record, marPenalty })).toBe(true);
		expect(ok({ ...record, marPenalty: { ...marPenalty, marLowMm3: 5, marHighMm3: 10 } })).toBe(true);
		expect(ok({ ...record, marPenalty: { ...marPenalty, weight: 11 } })).toBe(false);
		expect(ok({ ...record, marPenalty: { ...marPenalty, extra: 1 } })).toBe(false);
	});

	it('accepts an optional forcing block (the pan coefficient / A-pan the fit ran under), and a record from before it without', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] };
		expect(ok(record)).toBe(true); // no forcing: a record from before it existed
		expect(ok({ ...record, forcing })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, panCoefficient: new Array(11).fill(0.7) } })).toBe(false); // wrong length
		expect(ok({ ...record, forcing: { ...forcing, panCoefficient: new Array(12).fill(2.1) } })).toBe(false); // out of bounds (0–2)
		expect(ok({ ...record, forcing: { ...forcing, apanMm: forcing.apanMm.map(() => Infinity) } })).toBe(false); // must be finite
		expect(ok({ ...record, forcing: { ...forcing, extra: 1 } })).toBe(false); // no other keys
	});

	it('accepts an optional chirpsBiasCorrection inside forcing, and a forcing from before it without', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] };
		expect(ok({ ...record, forcing })).toBe(true); // no chirpsBiasCorrection: a forcing from before it existed
		expect(ok({ ...record, forcing: { ...forcing, chirpsBiasCorrection: 'monthly' } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, chirpsBiasCorrection: 'none' } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, chirpsBiasCorrection: 'yearly' } })).toBe(false); // not a known mode
	});

	it('accepts an optional chirpsSource inside forcing (issue #40c): a product and version, or null for not recorded', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] };
		expect(ok({ ...record, forcing: { ...forcing, chirpsSource: { product: 'CHIRPS', version: '2.0' } } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, chirpsSource: null } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, chirpsSource: { product: 'CHIRPS', version: '' } } })).toBe(false);
		expect(ok({ ...record, forcing: { ...forcing, chirpsSource: { product: 'CHIRPS', version: '2.0', extra: 1 } } })).toBe(false);
	});

	it('accepts an optional apanDaily inside forcing (issue #45): the daily A-pan series fingerprint, or null for none', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] };
		const pan = { startDate: '2012-10-01', length: 730, valuesSha256: 'ab'.repeat(32) };
		expect(ok({ ...record, forcing: { ...forcing, apanDaily: pan } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, apanDaily: null } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, apanDaily: { ...pan, valuesSha256: 'not a hash' } } })).toBe(false);
		expect(ok({ ...record, forcing: { ...forcing, apanDaily: { ...pan, startDate: '2012-10' } } })).toBe(false);
		expect(ok({ ...record, forcing: { ...forcing, apanDaily: { ...pan, length: -1 } } })).toBe(false);
		expect(ok({ ...record, forcing: { ...forcing, apanDaily: { ...pan, extra: 1 } } })).toBe(false);
	});

	it('accepts an optional, whole zeroRainRuns inside forcing (CR-20)', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100], chirpsBiasCorrection: 'monthly' };
		const zr = { mode: 'missing', keepDry: [{ waterYear: 2003, reason: 'real drought' }], missing: [] };
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: zr } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: { mode: 'missing' } } })).toBe(false); // recorded whole
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: { ...zr, mode: 'sometimes' } } })).toBe(false);
		// The accumulation fields (engine ≥ 0.20.0) are optional there, so a record made before them still validates.
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: { mode: 'missing', keepDry: [], missing: [] } } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: { ...zr, accumulationMode: 'smear' } } })).toBe(false);
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: { ...zr, keepDry: [{ waterYear: 2003, reason: ' ' }] } } })).toBe(false);
	});

	it('accepts an optional CHIRPS fit period and factor sets inside forcing (engine ≥ 0.29.0)', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100], chirpsBiasCorrection: 'monthly' };
		const sets = [{ label: 'range 1990/91–1999/00 (old network), filling up to 1999/00', fittedOn: '1990/91–1999/00', factors: [...new Array(11).fill(1.5), null] }];
		expect(ok({ ...record, forcing: { ...forcing, chirpsFitPeriod: 'all', chirpsFactors: sets } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, chirpsFactors: [{ label: 'whole record', factors: new Array(12).fill(1) }] } })).toBe(true); // fittedOn optional
		expect(ok({ ...record, forcing: { ...forcing, chirpsFitPeriod: [{ fromWaterYear: 1990, toWaterYear: 1999, reason: 'x' }], chirpsFactors: null } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, chirpsFitPeriod: 'segments' } })).toBe(false);
		expect(ok({ ...record, forcing: { ...forcing, chirpsFactors: [{ label: 'x', factors: [1, 2] }] } })).toBe(false); // 12 months
	});

	it('accepts the starts of a multi-start fit (CR-2), and a record from before them without', () => {
		const startResults = [
			{ seed: 7, params: { x1: 512, x2: 0, x3: 61, x4: 2.2 }, score: 0.8, best: true },
			{ seed: 1000010, params: { x1: 900, x2: 0, x3: 40, x4: 2.2 }, score: null, best: false }
		];
		expect(ok({ ...record, starts: 2, startResults })).toBe(true);
		expect(ok(record)).toBe(true);
		expect(ok({ ...record, starts: 0, startResults })).toBe(false);
		expect(ok({ ...record, starts: 11, startResults })).toBe(false);
		expect(ok({ ...record, starts: 2, startResults: [{ ...startResults[0], extra: 1 }] })).toBe(false);
		expect(ok({ ...record, starts: 11, startResults: new Array(11).fill(startResults[0]) })).toBe(false);
	});

	it('rejects a record missing its provenance, with an unknown objective or model, a bad time, or extra keys', () => {
		const without = (k: string) => Object.fromEntries(Object.entries(record).filter(([key]) => key !== k));
		for (const bad of [
			without('seed'),
			without('objective'),
			without('bounds'),
			without('fittedAt'),
			without('engineVersion'),
			without('exclusions'),
			{ ...record, objective: 'rmse' },
			{ ...record, model: 'pitman' },
			{ ...record, bounds: 'narrow' },
			{ ...record, seed: -1 },
			{ ...record, seed: 1.5 },
			{ ...record, fittedAt: 'yesterday' },
			{ ...record, exclusions: [{ waterYear: 2015 }] },
			{ ...record, fit: { ...period, scores: { kgePrime: 'high' } } },
			{ ...record, extra: 1 }
		]) {
			expect(ok(bad), JSON.stringify(bad).slice(0, 60)).toBe(false);
		}
	});

	it('patchSettings recomputes editedParams from the parameters, whatever the client sends', () => {
		const stored = { runoffModel: 'gr4j', gr4j: { x1: 512, x2: 0, x3: 61, x4: 2.2, warmupDays: 365 } };
		expect(patchSettings(stored, { fitRecord: { ...record, editedParams: ['x1'] } }).fitRecord).toMatchObject({ editedParams: [] });
		const edited = patchSettings(stored, { fitRecord: record, gr4j: { x1: 600, x2: 0, x3: 61, x4: 2.2, warmupDays: 365 } });
		expect(edited.fitRecord).toMatchObject({ editedParams: ['x1'] });
		// An edit in a later save, with the record untouched, still marks it.
		const later = patchSettings({ ...stored, fitRecord: record }, { gr4j: { x1: 512, x2: 0, x3: 70, x4: 2.2, warmupDays: 365 } });
		expect(later.fitRecord).toMatchObject({ editedParams: ['x3'] });
		expect(patchSettings(stored, {}).fitRecord).toBeNull();
		// A new record replaces the stored one whole (never merged field by field).
		const replaced = patchSettings({ ...stored, fitRecord: { ...record, seed: 1, oldKey: true } }, { fitRecord: record });
		expect(replaced.fitRecord).not.toHaveProperty('oldKey');
		expect(replaced.fitRecord!.seed).toBe(7);
	});
});

describe('SettingsPatch.effectiveRainStoreMm (engine N3)', () => {
	const ok = (effectiveRainStoreMm: unknown) => SettingsPatch.safeParse({ effectiveRainStoreMm }).success;

	it('accepts 0 (no carry-over) up to 500 mm', () => {
		for (const v of [0, 12.5, 25, 500]) expect(ok(v), String(v)).toBe(true);
	});

	it('rejects a negative, oversized or non-numeric store', () => {
		for (const v of [-1, 501, Infinity, '25', null]) expect(ok(v), String(v)).toBe(false);
	});

	it('defaults to 25 mm for a project that never set it', () => {
		expect(mergeSettings({}).effectiveRainStoreMm).toBe(25);
		expect(defaultProjectSettings().effectiveRainStoreMm).toBe(25);
	});
});

describe('SettingsPatch.lakeEvapFactor (engine N2)', () => {
	const ok = (lakeEvapFactor: unknown) => SettingsPatch.safeParse({ lakeEvapFactor }).success;

	it('accepts 0 (no dam evaporation) up to 2 × A-pan', () => {
		for (const v of [0, 0.6, 0.75, 2]) expect(ok(v), String(v)).toBe(true);
	});

	it('rejects a negative, oversized or non-numeric factor', () => {
		for (const v of [-0.1, 2.5, Infinity, '0.75', null]) expect(ok(v), String(v)).toBe(false);
	});

	it('defaults to 0.75 × A-pan for a project that never set it', () => {
		expect(mergeSettings({}).lakeEvapFactor).toBe(0.75);
	});
});

describe('SettingsPatch.ewrChargeSource and lowFlowMeasure (engine ≥ 1.3.0, issue #64)', () => {
	const ok = (patch: unknown) => SettingsPatch.safeParse(patch).success;

	it('accepts the engine’s choices', () => {
		for (const v of ['pragmatic', 'ruleTable']) expect(ok({ ewrChargeSource: v }), v).toBe(true);
		for (const v of ['total', 'baseflow']) expect(ok({ lowFlowMeasure: v }), v).toBe(true);
	});

	it('rejects anything else', () => {
		for (const v of ['', 'rule', 'Pragmatic', null, 1]) expect(ok({ ewrChargeSource: v }), String(v)).toBe(false);
		for (const v of ['', 'base', 'median', null, 0]) expect(ok({ lowFlowMeasure: v }), String(v)).toBe(false);
	});

	it('defaults to what every earlier run did for a project that never set them', () => {
		expect(mergeSettings({})).toMatchObject({ ewrChargeSource: 'pragmatic', lowFlowMeasure: 'total' });
	});
});

describe('SettingsPatch.assuranceAnnualThreshold (engine ≥ 0.32.0, WP-3.4)', () => {
	const ok = (assuranceAnnualThreshold: unknown) => SettingsPatch.safeParse({ assuranceAnnualThreshold }).success;

	it('accepts a fraction in (0, 1]', () => {
		for (const v of [0.01, 0.5, 0.9, 1]) expect(ok(v), String(v)).toBe(true);
	});

	it('rejects 0, above 1, a percentage or a non-number', () => {
		for (const v of [0, -0.1, 1.01, 90, Infinity, '0.9', null]) expect(ok(v), String(v)).toBe(false);
	});
});

describe('SettingsPatch allocation settings (engine ≥ 1.18.0, issue #72)', () => {
	const ok = (patch: unknown) => SettingsPatch.safeParse(patch).success;

	it('takes one of the three allocation modes', () => {
		for (const v of ['none', 'cap', 'fullAllocation']) expect(ok({ allocationMode: v }), v).toBe(true);
		for (const v of ['full', '', null, 1]) expect(ok({ allocationMode: v }), String(v)).toBe(false);
	});

	it('takes a comparison band in [0, 1), not a percentage', () => {
		for (const v of [0, 0.05, 0.1, 0.99]) expect(ok({ allocationTolerance: v }), String(v)).toBe(true);
		for (const v of [-0.01, 1, 10, Infinity, '0.1', null]) expect(ok({ allocationTolerance: v }), String(v)).toBe(false);
	});

	it('defaults a project that never set them to compare only, at ±10 %', () => {
		const s = mergeSettings({});
		expect(s.allocationMode).toBe('none');
		expect(s.allocationTolerance).toBe(0.1);
	});
});

describe('SettingsPatch.lakeEvapFactorMonthly (WP-3.5)', () => {
	const ok = (lakeEvapFactorMonthly: unknown) => SettingsPatch.safeParse({ lakeEvapFactorMonthly }).success;

	it('accepts 12 factors of 0–2, or null for the one factor every month', () => {
		expect(ok(null)).toBe(true);
		expect(ok([0.7, 0.7, 0.75, 0.8, 0.8, 0.8, 0.8, 0.75, 0.7, 0.65, 0.65, 0.7])).toBe(true);
		expect(ok(new Array(12).fill(0))).toBe(true);
	});

	it('rejects a short row, a negative or oversized factor', () => {
		for (const v of [[0.7], new Array(13).fill(0.7), [...new Array(11).fill(0.7), -0.1], [...new Array(11).fill(0.7), 2.5], 'monthly']) expect(ok(v), JSON.stringify(v)).toBe(false);
	});

	it('is null for a project that never set it (the run uses lakeEvapFactor)', () => {
		expect(mergeSettings({}).lakeEvapFactorMonthly).toBeNull();
	});
});

describe('SettingsPatch.effectiveRainFractionMonthly (engine 0.43.0, issue #54)', () => {
	const ok = (effectiveRainFractionMonthly: unknown) => SettingsPatch.safeParse({ effectiveRainFractionMonthly }).success;

	it('accepts 12 fractions of 0–1, or null for the one fraction every month', () => {
		expect(ok(null)).toBe(true);
		expect(ok([0.5, 0.55, 0.6, 0.65, 0.65, 0.6, 0.5, 0.4, 0.3, 0.3, 0.4, 0.45])).toBe(true);
		expect(ok(new Array(12).fill(1))).toBe(true);
		// A row of zeros is the modeller's call (the run warns about it), not an error.
		expect(ok(new Array(12).fill(0))).toBe(true);
	});

	it('rejects a short or long row, a fraction outside 0–1, a percentage or a non-number', () => {
		for (const v of [[0.5], new Array(13).fill(0.5), [...new Array(11).fill(0.5), -0.1], [...new Array(11).fill(0.5), 1.01], new Array(12).fill(65), 'monthly'])
			expect(ok(v), JSON.stringify(v)).toBe(false);
	});

	it('is null for a project that never set it (the run uses effectiveRainFraction)', () => {
		expect(mergeSettings({}).effectiveRainFractionMonthly).toBeNull();
	});
});

describe('SettingsPatch.ewrRules (engine ≥ 0.21.0)', () => {
	const issues = (ewrRules: unknown) => {
		const r = SettingsPatch.safeParse({ ewrRules });
		return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
	};
	// Synthetic: round numbers, EWR half the natural flow.
	const table = (over: Record<string, unknown> = {}) => ({
		siteNodeId: null,
		source: 'Synthetic table',
		component: 'total',
		unit: 'mcm',
		points: [10, 50, 90],
		ewr: Array.from({ length: 12 }, () => [1.5, 1, 0.5]),
		naturalSource: 'table',
		natural: Array.from({ length: 12 }, () => [3, 2, 1]),
		scale: 1,
		...over
	});

	it('accepts none, a table at the outlet and one at a gauge, from the run or the table', () => {
		expect(issues(defaultProjectSettings().ewrRules)).toEqual([]);
		expect(issues([table(), table({ siteNodeId: 'g1', naturalSource: 'run', natural: null, unit: 'm3s', component: 'lowFlow', scale: 0.25 })])).toEqual([]);
	});

	it('runs the engine checks: source, rising points, the grid shape, natural flows when they are the source', () => {
		expect(issues([table({ source: ' ' })])).toContain('ewrRules.0.source: Say where the table comes from (Reserve determination, gazette notice, table).');
		expect(issues([table({ points: [10, 90, 50] })])).toEqual(['ewrRules.0.points: The % points must rise from left to right, each once.']);
		expect(issues([table({ ewr: Array.from({ length: 12 }, () => [1, 0.5]) })])).toEqual(['ewrRules.0.ewr: Each EWR row needs one value per % point (Oct has 2 of 3).']);
		expect(issues([table({ natural: null })])).toEqual(['ewrRules.0.natural: Enter the natural flow at each point, or find the percentile from the run.']);
		expect(issues([table({ ewr: Array.from({ length: 11 }, () => [1, 1, 1]) })])[0]).toMatch(/^ewrRules\.0\.ewr: /);
	});

	it('rejects negative or huge values, a bad scale or unit, unknown keys, two tables for one site and too many', () => {
		const neg = Array.from({ length: 12 }, (_, m) => (m === 5 ? [1, -1, 0] : [1, 1, 0]));
		expect(issues([table({ ewr: neg })]).length).toBeGreaterThan(0);
		expect(issues([table({ ewr: Array.from({ length: 12 }, () => [2e6, 1, 0]) })]).length).toBeGreaterThan(0);
		expect(issues([table({ scale: 0 })]).length).toBeGreaterThan(0);
		expect(issues([table({ unit: 'l/s' })]).length).toBeGreaterThan(0);
		expect(issues([table({ extra: 1 })]).length).toBeGreaterThan(0);
		expect(issues([table(), table()])).toEqual(['ewrRules: Each EWR site can have one rule table.']);
		expect(issues(Array.from({ length: 21 }, (_, i) => table({ siteNodeId: `g${i}` }))).length).toBeGreaterThan(0);
		expect(issues({ siteNodeId: null }).length).toBeGreaterThan(0);
	});

	it('accepts a source kind, absent or null, and refuses an unknown one (engine ≥ 1.5.0)', () => {
		for (const sourceKind of ['gazetted', 'desktop', 'other', null]) expect(issues([table({ sourceKind })])).toEqual([]);
		expect(issues([table({ sourceKind: 'guess' })]).map((i) => i.split(':')[0])).toContain('ewrRules.0.sourceKind');
	});

	it('accepts the determination’s natural MAR, absent or null, and refuses one that isn’t above 0 (engine ≥ 1.11.0)', () => {
		for (const naturalMarMcm of [12.5, null]) expect(issues([table({ naturalMarMcm })])).toEqual([]);
		for (const naturalMarMcm of [0, -2, '12']) expect(issues([table({ naturalMarMcm })]).map((i) => i.split(':')[0])).toContain('ewrRules.0.naturalMarMcm');
	});

	it('accepts a low-flow grid and high-flow components, and runs the engine checks on them (engine ≥ 0.33.0)', () => {
		const lowFlow = Array.from({ length: 12 }, () => [1, 0.6, 0.2]);
		const fresh = { label: 'Class II freshet', months: [11, 12], peakM3s: 8, durationDays: 3, perYear: 2 };
		expect(issues([table({ lowFlow, highFlows: [fresh] })])).toEqual([]);
		// Optional: a table saved before 0.33.0 has neither, and null / [] mean none.
		expect(issues([table({ lowFlow: null, highFlows: [] })])).toEqual([]);
		expect(issues([table({ component: 'lowFlow', lowFlow })])).toEqual([
			'ewrRules.0.lowFlow: A low-flow table already is the low flows: clear the separate low-flow values, or say the table covers the total flow.'
		]);
		expect(issues([table({ lowFlow: lowFlow.map((r) => r.slice(1)) })])).toEqual(['ewrRules.0.lowFlow: Each low-flow row needs one value per % point (Oct has 2 of 3).']);
		expect(issues([table({ highFlows: [{ ...fresh, durationDays: 90, perYear: 5 }] })])).toEqual(["ewrRules.0.highFlows: High flow 1: 5 events of 90 days don't fit in a year."]);
		expect(issues([table({ highFlows: [{ ...fresh, months: [11, 11] }] })])).toEqual(['ewrRules.0.highFlows: High flow 1: pick the months it may peak in (each once).']);
		// The shape: whole days, months 1–12, a peak above 0, no unknown keys, at most 12.
		for (const bad of [{ durationDays: 1.5 }, { months: [0] }, { peakM3s: 0 }, { perYear: 13 }, { label: '' }, { extra: 1 }]) {
			expect(issues([table({ highFlows: [{ ...fresh, ...bad }] })]).length, JSON.stringify(bad)).toBeGreaterThan(0);
		}
		expect(issues([table({ highFlows: Array.from({ length: 13 }, () => fresh) })]).length).toBeGreaterThan(0);
	});

	it('defaults to none for settings stored before it, and a patch replaces the whole list', () => {
		expect(mergeSettings({}).ewrRules).toEqual([]);
		const stored = { ewrRules: [table(), table({ siteNodeId: 'g1' })] };
		expect(patchSettings(stored, { ewrRules: [table({ siteNodeId: 'g2' })] }).ewrRules).toEqual([table({ siteNodeId: 'g2' })]);
		expect(patchSettings(stored, { ewrRules: [] }).ewrRules).toEqual([]);
	});
});

describe('remapSettingNodeIds (project copy)', () => {
	it('moves each rule table to its node’s new id, keeps the outlet and unknown sites, and changes nothing else', () => {
		const ids = new Map([
			['g1', 'new-g1'],
			['f1', 'new-f1']
		]);
		const stored = { effectiveRainFraction: 0.5, ewrRules: [{ siteNodeId: null, source: 'a' }, { siteNodeId: 'g1', source: 'b' }, { siteNodeId: 'gone', source: 'c' }] };
		const out = remapSettingNodeIds(stored, ids);
		expect(out).toEqual({ effectiveRainFraction: 0.5, ewrRules: [{ siteNodeId: null, source: 'a' }, { siteNodeId: 'new-g1', source: 'b' }, { siteNodeId: 'gone', source: 'c' }] });
		expect(stored.ewrRules[1]!.siteNodeId).toBe('g1');
		expect(remapSettingNodeIds({ apanMm: [1] }, ids)).toEqual({ apanMm: [1] });
		expect(remapSettingNodeIds(null, ids)).toEqual({});
	});

	it('moves the outcome matrix’s site too, leaving the outlet (null) and an unknown site alone', () => {
		const ids = new Map([['g1', 'new-g1']]);
		const at = (siteNodeId: string | null) => ({ outcomes: { yearClassMethod: 'terciles', siteNodeId } });
		expect(remapSettingNodeIds(at('g1'), ids)).toEqual(at('new-g1'));
		expect(remapSettingNodeIds(at(null), ids)).toEqual(at(null));
		expect(remapSettingNodeIds(at('gone'), ids)).toEqual(at('gone'));
	});
});
