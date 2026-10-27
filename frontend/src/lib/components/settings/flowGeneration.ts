// Settings → Model selection for flow generation (issue #553 round 3, docs/ui.md § Settings &
// calibration, docs/model.md §2.4h, §2.4i, §2.5): the one choice of how
// natural flow is made. Fragmentation is settings.unitRain off (absent, null
// or `catchment`): GR4J once on the catchment rain, its flow split to the
// units by the flow share. Per unit is `perUnit`: GR4J on each land unit's
// own rain, from the rainfall station settings.rainStations.units assigns it
// (§2.4i), or, for a unit without one, the §2.4h chain as before. Nothing is
// migrated: the radio writes the same settings.unitRain the checkbox did, and
// a unit's station is the rainStations assignment round 2 runs, so every
// stored project runs as it did. Pure: the components call these.
import {
	AREAL_RAIN_FACTOR_MAX,
	AREAL_RAIN_FACTOR_MIN,
	AREAL_RAIN_FACTOR_WARN_MAX,
	AREAL_RAIN_FACTOR_WARN_MIN,
	flowMethodOf,
	type FlowGenerationMethod,
	type NetworkNode,
	type RainStationAssignment,
	type RainStationSettings,
	type SeriesMeta
} from '@water-management/engine';

export type { FlowGenerationMethod };
export { flowMethodOf };

/**
 * The two methods: `label` is the name the engine's messages and the fit record use ("fitted under Fragmentation"),
 * `short` the plain words shown beside it, always (issue #586 E14: "Fragmentation" alone said nothing to a reader,
 * and the panel's name read like Calibration's Flow calibration), `help` the longer explanation behind the switch.
 */
export const FLOW_METHODS: readonly { value: FlowGenerationMethod; label: string; short: string; help: string }[] = [
	{
		value: 'fragmentation',
		label: 'Fragmentation',
		short: 'one runoff run on the catchment rain, split between the units',
		help: 'GR4J runs once on the catchment rain, and the flow share splits its flow and the EWR between the units.'
	},
	{
		value: 'perUnit',
		label: 'Per unit',
		short: 'a runoff run for each unit with land, on its own rain',
		help: 'GR4J runs on each unit with land, on the rain of the rainfall station it is assigned. Demand and the dams keep the catchment rain.'
	}
];

/** A rainfall station as the form lists it: a catchment rain series with no site (SeriesMeta with its station details). */
export type StationOption = Pick<SeriesMeta, 'id' | 'name' | 'station'>;
/** A land unit as the table needs it. */
export type UnitNode = Pick<NetworkNode, 'id' | 'name' | 'kind' | 'areaKm2' | 'mapMm' | 'mapSource'>;

/** The project's rainfall stations from its series list: every catchment rain series without a site, by name. */
export function stationOptions<S extends StationOption & Pick<SeriesMeta, 'kind'> & { siteNodeId?: string | null }>(series: readonly S[]): StationOption[] {
	return series
		.filter((s) => s.kind === 'rain_catchment_mm' && !s.siteNodeId)
		.map((s) => ({ id: s.id, name: s.name, station: s.station ?? null }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The land units the table lists (a farm with an area), in the model's order. */
export const landUnits = <N extends UnitNode>(nodes: readonly N[]): N[] => nodes.filter((n) => n.kind === 'farm' && n.areaKm2 > 0);

const isEmpty = (o: object | null | undefined) => !o || Object.keys(o).length === 0;

/**
 * The setting with nothing left in it as null, so a project that assigns a
 * station and takes it away again stores what it had (none). A part still
 * set (the catchment's, a site, an unreliable period, the catchment MAP) keeps it.
 */
export function tidyStations(rs: RainStationSettings): RainStationSettings | null {
	const out: RainStationSettings = { ...rs };
	if (isEmpty(out.units)) delete out.units;
	if (isEmpty(out.sites)) delete out.sites;
	if (isEmpty(out.unreliable)) delete out.unreliable;
	for (const k of ['catchment', 'catchmentMapMm', 'catchmentMapSource'] as const) if (out[k] === null || out[k] === undefined) delete out[k];
	return Object.keys(out).length ? out : null;
}

/** The units' assignments, copied. */
const unitsOf = (rs: RainStationSettings | null | undefined): Record<string, RainStationAssignment> => ({ ...(rs?.units ?? {}) });

/**
 * The setting with a land unit's station set ('' / null: none, so the unit
 * keeps the §2.4h rule). Another station keeps the unit's scaling and its
 * correcting station.
 */
export function withUnitStation(rs: RainStationSettings | null | undefined, unitId: string, stationId: string | null): RainStationSettings | null {
	const units = unitsOf(rs);
	if (!stationId) delete units[unitId];
	else units[unitId] = { ...(units[unitId] ?? {}), stationId };
	return tidyStations({ ...(rs ?? {}), units });
}

/** The setting with each of `unitIds` on `stationId` (or none): the select-several action. */
export function withUnitsStation(rs: RainStationSettings | null | undefined, unitIds: readonly string[], stationId: string | null): RainStationSettings | null {
	let next = rs ?? null;
	for (const id of unitIds) next = withUnitStation(next, id, stationId);
	return next;
}

/** The setting with a unit's "Scale to unit MAP" set. Scaling is the default, so on stores none. */
export function withUnitScale(rs: RainStationSettings | null | undefined, unitId: string, scale: boolean): RainStationSettings | null {
	const units = unitsOf(rs);
	const a = units[unitId];
	if (!a) return rs ?? null;
	const { scaleToMap: _s, ...rest } = a;
	units[unitId] = scale ? rest : { ...rest, scaleToMap: false };
	return tidyStations({ ...(rs ?? {}), units });
}

/** The setting with the station that corrects a unit's CHIRPS on its station's gaps ('' / null / its own station: the default, stored as none). */
export function withUnitCorrectAgainst(rs: RainStationSettings | null | undefined, unitId: string, stationId: string | null): RainStationSettings | null {
	const units = unitsOf(rs);
	const a = units[unitId];
	if (!a) return rs ?? null;
	const { correctAgainst: _c, ...rest } = a;
	units[unitId] = stationId && stationId !== a.stationId ? { ...rest, correctAgainst: stationId } : rest;
	return tidyStations({ ...(rs ?? {}), units });
}

/** The setting with the land unit a station without coordinates stands in, whose CHIRPS its pairing reads ('' / null: none). */
export function withStationSite(rs: RainStationSettings | null | undefined, stationId: string, unitId: string | null): RainStationSettings | null {
	const sites = { ...(rs?.sites ?? {}) };
	if (unitId) sites[stationId] = { unitId };
	else delete sites[stationId];
	return tidyStations({ ...(rs ?? {}), sites });
}

/** A station's MAP, or null. */
const stationMap = (s: StationOption | undefined): number | null => s?.station?.mapMm ?? null;

/** The ratio a station unit's rain is scaled by, as the engine takes it (stationForcing.ts stationRatio): area MAP ÷ station MAP, clamped 0.25–4; × 1 without scaling or a MAP. */
export function unitRatio(unitMapMm: number | null | undefined, stationMapMm: number | null | undefined, scale: boolean): { ratio: number; own: number | null; clamped: boolean; outsideBand: boolean } {
	if (!scale || unitMapMm == null || stationMapMm == null || !(stationMapMm > 0)) return { ratio: 1, own: null, clamped: false, outsideBand: false };
	const own = unitMapMm / stationMapMm;
	const ratio = Math.min(AREAL_RAIN_FACTOR_MAX, Math.max(AREAL_RAIN_FACTOR_MIN, own));
	return { ratio, own, clamped: ratio !== own, outsideBand: own < AREAL_RAIN_FACTOR_WARN_MIN || own > AREAL_RAIN_FACTOR_WARN_MAX };
}

/** One row of the Per unit table. */
export interface UnitStationRow<N extends UnitNode = UnitNode> {
	unit: N;
	/** The unit's assignment, or null (the §2.4h rule). */
	assignment: RainStationAssignment | null;
	/** The assigned station, or null: none, or one the project no longer has (`missing`). */
	station: StationOption | null;
	missing: boolean;
	scale: boolean;
	/** The station correcting its CHIRPS: the assignment's, else its own station. */
	correctAgainst: string | null;
	ratio: ReturnType<typeof unitRatio>;
	/** Why the station's rain isn't scaled although scaling is on: no MAP on one side. */
	noRatioWhy: string | null;
}

export function unitStationRows<N extends UnitNode>(nodes: readonly N[], rs: RainStationSettings | null | undefined, stations: readonly StationOption[]): UnitStationRow<N>[] {
	const byId = new Map(stations.map((s) => [s.id, s]));
	return landUnits(nodes).map((unit) => {
		const assignment = rs?.units?.[unit.id] ?? null;
		const station = assignment ? (byId.get(assignment.stationId) ?? null) : null;
		const scale = assignment?.scaleToMap !== false;
		const sMap = stationMap(station ?? undefined);
		const noRatioWhy = !assignment || !station || !scale ? null : sMap === null ? 'the station has no MAP' : unit.mapMm == null ? 'the unit has no MAP' : null;
		return {
			unit,
			assignment,
			station,
			missing: !!assignment && !station,
			scale,
			correctAgainst: assignment ? (assignment.correctAgainst ?? assignment.stationId) : null,
			ratio: unitRatio(unit.mapMm, sMap, scale && !!station),
			noRatioWhy
		};
	});
}

/** The stations the table's rows use (assigned or correcting), each once, in the stations' order, with the units on it. */
export function stationsInUse(rows: readonly UnitStationRow[], stations: readonly StationOption[]): { station: StationOption; units: string[]; corrects: string[] }[] {
	return stations
		.map((station) => ({
			station,
			units: rows.filter((r) => r.station?.id === station.id).map((r) => r.unit.name),
			corrects: rows.filter((r) => r.station && r.correctAgainst === station.id).map((r) => r.unit.name)
		}))
		.filter((s) => s.units.length || s.corrects.length);
}

/** "Upper farm, Lower farm and 2 more". */
export function namesLine(names: readonly string[], shown = 4): string {
	if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
	return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

/** "3 of 5 units have a station": the Per unit table's state line. */
export function assignmentLine(rows: readonly UnitStationRow[]): string {
	if (!rows.length) return 'No unit has land yet: give a unit an area in Network to list it here.';
	const assigned = rows.filter((r) => r.station).length;
	const of = rows.length === 1 ? '1 unit' : `${rows.length} units`;
	return `${assigned} of ${of} with land ${assigned === 1 ? 'has' : 'have'} a rainfall station.`;
}

export const methodLabel = (m: FlowGenerationMethod) => FLOW_METHODS.find((x) => x.value === m)!.label;
