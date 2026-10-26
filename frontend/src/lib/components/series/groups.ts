// The Data tab's series list in groups (issue #553 round 5, docs/ui.md §
// Data): Rainfall stations, Catchment rainfall, Hydrological units, Flow
// records, Other inputs, in that order, each keeping the freshness order the
// list arrives in (./freshness.ts freshnessOrder). A hydrological unit is one
// row of its own that holds the series measured at it (its CHIRPS feed, a
// migration-209 gauge), and the catchment's average rainfall is a row of its
// own when Settings assigns the catchment a station: both are derived, so the
// row says what the area's rain is made of (areaSentence) and the series it
// reads are listed under it. Pure: no Svelte, no DOM.
import { catchmentMapOf, isLandUnit, stationRatio, type NetworkNode, type ProjectSettings, type RainStationAssignment, type SeriesMeta } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { kindLabel } from '#lib/series/kinds.js';
import { asksStation } from './station';

export type SeriesGroupId = 'stations' | 'catchment' | 'units' | 'flow' | 'other';

export const GROUP_ORDER: readonly SeriesGroupId[] = ['stations', 'catchment', 'units', 'flow', 'other'];

export const GROUP_TITLE: Record<SeriesGroupId, string> = {
	stations: 'Rainfall stations',
	catchment: 'Catchment rainfall',
	units: 'Hydrological units',
	flow: 'Flow records',
	other: 'Other inputs'
};

/** The rain kinds read for the catchment as a whole (the stations aside): CHIRPS, an alternative gauge, a reanalysis, the forecast. */
const CATCHMENT_RAIN = new Set(['rain_catchment_mm', 'rain_catchment_alt_mm', 'rain_chirps_mm', 'rain_reanalysis_mm', 'rain_forecast_mm']);

type Meta = Pick<SeriesMeta, 'id' | 'kind' | 'siteNodeId'>;

/** The group a stored series is listed in; `unitIds` are the land units the Hydrological units group lists. */
export function groupOf(s: Meta, unitIds: ReadonlySet<string>): SeriesGroupId {
	if (asksStation(s)) return 'stations';
	if (s.siteNodeId && unitIds.has(s.siteNodeId)) return 'units';
	if (s.kind.startsWith('flow_')) return 'flow';
	if (CATCHMENT_RAIN.has(s.kind) && !s.siteNodeId) return 'catchment';
	return 'other';
}

/** A row of the grouped list: a stored series, a hydrological unit (with the series measured at it), or the catchment's average rainfall. */
export type GroupItem<T> =
	| { type: 'series'; id: string; series: T }
	| { type: 'unit'; id: string; unit: NetworkNode; series: T[] }
	| { type: 'catchment'; id: string };

export interface SeriesGroup<T> {
	id: SeriesGroupId;
	title: string;
	items: GroupItem<T>[];
}

export const unitItemId = (nodeId: string) => `unit:${nodeId}`;
export const CATCHMENT_ITEM_ID = 'area:catchment';

/** Whether a run gives the land units rain of their own: per-unit rain on, or a station assigned to a unit. */
export const unitsHaveRain = (settings: ProjectSettings | null | undefined) =>
	settings?.unitRain?.mode === 'perUnit' || Object.keys(settings?.rainStations?.units ?? {}).length > 0;

/**
 * The land units the Hydrological units group lists, in the model's order:
 * every one when units have rain of their own (unitsHaveRain), else only
 * those a series is measured at.
 */
export function listedUnits(nodes: readonly NetworkNode[], settings: ProjectSettings | null | undefined, list: readonly Meta[]): NetworkNode[] {
	const land = nodes.filter(isLandUnit);
	if (unitsHaveRain(settings)) return land;
	const sited = new Set(list.map((s) => s.siteNodeId).filter((x): x is string => !!x));
	return land.filter((n) => sited.has(n.id));
}

/**
 * The grouped list: `rows` (already in freshness order) split into the
 * groups, each in GROUP_ORDER and in `rows`' order within it, a unit's own
 * series under its unit, and empty groups left out.
 */
export function groupSeries<T extends Meta>(
	rows: readonly T[],
	nodes: readonly NetworkNode[],
	settings: ProjectSettings | null | undefined,
	/** The series behind (freshness.ts): a unit holding one comes first in its group, as a series behind does in its own. */
	behind: ReadonlySet<string> = new Set()
): SeriesGroup<T>[] {
	const units = listedUnits(nodes, settings, rows);
	const unitIds = new Set(units.map((u) => u.id));
	const items: Record<SeriesGroupId, GroupItem<T>[]> = { stations: [], catchment: [], units: [], flow: [], other: [] };
	if (settings?.rainStations?.catchment?.stationId) items.catchment.push({ type: 'catchment', id: CATCHMENT_ITEM_ID });
	const byUnit = new Map(units.map((u) => [u.id, [] as T[]]));
	for (const s of rows) {
		const g = groupOf(s, unitIds);
		if (g === 'units') byUnit.get(s.siteNodeId!)!.push(s);
		else items[g].push({ type: 'series', id: s.id, series: s });
	}
	const unitBehind = (u: NetworkNode) => byUnit.get(u.id)!.some((s) => behind.has(s.id));
	for (const u of [...units.filter(unitBehind), ...units.filter((u) => !unitBehind(u))]) items.units.push({ type: 'unit', id: unitItemId(u.id), unit: u, series: byUnit.get(u.id)! });
	return GROUP_ORDER.filter((g) => items[g].length).map((g) => ({ id: g, title: GROUP_TITLE[g], items: items[g] }));
}

/** The item a series' row sits in: its unit's when it is measured at a listed unit, else its own. */
export function itemOfSeries<T extends Meta>(groups: readonly SeriesGroup<T>[], seriesId: string | null): string | null {
	if (!seriesId) return null;
	for (const g of groups)
		for (const it of g.items) {
			if (it.type === 'series' && it.id === seriesId) return it.id;
			if (it.type === 'unit' && it.series.some((s) => s.id === seriesId)) return it.id;
		}
	return null;
}

/** A station as the sentences name it. */
export interface StationLite {
	id: string;
	name: string;
	mapMm: number | null;
}

/** The stations of a series list (catchment rain with no site), by id. */
export function stationsOf(list: readonly Pick<SeriesMeta, 'id' | 'kind' | 'siteNodeId' | 'name' | 'station'>[]): Map<string, StationLite> {
	return new Map(list.filter(asksStation).map((s) => [s.id, { id: s.id, name: s.name || 'Unnamed station', mapMm: s.station?.mapMm ?? null }]));
}

const mm = (v: number) => fmtNum(v, 1);

/**
 * What an area's rain is made of, in one sentence, from the settings as
 * stored (the run's own rule, docs/model.md §2.4i): "Bergwater × 1.16 (unit
 * MAP 863.1 mm ÷ station MAP 745.0 mm); gaps from CHIRPS corrected against
 * Bergwater." The ratio is the engine's stationRatio (clamped 0.25–4). Null
 * without an assignment.
 */
export function areaSentence(
	area: { name: string; mapMm: number | null; catchment: boolean; mapFromUnits?: boolean; hasChirps?: boolean },
	a: RainStationAssignment | null | undefined,
	stations: ReadonlyMap<string, StationLite>
): string | null {
	if (!a?.stationId) return null;
	const st = stations.get(a.stationId);
	if (!st) return 'Its station is no longer one of the project’s series, so runs warn and read the rain as without a station.';
	const scale = a.scaleToMap !== false;
	const r = stationRatio(area.mapMm, st.mapMm, scale);
	const what = area.catchment ? (area.mapFromUnits ? 'catchment MAP, the units’ area-weighted mean' : 'catchment MAP') : 'unit MAP';
	let rain: string;
	if (!scale) rain = `${st.name} as recorded (not scaled by MAP)`;
	else if (st.mapMm === null) rain = `${st.name} × 1: the station has no MAP to scale it by`;
	else if (area.mapMm === null) rain = `${st.name} × 1: ${area.catchment ? 'the catchment has no MAP' : `${area.name} has no MAP`} to scale it by`;
	else rain = `${st.name} × ${fmtNum(r.ratio, 2)}${r.clamped ? ' (clamped)' : ''} (${what} ${mm(area.mapMm)} mm ÷ station MAP ${mm(st.mapMm)} mm)`;
	const against = a.correctAgainst ? stations.get(a.correctAgainst) : st;
	const gaps =
		area.hasChirps === false
			? area.catchment
				? 'gaps from the forecast, if any: the catchment has no CHIRPS series'
				: 'gaps from the catchment’s rain: the unit has no CHIRPS series of its own'
			: against
				? `gaps from CHIRPS corrected against ${against.name}`
				: 'gaps from CHIRPS corrected against a station that is no longer in the project';
	return `${rain}; ${gaps}.`;
}

/** The catchment's MAP for its station's ratio (the engine's catchmentMapOf): the entered one, else the land units' area-weighted mean. */
export const catchmentMap = (settings: ProjectSettings | null | undefined, nodes: readonly NetworkNode[]) => catchmentMapOf(settings?.rainStations, nodes);

/**
 * Which areas a station serves, as a run reads settings.rainStations
 * (docs/model.md §2.4i): the catchment and the units whose rain it is, and
 * those whose CHIRPS gaps it corrects without being their station. A unit's
 * assignment is read only under per-unit rain (settings.unitRain `perUnit`,
 * the engine's unitRain.ts) and only for a land unit of the model; units it
 * is assigned to while per-unit rain is off are `idle`, read by no run until
 * it is on. Unit names in the model's order. The row's line
 * (stationUsesText) and its role badge (roles.ts roleBadge) both read this,
 * so they never disagree (issue #589).
 */
export function stationUses(stationId: string, settings: ProjectSettings | null | undefined, nodes: readonly NetworkNode[]): StationUses {
	const rs = settings?.rainStations;
	const rainFor: string[] = [];
	const corrects: string[] = [];
	const idle: string[] = [];
	const names = (a: RainStationAssignment | null | undefined) => !!a?.stationId && (a.stationId === stationId || a.correctAgainst === stationId);
	const add = (a: RainStationAssignment | null | undefined, name: string) => {
		if (!a?.stationId) return;
		if (a.stationId === stationId) rainFor.push(name);
		else if (a.correctAgainst === stationId) corrects.push(name);
	};
	add(rs?.catchment, 'the catchment');
	for (const n of nodes.filter(isLandUnit)) {
		const a = rs?.units?.[n.id];
		if (perUnitOn(settings)) add(a, n.name);
		else if (names(a)) idle.push(n.name);
	}
	return { rainFor, corrects, idle };
}

/** Where a station's rain goes (stationUses). */
export interface StationUses {
	rainFor: string[];
	corrects: string[];
	/** Units it is assigned to (as their station or their CHIRPS correction) while per-unit rain is off: no run reads it there. */
	idle: string[];
}

/** Whether a run reads the station for some area (stationUses): as its rain or its CHIRPS correction. */
export const stationRead = (uses: Pick<StationUses, 'rainFor' | 'corrects'>) => uses.rainFor.length > 0 || uses.corrects.length > 0;

const nameList = (xs: string[]) => {
	const names = (ys: string[]) => (ys.length < 2 ? (ys[0] ?? '') : `${ys.slice(0, -1).join(', ')} and ${ys[ys.length - 1]}`);
	if (xs.length <= 3) return names(xs);
	const units = xs.filter((x) => x !== 'the catchment').length;
	return names([...(xs.includes('the catchment') ? ['the catchment'] : []), `${units} units`]);
};

/**
 * A station row's line about where its rain goes: "Rain for the catchment and Unit A. Corrects the CHIRPS gaps of
 * Unit C." Past three areas the units are counted ("the catchment and 15 units"), so a row stays short whatever the
 * model's size; each unit's own row names its station. Units it is assigned to while per-unit rain is off are said
 * apart: "Assigned to Unit A, read only under per-unit rain."
 */
export function stationUsesText(uses: { rainFor: string[]; corrects: string[]; idle?: string[] }): string {
	const parts: string[] = [];
	if (uses.rainFor.length) parts.push(`Rain for ${nameList(uses.rainFor)}.`);
	if (uses.corrects.length) parts.push(`Corrects the CHIRPS gaps of ${nameList(uses.corrects)}.`);
	if (uses.idle?.length) parts.push(`Assigned to ${nameList(uses.idle)}, read only under per-unit rain.`);
	return parts.length ? parts.join(' ') : 'Not assigned to the catchment or a unit.';
}

/** A derived row of the grouped list: a hydrological unit, or the catchment's average rainfall. */
export type AreaItem<T> = Exclude<GroupItem<T>, { type: 'series' }>;

/** What a derived row's words are read from. */
export interface AreaContext {
	settings: ProjectSettings | null | undefined;
	nodes: readonly NetworkNode[];
	stations: ReadonlyMap<string, StationLite>;
	/** The series behind (freshness.ts), by id: a unit with one is marked. */
	behind: ReadonlySet<string>;
	/** Whether the catchment has a CHIRPS series of its own (with no site). */
	catchmentChirps: boolean;
}

const perUnitOn = (settings: ProjectSettings | null | undefined) => settings?.unitRain?.mode === 'perUnit';

/** The station a run reads for the area with the settings as saved, or null (a unit's only under per-unit rain). */
export function areaAssignment<T>(it: AreaItem<T>, settings: ProjectSettings | null | undefined): RainStationAssignment | null {
	const rs = settings?.rainStations;
	if (it.type === 'catchment') return rs?.catchment ?? null;
	return perUnitOn(settings) ? (rs?.units?.[it.unit.id] ?? null) : null;
}

/** The names an open row's chart uses; null when no run reads a station for the area (nothing to draw). */
export function areaNames<T>(it: AreaItem<T>, ctx: Pick<AreaContext, 'settings' | 'stations'>): { name: string; stationName: string; correctingName: string } | null {
	const a = areaAssignment(it, ctx.settings);
	const st = a ? ctx.stations.get(a.stationId) : undefined;
	if (!a || !st) return null;
	return {
		name: it.type === 'catchment' ? 'Average catchment rainfall' : it.unit.name,
		stationName: st.name,
		correctingName: ctx.stations.get(a.correctAgainst ?? a.stationId)?.name ?? 'a station no longer in the project'
	};
}

/** A derived row's words: its kind, name, MAP, sentence, its series, whether one is behind, and its disclosure's label (null: none). */
export interface AreaRowInfo {
	kind: string;
	name: string;
	map: string;
	sentence: string;
	seriesNote: string | null;
	behind: boolean;
	toggle: 'rain used' | 'its series' | null;
}

export function areaRowInfo(it: AreaItem<Pick<SeriesMeta, 'id' | 'kind' | 'name'>>, ctx: AreaContext): AreaRowInfo {
	const a = areaAssignment(it, ctx.settings);
	const drawn = areaNames(it, ctx) !== null;
	if (it.type === 'catchment') {
		const m = catchmentMap(ctx.settings, ctx.nodes);
		return {
			kind: 'Catchment average (derived)',
			name: 'Average catchment rainfall',
			map: m.mapMm === null ? 'No catchment MAP' : `MAP ${mm(m.mapMm)} mm (${m.fromUnits ? 'the units’ area-weighted mean' : (m.mapSource ?? 'entered')})`,
			sentence: areaSentence({ name: 'the catchment', mapMm: m.mapMm, catchment: true, mapFromUnits: m.fromUnits, hasChirps: ctx.catchmentChirps }, a, ctx.stations) ?? '',
			seriesNote: null,
			behind: false,
			toggle: drawn ? 'rain used' : null
		};
	}
	const u = it.unit;
	const n = it.series.length;
	const perUnit = perUnitOn(ctx.settings);
	const sentence =
		areaSentence({ name: u.name, mapMm: u.mapMm ?? null, catchment: false, hasChirps: it.series.some((s) => s.kind === 'rain_chirps_mm') }, a, ctx.stations) ??
		(ctx.settings?.rainStations?.units?.[u.id] && !perUnit
			? 'Runs split the catchment’s flow by the flow share (per-unit rain is off), so its station isn’t read.'
			: perUnit
				? 'No rainfall station assigned: its rain follows Rain for each unit (Settings → Flow calibration).'
				: 'Runs split the catchment’s flow by the flow share; this unit has no rain of its own.');
	return {
		kind: 'Hydrological unit',
		name: u.name,
		map: u.mapMm != null ? `MAP ${mm(u.mapMm)} mm` : 'No MAP',
		sentence,
		seriesNote: n ? `${n} series measured here: ${it.series.map((s) => s.name || kindLabel(s.kind)).join(', ')}` : null,
		behind: it.series.some((s) => ctx.behind.has(s.id)),
		toggle: drawn ? 'rain used' : n ? 'its series' : null
	};
}
