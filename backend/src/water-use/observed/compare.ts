// Observed vs modelled irrigation use (issue #623 step 5; docs/model.md
// § 2.10o Observed actual ET against the modelled irrigation use, docs/api.md
// § Observed actual ET).
//
// Pure: the route (./routes.ts) reads the rows and hands them here. The
// observed side is et_observation (276): per unit, source and dekad, the
// area-weighted mean actual ET (ETa, mm/day) over the unit's parcels (∩
// WorldCover cropland where loaded) and the share of that area with a valid
// pixel. The modelled side is the run's own output for the unit, summed over
// the dekad's days:
//  - the requirement: `gross_demand`, Σ planted area × crop factor × A-pan
//    (§2.3 steps 1–2, at least 0 a day), the crop's water use at full supply;
//  - effective rain: `effective_rain`, the part of that the model's rain (and
//    soil store) covered (§2.3 steps 3–4);
//  - irrigation reaching the crop: e × G, the share of `supplied` the crop
//    gets after the application losses (§2.7). With D = F ÷ e it is F × G ÷ D
//    each day, from `crop_requirement` (F), `supplied` (G) and `demand` (D),
//    each less the unit's demand objects (`object_demand@…`,
//    `object_supplied@…`), which aren't irrigation.
//  - crop ET as the run supplied it: effective rain + the irrigation reaching
//    the crop. Not the requirement: a dry dam, the drought restriction, an
//    allocation cap or a demand factor gives the crop less than it needs, and
//    the satellite sees what it used, not what it needed.
// Observed ETa (a depth) is put on the run's planted area, so the two sides are
// volumes over the same land: the planted area is what the model multiplies by.
// The observed area itself is reported beside it, as a separate check.
//
// It compares two things: observed ETa × area against the crop ET as the run supplied it,
// and observed (ETa × area − effective rain) against the irrigation reaching
// the crop. A disagreement points at the inputs (crops, areas, factors, the
// A-pan row, the efficiency), never at a correction: nothing here changes
// the engine or feeds a run, and the hydrologist decides.
import { toEpochDay } from '@water-management/engine';

/** et_observation.source. */
export type EtSource = 'wapor' | 'ssebop';

/** One et_observation row. */
export interface EtObservationIn {
	source: EtSource;
	/** The dekad's first day, YYYY-MM-DD (the 1st, 11th or 21st). */
	dekad: string;
	/** Mean actual ET over the valid part of the area, mm/day. */
	etaMmDay: number;
	/** The share of the area with a valid pixel, 0–1. */
	validShare: number;
	/** The area the mean covers, m². */
	areaM2: number;
	mask: 'cropland' | 'parcel';
}

/**
 * The thresholds, provisional (docs/model.md §2.10o says why each): change
 * them there and here together.
 */
export const ET_OBSERVED = {
	/** A dekad is compared only when at least this share of the area had a valid pixel (cloud, gaps). */
	minValidShare: 0.8,
	/** A pair agrees when the two volumes are within this share of the larger. */
	withinShare: 0.25,
	/** …or within this depth over the planted area for the dekad's days (mm/day): a dry winter dekad's few m³ aren't a 25 % question. */
	floorMmDay: 0.5,
	/** The observed area is flagged when it is outside this ratio of the planted area, either way. */
	areaRatio: 1.5
} as const;

/** Why a dekad wasn't compared. */
export type EtSkipReason =
	/** Under ET_OBSERVED.minValidShare of the area had a valid pixel. */
	| 'partly-seen'
	/** The run covers only part of the dekad (it starts or ends inside it, or its forecast starts inside it), or a day's value is missing. */
	| 'partial-dekad'
	/** The run doesn't reach the dekad, or the dekad is all forecast. */
	| 'outside-run'
	/** The unit plants nothing in the run: no area to put the depth on. */
	| 'no-area'
	/** No run, or the unit isn't in it. */
	| 'no-run'
	/** The run has the unit but not the columns compared (an older engine's run): run it again. */
	| 'no-series';

/** The run's daily series for the unit, from its first day. */
export interface ModelledIn {
	startDate: string;
	grossDemand: readonly (number | null)[];
	effectiveRain: readonly (number | null)[];
	cropRequirement: readonly (number | null)[];
	demand: readonly (number | null)[];
	supplied: readonly (number | null)[];
	/** Σ of the unit's demand objects' demand and supply per day (object_demand@…, object_supplied@…); absent with none. */
	objectDemand?: readonly (number | null)[];
	objectSupplied?: readonly (number | null)[];
}

export interface EtComparedPoint {
	source: EtSource;
	dekad: string;
	/** The dekad's last day, YYYY-MM-DD. */
	end: string;
	/** Days in the dekad (8–11). */
	days: number;
	etaMmDay: number;
	validShare: number;
	areaM2: number;
	mask: 'cropland' | 'parcel';
	/** Observed ETa × days × planted area (m³); null without a planted area. */
	observedEtM3: number | null;
	/** Σ (effective rain + irrigation reaching the crop) over the dekad (m³): the crop's ET as the run supplied it; null when the dekad isn't whole in the run. */
	modelledEtM3: number | null;
	/** Σ gross_demand (each day at least 0) over the dekad (m³): the requirement at full supply, for reference. */
	requirementM3: number | null;
	/** Σ effective_rain over the dekad (m³). */
	effectiveRainM3: number | null;
	/** max(0, observedEtM3 − effectiveRainM3) (m³): the ET the model's rain didn't cover. */
	observedIrrigationM3: number | null;
	/** Σ e × G over the dekad (m³): the irrigation water the run delivered to the crop. */
	modelledIrrigationM3: number | null;
	/** Σ irrigation supplied (G, abstraction before losses) over the dekad (m³), for reference. */
	suppliedM3: number | null;
	compared: boolean;
	skip: EtSkipReason | null;
	/** Only on compared points: the pair within the band (ET_OBSERVED.withinShare, floorMmDay). */
	etWithin: boolean | null;
	irrigationWithin: boolean | null;
}

/** Sums and agreement over a set of compared dekads. */
export interface EtTotals {
	/** Dekads compared. */
	compared: number;
	/** Dekads observed but not compared. */
	skipped: number;
	observedEtM3: number;
	modelledEtM3: number;
	observedIrrigationM3: number;
	modelledIrrigationM3: number;
	/** (Σ modelled − Σ observed) ÷ Σ observed × 100: + means the model uses more. null with nothing compared or nothing observed. */
	etBiasPct: number | null;
	irrigationBiasPct: number | null;
	/** Share of the compared dekads within the band, 0–1; null with none. */
	etWithinShare: number | null;
	irrigationWithinShare: number | null;
}

/** A half of a water year: summer Oct–Mar (the irrigation season), winter Apr–Sep. */
export interface EtSeason extends EtTotals {
	/** The water year it falls in, by its first calendar year (Oct 2019–Sep 2020 is 2019). */
	waterYear: number;
	half: 'summer' | 'winter';
	/** e.g. "Oct 2019 – Mar 2020". */
	label: string;
}

export interface EtCompareInput {
	observations: readonly EtObservationIn[];
	/** The run's series for the unit, or null with no run (or the unit not in it). */
	modelled: ModelledIn | null;
	/** The run has the unit but lacks the columns (an older engine): every dekad is `no-series`. */
	seriesMissing?: boolean;
	/** The run's first forecast day, when it is a forecast run: days from it on aren't compared. */
	forecastFrom?: string | null;
	/** Σ the unit's planted areas in the run's model (m²); null with no run. */
	plantedAreaM2: number | null;
}

export interface EtSourceResult {
	source: EtSource;
	/** The newest dekad's area and mask, and its ratio to the planted area (null without one). */
	area: { areaM2: number; mask: 'cropland' | 'parcel'; ratioToPlanted: number | null; differs: boolean } | null;
	/** Oldest first. */
	points: EtComparedPoint[];
	/** Oldest first; only halves with an observed dekad. */
	seasons: EtSeason[];
	summary: EtTotals;
}

export interface EtCompareResult {
	sources: EtSourceResult[];
}

const SOURCES: readonly EtSource[] = ['wapor', 'ssebop'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The dekad's last day and length, from its first day (string arithmetic in UTC, whatever the process's zone). */
export function dekadSpan(dekad: string): { end: string; days: number } {
	const y = Number(dekad.slice(0, 4));
	const m = Number(dekad.slice(5, 7));
	const d = Number(dekad.slice(8, 10));
	if (d !== 1 && d !== 11 && d !== 21) throw new RangeError(`not a dekad's first day: ${dekad}`);
	const last = d === 21 ? new Date(Date.UTC(y, m, 0)).getUTCDate() : d + 9;
	return { end: `${dekad.slice(0, 8)}${String(last).padStart(2, '0')}`, days: last - d + 1 };
}

/** The half water year a dekad falls in. */
export function seasonOf(dekad: string): { waterYear: number; half: 'summer' | 'winter'; label: string } {
	const y = Number(dekad.slice(0, 4));
	const m = Number(dekad.slice(5, 7));
	const waterYear = m >= 10 ? y : y - 1;
	const half = m >= 10 || m <= 3 ? 'summer' : 'winter';
	const label = half === 'summer' ? `${MONTHS[9]} ${waterYear} – ${MONTHS[2]} ${waterYear + 1}` : `${MONTHS[3]} ${waterYear + 1} – ${MONTHS[8]} ${waterYear + 1}`;
	return { waterYear, half, label };
}

/** Whether a pair agrees: within withinShare of the larger, or within the depth floor over the area for the days. */
export function within(observed: number, modelled: number, areaM2: number, days: number): boolean {
	const d = Math.abs(modelled - observed);
	return d <= ET_OBSERVED.withinShare * Math.max(Math.abs(observed), Math.abs(modelled)) || d <= (ET_OBSERVED.floorMmDay * days * areaM2) / 1000;
}

/** Σ over [lo, hi) of a series; null when a day is missing (not finite). */
function sum(values: readonly (number | null)[] | undefined, lo: number, hi: number): number | null {
	if (!values) return 0;
	let s = 0;
	for (let i = lo; i < hi; i++) {
		const v = values[i];
		if (!finite(v)) return null;
		s += v;
	}
	return s;
}

/** Σ max(0, v) over [lo, hi): the engine clamps a negative gross (a bad crop factor) to no need; null when a day is missing. */
function sumPositive(values: readonly (number | null)[], lo: number, hi: number): number | null {
	let s = 0;
	for (let i = lo; i < hi; i++) {
		const v = values[i];
		if (!finite(v)) return null;
		s += Math.max(0, v);
	}
	return s;
}

/** Σ e × G over [lo, hi): each day F × G ÷ D, irrigation only (demand objects taken off); null when a day is missing. */
function cropUse(m: ModelledIn, lo: number, hi: number): number | null {
	let s = 0;
	for (let i = lo; i < hi; i++) {
		const F = m.cropRequirement[i];
		const D0 = m.demand[i];
		const G0 = m.supplied[i];
		if (!finite(F) || !finite(D0) || !finite(G0)) return null;
		const od = m.objectDemand ? m.objectDemand[i] : 0;
		const os = m.objectSupplied ? m.objectSupplied[i] : 0;
		if (!finite(od) || !finite(os)) return null;
		const D = D0 - od;
		const G = G0 - os;
		if (D > 0 && F > 0) s += F * Math.min(1, Math.max(0, G / D));
	}
	return s;
}

/**
 * Pair each source's dekads with the run's output for the unit and flag them.
 * Each source is compared on its own (they are different products); points
 * come back oldest first, each saying whether it was compared and why not.
 */
export function compareEt(input: EtCompareInput): EtCompareResult {
	const m = input.modelled;
	const A = input.plantedAreaM2;
	const start = m ? toEpochDay(m.startDate) : 0;
	const length = m ? m.grossDemand.length : 0;
	// The run's last day it may compare: the day before the forecast, else its last day.
	const forecastIdx = m && input.forecastFrom ? toEpochDay(input.forecastFrom) - start : Infinity;
	const usable = Math.min(length, forecastIdx);

	const sources: EtSourceResult[] = [];
	for (const source of SOURCES) {
		const rows = input.observations.filter((o) => o.source === source).sort((a, b) => (a.dekad < b.dekad ? -1 : a.dekad > b.dekad ? 1 : 0));
		if (!rows.length) continue;
		const points: EtComparedPoint[] = rows.map((o) => {
			const { end, days } = dekadSpan(o.dekad);
			const lo = toEpochDay(o.dekad) - start;
			const hi = lo + days;
			const whole = !!m && lo >= 0 && hi <= usable;
			const overlaps = !!m && hi > 0 && lo < usable;
			const requirement = whole ? sumPositive(m!.grossDemand, lo, hi) : null;
			const rain = whole ? sum(m!.effectiveRain, lo, hi) : null;
			const irr = whole ? cropUse(m!, lo, hi) : null;
			const modelledEt = rain !== null && irr !== null ? rain + irr : null;
			const supplied = whole ? sum(m!.supplied, lo, hi) : null;
			const objects = whole ? sum(m!.objectSupplied, lo, hi) : null;
			const suppliedIrr = supplied !== null && objects !== null ? supplied - objects : null;
			// mm/day × days × m² ÷ 1000 mm/m = m³.
			const observedEt = finite(A) && A > 0 ? (o.etaMmDay * days * A) / 1000 : null;
			const observedIrr = observedEt !== null && rain !== null ? Math.max(0, observedEt - rain) : null;
			const missing = whole && (requirement === null || modelledEt === null);
			let skip: EtSkipReason | null = null;
			if (o.validShare < ET_OBSERVED.minValidShare) skip = 'partly-seen';
			else if (input.seriesMissing) skip = 'no-series';
			else if (!m) skip = 'no-run';
			else if (!(finite(A) && A > 0)) skip = 'no-area';
			else if (!overlaps) skip = 'outside-run';
			else if (!whole || missing) skip = 'partial-dekad';
			const compared = skip === null;
			return {
				source,
				dekad: o.dekad,
				end,
				days,
				etaMmDay: o.etaMmDay,
				validShare: o.validShare,
				areaM2: o.areaM2,
				mask: o.mask,
				observedEtM3: observedEt,
				modelledEtM3: modelledEt,
				requirementM3: requirement,
				effectiveRainM3: rain,
				observedIrrigationM3: observedIrr,
				modelledIrrigationM3: irr,
				suppliedM3: suppliedIrr,
				compared,
				skip,
				etWithin: compared ? within(observedEt!, modelledEt!, A!, days) : null,
				irrigationWithin: compared ? within(observedIrr!, irr!, A!, days) : null
			};
		});
		const seasons = new Map<string, { s: ReturnType<typeof seasonOf>; points: EtComparedPoint[] }>();
		for (const p of points) {
			const s = seasonOf(p.dekad);
			const k = `${s.waterYear}|${s.half === 'summer' ? 0 : 1}`;
			const g = seasons.get(k);
			if (g) g.points.push(p);
			else seasons.set(k, { s, points: [p] });
		}
		const newest = rows.at(-1)!;
		const ratio = finite(A) && A > 0 ? newest.areaM2 / A : null;
		sources.push({
			source,
			area: {
				areaM2: newest.areaM2,
				mask: newest.mask,
				ratioToPlanted: ratio,
				differs: ratio !== null && (ratio > ET_OBSERVED.areaRatio || ratio < 1 / ET_OBSERVED.areaRatio)
			},
			points,
			seasons: [...seasons.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([, g]) => ({ ...g.s, ...totals(g.points) })),
			summary: totals(points)
		});
	}
	return { sources };
}

/** The sums, biases and agreement shares of a set of points (only the compared ones count). */
export function totals(points: readonly EtComparedPoint[]): EtTotals {
	const c = points.filter((p) => p.compared);
	const n = c.length;
	const add = (f: (p: EtComparedPoint) => number | null) => c.reduce((s, p) => s + (f(p) ?? 0), 0);
	const observedEtM3 = add((p) => p.observedEtM3);
	const modelledEtM3 = add((p) => p.modelledEtM3);
	const observedIrrigationM3 = add((p) => p.observedIrrigationM3);
	const modelledIrrigationM3 = add((p) => p.modelledIrrigationM3);
	const bias = (mod: number, obs: number) => (n && obs > 0 ? ((mod - obs) / obs) * 100 : null);
	return {
		compared: n,
		skipped: points.length - n,
		observedEtM3,
		modelledEtM3,
		observedIrrigationM3,
		modelledIrrigationM3,
		etBiasPct: bias(modelledEtM3, observedEtM3),
		irrigationBiasPct: bias(modelledIrrigationM3, observedIrrigationM3),
		etWithinShare: n ? c.filter((p) => p.etWithin).length / n : null,
		irrigationWithinShare: n ? c.filter((p) => p.irrigationWithin).length / n : null
	};
}
