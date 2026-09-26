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
import type { EwrHighFlowEvent, EwrNaturalSource, EwrRuleComponent, EwrRuleTable, EwrRuleUnit } from './rules';

const SEC_PER_DAY = 86_400;
/** Years of a calendar month below which the run's natural-flow percentiles are coarse. */
export const EWR_ASSURANCE_MIN_YEARS = 10;
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

/** m³ over a month of `days` days → the table's unit, and back. */
const toUnit = (m3: number, days: number, unit: EwrRuleUnit) => (unit === 'mcm' ? m3 / 1e6 : m3 / (days * SEC_PER_DAY));
const toM3 = (v: number, days: number, unit: EwrRuleUnit) => (unit === 'mcm' ? v * 1e6 : v * days * SEC_PER_DAY);

/**
 * Assess one site. Also returns the requirement as a daily series (m³/day:
 * R's volume ÷ the month's days; NaN outside complete months), for charts and
 * the daily CSV.
 */
export function assessSite(startDate: string, days: number, site: EwrAssuranceInput): { report: EwrAssuranceSite; requiredM3Day: Float64Array } {
	const { table } = site;
	const unit = table.unit;
	const P = table.points;
	const blocks = completeMonths(startDate, days);
	const requiredM3Day = new Float64Array(days).fill(NaN);
	const d0 = toEpochDay(startDate);

	// Per complete month, natural and impacted in the table's unit.
	const rows = blocks.map((b) => {
		let nat = 0;
		let imp = 0;
		for (let t = b.from; t < b.from + b.days; t++) {
			const n = site.natural[t]!;
			const a = site.impacted[t]!;
			nat += Number.isFinite(n) ? n : 0;
			imp += Number.isFinite(a) ? a : 0;
		}
		return { ...b, w: waterYearIndex(b.month), natural: toUnit(nat, b.days, unit), actual: toUnit(imp, b.days, unit) };
	});

	const byW = Array.from({ length: 12 }, (_, w) => rows.filter((r) => r.w === w));
	const curves = byW.map((list, w) => {
		const ewr = table.ewr[w]!.map((v) => v * table.scale);
		const low = table.lowFlow ? table.lowFlow[w]!.map((v) => v * table.scale) : null;
		const natural =
			table.naturalSource === 'table'
				? runningMin(table.natural![w]!.map((v) => v * table.scale))
				: list.length
					? runningMin(P.map((p) => durationQuantile(list.map((r) => r.natural), p)!))
					: null;
		return { ewr, natural, low };
	});

	const months: EwrAssuranceMonth[] = rows.map((r) => {
		const c = curves[r.w]!;
		const look = lookupRequirement(r.natural, P, c.natural!, c.ewr);
		const met = isMet(r.actual, look.required);
		const deficitM3 = met ? 0 : toM3(look.required - r.actual, r.days, unit);
		const reqM3Day = toM3(look.required, r.days, unit) / r.days;
		for (let t = r.from; t < r.from + r.days; t++) requiredM3Day[t] = reqM3Day;
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
		if (c.low) {
			// The same natural curve, so the same point and interpolation weight as the total.
			const low = lookupRequirement(r.natural, P, c.natural!, c.low).required;
			month.requiredLowFlow = low;
			month.lowFlowMet = isMet(r.actual, low);
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
	const met = months.filter((m) => m.met).length;
	const cells = byMonth.flatMap((m) => m.fdc.filter((f) => f.met !== null));
	const cellsMet = cells.filter((f) => f.met).length;

	const report: EwrAssuranceSite = {
		nodeId: site.nodeId,
		name: site.name,
		isOutlet: site.isOutlet,
		source: table.source,
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
			meanShortfallPct: short.length ? (100 * short.reduce((s, m) => s + (m.required - m.actual) / m.required, 0)) / short.length : null
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
			deficitM3: months.reduce((s, m) => s + (m.lowFlowMet ? 0 : toM3(m.requiredLowFlow! - m.actual, m.days, unit)), 0),
			longestNotMetRun: longestRun(months.map((m) => m.lowFlowMet!))
		};
	}
	if (table.highFlows?.length) {
		report.highFlows = table.highFlows.map((e) => assessHighFlow(e, table.scale, startDate, blocks, site.natural, site.impacted));
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
 * Events of a high-flow component in days [from, from + days) of a daily
 * series (m³/day): maximal runs of days with the mean flow at or above the
 * peak (m³/s; relative tolerance 1e-9), at least `durationDays` long, whose
 * first day falls in one of `months`. A run is cut at the window's ends, so
 * each water year counts its own events.
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
	const threshold = peakM3s * SEC_PER_DAY * (1 - MET_TOLERANCE);
	let count = 0;
	let runStart = -1;
	const close = (end: number) => {
		if (runStart >= 0 && end - runStart >= durationDays) {
			const m = new Date((d0 + runStart) * SEC_PER_DAY * 1000).getUTCMonth() + 1;
			if (months.includes(m)) count++;
		}
		runStart = -1;
	};
	for (let t = from; t < from + days; t++) {
		const v = flow[t]!;
		if (Number.isFinite(v) && v >= threshold) {
			if (runStart < 0) runStart = t;
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

/** Warnings a site's assessment carries (no complete month, calendar months missing, short records). */
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
	return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
