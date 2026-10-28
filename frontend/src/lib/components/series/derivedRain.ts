// An area's rain under its rainfall station, for the Data tab (issue #553
// round 5, docs/ui.md § Data, docs/model.md §2.4i): the lines behind the rain
// a run reads for the catchment (Fragmentation's average catchment rainfall)
// or a land unit (per-unit rain): the station as recorded, the station × the
// MAP ratio, the area's CHIRPS as stored and corrected by the pairing's
// monthly factors, and the rain used with each day's source.
//
// Computed when viewed, never stored, from the engine's own code over the
// input a run would read (GET /projects/:id/model-input): the rain used and
// its sources are the engine's stationAreaRain (the run's rain_unit /
// rain_used, to the bit), the factors are the pairing the run fits
// (prepareRun's station context), the ratio the run's forcing records. The
// only arithmetic here is the two products a run makes the same way: station
// × ratio and CHIRPS × the factor of the day's month. Pure: no Svelte, no DOM.
import {
	monthOfEpochDay,
	prepareRun,
	stationAreaRain,
	stationSeriesKey,
	toEpochDay,
	unitAreaRain,
	unitRainSeriesKey,
	type DailySeries,
	type ModelInput,
	type PreparedRun,
	type StationAreaForcing,
	type StationRainDaySource,
	type UnitAreaRain
} from '@water-management/engine';

export interface AreaRainLines {
	/** The run window's first day; every line below covers the window, one value a day. */
	startDate: string;
	/** The rain the run reads (mm; 0 on a dry day). */
	rainUsed: number[];
	source: StationRainDaySource[];
	/** On a `patch` day (issue #612), its source in words: "patch 1: <station>"; null on the others. */
	patchFrom: (string | null)[];
	/**
	 * Each patch station the run reads for this area (issue #613 slice 3, issue #612), in its patching priority: its
	 * record as stored and × the ratio the run applies to it (this area's MAP ÷ that station's MAP). A source the run
	 * skips (no record, no MAP under scaling) and the CHIRPS entry aren't lines. Absent before engine 1.105.0.
	 */
	patches?: PatchStationLines[];
	/** The station's record as stored (null: no reading). */
	stationRaw: (number | null)[];
	/** The stored record × the ratio the run applies (null: no reading). */
	stationScaled: (number | null)[];
	/** The area's CHIRPS as stored (`rain_chirps_mm` for the catchment, `rain_chirps_mm@<unit>` for a unit); null when it has none. */
	chirpsRaw: (number | null)[] | null;
	/** That CHIRPS × the pairing's factor of the day's month; null when it has none or the pairing is refused. */
	chirpsCorrected: (number | null)[] | null;
	/** The pairing's 12 factors (January first), null when refused or not fitted. */
	factors: number[] | null;
	/** Why the pairing was refused (the engine's words), or null. */
	refused: string | null;
	/** The station the area's CHIRPS is corrected against (its id). */
	correctAgainst: string;
	forcing: StationAreaForcing;
	warnings: string[];
}

/** One patch station's lines for an area (AreaRainLines.patches). */
export interface PatchStationLines {
	/** Its place in the area's patching priority, 1 first (the "patch N" a patched day names; CHIRPS and skipped sources keep their places). */
	place: number;
	stationId: string;
	stationName: string;
	/** This area's MAP ÷ the station's MAP after the clamp, the ratio the run applies (1 with scaling off). */
	ratio: number;
	/** The station's record as stored (null: no reading). */
	raw: (number | null)[];
	/** The stored record × ratio (null: no reading). */
	scaled: (number | null)[];
}

const reading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** `s` over start … start + days − 1, a non-reading as null. */
function align(s: DailySeries | null | undefined, start: number, days: number): (number | null)[] {
	const out = new Array<number | null>(days).fill(null);
	if (!s) return out;
	const off = toEpochDay(s.startDate) - start;
	for (let i = Math.max(0, -off); i < Math.min(s.values.length, days - off); i++) {
		const v = s.values[i];
		out[i + off] = reading(v) ? v : null;
	}
	return out;
}

/** The run preparation the pairings are read from: one per input, shared by every area of it (prepareRun is the costly part). */
export const prepareFor = (input: ModelInput): PreparedRun => prepareRun(input);

/**
 * The lines of the catchment (`nodeId` null) or a land unit under its station,
 * over the run window; null when the area has no station in this input (no
 * assignment, its station has no record, or, for a unit, per-unit rain off).
 * `prep` is prepareFor(input), passed in when several areas are read from one
 * input.
 */
export function areaRainLines(input: ModelInput, nodeId: string | null, prep: PreparedRun = prepareFor(input)): AreaRainLines | null {
	const r = stationAreaRain(input, nodeId);
	if (!r) return null;
	const start = toEpochDay(r.startDate);
	const days = r.rainMm.length;
	const series = input.series as Record<string, DailySeries | undefined>;
	const stationRaw = align(series[stationSeriesKey(r.forcing.stationId)], start, days);
	const stationScaled = stationRaw.map((v) => (v === null ? null : v * r.forcing.ratio));
	const chirpsSeries = nodeId === null ? series.rain_chirps_mm : series[unitRainSeriesKey('rain_chirps_mm', nodeId)];
	const chirpsRaw = chirpsSeries ? align(chirpsSeries, start, days) : null;
	const rs = input.settings.rainStations;
	const a = nodeId === null ? rs?.catchment : rs?.units?.[nodeId];
	const correctAgainst = a?.correctAgainst ?? r.forcing.stationId;
	// The pairing the run fits for this area (prepareRun's station context, the same fit stationAreaRain's run reads).
	// A run pins a unit's factors only from settings.unitRain.pinned / rainStations.pinnedFactors, which are the
	// engine's own (an outlook member, a resumed run) and never stored, so the model input a view reads has none.
	// One per area since engine 1.105.0 (issue #612): fitted against the station's adjusted rain over this area's CHIRPS.
	const pairing = prep.stations?.context.pairing(correctAgainst, nodeId) ?? null;
	const patchName = (id: string) => input.stations?.[id]?.name ?? 'a station no longer in the project';
	const patches: PatchStationLines[] = [];
	(r.forcing.patches ?? []).forEach((p, i) => {
		if (p.source !== 'station' || p.skipped !== null) return;
		const raw = align(series[stationSeriesKey(p.stationId)], start, days);
		patches.push({ place: i + 1, stationId: p.stationId, stationName: p.stationName || patchName(p.stationId), ratio: p.ratio, raw, scaled: raw.map((v) => (v === null ? null : v * p.ratio)) });
	});
	const patchFrom = r.patchStationId.map((id, t) => (id === null ? null : `patch ${r.patchPlace[t]}: ${patchName(id)}`));
	const factors = pairing && pairing.refused === null && pairing.months.length === 12 ? pairing.months.map((m) => m.factor) : null;
	const chirpsCorrected = chirpsRaw && factors ? chirpsRaw.map((v, t) => (v === null ? null : v * factors[monthOfEpochDay(start + t) - 1]!)) : null;
	return {
		startDate: r.startDate,
		rainUsed: r.rainMm,
		source: r.source,
		patchFrom,
		patches,
		stationRaw,
		stationScaled,
		chirpsRaw,
		chirpsCorrected,
		factors,
		refused: pairing?.refused ?? null,
		correctAgainst,
		forcing: r.forcing,
		warnings: r.warnings
	};
}

/**
 * A land unit without a rainfall station under per-unit rain (issue #613 slice 2, docs/model.md §2.4h): the links
 * of its chain (its own gauge after the checks, the catchment gauge × its MAP ratio, its CHIRPS as stored and
 * levelled to its MAP), the rain used and the link each day came from: the engine's unitAreaRain, the run's
 * rain_unit to the bit. Null when per-unit rain is off or the unit is on its station (areaRainLines' then).
 */
export type UnitChainLines = Omit<UnitAreaRain, 'rainMm'> & { /** The rain the run reads (its rain_unit), mm; 0 on a dry day. */ rainUsed: number[] };

export function unitChainLines(input: ModelInput, nodeId: string, prep: PreparedRun = prepareFor(input)): UnitChainLines | null {
	const r = unitAreaRain(input, nodeId, prep);
	if (!r) return null;
	const { rainMm, ...rest } = r;
	return { ...rest, rainUsed: rainMm };
}

/** Whether an area's lines are a §2.4h chain's (a unit without a station) rather than a station's. */
export const isChain = (l: AreaRainLines | UnitChainLines): l is UnitChainLines => 'rule' in l;
