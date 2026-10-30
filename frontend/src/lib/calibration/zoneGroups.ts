// Calibration locations' groups as the Network and the Map show them (issue
// #555 round 4; issue #659, docs/model.md §2.10n, docs/ui.md § Network,
// docs/maps.md § Calibration zones on the map): each ticked location's land
// units and its colour, from the model as it is now and the saved settings, by
// the engine's own rule (resolveLocations), so what the screens colour is what
// the next run applies. A unit borrowed by Parameters from takes its donor's
// colour and is marked; a unit outside every location says which rule placed
// it. Pure, unit-tested.
import { calibrationRestOf, GR4J_PARAMS, resolveLocations, type CalibrationRest, type Gr4jParams, type NetworkNode, type ProjectSettings } from '@water-management/engine';

/**
 * The groups' colour tokens, in order: the crop palette's (crops/cards.ts
 * CROP_PALETTE, every adjacent pair validated apart for colour-blind readers in
 * both themes, `--series-4` left to the line charts). A group's name is always
 * written beside its colour (legend, label line, card), so a reused colour past
 * the ninth never stands alone. The units on the catchment parameters take the
 * next colour after the locations', never the map's "no figure" grey.
 */
export const ZONE_TOKENS = ['--series-1', '--series-2', '--series-3', '--series-5', '--series-6', '--series-7', '--series-8', '--series-9', '--series-10'] as const;

export interface ZoneGroup {
	/** Unique per group: the location's node id, or 'default' for the units on the catchment parameters. */
	key: string;
	/** The location's node (a gauge's, or the outlet's); null = the units on the catchment parameters. */
	nodeId: string | null;
	/** The location's name; the catchment-parameter units: "Catchment parameters". */
	name: string;
	kind: 'gauge' | 'outlet' | 'default';
	/** Its statistics are the run's headline calibration statistics. */
	headline: boolean;
	/** Its land units (own, borrowed and rest), node-id order. */
	units: string[];
	/** Units that take its parameters by Parameters from (settings.unitParamsFrom). */
	borrowed: string[];
	/** Units with no ticked location downstream that the rest rule gave it. */
	rest: string[];
	/** The rest rule its `rest` units came by. */
	restRule: CalibrationRest;
	/** Whether the location has parameters of its own (the outlet's and the catchment's: always). */
	fitted: boolean;
	/** Its colour token (`--series-N`), for a fill read through the theme. */
	token: string;
}

type ZoneSettings = Pick<ProjectSettings, 'calibrationZones' | 'calibrationSiteNodeId' | 'gr4j'> & Partial<Pick<ProjectSettings, 'calibrateAtOutlet' | 'calibrationRest' | 'unitParamsFrom'>>;

const resolvedGr4j = (g: Partial<Gr4jParams> | null | undefined): Gr4jParams =>
	Object.fromEntries(GR4J_PARAMS.map((p) => [p.key, typeof g?.[p.key] === 'number' ? g[p.key] : p.default])) as unknown as Gr4jParams;

/**
 * The groups a run would apply now: each ticked location upstream first and the
 * headline last, then the units on the catchment parameters when any, each with
 * its colour; null when every unit runs on one parameter set (no ticked gauge,
 * every ticked gauge unusable, or one group holding every unit). The
 * engine's warnings are dropped here: the run gives them.
 */
export function zoneGroups(nodes: readonly NetworkNode[], settings: ZoneSettings | null | undefined): ZoneGroup[] | null {
	if (!settings) return null;
	const a = resolveLocations(nodes, settings as Partial<ProjectSettings>, resolvedGr4j(settings.gr4j), []);
	if (!a) return null;
	const restRule = calibrationRestOf(settings);
	// A location whose every unit is borrowed away has no group to colour (the fit refuses it: locationFitPlan).
	const groups: ZoneGroup[] = a.locations.filter((l) => l.units.length).map((l, i) => ({
		key: l.nodeId,
		nodeId: l.nodeId,
		name: l.name,
		kind: l.kind,
		headline: l.key === a.headline,
		units: [...l.units],
		borrowed: [...l.borrowed],
		rest: [...l.rest],
		restRule,
		fitted: l.fitted,
		token: ZONE_TOKENS[i % ZONE_TOKENS.length]!
	}));
	if (a.defaultUnits.length)
		groups.push({
			key: 'default',
			nodeId: null,
			name: 'Catchment parameters',
			kind: 'default',
			headline: false,
			units: [...a.defaultUnits],
			borrowed: [],
			rest: [],
			restRule,
			fitted: true,
			token: ZONE_TOKENS[groups.length % ZONE_TOKENS.length]!
		});
	// One group is one parameter set: nothing to tell apart.
	return groups.length > 1 ? groups : null;
}

/** Each land unit's group (by unit id). */
export function zoneByUnit(groups: readonly ZoneGroup[] | null): Map<string, ZoneGroup> {
	const out = new Map<string, ZoneGroup>();
	for (const g of groups ?? []) for (const u of g.units) out.set(u, g);
	return out;
}

/**
 * A group in words: "Weir zone", "Outflow gauge zone (outlet, headline)", "Catchment parameters (no location)",
 * with "not fitted yet" when its units take the catchment's parameters until the location is fitted.
 */
export function zoneName(g: Pick<ZoneGroup, 'kind' | 'name' | 'headline' | 'fitted'>): string {
	if (g.kind === 'default') return 'Catchment parameters (no location)';
	const notes = [g.kind === 'outlet' ? 'outlet' : '', g.headline ? 'headline' : ''].filter(Boolean);
	return `${g.name} zone${notes.length ? ` (${notes.join(', ')})` : ''}${g.fitted ? '' : ', not fitted yet'}`;
}

/** How a unit came to its group: its own zone, borrowed by Parameters from, or the rest rule. */
export type UnitPlacement = 'zone' | 'borrowed' | 'rest' | 'default';

export function unitPlacement(g: Pick<ZoneGroup, 'kind' | 'borrowed' | 'rest'>, unitId: string): UnitPlacement {
	if (g.kind === 'default') return 'default';
	if (g.borrowed.includes(unitId)) return 'borrowed';
	return g.rest.includes(unitId) ? 'rest' : 'zone';
}

/** The rest rule in a unit's words: "nearest upstream", "the headline’s". */
export const REST_WORDS: Record<CalibrationRest, string> = { nearest: 'nearest upstream', headline: 'the headline’s', default: 'the catchment parameters' };
/** The rest rule after a count, in a key: "1 placed by nearest upstream". */
const REST_COUNT_WORDS: Record<CalibrationRest, string> = { nearest: 'placed by nearest upstream', headline: 'given the headline’s parameters', default: 'on the catchment parameters' };

/**
 * One unit's group in words, for its label line, card and tooltip: "Weir zone", "borrowed from Weir",
 * "nearest upstream: Weir", "Catchment parameters (no location)"; ", not fitted yet" when its location isn't.
 */
export function unitZoneText(g: ZoneGroup, unitId: string): string {
	const how = unitPlacement(g, unitId);
	if (how === 'zone' || how === 'default') return zoneName(g);
	const fitted = g.fitted ? '' : ', not fitted yet';
	return how === 'borrowed' ? `borrowed from ${g.name}${fitted}` : `${REST_WORDS[g.restRule]}: ${g.name}${fitted}`;
}

/** "3 units". */
export const unitCount = (n: number) => `${n} unit${n === 1 ? '' : 's'}`;

/** One entry of a key: a group, or its borrowed units (`marker`: drawn with the borrowed outline). */
export interface ZoneKeyEntry {
	key: string;
	/** "Weir zone", "Borrowed from Weir". */
	text: string;
	/** Its units. */
	count: number;
	/** How many of them the rest rule placed, in words ("1 placed by nearest upstream"); '' = none. */
	note: string;
	token: string;
	marker: boolean;
}

/**
 * The key's entries, shared by the Network and the Map: each group with the units that are its own or the rest
 * rule's, then, where a group lends its parameters, its borrowed units as their own entry ("Borrowed from Weir"),
 * marked as the drawing marks them.
 */
export function zoneKeyEntries(groups: readonly ZoneGroup[]): ZoneKeyEntry[] {
	const out: ZoneKeyEntry[] = [];
	for (const g of groups) {
		const own = g.units.length - g.borrowed.length;
		const note = g.rest.length ? `${g.rest.length} ${REST_COUNT_WORDS[g.restRule]}` : '';
		if (own) out.push({ key: g.key, text: zoneName(g), count: own, note, token: g.token, marker: false });
		if (g.borrowed.length) out.push({ key: `${g.key}:borrowed`, text: `Borrowed from ${g.name}${g.fitted ? '' : ', not fitted yet'}`, count: g.borrowed.length, note: '', token: g.token, marker: true });
	}
	return out;
}

/** An entry as one line: "Weir zone: 2 units, 1 placed by nearest upstream". */
export const keyEntryText = (e: Pick<ZoneKeyEntry, 'text' | 'count' | 'note'>) => `${e.text}: ${unitCount(e.count)}${e.note ? `, ${e.note}` : ''}`;
