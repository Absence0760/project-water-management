// Calibration zones (engine 1.106.0, issue #555, docs/model.md §2.10n): GR4J
// parameters per zone of the network, each zone fitted on the record of its own
// gauge, upstream first.
//
// The primary site (settings.calibrationSiteNodeId: null = the outlet, else an
// inner gauge, §2.10k) keeps today's settings: settings.gr4j, the calibration
// window, exclusions, flow kind, quality flags and fitRecord are its. Each
// ticked entry of settings.calibrationZones adds a zone above it: the land units
// draining to that gauge that aren't in a ticked zone further upstream, with
// their own GR4J X1–X4 and their own record settings. The primary zone is the
// rest. Unticking a gauge (enabled false) keeps its row and merges its units into
// the next ticked gauge downstream. Only under Per unit flow generation (§2.4h):
// under Fragmentation one GR4J runs for the whole catchment, so the zones are
// ignored with a warning. No ticked zone (absent, [] or every row unticked) is
// every engine before: one parameter set, to the bit.
//
// Pure: the nodes and settings are all it reads.
import type { CalibrationFlowKind, NetworkNode, ProjectSettings } from '../project';
import { GR4J_PARAMS, type Gr4jParams } from '../runoff/params';
import { exclusionsError, sanitizeExclusions, type CalibrationExclusion, type FitRecord } from './provenance';
import { FLAG_USES, zeroFlowMonthsError, type FlagUse } from './qualityFlagSettings';
import { isLandUnit } from '../runoff/area';
import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';

/** The record settings a zone's fit treats flagged days by (a gauge has no gauged range or gap fill, §2.10k). */
export interface ZoneQualityFlags {
	suspect: FlagUse;
	/** Months the river is known to stop at this gauge (QualityFlagSettings.zeroFlowMonths); absent = none. */
	zeroFlowMonths?: number[];
}

/** One gauge of settings.calibrationZones: a row of Settings & calibration → Calibration record. */
export interface CalibrationZone {
	/** The gauge node inside the network, with an observed record of its own (a GaugeSeriesKey series). */
	nodeId: string;
	/** Calibrate here. False keeps the row but merges its zone into the next ticked site downstream. */
	enabled: boolean;
	/** The zone's calibration window (ISO dates, inclusive); null = the whole record. */
	calibrationStart: string | null;
	calibrationEnd: string | null;
	/** The gauge's record to fit (null = its gauge record, else its logger). */
	calibrationFlowKind: CalibrationFlowKind | null;
	/** Periods left out of the zone's scores, each with a reason. */
	calibrationExclusions: CalibrationExclusion[];
	/** How the zone's fit treats flagged days; null = the catchment's (settings.qualityFlags). */
	qualityFlags: ZoneQualityFlags | null;
	/** The zone's GR4J X1–X4; null = not fitted yet, so its units take settings.gr4j. */
	gr4j: Gr4jParams | null;
	/** The fit whose parameters Apply wrote into `gr4j`; null = none. */
	fitRecord: FitRecord | null;
}

/** At most this many zone rows (a network has far fewer gauges with records). */
export const CALIBRATION_ZONES_MAX = 50;

/** A new, unticked row for a gauge: the catchment's settings until changed. */
export function newCalibrationZone(nodeId: string): CalibrationZone {
	return { nodeId, enabled: false, calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null, calibrationExclusions: [], qualityFlags: null, gr4j: null, fitRecord: null };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Why a zone's GR4J parameters can't be used, or null (each inside the bounds calibration searches). */
export function zoneParamsError(v: unknown): string | null {
	if (v === null) return null;
	if (!isObj(v)) return 'the GR4J parameters must be an object';
	for (const s of GR4J_PARAMS) {
		const x = v[s.key];
		if (typeof x !== 'number' || !Number.isFinite(x) || x < s.min || x > s.max) return `${s.label} must be ${s.min}–${s.max} ${s.unit}`;
	}
	return null;
}

/**
 * A stored settings.calibrationZones as the engine reads it: every usable row,
 * in stored order. A row that isn't one is dropped with a warning; a bad field
 * falls back to the catchment's (null) with one.
 */
export function sanitizeCalibrationZones(raw: unknown, warnings: string[]): CalibrationZone[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) {
		warnings.push('the calibration zones are not a list; calibrating at one site');
		return [];
	}
	const out: CalibrationZone[] = [];
	const seen = new Set<string>();
	for (const z of raw.slice(0, CALIBRATION_ZONES_MAX)) {
		if (!isObj(z) || typeof z.nodeId !== 'string' || !z.nodeId) {
			warnings.push('a calibration zone without a gauge is ignored');
			continue;
		}
		if (seen.has(z.nodeId)) {
			warnings.push(`the calibration zone at gauge node ${z.nodeId} is listed twice; the first is used`);
			continue;
		}
		seen.add(z.nodeId);
		const e = zoneParamsError(z.gr4j ?? null);
		const ticked = z.enabled === true;
		// Only a ticked row's problems warn: an unticked row changes nothing a run does, its warnings included.
		if (e && ticked) warnings.push(`calibration zone at gauge node ${z.nodeId}: ${e}; its units take the catchment's parameters`);
		const qf = isObj(z.qualityFlags) && (FLAG_USES as readonly unknown[]).includes(z.qualityFlags.suspect) && !zeroFlowMonthsError(z.qualityFlags.zeroFlowMonths ?? []) ? z.qualityFlags : null;
		const kind = z.calibrationFlowKind === 'flow_observed_m3s' || z.calibrationFlowKind === 'flow_logger_m3s' ? z.calibrationFlowKind : null;
		out.push({
			nodeId: z.nodeId,
			enabled: ticked,
			calibrationStart: isoDate(z.calibrationStart) ? z.calibrationStart : null,
			calibrationEnd: isoDate(z.calibrationEnd) ? z.calibrationEnd : null,
			calibrationFlowKind: kind,
			calibrationExclusions: sanitizeExclusions(z.calibrationExclusions, ticked ? warnings : [], `calibration exclusion at gauge node ${z.nodeId}`),
			qualityFlags: qf ? { suspect: qf.suspect as FlagUse, ...(Array.isArray(qf.zeroFlowMonths) && qf.zeroFlowMonths.length ? { zeroFlowMonths: [...(qf.zeroFlowMonths as number[])] } : {}) } : null,
			gr4j: e || z.gr4j == null ? null : (Object.fromEntries(GR4J_PARAMS.map((s) => [s.key, (z.gr4j as Record<string, number>)[s.key]])) as unknown as Gr4jParams),
			fitRecord: isObj(z.fitRecord) ? (z.fitRecord as unknown as FitRecord) : null
		});
	}
	return out;
}

type ZoneNode = Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'> & Partial<Pick<NetworkNode, 'areaKm2'>>;

/** The nodes from `id` down to the outlet, `id` first (stops on a loop). */
function pathDown(byId: ReadonlyMap<string, ZoneNode>, id: string): string[] {
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

/**
 * Why one row can't define a zone, or null: the gauge is gone, isn't a gauge
 * inside the network, is the calibration site itself, or lies below it (its
 * zone would take units of the site's own).
 */
export function calibrationZoneError(nodes: readonly ZoneNode[], siteNodeId: string | null, nodeId: string): string | null {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const n = byId.get(nodeId);
	if (!n) return 'its gauge is no longer in the model';
	if (n.kind !== 'gauge') return `"${n.name}" is not a gauge`;
	if (n.downstreamNodeId === null) return `"${n.name}" is the outlet, whose zone is the rest of the catchment`;
	if (siteNodeId !== null && byId.has(siteNodeId)) {
		if (nodeId === siteNodeId) return `"${n.name}" is the calibration site (Scored at), whose zone is the rest of the catchment`;
		if (pathDown(byId, siteNodeId).includes(nodeId)) return `"${n.name}" is below the calibration site, so its zone would take the site's own units`;
	}
	return null;
}

/**
 * Why a list of zone rows can't be saved, or null: a gauge listed twice, or a
 * ticked row that can't define a zone (calibrationZoneError). An unticked row
 * is only a stored setting and is never refused but for a repeat.
 */
export function calibrationZonesError(nodes: readonly ZoneNode[], siteNodeId: string | null, zones: readonly Pick<CalibrationZone, 'nodeId' | 'enabled'>[]): string | null {
	const seen = new Set<string>();
	for (const z of zones) {
		if (seen.has(z.nodeId)) return `the gauge node ${z.nodeId} has two rows`;
		seen.add(z.nodeId);
	}
	for (const z of zones) {
		if (!z.enabled) continue;
		const e = calibrationZoneError(nodes, siteNodeId, z.nodeId);
		if (e) return `calibration zone: ${e}`;
	}
	return null;
}

/** A ticked zone as a run or fit applies it. */
export interface ResolvedZone {
	nodeId: string;
	name: string;
	/** The land units it runs with its own parameters, node-id order. */
	units: string[];
	/** Its parameters: the row's, else (not fitted) the catchment's. */
	params: Gr4jParams;
	/** Whether the row had parameters of its own (false: it took the catchment's). */
	fitted: boolean;
	zone: CalibrationZone;
}

export interface ZoneAssignment {
	/** The usable ticked zones, upstream first (the stepwise fit's order). */
	zones: ResolvedZone[];
	/** The land units of the primary zone (the rest), node-id order. */
	primaryUnits: string[];
	/** Land unit id → its zone's gauge, or null for the primary zone. */
	unitZone: ReadonlyMap<string, string | null>;
}

/** Whether the run generates flow per unit (§2.4h), the only method zones apply under. */
const perUnit = (s: Pick<ProjectSettings, 'unitRain'>): boolean => s.unitRain?.mode === 'perUnit';

/** The ticked rows (whatever the method). */
export const tickedZones = (s: Pick<ProjectSettings, 'calibrationZones'>): CalibrationZone[] => (s.calibrationZones ?? []).filter((z) => z.enabled);

/**
 * The zones a run or fit applies, or null when it applies none (no ticked row,
 * or every ticked row unusable): then the run is every engine before's. Under
 * Fragmentation ticked rows warn and give null. An unusable ticked row warns
 * and is left out (its units fall to the next zone down). `base` is the
 * catchment's parameters (settings.gr4j, resolved).
 */
export function resolveZones(nodes: readonly ZoneNode[], settings: Pick<ProjectSettings, 'calibrationZones' | 'calibrationSiteNodeId' | 'unitRain'>, base: Gr4jParams, warnings: string[]): ZoneAssignment | null {
	const ticked = tickedZones(settings);
	if (!ticked.length) return null;
	if (!perUnit(settings)) {
		warnings.push(
			`Calibration zones: ${ticked.length} gauge${ticked.length === 1 ? ' is' : 's are'} ticked to calibrate here, but calibration zones need Per unit flow generation (Settings → Model selection for flow generation): under Fragmentation one GR4J runs for the whole catchment, on the catchment's parameters`
		);
		return null;
	}
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const site = settings.calibrationSiteNodeId ?? null;
	const usable = ticked.filter((z) => {
		const e = calibrationZoneError(nodes, site, z.nodeId);
		if (e) warnings.push(`Calibration zone: ${e}; its units are in the next zone downstream`);
		return !e;
	});
	if (!usable.length) return null;
	const zoneIds = new Set(usable.map((z) => z.nodeId));
	const unitZone = new Map<string, string | null>();
	const landUnits = nodes.filter((n) => n.areaKm2 !== undefined && isLandUnit(n as NetworkNode)).map((n) => n.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	for (const u of landUnits) unitZone.set(u, pathDown(byId, u).find((id) => zoneIds.has(id)) ?? null);
	// Upstream first: a zone gauge with more ticked gauges below it is further up (one that drains through another
	// always has more), then by name and id so the order is stable.
	const below = (id: string) => pathDown(byId, id).slice(1).filter((x) => zoneIds.has(x)).length;
	const zones = usable
		.map((z): ResolvedZone => ({
			nodeId: z.nodeId,
			name: byId.get(z.nodeId)!.name,
			units: landUnits.filter((u) => unitZone.get(u) === z.nodeId),
			params: z.gr4j ? { ...z.gr4j } : { ...base },
			fitted: !!z.gr4j,
			zone: z
		}))
		.sort((a, b) => below(b.nodeId) - below(a.nodeId) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.nodeId < b.nodeId ? -1 : 1));
	for (const z of zones) {
		if (!z.fitted) warnings.push(`Calibration zone "${z.name}" has no parameters of its own yet: its units run on the catchment's GR4J parameters until it is fitted`);
	}
	// Until the report, the evidence pack, the uncertainty ensemble and automated calibration read the zones (issue #555's
	// next round), the run says that they show or vary the calibration site's zone's parameters only.
	const zoned = zones.reduce((n, z) => n + z.units.length, 0);
	if (zoned)
		warnings.push(
			`Calibration zones: ${zoned} land unit${zoned === 1 ? '' : 's'} ran on ${zones.length === 1 ? 'a calibration zone’s' : 'calibration zones’'} own GR4J parameters. The report, the evidence pack, the uncertainty ensemble and automated calibration still show or vary only the calibration site’s parameters (Model settings → Flow calibration)`
		);
	return { zones, primaryUnits: landUnits.filter((u) => unitZone.get(u) === null), unitZone };
}

/**
 * Each land unit's parameters under the zones (`fitZone`'s units take `free`
 * instead, for the zone being fitted: null = the primary zone), or undefined
 * when no zone applies (every unit takes the one parameter set, as before).
 */
export function zoneParamsOf(a: ZoneAssignment | null, base: Gr4jParams, fitZone?: { zone: string | null; free: Gr4jParams }): ((unitId: string) => Gr4jParams) | undefined {
	if (!a) return undefined;
	const of = new Map<string | null, Gr4jParams>([[null, base], ...a.zones.map((z) => [z.nodeId, z.params] as const)]);
	if (fitZone) of.set(fitZone.zone, fitZone.free);
	return (id) => of.get(a.unitZone.get(id) ?? null) ?? base;
}

/**
 * The settings a fit of one zone reads (docs/model.md §2.10n): the zone's
 * gauge as the site, its window, exclusions, record and quality flags, its
 * parameters (else the catchment's) as the start, and its fit record. Every
 * other setting is the project's. null = the primary zone: the settings as
 * they are.
 */
export function zoneCalibrationSettings<S extends ProjectSettings>(settings: S, zoneNodeId: string | null): S {
	if (zoneNodeId === null) return settings;
	const z = (settings.calibrationZones ?? []).find((x) => x.nodeId === zoneNodeId);
	if (!z) throw new Error(`no calibration zone at gauge node ${zoneNodeId}`);
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

/** The name of the calibration site's own zone: Scored at's gauge, else the outlet's node. */
export function zoneSiteName(nodes: readonly ZoneNode[], siteNodeId: string | null): string {
	const site = siteNodeId !== null ? nodes.find((n) => n.id === siteNodeId) : undefined;
	return site?.name ?? nodes.find((n) => n.downstreamNodeId === null)?.name ?? 'the outlet';
}

/**
 * Why the zones can't be fitted stepwise, or null: a ticked zone with no land
 * unit, or a calibration site none of whose own zone's units drains through
 * it (every unit in a zone above it, or the rest all beside an inner site), so
 * its step's score couldn't move with the parameters it fits.
 */
export function zoneFitError(a: ZoneAssignment, nodes: readonly ZoneNode[], siteNodeId: string | null): string | null {
	for (const z of a.zones) if (!z.units.length) return `the calibration zone "${z.name}" has no land unit above its gauge (none drains to it that isn't in a zone further up): untick it, or give a unit above it an area`;
	if (!a.primaryUnits.length) return 'every land unit is in a zone above the calibration site, so the site has nothing of its own to fit: untick the lowest gauge, or calibrate there instead (Scored at)';
	const byId = new Map(nodes.map((n) => [n.id, n]));
	if (siteNodeId !== null && byId.has(siteNodeId) && !a.primaryUnits.some((u) => pathDown(byId, u).includes(siteNodeId)))
		return `none of the land units left to the calibration site "${byId.get(siteNodeId)!.name}" drains through it (they are all beside it), so its step could not fit them: calibrate at the outlet instead (Scored at), or untick the gauge above the site`;
	return null;
}

/** Zone rows checked as an exclusions list is (the API's rule for each row's exclusions). */
export function zoneExclusionsError(z: Pick<CalibrationZone, 'calibrationExclusions'>): string | null {
	return exclusionsError(z.calibrationExclusions);
}

/** A water year counts as complete for a zone's coverage with at least this share of its days observed. */
export const ZONE_COMPLETE_YEAR_SHARE = 0.95;
/** Fewer complete water years than this at a ticked gauge warn (issue #555). */
export const ZONE_MIN_COMPLETE_YEARS = 2;

/** Water years (by the calendar year they start in) with at least ZONE_COMPLETE_YEAR_SHARE of their days among `idx` (run day indices from `startDate`), ascending. */
export function zoneCompleteWaterYears(startDate: string, idx: ArrayLike<number>): number[] {
	const d0 = toEpochDay(startDate);
	const count = new Map<number, number>();
	for (let i = 0; i < idx.length; i++) {
		const y = waterYearOf(d0 + idx[i]!);
		count.set(y, (count.get(y) ?? 0) + 1);
	}
	return [...count]
		.filter(([y, n]) => n >= ZONE_COMPLETE_YEAR_SHARE * (toEpochDay(`${y + 1}-10-01`) - toEpochDay(`${y}-10-01`)))
		.map(([y]) => y)
		.sort((a, b) => a - b);
}

/**
 * Complete water years between two ISO dates (1 October to 30 September, both
 * inside): a record's span, gaps not counted, as Settings' coverage column
 * shows it before a fit reads the days. 0 when either date is missing.
 */
export function spannedWaterYears(start: string | null | undefined, end: string | null | undefined): number {
	if (!start || !end) return 0;
	const a = toEpochDay(start);
	const b = toEpochDay(end);
	const first = waterYearOf(a) + (fromEpochDay(a).slice(5) === '10-01' ? 0 : 1);
	const last = waterYearOf(b) - (fromEpochDay(b).slice(5) === '09-30' ? 0 : 1);
	return Math.max(0, last - first + 1);
}

/**
 * The coverage warnings of a ticked gauge's fit (issue #555): fewer than
 * ZONE_MIN_COMPLETE_YEARS complete water years, or no dry → wet test (too few
 * years to rank, so no dry year to fit on). The dry → wet test's own note
 * says why it didn't run; this one says what it means for the zone.
 */
export function zoneCoverageNotes(name: string, completeYears: number, dryWetRan: boolean): string[] {
	const out: string[] = [];
	if (completeYears < ZONE_MIN_COMPLETE_YEARS)
		out.push(
			`The record at "${name}" has ${completeYears} complete water year${completeYears === 1 ? '' : 's'} (at least ${Math.round(ZONE_COMPLETE_YEAR_SHARE * 100)} % of the days observed), fewer than ${ZONE_MIN_COMPLETE_YEARS}: this zone's parameters rest on too short a record to trust on their own. Consider unticking the gauge, so its units take the zone below.`
		);
	if (!dryWetRan) out.push(`The record at "${name}" has no dry year to fit on and test against wet ones, so how this zone behaves outside the years it was fitted on is untested.`);
	return out;
}
