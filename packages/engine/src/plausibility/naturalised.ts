// Natural flow ≥ observed flow + net abstraction, per water year (engine ≥
// 0.25.0, docs/model.md §2.10d, issue #4 phase 6 plausibility check 1).
//
// A gauge or logger at the outlet measures the impacted river. Adding back
// what the network took out upstream (naturalisation: the use, net of return
// flows; the water the dams stored and lost to evaporation; the land-cover
// reduction) rebuilds the natural flow the record implies. That can't exceed
// the natural flow the rain model simulates, beyond measurement error: a year
// where it does points to natural flow simulated too low (rain under-read,
// parameters), abstraction over-estimated, or a problem in the record.
//
// The modelled net abstraction A is taken from the network's own water
// balance: A = N − S, natural flow less the simulated outflow, on each day
// with an observation, split into dams (storage gained + evaporation − rain on
// the dam surface), land cover, and the rest, which is the use net of return
// flows (irrigation, other users, stream depletion by boreholes, and flow from
// any node that doesn't drain to the outlet). With that A the test
// N ≥ O + A − tolerance is the same as S ≥ O − tolerance: the simulated
// outflow's annual volume can't fall short of the observed beyond the
// gauge's error. It is reported in the naturalised form so the split shows
// which term would have to be wrong.
//
// Tolerance: 10 % of the year's observed volume. Rated South African
// gauging weirs are good to about ±5 % in their gauged range (Wessels &
// Rooseboom 2009), but a year's volume also carries extrapolated floods and
// low flows where the error is larger; published reviews put annual-volume
// uncertainty at about 10 % for a well-rated station (McMillan, Krueger &
// Freer 2012). A floor of 1 % of the record's mean volume over the same
// number of days keeps a near-dry year, whose volume is tiny, from failing on
// a few hundred cubic metres.
import type { CalibrationFlowKind } from '../project';
import { isFlow } from './season';
import { waterYearLabel as wyLabel, waterYearOf } from '../calendar';
import { amount } from './format';

const SEC_PER_DAY = 86_400;
const M3_PER_MM3 = 1e6;

/** A water year is judged with this many observed days (both seasons, as the double-mass checks require). */
export const NATURALISED_MIN_DAYS = 300;
/** Allowed shortfall: this share of the year's observed volume … */
export const NATURALISED_TOLERANCE = 0.1;
/** … and at least this share of the record's mean observed volume over the same number of days. */
export const NATURALISED_FLOOR = 0.01;

export interface NaturalisedYear {
	/** Water year, by the calendar year it starts in. */
	waterYear: number;
	/** Days with an observation (the volumes are over these days only). */
	days: number;
	/** Judged: at least NATURALISED_MIN_DAYS days. */
	judged: boolean;
	/** N: simulated natural flow, Mm³. */
	naturalMm3: number;
	/** O: observed (impacted) flow, Mm³. */
	observedMm3: number;
	/** A = N − S: modelled net abstraction upstream, Mm³ … */
	abstractionMm3: number;
	/** … of which dams: storage gained + evaporation − rain on the dam surface … */
	damsMm3: number;
	/** … land-cover reduction … */
	landCoverMm3: number;
	/** … and use net of return flows (the rest). */
	useMm3: number;
	/** O + A: the natural flow the record implies. */
	naturalisedMm3: number;
	/** O + A − N (= O − S): > 0 when the record implies more natural flow than simulated. */
	gapMm3: number;
	/** gap ÷ N × 100; null when N = 0. */
	gapPct: number | null;
	toleranceMm3: number;
	/** gap ≤ tolerance; null when not judged. */
	passed: boolean | null;
}

export interface NaturalisedCheck {
	/** The observed record checked: the one the run calibrates against. */
	flowKind: CalibrationFlowKind;
	tolerance: number;
	floor: number;
	minDays: number;
	/** Every water year with an observed day, in order. */
	years: NaturalisedYear[];
	judgedYears: number;
	/** Judged water years that fail. */
	failedYears: number[];
}

export interface NaturalisedInput {
	flowKind: CalibrationFlowKind;
	/** Epoch day of run day 0. */
	start: number;
	naturalM3Day: ArrayLike<number>;
	simulatedM3Day: ArrayLike<number>;
	/** Observed m³/s (null = missing). */
	observedM3s: ArrayLike<number | null>;
	/** Per day: Σ over dams of (storage − storage the day before) + evaporation − rain on the surface, m³. */
	damsM3Day: ArrayLike<number>;
	/** Per day: land-cover reduction, m³ (empty without land cover). */
	landCoverM3Day: ArrayLike<number>;
	/** 1 on days the calibration exclusions leave out. */
	excluded: Uint8Array;
}

/** The check per water year; null when no day has an observation. */
export function naturalisedCheck(x: NaturalisedInput): NaturalisedCheck | null {
	const days = x.naturalM3Day.length;
	const byYear = new Map<number, { days: number; n: number; s: number; o: number; dams: number; lc: number }>();
	for (let t = 0; t < days; t++) {
		const o = x.observedM3s[t];
		if (!isFlow(o) || x.excluded[t]) continue;
		const wy = waterYearOf(x.start + t);
		let y = byYear.get(wy);
		if (!y) byYear.set(wy, (y = { days: 0, n: 0, s: 0, o: 0, dams: 0, lc: 0 }));
		y.days++;
		y.n += x.naturalM3Day[t]!;
		y.s += x.simulatedM3Day[t]!;
		y.o += o * SEC_PER_DAY;
		y.dams += x.damsM3Day[t]!;
		y.lc += x.landCoverM3Day[t] ?? 0;
	}
	if (!byYear.size) return null;
	const all = [...byYear.entries()].sort(([a], [b]) => a - b);
	let totalO = 0;
	let totalDays = 0;
	for (const [, y] of all) {
		totalO += y.o;
		totalDays += y.days;
	}
	const meanDaily = totalO / totalDays;
	const years: NaturalisedYear[] = all.map(([waterYear, y]) => {
		const a = y.n - y.s;
		const gap = y.o - y.s;
		const tol = Math.max(NATURALISED_TOLERANCE * y.o, NATURALISED_FLOOR * meanDaily * y.days);
		const judged = y.days >= NATURALISED_MIN_DAYS;
		return {
			waterYear,
			days: y.days,
			judged,
			naturalMm3: y.n / M3_PER_MM3,
			observedMm3: y.o / M3_PER_MM3,
			abstractionMm3: a / M3_PER_MM3,
			damsMm3: y.dams / M3_PER_MM3,
			landCoverMm3: y.lc / M3_PER_MM3,
			useMm3: (a - y.dams - y.lc) / M3_PER_MM3,
			naturalisedMm3: (y.o + a) / M3_PER_MM3,
			gapMm3: gap / M3_PER_MM3,
			gapPct: y.n > 0 ? (gap / y.n) * 100 : null,
			toleranceMm3: tol / M3_PER_MM3,
			passed: judged ? gap <= tol : null
		};
	});
	const judged = years.filter((y) => y.judged);
	return {
		flowKind: x.flowKind,
		tolerance: NATURALISED_TOLERANCE,
		floor: NATURALISED_FLOOR,
		minDays: NATURALISED_MIN_DAYS,
		years,
		judgedYears: judged.length,
		failedYears: judged.filter((y) => y.passed === false).map((y) => y.waterYear)
	};
}

const RECORD: Record<CalibrationFlowKind, string> = { flow_observed_m3s: 'observed gauge', flow_logger_m3s: 'logger' };

/** The run warning for the failing years, or null. */
export function naturalisedWarning(c: NaturalisedCheck | null): string | null {
	if (!c || !c.failedYears.length) return null;
	const failed = c.years.filter((y) => y.passed === false);
	// Worst: the gap furthest beyond its own tolerance.
	const over = (y: NaturalisedYear) => (y.toleranceMm3 > 0 ? y.gapMm3 / y.toleranceMm3 : Infinity);
	const worst = failed.reduce((w, y) => (over(y) > over(w) ? y : w), failed[0]!);
	const list = failed.map((y) => wyLabel(y.waterYear)).join(', ');
	return (
		`Natural flow below observed + abstraction in ${failed.length} of ${c.judgedYears} water years (${list}): ` +
		`the ${RECORD[c.flowKind]} record plus the modelled net abstraction upstream implies more natural flow than the model simulates, ` +
		`beyond the ${Math.round(c.tolerance * 100)} % allowed for gauging error (worst ${wyLabel(worst.waterYear)}: ` +
		`${amount(worst.naturalisedMm3, 2)} Mm³ implied against ${amount(worst.naturalMm3, 2)} Mm³ simulated). ` +
		'Natural flow may be simulated too low (rain, parameters), abstraction over-estimated, or the record wrong in those years. ' +
		'The Plausibility checks panel splits the abstraction into use, dams and land cover.'
	);
}
