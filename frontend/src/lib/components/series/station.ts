// A rainfall station's details in the Data tab's Series details (issue #553,
// docs/ui.md § Data): a catchment rain series with no site is a station, with
// its own MAP and that MAP's source, and optionally where it stands. Editors
// edit them as one draft saved together, since the engine's rainStationError
// judges them together (a MAP needs its source; coordinates both or neither).
// Add data's station fields are stationInput.ts.
import { MAP_MM_MAX, MAP_MM_MIN, rainStationError, type RainStationMeta, type SeriesMeta } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** Whether a series is a rainfall station: catchment rain, measured at no site (a gauge's or a unit's own rain is not). */
export const asksStation = (s: Pick<SeriesMeta, 'kind' | 'siteNodeId'>) => s.kind === 'rain_catchment_mm' && !s.siteNodeId;

/** The form's draft: numbers or null (empty), the source as typed. */
export interface StationDraft {
	mapMm: number | null;
	mapSource: string;
	lat: number | null;
	lon: number | null;
}

export function stationDraft(station: RainStationMeta | null | undefined): StationDraft {
	return { mapMm: station?.mapMm ?? null, mapSource: station?.mapSource ?? '', lat: station?.lat ?? null, lon: station?.lon ?? null };
}

/**
 * What the PATCH sends: the station, or null once every field is empty. A
 * source without a MAP goes with it (a source names a MAP), and the source is
 * trimmed.
 */
export function stationFromDraft(d: StationDraft): RainStationMeta | null {
	const mapMm = d.mapMm;
	const mapSource = mapMm === null ? null : d.mapSource.trim() || null;
	if (mapMm === null && d.lat === null && d.lon === null) return null;
	return { mapMm, mapSource, lat: d.lat, lon: d.lon };
}

/** Whether the draft differs from what is stored. */
export function stationChanged(d: StationDraft, stored: RainStationMeta | null | undefined): boolean {
	const a = stationFromDraft(d);
	const b = stored ? stationFromDraft(stationDraft(stored)) : null;
	return JSON.stringify(a) !== JSON.stringify(b);
}

/** The draft's first problem and the field it is fixed in (rainStationError, the API's rule, in the form's words); null when it can be saved. */
export function stationProblem(d: StationDraft): { field: 'map' | 'source' | 'coords'; message: string } | null {
	const station = stationFromDraft(d);
	if (!station) return null;
	const e = rainStationError(station);
	if (!e) return null;
	const mm = station.mapMm;
	const mapBad = mm !== null && !(Number.isFinite(mm) && mm >= MAP_MM_MIN && mm <= MAP_MM_MAX);
	const field = mapBad ? 'map' : /MAP/.test(e) ? 'source' : 'coords';
	const message =
		field === 'map'
			? `The station’s MAP must be ${MAP_MM_MIN} to ${MAP_MM_MAX} mm.`
			: field === 'source' && !(station.mapSource ?? '').trim()
				? 'Say where the station’s MAP comes from: the source is required (the record or study, and its years).'
				: `${e.charAt(0).toUpperCase()}${e.slice(1)}.`;
	return { field, message };
}

/** The station's MAP as a read-out: "745 mm (gauge record 1991–2020)", or null when none is recorded. */
export function stationMapText(station: RainStationMeta | null | undefined): string | null {
	if (station?.mapMm === null || station?.mapMm === undefined) return null;
	return `${fmtNum(station.mapMm, 1, true)} mm${station.mapSource ? ` (${station.mapSource})` : ''}`;
}

/** Where the station stands, as a read-out: "−33.9200, 18.8600", or null when not recorded. */
export function stationPlaceText(station: RainStationMeta | null | undefined): string | null {
	if (station?.lat === null || station?.lat === undefined || station?.lon === null || station?.lon === undefined) return null;
	return `${fmtNum(station.lat, 4)}, ${fmtNum(station.lon, 4)}`;
}
