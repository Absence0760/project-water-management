// Rain from rainfall stations (issue #553, engine ≥ 1.91.0, docs/model.md
// §2.4i): one rule for the catchment and for a land unit.
//
//   station day (the checked station record has a reading):
//       rain = station × clamp(area MAP ÷ station MAP)   (× 1 with scaleToMap false or a MAP missing)
//   otherwise, when the area has CHIRPS and the pairing of `correctAgainst`
//   (default the same station) isn't refused:
//       rain = the area's CHIRPS × that pairing's factor of the day's month, as is (no MAP ratio)
//   otherwise: the area's next fallback (the catchment: the forecast; a unit:
//   its own forecast, then the catchment forcing), else dry.
//
// The station's checked record is ./stationRecord.ts's (the catchment's
// §2.4c/§2.4d checks, then the user's unreliable periods), its pairing
// ./stationPairing.ts's. The catchment's area is the catchment MAP: settings
// .rainStations.catchmentMapMm, else the land units' area-weighted mean MAP
// (node-id order). The catchment forcing is built in ../prepare.ts, which
// reads it as the catchment rain (`aligned('rain_catchment_mm')` = the
// station days, `aligned('rain_chirps_mm')` = the corrected CHIRPS on the
// other days), so every reader of the catchment rain (GR4J, demand, the
// WR2012 check, a rule-4 unit) reads the same rain. A unit's is built in
// ./unitRain.ts (rule 'station'). This module is pure: no I/O.
import { toEpochDay } from '../calendar';
import { cmpStr } from '../order';
import {
	AREAL_RAIN_FACTOR_MAX,
	AREAL_RAIN_FACTOR_MIN,
	AREAL_RAIN_FACTOR_WARN_MAX,
	AREAL_RAIN_FACTOR_WARN_MIN,
	MAP_MM_MAX,
	MAP_MM_MIN,
	outsideArealRainBand,
	stationSeriesKey,
	type DailySeries,
	type ModelInput,
	type NetworkNode,
	type ProjectSettings,
	type RainStationAssignment,
	type RainStationInputs,
	type RainStationSettings,
	type RainStationSummary,
	type StationAreaForcing,
	type StationPairingFit
} from '../project';
import { isLandUnit } from './area';
import { fitStationPairing, pairingFactorOn } from './stationPairing';
import { checkedStationRecord, type CheckedStationRecord } from './stationRecord';

/** What a day of an area's station forcing read (StationAreaDays.source). */
export const STATION_DAY_SOURCE = { none: 0, station: 1, chirps: 2, fallback: 3 } as const;

const usableMap = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= MAP_MM_MIN && v <= MAP_MM_MAX ? v : null);
const reading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const clampFactor = (k: number) => Math.min(AREAL_RAIN_FACTOR_MAX, Math.max(AREAL_RAIN_FACTOR_MIN, k));
const fmt = (k: number) => (Math.round(k * 1000) / 1000).toString();
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

/** One assignment as the engine runs it, or null (with a warning) when it can't be one. */
function resolveAssignment(raw: unknown, where: string, warnings: string[]): RainStationAssignment | null {
	const a = raw as Partial<RainStationAssignment> | null;
	if (!a || typeof a !== 'object' || Array.isArray(a) || !isId(a.stationId)) {
		warnings.push(`rain stations: ${where} names no station, so it is ignored (docs/model.md §2.4i)`);
		return null;
	}
	if (a.scaleToMap !== undefined && typeof a.scaleToMap !== 'boolean') warnings.push(`rain stations: ${where}'s scaleToMap isn't true or false; scaling to MAP`);
	if (a.correctAgainst != null && !isId(a.correctAgainst)) warnings.push(`rain stations: ${where}'s correctAgainst isn't a station id; correcting against its own station`);
	return {
		stationId: a.stationId,
		scaleToMap: typeof a.scaleToMap === 'boolean' ? a.scaleToMap : true,
		correctAgainst: isId(a.correctAgainst) ? a.correctAgainst : a.stationId
	};
}

/**
 * A stored settings.rainStations as the engine runs it (mergeSettings, only
 * when stored): each assignment with its defaults filled in (scaleToMap true,
 * correctAgainst its station), an unusable one dropped with a warning, an
 * unusable catchment MAP read as none. `sites`, `unreliable` and
 * `pinnedFactors` pass through: the record checks and the pairing fit judge
 * them. Null for null / not an object.
 */
export function resolveRainStations(raw: unknown, warnings: string[]): RainStationSettings | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		warnings.push('rain stations: the setting is not an object, so it is ignored (docs/model.md §2.4i)');
		return null;
	}
	const r = raw as RainStationSettings;
	const out: RainStationSettings = {};
	out.catchment = r.catchment == null ? null : resolveAssignment(r.catchment, 'the catchment', warnings);
	if (r.units != null) {
		if (typeof r.units !== 'object' || Array.isArray(r.units)) warnings.push('rain stations: the units’ stations are not a map of unit → station, so they are ignored');
		else {
			const units: Record<string, RainStationAssignment> = {};
			for (const id of Object.keys(r.units).sort(cmpStr)) {
				const a = resolveAssignment(r.units[id], `the unit ${id}`, warnings);
				if (a) units[id] = a;
			}
			out.units = units;
		}
	}
	if (r.catchmentMapMm != null) {
		const map = usableMap(r.catchmentMapMm);
		if (map === null) warnings.push(`rain stations: the catchment MAP ${JSON.stringify(r.catchmentMapMm)} mm is not ${MAP_MM_MIN}–${MAP_MM_MAX} mm, so the units’ area-weighted mean is used`);
		out.catchmentMapMm = map;
		out.catchmentMapSource = map !== null && typeof r.catchmentMapSource === 'string' ? r.catchmentMapSource : null;
	}
	if (r.sites != null) out.sites = r.sites;
	if (r.unreliable != null) out.unreliable = r.unreliable;
	if (r.pinnedFactors != null) out.pinnedFactors = r.pinnedFactors;
	return out;
}

/** The settings with `factors` (station id → 12) pinned over the stored pinnedFactors (a resumed run's, PreparedFits.stationFactors). */
export function withPinnedStationFactors(settings: ProjectSettings, factors: Readonly<Record<string, number[]>> | null | undefined): ProjectSettings {
	if (!settings.rainStations || !factors || !Object.keys(factors).length) return settings;
	return { ...settings, rainStations: { ...settings.rainStations, pinnedFactors: { ...(settings.rainStations.pinnedFactors ?? {}), ...structuredClone(factors) } } };
}

// ---------------------------------------------------------------------------
// Records and pairings, once per station per run
// ---------------------------------------------------------------------------

/**
 * Each station's checked record and pairing, computed once per run and shared
 * by the catchment and every unit (so a pairing's warnings come once). The
 * pairings used are summary.stations.pairings.
 */
export interface StationContext {
	settings: ProjectSettings;
	series: ModelInput['series'];
	stations: RainStationInputs;
	nodes: readonly NetworkNode[];
	/** The station's name: ModelInput.stations[id].name, else its id. */
	name(id: string): string;
	/** The station's MAP and source (null without one). */
	map(id: string): { mapMm: number | null; mapSource: string | null };
	/** The station's checked record (null: no record in the input); its check warnings go to the run once. */
	record(id: string): CheckedStationRecord | null;
	/** The station's pairing (fitted once; recorded as used). */
	pairing(id: string): StationPairingFit;
	/** Every pairing used so far, station-id order. */
	pairings(): StationPairingFit[];
}

export function stationContext(args: { settings: ProjectSettings; series: ModelInput['series']; stations: RainStationInputs | null | undefined; nodes: readonly NetworkNode[] }, warnings: string[]): StationContext {
	const stations = args.stations ?? {};
	const records = new Map<string, CheckedStationRecord | null>();
	const fits = new Map<string, StationPairingFit>();
	const isGauge = (id: string) => stations[id]?.isCatchmentGauge === true;
	const name = (id: string) => (typeof stations[id]?.name === 'string' && stations[id]!.name ? stations[id]!.name : id);
	return {
		settings: args.settings,
		series: args.series,
		stations,
		nodes: args.nodes,
		name,
		map: (id) => {
			const mapMm = usableMap(stations[id]?.mapMm);
			return { mapMm, mapSource: mapMm !== null && typeof stations[id]?.mapSource === 'string' ? stations[id]!.mapSource : null };
		},
		record: (id) => {
			if (!records.has(id)) {
				const r = checkedStationRecord(args.settings, args.series, id, { name: name(id), isCatchmentGauge: isGauge(id) });
				if (r) warnings.push(...r.warnings);
				records.set(id, r);
			}
			return records.get(id)!;
		},
		pairing: (id) => {
			if (!fits.has(id)) fits.set(id, fitStationPairing({ settings: args.settings, series: args.series, stations, nodes: args.nodes, stationId: id }, warnings));
			return fits.get(id)!;
		},
		pairings: () => [...fits.values()].sort((a, b) => cmpStr(a.stationId, b.stationId))
	};
}

/** The factors of every pairing used and not refused, for a snapshot to pin (PreparedFits.stationFactors). */
export function pairingFactors(ctx: StationContext | null | undefined): Record<string, number[]> {
	const out: Record<string, number[]> = {};
	for (const p of ctx?.pairings() ?? []) if (p.refused === null && p.months.length === 12) out[p.stationId] = p.months.map((m) => m.factor);
	return out;
}

// ---------------------------------------------------------------------------
// MAPs and the ratio
// ---------------------------------------------------------------------------

/**
 * The catchment's MAP for the catchment station's ratio: the setting's, else
 * the land units' area-weighted mean MAP in node-id order (null, with the
 * units lacking one, when any land unit has none or there is no land unit).
 */
export function catchmentMapOf(rs: RainStationSettings | null | undefined, nodes: readonly NetworkNode[]): { mapMm: number | null; mapSource: string | null; fromUnits: boolean; missing: string[] } {
	const set = usableMap(rs?.catchmentMapMm);
	if (set !== null) return { mapMm: set, mapSource: typeof rs?.catchmentMapSource === 'string' ? rs.catchmentMapSource : null, fromUnits: false, missing: [] };
	const units = nodes.filter(isLandUnit).sort((a, b) => cmpStr(a.id, b.id));
	const missing = units.filter((n) => usableMap(n.mapMm) === null).map((n) => n.name);
	if (!units.length || missing.length) return { mapMm: null, mapSource: null, fromUnits: true, missing };
	let area = 0;
	let sum = 0;
	for (const n of units) {
		area += n.areaKm2;
		sum += n.mapMm! * n.areaKm2;
	}
	return { mapMm: sum / area, mapSource: 'the units’ area-weighted mean MAP', fromUnits: true, missing: [] };
}

/** area MAP ÷ station MAP, clamped to 0.25–4; × 1 (ownRatio null) with scaling off or either MAP missing. */
export function stationRatio(areaMapMm: number | null, stationMapMm: number | null, scaleToMap: boolean): { ratio: number; ownRatio: number | null; clamped: boolean } {
	if (!scaleToMap || areaMapMm === null || stationMapMm === null) return { ratio: 1, ownRatio: null, clamped: false };
	const own = areaMapMm / stationMapMm;
	const ratio = clampFactor(own);
	return { ratio, ownRatio: own, clamped: ratio !== own };
}

/** The warnings a ratio gives (clamped, outside the 0.5–2 band, or × 1 for a missing MAP), naming the area and its station. */
function ratioWarnings(area: string, station: string, areaMapMm: number | null, stationMapMm: number | null, r: ReturnType<typeof stationRatio>, scaleToMap: boolean, missingWhy: string | null): string[] {
	const who = `station: ${area} on "${station}"`;
	if (!scaleToMap) return [];
	if (stationMapMm === null) return [`${who} runs on the station’s rain × 1: the station has no MAP to scale it by`];
	if (areaMapMm === null) return [`${who} runs on the station’s rain × 1: ${missingWhy ?? 'it has no MAP to scale it by'}`];
	const own = r.ownRatio!;
	if (r.clamped) return [`${who}: its MAP ÷ the station’s MAP is ${fmt(own)} (${fmt(areaMapMm)} ÷ ${fmt(stationMapMm)} mm), outside ${AREAL_RAIN_FACTOR_MIN}–${AREAL_RAIN_FACTOR_MAX}; using ${fmt(r.ratio)} (clamped)`];
	if (outsideArealRainBand(own))
		return [`${who}: its MAP ÷ the station’s MAP is ${fmt(own)} (${fmt(areaMapMm)} ÷ ${fmt(stationMapMm)} mm), outside ${AREAL_RAIN_FACTOR_WARN_MIN}–${AREAL_RAIN_FACTOR_WARN_MAX}: used as it is, but check the MAPs`];
	return [];
}

// ---------------------------------------------------------------------------
// The daily rule
// ---------------------------------------------------------------------------

/** A series aligned to start … start + days − 1 (epoch days), a non-reading as null. */
export function alignReadings(s: DailySeries | null | undefined, start: number, days: number): (number | null)[] {
	const out = new Array<number | null>(days).fill(null);
	if (!s) return out;
	const off = toEpochDay(s.startDate) - start;
	for (let i = Math.max(0, -off); i < Math.min(s.values.length, days - off); i++) {
		const v = s.values[i];
		out[i + off] = reading(v) ? v : null;
	}
	return out;
}

/** An area's station rule over a window, before its next fallback. */
export interface StationAreaDays {
	/** The rain on station and CHIRPS days (mm, the value as computed: not floored); null on the days the next fallback takes. */
	values: (number | null)[];
	/** STATION_DAY_SOURCE per day: station, chirps, or none (left to the next fallback). */
	source: Uint8Array;
}

/**
 * The station rule on each day (see the header): station × ratio on its
 * days, else the area's CHIRPS × the pairing's factor of the day's month (no
 * ratio), else null. `pairing` null or refused leaves CHIRPS unread.
 */
export function stationAreaDays(a: { start: number; days: number; station: readonly (number | null)[]; ratio: number; chirps: readonly (number | null)[] | null; pairing: StationPairingFit | null }): StationAreaDays {
	const values = new Array<number | null>(a.days).fill(null);
	const source = new Uint8Array(a.days);
	const corrected = a.chirps && a.pairing && a.pairing.refused === null ? a.pairing : null;
	for (let t = 0; t < a.days; t++) {
		const s = a.station[t];
		if (s != null) {
			values[t] = s * a.ratio;
			source[t] = STATION_DAY_SOURCE.station;
			continue;
		}
		if (!corrected) continue;
		const c = a.chirps![t];
		if (c == null) continue;
		const k = pairingFactorOn(corrected, a.start + t);
		if (k === null) continue;
		values[t] = c * k;
		source[t] = STATION_DAY_SOURCE.chirps;
	}
	return { values, source };
}

/**
 * The station days the checks and the unreliable periods set aside inside
 * the window: a stored reading that the checked record blanks. A day both
 * set aside counts under the checks (the record-wide rule of
 * ./stationRecord.ts).
 */
export function setAsideInWindow(ctx: StationContext, stationId: string, start: number, days: number): { checks: number; unreliable: number } {
	const stored = alignReadings((ctx.series as Record<string, DailySeries | undefined>)[stationSeriesKey(stationId)], start, days);
	const rec = ctx.record(stationId);
	const final = alignReadings(rec?.record, start, days);
	const periods = ctx.settings.rainStations?.unreliable?.[stationId];
	const hasPeriods = Array.isArray(periods) && periods.length > 0;
	let checksOnly: (number | null)[] | null = null;
	if (hasPeriods) {
		const rs = ctx.settings.rainStations!;
		const without = checkedStationRecord({ ...ctx.settings, rainStations: { ...rs, unreliable: Object.fromEntries(Object.entries(rs.unreliable ?? {}).filter(([id]) => id !== stationId)) } }, ctx.series, stationId, { isCatchmentGauge: ctx.stations[stationId]?.isCatchmentGauge === true });
		checksOnly = alignReadings(without?.record, start, days);
	}
	let checks = 0;
	let unreliable = 0;
	for (let t = 0; t < days; t++) {
		if (stored[t] == null || final[t] != null) continue;
		if (checksOnly && checksOnly[t] != null) unreliable++;
		else checks++;
	}
	return { checks, unreliable };
}

/** Day counts by source over the run (StationAreaForcing.days). */
export function stationDayCounts(source: ArrayLike<number>, fallback: (t: number) => boolean): StationAreaForcing['days'] {
	const days = { station: 0, chirps: 0, fallback: 0, none: 0 };
	for (let t = 0; t < source.length; t++) {
		const s = source[t];
		if (s === STATION_DAY_SOURCE.station) days.station++;
		else if (s === STATION_DAY_SOURCE.chirps) days.chirps++;
		else if (fallback(t)) days.fallback++;
		else days.none++;
	}
	return days;
}

// ---------------------------------------------------------------------------
// The catchment
// ---------------------------------------------------------------------------

/** The catchment's station resolved for a run: what ../prepare.ts needs before the window is known. */
export interface CatchmentStationPlan {
	ctx: StationContext;
	assignment: Required<Pick<RainStationAssignment, 'stationId'>> & { scaleToMap: boolean; correctAgainst: string };
	/** The checked station record (its whole span). */
	record: DailySeries;
	map: ReturnType<typeof catchmentMapOf>;
	stationMap: { mapMm: number | null; mapSource: string | null };
	ratio: ReturnType<typeof stationRatio>;
	pairing: StationPairingFit;
}

/**
 * The catchment's station for a run, or null when settings.rainStations has
 * no catchment assignment (the catchment rain as before, bit for bit) or its
 * station has no record in the input (a warning: the catchment rain as
 * before). Fits the pairing it corrects against.
 */
export function catchmentStationPlan(ctx: StationContext, warnings: string[]): CatchmentStationPlan | null {
	const a = ctx.settings.rainStations?.catchment;
	if (!a) return null;
	const stationId = a.stationId;
	const rec = ctx.record(stationId);
	if (!rec) {
		warnings.push(`station: the catchment’s station "${ctx.name(stationId)}" has no record in this run’s input, so the catchment rain is read as without a station (docs/model.md §2.4i)`);
		return null;
	}
	const scaleToMap = a.scaleToMap !== false;
	const correctAgainst = a.correctAgainst ?? stationId;
	const map = catchmentMapOf(ctx.settings.rainStations, ctx.nodes);
	const stationMap = ctx.map(stationId);
	const ratio = stationRatio(map.mapMm, stationMap.mapMm, scaleToMap);
	const why = map.missing.length ? `the catchment MAP is the units’ area-weighted mean, and ${map.missing.map((n) => `"${n}"`).join(', ')} ${map.missing.length === 1 ? 'has' : 'have'} no MAP` : 'the catchment has no MAP (no unit with land, and none entered)';
	warnings.push(...ratioWarnings('the catchment', ctx.name(stationId), map.mapMm, stationMap.mapMm, ratio, scaleToMap, why));
	const pairing = ctx.pairing(correctAgainst);
	return { ctx, assignment: { stationId, scaleToMap, correctAgainst }, record: rec.record, map, stationMap, ratio, pairing };
}

/**
 * The catchment rain a reference gauge of `rain_catchment_mm` (§2.4h) is
 * fitted on under a catchment station: what every reader of the catchment
 * rain sees on the station's days, station × the catchment ratio, from the
 * station's checked record with its accumulation windows left out (as the
 * fit leaves them out on the gauge), over the record's whole span. Null
 * without a catchment station in this input (then the stored gauge is the
 * catchment rain, and the reference reads it as before).
 */
export function catchmentStationReferenceRecord(ctx: StationContext): DailySeries | null {
	const plan = catchmentStationPlan(ctx, []);
	if (!plan) return null;
	const id = plan.assignment.stationId;
	const rec = checkedStationRecord(ctx.settings, ctx.series, id, { fitExcludeAccumulations: true, name: ctx.name(id), isCatchmentGauge: ctx.stations[id]?.isCatchmentGauge === true });
	if (!rec) return null;
	const r = plan.ratio.ratio;
	return { startDate: rec.record.startDate, values: rec.record.values.map((v) => (v == null ? null : v * r)) };
}

/**
 * The catchment forcing over a window: the two arrays prepareRun's `aligned`
 * returns for `rain_catchment_mm` (station × ratio on its days, else null)
 * and `rain_chirps_mm` (the catchment CHIRPS × the pairing's factors on the
 * other days; as stored on station days; null on days the pairing can't
 * correct, so they fall to the forecast), with the day codes and the summary.
 */
export function catchmentStationForcing(
	plan: CatchmentStationPlan,
	start: number,
	days: number,
	chirps: readonly (number | null)[],
	forecast: readonly (number | null)[]
): { catchment: (number | null)[]; chirps: (number | null)[]; days: StationAreaDays; forcing: StationAreaForcing } {
	const d = stationAreaDays({ start, days, station: alignReadings(plan.record, start, days), ratio: plan.ratio.ratio, chirps, pairing: plan.pairing });
	const catchment = new Array<number | null>(days).fill(null);
	const ch = new Array<number | null>(days).fill(null);
	for (let t = 0; t < days; t++) {
		if (d.source[t] === STATION_DAY_SOURCE.station) {
			catchment[t] = d.values[t]!;
			ch[t] = chirps[t] ?? null;
		} else if (d.source[t] === STATION_DAY_SOURCE.chirps) ch[t] = d.values[t]!;
	}
	const ctx = plan.ctx;
	const id = plan.assignment.stationId;
	return {
		catchment,
		chirps: ch,
		days: d,
		forcing: {
			nodeId: null,
			name: 'the catchment',
			stationId: id,
			stationName: ctx.name(id),
			areaMapMm: plan.map.mapMm,
			areaMapSource: plan.map.mapSource,
			stationMapMm: plan.stationMap.mapMm,
			stationMapSource: plan.stationMap.mapSource,
			ownRatio: plan.ratio.ownRatio,
			ratio: plan.ratio.ratio,
			clamped: plan.ratio.clamped,
			scaleToMap: plan.assignment.scaleToMap,
			correctedBy: plan.pairing.refused === null ? plan.pairing.stationId : null,
			days: stationDayCounts(d.source, (t) => forecast[t] != null),
			setAside: setAsideInWindow(ctx, id, start, days)
		}
	};
}

// ---------------------------------------------------------------------------
// A unit
// ---------------------------------------------------------------------------

/** A land unit's station, fixed for a run (UnitRainRecipe.station): what a snapshot or an outlook member pins. */
export interface UnitStationRecipe {
	stationId: string;
	correctAgainst: string;
	scaleToMap: boolean;
	stationMapMm: number | null;
	ratio: number;
	ownRatio: number | null;
	clamped: boolean;
	/** The pairing's 12 factors (calendar months); null when refused (its gaps fall to the next fallback). */
	factors: number[] | null;
}

/**
 * A land unit's station recipe, or null with a warning when its station has
 * no record in the input (the unit keeps the §2.4h chain).
 */
export function unitStationRecipe(ctx: StationContext, node: NetworkNode, a: RainStationAssignment, warnings: string[]): UnitStationRecipe | null {
	const stationId = a.stationId;
	if (!ctx.record(stationId)) {
		warnings.push(`station: "${node.name}"’s station "${ctx.name(stationId)}" has no record in this run’s input, so the unit keeps its own rain rule (docs/model.md §2.4h)`);
		return null;
	}
	const scaleToMap = a.scaleToMap !== false;
	const correctAgainst = a.correctAgainst ?? stationId;
	const stationMap = ctx.map(stationId);
	const unitMap = usableMap(node.mapMm);
	const r = stationRatio(unitMap, stationMap.mapMm, scaleToMap);
	warnings.push(...ratioWarnings(`"${node.name}"`, ctx.name(stationId), unitMap, stationMap.mapMm, r, scaleToMap, null));
	const p = ctx.pairing(correctAgainst);
	return { stationId, correctAgainst, scaleToMap, stationMapMm: stationMap.mapMm, ratio: r.ratio, ownRatio: r.ownRatio, clamped: r.clamped, factors: p.refused === null && p.months.length === 12 ? p.months.map((m) => m.factor) : null };
}

/** The pairing a recipe's factors stand for (pinned ones read as a fit of those factors). */
export function recipePairing(ctx: StationContext, r: UnitStationRecipe): StationPairingFit {
	const fit = ctx.pairing(r.correctAgainst);
	if (r.factors === null) return { ...fit, refused: fit.refused ?? 'pinned as refused', months: [] };
	const same = fit.refused === null && fit.months.length === 12 && fit.months.every((m, i) => m.factor === r.factors![i]);
	if (same) return fit;
	return { ...fit, refused: null, pinned: true, months: r.factors.map((factor, m) => ({ month: m + 1, sharedDays: 0, gaugeMm: 0, chirpsMm: 0, ownFactor: null, factor, clamped: false, fitted: false, outsideBand: false })) };
}

/** summary.stations from the catchment's forcing, the units' and the pairings used; null when no area has a station. */
export function rainStationSummary(ctx: StationContext | null | undefined, catchment: StationAreaForcing | null, units: readonly StationAreaForcing[], map: ReturnType<typeof catchmentMapOf> | null): RainStationSummary | null {
	if (!ctx || (!catchment && !units.length)) return null;
	const m = map ?? catchmentMapOf(ctx.settings.rainStations, ctx.nodes);
	return {
		pairings: structuredClone(ctx.pairings()),
		catchment: catchment ? structuredClone(catchment) : null,
		units: units.map((u) => structuredClone(u)).sort((a, b) => cmpStr(a.nodeId!, b.nodeId!)),
		catchmentMapMm: m.mapMm,
		catchmentMapFromUnits: m.fromUnits
	};
}
