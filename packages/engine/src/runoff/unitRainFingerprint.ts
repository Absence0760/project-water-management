// What a fit records of the per-unit rain (engine ≥ 1.78.0, docs/model.md
// §2.4h, §2.10b), apart from ./unitRain.ts so the fit-provenance code the
// Settings forms load doesn't pull in the runoff model (issue #9).
import { DEFAULT_UNIT_MAP_PERIOD, MAP_MM_MAX, MAP_MM_MIN, unitRainSeriesKey, type UnitRainRule, type UnitRainSettings, type UnitRainSummary, type UnitChirpsLevel, type UnitRainUnit } from '../project';
import type { UnitRainRecipe } from './unitRain';

/** A unit's CHIRPS level as the fingerprint records it. */
const chirpsLevel = (c: UnitChirpsLevel | null): { chirpsSource: UnitChirpsLevel['source'] | null; chirpsFactor: number | null; chirpsFactors?: number[] } =>
	c
		? {
				chirpsSource: c.source,
				chirpsFactor: c.source === 'map' ? c.factor : c.source === 'reference' ? c.mapRatio : null,
				// The reference's monthly factors (engine ≥ 1.80.0), only on such a unit, so a fingerprint without them is as before.
				...(c.source === 'reference' ? { chirpsFactors: [...c.factors] } : {})
			}
		: { chirpsSource: null, chirpsFactor: null };

const usableMap = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= MAP_MM_MIN && v <= MAP_MM_MAX ? v : null);

/**
 * What a fit's forcing records of the per-unit rain (FitRecord.forcing.unitRain,
 * docs/model.md §2.10b): the setting and, per unit, its rule, the record it
 * names and its factors. A change of any is "Forcing changed since fit".
 */
export interface UnitRainFingerprint {
	mode: 'perUnit';
	gaugeMapMm: number | null;
	mapPeriod: { start: string; end: string };
	/** The reference gauge and unit (engine ≥ 1.80.0); absent = none. */
	reference?: { gauge: string; unitId: string };
	units: {
		nodeId: string;
		rule: UnitRainRule;
		rainKey: string | null;
		factor: number | null;
		factorSource: UnitRainUnit['factorSource'];
		gaugeMapFactor: number | null;
		/** How the unit's own CHIRPS is levelled, whatever the rule (it fills a gauge's gaps too); absent on a fingerprint without it, null = no CHIRPS. */
		chirpsSource?: 'map' | 'bias' | 'raw' | 'reference' | null;
		/** The CHIRPS MAP factor (`map`) or the MAP ratio on the reference factors (`reference`); else null. */
		chirpsFactor?: number | null;
		/** The 12 reference factors, calendar months (`reference` only). */
		chirpsFactors?: number[];
	}[];
}

/** The record a unit's rule names, and the level factor on it (UnitRainUnit's rainKey, factor and factorSource). */
export function recipeLevel(r: UnitRainRecipe): Pick<UnitRainUnit, 'rainKey' | 'factor' | 'factorSource'> {
	switch (r.rule) {
		case 'unitGauge':
			return { rainKey: unitRainSeriesKey('rain_catchment_mm', r.nodeId), factor: 1, factorSource: 'gauge' };
		case 'gaugeMap':
			return { rainKey: 'rain_catchment_mm', factor: r.gaugeMapFactor, factorSource: 'gaugeMap' };
		case 'unitChirps': {
			const c = r.chirps;
			const rainKey = unitRainSeriesKey('rain_chirps_mm', r.nodeId);
			if (c?.source === 'map') return { rainKey, factor: c.factor, factorSource: 'chirpsMap' };
			if (c?.source === 'bias') return { rainKey, factor: null, factorSource: 'chirpsBias' };
			if (c?.source === 'reference') return { rainKey, factor: null, factorSource: 'chirpsReference' };
			return { rainKey, factor: 1, factorSource: 'chirpsRaw' };
		}
		default:
			return { rainKey: null, factor: null, factorSource: 'catchment' };
	}
}

/** The fingerprint of the per-unit forcing a run or a fit used (settings.unitRain and each unit's recipe); null for catchment rain. */
export function unitRainFingerprint(u: UnitRainSettings | null | undefined, recipes: readonly UnitRainRecipe[] | null | undefined): UnitRainFingerprint | null {
	if (u?.mode !== 'perUnit' || !recipes) return null;
	return {
		mode: 'perUnit',
		gaugeMapMm: usableMap(u.gaugeMapMm),
		mapPeriod: { ...(u.mapPeriod ?? DEFAULT_UNIT_MAP_PERIOD) },
		...(u.reference ? { reference: { gauge: u.reference.gauge, unitId: u.reference.unitId } } : {}),
		units: recipes.map((r) => ({ nodeId: r.nodeId, rule: r.rule, ...recipeLevel(r), gaugeMapFactor: r.gaugeMapFactor, ...chirpsLevel(r.chirps) }))
	};
}

/** The fingerprint of a run's summary.unitRain (as unitRainFingerprint gives it at the fit); null for catchment rain. */
export function unitRainFingerprintOfSummary(s: UnitRainSummary | null | undefined): UnitRainFingerprint | null {
	if (!s) return null;
	return {
		mode: 'perUnit',
		gaugeMapMm: s.gaugeMapMm,
		mapPeriod: { ...s.mapPeriod },
		...(s.reference ? { reference: { gauge: s.reference.gauge, unitId: s.reference.unitId } } : {}),
		units: s.units.map((x) => ({ nodeId: x.nodeId, rule: x.rule, rainKey: x.rainKey, factor: x.factor, factorSource: x.factorSource, gaugeMapFactor: x.gaugeMapFactor, ...chirpsLevel(x.chirps) }))
	};
}

/** Relative tolerance two fingerprints' factors may differ by and still count as the same forcing (the CHIRPS factor drift's). */
const FACTOR_TOLERANCE = 0.02;

/** Whether two fingerprints describe different forcing (null = catchment rain). */
export function unitRainFingerprintChanged(a: UnitRainFingerprint | null | undefined, b: UnitRainFingerprint | null | undefined): boolean {
	if (!a || !b) return !a !== !b;
	const near = (x: number | null, y: number | null) => (x === null || y === null ? x === y : Math.abs(x - y) <= FACTOR_TOLERANCE * Math.abs(x));
	if (!near(a.gaugeMapMm, b.gaugeMapMm) || a.mapPeriod.start !== b.mapPeriod.start || a.mapPeriod.end !== b.mapPeriod.end || a.units.length !== b.units.length) return true;
	if (a.reference?.gauge !== b.reference?.gauge || a.reference?.unitId !== b.reference?.unitId) return true;
	return a.units.some((x, i) => {
		const y = b.units[i]!;
		// The CHIRPS level, when both sides recorded it.
		const months = (p?: number[], q?: number[]) => (!p || !q ? !p !== !q : p.length !== q.length || p.some((k, m) => !near(k, q[m]!)));
		const chirps =
			x.chirpsSource !== undefined &&
			y.chirpsSource !== undefined &&
			(x.chirpsSource !== y.chirpsSource || !near(x.chirpsFactor ?? null, y.chirpsFactor ?? null) || months(x.chirpsFactors, y.chirpsFactors));
		return x.nodeId !== y.nodeId || x.rule !== y.rule || x.rainKey !== y.rainKey || x.factorSource !== y.factorSource || !near(x.factor, y.factor) || !near(x.gaugeMapFactor, y.gaugeMapFactor) || chirps;
	});
}

/** Why a stored FitRecord.forcing.unitRain can't be one, or null (for the API's fit-record validation). */
export function unitRainFingerprintError(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) return 'not a unit rain fingerprint';
	const r = raw as Partial<UnitRainFingerprint>;
	if (r.mode !== 'perUnit') return 'mode must be perUnit';
	const num = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
	if (!num(r.gaugeMapMm)) return 'gaugeMapMm must be a number or null';
	if (!r.mapPeriod || typeof r.mapPeriod.start !== 'string' || typeof r.mapPeriod.end !== 'string') return 'mapPeriod needs a start and an end';
	if (!Array.isArray(r.units) || r.units.length > 2000) return 'units must be a list';
	const rules = ['unitGauge', 'gaugeMap', 'unitChirps', 'catchment'];
	const sources = ['gauge', 'gaugeMap', 'chirpsMap', 'chirpsBias', 'chirpsRaw', 'chirpsReference', 'catchment'];
	if (r.reference !== undefined && (!r.reference || typeof r.reference.gauge !== 'string' || typeof r.reference.unitId !== 'string' || r.reference.gauge.length > 250 || r.reference.unitId.length > 200))
		return 'the reference needs a gauge and a unit';
	for (const x of r.units) {
		if (!x || typeof x !== 'object' || typeof x.nodeId !== 'string' || x.nodeId.length > 200) return 'a unit needs a node id';
		if (!rules.includes(x.rule) || !sources.includes(x.factorSource)) return 'a unit has an unknown rule or factor source';
		if (!(x.rainKey === null || (typeof x.rainKey === 'string' && x.rainKey.length <= 250)) || !num(x.factor) || !num(x.gaugeMapFactor)) return 'a unit has a bad record key or factor';
		if (x.chirpsSource !== undefined && !(x.chirpsSource === null || ['map', 'bias', 'raw', 'reference'].includes(x.chirpsSource))) return 'a unit has an unknown CHIRPS level';
		if (x.chirpsFactor !== undefined && !num(x.chirpsFactor)) return 'a unit has a bad CHIRPS factor';
		if (x.chirpsFactors !== undefined && !(Array.isArray(x.chirpsFactors) && x.chirpsFactors.length === 12 && x.chirpsFactors.every((k) => typeof k === 'number' && Number.isFinite(k))))
			return 'a unit has bad reference factors';
	}
	return null;
}
