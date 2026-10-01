// The licensing evidence report (issue #71; design: docs/design/evidence-report.md,
// WP-2.15 Phase C "evidence mode", roadmap WP-3.14). What the backend reads,
// under the reader's RLS, and hands to evidenceReport(); and the document it
// returns, which the report route renders and an issued evidence pack freezes
// as its manifest. Pure data: no I/O, and nothing time-dependent is computed
// here, so the same input always gives the same document.
import type { AllocationComparison, AllocationStatus, AllocationWaterSource } from '../allocations/compare';
import type { AllocationMode } from '../allocations/mode';
import type { InputChange, RunInputsSnapshot } from '../compare';
import type { Erratum } from '../liability/errata';
import type { Limitation } from '../liability/limitations';
import type { MethodologyVersion } from '../liability/methodology';
import type { DemandSourceShare } from '../network/demandSources';
import type { AllocationLimitBound, DemandObjectCategory, DemandObjectDestination, DemandObjectPriority, DemandObjectSizing, DemandObjectSource, RunSummary } from '../project';
import type { OpClass } from '../scenario/overrides';
import type { ScenarioOp } from '../scenario/ops';
import type { Band } from '../uncertainty/bands';
import type { EnsembleSummary } from '../uncertainty/ensemble';
import type { LicenceImpact } from '../views/licenceImpact';
import type { YearClassMethod } from '../views/yearClasses';
import type { DeclaredUncertaintyRule, OptionChange, ResolvedEnsembleOptions } from '../uncertainty/options';
import type { PairedSummary } from '../uncertainty/paired';
import type { ApplicantPrompts } from './prompts';

/**
 * Bumped whenever the document's shape or a rule that builds it changes; a pack records it.
 * evidence-2: registered water use (`allocations`, § 5) and the page-1 row "Registered vs
 * modelled use" (`registeredUse`), with its flag, were added (issue #71, WP-3.10).
 * evidence-3: each Reserve site's driest month (`river[].fdcDriestMonth`, § 1 plots its
 * FDC beside the largest-change month's), and the other applications on the baseline
 * (`cumulative`, § 4) with their summed change as the page-1 row "Other applications on
 * this baseline, summed" (`otherApplications`). A new field an old document lacks, and a
 * new row: a pack built before it must say which version it is (issue #71 follow-ups).
 * evidence-4: the page-1 rows "No-flow days at the outlet" (`noFlowDays`) and "EWR below the
 * works" (`ewrBelowWorks`); paired bands on the supply rows and in § 4 (`EvidenceUser.change`);
 * "served in full while the site fails" (`servedWhileFailing`, § 4, with its flag); and the
 * banded Reserve FDC (`EvidenceSite.fdcBands`, ER5) (issue #71, engine 1.33.0).
 * evidence-5: page 1's licence impact by year class (`licenceImpact`, issue #53 R7), built
 * here from the runs' daily series instead of in the browser, so an issued pack freezes it.
 * evidence-6: § 5 cites a capped run's cap (`EvidenceAllocationSource.capA` / `capB`): the
 * water years the registered volume was used up and the days the licence limit held use
 * back, by limit (RunSummary.allocations, engine ≥ 1.40.0 for the days).
 * evidence-7: § 1's paired change in the FDC check curve (`EvidenceSite.fdcChange`, the
 * engine review of ER5): per month and table point, the band on application − baseline of
 * the impacted flow with "worse in k of n", from `PairedSummary.reserveFdcChange`, printed
 * as a table under the chart instead of reading the change off two overlapping bands.
 * evidence-8: Appendix C's fixed prompts (`applicantStatement.prompts`: purpose and need,
 * mitigation, monitoring, each answered or empty for "Not given"; prompts.ts). A pack
 * drafted before it has no `prompts`: its Appendix C says the prompts aren't part of it.
 * evidence-9: § 6 the applicant's demand objects (`demandObjects`, issue #259): each object
 * on the applicant's units, or that the application adds, changes or removes, with its sizing,
 * its source (engine ≥ 1.56.0) and the note on it, its demand in both runs, and the share of
 * their demand by source, with a flag when most of it isn't from meter records. A pack drafted
 * before it has no `demandObjects`, and its report has no § 6.
 * evidence-10: two checks that stop issue (issue #54, #90 Q15 and Q16): `pumpCapacity`, every
 * river pump, other water user and river off-take either run rests on has a capacity, and, for an
 * application, `protectsEwr`, the river abstraction its proposals add or change keeps a hands-off
 * flow or the EWR (evidence/riverWorks.ts). A pack drafted before it lists neither check: its frozen
 * report stays as it was, and issuing it checks the live report, which has both.
 */
export const EVIDENCE_REPORT_VERSION = 'evidence-10';

// ---------------------------------------------------------------------------
// What the backend reads
// ---------------------------------------------------------------------------

/** One stored run, as the report needs it. */
export interface EvidenceRunInput {
	id: string;
	/** '' = no label. */
	label: string;
	engineVersion: string;
	/** settings.runoffModel as the run recorded it ('legacy' for a run from before engine 1.0.0). */
	runoffModel: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	/** Display name of who ran it; null once that account is gone. */
	createdBy: string | null;
	/** model_run.trigger: 'forecast' runs are never evidence. */
	trigger: string;
	summary: RunSummary;
	/** Settings, model and each input series' dates and SHA-256, as the run used them. */
	inputs: RunInputsSnapshot;
	/** The modeller's written explanation (007_run_notes); '' = none. */
	notes: string;
	notesUpdatedAt: string | null;
	notesUpdatedBy: string | null;
	/**
	 * The run's modelled use against its registered volumes, per unit, water
	 * source and water year (compareAllocations over the run's own stored
	 * series, its own stored allocations and its own tolerance, record days
	 * only). Null or absent when the run's inputs carry no allocations (a
	 * project without any, or a run from before engine 1.18.0). Carries no
	 * holder names: a run's allocations never do (docs/allocations.md § Who sees what).
	 */
	allocations?: AllocationComparison | null;
}

/** The scenario an application run came from, as the run recorded it (inputs.scenario), with the scenario's current metadata. */
export interface EvidenceScenarioInput {
	id: string;
	name: string;
	/** The applicant's own words (scenario.description); '' = none. Printed only in Appendix C (G13). */
	description: string;
	/** The answers to Appendix C's fixed prompts (129_scenario_statement); '' = not given. Appendix C only (G13). */
	prompts: ApplicantPrompts;
	/** draft | submitted | withdrawn | decided; null once the scenario is deleted. */
	status: string | null;
	/** Display name of the scenario's owner; null when unknown. */
	ownerName: string | null;
	baseRunId: string;
	ops: ScenarioOp[];
	opsSha256: string;
	ownedNodeIds: string[];
	/** One class per op, as the run classified them. */
	classified: OpClass[];
}

/** A row of the evidence nomination history (010_run_nomination), oldest first. */
export interface EvidenceNomination {
	withdrawn: boolean;
	runId: string | null;
	runLabel: string | null;
	runoffModel: string | null;
	engineVersion: string | null;
	reason: string;
	nominatedAt: string;
	nominatedBy: string | null;
}

/** One stored uncertainty ensemble (014_run_uncertainty): every start is kept, so every one is listed. */
export interface EvidenceEnsembleInput {
	id: string;
	runId: string;
	/** Set on a paired row: the baseline ensemble it re-runs. */
	baselineId: string | null;
	status: 'started' | 'complete';
	seed: number;
	members: number;
	options: ResolvedEnsembleOptions;
	createdAt: string;
	createdBy: string | null;
	completedAt: string | null;
	/** Kept members, when complete. */
	accepted: number | null;
	/** An unpaired row's bands (summariseEnsemble), when complete. */
	summary: EnsembleSummary | null;
	/** A paired row's bands, recomputed by the backend from both rows' stored members (summarisePaired), when complete. */
	paired: PairedSummary | null;
}

/** The project's publication (022_publication) of a run, the baseline's context (WP-2.3). */
export interface EvidencePublication {
	runId: string;
	publishedAt: string;
	publishedBy: string | null;
}

/** A change to the project's inputs (030_history), for the baseline's history since the previous publication. */
export interface EvidenceRevision {
	createdAt: string;
	actor: string | null;
	reason: string | null;
	changes: InputChange[];
}

/** Another run of a scenario on the same baseline: the ledger an assessor needs to see what else was tried (persona A3). */
export interface EvidenceApplicationRun {
	runId: string;
	label: string;
	scenarioName: string;
	createdAt: string;
	createdBy: string | null;
}

/**
 * Another application on the same baseline, for the cumulative table (§ 4): a
 * scenario other than the report's own, submitted or decided with approval,
 * with its newest run of its current ops on this baseline. Read under the
 * reader's RLS, so it lists only what the reader may see (a submitted
 * application is visible to the project's editors, a draft only to its
 * applicant). Only the measures the table needs, read from that run's summary.
 */
export interface EvidenceOtherApplicationInput {
	scenarioId: string;
	scenarioName: string;
	status: 'submitted' | 'decided';
	/** The assessor's outcome, when decided ('approved' | 'approved_with_conditions'). */
	outcome: string | null;
	runId: string;
	runCreatedAt: string;
	engineVersion: string;
	runoffModel: string;
	startDate: string;
	endDate: string;
	/** summary.catchment.ewrDaysNotMet. */
	ewrDaysNotMet: number | null;
	/** The outlet's Reserve compliance (summary.ewrAssurance, the outlet's `overall`); null without a rule table at the outlet. */
	reserveOutlet: { months: number; met: number; rate: number | null } | null;
}

export interface EvidenceInput {
	project: { id: string; name: string };
	/** The run the report treats as the baseline: the application's base run, or the run itself for baseline evidence. */
	baseline: EvidenceRunInput;
	/** The application run and its scenario; null for a baseline-evidence report. */
	application: (EvidenceRunInput & { scenario: EvidenceScenarioInput }) | null;
	/** The project's nomination history, oldest first. */
	nominations: EvidenceNomination[];
	/** The current publication and the one before it, when there are any. */
	publication: { current: EvidencePublication | null; previous: EvidencePublication | null };
	/** Every ensemble started on the baseline, and every paired ensemble on the application run, newest first. */
	ensembles: { baseline: EvidenceEnsembleInput[]; paired: EvidenceEnsembleInput[] };
	/** diffInputs(baseline, application), with stored values; [] for baseline evidence. */
	changes: InputChange[];
	/** Revisions between the previous publication's run and the baseline (C20); null when there is no earlier publication. */
	history: { since: EvidencePublication; revisions: EvidenceRevision[]; truncated: boolean } | null;
	/** Other scenario runs on the same baseline, newest first, this one included. */
	applicationRuns: EvidenceApplicationRun[];
	/** Other submitted or approved applications with a run on the baseline (not this report's own), for § 4's cumulative table. */
	otherApplications: EvidenceOtherApplicationInput[];
	/** More than the backend's cap (the newest 50 are listed): the sum is then not assessed. */
	otherApplicationsTruncated: boolean;
	/** What the report cites for its methods and limits (the engine's generated lists). */
	liability: { methodology: MethodologyVersion; limitations: readonly Limitation[]; errata: readonly Erratum[]; disclaimerVersion: string };
	/** What page 1's licence impact by year class reads (application reports only); absent or null, the report says it wasn't built. */
	impact?: EvidenceImpactInput | null;
}

/**
 * The licence impact board's inputs (issue #53 R7): the project's outcome
 * settings (settings.outcomes, which no run records) and three stored daily
 * series at the outlet. A value is null where the stored series has a gap
 * (JSON has no NaN); a series is null when the run hasn't one.
 */
export interface EvidenceImpactInput {
	yearClassMethod: YearClassMethod;
	/** The Reserve site the project's outcome matrix reads: null = the outlet, else a gauge. */
	siteNodeId: string | null;
	series: {
		backgroundNatural: (number | null)[] | null;
		backgroundEwrShortfall: (number | null)[] | null;
		applicationEwrShortfall: (number | null)[] | null;
	};
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export type EvidenceMode = 'application' | 'baseline';

/**
 * One check on the report's inputs. `refuses`: a failure means the report
 * can't be shown as evidence at all (board 2 of the mock-up). `blocksIssue`:
 * the report may be previewed, but not issued as a pack. Every check has a
 * `passed` value; one that doesn't apply to the mode isn't listed.
 */
export interface EvidenceCheck {
	id:
		| 'nominated'
		| 'notLegacy'
		| 'notForecast'
		| 'base'
		| 'engine'
		| 'period'
		| 'runoffModel'
		| 'assumptions'
		| 'pumpCapacity'
		| 'protectsEwr'
		| 'declaredRule'
		| 'citedEnsemble'
		| 'pairedBand'
		| 'coverage';
	label: string;
	passed: boolean;
	/** What was found, in words. */
	detail: string;
	refuses: boolean;
	blocksIssue: boolean;
	/** What to do about a failure; null when passed. */
	fix: string | null;
}

/** A "Read these first" flag (§4.1 item 3). `red`: the run is outside its own rule or evidence rules; `caution`: changes how the table is read; `count`: a count to keep in mind. */
export interface EvidenceFlag {
	id: string;
	level: 'red' | 'caution' | 'count';
	text: string;
	/** Which way it pushes the numbers, when that is known (persona A: "which way it biases"). */
	effect: string | null;
}

/** The value of a banded change (D-U1…D-U6). */
export interface EvidenceChange {
	/** The two runs' own difference (application − baseline); null when either lacks the measure. */
	run: number | null;
	/** The paired band on the difference; null when there is none (the cell says why, `bandNote`). */
	band: Band | null;
	/** Why there is no band, or it has no percentiles ("no band", gated); null with a band. */
	bandNote: string | null;
	/** "Worse in k of n sets"; null without a count. */
	worse: { k: number; n: number } | null;
}

export interface EvidenceRow {
	id: 'reserve' | 'ewrDays' | 'shortfall' | 'noFlowDays' | 'ewrBelowWorks' | 'outflowMar' | 'registeredUse' | 'applicantSupply' | 'userSupply' | 'otherApplications';
	/** The measure, in words. */
	label: string;
	/** What it is measured against, so two EWRs are never confused (persona E: "label each measure's basis"). */
	basis: string;
	/** The site or node the row is about, when there are several of the kind. */
	subject: string | null;
	unit: string;
	/** Higher is worse for the river or the user (drives "worse in", never a colour: G15). */
	higherIsWorse: boolean;
	baseline: number | null;
	/** null for baseline evidence. */
	application: number | null;
	change: EvidenceChange | null;
	/** Set when the row can't be assessed: printed in the value's place, in words (rule 3, G6). */
	notAssessed: string | null;
	/** A second reading beside the value (outflow as % of natural MAR). */
	note: string | null;
}

/** A calendar month's paired change in days below the EWR (D-U9), water-year order. */
export interface EvidenceMonthChange {
	/** Calendar month 1–12. */
	month: number;
	run: number | null;
	band: Band | null;
}

/** One complete month at a Reserve site, both runs (§1 heat maps). */
export interface EvidenceSiteMonth {
	year: number;
	month: number;
	waterYear: number;
	/** Share of the requirement delivered, 0…1+ (depth of failure, persona E), baseline and application. */
	deliveredA: number | null;
	deliveredB: number | null;
	metA: boolean;
	metB: boolean | null;
}

export interface EvidenceSite {
	/** 'outlet' or the gauge's node id. */
	key: string;
	name: string;
	isOutlet: boolean;
	/** The rule table's source, its kind in words, the component and unit (C9). */
	source: string;
	sourceKind: string;
	component: string;
	unit: string;
	/** The recommended ecological category (REC) from the baseline's rule table (ER9): "A" … "F" or a band like "B/C"; null = not given. */
	category: string | null;
	/** The EWR as % of the natural MAR at the site, computed from the run (engine ≥ 1.19.0); null when it can't be. */
	ewrPctNmar: number | null;
	/** The determination's natural MAR against the run's, when the table records one. */
	naturalMar: { runMcm: number; tableMcm: number; differencePct: number } | null;
	months: EvidenceSiteMonth[];
	/** Months met in the baseline but not the application, and the reverse. */
	lost: number;
	gained: number;
	/** The worst month-year of the application (or baseline): the lowest share delivered (persona E: "worst month and year"). */
	worst: { year: number; month: number; delivered: number } | null;
	/** Most consecutive months not met. */
	longestA: number;
	longestB: number | null;
	/** Months met ÷ complete months. */
	rateA: number | null;
	rateB: number | null;
	monthsA: number;
	/**
	 * Complete months whose natural flow is drier than the rule table's driest
	 * point (G16), baseline and application (B null for baseline evidence, or
	 * when the application has no such site): the requirement is scaled with
	 * the flow there (model.md §2.9c).
	 */
	belowTableA: number;
	belowTableB: number | null;
	/**
	 * With the percentile from the run, the share of months expected below the
	 * driest point by construction (100 − its %, the run's own duration curve);
	 * null with the table's natural curve, which places months on its own.
	 */
	belowTableExpectedPct: number | null;
	/** By calendar month (water-year order): complete years and met, baseline and application. */
	byMonth: { month: number; years: number; metA: number; metB: number | null }[];
	/** The calendar month whose FDC check the report plots: the one with the largest drop in months met, else the month met least often. */
	fdcMonth: number | null;
	/**
	 * The banded FDC check (ER5), per calendar month (water-year order): the
	 * baseline's band (R1) and the application's own curve under the same
	 * parameter sets (R2, not a difference), at each of the table's points,
	 * table unit. Null when there is no band (`fdcBandNote` says why).
	 */
	fdcBands: { month: number; a: (Band | null)[]; b: (Band | null)[] | null }[] | null;
	fdcBandNote: string | null;
	/**
	 * The paired change in the FDC check curve (evidence-7), per calendar
	 * month (water-year order) and table point, table unit: `run` the two
	 * runs' own difference (application − baseline), `band` the paired band
	 * on it (each kept parameter set on both runs' inputs), `worse` the sets
	 * in which the application's flow at the point is lower. Null for
	 * baseline evidence, and when the application's curve has no band
	 * (`fdcBandNote` says why) or the two runs read the site against
	 * different table points, units or components. Absent from a pack's
	 * document before evidence-7.
	 */
	fdcChange?: { month: number; points: EvidenceChange[] }[] | null;
	/**
	 * The site's driest calendar month: the lowest mean natural flow over its
	 * complete months in the baseline (evidence-3). A property of the river,
	 * not of the requirement or the application, so no one can choose it; § 1
	 * plots its FDC beside `fdcMonth`'s when the two differ. Null without a
	 * complete month.
	 */
	fdcDriestMonth: number | null;
}

/** An ensemble in the uncertainty ledger (D-U7): every start on the baseline, listed. */
export interface EvidenceEnsembleRef {
	id: string;
	status: 'started' | 'complete';
	createdAt: string;
	createdBy: string | null;
	completedAt: string | null;
	seed: number;
	members: number;
	accepted: number | null;
	/** How its rule departs from the project's declared one; empty when it follows it (or none is declared). */
	departsFromDeclared: OptionChange[];
	/** The ensemble the report cites. */
	cited: boolean;
}

export interface EvidenceUser {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** One of the applicant's own nodes (the scenario's owned nodes). */
	own: boolean;
	/** Share of demand supplied, 0–1, over the whole run (FarmSummary.fractionSupplied). */
	suppliedA: number | null;
	suppliedB: number | null;
	/** Share of demand days fully met over the reporting window (supplyAssurance). */
	timeReliabilityA: number | null;
	timeReliabilityB: number | null;
	annualReliabilityA: number | null;
	annualReliabilityB: number | null;
	/** Only in one of the runs (a node the application added or removed). */
	onlyIn: 'baseline' | 'application' | null;
	/** The change in its share supplied, percentage points, with the paired band (ER4); null for baseline evidence or a unit in one run only. */
	change: EvidenceChange | null;
}

/** A farm or water user upstream of an EWR site, served in full on days the site failed (§ 4). */
export interface EvidenceServedUnit {
	nodeId: string;
	name: string;
	own: boolean;
	/** Days, per run; null where the run lacks the unit. */
	daysA: number | null;
	daysB: number | null;
}

/** What the application does to a demand object of the applicant's (§ 6, evidence-9). */
export type EvidenceDemandObjectChange = 'added' | 'changed' | 'removed' | 'unchanged';

/**
 * One of the applicant's demand objects (§ 6, evidence-9): as the
 * application ran it (as the baseline did, for one it removes). Its sizing,
 * source and note are the model's, verbatim; the demand is the run's.
 */
export interface EvidenceDemandObject {
	id: string;
	name: string;
	/** The unit (a farm node) that supplies it, and that unit's name in the run it is read from. */
	nodeId: string;
	unit: string;
	category: DemandObjectCategory;
	change: EvidenceDemandObjectChange;
	/** false = kept on record, not modelled: no demand in the run. */
	enabled: boolean;
	sizing: DemandObjectSizing;
	/** 'monthly': m³/day per water-year month (Oct–Sep); null under 'perUnit'. */
	monthlyM3Day: number[] | null;
	/** 'perUnit': how many, litres per unit per day, and losses (0–1); null (losses 0) under 'monthly'. */
	count: number | null;
	litresPerUnitDay: number | null;
	lossPct: number;
	priority: DemandObjectPriority;
	destination: DemandObjectDestination;
	/** Where its number comes from (engine ≥ 1.56.0); null = not recorded. */
	source: DemandObjectSource | null;
	/** The detail of the source (which meter, which strategy and year, which norm); '' = none given. */
	note: string;
	/** Mean demand over the run, m³/day; null when the run doesn't model it (absent, or disabled). */
	demandA: number | null;
	demandB: number | null;
	/** Share of its demand supplied in the application, 0–1; null when not modelled there. */
	suppliedB: number | null;
}

/** § 6 The applicant's demand objects (evidence-9). */
export interface EvidenceDemandObjects {
	/** Set when there is nothing to list: printed in the section's place (rule 3). */
	notAssessed: string | null;
	objects: EvidenceDemandObject[];
	/**
	 * Their demand in the application by source, the rule's order, not
	 * recorded last (demandSourceShares over every listed object the
	 * application models): the same shares as the run's demand-objects table.
	 */
	bySource: DemandSourceShare[];
	/** Their whole mean demand in the application, m³/day. */
	demandM3Day: number;
}

/** Per EWR site, the days units upstream got their whole demand while the site's EWR failed (§ 4, engine ≥ 1.33.0). */
export interface EvidenceServedWhileFailing {
	/** Set when the runs don't carry it: printed in the section's place. */
	notAssessed: string | null;
	sites: {
		key: string;
		name: string;
		isOutlet: boolean;
		/** The daily requirement the site is judged on, in words. */
		basis: string;
		/** Days the site's EWR was not met, per run. */
		daysNotMetA: number;
		daysNotMetB: number | null;
		/** Units upstream with demand, most days first (the reported run's); units never served in full on a failing day included, with 0. */
		units: EvidenceServedUnit[];
	}[];
}

/** Another application's own change against the baseline (§ 4's cumulative table). */
export interface EvidenceCumulativeApplication {
	scenarioId: string;
	scenarioName: string;
	status: 'submitted' | 'decided';
	outcome: string | null;
	runId: string;
	runCreatedAt: string;
	/**
	 * Same engine, period and runoff model as the baseline, so its difference is counted in the sum.
	 * Any other difference from the baseline is the application's own ops (its scenario snapshot), which the sum is meant to carry.
	 */
	comparable: boolean;
	/** Why it isn't counted, in words; null when it is. */
	reason: string | null;
	/** Its days below the pragmatic EWR at the outlet minus the baseline's. */
	ewrDays: number | null;
	/** Its Reserve months met at the outlet minus the baseline's, percentage points; null without a rule table at the outlet. */
	reservePp: number | null;
}

/**
 * What else is proposed on the baseline (licensing authority, s27 "other
 * water users"): each other application's own change, and their sum. A sum of
 * separate runs, not one combined run: two applications drawing on the same
 * water may take less, or more, together than the sum says. A true cumulative
 * run is WP-3.11 (combineScenarios).
 */
export interface EvidenceCumulative {
	applications: EvidenceCumulativeApplication[];
	/** Applications counted in the sum (the comparable ones). */
	counted: number;
	/** The list was cut at the backend's cap: the sum would understate, so it is not assessed. */
	truncated: boolean;
	/** Σ over the counted applications; null when none carries the measure. */
	total: { ewrDays: number | null; reservePp: number | null };
	/** The sum with this report's own change added; null for baseline evidence. */
	withThis: { ewrDays: number | null; reservePp: number | null } | null;
}

/** One water year of a unit's use from one water source, both runs (§ 5). */
export interface EvidenceAllocationYear {
	/** Water year (Oct–Sep), labelled by the year it starts in. */
	waterYear: number;
	/** Days of the water year inside the baseline (else the application), and in the whole year. */
	days: number;
	yearDays: number;
	/** A run covers only part of it: listed, the registered volume prorated, but not counted for that run; null where the run lacks the year. */
	partialA: boolean | null;
	partialB: boolean | null;
	/** Registered volume in force over those days (m³), modelled use (m³) and how they compare, per run; null where the run lacks the unit or the year. */
	registeredA: number | null;
	modelledA: number | null;
	statusA: AllocationStatus | null;
	/** Baseline evidence: null. */
	registeredB: number | null;
	modelledB: number | null;
	statusB: AllocationStatus | null;
}

/** Whole water years by how modelled use compared with the registered volume. */
export interface EvidenceAllocationCounts {
	wholeYears: number;
	over: number;
	within: number;
	under: number;
	/** No registered volume in force that year (outside its validity dates). */
	noVolume: number;
}

export interface EvidenceAllocationSource {
	waterSource: AllocationWaterSource;
	years: EvidenceAllocationYear[];
	countsA: EvidenceAllocationCounts | null;
	/** Baseline evidence, or the application lacks the unit or has no volume on this source: null. */
	countsB: EvidenceAllocationCounts | null;
	/** Mean modelled use and registered volume per whole water year (m³), per run. */
	meanModelledA: number | null;
	meanRegisteredA: number | null;
	meanModelledB: number | null;
	meanRegisteredB: number | null;
	/**
	 * A cap run's cap on this unit and source, per run (evidence-6, from its
	 * RunSummary.allocations): null when that run isn't a cap run or doesn't
	 * cap the source (baseline evidence: capB null). Absent from an older
	 * pack's document.
	 */
	capA?: EvidenceCapYears | null;
	capB?: EvidenceCapYears | null;
}

/** One run's cap on one unit and source (evidence-6). */
export interface EvidenceCapYears {
	/** The water years the use reached the registered volume. */
	capReached: { waterYear: number; budgetM3: number; usedM3: number }[];
	/** The days per water year the licence limit held use back, by limit (engine ≥ 1.40.0); null for a run before it. */
	limitBound: AllocationLimitBound[] | null;
}

/** A farm or water user with a registered volume in either run: by its unit (node) name, never the holder's (D3). */
export interface EvidenceAllocationUnit {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** One of the applicant's own units. */
	own: boolean;
	/** Only in one of the runs (a unit the application added or removed). */
	onlyIn: 'baseline' | 'application' | null;
	/** Per water source with a registered volume in either run, surface first. */
	sources: EvidenceAllocationSource[];
}

/** § 5 Registered water use: modelled use against the registered volumes (WARMS registrations, licences), both runs. */
export interface EvidenceAllocations {
	/** Set when there is nothing to compare: printed in the section's place, in words (rule 3, G6). */
	notAssessed: string | null;
	/** The allocation mode each run ran with (RunSummary.allocations); null when the run carries none. */
	modeA: AllocationMode | null;
	modeB: AllocationMode | null;
	/** The band around a registered volume counted as within it, per run (settings.allocationTolerance). */
	toleranceA: number | null;
	toleranceB: number | null;
	units: EvidenceAllocationUnit[];
	/** Registered volumes matched to no unit of the run, or to one the run lacks: counted, not compared. */
	notMatchedA: number;
	notMatchedB: number | null;
}

/** Why the licence impact board couldn't be built; the page words it. */
export type EvidenceLicenceImpactUnavailable =
	/** The report was built without the board's inputs. */
	| 'notBuilt'
	/** The baseline has no natural flow series, so its water years can't be classed. */
	| 'noNaturalFlow'
	/** A run predates the water account (engine 0.32.0). */
	| 'noWaterAccount'
	/** A run has no ewr_shortfall series, so its days below the EWR can't be counted. */
	| 'noEwrShortfall'
	/** Anything else; `detail` has the engine's message. */
	| 'failed';

/** Page 1's licence impact by year class: the baseline as the background, the application beside it. */
export interface EvidenceLicenceImpact {
	/** As the project set it when the report was built. */
	yearClassMethod: YearClassMethod;
	/** The Reserve site the project asked for (settings.outcomes.siteNodeId): null = the outlet; `name` is null when the baseline's model hasn't the node. */
	requestedSite: { nodeId: string; name: string | null } | null;
	/** The site read: null = the outlet, else the gauge and its name in the baseline's model. */
	site: { nodeId: string; name: string } | null;
	/** The requested gauge has no Reserve results in one of the runs, so the board reads the outlet. */
	siteFellBack: boolean;
	result: { status: 'ok'; impact: LicenceImpact } | { status: 'unavailable'; reason: EvidenceLicenceImpactUnavailable; detail: string | null };
}

export interface EvidenceReport {
	version: typeof EVIDENCE_REPORT_VERSION;
	mode: EvidenceMode;
	/** The engine that built the document (a pack records it; the runs' own engines are in `identity`). */
	builtBy: string;
	identity: {
		/** The scenario's name, or the project's for baseline evidence. */
		title: string;
		project: { id: string; name: string };
		baseline: {
			runId: string;
			label: string;
			engineVersion: string;
			runoffModel: string;
			startDate: string;
			endDate: string;
			createdAt: string;
			createdBy: string | null;
			/** The current nomination, when this run is it. */
			nomination: { nominatedAt: string; nominatedBy: string | null; reason: string } | null;
			/** Where the run stands against the project's publication (WP-2.3), persona A: "baseline provenance". */
			published: 'this' | 'other' | 'none';
			publishedAt: string | null;
		};
		application: {
			runId: string;
			label: string;
			engineVersion: string;
			createdAt: string;
			createdBy: string | null;
			scenarioId: string;
			scenarioName: string;
			scenarioStatus: string | null;
			ownerName: string | null;
			opsSha256: string;
			proposals: number;
			assumptions: number;
		} | null;
	};
	checks: EvidenceCheck[];
	/** A refusing check failed: the report isn't evidence (board 2). */
	refused: boolean;
	/** A baseline-assumption op: preview only, red banner on every page, can't be issued (G3). */
	assumptionsChanged: boolean;
	/** No check that blocks issue failed. */
	issuable: boolean;
	/** The application's ops, each with its class (the banner and Appendix A.2). */
	ops: { index: number; class: OpClass; op: ScenarioOp }[];
	flags: EvidenceFlag[];
	/** What an assessor will ask about, with the fix (persona P: board 1 "expect questions"). */
	questions: string[];
	/** Page 1's change table, fixed rows (G6). */
	rows: EvidenceRow[];
	/** The paired change in days below the outlet EWR, by calendar month (D-U9); null without a paired band or for baseline evidence. */
	byMonth: EvidenceMonthChange[] | null;
	/** The three months with the largest paired median increase, and any month that improves. */
	worstMonths: { month: number; median: number; band: Band }[];
	improvingMonths: { month: number; median: number; band: Band }[];
	rules: {
		/** The cited ensemble's decision rule, verbatim (ensembleDecisionRule). */
		r1: string | null;
		/** The paired band's rule, verbatim (summarisePaired). */
		r2: string | null;
		/** What a band is not (D-U3). */
		footnote: string;
	};
	river: EvidenceSite[];
	uncertainty: {
		declared: DeclaredUncertaintyRule | null;
		cited: EvidenceEnsembleRef | null;
		ledger: EvidenceEnsembleRef[];
		baseline: EnsembleSummary | null;
		paired: PairedSummary | null;
		/** Held-out coverage below its warning (D-U5). */
		coverageWarning: boolean;
		/** The coverage of the cited ensemble's primary record, 0–1. */
		coverage: number | null;
	};
	credibility: {
		nominations: EvidenceNomination[];
	};
	users: EvidenceUser[];
	/** § 4: users served in full while an EWR site below them fails. */
	servedWhileFailing: EvidenceServedWhileFailing;
	/** § 4: the other applications on the baseline and their summed change (evidence-3). */
	cumulative: EvidenceCumulative;
	/** § 5: registered water use against modelled use (WP-3.10). */
	allocations: EvidenceAllocations;
	/** Page 1's licence impact by year class (issue #53 R7, evidence-5); null for baseline evidence. Absent from an older pack's document. */
	licenceImpact?: EvidenceLicenceImpact | null;
	/** § 6: the applicant's demand objects and their sources (evidence-9); null for baseline evidence. Absent from an older pack's document, which has no § 6. */
	demandObjects?: EvidenceDemandObjects | null;
	appendix: {
		/** The baseline's settings and model, as it ran (the report's Appendix A.1 reads them). */
		baselineInputs: RunInputsSnapshot;
		/** The full input diff, application against baseline (A.2). */
		changes: InputChange[];
		/** Each input series of each run: kind, first day, days and SHA-256 (A.3). */
		series: { run: 'baseline' | 'application'; kind: string; startDate: string; days: number; sha256: string | null }[];
		history: EvidenceInput['history'];
		/** Every run warning, verbatim (A.5). */
		warnings: { baseline: string[]; application: string[] | null };
		/** Other application runs on the baseline (the ledger, persona A3). */
		applicationRuns: EvidenceApplicationRun[];
	};
	verification: {
		methodology: Pick<MethodologyVersion, 'version' | 'sha256'>;
		limitations: readonly Limitation[];
		/** Errata of either run's engine, or its fit's (deduplicated by id). */
		errata: Erratum[];
		disclaimerVersion: string;
	};
	/** The applicant's own words, only here (Appendix C, G13); null for baseline evidence. */
	applicantStatement: {
		scenarioName: string;
		/**
		 * The fixed prompts' answers, verbatim; '' = not given (evidence-8). Absent in a
		 * pack drafted before evidence-8, whose manifest froze no prompts.
		 */
		prompts?: ApplicantPrompts;
		description: string;
		ownerName: string | null;
		notes: string;
		notesUpdatedAt: string | null;
		notesUpdatedBy: string | null;
	} | null;
	/** Both runs' summaries, for the sections that reuse the run views (calibration, WR2012, data quality). */
	summaries: { baseline: RunSummary; application: RunSummary | null };
}
