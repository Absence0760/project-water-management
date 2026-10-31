// A cap or full-allocation run as a viewer kept from each registered volume
// reads it: verdicts and counts only (decision D3; issue #523 security
// review, finding I, rounds 4 and 5; the operator's decisions of 2026-10-11;
// docs/security.md § Allocations).
//
// In such a run every unit's use is worked out from the registered volumes,
// and so is every flow below a unit: round 4 subtracted the water balance's
// use from the units shown, round 5 a gauge's inflow from the natural flow
// times a dam-less unit's share, both to one holder's volume exactly. So
// such a viewer reads an allowlist of verdicts and counts, nothing else: per
// EWR site the days and months its EWR is not met and its assurance verdicts
// (rates, months met) without the monthly delivered shares (a share times the
// base run's requirement is the month's flow)
// coarsely, and each licence-impact board's below / verdict / class fields.
// No series of any kind (no natural flow, outflow, gauge flow or EWR
// shortfall), no volume, no use total, no ensemble flow figure, no sweep
// member series; anything the engine adds later is withheld until it is
// listed. Every other run gives that viewer everything but the allocation
// series. The licence-impact boards' waterfalls (use totals) are withheld
// from that viewer on every report (boardVerdicts). Pure: the routes decide
// who is kept from the volumes (allocationUnitsHidden).
import { ALLOCATION_SERIES } from '@water-management/engine';

/** The series a run stores from the registered volumes on any unit (engine ≥ 1.18.0): withheld on every run. */
export const ALLOCATION_SERIES_KEYS: ReadonlySet<string> = new Set(Object.values(ALLOCATION_SERIES).map((s) => s.key));

type AllocationsLike = { mode?: unknown } | null | undefined;

/** A run whose figures rest on the registered volumes: one that caps use at them or scales demand to them. */
export const verdictsOnly = (allocations: AllocationsLike): boolean => allocations?.mode === 'cap' || allocations?.mode === 'fullAllocation';

/** What the run pages and the report say instead of the figures. */
export const VERDICTS_ONLY_NOTE =
	'This run caps use at, or scales demand to, the registered water volumes, which this project shows to its editors and owners only: only its EWR verdicts and counts are given.';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** `o` with only `keys` (those it has), or undefined for no object. */
const pick = (o: unknown, keys: readonly string[]): Obj | undefined => (isObj(o) ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : undefined);
/** Each element of a list, picked. */
const pickEach = (list: unknown, keys: readonly string[]): Obj[] => (Array.isArray(list) ? list.map((x) => pick(x, keys) ?? {}) : []);

/** An EWR site's assurance (EwrAssuranceSite) as verdicts: which months met and the rates, no flow, requirement or natural figure. */
function assuranceVerdicts(site: unknown): Obj {
	const s = isObj(site) ? site : {};
	return {
		...pick(s, ['nodeId', 'name', 'isOutlet', 'source', 'sourceKind', 'component', 'unit', 'minYears']),
		points: [],
		months: pickEach(s.months, ['year', 'month', 'waterYear', 'days', 'met']),
		byMonth: pickEach(s.byMonth, ['month', 'years', 'met', 'rate', 'lowFlowRate']).map((m) => ({ ...m, meanRequired: null, meanActual: null, naturalCurve: null, fdc: [] })),
		overall: pick(s.overall, ['months', 'met', 'rate', 'longestNotMetRun']),
		fdc: pick(s.fdc, ['cells', 'met', 'rate']),
		...(isObj(s.lowFlow) ? { lowFlow: pick(s.lowFlow, ['months', 'met', 'rate', 'longestNotMetRun']) } : {})
	};
}

/** Summary fields that are counts or verdicts, or none at all, and how each is kept. */
const SUMMARY_VERDICTS: Record<string, (v: unknown) => unknown> = {
	historyDays: (v) => v,
	catchment: (v) => ({
		meanNaturalFlowM3Day: null,
		meanSimulatedOutflowM3Day: null,
		...pick(v, ['ewrDaysNotMet', 'ewrFractionDaysNotMet']),
		...(isObj(v) && isObj(v.noFlow) ? { noFlow: pick(v.noFlow, ['days', 'longestRun']) } : {})
	}),
	// The outlet's days not met by month, not its shortfall in m³.
	ewrCompliance: (v) => ({ ...pick(v, ['waterYears', 'days']), outlet: pick(isObj(v) ? v.outlet : null, ['nodeId', 'name', 'daysNotMet']) ?? null, farms: [] }),
	ewrAssurance: (v) => (Array.isArray(v) ? v.map(assuranceVerdicts) : []),
	servedWhileEwrFails: (v) => pickEach(v, ['nodeId', 'name', 'basis', 'daysNotMet']).map((x) => ({ ...x, units: [] })),
	forecast: (v) => ({ ...pick(v, ['from', 'to', 'days', 'lastObserved', 'outletEwrDaysAtRisk']), perFarm: [] })
};

type SummaryLike = Obj & { allocations?: Obj | null };

/**
 * A run summary as that viewer reads it, when the run caps or fully
 * allocates: only the fields in SUMMARY_VERDICTS, each as it says, every
 * unit list empty, no calibration, the allocation counts without the
 * per-unit part and `allocations.verdictsOnly` (the marker the pages read),
 * and `withheld` naming the fields left out. Any other run comes back as it
 * is. Idempotent.
 */
export function verdictsSummary<S>(summary: S): S {
	const s = summary as SummaryLike | null | undefined;
	if (!s || !verdictsOnly(s.allocations)) return summary;
	if ((s.allocations as { verdictsOnly?: unknown }).verdictsOnly === true) return summary;
	const out: Obj = {};
	for (const [k, keep] of Object.entries(SUMMARY_VERDICTS)) if (s[k] !== undefined && s[k] !== null) out[k] = keep(s[k]);
	out.farms = [];
	out.users = [];
	out.warnings = [];
	// The coded warnings carry the same texts (and their figures), so they go with them (engine ≥ 1.102.0).
	if (s.warningCodes !== undefined) out.warningCodes = [];
	out.calibration = null;
	out.allocations = { ...pick(s.allocations!, ['mode', 'tolerance', 'used', 'notMatched']), nodes: [], verdictsOnly: true };
	out.withheld = Object.keys(s).filter((k) => !(k in SUMMARY_VERDICTS) && !['farms', 'users', 'warnings', 'warningCodes', 'calibration', 'allocations'].includes(k) && s[k] !== undefined && s[k] !== null).sort();
	return out as S;
}

/** Series of such a run that viewer reads: none (no flow series of any kind). */
export const verdictSeries = (): boolean => false;

/**
 * A licence-impact board (evidence-5 and the authorised board, evidence-14)
 * as a viewer kept from the volumes reads it, on every report: each year
 * class's id, label, years, months or days below the requirement and
 * verdict; no waterfall (the use totals: existing use, the application's,
 * storage change, dam losses) and no class bounds in m³. Anything else of
 * the board stays (its site, method, the unavailable reason). Applied to any
 * object holding a `classes` list of year classes.
 */
export function boardVerdicts<T>(board: T): T {
	const walk = (x: unknown): unknown => {
		if (Array.isArray(x)) return x.map(walk);
		if (!isObj(x)) return x;
		if (Array.isArray(x.classes) && x.classes.every((c) => isObj(c) && 'classId' in c && 'verdict' in c))
			return {
				...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'warnings' ? [] : walk(v)])),
				classes: (x.classes as Obj[]).map((c) => ({ ...pick(c, ['classId', 'label', 'nYears', 'enoughYears', 'waterYears', 'below', 'verdict']), lowerM3: null, upperM3: null, waterfall: null }))
			};
		return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
	};
	return walk(board) as T;
}

/**
 * Page 1's board against full authorised use (evidence-14) as a viewer kept
 * from the volumes reads it: boardVerdicts, and without its pair's
 * reproduction record (evidence-19, #523 G2): the results digests and how each
 * registered volume, by id, was held. Those are for re-running the pair from
 * the reproduction bundle, which that viewer is refused (the digests would be
 * an oracle for guessed volumes).
 */
export function authorisedVerdicts<T>(board: T): T {
	const b = boardVerdicts(board);
	if (!isObj(b) || !('reproduction' in b)) return b;
	const { reproduction: _withheld, ...rest } = b;
	return rest as T;
}

/**
 * § 4's combined dams (evidence-25, `cumulative.combined.dams`) as a viewer
 * kept from the registered volumes reads them: a dam whose yields rest on
 * them (`onVolumes`: some run capped use at, or scaled demand to, the
 * volumes), or every dam when `all` (a report on such a run), keeps its
 * direction (`verdict`) and loses its firm yield and assurance figures,
 * marked `withheld`, as the Yield panel withholds a yield on such a run's
 * points (#523 I, round 5). Anything else comes back as it is.
 */
export function combinedDamVerdicts<T>(cumulative: T, all: boolean): T {
	if (!isObj(cumulative) || !isObj(cumulative.combined) || !Array.isArray(cumulative.combined.dams)) return cumulative;
	const dams = (cumulative.combined.dams as unknown[]).map((d) =>
		isObj(d) && (all || d.onVolumes !== false) ? { ...pick(d, ['nodeId', 'name', 'verdict', 'onVolumes']), firmYield: null, reliability: null, withheld: true } : d
	);
	return { ...cumulative, combined: { ...cumulative.combined, dams } } as T;
}

/** A member's metrics (MemberMetrics) that are EWR counts and rates. */
const METRIC_VERDICTS = ['ewrDaysNotMet', 'ewrDaysNotMetByMonth', 'reserveRate', 'noFlowDays', 'ewrSiteDaysNotMet'] as const;
/** An ensemble's bands (EnsembleBands) that are EWR counts and rates; the rest null or empty. */
const BAND_VERDICTS = ['ewrDaysNotMet', 'ewrDaysNotMetByMonth', 'reserve', 'noFlowDays', 'ewrSites', 'fdcPoints'] as const;
/** A paired band's (PairedSummary) fields that are EWR counts and rates. */
const PAIRED_VERDICTS = ['members', 'gated', 'ewrDaysNotMet', 'ewrDaysNotMetWorse', 'ewrDaysNotMetByMonth', 'reserve', 'unpaired', 'decisionRule', 'noFlowDays', 'ewrSites'] as const;

/**
 * An uncertainty ensemble of such a run (a row, its result, its summary, a
 * paired band, the report's uncertainty section) as that viewer reads it:
 * each member's metrics its EWR counts and rates only, the bands likewise
 * (no natural, outflow, shortfall, FDC or supply band), the header without
 * its units, farms and monthly EWR flows.
 */
export function ensembleVerdicts<T>(v: T): T {
	const walk = (x: unknown): unknown => {
		if (Array.isArray(x)) return x.map(walk);
		if (!isObj(x)) return x;
		if ('ewrDaysNotMet' in x && 'curtailmentM3Day' in x) return { ...pick(x, METRIC_VERDICTS), curtailmentM3Day: {} };
		if ('ewrDaysNotMetWorse' in x) return pick(x, PAIRED_VERDICTS);
		return Object.fromEntries(
			Object.entries(x).map(([k, y]) => {
				if (k === 'bands' && isObj(y))
					return [k, { ...pick(y, BAND_VERDICTS), shortfallMm3: null, marNaturalMm3: null, marOutflowMm3: null, annual: [], curtailment: [], fdc: [], supply: [], reserveFdc: [] }];
				if (k === 'header' && isObj(y)) return [k, { ...walk(y) as Obj, farms: [], units: [], ewrByMonthM3Day: [] }];
				return [k, walk(y)];
			})
		);
	};
	return walk(v) as T;
}

/** The evidence report's page-1 rows that are counts or verdicts. */
const ROW_VERDICTS: ReadonlySet<string> = new Set(['reserve', 'ewrDays', 'noFlowDays', 'ewrBelowWorks', 'otherApplications']);
/** Its flags that say nothing of a unit's figure or a flow. */
const FLAG_VERDICTS: ReadonlySet<string> = new Set(['assumptions', 'reference', 'ewrZero', 'noReserve', 'gated', 'noRule', 'noCalibration', 'noFit', 'chirps', 'dataQuality', 'notEndorsed']);
/** An EWR site's section (EvidenceSite) as verdicts: the months met, no delivered share, natural or flow figure. */
const SITE_VERDICTS = ['key', 'name', 'isOutlet', 'source', 'sourceKind', 'component', 'unit', 'category', 'months', 'lost', 'gained', 'worst', 'longestA', 'longestB', 'rateA', 'rateB', 'monthsA', 'belowTableA', 'belowTableB', 'belowTableExpectedPct', 'byMonth', 'fdcMonth', 'fdcDriestMonth'] as const;

type ReportLike = Obj & { summaries: { baseline: SummaryLike | null; application: SummaryLike | null } };

/** Whether an evidence report rests on a cap or a full allocation (either run). */
export const reportVerdictsOnly = (r: Pick<ReportLike, 'summaries'>): boolean =>
	verdictsOnly(r.summaries?.baseline?.allocations) || verdictsOnly(r.summaries?.application?.allocations);

/**
 * The report's top-level sections such a viewer reads, and how: the
 * identity, checks, ops, rules, credibility, locality map, verification and
 * the applicant's statement and the observed wet days as they are; page 1's count rows and flags; the
 * EWR sites as verdicts; the month changes (counts); the boards' verdicts;
 * the ensembles' counts; the cumulative counts; § 5 and served-while-failing
 * without units; the appendix without its warnings; the summaries as
 * verdictsSummary leaves them. A section not listed is withheld.
 */
const REPORT_VERDICTS: Record<string, (v: unknown) => unknown> = {
	version: (v) => v,
	mode: (v) => v,
	builtBy: (v) => v,
	identity: (v) => v,
	checks: (v) => v,
	refused: (v) => v,
	assumptionsChanged: (v) => v,
	issuable: (v) => v,
	ops: (v) => v,
	rules: (v) => v,
	credibility: (v) => v,
	localityMap: (v) => v,
	// Satellite observations of the applicant's own dams: nothing from the registered volumes (evidence-21).
	damObservations: (v) => v,
	verification: (v) => v,
	applicantStatement: (v) => v,
	byMonth: (v) => v,
	worstMonths: (v) => v,
	improvingMonths: (v) => v,
	// Its counts as they are; each dam's yield and assurance as its direction only (evidence-25).
	cumulative: (v) => combinedDamVerdicts(v, true),
	rows: (v) => (Array.isArray(v) ? v.filter((r) => isObj(r) && ROW_VERDICTS.has(r.id as string)) : []),
	flags: (v) => (Array.isArray(v) ? v.filter((f) => isObj(f) && FLAG_VERDICTS.has(f.id as string)) : []),
	// Each month met or not, never the share delivered: share × the base run's requirement (which the viewer reads in
	// full, since it rests on natural flow alone) is the month's exact flow (#523 I, round 6). The worst month stays as
	// a month, without its share.
	river: (v) =>
		pickEach(v, SITE_VERDICTS).map((s) => ({
			...s,
			months: pickEach(s.months, ['year', 'month', 'waterYear', 'metA', 'metB']).map((m) => ({ ...m, deliveredA: null, deliveredB: null })),
			worst: isObj(s.worst) ? { ...pick(s.worst, ['year', 'month']), delivered: null } : null,
			naturalMar: null,
			ewrPctNmar: null,
			fdcBands: null,
			fdcBandNote: null,
			fdcChange: null
		})),
	licenceImpact: boardVerdicts,
	licenceImpactAuthorised: authorisedVerdicts,
	uncertainty: ensembleVerdicts,
	servedWhileFailing: (v) => ({
		notAssessed: VERDICTS_ONLY_NOTE,
		sites: pickEach(isObj(v) ? v.sites : [], ['key', 'name', 'isOutlet', 'basis', 'daysNotMetA', 'daysNotMetB']).map((s) => ({ ...s, units: [] }))
	}),
	allocations: (v) => ({ ...pick(v, ['modeA', 'modeB', 'toleranceA', 'toleranceB', 'notMatchedA', 'notMatchedB']), notAssessed: VERDICTS_ONLY_NOTE, units: [] }),
	appendix: (v) => {
		const a = isObj(v) ? v : {};
		const w = isObj(a.warnings) ? a.warnings : null;
		return { ...pick(a, ['baselineInputs', 'changes', 'series', 'history', 'applicationRuns']), ...(w ? { warnings: { baseline: [], application: w.application ? [] : null } } : {}) };
	},
	summaries: (v) => {
		const s = isObj(v) ? v : {};
		return { baseline: verdictsSummary(s.baseline), application: verdictsSummary(s.application) };
	}
};

/**
 * An evidence report on such a run (either side) as that viewer reads it:
 * only the sections REPORT_VERDICTS lists, each as it says; users,
 * questions and demand objects empty, and `withheld` naming every section
 * left out or cut down. Called after the D3 redaction
 * (redactReportAllocations), on its result.
 */
export function verdictsReport<R extends ReportLike>(report: R): R {
	if (!reportVerdictsOnly(report)) return report;
	const out: Obj = {};
	for (const [k, keep] of Object.entries(REPORT_VERDICTS)) if (k in report) out[k] = keep(report[k]);
	out.users = [];
	out.questions = [];
	if ('demandObjects' in report) out.demandObjects = null;
	out.withheld = [
		...Object.keys(report).filter((k) => !(k in REPORT_VERDICTS) && !['users', 'questions', 'demandObjects'].includes(k)),
		'allocations',
		'demandObjects',
		'flags',
		'licenceImpact',
		'licenceImpactAuthorised',
		'questions',
		'river',
		'rows',
		'servedWhileFailing',
		'summaries',
		'uncertainty',
		'users',
		'warnings'
	]
		.filter((k, i, all) => all.indexOf(k) === i)
		.sort();
	return out as R;
}
