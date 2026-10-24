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
	fromEpochDay,
	monthOfEpochDay,
	prepareRun,
	stationAreaRain,
	stationSeriesKey,
	toEpochDay,
	unitRainSeriesKey,
	type DailySeries,
	type ModelInput,
	type StationAreaForcing,
	type StationRainDaySource
} from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';

export interface AreaRainLines {
	/** The run window's first day; every line below covers the window, one value a day. */
	startDate: string;
	/** The rain the run reads (mm; 0 on a dry day). */
	rainUsed: number[];
	source: StationRainDaySource[];
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

/**
 * The lines of the catchment (`nodeId` null) or a land unit under its station,
 * over the run window; null when the area has no station in this input (no
 * assignment, its station has no record, or, for a unit, per-unit rain off).
 */
export function areaRainLines(input: ModelInput, nodeId: string | null): AreaRainLines | null {
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
	const pairing = prepareRun(input).stations?.context.pairing(correctAgainst) ?? null;
	const factors = pairing && pairing.refused === null && pairing.months.length === 12 ? pairing.months.map((m) => m.factor) : null;
	const chirpsCorrected = chirpsRaw && factors ? chirpsRaw.map((v, t) => (v === null ? null : v * factors[monthOfEpochDay(start + t) - 1]!)) : null;
	return {
		startDate: r.startDate,
		rainUsed: r.rainMm,
		source: r.source,
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

/** The days by source, as the run counts them (StationAreaForcing.days). */
export function sourceCounts(source: readonly StationRainDaySource[]): Record<StationRainDaySource, number> {
	const n: Record<StationRainDaySource, number> = { station: 0, chirps: 0, fallback: 0, none: 0 };
	for (const s of source) n[s]++;
	return n;
}

/** The chart's source strip: one lane per source other than the station (the default, no strip), with its days in words. */
export interface SourceLane {
	label: string;
	color: string;
	ranges: { start: string; end: string }[];
	text: string;
}

const SOURCE_LANES: readonly { source: Exclude<StationRainDaySource, 'station'>; label: string; color: string; what: string }[] = [
	{ source: 'chirps', label: 'Corrected CHIRPS', color: '--series-9', what: 'corrected CHIRPS (the station has no reading, or it was set aside)' },
	{ source: 'fallback', label: 'Next fallback', color: '--series-10', what: 'the next fallback (no corrected CHIRPS that day)' },
	{ source: 'none', label: 'No rain', color: '--text-muted', what: 'no rain from any source (read as dry)' }
];

export function sourceLanes(startDate: string, source: readonly StationRainDaySource[]): SourceLane[] {
	const d0 = toEpochDay(startDate);
	const out: SourceLane[] = [];
	for (const l of SOURCE_LANES) {
		const ranges: { start: string; end: string }[] = [];
		let days = 0;
		for (let t = 0; t < source.length; t++) {
			if (source[t] !== l.source) continue;
			days++;
			const last = ranges[ranges.length - 1];
			const iso = fromEpochDay(d0 + t);
			if (last && toEpochDay(last.end) === d0 + t - 1) last.end = iso;
			else ranges.push({ start: iso, end: iso });
		}
		if (days) out.push({ label: l.label, color: l.color, ranges, text: `${fmtNum(days)} ${days === 1 ? 'day' : 'days'} from ${l.what}` });
	}
	return out;
}

/** One line of what the run read, in words: "4,018 days from the station, 312 from corrected CHIRPS, 2 from the next fallback." */
export function sourceSummary(source: readonly StationRainDaySource[]): string {
	const n = sourceCounts(source);
	const day = (k: number) => `${fmtNum(k)} ${k === 1 ? 'day' : 'days'}`;
	const parts = [`${day(n.station)} from the station`];
	if (n.chirps) parts.push(`${fmtNum(n.chirps)} from corrected CHIRPS`);
	if (n.fallback) parts.push(`${fmtNum(n.fallback)} from the next fallback`);
	if (n.none) parts.push(`${fmtNum(n.none)} with no rain from any source`);
	return `${parts.join(', ')}.`;
}
