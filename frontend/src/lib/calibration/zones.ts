// Calibration locations in Calibration → Calibration record (issue #659,
// engine 1.110.0, docs/model.md §2.10n; calibrate at several gauges since
// #555): the rows of the locations table (the outlet and every gauge inside
// the network with a record, none special), a tick's and a headline pick's
// effect on the settings, the rows' errors, each record's coverage, the fit
// plan as the fit card shows it, and the steps of a stepwise fit. Pure, so it
// is unit-tested; CalibrationLocationsTable.svelte and FitPanel.svelte are
// thin.
//
// Storage (engine-audit.md CZ2): an inner gauge's location is its row of
// settings.calibrationZones; the outlet's is the top-level calibration
// settings, ticked by settings.calibrateAtOutlet. calibrationSiteNodeId is the
// optional headline pointer (null = auto). Settings from before engine 1.110.0
// (no calibrateAtOutlet) are read through the engine's
// normalizeCalibrationLocations: the readers here (headlineView) do it
// themselves, and the edits (withLocationTicked, withHeadline, withRest) take
// settings already in that shape (the Calibration page adopts them first,
// settingsDraft adopt, and shows the table only then).
import {
	CALIBRATION_PARAMS,
	calibrationRestOf,
	headlineCalibrationSettings,
	headlineLocation,
	locationCalibrationSettings,
	locationFitPlan,
	locationName,
	newCalibrationZone,
	normalizeCalibrationLocations,
	outletNode,
	resolveLocations,
	spannedWaterYears,
	type CalibrationFlowKind,
	type CalibrationRest,
	type CalibrationSite,
	type CalibrationZone,
	type Gr4jParams,
	type LocationKey,
	type ModelInput,
	type NetworkNode,
	type ProjectSettings,
	type SeriesMeta,
	type ZoneFitPlanStep,
	type ZoneFitStep
} from '@water-management/engine';
import { windowError } from '#lib/components/calibration/metrics.js';
import { fmtNum } from '#lib/format/number.js';

type LocNode = Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'> & Partial<Pick<NetworkNode, 'areaKm2'>>;
/** The settings the locations read and write (the form's, or a run's snapshot). */
type LocSettings = Partial<ProjectSettings>;

/** Settings from before engine 1.110.0: no boolean calibrateAtOutlet, so they read through normalizeCalibrationLocations. */
export const isLegacyLocations = (s: { calibrateAtOutlet?: unknown }): boolean => typeof s.calibrateAtOutlet !== 'boolean';

/**
 * The settings in the calibration-locations shape (the engine's normalizeCalibrationLocations; a no-op from engine
 * 1.110.0 on). `hasOutletRecord`: whether the outlet has a flow record of its own (an outlet with none isn't ticked,
 * as the migration decides it).
 */
export function normalizedLocations<S extends { calibrateAtOutlet?: unknown }>(s: S, nodes: readonly LocNode[], hasOutletRecord: boolean): S {
	return isLegacyLocations(s) ? (normalizeCalibrationLocations(s as unknown as ModelInput['settings'], nodes, hasOutletRecord) as unknown as S) : s;
}

/**
 * The settings every reader of "the calibration site" goes through (issue #659): the headline location's window,
 * record, exclusions, quality flags, parameters and fit record over the rest (the engine's
 * headlineCalibrationSettings), so a legacy project reads exactly as before and a project calibrated at several
 * locations reads its headline. Without the nodes (a run that kept no model) the settings as they are.
 */
export function headlineView<S extends object>(s: S, nodes: readonly LocNode[] | null | undefined): S {
	if (!nodes?.length) return s;
	return headlineCalibrationSettings(s as unknown as ProjectSettings, nodes) as unknown as S;
}

/** A run's settings read at its headline (headlineView), with the run's own nodes; null without a settings snapshot. */
export function runHeadlineSettings<S extends object>(run: { settings?: S | null; model?: { nodes?: readonly unknown[] } | null }): S | null {
	if (!run.settings) return null;
	return headlineView(run.settings, (run.model?.nodes ?? null) as readonly LocNode[] | null);
}

/** One location of the table: the outlet or a gauge inside the network. */
export interface LocationRow {
	/** null = the outlet's location (the top-level settings). */
	key: LocationKey;
	/** Its node: the outlet's or the gauge's. */
	nodeId: string;
	name: string;
	kind: 'outlet' | 'gauge';
	/** The flow records it has (never empty for a gauge with a record; empty for a ticked row whose gauge lost its record). */
	records: CalibrationFlowKind[];
	/** A gauge's stored row (null: never ticked); null for the outlet. */
	zone: CalibrationZone | null;
	ticked: boolean;
	/** Its own parameters (the outlet's are settings.gr4j), or null: not fitted yet. */
	params: Gr4jParams | null;
	/** Why it can't be fitted now (its gauge is gone, isn't a gauge inside the network, or has no record), or null. */
	problem: string | null;
	/** It can't be a location at all (its gauge is gone or isn't a gauge inside the network): a run leaves it out. */
	unusable: boolean;
}

/**
 * The locations table's rows: the outlet first when it has a record (or is ticked, so it can be unticked), then every
 * gauge inside the network with a record (`sites`, name order), then any ticked row whose gauge is gone or lost its
 * record (so it can be unticked). `s` is in the locations shape (normalizedLocations).
 */
export function locationRows(nodes: readonly LocNode[], sites: readonly CalibrationSite[], outletRecords: readonly CalibrationFlowKind[], s: LocSettings): LocationRow[] {
	const rows: LocationRow[] = [];
	const outlet = outletNode(nodes);
	const zones = s.calibrationZones ?? [];
	if (outlet && (outletRecords.length || s.calibrateAtOutlet === true))
		rows.push({
			key: null,
			nodeId: outlet.id,
			name: outlet.name,
			kind: 'outlet',
			records: [...outletRecords],
			zone: null,
			ticked: s.calibrateAtOutlet === true,
			params: s.gr4j ? gr4jOf(s.gr4j) : null,
			problem: outletRecords.length ? null : 'no flow record at the outlet yet',
			unusable: false
		});
	for (const site of sites) {
		const zone = zones.find((z) => z.nodeId === site.nodeId) ?? null;
		rows.push({ key: site.nodeId, nodeId: site.nodeId, name: site.name, kind: 'gauge', records: [...site.records], zone, ticked: !!zone?.enabled, params: zone?.gr4j ?? null, problem: null, unusable: false });
	}
	for (const zone of zones) {
		if (!zone.enabled || sites.some((x) => x.nodeId === zone.nodeId)) continue;
		const n = nodes.find((x) => x.id === zone.nodeId);
		const inner = !!n && n.kind === 'gauge' && n.downstreamNodeId !== null;
		rows.push({
			key: zone.nodeId,
			nodeId: zone.nodeId,
			name: n?.name ?? 'A gauge no longer in the model',
			kind: 'gauge',
			records: [],
			zone,
			ticked: true,
			params: zone.gr4j,
			problem: !n ? 'its gauge is no longer in the model' : !inner ? 'it is not a gauge inside the network' : 'it has no flow record',
			unusable: !inner
		});
	}
	return rows;
}

const gr4jOf = (g: Partial<Gr4jParams>): Gr4jParams => Object.fromEntries(CALIBRATION_PARAMS.gr4j.map((p) => [p.key, (g as Record<string, number | undefined>)[p.key] ?? p.default])) as unknown as Gr4jParams;

/** settings.calibrationZones with one gauge ticked or unticked: a first tick adds its row, an untick keeps the row's settings. */
export function withZoneTicked(zones: readonly CalibrationZone[] | null | undefined, nodeId: string, on: boolean): CalibrationZone[] {
	const list = [...(zones ?? [])];
	const i = list.findIndex((z) => z.nodeId === nodeId);
	if (i < 0) return on ? [...list, { ...newCalibrationZone(nodeId), enabled: true }] : list;
	list[i] = { ...list[i]!, enabled: on };
	return list;
}

/** settings.calibrationZones with one row's fields changed (a row is made, unticked, when the gauge has none yet). */
export function withZoneFields(zones: readonly CalibrationZone[] | null | undefined, nodeId: string, patch: Partial<Omit<CalibrationZone, 'nodeId'>>): CalibrationZone[] {
	const list = [...(zones ?? [])];
	const i = list.findIndex((z) => z.nodeId === nodeId);
	if (i < 0) return [...list, { ...newCalibrationZone(nodeId), ...patch }];
	list[i] = { ...list[i]!, ...patch };
	return list;
}

/**
 * The settings with one location ticked or unticked (`key` null: the outlet's Calibrate here, calibrateAtOutlet).
 * Unticking the location the headline pointer names puts the headline back to auto, as a pointer to an unticked
 * location can't be saved (calibrationLocationsError).
 */
export function withLocationTicked<S extends LocSettings>(s: S, nodes: readonly LocNode[], key: LocationKey, on: boolean): S {
	const out: S = key === null ? { ...s, calibrateAtOutlet: on } : { ...s, calibrationZones: withZoneTicked(s.calibrationZones, key, on) };
	const ptr = s.calibrationSiteNodeId ?? null;
	const outletId = outletNode(nodes)?.id;
	if (!on && ptr !== null && (ptr === key || (key === null && ptr === outletId))) return { ...out, calibrationSiteNodeId: null };
	return out;
}

/** The settings with the headline pointer set: a ticked location's node (the outlet's node for the outlet), or null for auto. */
export function withHeadline<S extends LocSettings>(s: S, nodeId: string | null): S {
	return { ...s, calibrationSiteNodeId: nodeId };
}

/** The settings with the rest rule set (what units with no ticked location downstream take). */
export function withRest<S extends LocSettings>(s: S, rest: CalibrationRest): S {
	return { ...s, calibrationRest: rest };
}

/** The rest rule's choices, as the select names them. */
export const REST_LABEL: Record<CalibrationRest, string> = {
	nearest: 'The nearest ticked location upstream on their river',
	headline: 'The headline location’s parameters',
	default: 'The catchment parameters (GR4J parameters, above)'
};

/** The locations as they stand: what's ticked, the headline (and whether it was picked automatically), and each unit's source. */
export interface LocationsState {
	/** The ticked locations' keys, in table order (one that can't be a location left out; one with no record kept: a run still uses it). */
	ticked: LocationKey[];
	/** The headline location (null = the outlet's; meaningless when none is ticked). */
	headline: LocationKey;
	headlineName: string;
	/** No pointer, or one that isn't a ticked location: the headline was picked automatically. */
	auto: boolean;
	rest: CalibrationRest;
	/** Land units the rest rule sends to a location (or to the catchment parameters under 'default'). */
	restUnits: number;
	/** Land units on the catchment parameters (no location's group). */
	defaultUnits: number;
}

/** The locations' state for the table (`s` in the locations shape). */
export function locationsState(nodes: readonly LocNode[], rows: readonly LocationRow[], s: LocSettings): LocationsState {
	const ticked = rows.filter((r) => r.ticked && !r.unusable).map((r) => r.key);
	const headline = headlineLocation(nodes, s);
	const ptr = s.calibrationSiteNodeId ?? null;
	const outletId = outletNode(nodes)?.id;
	const auto = ptr === null || !(headline === null ? ptr === outletId : ptr === headline);
	const base = gr4jOf(s.gr4j ?? {});
	const a = resolveLocations(nodes, s, base, []);
	const sources = Object.values(a?.paramSource ?? {});
	const units = nodes.filter((n) => n.kind === 'farm' && (n.areaKm2 ?? 0) > 0).length;
	return {
		ticked,
		headline,
		headlineName: locationName(nodes, headline),
		auto,
		rest: calibrationRestOf(s),
		restUnits: sources.filter((x) => x.how === 'rest').length,
		// No gauge applies: the outlet's location (ticked or not) and every unit run on settings.gr4j.
		defaultUnits: a ? sources.filter((x) => x.how === 'default').length : s.calibrateAtOutlet === true ? 0 : units
	};
}

/** A gauge row at its defaults (no window, record, exclusions or suspect-day rule of its own): its fold starts closed. */
export const zoneAtDefaults = (z: CalibrationZone): boolean =>
	z.calibrationStart === null && z.calibrationEnd === null && z.calibrationFlowKind === null && !z.calibrationExclusions.length && !z.qualityFlags;

/** A gauge row's fold line: "2001-10-01 – end of record · 2 exclusions · suspect days left out". */
export function zoneWindowLine(z: CalibrationZone): string {
	const n = z.calibrationExclusions.length;
	return [
		`${z.calibrationStart ?? 'start of record'} – ${z.calibrationEnd ?? 'end of record'}`,
		n ? `${fmtNum(n)} exclusion${n === 1 ? '' : 's'}` : null,
		z.qualityFlags ? `suspect days ${z.qualityFlags.suspect === 'include' ? 'scored' : 'left out'}` : null
	]
		.filter(Boolean)
		.join(' · ');
}

/** The first location whose window or exclusions can't be saved, as the save bar names it; null when every row is fine. */
export function zonesError(zones: readonly CalibrationZone[] | null | undefined, name: (nodeId: string) => string): string | null {
	for (const z of zones ?? []) {
		const e = windowError(z.calibrationStart, z.calibrationEnd);
		if (e) return `Calibration location at ${name(z.nodeId)}: ${e}`;
	}
	return null;
}

/**
 * A location's record coverage, in complete water years spanned (1 October to 30 September, gaps not counted: the
 * fit's own notes count the observed days): the record the row fits (its kind, else its gauge record, else its
 * logger). `nodeId` null: the outlet's records (no site). null when the series aren't known.
 */
export function locationCoverage(
	series: readonly Pick<SeriesMeta, 'kind' | 'siteNodeId' | 'startDate' | 'length' | 'lastValueDate' | 'name'>[] | null | undefined,
	nodeId: string | null,
	records: readonly CalibrationFlowKind[],
	kind: CalibrationFlowKind | null
): number | null {
	if (!series) return null;
	const want = kind && records.includes(kind) ? kind : records[0];
	const s = series.find((x) => (x.siteNodeId ?? null) === nodeId && x.kind === want);
	if (!s) return null;
	const end = s.lastValueDate ?? addDays(s.startDate, s.length - 1);
	return spannedWaterYears(s.startDate, end);
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** "3 water years", with the warning the fit will give under 2 (issue #555). */
export function coverageText(years: number | null): string {
	if (years === null) return '–';
	return `${fmtNum(years)} water year${years === 1 ? '' : 's'}${years < 2 ? ' (too short)' : ''}`;
}

/** "X1 900 · X2 0 · X3 220 · X4 3.1", or that the location has none of its own yet. */
export function zoneParamsText(p: Gr4jParams | null | undefined): string {
	if (!p) return 'Not fitted yet: its units run on the catchment parameters';
	const f = (v: number) => fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 2);
	return `X1 ${f(p.x1)} · X2 ${f(p.x2)} · X3 ${f(p.x3)} · X4 ${f(p.x4)}`;
}

/**
 * The fit's plan (the engine's locationFitPlan: the ticked locations in dependency order), or why it can't be made:
 * no location is ticked, a group with no unit draining through its location, or a borrowing cycle. Read from the
 * form and the network as they stand, before any worker starts.
 */
export function fitPlanOf(
	s: LocSettings,
	nodes: readonly NetworkNode[]
): { plan: ZoneFitPlanStep[]; error: null; none: false } | { plan: null; error: string; /** No location is ticked (the page's own state, not a fault). */ none: boolean } {
	// None ticked, read as the engine does (a ticked row that can't be a location doesn't count), so the card can say
	// so as a state rather than as the engine's refusal.
	const n = normalizedLocations(s, nodes, true);
	const none = !(n.calibrateAtOutlet === true && outletNode(nodes)) && !resolveLocations(nodes, n, gr4jOf(n.gr4j ?? {}), []);
	try {
		const input = { settings: s as ModelInput['settings'], model: { nodes: [...nodes], crops: [], cropAreas: [], transfers: [] }, series: {} } as unknown as ModelInput;
		return { plan: locationFitPlan(input), error: null, none: false };
	} catch (e) {
		return { plan: null, error: planErrorText(e instanceof Error ? e.message : String(e)), none };
	}
}

/** The engine's refusal as a sentence: capitalised, with a full stop. */
const planErrorText = (m: string) => `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`;

/** "after Weir and Upper weir", the locations a step is fitted after (its dependencies); null when none. */
export function afterText(step: Pick<ZoneFitPlanStep, 'deps'>, nodes: readonly LocNode[]): string | null {
	const deps = step.deps ?? [];
	if (!deps.length) return null;
	const names = deps.map((k) => locationName(nodes, k));
	return `after ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`;
}

/** One step of the stepwise fit, as the fit card's steps table shows it. */
export interface StepRow {
	key: string;
	step: number;
	name: string;
	/** "Location" or "Headline". */
	what: string;
	/** "after Weir", the locations fitted first that it depends on; null when none. */
	after: string | null;
	units: number;
	/** Of `units`, those borrowed from elsewhere (Parameters from). */
	borrowed: number;
	params: string;
	fit: number | null;
	split: number | null;
	dsst: number | null;
	notes: string[];
}

/** The steps of a stepwise fit, in dependency order, each with its fit's and validation's score on the fit's objective. */
export function stepRows(steps: readonly ZoneFitStep[], nodes: readonly LocNode[] = []): StepRow[] {
	return steps.map((s, i) => {
		const r = s.report;
		const score = (p: { scores: object } | null | undefined) => {
			const v = (p?.scores as Record<string, unknown> | undefined)?.[r.objective];
			return typeof v === 'number' ? v : null;
		};
		const f = (v: number | undefined) => (v === undefined ? '–' : fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 2));
		return {
			key: s.zoneNodeId ?? 'outlet',
			step: i + 1,
			name: s.name,
			what: s.headline ? 'Headline' : 'Location',
			after: afterText(s, nodes),
			units: s.units.length,
			borrowed: s.borrowed?.length ?? 0,
			params: `X1 ${f(r.params.x1)} · X2 ${f(r.params.x2)} · X3 ${f(r.params.x3)} · X4 ${f(r.params.x4)}`,
			fit: score(r.fit),
			split: score(r.splitSample?.validation),
			dsst: score(r.differential?.validation),
			notes: r.notes
		};
	});
}

/** The settings a location's fit read (locationCalibrationSettings on the locations shape), for its fit record. */
export function locationSettings<S extends ProjectSettings>(s: S, nodes: readonly LocNode[], key: LocationKey): S {
	return locationCalibrationSettings(normalizeCalibrationLocations(s as unknown as ModelInput['settings'], nodes) as unknown as S, key);
}
