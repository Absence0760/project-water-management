// What a fit records of the catchment's rainfall station (engine ≥ 1.91.0,
// issue #553, docs/model.md §2.4i, §2.10b), apart from ./stationForcing.ts so
// the fit-provenance code the Settings forms load doesn't pull in the
// forcing (issue #9). Pure.
import type { RainStationSettings, RainStationSummary, StationAreaForcing } from '../project';

/**
 * A patching priority as a fingerprint records it (issue #612): `chirps`, or
 * `station:<id>`, in order. A stored setting reads as the engine resolves it
 * (absent / null = ['chirps']; the main station, repeats and entries that
 * aren't a source left out), without the warnings.
 */
export function patchChainOfSetting(raw: unknown, mainStationId: string): string[] {
	if (!Array.isArray(raw)) return ['chirps'];
	const out: string[] = [];
	for (const e of raw) {
		const x = e as { source?: unknown; stationId?: unknown } | null;
		const key = x && typeof x === 'object' ? (x.source === 'chirps' ? 'chirps' : x.source === 'station' && typeof x.stationId === 'string' && x.stationId ? `station:${x.stationId}` : null) : null;
		if (key && key !== `station:${mainStationId}` && !out.includes(key) && out.length < 8) out.push(key);
	}
	return out;
}

/** A run's patching priority (StationAreaForcing.patches) as a fingerprint records it; undefined on a summary from before issue #612. */
export const patchChainOfForcing = (f: Pick<StationAreaForcing, 'patches'>): string[] | undefined => f.patches?.map((p) => (p.source === 'chirps' ? 'chirps' : `station:${p.stationId}`));

const sameChain = (a: readonly string[] | undefined, b: readonly string[] | undefined) => !a || !b || (a.length === b.length && a.every((x, i) => x === b[i]));

/**
 * FitRecord.forcing.catchmentStation: the catchment's station as the fit's
 * rain read it. Absent / null = the catchment rain without a station.
 */
export interface CatchmentStationFingerprint {
	stationId: string;
	scaleToMap: boolean;
	correctAgainst: string;
	/** The catchment MAP the ratio used (null: none, × 1). */
	catchmentMapMm: number | null;
	/** The ratio applied (catchment MAP ÷ station MAP, clamped; 1 without). */
	ratio: number;
	/** The correcting pairing's 12 factors (calendar months); null = refused. */
	factors: number[] | null;
	/**
	 * The pairing was fitted against the station's MAP-adjusted rain over the
	 * catchment's own CHIRPS (engine ≥ 1.105.0, issue #612); absent on a fit
	 * from before, which then reads "Forcing changed since fit".
	 */
	stationFit?: 'adjusted';
	/** The patching priority (patchChainOfSetting's form, engine ≥ 1.105.0); compared only when both sides have it. */
	patch?: string[];
}

/** The catchment station of a run's summary.stations (or a fit's), or null when the catchment had none. */
export function catchmentStationFingerprint(s: Pick<RainStationSummary, 'catchment' | 'pairings' | 'catchmentMapMm'> | null | undefined): CatchmentStationFingerprint | null {
	const c = s?.catchment;
	if (!c) return null;
	const against = c.correctedBy;
	// The catchment's pairing (areaId null since engine 1.105.0; a summary from before has one per station).
	const p = against ? (s!.pairings.find((x) => x.stationId === against && x.areaId === null) ?? s!.pairings.find((x) => x.stationId === against && x.areaId === undefined)) : null;
	const patch = patchChainOfForcing(c);
	return {
		stationId: c.stationId,
		scaleToMap: c.scaleToMap,
		// correctedBy is null when the pairing was refused: record the station it is corrected against all the same.
		correctAgainst: against ?? c.stationId,
		catchmentMapMm: s!.catchmentMapMm,
		ratio: c.ratio,
		factors: p && p.refused === null && p.months.length === 12 ? p.months.map((m) => m.factor) : null,
		...(patch ? { stationFit: 'adjusted' as const, patch } : {})
	};
}

/** Relative tolerance of a factor, the ratio or the catchment MAP (as the unit rain fingerprint's). */
const TOLERANCE = 0.02;
const near = (x: number | null, y: number | null) => (x === null || y === null ? x === y : Math.abs(x - y) <= TOLERANCE * Math.abs(x));

/**
 * Whether two catchment station fingerprints describe different rain: a
 * station on one side only, another station, scaling or correcting station,
 * or the ratio, the catchment MAP or a pairing factor moving by more than 2 %.
 */
export function catchmentStationFingerprintChanged(a: CatchmentStationFingerprint | null | undefined, b: CatchmentStationFingerprint | null | undefined): boolean {
	if (!a || !b) return !a !== !b;
	if (a.stationId !== b.stationId || a.scaleToMap !== b.scaleToMap || a.correctAgainst !== b.correctAgainst) return true;
	// The pairing rule's marker on one side only (a fit from before engine 1.105.0), or another patching priority.
	if (a.stationFit !== b.stationFit || !sameChain(a.patch, b.patch)) return true;
	if (!near(a.ratio, b.ratio) || !near(a.catchmentMapMm, b.catchmentMapMm)) return true;
	if (!a.factors || !b.factors) return !a.factors !== !b.factors;
	return a.factors.length !== b.factors.length || a.factors.some((k, m) => !near(k, b.factors![m]!));
}

/**
 * Whether settings.rainStations.catchment differs from what a fit recorded
 * (the Settings form, which has no run): a station on one side only, or
 * another station, scaling or correcting station. The ratio, the MAP and
 * the factors come from the records, so a run's own fingerprint compares
 * those.
 */
export function catchmentStationSettingChanged(now: RainStationSettings | null | undefined, then: CatchmentStationFingerprint | null | undefined): boolean {
	const a = now && typeof now === 'object' ? now.catchment : null;
	const on = !!a && typeof a.stationId === 'string' && a.stationId.length > 0;
	if (!on || !then) return on !== !!then;
	return (
		a!.stationId !== then.stationId ||
		(a!.scaleToMap !== false) !== then.scaleToMap ||
		(a!.correctAgainst ?? a!.stationId) !== then.correctAgainst ||
		!sameChain(patchChainOfSetting(a!.patch, a!.stationId), then.patch)
	);
}

/** Why a stored FitRecord.forcing.catchmentStation can't be one, or null (for the API's fit-record validation). */
export function catchmentStationFingerprintError(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) return 'not a catchment station fingerprint';
	const r = raw as Partial<CatchmentStationFingerprint>;
	const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200;
	const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
	if (!id(r.stationId) || !id(r.correctAgainst)) return 'the station and the correcting station need ids';
	if (typeof r.scaleToMap !== 'boolean') return 'scaleToMap must be true or false';
	if (!(r.catchmentMapMm === null || num(r.catchmentMapMm)) || !num(r.ratio)) return 'a bad catchment MAP or ratio';
	if (!(r.factors === null || (Array.isArray(r.factors) && r.factors.length === 12 && r.factors.every(num)))) return 'factors must be 12 numbers or null';
	if (r.stationFit !== undefined && r.stationFit !== 'adjusted') return 'a bad pairing rule marker';
	if (r.patch !== undefined && !(Array.isArray(r.patch) && r.patch.length <= 8 && r.patch.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 210))) return 'a bad patching priority';
	const known = new Set(['stationId', 'scaleToMap', 'correctAgainst', 'catchmentMapMm', 'ratio', 'factors', 'stationFit', 'patch']);
	if (Object.keys(r).some((k) => !known.has(k))) return 'an unknown field';
	return null;
}
