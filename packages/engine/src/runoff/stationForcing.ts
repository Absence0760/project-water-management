// Rain from rainfall stations (issue #553, engine ≥ 1.91.0, docs/model.md
// §2.4i): one rule for the catchment and for a land unit.
//
//   station day (the main station's checked record has a reading):
//       rain = station × clamp(area MAP ÷ station MAP)   (× 1 with scaleToMap false or a MAP missing)
//   otherwise the patching priority (`patch`, engine ≥ 1.105.0, issue #612;
//   default [CHIRPS]), the first source in order with a value that day:
//     a patch station: its checked reading × clamp(area MAP ÷ its MAP)
//       (× 1 with scaleToMap false; skipped, with a warning, when scaling is
//       on and it has no MAP);
//     CHIRPS, when the area has CHIRPS and the area's pairing against
//       `correctAgainst` (default the main station) isn't refused: the
//       area's CHIRPS × that pairing's factor of the day's month, as is
//       (the factors are fitted against the station's rain × r, so they
//       already carry the area's level; ./stationPairing.ts)
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
import { fromEpochDay, toEpochDay } from '../calendar';
import { cmpStr } from '../order';
import {
	AREAL_RAIN_FACTOR_MAX,
	AREAL_RAIN_FACTOR_MIN,
	AREAL_RAIN_FACTOR_WARN_MAX,
	AREAL_RAIN_FACTOR_WARN_MIN,
	MAP_MM_MAX,
	MAP_MM_MIN,
	outsideArealRainBand,
	DEFAULT_RAIN_PATCH,
	RAIN_PATCH_MAX,
	stationSeriesKey,
	stationPairingKey,
	unitRainSeriesKey,
	type DailySeries,
	type ModelInput,
	type NetworkNode,
	type ProjectSettings,
	type RainStationAssignment,
	type RainStationInputs,
	type RainStationSettings,
	type RainPatchSource,
	type RainStationSummary,
	type StationAreaForcing,
	type StationPairingFit,
	type StationPatchUse
} from '../project';
import { isLandUnit } from './area';
import { fitStationPairing, pairingFactorOn } from './stationPairing';
import { checkedStationRecord, type CheckedStationRecord } from './stationRecord';
import { warn } from '../warningCodes';
import { tailOfSource } from '../forecastTail';
import { rainSourceCodes } from '../rainSourcePeriods';

/** What a day of an area's station forcing read (StationAreaDays.source). */
export const STATION_DAY_SOURCE = { none: 0, station: 1, chirps: 2, fallback: 3, patch: 4 } as const;

const usableMap = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= MAP_MM_MIN && v <= MAP_MM_MAX ? v : null);
const reading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const clampFactor = (k: number) => Math.min(AREAL_RAIN_FACTOR_MAX, Math.max(AREAL_RAIN_FACTOR_MIN, k));
const fmt = (k: number) => (Math.round(k * 1000) / 1000).toString();
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

/**
 * A stored patching priority as the engine runs it (issue #612): absent or
 * null = [CHIRPS] (the rule before); not a list = [CHIRPS] with a warning;
 * an entry that isn't a source, a second CHIRPS, a station listed twice or
 * the main station dropped with a warning; past RAIN_PATCH_MAX the rest
 * dropped with a warning.
 */
export function resolvePatch(raw: unknown, mainStationId: string, where: string, warnings: string[]): RainPatchSource[] {
	if (raw === null || raw === undefined) return DEFAULT_RAIN_PATCH.map((x) => ({ ...x }));
	if (!Array.isArray(raw)) {
		warnings.push(`rain stations: ${where}'s patching priority isn't a list, so its gaps take the corrected CHIRPS alone`);
		return DEFAULT_RAIN_PATCH.map((x) => ({ ...x }));
	}
	const out: RainPatchSource[] = [];
	const seen = new Set<string>();
	for (const e of raw) {
		const x = e as Partial<{ source: string; stationId: unknown }> | null;
		const key = x && typeof x === 'object' ? (x.source === 'chirps' ? 'chirps' : x.source === 'station' && isId(x.stationId) ? `station:${x.stationId}` : null) : null;
		if (key === null) {
			warnings.push(`rain stations: ${where}'s patching priority has an entry that is neither a station nor CHIRPS, so it is skipped`);
			continue;
		}
		if (key === `station:${mainStationId}`) {
			warnings.push(`rain stations: ${where}'s patching priority lists its main station, so that entry is skipped`);
			continue;
		}
		if (seen.has(key)) {
			warnings.push(`rain stations: ${where}'s patching priority lists ${key === 'chirps' ? 'CHIRPS' : `the station ${(x as { stationId: string }).stationId}`} twice, so the second is skipped`);
			continue;
		}
		if (out.length >= RAIN_PATCH_MAX) {
			warnings.push(`rain stations: ${where}'s patching priority lists more than ${RAIN_PATCH_MAX} sources, so the rest are skipped`);
			break;
		}
		seen.add(key);
		out.push(key === 'chirps' ? { source: 'chirps' } : { source: 'station', stationId: (x as { stationId: string }).stationId });
	}
	return out;
}

/** One assignment as the engine runs it, or null (with a warning) when it can't be one. */
function resolveAssignment(raw: unknown, where: string, warnings: string[]): RainStationAssignment | null {
	const a = raw as Partial<RainStationAssignment> | null;
	if (!a || typeof a !== 'object' || Array.isArray(a) || !isId(a.stationId)) {
		warnings.push(`rain stations: ${where} names no station, so it is ignored`);
		return null;
	}
	if (a.scaleToMap !== undefined && typeof a.scaleToMap !== 'boolean') warnings.push(`rain stations: ${where}'s scaleToMap isn't true or false; scaling to MAP`);
	if (a.correctAgainst != null && !isId(a.correctAgainst)) warnings.push(`rain stations: ${where}'s correctAgainst isn't a station id; correcting against its own station`);
	return {
		stationId: a.stationId,
		scaleToMap: typeof a.scaleToMap === 'boolean' ? a.scaleToMap : true,
		correctAgainst: isId(a.correctAgainst) ? a.correctAgainst : a.stationId,
		patch: resolvePatch(a.patch, a.stationId, where, warnings)
	};
}

/** An assignment's patching priority as run: its resolved `patch`, else the default (an assignment that didn't pass through resolveRainStations). */
export const patchOf = (a: Pick<RainStationAssignment, 'patch'> | null | undefined): readonly RainPatchSource[] => (Array.isArray(a?.patch) ? a.patch : DEFAULT_RAIN_PATCH);

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
		warnings.push('rain stations: the setting is not an object, so it is ignored');
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

/** The settings with `factors` (stationPairingKey → 12) pinned over the stored pinnedFactors (a resumed run's, PreparedFits.stationFactors). */
export function withPinnedStationFactors(settings: ProjectSettings, factors: Readonly<Record<string, number[]>> | null | undefined): ProjectSettings {
	if (!settings.rainStations || !factors || !Object.keys(factors).length) return settings;
	return { ...settings, rainStations: { ...settings.rainStations, pinnedFactors: { ...(settings.rainStations.pinnedFactors ?? {}), ...structuredClone(factors) } } };
}

// ---------------------------------------------------------------------------
// Records and pairings, once per station per run
// ---------------------------------------------------------------------------

/**
 * Each station's checked record, computed once per run and shared by the
 * catchment and every unit, and each (correcting station, area) pairing,
 * fitted once per run (so their warnings come once). The pairings used are
 * summary.stations.pairings.
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
	/**
	 * The pairing of station `id` with an area's CHIRPS (a land unit's node id,
	 * or null for the catchment), fitted once and recorded as used. The area's
	 * ratio to the station is its assignment's scaling (scaleToMap) of the
	 * area's MAP ÷ the station's.
	 */
	pairing(id: string, areaId: string | null): StationPairingFit;
	/** Every pairing used so far, station-id order, then the catchment, then units in node-id order. */
	pairings(): StationPairingFit[];
}

export function stationContext(args: { settings: ProjectSettings; series: ModelInput['series']; stations: RainStationInputs | null | undefined; nodes: readonly NetworkNode[] }, warnings: string[]): StationContext {
	const stations = args.stations ?? {};
	const records = new Map<string, CheckedStationRecord | null>();
	const fits = new Map<string, StationPairingFit>();
	const map = (id: string) => {
		const mapMm = usableMap(stations[id]?.mapMm);
		return { mapMm, mapSource: mapMm !== null && typeof stations[id]?.mapSource === 'string' ? stations[id]!.mapSource : null };
	};
	const isGauge = (id: string) => stations[id]?.isCatchmentGauge === true;
	const name = (id: string) => (typeof stations[id]?.name === 'string' && stations[id]!.name ? stations[id]!.name : id);
	return {
		settings: args.settings,
		series: args.series,
		stations,
		nodes: args.nodes,
		name,
		map,
		record: (id) => {
			if (!records.has(id)) {
				const r = checkedStationRecord(args.settings, args.series, id, { name: name(id), isCatchmentGauge: isGauge(id) });
				if (r) warnings.push(...r.warnings);
				records.set(id, r);
			}
			return records.get(id)!;
		},
		pairing: (id, areaId) => {
			const key = stationPairingKey(id, areaId);
			if (!fits.has(key)) {
				const rs = args.settings.rainStations;
				const node = areaId === null ? null : args.nodes.find((n) => n.id === areaId);
				const a = areaId === null ? rs?.catchment : rs?.units?.[areaId];
				const areaMap = areaId === null ? catchmentMapOf(rs, args.nodes).mapMm : usableMap(node?.mapMm);
				const ratio = stationRatio(areaMap, map(id).mapMm, a?.scaleToMap !== false).ratio;
				const chirps = (args.series as Record<string, DailySeries | undefined>)[areaId === null ? 'rain_chirps_mm' : unitRainSeriesKey('rain_chirps_mm', areaId)] ?? null;
				fits.set(key, fitStationPairing({ settings: args.settings, series: args.series, stations, stationId: id, area: { id: areaId, name: node?.name ?? areaId ?? 'the catchment', chirps, ratio } }, warnings));
			}
			return fits.get(key)!;
		},
		pairings: () => [...fits.values()].sort((a, b) => cmpStr(a.stationId, b.stationId) || (a.areaId == null ? -1 : b.areaId == null ? 1 : cmpStr(a.areaId, b.areaId)))
	};
}

/** The factors of every pairing used and not refused, by stationPairingKey, for a snapshot to pin (PreparedFits.stationFactors). */
export function pairingFactors(ctx: StationContext | null | undefined): Record<string, number[]> {
	const out: Record<string, number[]> = {};
	for (const p of ctx?.pairings() ?? []) if (p.refused === null && p.months.length === 12) out[stationPairingKey(p.stationId, p.areaId ?? null)] = p.months.map((m) => m.factor);
	return out;
}

/**
 * Fit every pairing settings.rainStations names (the catchment's and each
 * land unit's in `nodes`, against its correctAgainst, when its patching
 * priority has CHIRPS), so a pinned copy (an outlook member, an ensemble
 * member) holds them all.
 */
export function fitEveryPairing(ctx: StationContext): void {
	const rs = ctx.settings.rainStations;
	if (!rs) return;
	const chirps = (a: RainStationAssignment) => patchOf(a).some((x) => x.source === 'chirps');
	if (rs.catchment && chirps(rs.catchment)) ctx.pairing(rs.catchment.correctAgainst ?? rs.catchment.stationId, null);
	const ids = new Set(ctx.nodes.map((n) => n.id));
	for (const id of Object.keys(rs.units ?? {}).sort(cmpStr)) {
		const a = rs.units![id]!;
		if (ids.has(id) && chirps(a)) ctx.pairing(a.correctAgainst ?? a.stationId, id);
	}
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

/** One link of an area's patching priority over a window (stationAreaDays). */
export type PatchLink =
	/** A patch station's checked readings already × its ratio; null = skipped (gives no day). */
	| { kind: 'station'; values: readonly (number | null)[] | null }
	/** The area's CHIRPS and the pairing correcting it (null or refused: gives no day). */
	| { kind: 'chirps'; chirps: readonly (number | null)[] | null; pairing: StationPairingFit | null };

/** An area's station rule over a window, before its next fallback. */
export interface StationAreaDays {
	/** The rain on station, patch and CHIRPS days (mm, the value as computed: not floored); null on the days the next fallback takes. */
	values: (number | null)[];
	/** STATION_DAY_SOURCE per day: station, patch (a patch station), chirps, or none (left to the next fallback). */
	source: Uint8Array;
	/** The index in the patching priority of the source that gave a patch or CHIRPS day; −1 on the others. */
	patchIndex: Int8Array;
}

/**
 * The station rule on each day (see the header): the main station × ratio on
 * its days, else the first link of `chain` with a value (a patch station's
 * scaled reading, or the area's CHIRPS × the pairing's factor of the day's
 * month, no ratio), else null. Without `chain`, the chain is [CHIRPS] of
 * `chirps` and `pairing` (the rule before issue #612).
 */
export function stationAreaDays(a: {
	start: number;
	days: number;
	station: readonly (number | null)[];
	ratio: number;
	chain?: readonly PatchLink[];
	chirps?: readonly (number | null)[] | null;
	pairing?: StationPairingFit | null;
}): StationAreaDays {
	const values = new Array<number | null>(a.days).fill(null);
	const source = new Uint8Array(a.days);
	const patchIndex = new Int8Array(a.days).fill(-1);
	const chain = a.chain ?? [{ kind: 'chirps', chirps: a.chirps ?? null, pairing: a.pairing ?? null }];
	const links = chain.map((l) =>
		l.kind === 'station'
			? { station: l.values, chirps: null, pairing: null }
			: { station: null, chirps: l.chirps, pairing: l.chirps && l.pairing && l.pairing.refused === null && l.pairing.months.length === 12 ? l.pairing : null }
	);
	for (let t = 0; t < a.days; t++) {
		const s = a.station[t];
		if (s != null) {
			values[t] = s * a.ratio;
			source[t] = STATION_DAY_SOURCE.station;
			continue;
		}
		for (let i = 0; i < links.length; i++) {
			const l = links[i]!;
			if (l.station) {
				const v = l.station[t];
				if (v == null) continue;
				values[t] = v;
				source[t] = STATION_DAY_SOURCE.patch;
				patchIndex[t] = i;
				break;
			}
			if (!l.pairing) continue;
			const c = l.chirps![t];
			if (c == null) continue;
			const k = pairingFactorOn(l.pairing, a.start + t);
			if (k === null) continue;
			values[t] = c * k;
			source[t] = STATION_DAY_SOURCE.chirps;
			patchIndex[t] = i;
			break;
		}
	}
	return { values, source, patchIndex };
}

/** One source of an area's patching priority, resolved for a run: a station with its ratio (or why it is skipped), or CHIRPS. */
export type ResolvedPatch =
	| { source: 'station'; stationId: string; stationMapMm: number | null; ratio: number; ownRatio: number | null; clamped: boolean; skipped: string | null }
	| { source: 'chirps' };

/**
 * An area's patching priority for a run (issue #612): each station with its
 * ratio to the area (as the main station's: area MAP ÷ its MAP, clamped,
 * × 1 without scaling or without the area's MAP), skipped with a warning
 * when it has no record in the input or, under scaling, no MAP of its own.
 */
export function resolvePatchSources(ctx: StationContext, a: RainStationAssignment, area: string, areaMapMm: number | null, warnings: string[]): ResolvedPatch[] {
	const scaleToMap = a.scaleToMap !== false;
	return patchOf(a).map((p): ResolvedPatch => {
		if (p.source === 'chirps') return { source: 'chirps' };
		const m = ctx.map(p.stationId).mapMm;
		const r = stationRatio(areaMapMm, m, scaleToMap);
		const skipped =
			p.stationId === a.stationId
				? 'it is the main station'
				: !ctx.record(p.stationId)
					? 'it has no record in this run’s input'
					: scaleToMap && m === null
						? 'it has no MAP to scale its rain to the area’s MAP by'
						: null;
		if (skipped) warnings.push(`station: ${area}’s patch station "${ctx.name(p.stationId)}" is skipped: ${skipped}`);
		else warnings.push(...ratioWarnings(area, ctx.name(p.stationId), areaMapMm, m, r, scaleToMap && m !== null, null));
		return { source: 'station', stationId: p.stationId, stationMapMm: m, ratio: r.ratio, ownRatio: r.ownRatio, clamped: r.clamped, skipped };
	});
}

/** The chain links of resolved patch sources over a window (stationAreaDays' `chain`). */
export function patchLinks(ctx: StationContext, patch: readonly ResolvedPatch[], start: number, days: number, chirps: readonly (number | null)[] | null, pairing: StationPairingFit | null): PatchLink[] {
	return patch.map((p): PatchLink => {
		if (p.source === 'chirps') return { kind: 'chirps', chirps, pairing };
		if (p.skipped) return { kind: 'station', values: null };
		return { kind: 'station', values: alignReadings(ctx.record(p.stationId)?.record, start, days).map((v) => (v === null ? null : v * p.ratio)) };
	});
}

/**
 * Whether a station can patch an area's main station over a window (issue
 * #612; pure): unusable, with the reason, when it is the main station, has
 * no record, has no MAP while scaling is on, or has a reading on none of the
 * main station's gap days; always with the main station's gap days in the
 * window, how many of them it has a reading on, and its record's span.
 *
 * The window is the run's history: its first `historyDays` days (forecastTail;
 * all of them by default). A forecast tail day is never patched (the run reads
 * the forecast there, after the last day any other source has rain), so it
 * isn't counted as a gap a patch station could fill.
 */
export interface StationPatchUsability {
	usable: boolean;
	reason: string | null;
	gapDays: number;
	fills: number;
	from: string | null;
	to: string | null;
	/** The days counted (the run's history), with `startDate`; null without it or when the window is empty. */
	windowFrom: string | null;
	windowTo: string | null;
	/** The forecast tail days after the window, left out of the count (0 without a tail). */
	forecastDays: number;
}

/** "in the run window", or "before the forecast" when a forecast tail is left out. */
const gapWindowText = (forecastDays: number) => (forecastDays > 0 ? 'before the forecast' : 'in the run window');

export function stationPatchUsability(a: {
	main: readonly (number | null)[];
	patch: readonly (number | null)[] | null;
	isMain?: boolean;
	scaleToMap: boolean;
	stationMapMm: number | null;
	record?: DailySeries | null;
	/** The run's history days (forecastTail(prep).historyDays); absent = every day of `main`. */
	historyDays?: number;
	/** The run day of `main[0]`, ISO, for the window's dates. */
	startDate?: string;
}): StationPatchUsability {
	let gapDays = 0;
	let fills = 0;
	const hist = Math.max(0, Math.min(a.main.length, a.historyDays ?? a.main.length));
	const forecastDays = a.main.length - hist;
	for (let t = 0; t < hist; t++) {
		if (a.main[t] != null) continue;
		gapDays++;
		if (a.patch?.[t] != null) fills++;
	}
	let from: string | null = null;
	let to: string | null = null;
	if (a.record) {
		const d0 = toEpochDay(a.record.startDate);
		const i = a.record.values.findIndex(reading);
		let j = a.record.values.length - 1;
		while (j >= 0 && !reading(a.record.values[j])) j--;
		if (i >= 0) {
			from = fromEpochDay(d0 + i);
			to = fromEpochDay(d0 + j);
		}
	}
	const win = gapWindowText(forecastDays);
	const reason = a.isMain
		? 'it is the main station'
		: !a.patch
			? 'it has no record'
			: a.scaleToMap && a.stationMapMm === null
				? 'it has no MAP to scale its rain by'
				: fills === 0
					? gapDays === 0
						? `the main station has no gap ${win}`
						: `it has no reading on any of the main station’s ${gapDays} gap ${gapDays === 1 ? 'day' : 'days'} ${win}`
					: null;
	const d0 = a.startDate ? toEpochDay(a.startDate) : null;
	const windowFrom = d0 !== null && hist > 0 ? fromEpochDay(d0) : null;
	const windowTo = d0 !== null && hist > 0 ? fromEpochDay(d0 + hist - 1) : null;
	return { usable: reason === null, reason, gapDays, fills, from, to, windowFrom, windowTo, forecastDays };
}

/**
 * The run's record of a resolved patching priority (StationAreaForcing.patches): each source's days and, for a
 * station, its fill of the main station's gaps over the run's history (its first `historyDays` days: a forecast
 * tail day is never patched).
 */
export function patchUses(
	ctx: StationContext,
	patch: readonly ResolvedPatch[],
	links: readonly PatchLink[],
	main: readonly (number | null)[],
	d: StationAreaDays,
	scaleToMap: boolean,
	historyDays: number = main.length
): StationPatchUse[] {
	const counts = new Array<number>(patch.length).fill(0);
	for (let t = 0; t < d.patchIndex.length; t++) if (d.patchIndex[t]! >= 0) counts[d.patchIndex[t]!]!++;
	return patch.map((p, i): StationPatchUse => {
		if (p.source === 'chirps') return { source: 'chirps', days: counts[i]! };
		const l = links[i] as Extract<PatchLink, { kind: 'station' }>;
		const u = stationPatchUsability({ main, patch: l.values, scaleToMap, stationMapMm: p.stationMapMm, historyDays });
		return {
			source: 'station',
			stationId: p.stationId,
			stationName: ctx.name(p.stationId),
			stationMapMm: p.stationMapMm,
			ownRatio: p.ownRatio,
			ratio: p.ratio,
			clamped: p.clamped,
			skipped: p.skipped,
			gapDays: u.gapDays,
			fills: u.fills,
			...(u.forecastDays > 0 ? { forecastDays: u.forecastDays } : {}),
			days: counts[i]!
		};
	});
}

/** A warning for each used patch station that fills none of the main station's gaps in the window (it changes nothing). */
export function idlePatchWarnings(area: string, uses: readonly StationPatchUse[]): string[] {
	return uses.flatMap((u) =>
		u.source === 'station' && !u.skipped && u.fills === 0 && u.gapDays > 0
			? [
					`station: ${area}’s patch station "${u.stationName}" has no reading on any of the main station’s ${u.gapDays} gap ${u.gapDays === 1 ? 'day' : 'days'} ${gapWindowText(u.forecastDays ?? 0)}, so it fills none`
				]
			: []
	);
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
export function stationDayCounts(source: ArrayLike<number>, fallback: (t: number) => boolean): Required<StationAreaForcing['days']> {
	const days = { station: 0, patch: 0, chirps: 0, fallback: 0, none: 0 };
	for (let t = 0; t < source.length; t++) {
		const s = source[t];
		if (s === STATION_DAY_SOURCE.station) days.station++;
		else if (s === STATION_DAY_SOURCE.patch) days.patch++;
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
	/** The patching priority resolved for the run (issue #612). */
	patch: ResolvedPatch[];
	/** The checked station record (its whole span). */
	record: DailySeries;
	map: ReturnType<typeof catchmentMapOf>;
	stationMap: { mapMm: number | null; mapSource: string | null };
	ratio: ReturnType<typeof stationRatio>;
	/** The catchment's pairing against correctAgainst; null when the patching priority has no CHIRPS (none fitted). */
	pairing: StationPairingFit | null;
}

/**
 * The catchment's station for a run, or null when settings.rainStations has
 * no catchment assignment (the catchment rain as before, bit for bit) or its
 * station has no record in the input (a warning: the catchment rain as
 * before). Fits the pairing it corrects against when its patching priority has CHIRPS.
 */
export function catchmentStationPlan(ctx: StationContext, warnings: string[]): CatchmentStationPlan | null {
	const a = ctx.settings.rainStations?.catchment;
	if (!a) return null;
	const stationId = a.stationId;
	const rec = ctx.record(stationId);
	if (!rec) {
		warnings.push(
			warn('rain.station.noRecord', { station: stationId, where: 'catchment' }, `station: the catchment’s station "${ctx.name(stationId)}" has no record in this run’s input, so the catchment rain is read as without a station`)
		);
		return null;
	}
	const scaleToMap = a.scaleToMap !== false;
	const correctAgainst = a.correctAgainst ?? stationId;
	const map = catchmentMapOf(ctx.settings.rainStations, ctx.nodes);
	const stationMap = ctx.map(stationId);
	const ratio = stationRatio(map.mapMm, stationMap.mapMm, scaleToMap);
	const why = map.missing.length ? `the catchment MAP is the units’ area-weighted mean, and ${map.missing.map((n) => `"${n}"`).join(', ')} ${map.missing.length === 1 ? 'has' : 'have'} no MAP` : 'the catchment has no MAP (no unit with land, and none entered)';
	warnings.push(...ratioWarnings('the catchment', ctx.name(stationId), map.mapMm, stationMap.mapMm, ratio, scaleToMap, why));
	const patch = resolvePatchSources(ctx, a, 'the catchment', map.mapMm, warnings);
	const pairing = patch.some((p) => p.source === 'chirps') ? ctx.pairing(correctAgainst, null) : null;
	return { ctx, assignment: { stationId, scaleToMap, correctAgainst }, patch, record: rec.record, map, stationMap, ratio, pairing };
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
 * returns for `rain_catchment_mm` (station × ratio on its days, a patch
 * station × its ratio on the days it patches, else null) and
 * `rain_chirps_mm` (the catchment CHIRPS × the pairing's factors on the days
 * CHIRPS patches; as stored on station and patch days; null on days nothing
 * patches, so they fall to the forecast), with the day codes, the summary
 * and the warnings about the patch stations.
 */
export function catchmentStationForcing(
	plan: CatchmentStationPlan,
	start: number,
	days: number,
	chirps: readonly (number | null)[],
	forecast: readonly (number | null)[]
): { catchment: (number | null)[]; chirps: (number | null)[]; days: StationAreaDays; forcing: StationAreaForcing; warnings: string[] } {
	const ctx = plan.ctx;
	const main = alignReadings(plan.record, start, days);
	const links = patchLinks(ctx, plan.patch, start, days, chirps, plan.pairing);
	const d = stationAreaDays({ start, days, station: main, ratio: plan.ratio.ratio, chain: links });
	const catchment = new Array<number | null>(days).fill(null);
	const ch = new Array<number | null>(days).fill(null);
	for (let t = 0; t < days; t++) {
		// A patch station's day is station rain at the catchment's level, as the main station's is.
		if (d.source[t] === STATION_DAY_SOURCE.station || d.source[t] === STATION_DAY_SOURCE.patch) {
			catchment[t] = d.values[t]!;
			ch[t] = chirps[t] ?? null;
		} else if (d.source[t] === STATION_DAY_SOURCE.chirps) ch[t] = d.values[t]!;
	}
	const id = plan.assignment.stationId;
	// The fill counts cover the run's history: the forecast tail the run will find in this rain (forecastTail, as
	// prepareRun reads it under a catchment station: no rain-source periods and no gap-filling product).
	const { historyDays } = tailOfSource(rainSourceCodes(catchment, ch, forecast), days);
	const patches = patchUses(ctx, plan.patch, links, main, d, plan.assignment.scaleToMap, historyDays);
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
			correctedBy: plan.pairing && plan.pairing.refused === null ? plan.pairing.stationId : null,
			days: stationDayCounts(d.source, (t) => forecast[t] != null),
			setAside: setAsideInWindow(ctx, id, start, days),
			patches
		},
		warnings: idlePatchWarnings('the catchment', patches)
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
	/** The unit's pairing's 12 factors (calendar months); null when refused or when the patching priority has no CHIRPS (its gaps fall to the next fallback). */
	factors: number[] | null;
	/** The patching priority resolved for the run (issue #612); absent on a recipe from before, which ran [CHIRPS]. */
	patch?: ResolvedPatch[];
}

/**
 * A land unit's station recipe, or null with a warning when its station has
 * no record in the input (the unit keeps the §2.4h chain).
 */
export function unitStationRecipe(ctx: StationContext, node: NetworkNode, a: RainStationAssignment, warnings: string[]): UnitStationRecipe | null {
	const stationId = a.stationId;
	if (!ctx.record(stationId)) {
		warnings.push(
			warn('rain.station.noRecord', { station: stationId, where: 'unit', unit: node.id }, `station: "${node.name}"’s station "${ctx.name(stationId)}" has no record in this run’s input, so the unit keeps its own rain rule`)
		);
		return null;
	}
	const scaleToMap = a.scaleToMap !== false;
	const correctAgainst = a.correctAgainst ?? stationId;
	const stationMap = ctx.map(stationId);
	const unitMap = usableMap(node.mapMm);
	const r = stationRatio(unitMap, stationMap.mapMm, scaleToMap);
	warnings.push(...ratioWarnings(`"${node.name}"`, ctx.name(stationId), unitMap, stationMap.mapMm, r, scaleToMap, null));
	const patch = resolvePatchSources(ctx, a, `"${node.name}"`, unitMap, warnings);
	const p = patch.some((x) => x.source === 'chirps') ? ctx.pairing(correctAgainst, node.id) : null;
	return {
		stationId,
		correctAgainst,
		scaleToMap,
		stationMapMm: stationMap.mapMm,
		ratio: r.ratio,
		ownRatio: r.ownRatio,
		clamped: r.clamped,
		factors: p && p.refused === null && p.months.length === 12 ? p.months.map((m) => m.factor) : null,
		patch
	};
}

/** A recipe's patching priority: its own, or [CHIRPS] for a recipe from before issue #612. */
export const recipePatch = (r: UnitStationRecipe): readonly ResolvedPatch[] => r.patch ?? [{ source: 'chirps' }];

/** The pairing a unit recipe's factors stand for (pinned ones read as a fit of those factors); null when its patching priority has no CHIRPS. */
export function recipePairing(ctx: StationContext, r: UnitStationRecipe, unitId: string): StationPairingFit | null {
	if (!recipePatch(r).some((x) => x.source === 'chirps')) return null;
	const fit = ctx.pairing(r.correctAgainst, unitId);
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
