// EWR compliance by the Reserve's assurance rules (engine ≥ 0.21.0,
// hydrologist Q6; docs/model.md §2.9c). Pure: no I/O.
//
// Per EWR site with a rule table (./rules.ts), per complete calendar month of
// the run:
//   1. the month's natural flow V at the site (Σ the upstream farms' runoff I,
//      no dams or abstraction), in the table's unit;
//   2. its natural-flow condition: where V sits on that calendar month's
//      natural flow duration curve N (the run's own, or the table's), as an
//      exceedance % between the table's points;
//   3. the required flow R: the EWR row T read at the same %; linear between
//      points, T₁ above the wettest point, T_last × V / N_last below the
//      driest (the requirement scales with a flow below the table);
//   4. compliance: the simulated (impacted) flow A at the site ≥ R.
// A month is the unit of compliance, as in Reserve monitoring (Pollard et
// al. 2011; Riddell et al. 2014), not the day.
//
// Separately, per calendar month, the FDC check: the impacted flow duration
// curve against the EWR curve at every % point (the "flow equalled or
// exceeded p % of the time" reading of an assurance rule; Hughes & Hannart
// 2003, Pollard et al. 2011 Fig. 4).
//
// Invariant (tested): when every EWR value is at most the natural flow at the
// same point (T ≤ N), natural flow meets its own requirement in every month,
// because the lookup interpolates T and N with the same weights; and R
// depends only on natural flow, so more abstraction can only lose months.
import { toEpochDay, waterYearIndex, waterYearOf } from '../calendar';
import { BASEFLOW_HISTORY_DAYS, monthBaseflowSum } from './baseflow';
import type { EwrHighFlowEvent, EwrNaturalSource, EwrRuleComponent, EwrRuleSourceKind, EwrRuleTable, EwrRuleUnit, LowFlowMeasure } from './rules';

const SEC_PER_DAY = 86_400;
/** Years of a calendar month below which the run's natural-flow percentiles are coarse. */
export const EWR_ASSURANCE_MIN_YEARS = 10;
/**
 * How far the run's natural MAR at a site may differ from the determination's
 * (EwrRuleTable.naturalMarMcm) before a run whose percentile comes from its
 * own natural flow warns: ±15 % (engine ≥ 1.11.0, issue #46). A judgement,
 * not a published standard: the tolerance the hydrologist and licensing
 * persona drafts proposed, roughly the gap between WR2012 and quinary
 * natural MARs (calibration-research.md CR-7). Pending the client's
 * hydrologist (model.md §2.9c).
 */
export const EWR_NATURAL_MAR_TOLERANCE = 0.15;

/** Whether a natural-MAR difference (%, run vs determination) is beyond ±EWR_NATURAL_MAR_TOLERANCE; exactly 15 % is within. */
export const naturalMarBeyondTolerance = (differencePct: number) => Math.abs(differencePct) > 100 * EWR_NATURAL_MAR_TOLERANCE * (1 + 1e-12);
/** Relative float tolerance on "A ≥ R". */
const MET_TOLERANCE = 1e-9;

/** Where a month's natural flow falls against the natural curve's points. */
export type EwrConditionBeyond = 'wetter' | 'drier' | null;

/** One complete month at one site. Flows are in the table's unit (Mm³, or mean m³/s). */
export interface EwrAssuranceMonth {
	/** Calendar year and month (1–12). */
	year: number;
	month: number;
	/** Water year, by the calendar year it starts in. */
	waterYear: number;
	days: number;
	natural: number;
	/** Exceedance % of the natural flow on the month's natural curve: its condition (low = wet). */
	percentile: number;
	/** Wetter than the table's first point (R = T₁), drier than its last (R scaled with V), else null. */
	beyond: EwrConditionBeyond;
	required: number;
	actual: number;
	met: boolean;
	/** MAX(R − A, 0) as a volume, m³. */
	deficitM3: number;
	/**
	 * With a low-flow grid on a total table (engine ≥ 0.33.0, §2.9d): the
	 * low-flow requirement at the same percentile, whether the month's flow met
	 * it, and the high-flow part of the requirement, MAX(R − R_low, 0).
	 * Absent without a low-flow grid.
	 */
	requiredLowFlow?: number;
	lowFlowMet?: boolean;
	requiredHighFlow?: number;
	/**
	 * The month's base flow at the site (table unit), when low flows are
	 * judged on base flow (settings.lowFlowMeasure 'baseflow', engine ≥ 1.3.0)
	 * and the table has a low-flow requirement: then a `lowFlow` table's `met`
	 * and a total table's `lowFlowMet` compare it, not `actual`, with the
	 * requirement. Absent otherwise. From engine 1.6.0 it is filtered over
	 * the month and the days before it only (./baseflow.ts monthBaseflowSum),
	 * so no later day changes it.
	 */
	baseflow?: number;
}

/** Months met against one requirement (the low flows of a total table). */
export interface EwrMonthsMet {
	months: number;
	met: number;
	/** met ÷ months; null without a complete month. */
	rate: number | null;
	deficitM3: number;
	longestNotMetRun: number;
}

/** One water year of a high-flow component. */
export interface EwrHighFlowYear {
	/** By the calendar year its 1 October falls in. */
	waterYear: number;
	/** Events the site's natural flow had. */
	natural: number;
	/** Events the simulated flow had. */
	actual: number;
	/** MIN(perYear, natural): nothing is asked that natural flow didn't give. */
	required: number;
	/** actual ≥ required. */
	met: boolean;
}

/** A high-flow component's compliance over the run's complete water years (engine ≥ 0.33.0, §2.9d). */
export interface EwrHighFlowReport extends EwrHighFlowEvent {
	/** The peak as applied: peakM3s × the table's scale. */
	peakAppliedM3s: number;
	years: EwrHighFlowYear[];
	overall: {
		/** Complete water years assessed. */
		years: number;
		/** Years with required > 0. */
		required: number;
		/** Of those, the years met. */
		met: number;
		/** met ÷ required; null when no year required an event. */
		rate: number | null;
	};
}

export interface EwrFdcPoint {
	point: number;
	/** The EWR curve at the point (× scale), table unit. */
	required: number;
	/** The impacted flow duration curve at the point; null without a complete month. */
	impacted: number | null;
	/** impacted ≥ required; null without a complete month. */
	met: boolean | null;
}

/** One calendar month over the run (the list is in water-year order, Oct … Sep). */
export interface EwrAssuranceMonthOfYear {
	month: number;
	/** Complete months of this calendar month in the run. */
	years: number;
	met: number;
	/** met ÷ years; null when years = 0. */
	rate: number | null;
	deficitM3: number;
	meanRequired: number | null;
	meanActual: number | null;
	/** The natural curve used at the points (the run's or the table's, × scale); null with no complete month in 'run' mode. */
	naturalCurve: number[] | null;
	fdc: EwrFdcPoint[];
	/** Low flows met ÷ years (engine ≥ 0.33.0); absent without a low-flow grid, null when years = 0. */
	lowFlowRate?: number | null;
}

export interface EwrAssuranceSite {
	/** null = the catchment outlet. */
	nodeId: string | null;
	name: string;
	isOutlet: boolean;
	source: string;
	/** The table's source kind (engine ≥ 1.5.0); absent when the table doesn't state one. */
	sourceKind?: EwrRuleSourceKind;
	component: EwrRuleComponent;
	unit: EwrRuleUnit;
	naturalSource: EwrNaturalSource;
	scale: number;
	points: number[];
	months: EwrAssuranceMonth[];
	byMonth: EwrAssuranceMonthOfYear[];
	overall: {
		months: number;
		met: number;
		/** met ÷ months; null without a complete month. */
		rate: number | null;
		deficitM3: number;
		/** Most consecutive months not met (contiguity, Riddell et al. 2014). */
		longestNotMetRun: number;
		/** Mean (R − A) ÷ R over the months not met with R > 0; null when none. */
		meanShortfallPct: number | null;
	};
	/** The FDC check over all calendar months × points. */
	fdc: { cells: number; met: number; rate: number | null };
	/** Fewest complete years of any calendar month (0 when one is missing). */
	minYears: number;
	/** The low flows of a total table, month by month (engine ≥ 0.33.0); absent without a low-flow grid. */
	lowFlow?: EwrMonthsMet;
	/** The freshet and flood components (engine ≥ 0.33.0); absent when the table has none. */
	highFlows?: EwrHighFlowReport[];
	/**
	 * 'baseflow' when the low-flow requirement was judged on the month's base
	 * flow (engine ≥ 1.3.0, settings.lowFlowMeasure); absent when it was the
	 * month's total volume, or the table has no low-flow requirement.
	 */
	lowFlowMeasure?: 'baseflow';
	/**
	 * The run's natural MAR at the site against the determination's (engine ≥
	 * 1.11.0): present when the table records one (naturalMarMcm) and the run
	 * has every calendar month at least once. runMcm = Σ over the 12 calendar
	 * months of the mean complete-month natural volume, Mm³/a; tableMcm =
	 * naturalMarMcm × scale; differencePct = 100 (run − table) ÷ table.
	 */
	naturalMar?: { runMcm: number; tableMcm: number; differencePct: number };
}

/** A site to assess: its table, and its daily natural and simulated flow (m³/day). */
export interface EwrAssuranceInput {
	table: EwrRuleTable;
	nodeId: string | null;
	name: string;
	isOutlet: boolean;
	natural: ArrayLike<number>;
	impacted: ArrayLike<number>;
}

/**
 * The value at exceedance `p` % of a duration curve through `values`: sorted
 * descending, the i-th (1-based) plotted at i ÷ (n + 1) (Weibull), linear
 * between, held at the ends. null for no values.
 */
export function durationQuantile(values: readonly number[], p: number): number | null {
	const n = values.length;
	if (n === 0) return null;
	const x = [...values].sort((a, b) => b - a);
	const h = (p / 100) * (n + 1);
	if (h <= 1) return x[0]!;
	if (h >= n) return x[n - 1]!;
	const i = Math.floor(h);
	return x[i - 1]! + (h - i) * (x[i]! - x[i - 1]!);
}

/** The running minimum along a row, so a duration curve never rises. */
export function runningMin(row: readonly number[]): number[] {
	const out: number[] = [];
	let m = Infinity;
	for (const v of row) out.push((m = Math.min(m, v)));
	return out;
}

/**
 * Read the requirement for natural flow `v` off a rule table: `natural` is the
 * natural curve at `points` (non-increasing), `ewr` the EWR at the same
 * points. The first point with natural ≤ v and the one before it bracket v;
 * the % and the EWR are interpolated with the same weight. Above the first
 * point the EWR is the first; below the last it is last × v ÷ natural_last.
 */
export function lookupRequirement(
	v: number,
	points: readonly number[],
	natural: readonly number[],
	ewr: readonly number[]
): { percentile: number; required: number; beyond: EwrConditionBeyond } {
	const last = points.length - 1;
	// A curve point within float noise of v counts as reached: on a flat stretch of the curve
	// (equal natural flow at several % points) a one-ulp difference in v, from summing the same
	// flows in another order, otherwise jumps the percentile across the stretch (fuzz seed
	// 18472, engine 0.24.1). v is the month's volume, so 1e-12 of it is far below any reading.
	const reach = v + Math.abs(v) * 1e-12;
	const k = natural.findIndex((n) => n <= reach);
	if (k === 0) return { percentile: points[0]!, required: ewr[0]!, beyond: v > natural[0]! ? 'wetter' : null };
	if (k === -1) {
		// v < natural_last, so natural_last > 0.
		return { percentile: points[last]!, required: (ewr[last]! * v) / natural[last]!, beyond: 'drier' };
	}
	const hi = natural[k - 1]!;
	const lo = natural[k]!;
	const w = Math.min(Math.max((hi - v) / (hi - lo), 0), 1);
	return {
		percentile: points[k - 1]! + w * (points[k]! - points[k - 1]!),
		required: ewr[k - 1]! + w * (ewr[k]! - ewr[k - 1]!),
		beyond: null
	};
}

/** Days in a calendar month (1–12). */
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

interface MonthBlock {
	year: number;
	month: number;
	from: number;
	days: number;
}

/** The run's complete calendar months, in order (a part month at either end is left out). */
export function completeMonths(startDate: string, days: number): MonthBlock[] {
	const d0 = toEpochDay(startDate);
	const out: MonthBlock[] = [];
	let t = 0;
	while (t < days) {
		const date = new Date((d0 + t) * SEC_PER_DAY * 1000);
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const first = date.getUTCDate() === 1;
		const len = daysInMonth(year, month);
		const n = Math.min(len - date.getUTCDate() + 1, days - t);
		if (first && n === len) out.push({ year, month, from: t, days: len });
		t += n;
	}
	return out;
}

/** The natural and impacted flow (m³) of a calendar month's days before a resumed run (assessSite's `carried`). */
export interface MonthCarry {
	/** Days of the month before the run's first day. */
	days: number;
	natural: number;
	impacted: number;
}

/**
 * The impacted daily flow (m³/day, oldest first) a resumed run needs before
 * its first day to filter its months' base flow exactly as the
 * uninterrupted run does (engine ≥ 1.6.0, settings.lowFlowMeasure
 * 'baseflow'): the BASEFLOW_HISTORY_DAYS days before the first day of the
 * month holding day `at` and that month's days before `at`, or as many of
 * them as the record holds. `history` is the days the run itself was given
 * before its first day (a resumed run's), oldest first.
 */
export function baseflowHistoryAt(startDate: string, at: number, impacted: ArrayLike<number>, history: ArrayLike<number> = []): number[] {
	const before = new Date((toEpochDay(startDate) + at) * SEC_PER_DAY * 1000).getUTCDate() - 1;
	const out: number[] = [];
	for (let t = Math.max(at - before - BASEFLOW_HISTORY_DAYS, -history.length); t < at; t++) out.push(t < 0 ? history[history.length + t]! : impacted[t]!);
	return out;
}

/** The calendar month a run starts inside, `before` of its days before the run: a block with from = −before, or null when the run ends before the month does. */
function carriedMonth(d0: number, days: number, before: number): MonthBlock | null {
	const date = new Date(d0 * SEC_PER_DAY * 1000);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() + 1;
	if (date.getUTCDate() !== before + 1) throw new Error(`a carried month of ${before} days does not end the day before ${date.toISOString().slice(0, 10)}`);
	const len = daysInMonth(year, month);
	if (len - before > days) return null;
	return { year, month, from: -before, days: len };
}

/**
 * The sums a resumed run carries into assessSite (engine ≥ 1.1.0): the
 * natural and impacted flow of the month holding day `at` (an index into
 * the series), from its first day to the day before `at`, summed as
 * assessSite sums a month. null when `at` is a month's first day, or the
 * month began before the series (it isn't a complete month either way).
 */
export function monthCarryAt(
	startDate: string,
	at: number,
	natural: ArrayLike<number>,
	impacted: ArrayLike<number>
): MonthCarry | null {
	const date = new Date((toEpochDay(startDate) + at) * SEC_PER_DAY * 1000);
	const before = date.getUTCDate() - 1;
	if (before === 0 || at - before < 0) return null;
	let nat = 0;
	let imp = 0;
	for (let t = at - before; t < at; t++) {
		const n = natural[t]!;
		const a = impacted[t]!;
		nat += Number.isFinite(n) ? n : 0;
		imp += Number.isFinite(a) ? a : 0;
	}
	return { days: before, natural: nat, impacted: imp };
}

/** m³ over a month of `days` days → the table's unit, and back. */
const toUnit = (m3: number, days: number, unit: EwrRuleUnit) => (unit === 'mcm' ? m3 / 1e6 : m3 / (days * SEC_PER_DAY));
const toM3 = (v: number, days: number, unit: EwrRuleUnit) => (unit === 'mcm' ? v * 1e6 : v * days * SEC_PER_DAY);

/**
 * Assess one site. Also returns the requirement as a daily series (m³/day:
 * R's volume ÷ the month's days; NaN outside complete months), for charts and
 * the daily CSV.
 */
export function assessSite(
	startDate: string,
	days: number,
	site: EwrAssuranceInput,
	/**
	 * The natural curves to use per water-year month (Oct … Sep) in 'run'
	 * mode, pinned from the run a model-state snapshot came from (engine ≥
	 * 1.1.0, ../warmstart); a month's null, or none given, is this run's own.
	 */
	pinnedNatural?: readonly (readonly number[] | null)[],
	/**
	 * A run resumed part-way through a calendar month (engine ≥ 1.1.0): that
	 * month's first `days` days before the run, as the natural and impacted
	 * sums (m³) so far, so the month is still assessed whole.
	 */
	carried?: MonthCarry | null,
	/**
	 * settings.lowFlowMeasure (engine ≥ 1.3.0): 'baseflow' judges a low-flow
	 * requirement on the month's base flow (./baseflow.ts); 'total' or absent,
	 * on its volume.
	 */
	lowFlowMeasure: LowFlowMeasure = 'total',
	/**
	 * A resumed run's impacted daily flow before its first day, oldest first
	 * (baseflowHistoryAt, carried in the snapshot; engine ≥ 1.6.0): the
	 * record a month's base-flow window reaches back into.
	 */
	history: ArrayLike<number> = []
): { report: EwrAssuranceSite; requiredM3Day: Float64Array } {
	const { table } = site;
	const unit = table.unit;
	const P = table.points;
	// Base flow only matters where there is a low-flow requirement to judge.
	const onBase = lowFlowMeasure === 'baseflow' && (table.component === 'lowFlow' || !!table.lowFlow);
	// A month's base flow (m³), causally: filtered over the month and the record
	// before it (at most BASEFLOW_HISTORY_DAYS days; a resumed run's reaches into
	// `history`), so nothing after the month changes it (./baseflow.ts).
	const baseOf = (from: number, len: number) => {
		const w0 = Math.max(from - BASEFLOW_HISTORY_DAYS, -history.length);
		const w = new Float64Array(from + len - w0);
		for (let k = 0; k < w.length; k++) {
			const t = w0 + k;
			w[k] = t < 0 ? history[history.length + t]! : site.impacted[t]!;
		}
		return monthBaseflowSum(w, len);
	};
	const inRun = completeMonths(startDate, days);
	const requiredM3Day = new Float64Array(days).fill(NaN);
	const d0 = toEpochDay(startDate);
	// The month the run starts inside, whole with the days carried from before it (from < 0).
	const head = carried && carried.days > 0 ? carriedMonth(d0, days, carried.days) : null;
	const blocks = head ? [head, ...inRun] : inRun;
	if (onBase && head && history.length < -head.from)
		throw new Error(`a resumed run judging low flows on base flow needs the ${-head.from} days of its first month before it; the snapshot carries ${history.length}`);

	// Per complete month, natural and impacted in the table's unit.
	const rows = blocks.map((b) => {
		let nat = b === head ? carried!.natural : 0;
		let imp = b === head ? carried!.impacted : 0;
		for (let t = Math.max(b.from, 0); t < b.from + b.days; t++) {
			const n = site.natural[t]!;
			const a = site.impacted[t]!;
			nat += Number.isFinite(n) ? n : 0;
			imp += Number.isFinite(a) ? a : 0;
		}
		return {
			...b,
			w: waterYearIndex(b.month),
			naturalM3: nat,
			natural: toUnit(nat, b.days, unit),
			actual: toUnit(imp, b.days, unit),
			...(onBase ? { baseflow: toUnit(baseOf(b.from, b.days), b.days, unit) } : {})
		};
	});

	const byW = Array.from({ length: 12 }, (_, w) => rows.filter((r) => r.w === w));
	const curves = byW.map((list, w) => {
		const ewr = table.ewr[w]!.map((v) => v * table.scale);
		const low = table.lowFlow ? table.lowFlow[w]!.map((v) => v * table.scale) : null;
		const pinned = pinnedNatural?.[w];
		const natural =
			table.naturalSource === 'table'
				? runningMin(table.natural![w]!.map((v) => v * table.scale))
				: pinned
					? [...pinned]
					: list.length
						? runningMin(P.map((p) => durationQuantile(list.map((r) => r.natural), p)!))
						: null;
		return { ewr, natural, low };
	});

	const months: EwrAssuranceMonth[] = rows.map((r) => {
		const c = curves[r.w]!;
		const look = lookupRequirement(r.natural, P, c.natural!, c.ewr);
		// The flow a low-flow requirement is judged on: the month's base flow, or its volume.
		const lowActual = r.baseflow ?? r.actual;
		const judged = table.component === 'lowFlow' ? lowActual : r.actual;
		const met = isMet(judged, look.required);
		const deficitM3 = met ? 0 : toM3(look.required - judged, r.days, unit);
		const reqM3Day = toM3(look.required, r.days, unit) / r.days;
		for (let t = Math.max(r.from, 0); t < r.from + r.days; t++) requiredM3Day[t] = reqM3Day;
		const month: EwrAssuranceMonth = {
			year: r.year,
			month: r.month,
			waterYear: waterYearOf(d0 + r.from),
			days: r.days,
			natural: r.natural,
			percentile: look.percentile,
			beyond: look.beyond,
			required: look.required,
			actual: r.actual,
			met,
			deficitM3
		};
		if (r.baseflow !== undefined) month.baseflow = r.baseflow;
		if (c.low) {
			// The same natural curve, so the same point and interpolation weight as the total.
			const low = lookupRequirement(r.natural, P, c.natural!, c.low).required;
			month.requiredLowFlow = low;
			month.lowFlowMet = isMet(lowActual, low);
			month.requiredHighFlow = Math.max(look.required - low, 0);
		}
		return month;
	});

	const byMonth: EwrAssuranceMonthOfYear[] = byW.map((list, w) => {
		const ms = months.filter((m) => waterYearIndex(m.month) === w);
		const n = ms.length;
		const impactedValues = list.map((r) => r.actual);
		const c = curves[w]!;
		const fdc: EwrFdcPoint[] = P.map((p, i) => {
			const q = durationQuantile(impactedValues, p);
			const required = c.ewr[i]!;
			return { point: p, required, impacted: q, met: q === null ? null : q >= required - MET_TOLERANCE * Math.max(required, q) };
		});
		const met = ms.filter((m) => m.met).length;
		const row: EwrAssuranceMonthOfYear = {
			month: ((w + 9) % 12) + 1,
			years: n,
			met,
			rate: n ? met / n : null,
			deficitM3: ms.reduce((s, m) => s + m.deficitM3, 0),
			meanRequired: n ? ms.reduce((s, m) => s + m.required, 0) / n : null,
			meanActual: n ? ms.reduce((s, m) => s + m.actual, 0) / n : null,
			naturalCurve: c.natural,
			fdc
		};
		if (table.lowFlow) row.lowFlowRate = n ? ms.filter((m) => m.lowFlowMet).length / n : null;
		return row;
	});

	const longest = longestRun(months.map((m) => m.met));
	const short = months.filter((m) => !m.met && m.required > 0);
	const judgedOf = (m: EwrAssuranceMonth) => (table.component === 'lowFlow' ? (m.baseflow ?? m.actual) : m.actual);
	const met = months.filter((m) => m.met).length;
	const cells = byMonth.flatMap((m) => m.fdc.filter((f) => f.met !== null));
	const cellsMet = cells.filter((f) => f.met).length;

	const report: EwrAssuranceSite = {
		nodeId: site.nodeId,
		name: site.name,
		isOutlet: site.isOutlet,
		source: table.source,
		...(table.sourceKind ? { sourceKind: table.sourceKind } : {}),
		component: table.component,
		unit,
		naturalSource: table.naturalSource,
		scale: table.scale,
		points: [...P],
		months,
		byMonth,
		overall: {
			months: months.length,
			met,
			rate: months.length ? met / months.length : null,
			deficitM3: months.reduce((s, m) => s + m.deficitM3, 0),
			longestNotMetRun: longest,
			meanShortfallPct: short.length ? (100 * short.reduce((s, m) => s + (m.required - judgedOf(m)) / m.required, 0)) / short.length : null
		},
		fdc: { cells: cells.length, met: cellsMet, rate: cells.length ? cellsMet / cells.length : null },
		minYears: Math.min(...byMonth.map((m) => m.years))
	};
	if (table.lowFlow) {
		const lowMet = months.filter((m) => m.lowFlowMet).length;
		report.lowFlow = {
			months: months.length,
			met: lowMet,
			rate: months.length ? lowMet / months.length : null,
			deficitM3: months.reduce((s, m) => s + (m.lowFlowMet ? 0 : toM3(m.requiredLowFlow! - (m.baseflow ?? m.actual), m.days, unit)), 0),
			longestNotMetRun: longestRun(months.map((m) => m.lowFlowMet!))
		};
	}
	if (table.highFlows?.length) {
		report.highFlows = table.highFlows.map((e) => assessHighFlow(e, table.scale, startDate, inRun, site.natural, site.impacted));
	}
	if (onBase) report.lowFlowMeasure = 'baseflow';
	if (table.naturalMarMcm != null && byW.every((list) => list.length > 0)) {
		const runMcm = byW.reduce((s, list) => s + list.reduce((a, r) => a + r.naturalM3, 0) / list.length, 0) / 1e6;
		const tableMcm = table.naturalMarMcm * table.scale;
		report.naturalMar = { runMcm, tableMcm, differencePct: (100 * (runMcm - tableMcm)) / tableMcm };
	}
	return { requiredM3Day, report };
}

const isMet = (actual: number, required: number) => actual >= required - MET_TOLERANCE * Math.max(Math.abs(required), Math.abs(actual));

/** Most consecutive false values. */
function longestRun(met: readonly boolean[]): number {
	let longest = 0;
	let run = 0;
	for (const m of met) {
		run = m ? 0 : run + 1;
		longest = Math.max(longest, run);
	}
	return longest;
}

/**
 * The run's complete water years (1 Oct … 30 Sep all inside the run), from
 * its complete months: first day index, days, and the water year.
 */
export function completeWaterYears(startDate: string, blocks: readonly MonthBlock[]): { from: number; days: number; waterYear: number }[] {
	const d0 = toEpochDay(startDate);
	const out: { from: number; days: number; waterYear: number }[] = [];
	for (let i = 0; i + 11 < blocks.length; i++) {
		const b = blocks[i]!;
		if (b.month !== 10) continue;
		const last = blocks[i + 11]!;
		// Complete months are consecutive within a run, so October and the September eleven blocks on bound one water year.
		if (last.month === 9 && last.year === b.year + 1) out.push({ from: b.from, days: last.from + last.days - b.from, waterYear: waterYearOf(d0 + b.from) });
	}
	return out;
}

/**
 * The level, as a fraction of a high-flow component's peak, that bounds an
 * event (engine ≥ 1.9.0, docs/model.md §2.9d). A Reserve's freshet or flood
 * is a hydrograph: a peak (daily mean, m³/s) and an event duration from the
 * rise to the end of the recession, not days held at the peak. Taken as a
 * triangle of base `duration`, it spends `duration × (1 − level)` days at or
 * above `level × peak`, so a flow that has an event of that peak and duration
 * stays at or above half the peak for at least half the duration.
 */
export const EWR_HIGH_FLOW_EVENT_LEVEL = 0.5;

/**
 * A high-flow component whose peak the site's natural flow reaches in no
 * more than this share of the complete water years draws a warning (engine
 * ≥ 1.11.0, docs/model.md §2.9d): with required = MIN(perYear, natural
 * events), such a requirement is waived in most years and the check can
 * hardly fail. The usual cause is a gazetted peak entered as it is published,
 * an instantaneous peak (BBM manual, King, Tharme & de Villiers 2008, WRC TT
 * 354/08, §21.3), where the engine compares daily means. Half: a judgement,
 * pending the hydrologist.
 */
export const EWR_HIGH_FLOW_NATURAL_MIN_SHARE = 0.5;

/** Days a high-flow event must stay at or above `EWR_HIGH_FLOW_EVENT_LEVEL × peak`: ⌈duration × (1 − level)⌉, at least 1. */
export function highFlowEventMinDays(durationDays: number): number {
	return Math.max(1, Math.ceil(durationDays * (1 - EWR_HIGH_FLOW_EVENT_LEVEL) - 1e-9));
}

/**
 * Events of a high-flow component in days [from, from + days) of a daily
 * series (m³/day), engine ≥ 1.9.0: maximal runs of days with the daily mean
 * flow at or above `EWR_HIGH_FLOW_EVENT_LEVEL × peak` (m³/s; relative
 * tolerance 1e-9) that reach the peak on at least one day and last at least
 * `highFlowEventMinDays(durationDays)` days, counted in the month of their
 * first day at the peak, which must be one of `months`. Two peaks count as
 * two events only if the flow falls below the level between them. A run is
 * cut at the window's ends, so each water year counts its own events, and a
 * missing day breaks it. (Engines before 1.9.0 asked for `durationDays`
 * consecutive days all at the peak, which a natural storm hydrograph almost
 * never has.)
 */
export function countHighFlowEvents(
	flow: ArrayLike<number>,
	from: number,
	days: number,
	startDate: string,
	peakM3s: number,
	durationDays: number,
	months: readonly number[]
): number {
	const d0 = toEpochDay(startDate);
	const peak = peakM3s * SEC_PER_DAY * (1 - MET_TOLERANCE);
	const level = peakM3s * EWR_HIGH_FLOW_EVENT_LEVEL * SEC_PER_DAY * (1 - MET_TOLERANCE);
	const minDays = highFlowEventMinDays(durationDays);
	let count = 0;
	let runStart = -1;
	let peakDay = -1;
	const close = (end: number) => {
		if (runStart >= 0 && peakDay >= 0 && end - runStart >= minDays) {
			const m = new Date((d0 + peakDay) * SEC_PER_DAY * 1000).getUTCMonth() + 1;
			if (months.includes(m)) count++;
		}
		runStart = -1;
		peakDay = -1;
	};
	for (let t = from; t < from + days; t++) {
		const v = flow[t]!;
		if (Number.isFinite(v) && v >= level) {
			if (runStart < 0) runStart = t;
			if (peakDay < 0 && v >= peak) peakDay = t;
		} else close(t);
	}
	close(from + days);
	return count;
}

/** One high-flow component over the complete water years: required = MIN(perYear, natural events). */
function assessHighFlow(
	e: EwrHighFlowEvent,
	scale: number,
	startDate: string,
	blocks: readonly MonthBlock[],
	natural: ArrayLike<number>,
	impacted: ArrayLike<number>
): EwrHighFlowReport {
	const peak = e.peakM3s * scale;
	const years: EwrHighFlowYear[] = completeWaterYears(startDate, blocks).map((y) => {
		const n = countHighFlowEvents(natural, y.from, y.days, startDate, peak, e.durationDays, e.months);
		const a = countHighFlowEvents(impacted, y.from, y.days, startDate, peak, e.durationDays, e.months);
		const required = Math.min(e.perYear, n);
		return { waterYear: y.waterYear, natural: n, actual: a, required, met: a >= required };
	});
	const req = years.filter((y) => y.required > 0);
	const met = req.filter((y) => y.met).length;
	return {
		label: e.label,
		months: [...e.months],
		peakM3s: e.peakM3s,
		durationDays: e.durationDays,
		perYear: e.perYear,
		peakAppliedM3s: peak,
		years,
		overall: { years: years.length, required: req.length, met, rate: req.length ? met / req.length : null }
	};
}

/** Warnings a site's assessment carries (no complete month, calendar months missing, short records, a high flow natural flow rarely has, a natural MAR off the determination's). */
export function assuranceWarnings(r: EwrAssuranceSite): string[] {
	const where = `EWR rule table at ${r.isOutlet ? `the outlet (${r.name})` : r.name}`;
	if (r.overall.months === 0) return [`${where}: the run has no complete calendar month, so Reserve compliance is not assessed`];
	const out: string[] = [];
	const missing = r.byMonth.filter((m) => m.years === 0).map((m) => MONTH_NAMES[m.month - 1]);
	if (missing.length) out.push(`${where}: the run has no complete ${missing.join(', ')}, so ${missing.length === 1 ? 'that month is' : 'those months are'} not assessed`);
	const few = Math.min(...r.byMonth.filter((m) => m.years > 0).map((m) => m.years));
	if (few < EWR_ASSURANCE_MIN_YEARS) {
		const base = `${where}: some calendar months have only ${few} complete year${few === 1 ? '' : 's'} in the run (fewer than ${EWR_ASSURANCE_MIN_YEARS})`;
		out.push(
			r.naturalSource === 'run'
				? `${base}, so the natural-flow percentiles, and the flow duration check, rest on few years; enter the table's natural flows or run a longer record`
				: `${base}, so the flow duration check rests on few years`
		);
	}
	for (const h of r.highFlows ?? []) {
		const n = h.years.length;
		const withEvent = h.years.filter((y) => y.natural > 0).length;
		if (n > 0 && n - withEvent > n * EWR_HIGH_FLOW_NATURAL_MIN_SHARE) {
			out.push(
				`${where}: high flow "${h.label}": the site's natural flow reached its ${sig(h.peakAppliedM3s)} m³/s daily-mean peak for the duration in only ${withEvent} of ${n} water years, so the requirement is waived in the rest and the check can hardly fail; a gazette's flood peak is instantaneous, so enter the daily-mean peak it corresponds to (BBM manual, WRC TT 354/08, §21.3)`
			);
		}
	}
	const mar = r.naturalMar;
	if (r.naturalSource === 'run' && mar && naturalMarBeyondTolerance(mar.differencePct)) {
		const pct = Math.round(Math.abs(mar.differencePct));
		out.push(
			`${where}: the run's natural MAR at the site (${sig(mar.runMcm)} Mm³/a) is ${pct} % ${mar.differencePct > 0 ? 'above' : 'below'} the determination's (${sig(mar.tableMcm)} Mm³/a), beyond ±${100 * EWR_NATURAL_MAR_TOLERANCE} %; with the percentile from the run, the table's flows are judged against a natural flow ${mar.differencePct > 0 ? 'wetter' : 'drier'} than the one they were set for, so months pass or fail that the determination's own curve would not: check the calibration, or enter the table's natural flows`
		);
	}
	return out;
}

/** Three significant figures, for a warning. */
const sig = (v: number) => String(Number(v.toPrecision(3)));

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
