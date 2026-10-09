// Per-unit rain (engine ≥ 1.78.0, issue #482, docs/model.md §2.4h): under
// settings.unitRain `perUnit` each land unit (a farm with an area) runs GR4J
// on its own daily rain, with the one parameter set and the catchment PE, and
// its runoff replaces natural × share as its local inflow. This module builds
// each unit's rain (the forcing rule) and runs GR4J per unit; ./simulate.ts
// (runs, firm yield) and ../calibrate/calibrate.ts (each evaluation) call it.
//
// The rule, per unit, picks one record and a chain of fallbacks for the days
// it has no value:
//   1. unitGauge:  rain_catchment_mm@u, then its CHIRPS (levelled), then 2's
//                  scaled gauge, then the catchment's rain × the MAP ratio;
//   2. gaugeMap:   the catchment gauge × clamp(unit MAP ÷ gauge MAP), then its
//                  CHIRPS (levelled), then the catchment's rain × the ratio;
//   3. unitChirps: rain_chirps_mm@u × clamp(unit MAP ÷ its mean annual) (or
//                  the catchment's §2.4b factors, or raw), then the catchment's rain;
//   4. catchment:  the catchment forcing exactly as without per-unit rain,
//                  × settings.arealRain (which applies to rule 4 only).
// Days after the record fall to the forecast through the catchment's rain,
// so CHIRPS-GEFS stays catchment-wide × the MAP ratio (rule 2's) or × 1.
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex } from '../calendar';
import {
	AREAL_RAIN_FACTOR_MAX,
	AREAL_RAIN_FACTOR_MIN,
	arealRainFactors,
	DEFAULT_UNIT_MAP_PERIOD,
	MAP_MM_MAX,
	MAP_MM_MIN,
	unitRainSeriesKey,
	type DailySeries,
	type ModelInput,
	type NetworkNode,
	type ProjectSettings,
	type SeriesKind,
	type UnitChirpsLevel,
	type UnitRainRule,
	type UnitRainSettings,
	type UnitRainSummary,
	type UnitRainUnit
} from '../project';
import { chirpsFactorOn, type ChirpsCorrection } from '../rain';
import { cmpStr } from '../order';
import { gr4j } from './gr4j';
import type { Gr4jParams } from './params';
import { simulateRunoff, type RunoffForcing, type RunoffTrace } from './simulate';
import { isLandUnit, MM_KM2_TO_M3 } from './area';
import { recipeLevel } from './unitRainFingerprint';

export { isLandUnit, perUnitAreaKm2 } from './area';
export * from './unitRainFingerprint';

/** Complete calendar years a unit's CHIRPS MAP factor needs inside the MAP period before it stops warning (provisional, §2.4h). */
export const UNIT_MAP_MIN_YEARS = 5;

/** The source codes of a unit's day (UnitForcing.source): which link of the chain gave its rain. */
export const UNIT_RAIN_SOURCE = { unitGauge: 0, gaugeMap: 1, unitChirps: 2, catchment: 3, forecast: 4 } as const;

/**
 * A unit's rule and factors, fixed for a run: everything about its forcing
 * that reads the whole stored record (which records it has, the CHIRPS MAP
 * factor) rather than the run's days. A model-state snapshot pins them, as it
 * pins the CHIRPS bias factors, so a resumed run levels the rain as the
 * capture run did.
 */
export interface UnitRainRecipe {
	nodeId: string;
	rule: UnitRainRule;
	hasGauge: boolean;
	gaugeMapFactor: number | null;
	gaugeMapOwnFactor: number | null;
	gaugeMapClamped: boolean;
	chirps: UnitChirpsLevel | null;
}

/** One land unit's daily forcing over the run. */
export interface UnitForcing {
	/** Index of the node in input.model.nodes. */
	node: number;
	nodeId: string;
	name: string;
	areaKm2: number;
	mapMm: number | null;
	mapSource: string | null;
	recipe: UnitRainRecipe;
	/** Rain GR4J runs on, mm/day, never negative (0 on a day with none). */
	rainMm: Float64Array;
	/** Rule 4 with an areal correction: the rain before it; absent otherwise. */
	rainBeforeArealMm?: Float64Array;
	/** UNIT_RAIN_SOURCE of each day's rain; NaN where it had none. */
	source: Float64Array;
}

/** What the per-unit forcing reads from a prepared run. */
export interface UnitRainContext {
	settings: Pick<ProjectSettings, 'unitRain' | 'arealRain'>;
	series: ModelInput['series'];
	nodes: readonly NetworkNode[];
	startDate: string;
	days: number;
	aligned: (kind: SeriesKind) => (number | null)[];
	/** The catchment's §2.4b CHIRPS correction (prepareRun's), for a unit's CHIRPS without a MAP. */
	chirpsCorrection: ChirpsCorrection | null;
	/** The run's historical days (before a forecast tail); counts and warnings read only these. */
	historyDays?: number;
}

/** settings.unitRain is on: mode `perUnit`. */
export const unitRainOn = (s: { unitRain?: UnitRainSettings | null } | null | undefined): boolean => s?.unitRain?.mode === 'perUnit';

const clampFactor = (k: number) => Math.min(AREAL_RAIN_FACTOR_MAX, Math.max(AREAL_RAIN_FACTOR_MIN, k));
const usableMap = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= MAP_MM_MIN && v <= MAP_MM_MAX ? v : null);
/** A rain reading: finite and not negative (a negative value is a no-data code). */
const reading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const hasReading = (s: DailySeries | undefined): boolean => !!s && s.values.some(reading);
const fmt = (k: number) => (Math.round(k * 1000) / 1000).toString();

/**
 * The CHIRPS MAP factor's mean annual rain: the mean total of the complete
 * calendar years (every day a reading) of `s` inside `period`, or, with fewer
 * than UNIT_MAP_MIN_YEARS there, of every complete year of the record.
 * Null without a complete year.
 */
export function chirpsMeanAnnual(s: DailySeries, period: { start: string; end: string }): { meanAnnualMm: number; years: number[]; inPeriod: boolean } | null {
	const d0 = toEpochDay(s.startDate);
	const totals = new Map<number, { days: number; mm: number }>();
	for (let i = 0; i < s.values.length; i++) {
		const v = s.values[i];
		if (!reading(v)) continue;
		const y = Number(fromEpochDay(d0 + i).slice(0, 4));
		const t = totals.get(y) ?? totals.set(y, { days: 0, mm: 0 }).get(y)!;
		t.days++;
		t.mm += v;
	}
	const daysIn = (y: number) => toEpochDay(`${y + 1}-01-01`) - toEpochDay(`${y}-01-01`);
	const complete = [...totals].filter(([y, t]) => t.days === daysIn(y)).sort(([a], [b]) => a - b);
	if (!complete.length) return null;
	const from = toEpochDay(period.start);
	const to = toEpochDay(period.end);
	const inside = complete.filter(([y]) => toEpochDay(`${y}-01-01`) >= from && toEpochDay(`${y}-12-31`) <= to);
	const use = inside.length >= UNIT_MAP_MIN_YEARS ? inside : complete;
	return { meanAnnualMm: use.reduce((a, [, t]) => a + t.mm, 0) / use.length, years: use.map(([y]) => y), inPeriod: use === inside };
}

/** The catchment's §2.4b monthly factors exist: mode 'monthly' and some month has one. */
const biasExists = (c: ChirpsCorrection | null): boolean => !!c && c.mode === 'monthly' && c.months.some((m) => m.factor !== null);

/**
 * Each land unit's rule and factors (node-id order), with the warnings a run
 * gives about them; null when settings.unitRain is off or the model has no
 * land unit (that warns). `pinned` (a resumed run) replaces a unit's recipe
 * computed from the input.
 */
export function unitRainRecipes(ctx: Omit<UnitRainContext, 'aligned' | 'days' | 'startDate'>, warnings: string[], pinned?: readonly UnitRainRecipe[]): UnitRainRecipe[] | null {
	const u = ctx.settings.unitRain;
	if (u?.mode !== 'perUnit') return null;
	const units = ctx.nodes.filter(isLandUnit).sort((a, b) => cmpStr(a.id, b.id));
	if (!units.length) {
		warnings.push('Runoff from each unit’s own rain is on, but no unit has an area: GR4J runs on the catchment rain (docs/model.md §2.4h)');
		return null;
	}
	const series = ctx.series;
	const gaugeMap = usableMap(u.gaugeMapMm);
	const gaugeRain = hasReading(series.rain_catchment_mm);
	const period = u.mapPeriod ?? DEFAULT_UNIT_MAP_PERIOD;
	const bias = biasExists(ctx.chirpsCorrection);
	return units.map((n) => {
		const pin = pinned?.find((p) => p.nodeId === n.id);
		if (pin) return structuredClone(pin);
		const map = usableMap(n.mapMm);
		const hasGauge = hasReading(series[unitRainSeriesKey('rain_catchment_mm', n.id)]);
		const chirpsSeries = series[unitRainSeriesKey('rain_chirps_mm', n.id)];
		const hasChirps = hasReading(chirpsSeries);
		const unit = `unit rain: "${n.name}"`;
		// Rule 2's ratio, whenever its conditions hold: it also scales the catchment rain and forecast filling the unit's gaps.
		let gaugeMapFactor: number | null = null;
		let gaugeMapOwnFactor: number | null = null;
		let gaugeMapClamped = false;
		if (gaugeMap !== null && map !== null && gaugeRain) {
			gaugeMapOwnFactor = map / gaugeMap;
			gaugeMapFactor = clampFactor(gaugeMapOwnFactor);
			gaugeMapClamped = gaugeMapFactor !== gaugeMapOwnFactor;
			if (gaugeMapClamped)
				warnings.push(`${unit}: its MAP ÷ the gauge's MAP is ${fmt(gaugeMapOwnFactor)} (${map} ÷ ${gaugeMap} mm), outside ${AREAL_RAIN_FACTOR_MIN}–${AREAL_RAIN_FACTOR_MAX}; using ${fmt(gaugeMapFactor)} (clamped)`);
		}
		let chirps: UnitChirpsLevel | null = null;
		if (hasChirps) {
			const mean = map !== null ? chirpsMeanAnnual(chirpsSeries!, period) : null;
			if (map !== null && mean && mean.meanAnnualMm > 0) {
				const own = map / mean.meanAnnualMm;
				const factor = clampFactor(own);
				chirps = { source: 'map', factor, ownFactor: own, clamped: factor !== own, meanAnnualMm: mean.meanAnnualMm, years: mean.years, inPeriod: mean.inPeriod };
				const span = `${mean.years[0]}–${mean.years[mean.years.length - 1]}`;
				if (!mean.inPeriod)
					warnings.push(
						`${unit}: its CHIRPS has fewer than ${UNIT_MAP_MIN_YEARS} complete calendar years in the MAP period ${period.start} to ${period.end}, so its MAP factor averages every complete year of the record (${mean.years.length}, ${span}${mean.years.length < UNIT_MAP_MIN_YEARS ? `, still fewer than ${UNIT_MAP_MIN_YEARS}` : ''})`
					);
				if (chirps.clamped)
					warnings.push(`${unit}: its MAP ÷ its CHIRPS mean annual rain is ${fmt(own)} (${map} ÷ ${Math.round(mean.meanAnnualMm)} mm), outside ${AREAL_RAIN_FACTOR_MIN}–${AREAL_RAIN_FACTOR_MAX}; using ${fmt(factor)} (clamped)`);
			} else {
				if (map !== null) warnings.push(`${unit}: its CHIRPS has no complete calendar year with rain to compare its MAP with, so the MAP doesn't level it`);
				chirps = bias ? { source: 'bias' } : { source: 'raw' };
				if (!bias) warnings.push(`${unit}: its CHIRPS runs raw: ${map !== null ? 'its MAP can’t level it' : 'it has no MAP to level it'} and the catchment has no CHIRPS bias factors (§2.4b) to correct it with`);
			}
		}
		const rule: UnitRainRule = hasGauge ? 'unitGauge' : gaugeMapFactor !== null ? 'gaugeMap' : hasChirps ? 'unitChirps' : 'catchment';
		if (rule === 'catchment')
			warnings.push(
				`${unit} has no rain of its own (no rain gauge or CHIRPS series of its own, and no MAP to scale the catchment gauge by): it runs on the catchment rain${ctx.settings.arealRain ? ' × the areal correction' : ''}`
			);
		return { nodeId: n.id, rule, hasGauge, gaugeMapFactor, gaugeMapOwnFactor, gaugeMapClamped, chirps };
	});
}

/**
 * Each land unit's daily rain under settings.unitRain `perUnit` (node-id
 * order), with the warnings about it; null when it is off (or there is no
 * land unit). Recipes come from unitRainRecipes unless `pinned`.
 */
export function unitRainForcing(ctx: UnitRainContext, warnings: string[], pinned?: readonly UnitRainRecipe[]): { units: UnitForcing[]; recipes: UnitRainRecipe[] } | null {
	const recipes = unitRainRecipes(ctx, warnings, pinned);
	if (!recipes) return null;
	const { days } = ctx;
	const d0 = toEpochDay(ctx.startDate);
	const hist = Math.min(days, ctx.historyDays ?? days);
	const c = ctx.aligned('rain_catchment_mm');
	const ch = ctx.aligned('rain_chirps_mm');
	const f = ctx.aligned('rain_forecast_mm');
	const areal = arealRainFactors(ctx.settings.arealRain);
	const wy = new Uint8Array(days);
	for (let t = 0; t < days; t++) wy[t] = waterYearIndex(monthOfEpochDay(d0 + t));
	const byId = new Map(ctx.nodes.map((n, i) => [n.id, i]));
	const align = (s: DailySeries | undefined) => {
		const out = new Array<number | null>(days).fill(null);
		if (!s) return out;
		const off = toEpochDay(s.startDate) - d0;
		for (let i = Math.max(0, -off); i < Math.min(s.values.length, days - off); i++) out[i + off] = reading(s.values[i]) ? (s.values[i] as number) : null;
		return out;
	};
	const units = recipes.map((r) => {
		const i = byId.get(r.nodeId)!;
		const n = ctx.nodes[i]!;
		const rainMm = new Float64Array(days);
		const source = new Float64Array(days).fill(NaN);
		const base = { node: i, nodeId: n.id, name: n.name, areaKm2: n.areaKm2, mapMm: usableMap(n.mapMm), mapSource: typeof n.mapSource === 'string' ? n.mapSource : null, recipe: r };
		if (r.rule === 'catchment') {
			// The catchment forcing as without per-unit rain (runoffForcing): catchment ?? CHIRPS ?? forecast, × the areal factor.
			const before = areal ? new Float64Array(days) : null;
			for (let t = 0; t < days; t++) {
				const v = c[t] ?? ch[t] ?? f[t] ?? null;
				if (v === null) continue;
				source[t] = c[t] != null || ch[t] != null ? UNIT_RAIN_SOURCE.catchment : UNIT_RAIN_SOURCE.forecast;
				rainMm[t] = Math.max(0, v) * (areal ? areal[wy[t]!]! : 1);
				if (before) before[t] = Math.max(0, v);
			}
			return { ...base, rainMm, source, ...(before ? { rainBeforeArealMm: before } : {}) };
		}
		const gauge = r.hasGauge ? align(ctx.series[unitRainSeriesKey('rain_catchment_mm', n.id)]) : null;
		const chirps = r.chirps ? align(ctx.series[unitRainSeriesKey('rain_chirps_mm', n.id)]) : null;
		const k2 = r.gaugeMapFactor;
		const level = r.chirps;
		const chirpsAt = (t: number): number | null => {
			const v = chirps![t];
			if (v == null) return null;
			if (level!.source === 'map') return v * level!.factor;
			if (level!.source === 'bias') return v * (chirpsFactorOn(ctx.chirpsCorrection, d0 + t) ?? 1);
			return v;
		};
		const kFill = k2 ?? 1;
		for (let t = 0; t < days; t++) {
			let v: number | null = null;
			let code: number = NaN;
			const own = gauge ? gauge[t]! : null;
			if (own !== null) {
				v = own;
				code = UNIT_RAIN_SOURCE.unitGauge;
			}
			// Rule 1 fills from its CHIRPS before rule 2's scaled gauge; rule 2 from its scaled gauge first.
			if (v === null && r.rule === 'gaugeMap' && c[t] != null) {
				v = c[t]! * k2!;
				code = UNIT_RAIN_SOURCE.gaugeMap;
			}
			if (v === null && chirps) {
				const x = chirpsAt(t);
				if (x !== null) {
					v = x;
					code = UNIT_RAIN_SOURCE.unitChirps;
				}
			}
			if (v === null && r.rule === 'unitGauge' && k2 !== null && c[t] != null) {
				v = c[t]! * k2;
				code = UNIT_RAIN_SOURCE.gaugeMap;
			}
			if (v === null) {
				const x = c[t] ?? ch[t] ?? f[t] ?? null;
				if (x !== null) {
					v = x * kFill;
					code = c[t] != null || ch[t] != null ? UNIT_RAIN_SOURCE.catchment : UNIT_RAIN_SOURCE.forecast;
				}
			}
			if (v === null) continue;
			rainMm[t] = Math.max(0, v);
			source[t] = code;
		}
		// The historical days the unit's own path left to the catchment's rain: say how many, so a short record isn't silent.
		let fell = 0;
		for (let t = 0; t < hist; t++) if (source[t] === UNIT_RAIN_SOURCE.catchment) fell++;
		if (fell > 0)
			warnings.push(
				`unit rain: "${n.name}" ran ${fell} of its ${hist} day${hist === 1 ? '' : 's'} on the catchment's rain${k2 !== null ? ` × its MAP ratio ${fmt(k2)}` : ''}, where its own records had no value`
			);
		return { ...base, rainMm, source };
	});
	return { units, recipes };
}

/** GR4J over each unit's forcing (one parameter set, the catchment PE); the per-unit simulateRunoff traces, in `units` order. */
export function simulateUnits(
	units: readonly Pick<UnitForcing, 'nodeId' | 'rainMm'>[],
	p: Gr4jParams,
	petMm: Float64Array,
	opts: { warmupDays: number; trace?: boolean; days?: number; cycleDays?: number; initial?: readonly { id: string; state: readonly number[] }[]; captureAt?: number }
): RunoffTrace[] {
	return units.map((u) => {
		const init = opts.initial?.find((x) => x.id === u.nodeId);
		if (opts.initial && !init) throw new Error(`the snapshot holds no runoff state for the unit ${u.nodeId}`);
		const forcing: RunoffForcing = { rainMm: u.rainMm, petMm };
		return simulateRunoff(gr4j, p, forcing, {
			warmupDays: opts.warmupDays,
			...(opts.trace !== undefined ? { trace: opts.trace } : {}),
			...(opts.days !== undefined ? { days: opts.days } : {}),
			...(opts.cycleDays !== undefined ? { cycleDays: opts.cycleDays } : {}),
			...(init ? { initial: init.state } : {}),
			...(opts.captureAt !== undefined ? { captureAt: opts.captureAt } : {})
		});
	});
}

/**
 * The run's summary.unitRain from each unit's forcing and GR4J trace (both
 * in node-id order). `hist` is the run's historical days: the day counts are
 * of the whole run.
 */
export function unitRainSummary(u: UnitRainSettings, units: readonly UnitForcing[], traces: readonly RunoffTrace[], petMm: Float64Array): UnitRainSummary {
	const sum = (a: ArrayLike<number>) => {
		let s = 0;
		for (let t = 0; t < a.length; t++) s += a[t]!;
		return s;
	};
	const petTotal = sum(petMm);
	return {
		mode: 'perUnit',
		gaugeMapMm: usableMap(u.gaugeMapMm),
		gaugeMapSource: typeof u.gaugeMapSource === 'string' && u.gaugeMapSource ? u.gaugeMapSource : null,
		mapPeriod: { ...(u.mapPeriod ?? DEFAULT_UNIT_MAP_PERIOD) },
		units: units.map((x, k): UnitRainUnit => {
			const tr = traces[k]!;
			const r = x.recipe;
			const days = { unitGauge: 0, gaugeMap: 0, unitChirps: 0, catchment: 0, forecast: 0, none: 0 };
			for (let t = 0; t < x.source.length; t++) {
				const s = x.source[t]!;
				if (s === UNIT_RAIN_SOURCE.unitGauge) days.unitGauge++;
				else if (s === UNIT_RAIN_SOURCE.gaugeMap) days.gaugeMap++;
				else if (s === UNIT_RAIN_SOURCE.unitChirps) days.unitChirps++;
				else if (s === UNIT_RAIN_SOURCE.catchment) days.catchment++;
				else if (s === UNIT_RAIN_SOURCE.forecast) days.forecast++;
				else days.none++;
			}
			const rainMm = sum(x.rainMm);
			const flowMm = sum(tr.qMm);
			const level = recipeLevel(r);
			return {
				nodeId: x.nodeId,
				name: x.name,
				areaKm2: x.areaKm2,
				mapMm: x.mapMm,
				mapSource: x.mapSource,
				rule: r.rule,
				...level,
				gaugeMapFactor: r.gaugeMapFactor,
				gaugeMapOwnFactor: r.gaugeMapOwnFactor,
				gaugeMapClamped: r.gaugeMapClamped,
				chirps: r.chirps ? structuredClone(r.chirps) : null,
				days,
				rainMm,
				petMm: petTotal,
				aetMm: sum(tr.aetMm),
				flowMm,
				exchangeMm: sum(tr.exchangeMm),
				storageStartMm: tr.storageStartMm,
				storageEndMm: tr.storageEndMm,
				runoffM3: flowMm * x.areaKm2 * MM_KM2_TO_M3,
				runoffCoefficient: rainMm > 0 ? flowMm / rainMm : null
			};
		})
	};
}
