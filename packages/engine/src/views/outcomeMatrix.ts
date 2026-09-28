// The outcome matrix (issue #53 R4, docs/design/planning-outputs.md §3.4,
// docs/model.md §2.14): rows are demand levels (one run each, e.g. R1's
// demand.scale at 1.0 / 0.85 / 0.7), columns are water-year classes
// (./yearClasses.ts), and each cell says how the river's requirement fared
// in that class's years at that demand level.
//
// A view over saved runs: not part of runModel, so ENGINE_VERSION doesn't
// move. Pure: no I/O.
//
// - **Cell metric.** With a Reserve rule table at the site (every level's
//   run has summary.ewrAssurance for it, §2.9c): the share of the class's
//   months met, pooled over its years. Otherwise the share of the class's
//   days below the pragmatic EWR at the outlet (the run's `ewr_shortfall`
//   series, the same test as ewrDaysNotMet, §2.9). The metric is one for the
//   whole matrix, so rows compare: if only some levels have the table, every
//   cell uses days below the EWR and a warning says why.
// - **Years.** Only the classed (complete) water years count, and in each
//   run only those it covers; every cell carries nYears. Fewer than
//   OUTCOME_MIN_YEARS years → `enoughYears: false`, no value and no risk.
// - **Risk labels** from cut-offs passed in; the defaults are placeholders
//   **pending the hydrologist** (the client's O1, plan.md § Decision-support
//   outputs). Wording (describeOutcomeCell) counts years ("met in 7 of 9 dry
//   years"), never "likely".
import type { ModelOutput } from '../project';
import type { EwrAssuranceSite } from '../reserve/assurance';
import { completeMonths, completeWaterYears } from '../reserve/assurance';
import type { WaterYearClasses, YearClassId } from './yearClasses';

export type OutcomeMetric = 'reserveMonthsMet' | 'daysBelowEwr';

/** Risk label for a cell, in the client's O1 wording. */
export type OutcomeRisk = 'lower' | 'increasing' | 'high';

export const OUTCOME_RISK_LABEL: Readonly<Record<OutcomeRisk, string>> = Object.freeze({
	lower: 'Lower risk',
	increasing: 'Increasing risk',
	high: 'High risk'
});

/** Years below which a cell is "not enough years": no value, no risk (judgement, design §3.4). */
export const OUTCOME_MIN_YEARS = 3;

/**
 * Risk cut-offs per metric, each in the metric's own direction:
 * - reserveMonthsMet: share of months met ≥ `lower` → lower risk; ≥ `increasing` → increasing risk; else high.
 * - daysBelowEwr: share of days below the EWR ≤ `lower` → lower risk; ≤ `increasing` → increasing risk; else high.
 */
export interface OutcomeRiskCutoffs {
	reserveMonthsMet: { lower: number; increasing: number };
	daysBelowEwr: { lower: number; increasing: number };
}

/**
 * PLACEHOLDER DEFAULTS, PENDING THE HYDROLOGIST (question O1: the client
 * agreed to them, issue #90; the hydrologist's confirmation is open). Days
 * below the EWR use the portfolio traffic lights' 5 % / 20 % (roadmap D11,
 * also unconfirmed); months met 90 % / 75 % are a judgement. The project
 * setting `settings.outcomes.riskCutoffs` overrides them per metric.
 */
export const DEFAULT_OUTCOME_RISK_CUTOFFS: Readonly<OutcomeRiskCutoffs> = Object.freeze({
	reserveMonthsMet: Object.freeze({ lower: 0.9, increasing: 0.75 }),
	daysBelowEwr: Object.freeze({ lower: 0.05, increasing: 0.2 })
});

/** True while the hydrologist hasn't confirmed DEFAULT_OUTCOME_RISK_CUTOFFS (O1; the client agreed, issue #90); a surface showing them should say so. */
export const OUTCOME_RISK_CUTOFFS_PENDING_HYDROLOGIST = true;

/** A demand level: an id, a label ("100 %") and its run. */
export interface OutcomeLevelInput {
	id: string;
	label: string;
	run: Pick<ModelOutput, 'startDate' | 'series' | 'summary'>;
}

export interface OutcomeMatrixOptions {
	/** `auto` (default): reserveMonthsMet when every level has a rule table at the site, else daysBelowEwr. */
	metric?: 'auto' | OutcomeMetric;
	/** The Reserve site: null (default) = the outlet, else a gauge's node id. Days below the EWR are always at the outlet. */
	siteNodeId?: string | null;
	/** Defaults to DEFAULT_OUTCOME_RISK_CUTOFFS. */
	cutoffs?: OutcomeRiskCutoffs;
}

/** One water year in a cell. */
export interface OutcomeYear {
	waterYear: number;
	/** Reserve: months assessed and met. Days: days and days below the EWR. */
	units: number;
	/** Units met (Reserve) or below the EWR (days). */
	count: number;
	/** count ÷ units. */
	share: number;
	/** Reserve: every month met; days: no day below the EWR. */
	met: boolean;
}

export interface OutcomeCell {
	levelId: string;
	classId: YearClassId;
	nYears: number;
	/** nYears ≥ OUTCOME_MIN_YEARS. When false, value and risk are null. */
	enoughYears: boolean;
	/** Years met in full (OutcomeYear.met), of nYears. */
	yearsMet: number;
	/** Pooled over the years: Σ count ÷ Σ units (share of months met, or of days below the EWR); null when !enoughYears. */
	value: number | null;
	risk: OutcomeRisk | null;
	/** Oldest first. */
	years: OutcomeYear[];
}

export interface OutcomeMatrix {
	metric: OutcomeMetric;
	/** The Reserve site (reserveMonthsMet), null = outlet; always null for daysBelowEwr. */
	siteNodeId: string | null;
	method: WaterYearClasses['method'];
	classes: { id: YearClassId; label: string; lowerM3: number | null; upperM3: number | null; nYears: number }[];
	levels: { id: string; label: string }[];
	/** cells[level][class], in the order of levels and classes. */
	cells: OutcomeCell[][];
	cutoffs: OutcomeRiskCutoffs;
	/** The defaults were used, so a surface should mark the labels pending the hydrologist. */
	cutoffsAreDefault: boolean;
	warnings: string[];
}

/** Throws when cut-offs are outside [0, 1] or in the wrong order. */
export function validateOutcomeCutoffs(c: OutcomeRiskCutoffs): void {
	const inUnit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
	const r = c.reserveMonthsMet;
	const d = c.daysBelowEwr;
	if (!inUnit(r.lower) || !inUnit(r.increasing) || r.lower < r.increasing) throw new RangeError('reserveMonthsMet cut-offs must be shares with lower ≥ increasing');
	if (!inUnit(d.lower) || !inUnit(d.increasing) || d.lower > d.increasing) throw new RangeError('daysBelowEwr cut-offs must be shares with lower ≤ increasing');
}

/** The risk label of a cell value under the metric's cut-offs (boundaries count to the lower risk). */
export function outcomeRisk(metric: OutcomeMetric, value: number, cutoffs: OutcomeRiskCutoffs = DEFAULT_OUTCOME_RISK_CUTOFFS): OutcomeRisk {
	if (metric === 'reserveMonthsMet') {
		const c = cutoffs.reserveMonthsMet;
		return value >= c.lower ? 'lower' : value >= c.increasing ? 'increasing' : 'high';
	}
	const c = cutoffs.daysBelowEwr;
	return value <= c.lower ? 'lower' : value <= c.increasing ? 'increasing' : 'high';
}

function reserveSite(run: OutcomeLevelInput['run'], siteNodeId: string | null): EwrAssuranceSite | undefined {
	return run.summary.ewrAssurance?.find((s) => (siteNodeId === null ? s.isOutlet : s.nodeId === siteNodeId));
}

/** Per water year: Reserve months assessed and met at the site. */
function reserveYears(site: EwrAssuranceSite): Map<number, { units: number; count: number }> {
	const out = new Map<number, { units: number; count: number }>();
	for (const m of site.months) {
		let y = out.get(m.waterYear);
		if (!y) out.set(m.waterYear, (y = { units: 0, count: 0 }));
		y.units++;
		if (m.met) y.count++;
	}
	return out;
}

/** Per complete water year: days and days below the pragmatic EWR at the outlet (`ewr_shortfall` < 0). */
function ewrYears(run: OutcomeLevelInput['run'], levelId: string): Map<number, { units: number; count: number }> {
	const s = run.series.find((x) => x.nodeId === null && x.key === 'ewr_shortfall');
	if (!s) throw new Error(`level ${levelId}: the run has no ewr_shortfall series`);
	const out = new Map<number, { units: number; count: number }>();
	for (const y of completeWaterYears(run.startDate, completeMonths(run.startDate, s.values.length))) {
		let below = 0;
		for (let t = y.from; t < y.from + y.days; t++) if (s.values[t]! < 0) below++;
		out.set(y.waterYear, { units: y.days, count: below });
	}
	return out;
}

/** Build the matrix: one row per level, one column per class of `classes`. */
export function outcomeMatrix(levels: readonly OutcomeLevelInput[], classes: WaterYearClasses, options: OutcomeMatrixOptions = {}): OutcomeMatrix {
	const cutoffs = options.cutoffs ?? DEFAULT_OUTCOME_RISK_CUTOFFS;
	validateOutcomeCutoffs(cutoffs);
	const ids = new Set<string>();
	for (const l of levels) {
		if (ids.has(l.id)) throw new Error(`duplicate level id: ${l.id}`);
		ids.add(l.id);
	}
	const siteNodeId = options.siteNodeId ?? null;
	const requested = options.metric ?? 'auto';
	const warnings: string[] = [];
	const sites = levels.map((l) => reserveSite(l.run, siteNodeId));
	let metric: OutcomeMetric;
	if (requested === 'reserveMonthsMet') {
		const missing = levels.filter((_, i) => !sites[i]);
		if (missing.length) throw new Error(`no Reserve rule table at the site for level ${missing.map((l) => l.id).join(', ')}`);
		metric = 'reserveMonthsMet';
	} else if (requested === 'daysBelowEwr') {
		metric = 'daysBelowEwr';
	} else {
		const withTable = sites.filter(Boolean).length;
		metric = levels.length > 0 && withTable === levels.length ? 'reserveMonthsMet' : 'daysBelowEwr';
		if (withTable > 0 && withTable < levels.length) {
			warnings.push('Only some demand levels have a Reserve rule table at the site, so every cell uses days below the pragmatic EWR, to keep the rows comparable.');
		}
	}

	const classOfYear = new Map(classes.years.map((y) => [y.waterYear, y.classId] as const));
	const cells = levels.map((level, li) => {
		const perYear = metric === 'reserveMonthsMet' ? reserveYears(sites[li]!) : ewrYears(level.run, level.id);
		const inRun = [...perYear.keys()].filter((wy) => classOfYear.has(wy));
		const notInRun = classes.years.filter((y) => !perYear.has(y.waterYear));
		if (notInRun.length) warnings.push(`${level.label}: its run does not cover ${notInRun.length} classed water year(s); those cells count the years it does.`);
		return classes.classes.map((band): OutcomeCell => {
			const years: OutcomeYear[] = inRun
				.filter((wy) => classOfYear.get(wy) === band.id)
				.sort((a, b) => a - b)
				.map((wy) => {
					const { units, count } = perYear.get(wy)!;
					const met = metric === 'reserveMonthsMet' ? count === units : count === 0;
					return { waterYear: wy, units, count, share: units ? count / units : 0, met };
				})
				.filter((y) => y.units > 0);
			const nYears = years.length;
			const enoughYears = nYears >= OUTCOME_MIN_YEARS;
			const units = years.reduce((s, y) => s + y.units, 0);
			const count = years.reduce((s, y) => s + y.count, 0);
			const value = enoughYears ? count / units : null;
			return {
				levelId: level.id,
				classId: band.id,
				nYears,
				enoughYears,
				yearsMet: years.filter((y) => y.met).length,
				value,
				risk: value === null ? null : outcomeRisk(metric, value, cutoffs),
				years
			};
		});
	});

	return {
		metric,
		siteNodeId: metric === 'reserveMonthsMet' ? siteNodeId : null,
		method: classes.method,
		classes: classes.classes.map((c) => ({ id: c.id, label: c.label, lowerM3: c.lowerM3, upperM3: c.upperM3, nYears: c.waterYears.length })),
		levels: levels.map((l) => ({ id: l.id, label: l.label })),
		cells,
		cutoffs,
		cutoffsAreDefault: options.cutoffs === undefined,
		warnings
	};
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * One sentence for a cell, counting years: "Reserve met in every month in 7
 * of 9 dry years (94 % of months met)." Never "likely". `classLabel` is the
 * class's label ("Dry"), lower-cased in the sentence.
 */
export function describeOutcomeCell(metric: OutcomeMetric, cell: OutcomeCell, classLabel: string): string {
	const cls = classLabel.toLowerCase();
	const noun = cell.nYears === 1 ? 'year' : 'years';
	if (!cell.enoughYears) {
		return cell.nYears === 0
			? `No ${cls} years in the record: not enough years to judge.`
			: `Only ${cell.nYears} ${cls} ${noun} in the record: not enough years to judge.`;
	}
	const v = cell.value!;
	return metric === 'reserveMonthsMet'
		? `Reserve met in every month in ${cell.yearsMet} of ${cell.nYears} ${cls} ${noun} (${pct(v)} of months met).`
		: `EWR met on every day in ${cell.yearsMet} of ${cell.nYears} ${cls} ${noun} (below it on ${pct(v)} of days).`;
}
