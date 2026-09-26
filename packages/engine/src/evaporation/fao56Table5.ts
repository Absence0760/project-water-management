// FAO-56 Table 5: Class A pan coefficient Kp (issue #39, proposal point 2).
//
// Source: Allen, R.G., Pereira, L.S., Raes, D. & Smith, M. (1998). Crop
// evapotranspiration: guidelines for computing crop water requirements. FAO
// Irrigation and Drainage Paper 56, chapter 4, Table 5 ("Pan coefficients (Kp)
// for Class A pan for different pan siting and environment and different
// levels of mean relative humidity and wind speed", itself from FAO Irrigation
// and Drainage Paper No. 24). https://www.fao.org/4/x0490e/x0490e08.htm
//
// A helper only: it suggests a monthly Kp for the Settings form, which the user
// then owns. Nothing here constrains how Kp may change from month to month —
// Table 5 itself moves with wind and humidity, which both change with the season.
//
// Choices (docs/model.md §2.4a):
// - Class boundaries follow the table's wording: RH "low < 40", "medium 40 - 70",
//   "high > 70", so 40 % and 70 % are both medium. Wind "light < 2", "moderate
//   2-5", "strong 5-8", "very strong > 8" (m/s at 2 m): 2 is moderate; the
//   shared endpoints 5 and 8 fall in the lower class (5 is moderate, 8 is
//   strong), matching how the RH ranges close at both ends and how "> 8" leaves
//   8 itself to "strong".
// - Fetch is NOT interpolated. Table 5 tabulates four discrete windward
//   distances (1, 10, 100, 1000 m); anything else is rejected, so every value
//   the helper suggests is a cell of the published table. (FAO-56 Table 7 gives
//   regression equations in ln(fetch) for a continuous fetch; those are a fitted
//   approximation of the table, not the table, and are not used here.)
// - FAO-56's bare-surroundings adjustment ("In areas with no agricultural
//   development and extensive areas of bare soils (large fetch, Case B), as
//   found under desert or semi-desert conditions, the listed values for Kp given
//   for arid, windy areas may need to be reduced by up to 20%; for areas with
//   moderate levels of wind, temperature and relative humidity, the listed
//   values may need to be reduced by 5-10%; no or little reduction in Kp is
//   needed in humid, cool conditions.") is a stated `reductionPct` (0–20),
//   never applied unless given, and reported in the result.

import type { Monthly } from '../calendar';

export type PanSiting = 'A' | 'B';
export type RhClass = 'low' | 'medium' | 'high';
export type WindClass = 'light' | 'moderate' | 'strong' | 'veryStrong';
export type Fao56Fetch = 1 | 10 | 100 | 1000;

export const FAO56_TABLE5_SOURCE =
	'FAO-56 (Allen et al. 1998, FAO Irrigation and Drainage Paper 56), chapter 4, Table 5: https://www.fao.org/4/x0490e/x0490e08.htm';

/** The windward distances Table 5 tabulates (m): green crop for Case A, dry fallow for Case B. */
export const FAO56_FETCHES: readonly Fao56Fetch[] = [1, 10, 100, 1000];
export const FAO56_RH_CLASSES: readonly RhClass[] = ['low', 'medium', 'high'];
export const FAO56_WIND_CLASSES: readonly WindClass[] = ['light', 'moderate', 'strong', 'veryStrong'];
/** FAO-56's largest suggested reduction for bare, arid, windy surroundings (%). */
export const FAO56_MAX_REDUCTION_PCT = 20;

export const FAO56_SITING_LABELS: Record<PanSiting, string> = {
	A: 'Case A: pan placed in short green cropped area',
	B: 'Case B: pan placed in dry fallow area'
};
export const FAO56_RH_LABELS: Record<RhClass, string> = { low: 'low (< 40 %)', medium: 'medium (40–70 %)', high: 'high (> 70 %)' };
export const FAO56_WIND_LABELS: Record<WindClass, string> = {
	light: 'light (< 2 m/s)',
	moderate: 'moderate (2–5 m/s)',
	strong: 'strong (5–8 m/s)',
	veryStrong: 'very strong (> 8 m/s)'
};
export const FAO56_REDUCTION_GUIDANCE =
	'FAO-56: in areas with no agricultural development and extensive bare soils (large fetch, Case B), Kp for arid, windy areas may need reducing by up to 20 %; 5–10 % for moderate wind, temperature and humidity; little or none in humid, cool conditions.';

/** Rows: wind class; within each, fetch 1, 10, 100, 1000 m; columns RH low, medium, high. */
type Block = Record<WindClass, readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]]>;

/** FAO-56 Table 5, transcribed cell for cell. */
export const FAO56_TABLE5: Record<PanSiting, Block> = {
	A: {
		light: [[0.55, 0.65, 0.75], [0.65, 0.75, 0.85], [0.7, 0.8, 0.85], [0.75, 0.85, 0.85]],
		moderate: [[0.5, 0.6, 0.65], [0.6, 0.7, 0.75], [0.65, 0.75, 0.8], [0.7, 0.8, 0.8]],
		strong: [[0.45, 0.5, 0.6], [0.55, 0.6, 0.65], [0.6, 0.65, 0.7], [0.65, 0.7, 0.75]],
		veryStrong: [[0.4, 0.45, 0.5], [0.45, 0.55, 0.6], [0.5, 0.6, 0.65], [0.55, 0.6, 0.65]]
	},
	B: {
		light: [[0.7, 0.8, 0.85], [0.6, 0.7, 0.8], [0.55, 0.65, 0.75], [0.5, 0.6, 0.7]],
		moderate: [[0.65, 0.75, 0.8], [0.55, 0.65, 0.7], [0.5, 0.6, 0.65], [0.45, 0.55, 0.6]],
		strong: [[0.6, 0.65, 0.7], [0.5, 0.55, 0.65], [0.45, 0.5, 0.6], [0.4, 0.45, 0.55]],
		veryStrong: [[0.5, 0.6, 0.65], [0.45, 0.5, 0.55], [0.4, 0.45, 0.5], [0.35, 0.4, 0.45]]
	}
};

function finite(name: string, v: number): void {
	if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`${name} must be a finite number, got ${v}`);
}

/** RH class per Table 5: < 40 low, 40–70 (both ends included) medium, > 70 high. */
export function fao56RhClass(rhPct: number): RhClass {
	finite('mean relative humidity', rhPct);
	if (rhPct < 0 || rhPct > 100) throw new RangeError(`mean relative humidity must be 0–100 %, got ${rhPct}`);
	if (rhPct < 40) return 'low';
	if (rhPct <= 70) return 'medium';
	return 'high';
}

/** Wind class per Table 5 (m/s at 2 m): < 2 light, 2–5 moderate, over 5 to 8 strong, > 8 very strong. */
export function fao56WindClass(windMs: number): WindClass {
	finite('wind speed', windMs);
	if (windMs < 0) throw new RangeError(`wind speed must be ≥ 0 m/s, got ${windMs}`);
	if (windMs < 2) return 'light';
	if (windMs <= 5) return 'moderate';
	if (windMs <= 8) return 'strong';
	return 'veryStrong';
}

function checkSiting(siting: PanSiting): void {
	if (siting !== 'A' && siting !== 'B') throw new RangeError(`siting must be 'A' or 'B', got ${String(siting)}`);
}

function checkFetch(fetchM: number): asserts fetchM is Fao56Fetch {
	if (!(FAO56_FETCHES as readonly number[]).includes(fetchM)) {
		throw new RangeError(`fetch must be one of Table 5's distances (${FAO56_FETCHES.join(', ')} m), got ${fetchM}`);
	}
}

function checkReduction(pct: number): void {
	finite('reduction', pct);
	if (pct < 0 || pct > FAO56_MAX_REDUCTION_PCT) throw new RangeError(`reduction must be 0–${FAO56_MAX_REDUCTION_PCT} %, got ${pct}`);
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export type Fao56KpInput = {
	siting: PanSiting;
	/** Mean relative humidity, % (0–100). */
	rhPct: number;
	/** Mean wind speed at 2 m, m/s (≥ 0). */
	windMs: number;
	/** Windward fetch, m: green crop (Case A) or dry fallow (Case B). One of 1, 10, 100, 1000. */
	fetchM: number;
	/** Stated FAO-56 bare-surroundings reduction, % (0–20). Default 0. */
	reductionPct?: number;
};

export type Fao56KpResult = {
	/** Suggested Kp: the table cell × (1 − reductionPct / 100). */
	kp: number;
	/** The Table 5 cell before any reduction. */
	tableKp: number;
	reductionPct: number;
	cell: { siting: PanSiting; rhClass: RhClass; windClass: WindClass; fetchM: Fao56Fetch };
	/** One line saying where the value came from, including any reduction. */
	note: string;
};

/** Class A pan Kp from FAO-56 Table 5. Throws RangeError on invalid input. */
export function fao56Kp(input: Fao56KpInput): Fao56KpResult {
	const { siting, rhPct, windMs, fetchM } = input;
	const reductionPct = input.reductionPct ?? 0;
	checkSiting(siting);
	const rhClass = fao56RhClass(rhPct);
	const windClass = fao56WindClass(windMs);
	checkFetch(fetchM);
	checkReduction(reductionPct);
	const tableKp = FAO56_TABLE5[siting][windClass][FAO56_FETCHES.indexOf(fetchM)]![FAO56_RH_CLASSES.indexOf(rhClass)]!;
	const kp = round4(tableKp * (1 - reductionPct / 100));
	const surround = siting === 'A' ? 'green crop' : 'dry fallow';
	let note = `FAO-56 Table 5, Case ${siting}, RH ${FAO56_RH_LABELS[rhClass]}, wind ${FAO56_WIND_LABELS[windClass]}, ${fetchM} m ${surround} fetch: Kp ${tableKp}`;
	if (reductionPct > 0) note += `, reduced by ${reductionPct} % to ${kp}`;
	return { kp, tableKp, reductionPct, cell: { siting, rhClass, windClass, fetchM }, note };
}

/**
 * Monthly Kp for the 12 water-year months (index 0 = Oct … 11 = Sep), one
 * Table 5 lookup per month from that month's mean RH and wind. The same siting,
 * fetch and reduction apply to every month. Throws on invalid input.
 */
export function fao56KpMonthly(
	months: ReadonlyArray<{ rhPct: number; windMs: number }>,
	siting: PanSiting,
	fetchM: number,
	reductionPct = 0
): Monthly {
	if (months.length !== 12) throw new RangeError(`need 12 water-year months (Oct–Sep), got ${months.length}`);
	return months.map((m) => fao56Kp({ siting, rhPct: m.rhPct, windMs: m.windMs, fetchM, reductionPct }).kp) as unknown as Monthly;
}
