// Scenario operations (roadmap WP-3.2, docs/scenarios.md): the closed union
// of overrides a scenario applies to a base run's input, the per-field value
// checks, and a zod-free runtime validator the backend can call on a request
// body (or mirror in zod). Pure: no I/O.
import { DAM_SEDIMENT_MAX_PER_YEAR } from '../network/development';
import { ALLOCATION_MODES, type AllocationMode } from '../allocations/mode';
import type { AllocationEntry } from '../allocations/compare';
import { fromEpochDay, toEpochDay } from '../calendar';
import {
	ACCUMULATION_MODES,
	BOREHOLE_MODES,
	BOREHOLE_RULES,
	BOREHOLE_TARGETS,
	GA538_GROUNDWATER_RATES,
	isGa538Rate,
	CALIBRATION_FLOW_KINDS,
	CHIRPS_BIAS_MODES,
	DAM_CURVE_MAX_ROWS,
	DEMAND_OBJECT_CATEGORIES,
	DEMAND_OBJECT_DESTINATIONS,
	DEMAND_OBJECT_PRIORITIES,
	DEMAND_OBJECT_SIZINGS,
	DEMAND_SCHEDULE_SPANS,
	DAM_RELEASE_RULES,
	LAND_COVER_CLASSES,
	PE_KINDS,
	PE_SOURCE_MAX,
	SUPPLY_RULES,
	TRANSFER_SIZINGS,
	TRANSFER_SOURCES,
	USER_PRIORITIES,
	ZERO_RAIN_MODES,
	type CalibrationFlowKind,
	type ChirpsBiasMode,
	type AccumulationMode,
	type Borehole,
	type CropDef,
	type DemandObject,
	type DemandScheduleWindow,
	type FlowShareMethod,
	type LandCoverPatch,
	type NetworkNode,
	type NodeKind,
	type PeInput,
	type Transfer,
	type ZeroRainMode
} from '../project';
import { GR4J_PARAMS } from '../runoff/params';
import { DEMAND_SCHEDULE_MAX_FACTOR, DEMAND_SCHEDULE_MAX_WINDOWS } from '../network/demandSchedule';
import {
	EWR_CHARGE_SOURCES,
	EWR_NATURAL_SOURCES,
	EWR_RULE_COMPONENTS,
	EWR_RULE_SOURCE_KINDS,
	EWR_RULE_UNITS,
	LOW_FLOW_MEASURES,
	ewrRuleTableIssues,
	type EwrChargeSource,
	type EwrRuleTable,
	type LowFlowMeasure
} from '../reserve/rules';

// ---------------------------------------------------------------------------
// Value checks: each returns an error message, or null when the value is fine.
// Ranges follow the backend's zod schemas (backend/src/model/validate.ts,
// backend/src/projects/settings.ts), so an applied scenario still validates.
// The calibration.* bounds here are plausibility limits of the engine's own.
// ---------------------------------------------------------------------------

type Check = (v: unknown) => string | null;

/**
 * A checks table keyed by name, as a Map: an op's field, path or node key is
 * untrusted text (a request body, a stored scenario, the preview worker's
 * message), and a plain object would answer `__proto__`, `constructor` or
 * `toString` with Object.prototype's own members. A Map knows only the names
 * it was built with.
 */
interface Checks {
	names: readonly string[];
	byName: ReadonlyMap<string, Check>;
}
const checksOf = (table: Record<string, Check>): Checks => ({ names: Object.keys(table), byName: new Map(Object.entries(table)) });

/**
 * The check for `name`, found by the allowlisted name equal to it (taken from
 * the table's own keys, never the caller's text), so the call dispatches only
 * to a check the table was built with.
 */
function checkFor(table: Checks, name: string): Check | undefined {
	const known = allowed(table.names, name);
	return known === undefined ? undefined : table.byName.get(known);
}

/** The allowlisted name equal to `v`, taken from the allowlist itself (never `v`), or undefined. */
export function allowed<T extends string>(names: readonly T[], v: unknown): T | undefined {
	return typeof v === 'string' ? names.find((n) => n === v) : undefined;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A survey curve row with only its three numbers (the backend's model schema is strict). */
const isCurveRow = (r: unknown): boolean =>
	isObj(r) && Object.keys(r).length === 3 && isNum(r.levelM) && isNum(r.areaM2) && r.areaM2 >= 0 && isNum(r.volumeM3) && r.volumeM3 >= 0;
const range =
	(lo: number, hi: number, opts: { loOpen?: boolean; int?: boolean } = {}): Check =>
	(v) => {
		if (!isNum(v)) return 'must be a finite number';
		if (opts.int && !Number.isInteger(v)) return 'must be a whole number';
		if (opts.loOpen ? !(v > lo) : !(v >= lo)) return `must be ${opts.loOpen ? 'above' : 'at least'} ${lo}`;
		if (!(v <= hi)) return `must be at most ${hi}`;
		return null;
	};
const nullable =
	(c: Check): Check =>
	(v) =>
		v === null ? null : c(v);
const oneOf =
	(xs: readonly string[]): Check =>
	(v) =>
		typeof v === 'string' && xs.includes(v) ? null : `must be one of ${xs.join(', ')}`;
const monthlyOf =
	(c: Check): Check =>
	(v) => {
		if (!Array.isArray(v) || v.length !== 12) return 'must be 12 monthly values (Oct–Sep)';
		for (let i = 0; i < 12; i++) {
			const e = c(v[i]);
			if (e) return `month ${i + 1}: ${e}`;
		}
		return null;
	};
const boolean: Check = (v) => (typeof v === 'boolean' ? null : 'must be true or false');
const nonNeg = range(0, Number.MAX_VALUE);
const frac = range(0, 1);
/** A list of calendar months 1–12 (order and repeats are normalised away on apply). */
const months: Check = (v) => {
	if (!Array.isArray(v) || v.length > 12) return 'must be a list of at most 12 calendar months';
	return v.every((m) => Number.isInteger(m) && m >= 1 && m <= 12) ? null : 'months must be whole numbers 1–12';
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO calendar date that exists (not 2021-02-30). */
export function isIsoDate(v: unknown): v is string {
	if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
	try {
		return fromEpochDay(toEpochDay(v)) === v;
	} catch {
		return false;
	}
}
const isoDate: Check = (v) => (isIsoDate(v) ? null : 'must be an ISO date (YYYY-MM-DD)');
/** Ids: the backend stores UUIDs; the engine only needs a non-empty string. */
const id: Check = (v) => (typeof v === 'string' && v.length >= 1 && v.length <= 100 ? null : 'must be an id (1–100 characters)');
const name: Check = (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 100 ? null : 'must be a name of 1–100 characters');

// ---------------------------------------------------------------------------
// node.set: the editable fields, per node kind
// ---------------------------------------------------------------------------

const DAM_AND_IRRIGATION = [
	'pctUpstreamToDam',
	'pctRunoffToDam',
	'damCapacityM3',
	'damInitialPct',
	'damMinPct',
	'damAreaFullM2',
	'damAreaExponent',
	'damSeepagePerDay',
	'divertCapacityM3Day',
	'irrigationEfficiency',
	'lossReturnFraction'
] as const;
/** Land and flow share: what the catchment's natural flow is split by (baseline hydrology). */
const LAND = ['areaKm2', 'areaHiKm2', 'areaLoKm2', 'flowShareManual'] as const;
/**
 * A dam's releases, where its seepage goes and its survey curve (WP-3.5; the
 * curve as a node.set from engine 1.20.0, so a scenario that raises a dam can
 * carry the enlarged dam's own surveyed curve, docs/scenarios.md § Dam capacity).
 */
const DAM_STORAGE = ['damReleaseRule', 'damReleaseM3Day', 'damOutletCapacityM3Day', 'damSeepageReturnPct', 'damCurve'] as const;
/** Development over the run (engine ≥ 1.30.0, docs/model.md §2.7g): a dam's sediment and in-service date, a unit's abstraction start. */
const DEVELOPMENT = ['damSurveyDate', 'damSedimentPctPerYear', 'damInServiceFrom'] as const;
const BOREHOLES = ['boreholeCapacityM3Day', 'boreholeRule', 'boreholeTriggerPct', 'streamDepletionFrac', 'streamDepletionLagDays'] as const;
const USER = ['userDemandM3Day', 'userReturnPct', 'userPriority'] as const;
/**
 * How a farm takes its water (engine ≥ 0.42.0, WP-3.8, docs/model.md §2.7e):
 * the supply rule, the river pump and the trigger rule's two dam levels.
 * Farms only; how they fit together (a gauge or user has none, trigger needs
 * a dam, run of river has none, stop ≥ trigger) is a model rule
 * (modelRules.ts), so applyScenario reports an op that breaks one.
 */
const SUPPLY = ['supplyRule', 'pumpCapacityM3Day', 'supplyTriggerPct', 'supplyStopPct'] as const;
/**
 * A farm's other operating rules (engine ≥ 1.32.0, WP-3.8, issue #204,
 * docs/model.md §2.7h): the hands-off flow by month, whether the EWR is kept
 * too, and River to dam by month. Farms only (a model rule).
 */
const OPERATING = ['handsOffM3Day', 'handsOffEwr', 'divertMonthlyM3Day'] as const;

/**
 * The fields `node.set` may change, per node kind. Never `id`, `kind`,
 * `downstreamNodeId` (the network's shape: `node.add`, `node.insert`,
 * `node.move` and `node.remove` change it) or `sortOrder` (display only). A gauge only measures, so only its name
 * and whether it is an EWR site (engine ≥ 1.5.0; the outlet always is one, a
 * model rule).
 */
export const NODE_SET_FIELDS = {
	farm: ['name', ...LAND, ...DAM_AND_IRRIGATION, ...DAM_STORAGE, ...DEVELOPMENT, 'abstractionFrom', ...BOREHOLES, ...SUPPLY, ...OPERATING],
	user: ['name', ...USER, 'abstractionFrom', ...BOREHOLES],
	gauge: ['name', 'ewrSite']
} as const satisfies Record<NodeKind, readonly (keyof NetworkNode)[]>;

export type NodeSetField = (typeof NODE_SET_FIELDS)[NodeKind][number];

/**
 * node.set fields that are baseline assumptions even on the applicant's own
 * node (classifyOp): land and flow share split the catchment's natural
 * runoff, where the EWR is assessed is the Reserve's, and a dam's survey and
 * sediment rate (engine ≥ 1.30.0) describe the dam as it is, never a proposal.
 */
export const BASELINE_NODE_FIELDS: readonly NodeSetField[] = [...LAND, 'ewrSite', 'damSurveyDate', 'damSedimentPctPerYear'];

const NODE_FIELD_CHECKS: Record<NodeSetField, Check> = {
	name,
	areaKm2: nonNeg,
	areaHiKm2: nonNeg,
	areaLoKm2: nonNeg,
	flowShareManual: nullable(frac),
	pctUpstreamToDam: frac,
	pctRunoffToDam: frac,
	damCapacityM3: nonNeg,
	damInitialPct: frac,
	damMinPct: frac,
	damAreaFullM2: nullable(nonNeg),
	damAreaExponent: range(0, 3, { loOpen: true }),
	damSeepagePerDay: frac,
	divertCapacityM3Day: nonNeg,
	irrigationEfficiency: range(0, 1, { loOpen: true }),
	lossReturnFraction: frac,
	damReleaseRule: oneOf(DAM_RELEASE_RULES),
	damReleaseM3Day: nullable(monthlyOf(nonNeg)),
	damOutletCapacityM3Day: nullable(nonNeg),
	damSeepageReturnPct: frac,
	damSurveyDate: nullable(isoDate),
	damSedimentPctPerYear: nullable(range(0, DAM_SEDIMENT_MAX_PER_YEAR)),
	damInServiceFrom: nullable(isoDate),
	abstractionFrom: nullable(isoDate),
	// The rows, as the model form saves them; whether they make a usable curve (volume rising, some area) is a model rule (modelRules.ts damCurveProblem).
	damCurve: nullable((v) =>
		Array.isArray(v) && v.length <= DAM_CURVE_MAX_ROWS && v.every(isCurveRow) ? null : `must be up to ${DAM_CURVE_MAX_ROWS} rows of { levelM, areaM2 ≥ 0, volumeM3 ≥ 0 }`
	),
	boreholeCapacityM3Day: nullable(nonNeg),
	boreholeRule: oneOf(BOREHOLE_RULES),
	boreholeTriggerPct: frac,
	streamDepletionFrac: frac,
	streamDepletionLagDays: range(0, 36_500),
	userDemandM3Day: nullable(monthlyOf(nonNeg)),
	userReturnPct: frac,
	userPriority: oneOf(USER_PRIORITIES),
	supplyRule: oneOf(SUPPLY_RULES),
	pumpCapacityM3Day: nullable(nonNeg),
	supplyTriggerPct: frac,
	supplyStopPct: frac,
	handsOffM3Day: nullable(monthlyOf(nonNeg)),
	handsOffEwr: boolean,
	divertMonthlyM3Day: nullable(monthlyOf(nonNeg)),
	ewrSite: boolean
};

export type NodeSetValue<F extends NodeSetField> = Exclude<NetworkNode[F], undefined>;

/** Check a node.set value (the kind rule is applyScenario's: it needs the node). */
const NODE_FIELD_CHECK = checksOf(NODE_FIELD_CHECKS);

export function nodeFieldError(field: string, value: unknown): string | null {
	const c = checkFor(NODE_FIELD_CHECK, field);
	return c ? c(value) : `"${field}" is not a field a scenario can set`;
}

// ---------------------------------------------------------------------------
// transfer.set
// ---------------------------------------------------------------------------

export const TRANSFER_SET_FIELDS = [
	'fromNodeId',
	'toNodeId',
	'months',
	'maxRateM3s',
	'dailyCapM3',
	'minStoragePct',
	'enabled',
	'priority',
	'monthlyRateM3s',
	'source',
	'handsOffM3Day',
	'handsOffEwr',
	'lossPct',
	'sizing',
	'topUpDam'
] as const;
export type TransferSetField = (typeof TRANSFER_SET_FIELDS)[number];

const TRANSFER_FIELD_CHECKS: Record<TransferSetField, Check> = {
	fromNodeId: id,
	toNodeId: id,
	months,
	maxRateM3s: nonNeg,
	dailyCapM3: nullable(nonNeg),
	minStoragePct: frac,
	enabled: boolean,
	priority: range(-1_000_000, 1_000_000, { int: true }),
	// Engine ≥ 1.14.0: a rate per water-year month (m³/s); setting it also sets months and max rate to match (applyScenario).
	monthlyRateM3s: nullable(monthlyOf(nonNeg)),
	// Engine ≥ 1.14.0: a river off-take and its fields (docs/model.md §2.6a).
	source: oneOf(TRANSFER_SOURCES),
	handsOffM3Day: nullable(nonNeg),
	handsOffEwr: boolean,
	lossPct: (v) => (isNum(v) && v >= 0 && v < 1 ? null : 'must be at least 0 and below 1'),
	sizing: oneOf(TRANSFER_SIZINGS),
	topUpDam: boolean
};

/** The transfer fields a new transfer may leave out (engine ≥ 1.14.0 additions). */
export const TRANSFER_OPTIONAL = new Set<string>(['monthlyRateM3s', 'source', 'handsOffM3Day', 'handsOffEwr', 'lossPct', 'sizing', 'topUpDam']);

const TRANSFER_FIELD_CHECK = checksOf(TRANSFER_FIELD_CHECKS);

export function transferFieldError(field: string, value: unknown): string | null {
	const c = checkFor(TRANSFER_FIELD_CHECK, field);
	return c ? c(value) : `"${field}" is not a transfer field a scenario can set`;
}

// ---------------------------------------------------------------------------
// settings.set: whitelisted paths and their value types
// ---------------------------------------------------------------------------

/** The settings a scenario may change, by dotted path, with the value each takes. */
export interface SettingsPathValues {
	februaryDays: number;
	effectiveRainFraction: number;
	/** Monthly effective-rain fractions (engine ≥ 0.43.0); null = the one fraction in every month. */
	effectiveRainFractionMonthly: number[] | null;
	effectiveRainStoreMm: number;
	lakeEvapFactor: number;
	/** Monthly lake factors (WP-3.5); null = the one factor in every month. */
	lakeEvapFactorMonthly: number[] | null;
	apanMm: number[];
	panCoefficient: number[];
	ewrPragmaticM3PerDay: number[];
	flowShareMethod: FlowShareMethod;
	'hiLoSplit.hi': number;
	'hiLoSplit.lo': number;
	'gr4j.x1': number;
	'gr4j.x2': number;
	'gr4j.x3': number;
	'gr4j.x4': number;
	'gr4j.warmupDays': number;
	chirpsBiasCorrection: ChirpsBiasMode;
	/** GR4J's PE input, whole (engine ≥ 0.31.0, issue #39). */
	pe: PeInput;
	'zeroRainRuns.mode': ZeroRainMode;
	'zeroRainRuns.accumulationMode': AccumulationMode;
	'calibration.rainThresholdMm': number;
	'calibration.catchmentAreaKm2': number | null;
	simulationStart: string | null;
	simulationEnd: string | null;
	reportStart: string | null;
	reportEnd: string | null;
	calibrationStart: string | null;
	calibrationEnd: string | null;
	calibrationFlowKind: CalibrationFlowKind | null;
	/** What the EWR charge follows (engine ≥ 1.3.0, issue #64): the pragmatic EWR or the Reserve rule tables. */
	ewrChargeSource: EwrChargeSource;
	/** What low flows are judged on (engine ≥ 1.3.0, issue #64): the month's total flow or its base flow. */
	lowFlowMeasure: LowFlowMeasure;
	/** What the registered volumes do to the run (engine ≥ 1.18.0, issue #72): compare only, cap, or a full allocation. */
	allocationMode: AllocationMode;
}
export type SettingsPath = keyof SettingsPathValues;

/**
 * settings.pe, whole: `{ kind: 'pan' }`, or `{ kind: 'monthly', mm, source }`
 * with 12 values 0–10 000 mm (the A-pan row's range) and a source note of 1 to
 * PE_SOURCE_MAX characters (a directly given PE must say where it came from).
 * No other keys, so nothing unchecked reaches the settings.
 */
const peInput: Check = (v) => {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'must be a PE input ({ kind: "pan" } or { kind: "monthly", mm, source })';
	const o = v as Record<string, unknown>;
	const kindErr = oneOf(PE_KINDS)(o.kind);
	if (kindErr) return `kind ${kindErr}`;
	const allowed = o.kind === 'pan' ? ['kind'] : ['kind', 'mm', 'source'];
	const extra = Object.keys(o).filter((k) => !allowed.includes(k));
	if (extra.length) return `has unknown field(s) ${extra.join(', ')} for kind ${String(o.kind)}`;
	if (o.kind === 'pan') return null;
	const mmErr = monthlyOf(range(0, 10_000))(o.mm);
	if (mmErr) return `mm ${mmErr}`;
	if (typeof o.source !== 'string' || !o.source.trim()) return 'source must say where the monthly PE came from';
	if (o.source.length > PE_SOURCE_MAX) return `source must be at most ${PE_SOURCE_MAX} characters`;
	return null;
};

const gr4j = (key: string): Check => {
	const p = GR4J_PARAMS.find((x) => x.key === key)!;
	return range(p.min, p.max);
};

const SETTINGS_CHECKS: Record<SettingsPath, Check> = {
	februaryDays: range(28, 29),
	effectiveRainFraction: frac,
	effectiveRainFractionMonthly: nullable(monthlyOf(frac)),
	effectiveRainStoreMm: range(0, 500),
	lakeEvapFactor: range(0, 2),
	lakeEvapFactorMonthly: nullable(monthlyOf(range(0, 2))),
	apanMm: monthlyOf(range(0, 10_000)),
	panCoefficient: monthlyOf(range(0, 2)),
	ewrPragmaticM3PerDay: monthlyOf(nonNeg),
	flowShareMethod: oneOf(['area', 'hiLo', 'manual']),
	'hiLoSplit.hi': frac,
	'hiLoSplit.lo': frac,
	'gr4j.x1': gr4j('x1'),
	'gr4j.x2': gr4j('x2'),
	'gr4j.x3': gr4j('x3'),
	'gr4j.x4': gr4j('x4'),
	'gr4j.warmupDays': range(0, 3650, { int: true }),
	chirpsBiasCorrection: oneOf(CHIRPS_BIAS_MODES),
	pe: peInput,
	'zeroRainRuns.mode': oneOf(ZERO_RAIN_MODES),
	'zeroRainRuns.accumulationMode': oneOf(ACCUMULATION_MODES),
	'calibration.rainThresholdMm': range(0, 1000),
	'calibration.catchmentAreaKm2': nullable(range(0, 1e6, { loOpen: true })),
	simulationStart: nullable(isoDate),
	simulationEnd: nullable(isoDate),
	reportStart: nullable(isoDate),
	reportEnd: nullable(isoDate),
	calibrationStart: nullable(isoDate),
	calibrationEnd: nullable(isoDate),
	calibrationFlowKind: nullable(oneOf(CALIBRATION_FLOW_KINDS)),
	ewrChargeSource: oneOf(EWR_CHARGE_SOURCES),
	lowFlowMeasure: oneOf(LOW_FLOW_MEASURES),
	allocationMode: oneOf(ALLOCATION_MODES)
};

export const SETTINGS_PATHS = Object.keys(SETTINGS_CHECKS) as SettingsPath[];

/**
 * Paths a scenario could change before engine 1.0.0 removed the legacy runoff
 * model (issue #16). A stored op on one is refused with this reason, so the
 * scenario shows what to delete rather than a generic error.
 */
export const RETIRED_SETTINGS_PATHS: readonly string[] = [
	'runoffModel',
	'calibration.a',
	'calibration.b',
	'calibration.summerFactor',
	'calibration.winterFactor',
	'calibration.baseFlowInitial',
	'calibration.summerMonths'
];
const RETIRED_PATH_REASON = 'belonged to the legacy runoff model, removed in engine 1.0.0: delete this change';

const SETTINGS_CHECK = checksOf(SETTINGS_CHECKS);

export function settingsValueError(path: string, value: unknown): string | null {
	const c = checkFor(SETTINGS_CHECK, path);
	if (c) return c(value);
	return RETIRED_SETTINGS_PATHS.includes(path) ? RETIRED_PATH_REASON : `"${path}" is not a setting a scenario can change`;
}

// ---------------------------------------------------------------------------
// series.scale
// ---------------------------------------------------------------------------

/**
 * The series `series.scale` may scale: the rain drivers, and the daily A-pan
 * evaporation (engine ≥ 0.38.0, issue #45). The monthly A-pan means are the
 * `apanMm` setting (`settings.set`); they reach only the days the daily
 * series doesn't cover, so a scenario that changes evaporation on a project
 * with a daily record scales that series too.
 * Observed and logger flow are measurements the run is scored against, not
 * drivers: scaling them would change calibration statistics and the EWR
 * agreement, never the simulated water, so they are not scalable. The
 * reference gauge is never read by the engine.
 */
export const SCALABLE_SERIES_KINDS = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm', 'evap_apan_mm'] as const;
export type ScalableSeriesKind = (typeof SCALABLE_SERIES_KINDS)[number];
/** Largest factor series.scale accepts: a scenario scales a driver, it doesn't replace it. */
export const SERIES_SCALE_MAX = 10;

// ---------------------------------------------------------------------------
// demand.scale
// ---------------------------------------------------------------------------

/**
 * Whose demand `demand.scale` scales (issue #53 R1): `farm`, the farms'
 * irrigation demand (the default), or `user`, the other water users'
 * (WP-1.33). One op scales one category; scaling both is two ops.
 */
export const DEMAND_CATEGORIES = ['farm', 'user'] as const;
export type DemandCategory = (typeof DEMAND_CATEGORIES)[number];
/** Largest factor demand.scale accepts: at most double what a node would take. */
export const DEMAND_SCALE_MAX = 2;

/** A demand.scale op's list of node ids: at least one, no repeats. */
const nodeIdList: Check = (v) => {
	if (!Array.isArray(v) || v.length === 0) return 'must be a list of at least one node id (leave it out for every node of the category)';
	if (v.length > SCENARIO_OPS_MAX) return `must be at most ${SCENARIO_OPS_MAX} node ids`;
	for (const x of v) {
		const e = id(x);
		if (e) return `each ${e}`;
	}
	return new Set(v).size === v.length ? null : 'names a node more than once';
};
/** A demand.scale op's months: calendar months 1–12, at least one, no repeats. */
const demandMonths: Check = (v) => {
	if (!Array.isArray(v) || v.length === 0) return 'must be a list of at least one calendar month (leave it out for every month)';
	const e = months(v);
	if (e) return e;
	return new Set(v).size === v.length ? null : 'names a month more than once';
};

/** Check a demand.scale op's fields (applyScenario checks the node ids exist and are of the category). */
export function demandScaleError(op: { factor?: unknown; nodeIds?: unknown; months?: unknown; category?: unknown }): string | null {
	const checks: [string, Check][] = [
		['factor', range(0, DEMAND_SCALE_MAX)],
		['nodeIds', nodeIdList],
		['months', demandMonths],
		['category', oneOf(DEMAND_CATEGORIES)]
	];
	for (const [k, c] of checks) {
		const v = (op as Record<string, unknown>)[k];
		if (v === undefined && k !== 'factor') continue;
		const e = v === undefined ? 'missing' : c(v);
		if (e) return `${k} ${e}`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// ewrRule.set
// ---------------------------------------------------------------------------

/** A rule table's fields: the shape checks here, then the engine's own (ewrRuleTableIssues), as Settings does. */
const EWR_TABLE_FIELDS: Record<string, Check> = {
	siteNodeId: nullable(id),
	source: (v) => (typeof v === 'string' ? null : 'must be text'),
	sourceKind: nullable(oneOf(EWR_RULE_SOURCE_KINDS)),
	category: nullable((v) => (typeof v === 'string' ? null : 'must be text')),
	component: oneOf(EWR_RULE_COMPONENTS),
	unit: oneOf(EWR_RULE_UNITS),
	points: (v) => (Array.isArray(v) ? null : 'must be a list of % points'),
	ewr: (v) => (Array.isArray(v) ? null : 'must be 12 rows of values'),
	naturalSource: oneOf(EWR_NATURAL_SOURCES),
	natural: nullable((v) => (Array.isArray(v) ? null : 'must be 12 rows of values')),
	scale: (v) => (isNum(v) ? null : 'must be a finite number'),
	lowFlow: nullable((v) => (Array.isArray(v) ? null : 'must be 12 rows of values')),
	highFlows: (v) => (Array.isArray(v) ? null : 'must be a list'),
	naturalMarMcm: nullable((v) => (isNum(v) ? null : 'must be a finite number'))
};
/** Left out = not stated (sourceKind, category, naturalMarMcm), none (lowFlow, highFlows): the same as a table saved in Settings before them. */
const EWR_TABLE_OPTIONAL = new Set(['sourceKind', 'category', 'lowFlow', 'highFlows', 'naturalMarMcm']);
const HIGH_FLOW_KEYS = ['label', 'months', 'peakM3s', 'durationDays', 'perYear'] as const;

/**
 * An `ewrRule.set` op's table, rebuilt from its known fields (a high-flow
 * component's too), with every problem as `[field, message]`: the shape,
 * then the Settings form's and the backend's own checks (ewrRuleTableIssues),
 * so a table a scenario sets is one Settings would save.
 */
export function ewrRuleTableOpIssues(raw: unknown): { table: EwrRuleTable | null; issues: [string, string][] } {
	if (!isObj(raw)) return { table: null, issues: [['', 'must be a rule table']] };
	const errs: string[] = [];
	const t = pickFields(raw, EWR_TABLE_FIELDS, EWR_TABLE_OPTIONAL, '', errs) as Obj;
	const issues: [string, string][] = errs.map((e) => {
		const [k, ...rest] = e.slice(1).split(': ');
		return [k!, rest.join(': ')];
	});
	if (Array.isArray(t.highFlows)) {
		t.highFlows = t.highFlows.map((e) => (isObj(e) ? Object.fromEntries(HIGH_FLOW_KEYS.filter((k) => k in e).map((k) => [k, cloneValue(e[k])])) : e));
	}
	if (issues.length) return { table: null, issues };
	for (const i of ewrRuleTableIssues(t as unknown as EwrRuleTable)) issues.push([i.field, i.message]);
	return { table: issues.length ? null : (t as unknown as EwrRuleTable), issues };
}

// ---------------------------------------------------------------------------
// crop.set, landCover.set (engine ≥ 1.35.0)
// ---------------------------------------------------------------------------

/**
 * The fields `crop.set` may change: the name, the 12 crop factors and the
 * crop's own irrigation efficiency (null = the farm's). Never `id`, and not
 * `sortOrder` (display only).
 */
export const CROP_SET_FIELDS = ['name', 'cropFactor', 'irrigationEfficiency'] as const;
export type CropSetField = (typeof CROP_SET_FIELDS)[number];

const cropFactors: Check = (v) => (Array.isArray(v) && v.length === 12 && v.every((x) => isNum(x) && x >= 0) ? null : 'must be 12 crop factors ≥ 0');
const CROP_FIELD_CHECKS: Record<CropSetField, Check> = {
	name,
	cropFactor: cropFactors,
	// The crop's own irrigation efficiency (engine ≥ 0.43.0); null = the farm's.
	irrigationEfficiency: nullable(range(0, 1, { loOpen: true }))
};

const CROP_FIELD_CHECK = checksOf(CROP_FIELD_CHECKS);

export function cropFieldError(field: string, value: unknown): string | null {
	const c = checkFor(CROP_FIELD_CHECK, field);
	return c ? c(value) : `"${field}" is not a crop field a scenario can set`;
}

/**
 * The fields `landCover.set` may change: the class, area, condensed cover
 * and the reductions overriding the class's. Never `id`, nor `nodeId` (a
 * patch on another farm is removing it and adding one there).
 */
export const LAND_COVER_SET_FIELDS = ['coverClass', 'areaKm2', 'densityPct', 'factors'] as const;
export type LandCoverSetField = (typeof LAND_COVER_SET_FIELDS)[number];

const LAND_COVER_FIELD_CHECKS: Record<LandCoverSetField, Check> = {
	coverClass: oneOf(LAND_COVER_CLASSES.map((c) => c.id)),
	areaKm2: nonNeg,
	densityPct: frac,
	// Other keys are dropped when the op is rebuilt (validateScenarioOps, applyScenario), as everywhere else.
	factors: nullable((v) => (isObj(v) && frac(v.mar) === null && frac(v.lowFlow) === null ? null : 'must be { mar, lowFlow }, each 0–1'))
};

/** A patch's reductions rebuilt from their two known keys (null stays null). */
export const reductions = (v: unknown): { mar: number; lowFlow: number } | null => (isObj(v) ? { mar: v.mar as number, lowFlow: v.lowFlow as number } : null);

const LAND_COVER_FIELD_CHECK = checksOf(LAND_COVER_FIELD_CHECKS);

export function landCoverFieldError(field: string, value: unknown): string | null {
	const c = checkFor(LAND_COVER_FIELD_CHECK, field);
	return c ? c(value) : `"${field}" is not a land-cover field a scenario can set`;
}

// ---------------------------------------------------------------------------
// allocation.set (engine ≥ 1.35.0)
// ---------------------------------------------------------------------------

export const ALLOCATION_WATER_SOURCES = ['surface', 'groundwater'] as const;
/** The backend's limits (backend/src/allocations/routes.ts): volumes below 10¹² m³, a rate below 10⁶ m³/s. */
const allocVolume: Check = (v) => (isNum(v) && v >= 0 && v < 1e12 ? null : 'must be a number of m³ from 0 to below 10¹²');
const allocMonths: Check = (v) => {
	if (!Array.isArray(v) || v.length === 0) return 'must be a list of at least one calendar month (null for none stated)';
	const e = months(v);
	if (e) return e;
	return new Set(v).size === v.length ? null : 'names a month more than once';
};
const ALLOCATION_FIELDS: Record<string, Check> = {
	id,
	// The farm or other water user it is held for: a scenario's volume is always on a unit (an unmatched one compares with nothing).
	nodeId: id,
	waterSource: oneOf(ALLOCATION_WATER_SOURCES),
	volumeM3PerYear: allocVolume,
	storageM3: nullable(allocVolume),
	validFrom: nullable(isoDate),
	validTo: nullable(isoDate),
	months: nullable(allocMonths),
	maxRateM3s: nullable((v) => (isNum(v) && v >= 0 && v < 1e6 ? null : 'must be a rate in m³/s from 0 to below 10⁶'))
};
/** Left out = not stated (no storage, open validity, no licence conditions), as a volume entered by hand. */
const ALLOCATION_OPTIONAL = new Set(['storageM3', 'validFrom', 'validTo', 'months', 'maxRateM3s']);

/**
 * An `allocation.set` op's entry rebuilt from its known fields, with every
 * problem as `[field, message]` (the validator's and applyScenario's one check).
 */
export function allocationOpIssues(raw: unknown): { allocation: AllocationEntry | null; issues: [string, string][] } {
	if (!isObj(raw)) return { allocation: null, issues: [['', 'must be a registered volume']] };
	const errs: string[] = [];
	const a = pickFields(raw, ALLOCATION_FIELDS, ALLOCATION_OPTIONAL, '', errs) as Obj;
	const issues: [string, string][] = errs.map((e) => {
		const [k, ...rest] = e.slice(1).split(': ');
		return [k!, rest.join(': ')];
	});
	if (typeof a.validFrom === 'string' && typeof a.validTo === 'string' && a.validFrom > a.validTo) issues.push(['validTo', `is before valid from (${a.validFrom})`]);
	return { allocation: issues.length ? null : (a as unknown as AllocationEntry), issues };
}

// ---------------------------------------------------------------------------
// demandObject.add, demandObject.set, demandObject.remove (engine ≥ 1.41.0)
// ---------------------------------------------------------------------------

/**
 * The fields `demandObject.set` may change: every field of a demand object
 * but `id`, and not `nodeId` (an object on another unit is removing it and
 * adding one there, as a land-cover patch). How the fields fit together (a
 * monthly demand needs 12 values, a demand per unit a count and litres,
 * nothing returns from one piped out, the schedule's windows) is a model
 * rule (modelRules.ts), so consecutive `demandObject.set` ops on one object
 * are one edit group, checked once after the last (docs/scenarios.md § Edit groups).
 */
export const DEMAND_OBJECT_SET_FIELDS = [
	'name',
	'category',
	'sizing',
	'monthlyM3Day',
	'count',
	'litresPerUnitDay',
	'lossPct',
	'monthlyFactor',
	'returnPct',
	'priority',
	'destination',
	'enabled',
	'schedule',
	'note'
] as const;
export type DemandObjectSetField = (typeof DEMAND_OBJECT_SET_FIELDS)[number];

const DEMAND_WINDOW_KEYS = ['label', 'span', 'from', 'to', 'easterFrom', 'easterTo', 'weekdays', 'factor'] as const;
const DEMAND_WINDOW_CHECKS: Record<(typeof DEMAND_WINDOW_KEYS)[number], Check> = {
	label: (v) => (typeof v === 'string' && v.length <= 200 ? null : 'must be text of at most 200 characters'),
	span: oneOf(DEMAND_SCHEDULE_SPANS),
	from: nullable((v) => (typeof v === 'string' && v.length <= 10 ? null : 'must be a date of at most 10 characters')),
	to: nullable((v) => (typeof v === 'string' && v.length <= 10 ? null : 'must be a date of at most 10 characters')),
	easterFrom: nullable((v) => (Number.isInteger(v) ? null : 'must be a whole number of days')),
	easterTo: nullable((v) => (Number.isInteger(v) ? null : 'must be a whole number of days')),
	weekdays: nullable((v) =>
		Array.isArray(v) && v.length >= 1 && v.length <= 7 && v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) ? null : 'must be 1–7 ISO weekdays (1 = Monday … 7 = Sunday)'
	),
	factor: range(0, DEMAND_SCHEDULE_MAX_FACTOR)
};
/**
 * A demand object's schedule, as the backend's model schema takes it: up to
 * DEMAND_SCHEDULE_MAX_WINDOWS windows, each with all its fields. What they
 * mean (real dates, spans in order) is a model rule (scheduleWindowProblem).
 */
const demandSchedule: Check = nullable((v) => {
	if (!Array.isArray(v)) return 'must be a list of schedule windows';
	if (v.length > DEMAND_SCHEDULE_MAX_WINDOWS) return `must be at most ${DEMAND_SCHEDULE_MAX_WINDOWS} windows`;
	for (let i = 0; i < v.length; i++) {
		const w = v[i];
		if (!isObj(w)) return `window ${i + 1}: must be an object`;
		for (const k of DEMAND_WINDOW_KEYS) {
			const e = k in w ? DEMAND_WINDOW_CHECKS[k](w[k]) : 'missing';
			if (e) return `window ${i + 1}: ${k} ${e}`;
		}
	}
	return null;
});
/** A checked schedule rebuilt from each window's known fields, its label trimmed as a save trims it (null stays null). */
const scheduleOf = (v: unknown): DemandScheduleWindow[] | null =>
	Array.isArray(v)
		? v.map((w) => Object.fromEntries(DEMAND_WINDOW_KEYS.map((k) => [k, k === 'label' ? String((w as Obj)[k]).trim() : cloneValue((w as Obj)[k])])) as unknown as DemandScheduleWindow)
		: null;

const DEMAND_OBJECT_FIELD_CHECKS: Record<DemandObjectSetField, Check> = {
	name: (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 200 ? null : 'must be a name of 1–200 characters'),
	category: oneOf(DEMAND_OBJECT_CATEGORIES),
	sizing: oneOf(DEMAND_OBJECT_SIZINGS),
	monthlyM3Day: nullable(monthlyOf(nonNeg)),
	count: nullable(nonNeg),
	litresPerUnitDay: nullable(nonNeg),
	lossPct: (v) => (isNum(v) && v >= 0 && v < 1 ? null : 'must be at least 0 and below 1'),
	monthlyFactor: nullable(monthlyOf(nonNeg)),
	returnPct: frac,
	priority: oneOf(DEMAND_OBJECT_PRIORITIES),
	destination: oneOf(DEMAND_OBJECT_DESTINATIONS),
	enabled: boolean,
	schedule: demandSchedule,
	note: (v) => (typeof v === 'string' && v.length <= 1000 ? null : 'must be text of at most 1000 characters')
};

const DEMAND_OBJECT_FIELD_CHECK = checksOf(DEMAND_OBJECT_FIELD_CHECKS);

export function demandObjectFieldError(field: string, value: unknown): string | null {
	const c = checkFor(DEMAND_OBJECT_FIELD_CHECK, field);
	return c ? c(value) : `"${field}" is not a demand-object field a scenario can set`;
}

/** A demandObject.set value as applyScenario writes it: a name and a note trimmed, a schedule rebuilt from its windows' known fields. */
export function demandObjectValue(field: DemandObjectSetField, value: unknown): unknown {
	return field === 'name' || field === 'note' ? (value as string).trim() : field === 'schedule' ? scheduleOf(value) : cloneValue(value);
}

const DEMAND_OBJECT_FIELDS: Record<string, Check> = { id, nodeId: id, ...DEMAND_OBJECT_FIELD_CHECKS };
/** Left out = no schedule (every day at its month's demand), no note: as an object saved before them. */
const DEMAND_OBJECT_OPTIONAL = new Set(['schedule', 'note']);

/**
 * A `demandObject.add` op's object rebuilt from its known fields (its
 * schedule's windows too), with every problem as `[field, message]`: the
 * validator's and applyScenario's one check.
 */
export function demandObjectOpIssues(raw: unknown): { demandObject: DemandObject | null; issues: [string, string][] } {
	if (!isObj(raw)) return { demandObject: null, issues: [['', 'must be a demand object']] };
	const errs: string[] = [];
	const o = pickFields(raw, DEMAND_OBJECT_FIELDS, DEMAND_OBJECT_OPTIONAL, '', errs) as Obj;
	const issues: [string, string][] = errs.map((e) => {
		const [k, ...rest] = e.slice(1).split(': ');
		return [k!, rest.join(': ')];
	});
	if (issues.length) return { demandObject: null, issues };
	if ('schedule' in o) o.schedule = scheduleOf(o.schedule);
	return { demandObject: o as unknown as DemandObject, issues };
}

// ---------------------------------------------------------------------------
// node.insert (engine ≥ 1.35.0)
// ---------------------------------------------------------------------------

/** node.insert's nodes re-pointed into the new one: at least one, no repeats. */
const upstreamList: Check = (v) => {
	if (!Array.isArray(v) || v.length === 0) return 'must be a list of at least one node id (the nodes that will drain into the new one; with none, add the node instead)';
	if (v.length > SCENARIO_OPS_MAX) return `must be at most ${SCENARIO_OPS_MAX} node ids`;
	for (const x of v) {
		const e = id(x);
		if (e) return `each ${e}`;
	}
	return new Set(v).size === v.length ? null : 'names a node more than once';
};

// ---------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------

export type NodeSetOp = { [F in NodeSetField]: { op: 'node.set'; nodeId: string; field: F; value: NodeSetValue<F> } }[NodeSetField];
export type TransferSetOp = { [F in TransferSetField]: { op: 'transfer.set'; transferId: string; field: F; value: Transfer[F] } }[TransferSetField];
export type SettingsSetOp = { [P in SettingsPath]: { op: 'settings.set'; path: P; value: SettingsPathValues[P] } }[SettingsPath];
export type CropSetOp = { [F in CropSetField]: { op: 'crop.set'; cropId: string; field: F; value: Exclude<CropDef[F], undefined> } }[CropSetField];
export type LandCoverSetOp = { [F in LandCoverSetField]: { op: 'landCover.set'; patchId: string; field: F; value: LandCoverPatch[F] } }[LandCoverSetField];
export type DemandObjectSetOp = {
	[F in DemandObjectSetField]: { op: 'demandObject.set'; demandObjectId: string; field: F; value: Exclude<DemandObject[F], undefined> };
}[DemandObjectSetField];

/**
 * One override. A closed union: every op targets an existing element by id
 * (or adds one with a fresh id), so a scenario lines up with its base run by
 * id in run comparison. docs/scenarios.md has the catalogue.
 */
export type ScenarioOp =
	| NodeSetOp
	/** A new leaf node draining into an existing one (it can't become the outflow). */
	| { op: 'node.add'; node: NetworkNode }
	/** Remove a node; its upstream nodes drain into its downstream node instead. */
	| { op: 'node.remove'; nodeId: string }
	/** Make a node drain into another (engine ≥ 1.35.0): it takes its upstream nodes with it; the network stays one tree. */
	| { op: 'node.move'; nodeId: string; downstreamNodeId: string }
	/** A new node on a reach (engine ≥ 1.35.0): `upstreamNodeIds`, each draining into the new node's downstream node, drain into it instead. */
	| NodeInsertOp
	/** Set a farm's area of one crop; 0 removes the row. */
	| { op: 'cropArea.set'; nodeId: string; cropId: string; areaM2: number }
	| { op: 'crop.add'; crop: CropDef }
	/** Change one field of a crop definition (engine ≥ 1.35.0): its name, crop factors or own irrigation efficiency. */
	| CropSetOp
	/** Remove a crop and every farm's area of it (engine ≥ 1.35.0). */
	| { op: 'crop.remove'; cropId: string }
	| { op: 'transfer.add'; transfer: Transfer }
	| TransferSetOp
	| { op: 'transfer.remove'; transferId: string }
	| { op: 'landCover.add'; patch: LandCoverPatch }
	| { op: 'landCover.remove'; patchId: string }
	/** Change one field of a land-cover patch in place (engine ≥ 1.35.0). */
	| LandCoverSetOp
	/** A new borehole on a farm or other user (WP-3.9). */
	| { op: 'borehole.add'; borehole: Borehole }
	| { op: 'borehole.remove'; boreholeId: string }
	/** A new demand object on a unit (engine ≥ 1.41.0): a town, household, livestock or any other demand that isn't a crop. */
	| { op: 'demandObject.add'; demandObject: DemandObject }
	/** Change one field of a demand object (engine ≥ 1.41.0). */
	| DemandObjectSetOp
	| { op: 'demandObject.remove'; demandObjectId: string }
	| SettingsSetOp
	/** Multiply a rain series by factor on the days from–to (inclusive; each open when absent). */
	| { op: 'series.scale'; kind: ScalableSeriesKind; factor: number; from?: string; to?: string }
	| DemandScaleOp
	| EwrRuleSetOp
	/** Remove the Reserve rule table of one EWR site (engine ≥ 1.35.0): null = the outlet. Always a baseline assumption. */
	| { op: 'ewrRule.remove'; siteNodeId: string | null }
	/** Set or replace one registered volume by id (engine ≥ 1.35.0, docs/allocations.md): what allocationMode caps or scales a run to. */
	| { op: 'allocation.set'; allocation: AllocationEntry }
	| { op: 'allocation.remove'; allocationId: string };

/**
 * A new node placed on a reach (engine ≥ 1.35.0): `node` as `node.add` takes
 * it, and the existing nodes in `upstreamNodeIds`, each draining into
 * `node.downstreamNodeId` now, drain into the new node instead. The order of
 * everything along the river is kept; the new node sits between.
 */
export interface NodeInsertOp {
	op: 'node.insert';
	node: NetworkNode;
	upstreamNodeIds: string[];
}

/**
 * Set or replace the Reserve rule table of one EWR site (engine ≥ 1.6.0,
 * WP-3.7): `table.siteNodeId` is the site (null = the outlet, else a gauge
 * marked as an EWR site). A site with a table has it replaced whole; one
 * without gets it. Always a baseline assumption (classifyOp): the Reserve is
 * never the applicant's to propose.
 */
export interface EwrRuleSetOp {
	op: 'ewrRule.set';
	table: EwrRuleTable;
}

/**
 * Multiply demand by `factor` (0–2, issue #53 R1): the farms' irrigation
 * demand (their crop water requirement, so efficiency and return flows are
 * unchanged), or with `category: 'user'` the other water users'. `nodeIds`
 * limits it to those nodes (default: every node of the category); `months`
 * to those calendar months (1–12, Oct = 10; default: every month). Ops
 * stack: two at 0.9 leave 0.81.
 */
export interface DemandScaleOp {
	op: 'demand.scale';
	factor: number;
	nodeIds?: string[];
	months?: number[];
	category?: DemandCategory;
}

export type ScenarioOpName = ScenarioOp['op'];
export const SCENARIO_OP_NAMES = [
	'node.set',
	'node.add',
	'node.remove',
	'node.move',
	'node.insert',
	'cropArea.set',
	'crop.add',
	'crop.set',
	'crop.remove',
	'transfer.add',
	'transfer.set',
	'transfer.remove',
	'landCover.add',
	'landCover.remove',
	'landCover.set',
	'borehole.add',
	'borehole.remove',
	'demandObject.add',
	'demandObject.set',
	'demandObject.remove',
	'settings.set',
	'series.scale',
	'demand.scale',
	'ewrRule.set',
	'ewrRule.remove',
	'allocation.set',
	'allocation.remove'
] as const satisfies readonly ScenarioOpName[];

/** Most ops one scenario may hold (the backend's body limit mirrors it). */
export const SCENARIO_OPS_MAX = 500;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------


/** Build a clean object from `fields`, collecting the errors; unknown keys are dropped. */
function pickFields(src: Obj, fields: Record<string, Check>, optional: ReadonlySet<string>, where: string, errors: string[]): Obj {
	const out: Obj = {};
	for (const [k, c] of Object.entries(fields)) {
		if (!(k in src) || src[k] === undefined) {
			if (!optional.has(k)) errors.push(`${where}.${k}: missing`);
			continue;
		}
		const e = c(src[k]);
		if (e) errors.push(`${where}.${k}: ${e}`);
		else out[k] = cloneValue(src[k]);
	}
	return out;
}
const cloneValue = (v: unknown): unknown => (Array.isArray(v) ? v.map(cloneValue) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneValue(x)])) : v);

const NODE_FIELDS: Record<string, Check> = {
	id,
	kind: oneOf(['farm', 'gauge', 'user']),
	downstreamNodeId: id,
	sortOrder: range(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, { int: true }),
	...NODE_FIELD_CHECKS,
	// A new farm or user may bring its GN 538 property area and Table 2 rate (engine ≥ 1.12.0), context for its groundwater.
	gaPropertyAreaHa: nullable(range(0, 10_000_000)),
	gaRateM3HaYear: nullable((v) => (isGa538Rate(v) ? null : `must be one of the GN 538 Table 2 rates: ${GA538_GROUNDWATER_RATES.join(', ')}`))
};
/** Check one field of a node.add's node (any field a node may carry, not only those node.set may change). */
const NODE_FIELD_ADD_CHECK = checksOf(NODE_FIELDS);
export function nodeAddFieldError(field: string, value: unknown): string | null {
	const c = checkFor(NODE_FIELD_ADD_CHECK, field);
	return c ? c(value) : `"${field}" is not a node field`;
}
/** A new node's fields that may be left out: they take the engine's defaults (upgradeLegacyModel). */
const NODE_OPTIONAL = new Set<string>([
	'sortOrder',
	'damAreaFullM2',
	'damAreaExponent',
	'damSeepagePerDay',
	...SUPPLY,
	...OPERATING,
	...DAM_STORAGE,
	// Development over the run (engine ≥ 1.30.0): the node's entered dam and demand throughout unless given.
	...DEVELOPMENT,
	'abstractionFrom',
	...USER,
	...BOREHOLES,
	// A new gauge is an EWR site unless it says otherwise (engine ≥ 1.5.0).
	'ewrSite',
	// GN 538 context (engine ≥ 1.12.0): unknown unless given.
	'gaPropertyAreaHa',
	'gaRateM3HaYear'
]);
const CROP_FIELDS: Record<string, Check> = {
	id,
	name,
	sortOrder: range(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, { int: true }),
	cropFactor: CROP_FIELD_CHECKS.cropFactor,
	irrigationEfficiency: CROP_FIELD_CHECKS.irrigationEfficiency
};
const TRANSFER_FIELDS: Record<string, Check> = { id, ...TRANSFER_FIELD_CHECKS };
const LAND_COVER_FIELDS: Record<string, Check> = {
	id,
	nodeId: id,
	coverClass: oneOf(LAND_COVER_CLASSES.map((c) => c.id)),
	areaKm2: nonNeg,
	densityPct: frac,
	factors: LAND_COVER_FIELD_CHECKS.factors
};
const BOREHOLE_FIELDS: Record<string, Check> = {
	id,
	nodeId: id,
	name: (v) => (typeof v === 'string' && v.length <= 200 ? null : 'must be a name of at most 200 characters'),
	capacityM3Day: nonNeg,
	annualCapM3: nullable(nonNeg),
	mode: oneOf(BOREHOLE_MODES),
	emergencyBelowPct: frac,
	target: oneOf(BOREHOLE_TARGETS),
	depletionFactor: frac
};
const NONE = new Set<string>();

function validateOne(raw: unknown, where: string, errors: string[]): ScenarioOp | null {
	if (!isObj(raw)) {
		errors.push(`${where}: must be an object`);
		return null;
	}
	const n = errors.length;
	const need = (k: string, c: Check) => {
		const e = k in raw ? c(raw[k]) : 'missing';
		if (e) errors.push(`${where}.${k}: ${e}`);
		return raw[k];
	};
	const sub = (k: string, fields: Record<string, Check>, optional = NONE): Obj => {
		const v = raw[k];
		if (!isObj(v)) {
			errors.push(`${where}.${k}: must be an object`);
			return {};
		}
		return pickFields(v, fields, optional, `${where}.${k}`, errors);
	};
	let op: ScenarioOp | null = null;
	switch (raw.op) {
		case 'node.set': {
			const nodeId = need('nodeId', id);
			const field = need('field', (v) => (typeof v === 'string' && NODE_FIELD_CHECK.byName.has(v) ? null : 'is not a node field a scenario can set'));
			if (typeof field === 'string' && NODE_FIELD_CHECK.byName.has(field)) need('value', (v) => nodeFieldError(field, v));
			op = { op: 'node.set', nodeId, field, value: cloneValue(raw.value) } as ScenarioOp;
			break;
		}
		case 'node.add':
			op = { op: 'node.add', node: sub('node', NODE_FIELDS, NODE_OPTIONAL) as unknown as NetworkNode };
			break;
		case 'node.remove':
			op = { op: 'node.remove', nodeId: need('nodeId', id) as string };
			break;
		case 'node.move':
			op = { op: 'node.move', nodeId: need('nodeId', id) as string, downstreamNodeId: need('downstreamNodeId', id) as string };
			break;
		case 'node.insert': {
			const node = sub('node', NODE_FIELDS, NODE_OPTIONAL) as unknown as NetworkNode;
			const ups = need('upstreamNodeIds', upstreamList);
			op = { op: 'node.insert', node, upstreamNodeIds: Array.isArray(ups) ? (cloneValue(ups) as string[]) : [] };
			break;
		}
		case 'cropArea.set':
			op = { op: 'cropArea.set', nodeId: need('nodeId', id) as string, cropId: need('cropId', id) as string, areaM2: need('areaM2', nonNeg) as number };
			break;
		case 'crop.add':
			op = { op: 'crop.add', crop: sub('crop', CROP_FIELDS, new Set(['sortOrder', 'irrigationEfficiency'])) as unknown as CropDef };
			break;
		case 'crop.set': {
			const cropId = need('cropId', id);
			const field = need('field', (v) => (typeof v === 'string' && CROP_FIELD_CHECK.byName.has(v) ? null : 'is not a crop field a scenario can set'));
			if (typeof field === 'string' && CROP_FIELD_CHECK.byName.has(field)) need('value', (v) => cropFieldError(field, v));
			op = { op: 'crop.set', cropId, field, value: cloneValue(raw.value) } as ScenarioOp;
			break;
		}
		case 'crop.remove':
			op = { op: 'crop.remove', cropId: need('cropId', id) as string };
			break;
		case 'transfer.add':
			op = { op: 'transfer.add', transfer: sub('transfer', TRANSFER_FIELDS, TRANSFER_OPTIONAL) as unknown as Transfer };
			break;
		case 'transfer.set': {
			const transferId = need('transferId', id);
			const field = need('field', (v) => (typeof v === 'string' && TRANSFER_FIELD_CHECK.byName.has(v) ? null : 'is not a transfer field a scenario can set'));
			if (typeof field === 'string' && TRANSFER_FIELD_CHECK.byName.has(field)) need('value', (v) => transferFieldError(field, v));
			op = { op: 'transfer.set', transferId, field, value: cloneValue(raw.value) } as ScenarioOp;
			break;
		}
		case 'transfer.remove':
			op = { op: 'transfer.remove', transferId: need('transferId', id) as string };
			break;
		case 'landCover.add':
			op = { op: 'landCover.add', patch: sub('patch', LAND_COVER_FIELDS) as unknown as LandCoverPatch };
			break;
		case 'landCover.remove':
			op = { op: 'landCover.remove', patchId: need('patchId', id) as string };
			break;
		case 'landCover.set': {
			const patchId = need('patchId', id);
			const field = need('field', (v) => (typeof v === 'string' && LAND_COVER_FIELD_CHECK.byName.has(v) ? null : 'is not a land-cover field a scenario can set'));
			if (typeof field === 'string' && LAND_COVER_FIELD_CHECK.byName.has(field)) need('value', (v) => landCoverFieldError(field, v));
			op = { op: 'landCover.set', patchId, field, value: field === 'factors' ? reductions(raw.value) : cloneValue(raw.value) } as ScenarioOp;
			break;
		}
		case 'borehole.add':
			op = { op: 'borehole.add', borehole: sub('borehole', BOREHOLE_FIELDS) as unknown as Borehole };
			break;
		case 'borehole.remove':
			op = { op: 'borehole.remove', boreholeId: need('boreholeId', id) as string };
			break;
		case 'demandObject.add': {
			const { demandObject, issues } = demandObjectOpIssues(raw.demandObject);
			for (const [k, m] of issues) errors.push(`${where}.demandObject${k ? `.${k}` : ''}: ${m}`);
			op = { op: 'demandObject.add', demandObject: demandObject as DemandObject };
			break;
		}
		case 'demandObject.set': {
			const demandObjectId = need('demandObjectId', id);
			const field = need('field', (v) => (typeof v === 'string' && DEMAND_OBJECT_FIELD_CHECK.byName.has(v) ? null : 'is not a demand-object field a scenario can set'));
			const known = allowed(DEMAND_OBJECT_SET_FIELDS, field);
			if (known) need('value', (v) => demandObjectFieldError(known, v));
			// A schedule is rebuilt from its windows' known fields; any other value is kept as sent.
			op = { op: 'demandObject.set', demandObjectId, field, value: known === 'schedule' && errors.length === n ? scheduleOf(raw.value) : cloneValue(raw.value) } as ScenarioOp;
			break;
		}
		case 'demandObject.remove':
			op = { op: 'demandObject.remove', demandObjectId: need('demandObjectId', id) as string };
			break;
		case 'settings.set': {
			const path = need('path', (v) =>
				typeof v === 'string' && SETTINGS_CHECK.byName.has(v) ? null : typeof v === 'string' && RETIRED_SETTINGS_PATHS.includes(v) ? RETIRED_PATH_REASON : 'is not a setting a scenario can change'
			);
			if (typeof path === 'string' && SETTINGS_CHECK.byName.has(path)) need('value', (v) => settingsValueError(path, v));
			op = { op: 'settings.set', path, value: cloneValue(raw.value) } as ScenarioOp;
			break;
		}
		case 'series.scale': {
			const kind = need('kind', oneOf(SCALABLE_SERIES_KINDS)) as ScalableSeriesKind;
			const factor = need('factor', range(0, SERIES_SCALE_MAX)) as number;
			const s: { op: 'series.scale'; kind: ScalableSeriesKind; factor: number; from?: string; to?: string } = { op: 'series.scale', kind, factor };
			for (const k of ['from', 'to'] as const) {
				if (raw[k] === undefined) continue;
				if (isIsoDate(raw[k])) s[k] = raw[k];
				else errors.push(`${where}.${k}: must be an ISO date (YYYY-MM-DD)`);
			}
			if (s.from && s.to && s.from > s.to) errors.push(`${where}: from ${s.from} is after to ${s.to}`);
			op = s;
			break;
		}
		case 'demand.scale': {
			const s: DemandScaleOp = { op: 'demand.scale', factor: need('factor', range(0, DEMAND_SCALE_MAX)) as number };
			// Optional fields are kept only when given, so an op's stored form (and its hash) is what was sent.
			const opt = (k: 'nodeIds' | 'months' | 'category', c: Check) => {
				if (raw[k] === undefined) return;
				const e = c(raw[k]);
				if (e) errors.push(`${where}.${k}: ${e}`);
				else (s as unknown as Obj)[k] = cloneValue(raw[k]);
			};
			opt('nodeIds', nodeIdList);
			opt('months', demandMonths);
			opt('category', oneOf(DEMAND_CATEGORIES));
			op = s;
			break;
		}
		case 'ewrRule.set': {
			const { table, issues } = ewrRuleTableOpIssues(raw.table);
			for (const [k, m] of issues) errors.push(`${where}.table${k ? `.${k}` : ''}: ${m}`);
			op = { op: 'ewrRule.set', table: table as EwrRuleTable };
			break;
		}
		case 'ewrRule.remove':
			// null = the outlet; present either way, so the stored op says which site.
			op = { op: 'ewrRule.remove', siteNodeId: need('siteNodeId', nullable(id)) as string | null };
			break;
		case 'allocation.set': {
			const { allocation, issues } = allocationOpIssues(raw.allocation);
			for (const [k, m] of issues) errors.push(`${where}.allocation${k ? `.${k}` : ''}: ${m}`);
			op = { op: 'allocation.set', allocation: allocation as AllocationEntry };
			break;
		}
		case 'allocation.remove':
			op = { op: 'allocation.remove', allocationId: need('allocationId', id) as string };
			break;
		default:
			errors.push(`${where}.op: must be one of ${SCENARIO_OP_NAMES.join(', ')}`);
	}
	return errors.length === n ? op : null;
}

/**
 * Check an untrusted op list (a request body, a stored `scenario.ops`).
 * Returns the ops rebuilt from their known fields only (unknown keys are
 * dropped) and every error, each prefixed with its path (`ops[3].value: …`).
 * Callers reject the list when `errors` is non-empty; `ops` then holds only
 * the entries that passed. Existence of the ids an op targets is not checked
 * here: that depends on the base run, and `applyScenario` reports it.
 */
export function validateScenarioOps(raw: unknown): { ops: ScenarioOp[]; errors: string[] } {
	if (!Array.isArray(raw)) return { ops: [], errors: ['ops: must be a list'] };
	if (raw.length > SCENARIO_OPS_MAX) return { ops: [], errors: [`ops: at most ${SCENARIO_OPS_MAX} ops`] };
	const errors: string[] = [];
	const ops: ScenarioOp[] = [];
	raw.forEach((r, i) => {
		const op = validateOne(r, `ops[${i}]`, errors);
		if (op) ops.push(op);
	});
	return { ops, errors };
}
