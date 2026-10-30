// Parameters from (issue #659 option 2, "similar units"; docs/model.md §2.10n,
// docs/ui.md § Settings & calibration): each land unit with the calibration
// location whose GR4J parameters it runs on, and the choice that sends it to
// another ticked location's (settings.unitParamsFrom). The rows, their
// options and what each unit then runs on come from the engine's own rule
// (resolveLocations), and the live refusal from its fit plan
// (locationFitPlan), so what the table says is what the next run and fit do.
// Pure; UnitParamsTable.svelte lays it out.
import {
	calibrationLocationError,
	calibrationRestOf,
	GR4J_PARAMS,
	locationFitPlan,
	normalizeCalibrationLocations,
	outletNode,
	resolveLocations,
	type Gr4jParams,
	type ModelInput,
	type NetworkNode,
	type ProjectSettings,
	type UnitParamSource
} from '@water-management/engine';
import { REST_WORDS } from './zoneGroups';

export type UnitParamsSettings = Pick<ProjectSettings, 'calibrationZones' | 'calibrationSiteNodeId' | 'gr4j'> &
	Partial<Pick<ProjectSettings, 'calibrateAtOutlet' | 'calibrationRest' | 'unitParamsFrom'>>;

/** A ticked location a unit can take its parameters from. */
export interface LocationChoice {
	/** Its node: a gauge's, or the outlet's (settings.unitParamsFrom's value). */
	nodeId: string;
	/** "Weir", or "Outflow gauge (outlet)". */
	label: string;
}

export interface UnitParamsOption {
	/** '' = its own zone (no entry in settings.unitParamsFrom), else a location's node id. */
	value: string;
	label: string;
}

export interface UnitParamsRow {
	unitId: string;
	name: string;
	/** settings.unitParamsFrom's entry for it, or '' (its own zone). */
	value: string;
	options: UnitParamsOption[];
	/** What it runs on now, in words: "Weir (its own zone)", "Weir (borrowed)", "Kloof (nearest upstream)", "The catchment parameters". */
	runsOn: string;
	/** Its entry names a location that isn't a ticked one (gone, or unticked): it takes its own zone's until changed. */
	stale: boolean;
}

/** A land unit: a farm with an area (the engine's isLandUnit, runoff/area.ts). */
const isLandUnit = (n: NetworkNode) => n.kind === 'farm' && n.areaKm2 > 0;

const resolvedGr4j = (g: Partial<Gr4jParams> | null | undefined): Gr4jParams =>
	Object.fromEntries(GR4J_PARAMS.map((p) => [p.key, typeof g?.[p.key] === 'number' ? g[p.key] : p.default])) as unknown as Gr4jParams;

/** The settings in the locations' shape (a no-op from engine 1.110.0 on), with `assignments` as Parameters from. */
function located(nodes: readonly NetworkNode[], settings: UnitParamsSettings, assignments: Record<string, string> | null | undefined): ProjectSettings {
	const s = normalizeCalibrationLocations(settings as ModelInput['settings'], nodes) as unknown as ProjectSettings;
	return { ...s, unitParamsFrom: assignments ?? null };
}

/** The ticked locations a unit can be given, gauges by name, then the outlet when it is ticked. */
export function locationChoices(nodes: readonly NetworkNode[], settings: UnitParamsSettings): LocationChoice[] {
	const s = located(nodes, settings, null);
	const name = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
	const gauges = (s.calibrationZones ?? [])
		.filter((z) => z.enabled && !calibrationLocationError(nodes, z.nodeId))
		.map((z) => ({ nodeId: z.nodeId, label: name(z.nodeId) }))
		.sort((a, b) => a.label.localeCompare(b.label) || (a.nodeId < b.nodeId ? -1 : 1));
	const outlet = outletNode(nodes);
	return s.calibrateAtOutlet === true && outlet ? [...gauges, { nodeId: outlet.id, label: `${outlet.name} (outlet)` }] : gauges;
}

/** Each land unit's parameter source under `s`; every unit on the catchment parameters (or the outlet's, when only it is ticked) when no gauge applies. */
function sources(nodes: readonly NetworkNode[], s: ProjectSettings): Record<string, UnitParamSource> {
	const a = resolveLocations(nodes, s, resolvedGr4j(s.gr4j), []);
	if (a) return a.paramSource;
	const atOutlet = s.calibrateAtOutlet === true && !!outletNode(nodes);
	return Object.fromEntries(nodes.filter(isLandUnit).map((n) => [n.id, atOutlet ? { from: null, how: 'zone' as const } : { from: null, how: 'default' as const }]));
}

/**
 * The table's rows: every land unit (name order), its choice, its options (its own zone, or the rule for units
 * outside every location when it has none, then every other ticked location) and what it runs on now. [] when no
 * location is ticked (every unit runs on the catchment parameters; the page says so).
 */
export function unitParamsRows(nodes: readonly NetworkNode[], settings: UnitParamsSettings, assignments: Record<string, string> | null | undefined): UnitParamsRow[] {
	const choices = locationChoices(nodes, settings);
	if (!choices.length) return [];
	const s = located(nodes, settings, assignments);
	const outlet = outletNode(nodes);
	const name = (id: string | null) => (id === null ? (outlet?.name ?? 'the outlet') : (nodes.find((n) => n.id === id)?.name ?? id));
	const rule = calibrationRestOf(s);
	const words = (src: UnitParamSource | undefined): string => {
		if (!src || src.how === 'default') return 'The catchment parameters';
		const where = name(src.from);
		return src.how === 'zone' ? `${where} (its own zone)` : src.how === 'assigned' ? `${where} (borrowed)` : `${where} (${REST_WORDS[rule]})`;
	};
	// What each unit takes with no choice of its own: its own zone, else the rule for units outside every location.
	const own = sources(nodes, { ...s, unitParamsFrom: null });
	const now = sources(nodes, s);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const chosen = assignments ?? {};
	return nodes
		.filter(isLandUnit)
		.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
		.map((u) => {
			const base = own[u.id];
			// Its own location's node (null = none), so the list doesn't offer it twice.
			const ownNode = base && base.how !== 'default' ? (base.from ?? outlet?.id ?? null) : null;
			const first: UnitParamsOption = {
				value: '',
				label:
					!base || base.how === 'default'
						? 'The catchment parameters (no location)'
						: base.how === 'zone'
							? `Its own zone (${name(base.from)})`
							: `${REST_WORDS[rule].charAt(0).toUpperCase()}${REST_WORDS[rule].slice(1)} (${name(base.from)})`
			};
			const value = typeof chosen[u.id] === 'string' ? chosen[u.id]! : '';
			const options = [first, ...choices.filter((c) => c.nodeId !== ownNode).map((c) => ({ value: c.nodeId, label: c.label }))];
			const stale = value !== '' && !choices.some((c) => c.nodeId === value);
			if (stale) options.push({ value, label: `${byId.get(value)?.name ?? 'A node no longer in the model'} (not a ticked location)` });
			// Its own location chosen by name: the same as its own zone, listed as the first option.
			return { unitId: u.id, name: u.name, value: value === ownNode ? '' : value, options, runsOn: words(now[u.id]), stale };
		});
}

/** Parameters from with one unit's choice set ('' or null = its own zone), or null when no unit has one. */
export function withUnitParamsFrom(assignments: Record<string, string> | null | undefined, unitId: string, target: string | null): Record<string, string> | null {
	const next = { ...(assignments ?? {}) };
	if (target) next[unitId] = target;
	else delete next[unitId];
	return Object.keys(next).length ? next : null;
}

/** "Every unit takes its own zone’s" or "2 units borrow another location’s parameters" (the fold's line). */
export function unitParamsLine(rows: readonly UnitParamsRow[]): string {
	const n = rows.filter((r) => r.value !== '').length;
	if (!n) return 'every unit takes its own zone’s';
	return `${n} unit${n === 1 ? '' : 's'} borrow${n === 1 ? 's' : ''} another location’s parameters`;
}

/**
 * Why Fit automatically would refuse these settings (the engine's fit plan, locationFitPlan): a borrowing cycle, or
 * a location left with no unit draining through it; null when it would fit, or when no location is ticked (the page
 * says that itself).
 */
export function unitParamsPlanError(nodes: readonly NetworkNode[], settings: UnitParamsSettings, assignments: Record<string, string> | null | undefined): string | null {
	if (!locationChoices(nodes, settings).length) return null;
	try {
		locationFitPlan({ model: { nodes: [...nodes] }, settings: located(nodes, settings, assignments) } as unknown as ModelInput);
		return null;
	} catch (e) {
		const text = e instanceof Error ? e.message : String(e);
		return `Fit automatically can’t run: ${text}.`;
	}
}
