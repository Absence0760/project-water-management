// A cap or full-allocation run as a viewer kept from each registered volume
// reads it: its river outcomes only (decision D3; issue #523 security review,
// finding I and its round 4; the operator's decision of 2026-10-11;
// docs/security.md § Allocations).
//
// In such a run every unit's use is worked out from the registered volumes:
// a cap's room on a licence's first day is the volume and a year the cap binds
// adds up to it; a full allocation scales demand to it. So is every figure
// that sums use: the catchment water balance less the units shown is a bound
// unit's volume exactly. Withholding unit by unit (round 3) left such
// differences, so this is an allowlist: such a viewer reads only what is
// listed here (the EWR results, the outflow and the results at the EWR and
// gauge sites, the catchment's natural flow and the inputs that make it), and
// nothing of any unit, bound or not. Anything the engine adds later is
// withheld until it is listed. Every other run gives that viewer everything
// but the allocation series. Pure: the routes decide who is kept from the
// volumes (allocationUnitsHidden).
import { ALLOCATION_SERIES } from '@water-management/engine';

/** The series a run stores from the registered volumes on any unit (engine ≥ 1.18.0): withheld on every run. */
export const ALLOCATION_SERIES_KEYS: ReadonlySet<string> = new Set(Object.values(ALLOCATION_SERIES).map((s) => s.key));

type AllocationsLike = { mode?: unknown } | null | undefined;

/** A run whose figures rest on the registered volumes: one that caps use at them or scales demand to them. */
export const riverOutcomesOnly = (allocations: AllocationsLike): boolean => allocations?.mode === 'cap' || allocations?.mode === 'fullAllocation';

/**
 * The catchment's series such a viewer reads (node null): the natural flow,
 * the outflow, the EWR and its shortfall at the outlet, and the rain, flow
 * records and runoff model that make the natural flow.
 */
export const CATCHMENT_RIVER_SERIES: ReadonlySet<string> = new Set([
	'natural_flow',
	'simulated_outflow',
	'ewr',
	'ewr_shortfall',
	'ewr_charged',
	'ewr_natural',
	'ewr_charge_shortfall',
	'landcover_reduction',
	// Rain and its handling.
	'rain_used',
	'rain_final',
	'rain_areal',
	'rain_chirps',
	'rain_chirps_corrected',
	'rain_chirps_mapped',
	'chirps_factor',
	'rain_catchment_missing',
	'rain_catchment_spread',
	'rain_source',
	// The runoff model (GR4J and the legacy [Flow data] columns).
	'pet',
	'aet',
	'exchange',
	'production_store',
	'routing_store',
	'uh_store',
	'rain_flow',
	'base_flow',
	'response_flow',
	'resultant_flow',
	'is_summer',
	// The observed records and their gap fill.
	'observed_flow',
	'observed_flow_other',
	'observed_flow_quality',
	'observed_flow_fill',
	'observed_flow_filled',
	'observed_flow_other_fill',
	'observed_flow_other_filled'
]);

/** A gauge's series such a viewer reads (an EWR or flow site, never a unit): its flows, its EWR and their shortfall. */
export const GAUGE_RIVER_SERIES: ReadonlySet<string> = new Set([
	'inflow_upstream',
	'outflow',
	'ewr_cumulative',
	'ewr_shortfall',
	'ewr_charged',
	'ewr_natural',
	'ewr_charge_shortfall',
	'reach_loss'
]);

/** Whether such a viewer reads this series of such a run: a listed catchment series, or a listed series of a gauge. */
export const riverSeries = (gauges: ReadonlySet<string>, nodeId: string | null, key: string): boolean =>
	nodeId === null ? CATCHMENT_RIVER_SERIES.has(key) : gauges.has(nodeId) && GAUGE_RIVER_SERIES.has(key);

/** What the run pages say instead of the units (summary.allocations.riverOutcomesOnly). */
export const RIVER_OUTCOMES_NOTE =
	'This run caps use at, or scales demand to, the registered water volumes, which this project shows to its editors and owners only: only its river outcomes are given.';

const pick = <T extends object, K extends keyof T>(o: T | null | undefined, keys: readonly K[]): Pick<T, K> | undefined =>
	o ? (Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) as Pick<T, K>) : undefined;

/** Summary fields read whole: the river, the runoff model and the inputs, none of which carries a unit's figure. */
const SUMMARY_WHOLE = [
	'historyDays',
	'runoff',
	'catchment',
	'calibration',
	'ewrAssurance',
	'wr2012',
	'chirpsCorrection',
	'forecastRain',
	'zeroRainInfill',
	'flowGapFill',
	'rainSource',
	'apanDaily',
	'rainAccumulation'
] as const;

type SummaryLike = Record<string, unknown> & { allocations?: Record<string, unknown> | null };

/**
 * A run summary as that viewer reads it, when the run caps or fully
 * allocates: only the listed fields, every unit list empty, the allocation
 * counts without the per-unit part and `allocations.riverOutcomesOnly` (the
 * marker the pages read), and `withheld` naming the fields left out. Any
 * other run comes back as it is. Idempotent.
 */
export function riverOutcomesSummary<S>(summary: S): S {
	const s = summary as SummaryLike | null | undefined;
	if (!s || !riverOutcomesOnly(s.allocations)) return summary;
	if ((s.allocations as { riverOutcomesOnly?: unknown }).riverOutcomesOnly === true) return summary;
	const out: Record<string, unknown> = {};
	for (const k of SUMMARY_WHOLE) if (k in s) out[k] = s[k];
	const ec = s.ewrCompliance as { farms?: unknown } | undefined;
	if (ec) out.ewrCompliance = { ...ec, farms: [] };
	const served = s.servedWhileEwrFails as Record<string, unknown>[] | undefined;
	if (served) out.servedWhileEwrFails = served.map((x) => ({ ...pick(x, ['nodeId', 'name', 'basis', 'daysNotMet']), units: [] }));
	const dq = s.dataQuality as Record<string, unknown> | undefined;
	if (dq) out.dataQuality = pick(dq, ['observedAgreement', 'seriesChecks', 'doubleMass']);
	const forecast = s.forecast as Record<string, unknown> | undefined;
	if (forecast) out.forecast = { ...pick(forecast, ['from', 'to', 'days', 'lastObserved', 'rainMm', 'outletEwrDaysAtRisk']), perFarm: [] };
	out.farms = [];
	out.users = [];
	out.warnings = [];
	out.allocations = { ...pick(s.allocations!, ['mode', 'tolerance', 'used', 'notMatched']), nodes: [], riverOutcomesOnly: true };
	out.withheld = Object.keys(s).filter((k) => !(k in out) && s[k] !== undefined && s[k] !== null).sort();
	return out as S;
}

/** The evidence report's page-1 rows that are river outcomes (not a unit's or a use's). */
const RIVER_ROWS: ReadonlySet<string> = new Set(['reserve', 'ewrDays', 'shortfall', 'noFlowDays', 'ewrBelowWorks', 'outflowMar', 'otherApplications']);
/** Its flags that say nothing of a unit's or a use's figure. */
const RIVER_FLAGS: ReadonlySet<string> = new Set(['assumptions', 'reference', 'ewrZero', 'noReserve', 'gated', 'noRule', 'noCalibration', 'noFit', 'chirps', 'dataQuality', 'notEndorsed']);
/** A member's metrics such a viewer reads: the river's (no record by unit). */
const RIVER_METRICS = [
	'ewrDaysNotMet',
	'ewrDaysNotMetByMonth',
	'shortfallMm3',
	'marNaturalMm3',
	'marOutflowMm3',
	'annualNaturalMm3',
	'annualOutflowMm3',
	'reserveRate',
	'fdcM3Day',
	'noFlowDays',
	'ewrSiteDaysNotMet',
	'reserveFdc'
] as const;
/** The per-unit lists of an ensemble's header, bands and paired band. */
const ENSEMBLE_UNIT_LISTS = ['farms', 'units', 'curtailment', 'supply'] as const;

/**
 * An uncertainty ensemble (a row, its result, its summary or a paired band)
 * of such a run as that viewer reads it: each member's metrics (and the
 * summary's reference member) only the river's, with `curtailmentM3Day`
 * empty; every per-unit list empty.
 */
export function ensembleRiverOutcomes<T>(v: T): T {
	const walk = (x: unknown): unknown => {
		if (Array.isArray(x)) return x.map(walk);
		if (!x || typeof x !== 'object') return x;
		const o = x as Record<string, unknown>;
		// A member's metrics (MemberMetrics): the allowlist.
		if ('ewrDaysNotMet' in o && 'curtailmentM3Day' in o) return { ...pick(o, RIVER_METRICS as unknown as string[]), curtailmentM3Day: {} };
		return Object.fromEntries(
			Object.entries(o).map(([k, y]) => [k, (ENSEMBLE_UNIT_LISTS as readonly string[]).includes(k) && Array.isArray(y) ? [] : walk(y)])
		);
	};
	return walk(v) as T;
}

type ReportLike = {
	rows: { id: string }[];
	flags: { id: string }[];
	questions: string[];
	users: unknown[];
	servedWhileFailing: { notAssessed: string | null; sites: Record<string, unknown>[] };
	allocations: Record<string, unknown>;
	demandObjects?: unknown;
	uncertainty: Record<string, unknown>;
	appendix: { warnings?: { baseline: string[]; application: string[] | null } } & Record<string, unknown>;
	summaries: { baseline: SummaryLike | null; application: SummaryLike | null };
};

/** Whether an evidence report rests on a cap or a full allocation (either run). */
export const reportRiverOutcomesOnly = (r: Pick<ReportLike, 'summaries'>): boolean =>
	riverOutcomesOnly(r.summaries.baseline?.allocations) || riverOutcomesOnly(r.summaries.application?.allocations);

/**
 * An evidence report on such a run (either side) as that viewer reads it:
 * page 1's river rows and the flags that name no unit's figure, the EWR
 * sites, months and bands, the cumulative and licence-impact boards (river
 * outcomes), the identity, checks and appendix; no users, no served-while-
 * failing units, no § 5 units or years, no demand objects, no questions, no
 * run warnings, the ensembles river-only, each summary as
 * riverOutcomesSummary leaves it, and `withheld` naming the sections.
 * Called after the D3 redaction (redactReportAllocations), on its result.
 */
export function riverOutcomesReport<R extends ReportLike>(report: R): R {
	if (!reportRiverOutcomesOnly(report)) return report;
	const a = report.allocations ?? {};
	return {
		...report,
		rows: (report.rows ?? []).filter((r) => RIVER_ROWS.has(r.id)),
		flags: (report.flags ?? []).filter((f) => RIVER_FLAGS.has(f.id)),
		questions: [],
		users: [],
		servedWhileFailing: {
			notAssessed: RIVER_OUTCOMES_NOTE,
			sites: (report.servedWhileFailing?.sites ?? []).map((s) => ({ ...pick(s, ['key', 'name', 'isOutlet', 'basis', 'daysNotMetA', 'daysNotMetB']), units: [] }))
		},
		allocations: { ...pick(a, ['modeA', 'modeB', 'toleranceA', 'toleranceB', 'notMatchedA', 'notMatchedB']), notAssessed: RIVER_OUTCOMES_NOTE, units: [] },
		...('demandObjects' in report ? { demandObjects: null } : {}),
		uncertainty: ensembleRiverOutcomes(report.uncertainty ?? {}),
		appendix: { ...report.appendix, ...(report.appendix?.warnings ? { warnings: { baseline: [], application: report.appendix.warnings.application ? [] : null } } : {}) },
		summaries: { baseline: riverOutcomesSummary(report.summaries.baseline), application: riverOutcomesSummary(report.summaries.application) },
		withheld: ['allocations', 'demandObjects', 'flags', 'questions', 'rows', 'servedWhileFailing', 'summaries', 'uncertainty', 'users', 'warnings']
	};
}
