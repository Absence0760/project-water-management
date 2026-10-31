// Calibration locations (engine 1.110.0, issue #659, docs/model.md §2.10n):
// every gauge with a record, and the outlet, is a calibration location, and
// none is special. A ticked location fits the GR4J X1–X4 of its group of land
// units on its own record, window, exclusions and quality flags.
//
// Storage (provisional, engine-audit.md CZ2): an inner gauge's location is its
// row of settings.calibrationZones (the same row shape since #555); the
// outlet's location is the top-level calibration keys (window, flow kind,
// exclusions, quality flags, `gr4j`, `fitRecord`), ticked by
// `calibrateAtOutlet`. `calibrationSiteNodeId` no longer marks a special zone:
// it is the optional headline pointer, the location whose statistics are
// summary.calibration and that the uncertainty ensemble and automated
// calibration act on (null = auto, headlineLocation).
//
// A land unit's group (resolveLocations), in order:
// 1. settings.unitParamsFrom[unit] when it names a usable ticked location
//    (borrowed: option 2 of the issue, "similar units");
// 2. else its own zone: the first usable ticked location on its downstream
//    path (the outlet counts when ticked);
// 3. else the rest rule, settings.calibrationRest: 'nearest' (the nearest
//    ticked location upstream on its river), 'headline' (the headline's
//    group; the read-time default when the key is absent, so every legacy
//    project runs as before) or 'default' (settings.gr4j).
// Each unit runs GR4J on its group's parameters. A ticked location not fitted
// yet (row gr4j null) takes settings.gr4j, as does a unit in no group.
//
// Settings from before 1.110.0 (no `calibrateAtOutlet`) are read through
// normalizeCalibrationLocations, which gives every legacy project the same
// run and fit, to the bit (locations.legacy.test.ts).
//
// Pure: the nodes and settings are all it reads.
import type { NetworkNode, ProjectSettings } from '../project';
import { mergeSettings } from '../prepare';
import type { ModelInput } from '../project';
import { GR4J_PARAMS, type Gr4jParams } from '../runoff/params';
import { isLandUnit } from '../runoff/area';
import { warn } from '../warningCodes';
import { zoneParamsError, type CalibrationZone } from './zones';

/** What units with no ticked location downstream take (settings.calibrationRest). */
export type CalibrationRest = 'nearest' | 'headline' | 'default';
export const CALIBRATION_RESTS: readonly CalibrationRest[] = ['nearest', 'headline', 'default'];
/** The rule when settings.calibrationRest is absent: the headline's group, as every engine before 1.110.0 ran "the rest". */
export const LEGACY_CALIBRATION_REST: CalibrationRest = 'headline';
/** The rule a new project is created with (the backend writes it; never a read-time default). Provisional, engine-audit.md CZ2. */
export const NEW_PROJECT_CALIBRATION_REST: CalibrationRest = 'nearest';

/**
 * A calibration location by its key: an inner gauge's node id, or null for
 * the outlet's location (the top-level calibration settings).
 */
export type LocationKey = string | null;

/** Where a land unit's GR4J parameters come from (summary.unitRain.paramSource). */
export interface UnitParamSource {
	/** The location whose parameters it runs on (null: the outlet's location, or with `how` 'default' settings.gr4j). */
	from: string | null;
	/** 'zone': its own zone; 'assigned': settings.unitParamsFrom; 'rest': the rest rule; 'default': settings.gr4j (no location). */
	how: 'zone' | 'assigned' | 'rest' | 'default';
}

type LocNode = Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'> & Partial<Pick<NetworkNode, 'areaKm2'>>;

/** One usable ticked location as a run or fit applies it. */
export interface ResolvedLocation {
	/** null = the outlet's location. */
	key: LocationKey;
	/** Its node: the gauge's, or the outlet's. */
	nodeId: string;
	name: string;
	kind: 'gauge' | 'outlet';
	/** Its own-zone land units that aren't borrowed away, node-id order. */
	own: string[];
	/** Land units assigned to it from elsewhere (settings.unitParamsFrom), node-id order. */
	borrowed: string[];
	/** Land units the rest rule sent to it, node-id order. */
	rest: string[];
	/** Its whole group (own + borrowed + rest), node-id order: the units that run on its parameters. */
	units: string[];
	/** Its parameters: the row's, else (not fitted yet, or the outlet) settings.gr4j. */
	params: Gr4jParams;
	/** Whether it had parameters of its own (the outlet's are settings.gr4j: always true). */
	fitted: boolean;
	/** The row (inner gauges); null for the outlet. */
	zone: CalibrationZone | null;
}

export interface LocationAssignment {
	/** The usable ticked locations, upstream first and the headline last (the fit's order when nothing is borrowed). */
	locations: ResolvedLocation[];
	/** The headline location's key (headlineLocation). */
	headline: LocationKey;
	/** Land units on settings.gr4j (no location's group), node-id order. */
	defaultUnits: string[];
	/** Each land unit's parameter source. */
	paramSource: Record<string, UnitParamSource>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The nodes from `id` down to the outlet, `id` first (stops on a loop). */
export function pathDown(byId: ReadonlyMap<string, LocNode>, id: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let cur: string | null = id;
	while (cur !== null && !seen.has(cur)) {
		seen.add(cur);
		out.push(cur);
		cur = byId.get(cur)?.downstreamNodeId ?? null;
	}
	return out;
}

/** The outlet node (the one node that drains into nothing; the run refuses several). */
export const outletNode = <N extends LocNode>(nodes: readonly N[]): N | undefined => nodes.find((n) => n.downstreamNodeId === null);

const landUnitsOf = (nodes: readonly LocNode[]): string[] =>
	nodes
		.filter((n) => n.areaKm2 !== undefined && isLandUnit(n as NetworkNode))
		.map((n) => n.id)
		.sort(cmp);

/**
 * Why a gauge can't be a calibration location of its own (a row), or null:
 * gone, not a gauge, or the outlet (whose location is the top-level settings,
 * ticked by `calibrateAtOutlet`).
 */
export function calibrationLocationError(nodes: readonly LocNode[], nodeId: string): string | null {
	const n = nodes.find((x) => x.id === nodeId);
	if (!n) return 'its gauge is no longer in the model';
	if (n.kind !== 'gauge') return `"${n.name}" is not a gauge`;
	if (n.downstreamNodeId === null) return `"${n.name}" is the outlet, whose location is the catchment's own settings (Calibrate here at the outlet)`;
	return null;
}

/**
 * Why a stored settings' calibration locations can't be saved, or null
 * (structural checks only, the API's save check): a gauge listed twice, a
 * ticked row that can't be a location, or a headline pointer that isn't a
 * ticked gauge inside the network (or the outlet's node with the outlet ticked). A borrowing cycle isn't refused on save:
 * a run doesn't care, and the fit refuses it (locationFitPlan).
 */
export function calibrationLocationsError(nodes: readonly LocNode[], settings: Pick<ProjectSettings, 'calibrationZones' | 'calibrationSiteNodeId'> & Partial<Pick<ProjectSettings, 'calibrateAtOutlet'>>): string | null {
	const seen = new Set<string>();
	for (const z of settings.calibrationZones ?? []) {
		if (seen.has(z.nodeId)) return `the gauge node ${z.nodeId} has two rows`;
		seen.add(z.nodeId);
	}
	for (const z of settings.calibrationZones ?? []) {
		if (!z.enabled) continue;
		const e = calibrationLocationError(nodes, z.nodeId);
		if (e) return `calibration location: ${e}`;
	}
	const h = settings.calibrationSiteNodeId ?? null;
	// The outlet's node is a headline pointer too when the outlet is ticked (headlineLocation reads it so).
	if (h !== null && !(settings.calibrateAtOutlet === true && outletNode(nodes)?.id === h)) {
		const e = calibrationLocationError(nodes, h);
		if (e) return `headline location: ${e}`;
		if (!ticked(settings).some((z) => z.nodeId === h)) return `headline location: "${nodes.find((n) => n.id === h)!.name}" is not a ticked calibration location: tick Calibrate here there, or leave the headline on auto`;
	}
	return null;
}

/**
 * Why settings.unitParamsFrom can't be saved, or null: a key that isn't a
 * land unit, or a value that is neither a gauge inside the network with a row
 * of settings.calibrationZones nor the outlet node. A target that is unticked
 * is allowed (the run warns and the unit takes its own zone).
 */
export function unitParamsFromError(nodes: readonly LocNode[], settings: Pick<ProjectSettings, 'calibrationZones' | 'unitParamsFrom'>): string | null {
	const m = settings.unitParamsFrom;
	if (m == null) return null;
	if (!isObj(m)) return 'the units’ parameter sources must be an object of land unit → location';
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const rows = new Set((settings.calibrationZones ?? []).map((z) => z.nodeId));
	const outlet = outletNode(nodes);
	for (const [u, t] of Object.entries(m)) {
		const n = byId.get(u);
		if (!n || !isLandUnit(n as NetworkNode)) return `parameters from: ${n ? `"${n.name}"` : `the node ${u}`} is not a land unit (a farm with an area)`;
		if (typeof t !== 'string') return `parameters from: "${n.name}" names no location`;
		if (outlet && t === outlet.id) continue;
		const target = byId.get(t);
		if (!target || calibrationLocationError(nodes, t) || !rows.has(t)) return `parameters from: "${n.name}" takes its parameters from ${target ? `"${target.name}"` : `the node ${t}`}, which is not a calibration location`;
	}
	return null;
}

/** The ticked rows. */
const ticked = (s: Pick<ProjectSettings, 'calibrationZones'>): CalibrationZone[] => (s.calibrationZones ?? []).filter((z) => z.enabled);

/** Land-unit area draining to each node (km²). */
function upstreamArea(nodes: readonly LocNode[], byId: ReadonlyMap<string, LocNode>): Map<string, number> {
	const out = new Map<string, number>();
	for (const u of nodes) {
		if (u.areaKm2 === undefined || !isLandUnit(u as NetworkNode)) continue;
		for (const id of pathDown(byId, u.id)) out.set(id, (out.get(id) ?? 0) + (u.areaKm2 || 0));
	}
	return out;
}

/** The usable ticked inner rows (calibrationLocationError), warning of each one that isn't. */
function usableRows(nodes: readonly LocNode[], s: Pick<ProjectSettings, 'calibrationZones'>, warnings: string[]): CalibrationZone[] {
	return ticked(s).filter((z) => {
		const e = calibrationLocationError(nodes, z.nodeId);
		if (e) warnings.push(warn('calibration.zone.unusable', { node: z.nodeId, reason: e }, `Calibration location: ${e}; it is left out and its units take their next location`));
		return !e;
	});
}

/**
 * The headline location (null = the outlet's): settings.calibrationSiteNodeId
 * when it names a usable ticked location, else auto: the outlet when it is
 * ticked, else the ticked location with the largest land-unit area above it,
 * then name, then id. With no ticked location at all: null (a run's
 * statistics and a lone fit score at the outlet, as every engine before).
 * A pointer that isn't a usable ticked location warns (when `warnings` is
 * given) and auto is used.
 */
export function headlineLocation(nodes: readonly LocNode[], settings: Partial<ProjectSettings>, warnings?: string[]): LocationKey {
	const s = normalizedSettings(settings, nodes);
	const rows = usableRows(nodes, s, []);
	const outlet = outletNode(nodes);
	const atOutlet = s.calibrateAtOutlet === true && !!outlet;
	const ptr = s.calibrationSiteNodeId ?? null;
	if (ptr !== null) {
		if (rows.some((z) => z.nodeId === ptr)) return ptr;
		if (outlet && ptr === outlet.id && atOutlet) return null;
		if (warnings) {
			const name = nodes.find((n) => n.id === ptr)?.name;
			warnings.push(
				warn(
					'calibration.site.notTicked',
					{ site: ptr, ...(name ? { name } : {}) },
					`Headline location: ${name ? `"${name}"` : `the node ${ptr}`} is not a ticked calibration location, so the headline is picked automatically (the outlet when it is ticked, else the ticked gauge with the largest area above it)`
				)
			);
		}
	}
	if (atOutlet || !rows.length) return null;
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const area = upstreamArea(nodes, byId);
	const name = (id: string) => byId.get(id)!.name;
	return [...rows].sort((a, b) => (area.get(b.nodeId) ?? 0) - (area.get(a.nodeId) ?? 0) || cmp(name(a.nodeId), name(b.nodeId)) || cmp(a.nodeId, b.nodeId))[0]!.nodeId;
}

/**
 * The settings a fit or a score at one location reads (docs/model.md §2.10n):
 * its node as the site (`calibrationSiteNodeId`), its window, exclusions,
 * record, quality flags, parameters (else settings.gr4j) and fit record.
 * Every other setting is the project's. null = the outlet's location: the
 * settings with the site at the outlet.
 */
export function locationCalibrationSettings<S extends ProjectSettings>(settings: S, key: LocationKey): S {
	if (key === null) return settings.calibrationSiteNodeId == null ? settings : { ...settings, calibrationSiteNodeId: null };
	const z = (settings.calibrationZones ?? []).find((x) => x.nodeId === key);
	if (!z) throw new Error(`no calibration location at gauge node ${key}`);
	return {
		...settings,
		calibrationSiteNodeId: z.nodeId,
		calibrationStart: z.calibrationStart,
		calibrationEnd: z.calibrationEnd,
		calibrationFlowKind: z.calibrationFlowKind,
		calibrationExclusions: z.calibrationExclusions,
		qualityFlags: { ...settings.qualityFlags, ...(z.qualityFlags ? { suspect: z.qualityFlags.suspect, zeroFlowMonths: z.qualityFlags.zeroFlowMonths ?? [] } : {}) },
		gr4j: { ...settings.gr4j, ...(z.gr4j ?? {}) },
		fitRecord: z.fitRecord
	};
}

/**
 * The settings every reader of "the calibration site" goes through (issue
 * #659): the headline location's (locationCalibrationSettings), so
 * summary.calibration, the scored record's flags, the plausibility
 * signatures, the uncertainty ensemble, automated calibration and the
 * evidence pack all read one location. Readers of the outlet *record* (its
 * gauged ranges, gap filling, low-flow periods, the outlet EWR test) keep
 * reading the top level.
 */
export function headlineCalibrationSettings<S extends ProjectSettings>(settings: S, nodes: readonly LocNode[]): S {
	const s = normalizedSettings(settings, nodes) as S;
	const h = headlineLocation(nodes, s);
	// A headline whose row is gone can't be (headlineLocation only names usable rows).
	return locationCalibrationSettings(s, h);
}

/** The settings with the location keys normalised (a no-op on settings from engine 1.110.0 on). */
function normalizedSettings<S extends Partial<ProjectSettings>>(settings: S, nodes: readonly LocNode[]): S {
	return typeof settings.calibrateAtOutlet === 'boolean' ? settings : (normalizeCalibrationLocations(settings as ModelInput['settings'], nodes) as unknown as S);
}

/**
 * Settings from before engine 1.110.0 (no boolean `calibrateAtOutlet`) in
 * the calibration-locations shape (issue #659, docs/model.md §2.10n), so they
 * run and fit as before, to the bit; settings that have it are returned as
 * they are. The backend's SQL migration (slice B of issue #659) does the same.
 *
 * - `calibrationSiteNodeId` names a gauge inside the network (`G`): the
 *   top-level window, flow kind, exclusions, `{ suspect, zeroFlowMonths }`
 *   and GR4J X1–X4 become `G`'s ticked row (replacing a row `G` had), the
 *   fit record moves into it (the top-level one becomes null), every ticked
 *   row at or below `G` is unticked (engines before left them out as
 *   unusable), `calibrateAtOutlet` false and `calibrationRest` 'headline';
 *   `G` stays the headline pointer. The top level keeps its values, which are
 *   the outlet record's settings.
 * - otherwise (the outlet, or a site that is gone or isn't an inner gauge,
 *   which engines before scored at the outlet): the pointer becomes null,
 *   `calibrateAtOutlet` = `hasOutletRecord` and `calibrationRest`
 *   'headline', or 'default' without an outlet record (the units left over
 *   took settings.gr4j either way).
 *
 * The engine's read path passes `hasOutletRecord` true: a fit that refused
 * at an outlet with no record still refuses there, as before. The migration
 * knows the records and passes the truth.
 */
export function normalizeCalibrationLocations(raw: ModelInput['settings'], nodes: readonly LocNode[], hasOutletRecord = true, warnings: string[] = []): ModelInput['settings'] {
	if (!isObj(raw)) return raw;
	if (typeof raw.calibrateAtOutlet === 'boolean') return raw;
	// The values the engines before read (sanitised), whatever the stored shape.
	const m = mergeSettings(raw, []);
	return { ...raw, ...locationPatch(m, nodes, hasOutletRecord, warnings) } as ModelInput['settings'];
}

/** The keys normalizeCalibrationLocations writes, from merged settings. */
export function locationPatch(m: ProjectSettings, nodes: readonly LocNode[], hasOutletRecord: boolean, warnings: string[]): Partial<ProjectSettings> {
	const site = m.calibrationSiteNodeId ?? null;
	const byId = new Map(nodes.map((n) => [n.id, n]));
	if (site !== null && !calibrationLocationError(nodes, site)) {
		const below = new Set(pathDown(byId, site));
		const gr4j = Object.fromEntries(GR4J_PARAMS.map((s) => [s.key, (m.gr4j as unknown as Record<string, unknown>)[s.key] ?? s.default])) as unknown as Gr4jParams;
		const zeroFlowMonths = m.qualityFlags.zeroFlowMonths ?? [];
		const row: CalibrationZone = {
			nodeId: site,
			enabled: true,
			calibrationStart: m.calibrationStart ?? null,
			calibrationEnd: m.calibrationEnd ?? null,
			calibrationFlowKind: m.calibrationFlowKind ?? null,
			calibrationExclusions: structuredClone(m.calibrationExclusions ?? []),
			qualityFlags: { suspect: m.qualityFlags.suspect, ...(zeroFlowMonths.length ? { zeroFlowMonths: [...zeroFlowMonths] } : {}) },
			gr4j: zoneParamsError(gr4j) ? null : gr4j,
			fitRecord: m.fitRecord ?? null
		};
		const rows = (m.calibrationZones ?? []).filter((z) => z.nodeId !== site).map((z) => (z.enabled && below.has(z.nodeId) ? { ...z, enabled: false } : z));
		return { calibrationZones: [...rows, row], fitRecord: null, calibrateAtOutlet: false, calibrationRest: 'headline', calibrationSiteNodeId: site };
	}
	if (site !== null) {
		// The words engines before warned with (calibrationSiteError), so the warning reads the same.
		const n = byId.get(site);
		const err = !n ? 'the calibration site is no longer in the model' : n.kind !== 'gauge' ? `the calibration site "${n.name}" is not a gauge` : `the calibration site "${n.name}" is the outlet`;
		warnings.push(
			warn('calibration.site.unusable', { site, reason: err }, `Calibration site: ${err}. Until it is changed, the run’s calibration statistics and a fit use the outlet’s record (pick a gauge in Calibration → Calibration record).`)
		);
	}
	return { calibrateAtOutlet: hasOutletRecord, calibrationRest: hasOutletRecord ? 'headline' : 'default', calibrationSiteNodeId: null };
}

/** The input with its settings normalised (normalizeCalibrationLocations), for code that writes a location's keys. */
export const normalizedInput = (input: ModelInput): ModelInput => {
	const settings = normalizeCalibrationLocations(input.settings, input.model.nodes);
	return settings === input.settings ? input : { ...input, settings };
};

/** settings.calibrationRest as read: a known rule, else (absent or not one) the legacy 'headline'. */
export const calibrationRestOf = (s: Pick<ProjectSettings, 'calibrationRest'>): CalibrationRest =>
	(CALIBRATION_RESTS as readonly unknown[]).includes(s.calibrationRest) ? (s.calibrationRest as CalibrationRest) : LEGACY_CALIBRATION_REST;

/**
 * The locations a run or fit applies (docs/model.md §2.10n), or null when
 * every land unit runs on settings.gr4j: no usable ticked gauge (the outlet's
 * location, ticked or not, runs on settings.gr4j). An unusable ticked row, a
 * stale assignment and a headline pointer that isn't ticked warn. `base` is
 * settings.gr4j, resolved.
 */
export function resolveLocations(nodes: readonly LocNode[], settings: Partial<ProjectSettings>, base: Gr4jParams, warnings: string[]): LocationAssignment | null {
	const s = normalizedSettings(settings, nodes);
	const rows = usableRows(nodes, s, warnings);
	const outlet = outletNode(nodes);
	const atOutlet = s.calibrateAtOutlet === true && !!outlet;
	const from = isObj(s.unitParamsFrom) ? (s.unitParamsFrom as Record<string, unknown>) : {};
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const rowIds = new Set(rows.map((z) => z.nodeId));
	// Stale assignments warn whether or not any gauge applies.
	const target = (u: string): LocationKey | undefined => {
		const t = from[u];
		if (t === undefined || t === null) return undefined;
		if (typeof t === 'string' && outlet && t === outlet.id && atOutlet) return null;
		if (typeof t === 'string' && rowIds.has(t)) return t;
		const unit = byId.get(u)?.name ?? u;
		const what = typeof t === 'string' ? (byId.get(t)?.name ? `"${byId.get(t)!.name}"` : `the node ${t}`) : 'no location';
		warnings.push(
			warn('calibration.zone.assignStale', { unit: u, target: String(t) }, `Parameters from: "${unit}" takes its parameters from ${what}, which is not a ticked calibration location, so it takes its own zone's`)
		);
		return undefined;
	};
	const units = landUnitsOf(nodes);
	const assigned = new Map<string, LocationKey>();
	for (const u of units) {
		const t = target(u);
		if (t !== undefined) assigned.set(u, t);
	}
	if (!rows.length) return null;

	const headline = headlineLocation(nodes, s, warnings);
	const locKeys: LocationKey[] = [...rows.map((z) => z.nodeId), ...(atOutlet ? [null] : [])];
	const nodeOf = (k: LocationKey) => (k === null ? outlet!.id : k);
	const nameOf = (k: LocationKey) => byId.get(nodeOf(k))!.name;
	const own = (u: string): LocationKey | undefined => {
		for (const id of pathDown(byId, u)) {
			if (rowIds.has(id)) return id;
			if (atOutlet && id === outlet!.id) return null;
		}
		return undefined;
	};
	const rule = calibrationRestOf(s);
	const nearest = (u: string): LocationKey | undefined => {
		const path = pathDown(byId, u);
		for (const x of path) {
			let best: { k: LocationKey; hops: number } | null = null;
			for (const k of locKeys) {
				const hops = pathDown(byId, nodeOf(k)).indexOf(x);
				if (hops < 0) continue;
				if (!best || hops < best.hops || (hops === best.hops && (cmp(nameOf(k), nameOf(best.k)) || cmp(nodeOf(k), nodeOf(best.k))) < 0)) best = { k, hops };
			}
			if (best) return best.k;
		}
		return undefined;
	};
	const DEFAULT = '\u0000default';
	const group = new Map<string, LocationKey | typeof DEFAULT>();
	// Keyed by node id, which a project's data names: a Map, made into the record by Object.fromEntries so no id can reach a prototype.
	const sources = new Map<string, UnitParamSource>();
	const ownOf = new Map<string, LocationKey | undefined>();
	for (const u of units) {
		const o = own(u);
		ownOf.set(u, o);
		if (assigned.has(u) && assigned.get(u) !== o) {
			group.set(u, assigned.get(u)!);
			sources.set(u, { from: assigned.get(u)!, how: 'assigned' });
		} else if (o !== undefined) {
			group.set(u, o);
			sources.set(u, { from: o, how: 'zone' });
		} else {
			const r = rule === 'headline' ? headline : rule === 'nearest' ? nearest(u) : undefined;
			if (r === undefined) {
				group.set(u, DEFAULT);
				sources.set(u, { from: null, how: 'default' });
			} else {
				group.set(u, r);
				sources.set(u, { from: r, how: 'rest' });
			}
		}
	}
	const paramSource: Record<string, UnitParamSource> = Object.fromEntries(sources);
	const row = new Map(rows.map((z) => [z.nodeId, z]));
	// Upstream first: a location with more ticked locations (other than the headline) below it is further up (one that
	// drains through another always has more), then by name and id; the outlet after the gauges, the headline last.
	const below = (k: LocationKey) => (k === null ? 0 : pathDown(byId, k).slice(1).filter((x) => locKeys.includes(x) && x !== headline).length);
	const locations = locKeys
		.map((k): ResolvedLocation => {
			const z = k === null ? null : row.get(k)!;
			const inGroup = units.filter((u) => group.get(u) === k);
			return {
				key: k,
				nodeId: nodeOf(k),
				name: nameOf(k),
				kind: k === null ? 'outlet' : 'gauge',
				own: inGroup.filter((u) => sources.get(u)!.how === 'zone'),
				borrowed: inGroup.filter((u) => sources.get(u)!.how === 'assigned'),
				rest: inGroup.filter((u) => sources.get(u)!.how === 'rest'),
				units: inGroup,
				params: z?.gr4j ? { ...z.gr4j } : { ...base },
				fitted: z ? !!z.gr4j : true,
				zone: z
			};
		})
		.sort(
			(a, b) =>
				Number(a.key === headline) - Number(b.key === headline) ||
				Number(a.key === null) - Number(b.key === null) ||
				below(b.key) - below(a.key) ||
				cmp(a.name, b.name) ||
				cmp(a.nodeId, b.nodeId)
		);
	for (const l of locations) {
		if (!l.fitted) warnings.push(warn('calibration.zone.unfitted', { node: l.nodeId, name: l.name }, `Calibration zone "${l.name}" has no parameters of its own yet: its units run on the catchment's GR4J parameters until it is fitted`));
	}
	if (rule === 'nearest') {
		for (const l of locations) {
			if (!l.rest.length) continue;
			warnings.push(
				warn(
					'calibration.zone.restNearest',
					{ units: l.rest.length, node: l.nodeId, name: l.name },
					`${l.rest.length} land unit${l.rest.length === 1 ? '' : 's'} outside every calibration location take${l.rest.length === 1 ? 's' : ''} the parameters of "${l.name}", the nearest ticked location upstream on ${l.rest.length === 1 ? 'its' : 'their'} river`
				)
			);
		}
	}
	// The uncertainty ensemble and automated calibration vary the headline's group only (docs/followups.md § #555).
	const others = locations.filter((l) => l.key !== headline);
	const zoned = others.reduce((n, l) => n + l.units.length, 0);
	if (zoned)
		warnings.push(
			warn(
				'calibration.zone.siteOnlyElsewhere',
				{ units: zoned, zones: others.length },
				`Calibration zones: ${zoned} land unit${zoned === 1 ? '' : 's'} ran on ${others.length === 1 ? 'a calibration zone’s' : 'calibration zones’'} own GR4J parameters. The uncertainty ensemble and automated calibration still vary only the calibration site’s parameters (Calibration → Flow calibration)`
			)
		);
	return { locations, headline, defaultUnits: units.filter((u) => group.get(u) === DEFAULT), paramSource };
}

/**
 * Each land unit's parameters under the locations (`fit`'s group takes
 * `free` instead, for the location being fitted), or undefined when no
 * location applies (every unit takes `base`, as before).
 */
export function locationParamsOf(a: LocationAssignment | null, base: Gr4jParams, fit?: { key: LocationKey; free: Gr4jParams }): ((unitId: string) => Gr4jParams) | undefined {
	if (!a) return undefined;
	const of = new Map<string, Gr4jParams>();
	for (const l of a.locations) {
		const p = fit && fit.key === l.key ? fit.free : l.params;
		for (const u of l.units) of.set(u, p);
	}
	return (id) => of.get(id) ?? base;
}

/** The input with one location's parameters replaced (a fit step's result, fixed for the steps after it): a row's `gr4j`, or for the outlet settings.gr4j. */
export function withLocationParams(input: ModelInput, key: LocationKey, params: Gr4jParams): ModelInput {
	const s = input.settings ?? {};
	if (key === null) return { ...input, settings: { ...s, gr4j: { ...((s.gr4j as object | undefined) ?? {}), ...params } } as ModelInput['settings'] };
	const rows = (s.calibrationZones as CalibrationZone[] | null | undefined) ?? [];
	if (!rows.some((z) => z.nodeId === key)) throw new Error(`no calibration location at gauge node ${key}: normalise the settings first (normalizeCalibrationLocations)`);
	// Over the row's own (else settings.gr4j's X1–X4, which an unfitted row runs on), so a partial set keeps the rest.
	const top = (s.gr4j as Record<string, unknown> | undefined) ?? {};
	const fallback = Object.fromEntries(GR4J_PARAMS.flatMap((p) => (typeof top[p.key] === 'number' ? [[p.key, top[p.key]]] : [])));
	return { ...input, settings: { ...s, calibrationZones: rows.map((z) => (z.nodeId === key ? { ...z, gr4j: { ...(z.gr4j ?? fallback), ...params } as Gr4jParams } : z)) } };
}

/**
 * The input with the headline location's parameters replaced, as the
 * uncertainty ensemble and automated calibration vary them (`key` the
 * headline's). For settings from before engine 1.110.0 (no boolean
 * `calibrateAtOutlet`) the top-level `gr4j` takes them too: there the site's
 * parameters were `gr4j`, which every ticked row not fitted yet ran on as
 * well, so a member or a case moves those rows' units as engines before did.
 */
export function withHeadlineParams(input: ModelInput, key: LocationKey, params: Gr4jParams): ModelInput {
	const legacy = isObj(input.settings) && typeof input.settings.calibrateAtOutlet !== 'boolean';
	const out = withLocationParams(normalizedInput(input), key, params);
	return legacy && key !== null ? withLocationParams(out, null, params) : out;
}

/** The input with one location's record kind set (the uncertainty ensemble scores each record in turn): a row's, or for the outlet the top level's. */
export function withLocationFlowKind(input: ModelInput, key: LocationKey, kind: ProjectSettings['calibrationFlowKind']): ModelInput {
	const s = input.settings ?? {};
	if (key === null) return { ...input, settings: { ...s, calibrationFlowKind: kind } };
	const rows = (s.calibrationZones as CalibrationZone[] | null | undefined) ?? [];
	if (!rows.some((z) => z.nodeId === key)) throw new Error(`no calibration location at gauge node ${key}: normalise the settings first (normalizeCalibrationLocations)`);
	return { ...input, settings: { ...s, calibrationZones: rows.map((z) => (z.nodeId === key ? { ...z, calibrationFlowKind: kind } : z)) } };
}

/** The name of a location: its gauge's, or the outlet's. */
export function locationName(nodes: readonly LocNode[], key: LocationKey): string {
	if (key !== null) return nodes.find((n) => n.id === key)?.name ?? key;
	return outletNode(nodes)?.name ?? 'the outlet';
}

/** One step of a fit plan: a location, its group, and the locations fitted before it that it depends on. */
export interface ZoneFitPlanStep {
	/** The location: a gauge's node id, or null for the outlet's location. */
	zoneNodeId: LocationKey;
	name: string;
	/** Its group's land units (own, borrowed and rest), node-id order. */
	units: string[];
	/** The units in `units` borrowed from elsewhere (settings.unitParamsFrom); absent on a plan from before 1.110.0. */
	borrowed?: string[];
	/** The locations it depends on (deps(L): the groups of every unit draining to it), fitted before it. */
	deps?: LocationKey[];
	/** It is the headline location. */
	headline?: boolean;
}

/**
 * The fit order of the ticked locations (docs/model.md §2.10n), a dependency
 * order: L depends on the group of every land unit draining to L's node
 * (every unit for the outlet), but its own and the settings.gr4j units'.
 * Kahn's sort; among the ready steps the headline goes last, then the one
 * with more ticked locations below first, then name, then id. Throws, before
 * any step runs, when no location is ticked, a group has no unit draining
 * through its location (its score couldn't move with its parameters), or the
 * borrowing makes a cycle.
 */
export function locationFitPlan(input: ModelInput): ZoneFitPlanStep[] {
	const nodes = input.model.nodes;
	const settings = mergeSettings(input.settings, [], nodes);
	const base = Object.fromEntries(GR4J_PARAMS.map((s) => [s.key, s.default])) as unknown as Gr4jParams;
	const a = resolveLocations(nodes, settings, base, []);
	const outlet = outletNode(nodes);
	if (!a) {
		if (settings.calibrateAtOutlet === true && outlet) return [{ zoneNodeId: null, name: outlet.name, units: landUnitsOf(nodes), borrowed: [], deps: [], headline: true }];
		throw new Error('no calibration location is ticked: tick Calibrate here at the outlet or at a gauge (Calibration → Calibration record), or run on the catchment parameters without a fit');
	}
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const groupOf = new Map<string, LocationKey>();
	for (const l of a.locations) for (const u of l.units) groupOf.set(u, l.key);
	const drainsTo = (u: string, node: string) => pathDown(byId, u).includes(node);
	for (const l of a.locations) {
		if (!l.units.length)
			throw new Error(
				`the calibration location "${l.name}" has no land unit in its group (none drains to it that isn't in a location further up or borrowed elsewhere): untick it, or give it units`
			);
		if (!l.units.some((u) => drainsTo(u, l.nodeId)))
			throw new Error(
				`none of the land units in the group of "${l.name}" drains through it (they are all borrowed or beside it), so its fit could not move its own score: untick it, or change a unit's Parameters from`
			);
	}
	const key = (k: LocationKey) => (k === null ? '\u0000outlet' : k);
	const deps = new Map<string, Set<LocationKey>>();
	for (const l of a.locations) {
		const d = new Set<LocationKey>();
		for (const [u, g] of groupOf) if (g !== l.key && drainsTo(u, l.nodeId)) d.add(g);
		deps.set(key(l.key), d);
	}
	const order: ResolvedLocation[] = [];
	const done = new Set<string>();
	const left = [...a.locations];
	while (left.length) {
		// a.locations is the priority order (headline last, upstream first): the first ready one goes next.
		const i = left.findIndex((l) => [...deps.get(key(l.key))!].every((d) => done.has(key(d))));
		if (i < 0) throw new Error(cycleText(left, deps, key));
		const [l] = left.splice(i, 1);
		order.push(l!);
		done.add(key(l!.key));
	}
	return order.map((l) => ({
		zoneNodeId: l.key,
		name: l.name,
		units: [...l.units],
		borrowed: [...l.borrowed],
		deps: order.filter((x) => deps.get(key(l.key))!.has(x.key)).map((x) => x.key),
		...(l.key === a.headline ? { headline: true } : {})
	}));
}

/** The refusal of a borrowing cycle, naming the locations on it. */
function cycleText(left: readonly ResolvedLocation[], deps: ReadonlyMap<string, ReadonlySet<LocationKey>>, key: (k: LocationKey) => string): string {
	const byKey = new Map(left.map((l) => [key(l.key), l]));
	// Walk unmet dependencies from the first stuck location until one repeats: that stretch is a cycle.
	const seen: string[] = [];
	let cur = key(left[0]!.key);
	while (!seen.includes(cur)) {
		seen.push(cur);
		const next = [...deps.get(cur)!].map(key).find((d) => byKey.has(d));
		if (next === undefined) break;
		cur = next;
	}
	const cycle = seen.slice(Math.max(0, seen.indexOf(cur))).map((k) => byKey.get(k)!.name);
	if (cycle.length === 2)
		return `the units above "${cycle[0]}" borrow "${cycle[1]}"'s parameters and the units above "${cycle[1]}" borrow "${cycle[0]}"'s, so neither can be fitted first: change one unit's Parameters from`;
	return `the calibration locations ${cycle.map((n) => `"${n}"`).join(' → ')} each need another's parameters fitted first (a unit above each borrows from the next), so none can be fitted first: change one unit's Parameters from`;
}
