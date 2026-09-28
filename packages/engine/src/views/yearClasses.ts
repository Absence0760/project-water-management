// Water-year classes (issue #53 R4, docs/design/planning-outputs.md §3.4,
// docs/model.md §2.14): the run's complete water years split into dry /
// normal / wet (terciles) or very dry … very wet (quintiles) by the annual
// total of the catchment's natural flow. The columns of the outcome matrix
// (./outcomeMatrix.ts) and, later, the evidence report's licence-impact board
// (R7).
//
// A view over a run's series: not part of runModel, so ENGINE_VERSION
// doesn't move. Pure: no I/O.
//
// Decisions (model.md §2.14):
// - Only **complete** water years (1 Oct … 30 Sep all inside the run, the
//   Reserve's own completeWaterYears) are classed; a part year at either end,
//   or a year with a missing (non-finite) day, is listed in `excluded`,
//   never ranked, since a part total would read as a dry year.
// - Bounds are the annual totals' quantiles on Weibull plotting positions
//   (i ÷ (n + 1), linear between, held at the ends: the rule of the
//   Reserve's natural curve, durationQuantile, §2.9c), so they are the
//   catchment's own, in m³. The rank is computed as (k − j)(n + 1) ÷ k in
//   integers, not from a % (66.67 % × 9 = 5.9999…), so a bound that falls on
//   a year's rank is exactly that year's total and the tie rule holds.
// - A year exactly on a bound goes to the **drier** class (each class's upper
//   bound is inclusive): "dry = at or below the lower tercile". Equal totals
//   always share a class, since classes are by value, not by rank.
// - The method is a parameter: `auto` (terciles, quintiles from 25 years)
//   is the default, confirmed by the client (O2, issue #90; plan.md
//   § Decision-support outputs). A project may still choose one.
import { waterYearLabel, waterYearOf, toEpochDay } from '../calendar';
import type { ModelOutput } from '../project';
import { completeMonths, completeWaterYears } from '../reserve/assurance';

/** How to split the years. `auto`: quintiles when there are at least YEAR_CLASS_QUINTILE_MIN_YEARS complete years, else terciles. */
export type YearClassMethod = 'auto' | 'terciles' | 'quintiles';

/** Complete water years from which `auto` uses quintiles (confirmed by the client, O2, issue #90). */
export const YEAR_CLASS_QUINTILE_MIN_YEARS = 25;

export type YearClassId = 'veryDry' | 'dry' | 'normal' | 'wet' | 'veryWet';

/** Class ids driest first, per method. */
export const YEAR_CLASS_IDS: Readonly<Record<'terciles' | 'quintiles', readonly YearClassId[]>> = Object.freeze({
	terciles: Object.freeze(['dry', 'normal', 'wet'] as const),
	quintiles: Object.freeze(['veryDry', 'dry', 'normal', 'wet', 'veryWet'] as const)
});

export const YEAR_CLASS_LABEL: Readonly<Record<YearClassId, string>> = Object.freeze({
	veryDry: 'Very dry',
	dry: 'Dry',
	normal: 'Normal',
	wet: 'Wet',
	veryWet: 'Very wet'
});

/** One class: its bounds on the annual natural flow (m³) and its years. */
export interface YearClassBand {
	id: YearClassId;
	label: string;
	/** Exclusive lower bound, m³; null for the driest class (no lower bound). */
	lowerM3: number | null;
	/** Inclusive upper bound, m³; null for the wettest class (no upper bound). */
	upperM3: number | null;
	/** Its water years (by the calendar year each starts in), oldest first. */
	waterYears: number[];
}

export interface ClassifiedWaterYear {
	/** By the calendar year its 1 October falls in. */
	waterYear: number;
	/** "2016/17". */
	label: string;
	days: number;
	/** Σ natural flow over the year, m³. */
	naturalM3: number;
	classId: YearClassId;
}

export type ExcludedWaterYearReason = 'partial' | 'missingDays';

export interface ExcludedWaterYear {
	waterYear: number;
	label: string;
	/** `partial`: the run starts or ends inside it; `missingDays`: a non-finite natural flow on some day. */
	reason: ExcludedWaterYearReason;
}

export interface WaterYearClasses {
	/** The method asked for. */
	requested: YearClassMethod;
	/** The method used (`auto` resolved). */
	method: 'terciles' | 'quintiles';
	/** The bounds between classes, m³, rising (k − 1 of them; empty without a complete year). */
	boundsM3: number[];
	/** Driest first. */
	classes: YearClassBand[];
	/** Every complete water year, oldest first. */
	years: ClassifiedWaterYear[];
	/** Water years the run touches but that aren't classed, oldest first. */
	excluded: ExcludedWaterYear[];
}

export interface YearClassInput {
	/** The run's first day, ISO. */
	startDate: string;
	/** The catchment's natural flow per day, m³/day, from startDate. */
	naturalM3Day: ArrayLike<number>;
}

/** The method `auto` resolves to for `n` complete years. */
export function resolveYearClassMethod(method: YearClassMethod, n: number): 'terciles' | 'quintiles' {
	if (method === 'auto') return n >= YEAR_CLASS_QUINTILE_MIN_YEARS ? 'quintiles' : 'terciles';
	return method;
}

/** Classify the complete water years of a natural-flow series by their annual totals. */
export function classifyWaterYears(input: YearClassInput, options: { method?: YearClassMethod } = {}): WaterYearClasses {
	const requested = options.method ?? 'auto';
	if (requested !== 'auto' && requested !== 'terciles' && requested !== 'quintiles') throw new RangeError(`unknown year-class method: ${String(requested)}`);
	const { startDate, naturalM3Day: q } = input;
	const days = q.length;
	const complete = completeWaterYears(startDate, completeMonths(startDate, days));

	const totals: { waterYear: number; days: number; naturalM3: number }[] = [];
	const excluded: ExcludedWaterYear[] = [];
	for (const y of complete) {
		let sum = 0;
		let finite = true;
		for (let t = y.from; t < y.from + y.days; t++) {
			const v = q[t]!;
			if (!Number.isFinite(v)) {
				finite = false;
				break;
			}
			sum += v;
		}
		if (finite) totals.push({ waterYear: y.waterYear, days: y.days, naturalM3: sum });
		else excluded.push({ waterYear: y.waterYear, label: waterYearLabel(y.waterYear), reason: 'missingDays' });
	}
	if (days > 0) {
		const d0 = toEpochDay(startDate);
		const completeSet = new Set(complete.map((y) => y.waterYear));
		for (let wy = waterYearOf(d0); wy <= waterYearOf(d0 + days - 1); wy++) {
			if (!completeSet.has(wy)) excluded.push({ waterYear: wy, label: waterYearLabel(wy), reason: 'partial' });
		}
	}
	excluded.sort((a, b) => a.waterYear - b.waterYear);

	const method = resolveYearClassMethod(requested, totals.length);
	const ids = YEAR_CLASS_IDS[method];
	const k = ids.length;
	// The annual duration curve, wettest first. The bound between class j − 1
	// and j is the total at non-exceedance j ÷ k: exceedance rank
	// h = (k − j)(n + 1) ÷ k, linear between ranks, held at the ends.
	const desc = totals.map((y) => y.naturalM3).sort((a, b) => b - a);
	const n = desc.length;
	const boundsM3: number[] = [];
	if (n) {
		for (let j = 1; j < k; j++) {
			const num = (k - j) * (n + 1);
			const i = Math.floor(num / k);
			const f = (num - i * k) / k;
			boundsM3.push(i < 1 ? desc[0]! : i >= n ? desc[n - 1]! : f === 0 ? desc[i - 1]! : desc[i - 1]! + f * (desc[i]! - desc[i - 1]!));
		}
	}

	const classOf = (v: number): YearClassId => {
		let j = 0;
		while (j < boundsM3.length && v > boundsM3[j]!) j++;
		return ids[j]!;
	};
	const years: ClassifiedWaterYear[] = totals.map((y) => ({ ...y, label: waterYearLabel(y.waterYear), classId: classOf(y.naturalM3) }));
	const classes: YearClassBand[] = ids.map((id, j) => ({
		id,
		label: YEAR_CLASS_LABEL[id],
		lowerM3: j === 0 || !boundsM3.length ? null : boundsM3[j - 1]!,
		upperM3: j === k - 1 || !boundsM3.length ? null : boundsM3[j]!,
		waterYears: years.filter((y) => y.classId === id).map((y) => y.waterYear)
	}));
	return { requested, method, boundsM3, classes, years, excluded };
}

/** A run's catchment natural flow (`natural_flow` at the outlet), m³/day. Throws when the run has none. */
export function runNaturalFlow(run: Pick<ModelOutput, 'series'>): number[] {
	const s = run.series.find((x) => x.nodeId === null && x.key === 'natural_flow');
	if (!s) throw new Error('the run has no natural_flow series');
	return s.values;
}

/** classifyWaterYears on a run's own natural flow. */
export function classifyRunWaterYears(run: Pick<ModelOutput, 'startDate' | 'series'>, options: { method?: YearClassMethod } = {}): WaterYearClasses {
	return classifyWaterYears({ startDate: run.startDate, naturalM3Day: runNaturalFlow(run) }, options);
}
