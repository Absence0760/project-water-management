// Add data's "Rainfall — station" kind (issue #553; Series details' station
// form is station.ts): a rainfall station is a catchment rain series
// (rain_catchment_mm, no site) with its own MAP and the MAP's source, and
// optionally where it stands. The form keeps what was typed as text; these
// read it, say what's wrong under the field it is in, and build the `station`
// the create request sends (engine RainStationMeta), which the API's own rule
// (engine rainStationError) then passes.
import { MAP_MM_MAX, MAP_MM_MIN, PE_SOURCE_MAX, rainStationError, type RainStationMeta, type SeriesMeta } from '@water-management/engine';
import { fmtNum, parseNum } from '$lib/format/number';

/** The Kind select's value for a station: not a series kind of its own, a catchment rain series with station details. */
export const STATION_OPTION = 'rain_station';
export const STATION_LABEL = 'Rainfall — station';
/** The series kind a station is stored as. */
export const STATION_KIND = 'rain_catchment_mm';

/** What the station fields hold, as typed. */
export interface StationInput {
	mapMm: string;
	mapSource: string;
	lat: string;
	lon: string;
}

export const emptyStation = (): StationInput => ({ mapMm: '', mapSource: '', lat: '', lon: '' });

export type StationField = 'name' | 'mapMm' | 'mapSource' | 'lat' | 'lon';
export interface StationProblem {
	field: StationField;
	message: string;
}

/** A series that is a rainfall station: catchment rain at no site. Stations made before #553 have no details (null). */
export const isStationSeries = (s: Pick<SeriesMeta, 'kind' | 'siteNodeId'>): boolean => s.kind === STATION_KIND && !s.siteNodeId;

/** The names of the project's stations that carry station details, for the name field's suggestions. */
export const stationNames = (list: readonly SeriesMeta[]): string[] => list.filter((s) => isStationSeries(s) && s.station).map((s) => s.name);

/** A coordinate as typed: a decimal point or a decimal comma (−33,92), never thousands separators. Blank = null, unreadable = NaN. */
export function readCoordinate(text: string): number | null {
	const s = text.trim().replace(/^−/, '-');
	if (s === '') return null;
	if (!/^-?\d+([.,]\d+)?$/.test(s)) return Number.NaN;
	return Number(s.replace(',', '.'));
}

/** The MAP as typed (745, 1 200, 1,200 or 745,5). Blank = null, unreadable = NaN. */
export function readMap(text: string): number | null {
	if (text.trim() === '') return null;
	return parseNum(text) ?? Number.NaN;
}

/**
 * The first thing that stops the station being added, or null. A station
 * needs its name and its MAP with the MAP's source (the run scales rain by
 * it); the coordinates are optional, both or neither. The bounds are the
 * API's (engine MAP_MM_MIN … MAP_MM_MAX, PE_SOURCE_MAX, WGS84 degrees).
 */
export function stationProblem(name: string, input: StationInput): StationProblem | null {
	if (!name.trim()) return { field: 'name', message: 'Give the station a name.' };
	const map = readMap(input.mapMm);
	if (map === null) return { field: 'mapMm', message: 'Enter the station’s MAP.' };
	if (!(Number.isFinite(map) && map >= MAP_MM_MIN && map <= MAP_MM_MAX)) return { field: 'mapMm', message: `Enter a MAP from ${MAP_MM_MIN} to ${fmtNum(MAP_MM_MAX)} mm.` };
	if (!input.mapSource.trim()) return { field: 'mapSource', message: 'A MAP needs its source.' };
	if (input.mapSource.length > PE_SOURCE_MAX) return { field: 'mapSource', message: `Keep the source to ${PE_SOURCE_MAX} characters.` };
	const lat = readCoordinate(input.lat);
	const lon = readCoordinate(input.lon);
	if (lat !== null && !(Number.isFinite(lat) && lat >= -90 && lat <= 90)) return { field: 'lat', message: 'Enter a latitude from −90 to 90 degrees.' };
	if (lon !== null && !(Number.isFinite(lon) && lon >= -180 && lon <= 180)) return { field: 'lon', message: 'Enter a longitude from −180 to 180 degrees.' };
	if (lat === null && lon !== null) return { field: 'lat', message: 'Give the latitude too, or leave both blank.' };
	if (lon === null && lat !== null) return { field: 'lon', message: 'Give the longitude too, or leave both blank.' };
	// The API's rule, as a backstop: the form's checks are worded for the field, and stricter (a new station needs its MAP).
	const api = rainStationError({ mapMm: map, mapSource: input.mapSource.trim(), lat, lon });
	return api ? { field: 'mapMm', message: `${api.charAt(0).toUpperCase()}${api.slice(1)}.` } : null;
}

/** The request's `station`, once stationProblem passes (null before then). */
export function stationBody(name: string, input: StationInput): RainStationMeta | null {
	if (stationProblem(name, input)) return null;
	return { mapMm: readMap(input.mapMm), mapSource: input.mapSource.trim(), lat: readCoordinate(input.lat), lon: readCoordinate(input.lon) };
}
