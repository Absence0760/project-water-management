import { readFileSync } from 'node:fs';
import { dayQuality, defaultCalibrationRules, defaultDataQualitySettings, defaultProjectSettings, PE_SOURCE_MAX, rainCheckLimits, resolveChirpsFitPeriod, resolveRainSource, RETIRED_CALIBRATION_KEYS, scoringDays } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { autoFitRecordError, dataQualityPatchError, importedAutoFitError, mergeSettings, nextCalibrationRules, patchSettings, remapSettingNodeIds, SettingsPatch, FitRecord } from './settings.js';

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

	it('takes the limits added in engine 1.20.0 (issue #66) with the engine’s ranges', () => {
		expect(
			ok({
				outlierFactorRain: 1000,
				outlierFactorFlow: 1.5,
				flatlineRainDays: 2,
				flatlineEvapDays: 366,
				flatlineFlowMinDays: 10,
				flatlineFlowMaxDays: 40,
				zeroRunRule: 'usualRain',
				zeroRunMinWetDays: 1,
				zeroRunUsualShare: 1,
				zeroRunMinDays: 366,
				zeroRunChirpsCheck: true,
				lowVsChirpsRatio: 0.99,
				lowVsChirpsBaseline: 'moving',
				lowVsChirpsMinimum: 'scaled'
			})
		).toBe(true);
		for (const bad of [
			{ outlierFactorRain: 1 },
			{ outlierFactorFlow: 1001 },
			{ flatlineRainDays: 1 },
			{ flatlineFlowMaxDays: 30.5 },
			{ zeroRunRule: 'weekly' },
			{ zeroRunMinWetDays: 0 },
			{ zeroRunUsualShare: 0 },
			{ zeroRunUsualShare: 1.1 },
			{ zeroRunChirpsCheck: 'yes' },
			{ lowVsChirpsRatio: 1 },
			{ lowVsChirpsBaseline: 'decade' },
			{ lowVsChirpsMinimum: 'none' }
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('checks the flow flat-line cap against its floor on the merged settings', () => {
		expect(dataQualityPatchError(patchSettings({}, { dataQuality: { flatlineFlowMinDays: 30 } }))).toBeNull();
		expect(dataQualityPatchError(patchSettings({}, { dataQuality: { flatlineFlowMinDays: 100 } }))).toMatch(/flow flat-line cap \(90 days\) can't be below its floor \(100 days\)/);
		expect(dataQualityPatchError(patchSettings({ dataQuality: { flatlineFlowMaxDays: 20 } }, { dataQuality: { flatlineFlowMinDays: 20 } }))).toBeNull();
		expect(dataQualityPatchError(mergeSettings({}))).toBeNull();
	});

	it('records the rain-check limits in a fit record’s forcing, optionally', () => {
		const rc = FitRecord.shape.forcing.unwrap().shape.rainChecks;
		expect(rc.safeParse(undefined).success).toBe(true);
		expect(rc.safeParse(rainCheckLimits(defaultDataQualitySettings())).success).toBe(true);
		expect(rc.safeParse({ ...rainCheckLimits(defaultDataQualitySettings()), outlierFactorRain: 5 }).success).toBe(false);
		expect(rc.safeParse({ zeroRunRule: 'usualRain' }).success).toBe(false);
	});
});

describe('mergeSettings', () => {
	it('fills dataQuality from the defaults for settings stored before it existed, and field by field', () => {
		expect(mergeSettings({}).dataQuality).toEqual(defaultDataQualitySettings());
		// Stored before the engine 1.20.0 limits: they take their defaults, so the project runs as before.
		expect(mergeSettings({ dataQuality: { agreementMinDays: 30 } }).dataQuality).toEqual({
			...defaultDataQualitySettings(),
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
			['a quantile map (engine ≥ 1.21.0)', [{ ...fixed, quantileMap: { fromWaterYear: 1995, toWaterYear: 2011, wetDayMm: 1 } }]],
			['a quantile map without a threshold', [{ ...fixed, quantileMap: { fromWaterYear: 1995, toWaterYear: 2011 } }]],
			['a quantile map with its era reversed', [{ ...fitNoProv, quantileMap: { fromWaterYear: 2011, toWaterYear: 1995, wetDayMm: 1 } }]],
			['a quantile map threshold out of range', [{ ...fixed, quantileMap: { fromWaterYear: 1995, toWaterYear: 2011, wetDayMm: 25 } }]],
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
		expect(s.dataQuality).toEqual({ ...defaultDataQualitySettings(), agreementMinRatio: 0.9, agreementMaxRatio: 1.5, agreementMinDays: 30 });
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
		// The dry → wet test's ranking (engine ≥ 1.19.0); a record from before it has none.
		expect(ok({ ...record, differential: { ...record.differential, rankedBy: 'reference' } })).toBe(true);
		expect(ok({ ...record, differential: { ...record.differential, rankedBy: 'observed' } })).toBe(true);
		expect(ok({ ...record, differential: { ...record.differential, rankedBy: 'gauge' } })).toBe(false);
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

	it('accepts the quality-flag settings, summary and fit on all days (CR-18/19/22, engine ≥ 1.22.0), and a record from before them without', () => {
		const flags = Uint8Array.from([0, 0, 4, 6]);
		const settings = defaultProjectSettings().qualityFlags;
		const dq = dayQuality({ flowKind: 'flow_logger_m3s', settings, windowIdx: [0, 1, 2, 3], flags, scoring: scoringDays([0, 1, 2, 3], flags, settings, null, 4), observed: Float64Array.from([1, 2, 0, NaN]), rainFlags: Uint8Array.from([0, 1, 0, 2]), zeroRunMask: null });
		const full = { ...record, qualityFlags: settings, dayQuality: dq, fitAllDays: period };
		expect(ok(full)).toBe(true);
		expect(ok({ ...full, dayQuality: null, fitAllDays: null })).toBe(true);
		expect(ok(record)).toBe(true);
		expect(ok({ ...full, dayQuality: { ...dq, extra: 1 } })).toBe(false);
		expect(ok({ ...full, qualityFlags: { ...settings, suspect: 'drop' } })).toBe(false);
	});

	it('accepts how automated calibration chose the fit (engine ≥ 1.25.0, issue #153), and refuses a kept case that wasn’t eligible', () => {
		const kase = { label: 'wide', pan: 'project', bounds: 'wide', objective: 'kgePrime', score: 0.7, eligible: true, reasons: [], params: record.params };
		const auto = { rules: defaultCalibrationRules(), ruleExclusions: [{ waterYear: 2013, reason: 'Rule (calibration rules, exclusions): …' }], chosen: 0, cases: [kase, { ...kase, bounds: 'typical', eligible: false, reasons: ['no score'], score: null }] };
		expect(ok({ ...record, auto })).toBe(true);
		expect(ok({ ...record, auto: { ...auto, chosen: 1 } })).toBe(false);
		expect(ok({ ...record, auto: { ...auto, chosen: 2 } })).toBe(false);
		expect(ok({ ...record, auto: { ...auto, rules: { ...auto.rules, forcing: { pan: ['nowhere'] } } } })).toBe(false);
		expect(ok({ ...record, auto: { ...auto, extra: 1 } })).toBe(false);
	});

	it('accepts the low/high-flow objective (CR-3, engine ≥ 1.19.0) and its score, and refuses an unknown objective', () => {
		const scored = { ...period, scores: { ...period.scores, kgeLowHigh: 0.55 } };
		expect(ok({ ...record, objective: 'kgeLowHigh', fit: scored, before: scored })).toBe(true);
		expect(ok({ ...record, objective: 'kgeLog' })).toBe(false);
	});

	it('accepts the optional score intervals and benchmarks on a scored period (CR-5, engine ≥ 1.19.0), and a period from before them without', () => {
		const iv = { lo: 0.4, hi: 0.7 };
		const intervals = { level: 0.9, resamples: 1000, seed: 20_210_101, years: 5, kgePrime: iv, nse: null, kgeLowHigh: iv };
		const benchmarks = { meanFlow: { days: 730, kgePrime: -0.41, nse: 0 }, climatology: { days: 730, kgePrime: 0.3, nse: 0.2 }, halfWindowDays: 7 };
		const withBoth = { ...period, intervals, benchmarks };
		expect(ok({ ...record, fit: withBoth, before: withBoth, splitSample: { params: { x1: 500 }, calibration: period, validation: withBoth } })).toBe(true);
		expect(ok({ ...record, fit: { ...period, intervals: null, benchmarks: null } })).toBe(true);
		expect(ok(record)).toBe(true); // neither: a record from before them
		expect(ok({ ...record, fit: { ...withBoth, intervals: { ...intervals, extra: 1 } } })).toBe(false);
		expect(ok({ ...record, fit: { ...withBoth, intervals: { ...intervals, kgePrime: { lo: Infinity, hi: 1 } } } })).toBe(false);
		expect(ok({ ...record, fit: { ...withBoth, benchmarks: { ...benchmarks, halfWindowDays: 400 } } })).toBe(false);
	});

	it('accepts the optional WR2012 five-statistic table on a scored period (CR-28, engine ≥ 1.19.0), and a period from before it without', () => {
		const stat = (key: string) => ({ key, observed: 1.2, simulated: 1.25, diffPct: 4.2, bandPct: 4, withinBand: false });
		const wr2012Fit = { waterYears: [2015, 2016], logYears: 2, stats: ['mar', 'meanLog', 'sd', 'logSd', 'seasonalIndex'].map(stat), bandsConfirmed: false };
		expect(ok({ ...record, fit: { ...period, wr2012Fit }, before: { ...period, wr2012Fit: null } })).toBe(true);
		expect(ok(record)).toBe(true); // a record from before it
		expect(ok({ ...record, fit: { ...period, wr2012Fit: { ...wr2012Fit, stats: [{ ...stat('mar'), key: 'kge' }] } } })).toBe(false);
		expect(ok({ ...record, fit: { ...period, wr2012Fit: { ...wr2012Fit, extra: 1 } } })).toBe(false);
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

	it('accepts a REC (ER9), absent or null, and refuses a malformed one', () => {
		for (const category of ['A', 'B/C', 'E/F', null]) expect(issues([table({ category })])).toEqual([]);
		for (const category of ['G', 'b', 'B/D', 'B-C', 'Class B', 3]) expect(issues([table({ category })]).map((i) => i.split(':')[0])).toContain('ewrRules.0.category');
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

describe('SettingsPatch.qualityFlags (engine ≥ 1.22.0, CR-18/19)', () => {
	const ok = (qualityFlags: unknown) => SettingsPatch.safeParse({ qualityFlags }).success;
	const rating = { gaugedMaxM3s: 12.5, gaugedMinM3s: 0.02, source: 'DWS gaugings 1998–2020' };

	it('accepts the defaults, any subset, and a gauged range per calibration record', () => {
		expect(ok(defaultProjectSettings().qualityFlags)).toBe(true);
		expect(ok({ suspect: 'include' })).toBe(true);
		expect(ok({ aboveRating: 'exclude', belowRating: 'include', infilled: 'include' })).toBe(true);
		expect(ok({ ratings: { flow_observed_m3s: rating, flow_logger_m3s: { gaugedMaxM3s: null, gaugedMinM3s: null, source: '' } } })).toBe(true);
		expect(ok({ ratings: {} })).toBe(true);
	});

	it('refuses what the engine’s ratingError refuses, an unknown treatment, and a rating for another series', () => {
		expect(ok({ aboveRating: 'drop' })).toBe(false);
		expect(ok({ belowRating: 'censor' })).toBe(false); // censoring is for floods only
		expect(ok({ ratings: { flow_observed_m3s: { ...rating, source: ' ' } } })).toBe(false);
		expect(ok({ ratings: { flow_observed_m3s: { ...rating, gaugedMinM3s: 13 } } })).toBe(false);
		expect(ok({ ratings: { flow_observed_m3s: { ...rating, gaugedMaxM3s: 0 } } })).toBe(false);
		expect(ok({ ratings: { flow_observed_m3s: { ...rating, gaugedMinM3s: -1 } } })).toBe(false);
		expect(ok({ ratings: { flow_reference_m3s: rating } })).toBe(false);
		expect(ok({ ratings: { flow_observed_m3s: { ...rating, extra: 1 } } })).toBe(false);
	});

	it('fills the defaults for settings stored before it, and a patch merges field by field with the ratings replaced whole', () => {
		expect(mergeSettings({}).qualityFlags).toEqual({ ratings: {}, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' });
		const stored = { qualityFlags: { suspect: 'include', ratings: { flow_logger_m3s: rating } } };
		const s = patchSettings(stored, { qualityFlags: { ratings: { flow_observed_m3s: rating } } });
		expect(s.qualityFlags).toEqual({ ratings: { flow_observed_m3s: rating }, aboveRating: 'censor', belowRating: 'exclude', suspect: 'include', infilled: 'exclude' });
	});
});

describe('settings.calibrationRules (engine ≥ 1.25.0, issue #153)', () => {
	const ok = (calibrationRules: unknown) => SettingsPatch.safeParse({ calibrationRules }).success;
	const rules = defaultCalibrationRules();
	const signed = { by: 'A. Hydrologist', on: '2026-09-29' };

	it('accepts the defaults, with or without a revision (the server sets it)', () => {
		expect(ok(rules)).toBe(true);
		const { revision: _r, ...noRevision } = rules;
		expect(ok(noRevision)).toBe(true);
		expect(ok({ ...rules, signedOff: signed })).toBe(true);
	});

	it('refuses an invalid rule set by the engine’s own check, and a partial or unknown group', () => {
		for (const bad of [
			{ ...rules, forcing: { pan: ['nowhere'] } },
			{ ...rules, cases: { bounds: ['wide', 'typical'], objectives: ['kgePrime', 'nseLog', 'nseSqrt', 'kgeNp', 'kgeYearly'] } },
			{ ...rules, exclusions: { maxFlaggedShare: 1.2 } },
			{ ...rules, selection: { test: 'inSample', score: 'kgePrime' } },
			{ ...rules, signedOff: { by: ' ', on: '2026-09-29' } },
			{ ...rules, extra: 1 },
			{ exclusions: rules.exclusions }
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('adds 1 to the revision when a rule changes, whatever revision the client sends', () => {
		const changed = { ...rules, revision: 99, exclusions: { maxFlaggedShare: 0.1 } };
		expect(nextCalibrationRules(undefined, changed)).toMatchObject({ revision: 2, exclusions: { maxFlaggedShare: 0.1 } });
		expect(patchSettings({ calibrationRules: { ...rules, revision: 5 } }, { calibrationRules: changed }).calibrationRules.revision).toBe(6);
		// Nothing changed: the same revision.
		expect(nextCalibrationRules({ ...rules, revision: 5 }, { ...rules, revision: 1 }).revision).toBe(5);
	});

	it('clears the sign-off when a rule changes, unless the same save records a new one; a sign-off alone keeps the revision', () => {
		const stored = { ...rules, revision: 3, signedOff: signed };
		// The form sends the stored sign-off back with a changed rule: it no longer covers the rules.
		expect(nextCalibrationRules(stored, { ...stored, selection: { test: 'split', score: 'kgePrime' } })).toMatchObject({ revision: 4, signedOff: null });
		const again = { by: 'A. Hydrologist', on: '2026-10-02' };
		expect(nextCalibrationRules(stored, { ...stored, selection: { test: 'split', score: 'kgePrime' }, signedOff: again })).toMatchObject({ revision: 4, signedOff: again });
		expect(nextCalibrationRules({ ...rules, revision: 3 }, { ...rules, signedOff: signed })).toMatchObject({ revision: 3, signedOff: signed });
	});

	it('leaves the stored rules alone when a save doesn’t send them', () => {
		expect(patchSettings({ calibrationRules: { ...rules, revision: 4 } }, { februaryDays: 29 }).calibrationRules.revision).toBe(4);
	});

	describe('autoFitRecordError', () => {
		const base = defaultProjectSettings();
		const params = { x1: 420, x2: 0, x3: 70, x4: 2.1 };
		const fit = (ranUnder: typeof rules, kept = params) =>
			({
				fittedAt: '2026-09-29T10:00:00.000Z',
				seed: 1,
				free: ['x1', 'x3', 'x4'],
				params,
				auto: { rules: ranUnder, ruleExclusions: [], chosen: 0, cases: [{ eligible: true, params: kept }] }
			}) as unknown as typeof base.fitRecord;
		const storedRules = { ...rules, revision: 2 };
		const stored = { ...base, calibrationRules: storedRules };

		it('refuses any new automated fit a client sends: the server writes those itself, however good the record looks', () => {
			for (const rec of [fit(storedRules), fit(rules), fit(storedRules, { ...params, x1: 900 })]) {
				expect(autoFitRecordError(stored, { ...stored, fitRecord: rec })).toBe(
					'an automated fit is applied by the server from its own run of the calibration rules (POST /projects/:id/auto-calibrations/:calibrationId/apply), never written directly'
				);
			}
			// A fit a person chose is never refused.
			expect(autoFitRecordError(stored, { ...stored, fitRecord: { ...fit(storedRules)!, auto: undefined } })).toBeNull();
		});

		it('checks an imported automated fit against the file’s own rules', () => {
			expect(importedAutoFitError({ calibrationRules: storedRules, fitRecord: fit(storedRules) })).toBeNull();
			expect(importedAutoFitError({ calibrationRules: { ...storedRules, revision: 3 }, fitRecord: fit(storedRules) })).toBe(
				'this automated fit ran under calibration rules revision 2, but the file’s rules are revision 3: run it again under the file’s rules'
			);
			expect(importedAutoFitError({ calibrationRules: { ...storedRules, signedOff: { by: 'Someone', on: '2026-09-29' } }, fitRecord: fit(storedRules) })).toContain('sign-off differs');
			expect(importedAutoFitError({ fitRecord: null })).toBeNull();
		});

		it('never refuses a stored fit a save carries back as it was, even with its keys in another order or the rules moved on', () => {
			const old = { ...stored, calibrationRules: { ...rules, revision: 3 }, fitRecord: fit(storedRules) };
			expect(autoFitRecordError(old, { ...old })).toBeNull();
			const auto = old.fitRecord!.auto!;
			const reordered = { ...old.fitRecord!, auto: Object.fromEntries(Object.entries(auto).reverse()) as typeof auto };
			expect(autoFitRecordError(old, { ...old, fitRecord: reordered })).toBeNull();
		});
	});
});

describe('settings.droughtRestriction (engine 1.46.0, WP-3.8)', () => {
	const rule = { reviewDates: ['01-01'], liftDates: ['05-01'], levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.3 } }, { belowPct: 0.3, cuts: { crops: 0.6, domestic: 0.2 } }] };
	it('takes a rule or null, checked by the engine’s own rule checks', () => {
		expect(SettingsPatch.safeParse({ droughtRestriction: rule }).success).toBe(true);
		expect(SettingsPatch.safeParse({ droughtRestriction: null }).success).toBe(true);
		const bad = SettingsPatch.safeParse({ droughtRestriction: { reviewDates: ['02-29'], levels: [{ belowPct: 0.5, cuts: { crops: 0.2 } }, { belowPct: 0.6, cuts: { crops: 0.1 } }] } });
		expect(bad.success).toBe(false);
		const messages = bad.error!.issues.map((i) => i.message).join('\n');
		expect(messages).toMatch(/drought restriction rule: reviewDates\[0\] .*29 February/);
		expect(messages).toMatch(/levels\[1\]\.belowPct level 2 must start below level 1's 50 %/);
		expect(messages).toMatch(/levels\[1\]\.cuts\.crops level 2 cuts crops less than level 1/);
		// No field the engine doesn't read gets through (mass assignment).
		expect(SettingsPatch.safeParse({ droughtRestriction: { ...rule, extra: 1 } }).success).toBe(false);
		expect(SettingsPatch.safeParse({ droughtRestriction: { ...rule, levels: [{ ...rule.levels[0], extra: 1 }] } }).success).toBe(false);
	});
	it('is replaced whole: a level left out of a save is gone', () => {
		const stored = patchSettings({}, { droughtRestriction: rule });
		expect(stored.droughtRestriction).toEqual(rule);
		const one = { reviewDates: ['10-01'], levels: [{ belowPct: 0.5, cuts: { crops: 0.5 } }] };
		expect(patchSettings(stored, { droughtRestriction: one }).droughtRestriction).toEqual(one);
		expect(patchSettings(stored, { droughtRestriction: null }).droughtRestriction).toBeNull();
		// Off by default: a project that never set it has none.
		expect(mergeSettings({}).droughtRestriction).toBeUndefined();
	});
});
