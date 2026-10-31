// Calibration zones (engine 1.106.0, issue #555, docs/model.md §2.10n): one row
// of settings.calibrationZones per gauge inside the network, with Calibrate
// here, its own window, flow kind, exclusions, quality flags, GR4J X1–X4 and
// fit record. Since engine 1.110.0 (issue #659) each ticked row is a
// calibration location, an equal of the outlet's (./locations.ts, which
// resolves the land units' groups, the headline and the fit order). This
// module keeps the row type, its sanitiser and the coverage helpers, and
// #555's names as views of the locations for callers not moved yet.
//
// Pure: the nodes and settings are all it reads.
import type { CalibrationFlowKind, NetworkNode, ProjectSettings } from '../project';
import { GR4J_PARAMS, type Gr4jParams } from '../runoff/params';
import { exclusionsError, sanitizeExclusions, type CalibrationExclusion, type FitRecord } from './provenance';
import { FLAG_USES, zeroFlowMonthsError, type FlagUse } from './qualityFlagSettings';
import { calibrationLocationError, calibrationLocationsError, locationCalibrationSettings, resolveLocations } from './locations';
import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { warn } from '../warningCodes';

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
		warnings.push(warn('calibration.zone.notList', {}, 'the calibration zones are not a list; calibrating at one site'));
		return [];
	}
	const out: CalibrationZone[] = [];
	const seen = new Set<string>();
	for (const z of raw.slice(0, CALIBRATION_ZONES_MAX)) {
		if (!isObj(z) || typeof z.nodeId !== 'string' || !z.nodeId) {
			warnings.push(warn('calibration.zone.noGauge', {}, 'a calibration zone without a gauge is ignored'));
			continue;
		}
		if (seen.has(z.nodeId)) {
			warnings.push(warn('calibration.zone.duplicate', { node: z.nodeId }, `the calibration zone at gauge node ${z.nodeId} is listed twice; the first is used`));
			continue;
		}
		seen.add(z.nodeId);
		const e = zoneParamsError(z.gr4j ?? null);
		const ticked = z.enabled === true;
		// Only a ticked row's problems warn: an unticked row changes nothing a run does, its warnings included.
		if (e && ticked) warnings.push(warn('calibration.zone.badParams', { node: z.nodeId, reason: e }, `calibration zone at gauge node ${z.nodeId}: ${e}; its units take the catchment's parameters`));
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

// Since engine 1.110.0 (issue #659) the rows are calibration locations, equals of the outlet's (./locations.ts): what
// follows keeps the names #555 exported, each now a thin view of the locations, for callers not moved yet.

/**
 * Why one row can't be ticked, or null (calibrationLocationError): the gauge
 * is gone, isn't a gauge inside the network, or is the outlet. Since engine
 * 1.110.0 a row may lie anywhere, the headline's own node and below it
 * included; `siteNodeId` is no longer read.
 * @deprecated use calibrationLocationError.
 */
export function calibrationZoneError(nodes: readonly ZoneNode[], _siteNodeId: string | null, nodeId: string): string | null {
	return calibrationLocationError(nodes, nodeId);
}

/**
 * Why a list of rows can't be saved, or null: a gauge listed twice, or a
 * ticked row that can't be a location (calibrationLocationError). An
 * unticked row is only a stored setting and is never refused but for a
 * repeat. `siteNodeId` is no longer read (engine 1.110.0).
 * @deprecated use calibrationLocationsError, which checks the headline pointer too.
 */
export function calibrationZonesError(nodes: readonly ZoneNode[], _siteNodeId: string | null, zones: readonly Pick<CalibrationZone, 'nodeId' | 'enabled'>[]): string | null {
	return calibrationLocationsError(nodes, { calibrationZones: zones as CalibrationZone[], calibrationSiteNodeId: null });
}

/** A ticked row as a run or fit applies it (a view of ResolvedLocation). */
export interface ResolvedZone {
	nodeId: string;
	name: string;
	/** Its group's land units, node-id order. */
	units: string[];
	params: Gr4jParams;
	fitted: boolean;
	zone: CalibrationZone;
}

/** @deprecated a view of LocationAssignment for callers of #555's API: the headline's group is the "primary" one. */
export interface ZoneAssignment {
	/** Every location but the headline, in the locations' order (the outlet's, when not the headline, by its node id). */
	zones: ResolvedZone[];
	/** The headline's group and the units on settings.gr4j, node-id order. */
	primaryUnits: string[];
	/** Land unit id → its location's node, or null for the headline's group and settings.gr4j. */
	unitZone: ReadonlyMap<string, string | null>;
}

/** The ticked rows. */
export const tickedZones = (s: Pick<ProjectSettings, 'calibrationZones'>): CalibrationZone[] => (s.calibrationZones ?? []).filter((z) => z.enabled);

/**
 * resolveLocations as #555's ZoneAssignment (the headline's group as the
 * primary zone), or null when no location applies.
 * @deprecated use resolveLocations.
 */
export function resolveZones(nodes: readonly ZoneNode[], settings: Partial<ProjectSettings>, base: Gr4jParams, warnings: string[]): ZoneAssignment | null {
	const a = resolveLocations(nodes, settings, base, warnings);
	if (!a) return null;
	const others = a.locations.filter((l) => l.key !== a.headline);
	const unitZone = new Map<string, string | null>();
	for (const l of a.locations) for (const u of l.units) unitZone.set(u, l.key === a.headline ? null : l.nodeId);
	for (const u of a.defaultUnits) unitZone.set(u, null);
	const head = a.locations.find((l) => l.key === a.headline);
	return {
		zones: others.map((l) => ({ nodeId: l.nodeId, name: l.name, units: [...l.units], params: { ...l.params }, fitted: l.fitted, zone: l.zone ?? newCalibrationZone(l.nodeId) })),
		primaryUnits: [...(head?.units ?? []), ...a.defaultUnits].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
		unitZone
	};
}

/**
 * The settings a fit or score at one location reads (locationCalibrationSettings).
 * @deprecated use locationCalibrationSettings (null = the outlet's location) or headlineCalibrationSettings.
 */
export function zoneCalibrationSettings<S extends ProjectSettings>(settings: S, zoneNodeId: string | null): S {
	return zoneNodeId === null ? settings : locationCalibrationSettings(settings, zoneNodeId);
}

/** The name of a location: Scored at's gauge (the headline pointer), else the outlet's node. */
export function zoneSiteName(nodes: readonly ZoneNode[], siteNodeId: string | null): string {
	const site = siteNodeId !== null ? nodes.find((n) => n.id === siteNodeId) : undefined;
	return site?.name ?? nodes.find((n) => n.downstreamNodeId === null)?.name ?? 'the outlet';
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
