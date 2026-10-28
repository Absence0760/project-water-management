// Start from the map's last step as a to-do list (issue #646 item 2, the
// hydrologist's review F2–F4; docs/design/start-from-map.md § The flow, step
// 4, docs/ui.md § Map): every data proposal a model started from the map
// needs before its first run, in the order a run reads them, each with a
// status worked out from what the project holds now (never a stored
// checkbox), and where it is accepted. The Start sheet's data step and the
// Map's Getting started pill show the same list, so it stays after the sheet
// is closed, until every item that a run needs is done. Pure: MapTab passes
// in what it has loaded.
import type { ProjectModel, ProjectSettings } from '@water-management/engine';
import type { MapFeature } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import type { RainReads } from './mapSetup';

export type DataItemId = 'network' | 'method' | 'rain' | 'catchment-map' | 'unit-rain' | 'unit-map' | 'evaporation' | 'wr2012' | 'flow' | 'dams' | 'crops' | 'run';
/** `done`; `partial` = started, or done for some units; `todo`; `unknown` = still loading. */
export type DataStatus = 'done' | 'partial' | 'todo' | 'unknown';

export interface DataItem {
	id: DataItemId;
	title: string;
	status: DataStatus;
	/** One line: what is there, or what to do. */
	detail: string;
	/** Where the value is proposed and accepted (a `?tab=` link on the project page)… */
	href: string;
	/** …and that place in words, the link's text ("Data → Data feeds"). */
	where: string;
	/** A second way in, when the value has one (Evaporation from the map beside the A-pan row). */
	more?: { href: string; text: string };
	/** A run goes without it (a check, or a value that has a stand-in): it never keeps the list open. */
	optional?: boolean;
}

/** A feed as the list reads it (GET …/feeds): its source and, for a unit's CHIRPS feed, the unit. */
export interface DataFeed {
	source: string;
	config: { unit?: { nodeId: string } | null };
}
/** A series as the list reads it (GET …/series). */
export interface DataSeries {
	kind: string;
	siteNodeId?: string | null;
	length: number;
}

export interface DataInput {
	model: Pick<ProjectModel, 'nodes' | 'cropAreas'>;
	/** null while loading. */
	settings: Pick<ProjectSettings, 'apanMm' | 'pe' | 'wr2012' | 'unitRain' | 'rainStations'> | null;
	/** null while loading (or unreadable: the items reading it stay unknown). */
	feeds: readonly DataFeed[] | null;
	series: readonly DataSeries[] | null;
	features: readonly Pick<MapFeature, 'kind' | 'nodeId'>[];
	hasBoundary: boolean;
	/** MapRainLink's read of the feed list for the boundary. */
	rain: RainReads;
	runs: readonly { createdAt: string }[] | null;
	/** Feeds are set up by owners (data_feed's RLS): an editor's lines say so. */
	owner: boolean;
}

const OBSERVED = ['flow_observed_m3s', 'flow_logger_m3s'];
const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
/** "2 of 3 units": done for some. */
const someOf = (k: number, m: number) => `${fmtNum(k)} of ${plural(m, 'unit')}`;

/** Every land unit's share of a per-unit value: done for all, partial for some, to do for none (done with no land unit). */
function perUnit(k: number, m: number): DataStatus {
	if (!m || k === m) return 'done';
	return k ? 'partial' : 'todo';
}

/**
 * The to-do list, in the order a run reads it: the units' areas, how natural
 * flow is made, the catchment's rain and MAP, each unit's rain and MAP,
 * evaporation, the WR2012 check, observed flow, the composite dams, the
 * cultivated area, then Run the model.
 */
export function startDataItems(s: DataInput): DataItem[] {
	const units = s.model.nodes.filter((n) => n.kind === 'farm');
	const land = units.filter((n) => n.areaKm2 > 0);
	const ownerNote = s.owner ? '' : ' An owner of the project sets up the feeds.';
	const items: DataItem[] = [];

	// The units' areas: anything Apply left unticked is 0 until typed on the Network.
	const noArea = units.filter((n) => !(n.areaKm2 > 0));
	items.push({
		id: 'network',
		title: 'The units’ areas and order',
		status: noArea.length ? 'partial' : 'done',
		detail: noArea.length
			? `${plural(noArea.length, 'unit')} ${noArea.length === 1 ? 'has' : 'have'} no area yet (${noArea.map((n) => n.name).join(', ')}): type it on the Network, or remove the unit.`
			: `${plural(units.length, 'unit')}, each with an area. The Network holds the order and anything not ticked.`,
		href: '?tab=network',
		where: 'Network',
		optional: true
	});

	const set = s.settings;
	const perUnitMode = set?.unitRain?.mode === 'perUnit';
	items.push({
		id: 'method',
		title: 'How natural flow is made',
		status: set ? 'done' : 'unknown',
		detail: !set
			? 'Reading the settings…'
			: perUnitMode
				? 'Per unit: GR4J runs on each unit’s own rain.'
				: 'Fragmentation (the default): GR4J runs once on the catchment rain, split by the units’ shares. Choose Per unit for each unit’s own runoff.',
		href: '?tab=settings#set-share',
		where: 'Model settings → Model selection for flow generation'
	});

	const rainStatus: DataStatus = !s.hasBoundary ? 'todo' : s.rain === 'current' ? 'done' : s.rain === 'changed' ? 'partial' : s.rain === 'none' ? 'todo' : 'unknown';
	items.push({
		id: 'rain',
		title: 'Rain from the boundary',
		status: rainStatus,
		detail: !s.hasBoundary
			? 'No catchment boundary on the map, so no feed can read the cells inside it: each unit’s own rain stands in.'
			: s.rain === 'current'
				? 'A CHIRPS feed reads the cells inside the boundary.'
				: s.rain === 'changed'
					? 'The boundary changed since the rain feed took its cells: propose them again.'
					: s.rain === 'none'
						? `No rain feed reads the boundary yet: the CHIRPS feed over its cells is proposed.${ownerNote}`
						: 'Reading the feeds…',
		href: '?tab=series&rain=boundary#data-feeds',
		where: 'Data → Data feeds',
		optional: !s.hasBoundary
	});

	const withMap = land.filter((n) => n.mapMm != null);
	const catchmentMap = set?.rainStations?.catchmentMapMm ?? null;
	items.push({
		id: 'catchment-map',
		title: 'The catchment’s MAP',
		status: !set ? 'unknown' : catchmentMap !== null ? 'done' : land.length && withMap.length === land.length ? 'partial' : 'todo',
		detail: !set
			? 'Reading the settings…'
			: catchmentMap !== null
				? `${fmtNum(catchmentMap, 0)} mm a year${set.rainStations?.catchmentMapSource ? ` (${set.rainStations.catchmentMapSource})` : ''}.`
				: land.length && withMap.length === land.length
					? 'Not set: the units’ area-weighted mean MAP stands in. Needed only when a rainfall station forces the catchment.'
					: 'Not set, and not every unit has a MAP to stand in. Needed only when a rainfall station forces the catchment.',
		href: '?tab=settings#set-share',
		where: 'Model settings → The catchment’s rainfall station',
		optional: true
	});

	const fed = s.feeds ? new Set(s.feeds.filter((f) => f.source === 'chirps' && f.config.unit).map((f) => f.config.unit!.nodeId)) : null;
	const withRain = fed ? land.filter((n) => fed.has(n.id)).length : 0;
	items.push({
		id: 'unit-rain',
		title: 'Rain for each unit',
		status: fed ? perUnit(withRain, land.length) : 'unknown',
		detail: !fed
			? 'Reading the feeds…'
			: !land.length
				? 'No unit has an area yet, so none has rain of its own to read.'
				: withRain === land.length
					? 'Every unit has its own CHIRPS feed, over its boundary’s cells.'
					: withRain
						? `${someOf(withRain, land.length)} have their own CHIRPS feed.${ownerNote}`
						: `No unit has its own rain yet: a CHIRPS feed per unit, over its boundary’s cells, is proposed.${ownerNote}`,
		href: '?tab=series&rain=units#data-feeds',
		where: 'Data → Data feeds'
	});

	items.push({
		id: 'unit-map',
		title: 'MAP for each unit',
		status: perUnit(withMap.length, land.length),
		detail: !land.length
			? 'No unit has an area yet.'
			: withMap.length === land.length
				? 'Every unit has its MAP, which sets its rain level and its share of the EWR.'
				: withMap.length
					? `${someOf(withMap.length, land.length)} have a MAP. The MAP grid proposes each unit’s over its boundary.`
					: 'No unit has a MAP yet: the MAP grid proposes each unit’s over its boundary.',
		href: '?tab=settings#set-unit-map',
		where: 'Model settings → MAP from the grid'
	});

	const apan = !!set && set.apanMm.some((v) => v > 0);
	items.push({
		id: 'evaporation',
		title: 'Evaporation',
		status: !set ? 'unknown' : apan ? 'done' : 'todo',
		detail: !set
			? 'Reading the settings…'
			: apan
				? `The monthly A-pan is set${set.pe.kind === 'monthly' ? ', and an ET₀ row feeds the runoff model' : ''}.`
				: 'No A-pan yet: the dams and crops lose nothing. Evaporation from the map proposes it; an ET₀ row from the map feeds the runoff model only.',
		href: '?tab=settings#set-demand',
		where: 'Model settings → Demand',
		more: { href: '?tab=calibration#set-evaporation', text: 'Evaporation from the map' }
	});

	const wr = set?.wr2012.reference ?? null;
	items.push({
		id: 'wr2012',
		title: 'WR2012 check',
		status: !set ? 'unknown' : wr ? 'done' : 'todo',
		detail: !set ? 'Reading the settings…' : wr ? `Against quaternary ${wr.quaternary}.` : 'No WR2012 check yet: Propose from the map looks the quaternary up.',
		href: '?tab=calibration#set-wr2012',
		where: 'Calibration → WR2012 check',
		optional: true
	});

	const observed = s.series ? s.series.some((x) => OBSERVED.includes(x.kind) && !x.siteNodeId && x.length > 0) : null;
	const dws = s.feeds ? s.feeds.some((f) => f.source === 'dws') : null;
	items.push({
		id: 'flow',
		title: 'Observed flow',
		status: observed === null || dws === null ? 'unknown' : observed ? 'done' : dws ? 'partial' : 'todo',
		detail:
			observed === null || dws === null
				? 'Reading the series…'
				: observed
					? 'An observed flow record at the outlet, to calibrate against.'
					: dws
						? 'A DWS feed is attached: its record arrives with its first fetch.'
						: `No observed flow yet: the nearest gauging stations to the outlet are proposed.${ownerNote}`,
		href: '?tab=series&feed=dws#data-feeds',
		where: 'Data → Data feeds'
	});

	const damUnits = new Set(s.features.filter((f) => f.kind === 'dam' && f.nodeId).map((f) => f.nodeId!));
	const withDams = units.filter((n) => damUnits.has(n.id));
	const sized = withDams.filter((n) => n.damCapacityM3 > 0).length;
	items.push({
		id: 'dams',
		title: 'Each unit’s composite dam',
		status: perUnit(sized, withDams.length),
		detail: !withDams.length
			? 'No dam on the map is part of a unit.'
			: sized === withDams.length
				? 'Every unit with dams has its composite dam’s volume.'
				: `${someOf(sized, withDams.length)} with dams have a volume. The volume and the area draining to it are yours to enter; the register of dams is a reference only.`,
		href: '?tab=dams',
		where: 'Dams'
	});

	const planted = new Set(s.model.cropAreas.filter((c) => c.areaM2 > 0).map((c) => c.nodeId));
	const withCrops = land.filter((n) => planted.has(n.id)).length;
	items.push({
		id: 'crops',
		title: 'Cultivated area',
		status: perUnit(withCrops, land.length),
		detail: !land.length
			? 'No unit has an area yet.'
			: withCrops === land.length
				? 'Every unit has a planted area.'
				: `${withCrops ? `${someOf(withCrops, land.length)} have a planted area` : 'No unit has a planted area yet'}: land cover proposes each unit’s, in its drawer on Crops. Skip it if nothing is irrigated.`,
		href: '?tab=crops',
		where: 'Crops',
		optional: true
	});

	items.push({
		id: 'run',
		title: 'Run the model',
		status: s.runs === null ? 'unknown' : s.runs.length ? 'done' : 'todo',
		detail: s.runs === null ? 'Reading the runs…' : s.runs.length ? `${plural(s.runs.length, 'run')} so far.` : 'Run it once rainfall is in (Runs & results).',
		href: '?tab=runs',
		where: 'Runs & results'
	});
	return items;
}

/** The item to do next: the first a run needs that isn't done (null when none is left). */
export const nextItem = (items: readonly DataItem[]): DataItem | null => items.find((i) => !i.optional && i.status !== 'done' && i.status !== 'unknown') ?? null;

/** Whether the list is finished: every item a run needs is done (an unknown one isn't). */
export const dataDone = (items: readonly DataItem[]): boolean => items.every((i) => i.optional || i.status === 'done');

/** "4 of 12": the items done, of all. */
export const dataCount = (items: readonly DataItem[]) => `${items.filter((i) => i.status === 'done').length} of ${items.length}`;

export const STATUS_WORD: Record<DataStatus, string> = { done: 'Done', partial: 'Started', todo: 'To do', unknown: 'Checking' };
