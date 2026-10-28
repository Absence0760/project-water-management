// The seasonal outlook conditioned on the climate state (issue #620 step 4,
// docs/model.md §2.15c): of the ESP analogue years (./outlook.ts
// outlookAnalogues), the k whose ENSO and SAM state in the months before
// their season was nearest this season's, summarised on their own beside the
// unconditioned ESP.
//
// The state: two monthly indices from NOAA CPC (docs/data-sources.md
// § climate-indices), copied by the fetcher's indices pass
// (backend/src/ingest/indices.ts):
//   ONI  the Oceanic Niño Index, a 3-month running mean of the Niño 3.4 SST
//        anomaly, kept under its centre month (JAS → August). Already a
//        3-month mean, so one value: the newest season wholly before the
//        decision date (a 1 October decision reads JAS, centred on August).
//   AAO  CPC's Antarctic Oscillation, the SAM's usual proxy, monthly. Noisy
//        month to month, so the mean of the 3 months before the decision
//        date (July–September for 1 October).
// A value is used only when every month it averages lies before the decision
// date (ONI reaches a month past its centre), so no year's state reads the
// season it is meant to predict. When the copy doesn't hold this season's
// window yet (ONI is published early in the month after its last month), the
// window steps back a month, at most CLIMATE_INDEX_MAX_LAG_MONTHS, and every
// year is read over the same calendar months.
//
// The distance (k nearest neighbours in the predictor space, Lall & Sharma
// 1996): each index standardised by its standard deviation across the
// candidate years, then the weighted root mean square of the differences
// from this season's state, so a distance of 0.5 is half a standard
// deviation apart on average. Equal weights: ENSO is the stronger driver of
// summer rain in the north-east of the country, the SAM of winter rain in
// the south-western Cape (Reason & Rouault 2005), and the app serves both.
//
// k: a third of the candidates (the ENSO-phase subsets of conditioned ESP,
// Hamlet & Lettenmaier 1999, are about a tercile), and never fewer than
// OUTLOOK_MIN_YEARS, so the subset has percentiles and a planning figure.
// With fewer than CLIMATE_ANALOGUE_MIN_CANDIDATES candidates with both
// indices, those k would be half the record or more: no conditioning to
// speak of, so none is drawn and the reason is said.
//
// The antecedent wetness (SPI-3 at the decision date, ../drought) is not a
// term: every member already starts from the season's own state (its dams,
// soils and groundwater), so the antecedent conditions are in the outlook
// once, and rain anomalies persist too little month to month to say much
// about the season's weather.
//
// Pure: no I/O. A derived view of the ESP members: no member is run again,
// and the ESP result is unchanged.
import { OUTLOOK_MIN_YEARS, summariseOutlook, type OutlookSummaryInput, type SeasonalOutlook } from './outlook';
import { analogueStart, resolveSeason, type OutlookAnalogue, type OutlookSeason } from './season';
import { fromEpochDay } from '../calendar';

export const CLIMATE_INDEX_IDS = ['oni', 'aao'] as const;
export type ClimateIndexId = (typeof CLIMATE_INDEX_IDS)[number];

/** A monthly index: its first month ("YYYY-MM") and one value a month from it, null where it has none. */
export interface MonthlyIndexSeries {
	id: ClimateIndexId;
	firstMonth: string;
	values: (number | null)[];
}

/** How an index is read: its name, months averaged, months a value reaches past its own (ONI's centre), and its weight. */
export interface ClimateIndexSpec {
	id: ClimateIndexId;
	label: string;
	months: number;
	reach: number;
	weight: number;
}

export const CLIMATE_INDICES: Readonly<Record<ClimateIndexId, ClimateIndexSpec>> = Object.freeze({
	oni: Object.freeze({ id: 'oni', label: 'ONI', months: 1, reach: 1, weight: 1 }),
	aao: Object.freeze({ id: 'aao', label: 'AAO', months: 3, reach: 0, weight: 1 })
});

/**
 * Fewest candidate years with both indices for a selection (2 × OUTLOOK_MIN_YEARS,
 * a literal: ./outlook.ts imports this module): below it the k nearest would be half the record or more.
 */
export const CLIMATE_ANALOGUE_MIN_CANDIDATES = 20;
/** The share of the candidates kept (a tercile, as ENSO-phase subsets of ESP). */
export const CLIMATE_ANALOGUE_SHARE = 1 / 3;
/** Months the window may step back when this season's newest months aren't held yet. */
export const CLIMATE_INDEX_MAX_LAG_MONTHS = 2;

/** The number of years kept from `n` candidates: a third, at least OUTLOOK_MIN_YEARS, at most n. */
export const climateAnalogueCount = (n: number) => Math.min(n, Math.max(OUTLOOK_MIN_YEARS, Math.round(n * CLIMATE_ANALOGUE_SHARE)));

/** An index as read for the season. */
export interface ClimateIndexWindow {
	id: ClimateIndexId;
	label: string;
	/** The calendar months the season's value averages ("YYYY-MM", inclusive); ONI's is its centre month. */
	from: string;
	to: string;
	/** Months stepped back because the copy didn't hold the newest ones. */
	lagMonths: number;
	/** This season's value. */
	value: number;
	/** The standard deviation across the candidate years: the distance's unit. */
	scale: number;
	weight: number;
}

/** A candidate year: its values over the same calendar months, its distance and whether it was kept. */
export interface ClimateAnalogueYear {
	waterYear: number;
	label: string;
	values: Record<ClimateIndexId, number>;
	distance: number;
	chosen: boolean;
}

export type ClimateSelectionProblem = 'indexNotHeld' | 'tooFewYears';

export interface ClimateSelection {
	/** Per index, as read for this season; empty when an index isn't held for it. */
	indices: ClimateIndexWindow[];
	/** Candidates (the ESP analogue years) with both indices. */
	nCandidates: number;
	/** Years kept; 0 with a problem. */
	k: number;
	/** Every candidate with both indices, nearest first (distance, then the newer year); empty with a problem. */
	years: ClimateAnalogueYear[];
	/** ESP analogue years without a value of an index over their months. */
	missing: number[];
	problem: { reason: ClimateSelectionProblem; message: string } | null;
}

const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthText = (i: number) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;

/** The series' value in month `i` (index), or null. */
function valueAt(s: MonthlyIndexSeries, i: number): number | null {
	const v = s.values[i - monthIndex(s.firstMonth)];
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The mean of `s` over the `months` months ending `last`, or null when one is missing. */
function windowMean(s: MonthlyIndexSeries, last: number, months: number): number | null {
	let sum = 0;
	for (let i = last - months + 1; i <= last; i++) {
		const v = valueAt(s, i);
		if (v === null) return null;
		sum += v;
	}
	return sum / months;
}

/** The month (index) a season starting on epoch day `day` is in. */
const monthOfDay = (day: number) => monthIndex(fromEpochDay(day));

/** The sample standard deviation (n − 1). */
function sd(v: readonly number[]): number {
	if (v.length < 2) return 0;
	const m = v.reduce((a, b) => a + b, 0) / v.length;
	return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/**
 * The k analogue years nearest this season's ENSO and SAM state (module
 * header). `analogues` are the ESP's (outlookAnalogues, after any the
 * backend left out). Deterministic: ties go to the newer year.
 */
export function selectClimateAnalogues(season: OutlookSeason, analogues: readonly OutlookAnalogue[], indices: readonly MonthlyIndexSeries[]): ClimateSelection {
	const s = resolveSeason(season);
	const decisionMonth = monthOfDay(s.from);
	const windows: { spec: ClimateIndexSpec; series: MonthlyIndexSeries; lag: number; value: number }[] = [];
	for (const id of CLIMATE_INDEX_IDS) {
		const spec = CLIMATE_INDICES[id];
		const series = indices.find((x) => x.id === id);
		let found: { lag: number; value: number } | null = null;
		if (series) {
			for (let lag = 0; lag <= CLIMATE_INDEX_MAX_LAG_MONTHS && !found; lag++) {
				const v = windowMean(series, decisionMonth - 1 - spec.reach - lag, spec.months);
				if (v !== null) found = { lag, value: v };
			}
		}
		if (!series || !found) {
			const last = series ? series.values.reduce<number | null>((a, v, i) => (typeof v === 'number' && Number.isFinite(v) ? i : a), null) : null;
			const held = series && last !== null ? `; the copy holds it to ${monthText(monthIndex(series.firstMonth) + last)}` : '; the copy holds none';
			const need = monthText(decisionMonth - 1 - spec.reach - CLIMATE_INDEX_MAX_LAG_MONTHS);
			return {
				indices: [],
				nCandidates: 0,
				k: 0,
				years: [],
				missing: [],
				problem: { reason: 'indexNotHeld', message: `The ${spec.label} isn’t held for the months before ${s.decisionDate} (it needs ${need} or later${held}), so no past seasons can be matched to this one.` }
			};
		}
		windows.push({ spec, series, ...found });
	}

	// Each candidate over the same calendar months, counted back from its own season start.
	const candidates: { a: OutlookAnalogue; values: Record<ClimateIndexId, number> }[] = [];
	const missing: number[] = [];
	for (const a of analogues) {
		const m = monthOfDay(analogueStart(s.decisionDate, a.waterYear));
		const values = {} as Record<ClimateIndexId, number>;
		let ok = true;
		for (const w of windows) {
			const v = windowMean(w.series, m - 1 - w.spec.reach - w.lag, w.spec.months);
			if (v === null) ok = false;
			else values[w.spec.id] = v;
		}
		if (ok) candidates.push({ a, values });
		else missing.push(a.waterYear);
	}

	const indexWindows: ClimateIndexWindow[] = windows.map((w) => {
		const last = decisionMonth - 1 - w.spec.reach - w.lag;
		const scale = sd(candidates.map((c) => c.values[w.spec.id]));
		return { id: w.spec.id, label: w.spec.label, from: monthText(last - w.spec.months + 1), to: monthText(last), lagMonths: w.lag, value: w.value, scale, weight: w.spec.weight };
	});
	const n = candidates.length;
	if (n < CLIMATE_ANALOGUE_MIN_CANDIDATES) {
		return {
			indices: indexWindows,
			nCandidates: n,
			k: 0,
			years: [],
			missing,
			problem: {
				reason: 'tooFewYears',
				message: `Only ${n} past season${n === 1 ? '' : 's'} with both indices: at least ${CLIMATE_ANALOGUE_MIN_CANDIDATES} are needed, or the ${OUTLOOK_MIN_YEARS} nearest would be half the record.`
			}
		};
	}
	const totalWeight = indexWindows.reduce((a, w) => a + w.weight, 0);
	const ranked = candidates
		.map((c) => {
			let sum = 0;
			for (const w of indexWindows) {
				// A constant index (sd 0) separates nothing: its differences are all 0.
				const d = w.scale > 0 ? (c.values[w.id] - w.value) / w.scale : 0;
				sum += w.weight * d * d;
			}
			return { c, distance: Math.sqrt(sum / totalWeight) };
		})
		.sort((x, y) => x.distance - y.distance || y.c.a.waterYear - x.c.a.waterYear);
	const k = climateAnalogueCount(n);
	return {
		indices: indexWindows,
		nCandidates: n,
		k,
		years: ranked.map((r, i) => ({ waterYear: r.c.a.waterYear, label: r.c.a.label, values: r.c.values, distance: r.distance, chosen: i < k })),
		missing,
		problem: null
	};
}

/** The climate-conditioned outlook: the selection, and the ESP's members summarised on the chosen years alone (null with a problem). */
export interface ClimateOutlook {
	method: 'climateState';
	selection: ClimateSelection;
	outlook: SeasonalOutlook | null;
}

/**
 * Summarise the ESP members of the chosen years alone (summariseOutlook on
 * the same members, the others left out): what the levels, the dams and the
 * river did in past seasons like this one. The members are the ESP's, in
 * the analogues' order, so no member is run again.
 */
export function climateConditionedOutlook(x: OutlookSummaryInput, selection: ClimateSelection): ClimateOutlook {
	if (selection.problem) return { method: 'climateState', selection, outlook: null };
	const chosen = new Set(selection.years.filter((y) => y.chosen).map((y) => y.waterYear));
	const keep = x.analogues.map((a) => chosen.has(a.waterYear));
	const outlook = summariseOutlook({
		...x,
		analogues: x.analogues.filter((_, i) => keep[i]),
		levels: x.levels.map((l) => (l.problems.length ? l : { ...l, members: l.members.filter((_, i) => keep[i]) }))
	});
	return { method: 'climateState', selection, outlook };
}
