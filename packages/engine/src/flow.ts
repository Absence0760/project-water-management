// Rain → natural flow: a port of the b023 WBT [Flow data] sheet, columns M–AB,
// and the workbook-level LAMBDA functions they call (fSorW2, fRainToFlow,
// fBaseFlow, fRecede, fRfIndex, fIndxAddedFlow, fRespAddedFlow).
//
// Each day carries two recession curves: an underlying *base flow* that
// recedes slowly and is reset by big rain, and a *response flow* that jumps on
// rain and then recedes from a shifted (steeper) point on the same curve. The
// natural flow is the larger of the two, falling back to Pitman when zero.
//
// Excel's rounding (INT / ROUND half away from zero) is reproduced exactly so a
// run matches the workbook day for day; see flow.test.ts for the regression
// against a real workbook.
import { monthOfEpochDay, toEpochDay } from './calendar';
import type { CalibrationParams } from './project';

export interface NaturalFlowInputs {
	startDate: string;
	days: number;
	/** Catchment-average rain (mm/day); preferred when present. */
	rainCatchmentMm: (number | null)[];
	/** CHIRPS satellite rain (mm/day); used where catchment rain is missing. */
	rainChirpsMm: (number | null)[];
	/** Forecast rain (mm/day); used where both of the above are missing. */
	rainForecastMm: (number | null)[];
	/** Pitman natural flow (m³/s); fallback when the rain model gives 0. */
	flowPitmanM3s: (number | null)[];
}

export interface FlowSeries {
	key: string;
	label: string;
	unit: string;
	values: number[];
}

export interface NaturalFlowResult {
	naturalFlowM3Day: number[];
	series: FlowSeries[];
}

/** Every intermediate column of [Flow data], one array per column, one entry per day. */
export interface FlowColumns {
	/** N — 1 = summer, 0 = winter. */
	isSummer: number[];
	/** R — rain used (mm), 0 when at or below the threshold. */
	rainUsedMm: number[];
	/** S — underlying base flow (m³/day). */
	baseFlow: number[];
	/** T — base flow recession index. */
	baseIndex: number[];
	/** U — yesterday's resultant flow receded one day (m³/day). */
	responseStart: number[];
	/** V — flow added by today's rain (m³/day). */
	rainFlow: number[];
	/** W — recession index of the response flow. */
	addedIndex: number[];
	/** X — response flow plus rain-added flow, or its recession (m³/day). */
	responseAdded: number[];
	/** Y — max(response, base) (m³/day). */
	resultantFlow: number[];
	/** Z — recession index belonging to Y. */
	resultantIndex: number[];
	/** O — Pitman flow converted to m³/day. */
	pitmanM3Day: number[];
	/** AB — resultant natural flow (m³/day). */
	naturalFlowM3Day: number[];
}

const SECONDS_PER_DAY = 86_400;

/**
 * Excel ROUND: half away from zero, applied to the value as Excel sees it
 * (15 significant digits), so 2.675 → 2.68 rather than JS's 2.67.
 */
export function excelRound(x: number, digits = 0): number {
	if (!Number.isFinite(x)) return x;
	const sign = x < 0 ? -1 : 1;
	const abs = Number(Math.abs(x).toPrecision(15));
	const text = String(abs);
	if (text.includes('e')) {
		// Tiny or huge magnitudes: shifting by string would be malformed; the
		// decimal-representation issue ROUND guards against doesn't arise there.
		const f = 10 ** digits;
		return (sign * Math.round(abs * f)) / f;
	}
	// Shift the decimal point textually so 1.005 → 100.5 exactly, not 100.4999….
	const scaled = Math.round(Number(`${text}e${digits}`));
	return sign * Number(`${scaled}e${-digits}`);
}

/** Excel INT: round down to the nearest integer. */
function excelInt(x: number): number {
	return Math.floor(x);
}

/** 1-based INDEX into a range; cells past the end read as blank (0). */
function at(range: readonly number[], i: number): number {
	return range[i - 1] ?? 0;
}

/** fRecede — flow receded one day at a fractional recession index. */
export function recede(cal: CalibrationParams, flow: number, index: number): number {
	const r = cal.recessionFactors;
	const lo = Math.min(Math.max(Math.floor(index), 1), r.length);
	const hi = Math.min(lo + 1, r.length);
	// Below index 1 (a pulse starting at shiftPeakIndexLo < 1) P goes negative
	// and the factor is extrapolated below the first one. Clamp it at 0: a
	// recession can shrink a flow to nothing but never below (audit E2).
	const p = index - lo;
	const fLo = at(r, lo);
	const fHi = at(r, hi);
	return excelRound(flow * Math.max(0, fLo + p * (fHi - fLo)), 0);
}

/** fRfIndex — fractional recession index for a flow, read off the smoothed curve. */
export function recessionIndex(cal: CalibrationParams, flow: number): number {
	const c = cal.recessionCurveM3Day;
	const rows = cal.recessionFactors.length;
	// MATCH(flow, curve, -1) on a descending curve: last position whose value is
	// ≥ flow; #N/A (flow above the top of the curve) falls back to 1.
	let match = 0;
	for (let i = 1; i <= c.length; i++) {
		if (at(c, i) >= flow) match = i;
		else break;
	}
	const lo = Math.min(match || 1, rows - 1);
	const hi = Math.min(lo + 1, rows);
	const span = at(c, hi) - at(c, lo);
	const p = span === 0 ? 0 : (flow - at(c, lo)) / span;
	return Math.max(1, excelRound(Math.min(lo + p, cal.recessionDaysMax), 4));
}

/** fRainToFlow — peak flow (m³/day) produced by a day's rain. */
export function rainToFlow(cal: CalibrationParams, rainMm: number, summer: boolean): number {
	if (!(rainMm > 0)) return 0;
	const factor = summer ? cal.summerFactor : cal.winterFactor;
	// runModel resolves a null area to the summed farm areas before calling in.
	const rainToM3 = ((cal.catchmentAreaKm2 ?? 0) * 10 ** 6) / 1000; // rFlowData_RainToM3
	return excelInt(cal.a * rainMm ** cal.b * rainToM3 * factor);
}

/** fSorW2 — 1 in summer, 0 in winter; winter persists until a summer month. */
export function seasonFlag(
	cal: CalibrationParams,
	month: number,
	prevFlag: number,
	rainToday: number,
	rainYesterday: number
): number {
	if (cal.summerMonths.includes(month)) return 1;
	if (prevFlag === 0) return 0;
	if (rainToday >= cal.winterTodayRainMm) return 0;
	if (rainYesterday >= cal.winterNextDayRainMm) return 0;
	return 1;
}

/** fIndxAddedFlow — recession index the response curve continues from. */
function addedFlowIndex(
	cal: CalibrationParams,
	prevIndex: number,
	baseIndex: number,
	addedFlow: number
): number {
	const lo = cal.shiftPeakIndexLo;
	const hi = cal.shiftPeakIndexHi;
	// Bigger rain → start nearer the steep top of the curve (towards Lo).
	const indx = cal.amplitudeM3Day === 0 ? lo : lo + (hi - lo) * (1 - addedFlow / cal.amplitudeM3Day);
	const ci = Math.max(indx, lo);
	// Keep the start left of the base index so the event curve crosses the base.
	const li = ci > baseIndex ? Math.max(1, baseIndex - 0.2) : ci;
	const afi = addedFlow > 0 ? li : prevIndex + 1;
	return excelRound(Math.min(prevIndex === 0 ? baseIndex : afi, cal.recessionDaysMax), 4);
}

function rainUsed(threshold: number, catchment: number | null, chirps: number | null, forecast: number | null): number {
	const pick = catchment ?? chirps ?? forecast ?? 0;
	return pick > threshold ? pick : 0;
}

/** Run the [Flow data] calculation and return every intermediate column. */
export function computeFlowColumns(cal: CalibrationParams, inputs: NaturalFlowInputs): FlowColumns {
	const n = Math.max(0, Math.floor(inputs.days));
	const cols: FlowColumns = {
		isSummer: new Array(n),
		rainUsedMm: new Array(n),
		baseFlow: new Array(n),
		baseIndex: new Array(n),
		responseStart: new Array(n),
		rainFlow: new Array(n),
		addedIndex: new Array(n),
		responseAdded: new Array(n),
		resultantFlow: new Array(n),
		resultantIndex: new Array(n),
		pitmanM3Day: new Array(n),
		naturalFlowM3Day: new Array(n)
	};
	const day0 = toEpochDay(inputs.startDate);

	// The day before the run is a steady base-flow state: base flow and the
	// resultant flow both equal baseFlowInitial, at that flow's own position on
	// the recession curve. The workbook's "reserved" row fills in only the base
	// flow and leaves its index blank (0), so day 1 receded at the extrapolated
	// factor 2·f1 − f2 (300 → 34 m³/day with the default curve, or a negative
	// base flow that can never reset when f2 > 2·f1) — audit E1.
	const initialIndex = recessionIndex(cal, cal.baseFlowInitial);
	let prevSummer = 0;
	let prevRain = 0;
	let prevBase = cal.baseFlowInitial;
	let prevBaseIndex = initialIndex;
	let prevAddedIndex = 0;
	let prevResponseAdded = 0;
	let prevResultant = cal.baseFlowInitial;
	let prevResultantIndex = initialIndex;

	for (let i = 0; i < n; i++) {
		const month = monthOfEpochDay(day0 + i);
		const rain = rainUsed(
			cal.rainThresholdMm,
			inputs.rainCatchmentMm[i] ?? null,
			inputs.rainChirpsMm[i] ?? null,
			inputs.rainForecastMm[i] ?? null
		);
		const summer = seasonFlag(cal, month, prevSummer, rain, prevRain);
		const rainFlow = rainToFlow(cal, rain, summer === 1);

		// fBaseFlow: recede yesterday's base; big rain relative to it resets it.
		const receded = recede(cal, prevBase, prevBaseIndex);
		const reset = receded === 0 ? rainFlow > 0 : rainFlow / receded > cal.baseResetRatio;
		const base = excelRound(reset ? rainFlow : receded, 0);
		const baseIndex = recessionIndex(cal, base);

		const responseStart = recede(cal, prevResultant, prevResultantIndex);
		const addedIndex = addedFlowIndex(cal, prevAddedIndex, baseIndex, rainFlow);
		// fRespAddedFlow
		const responseAdded =
			rainFlow > 0
				? responseStart + rainFlow
				: prevResponseAdded === 0
					? responseStart
					: recede(cal, prevResponseAdded, prevAddedIndex);

		const responseWins = responseAdded > base;
		const resultant = responseWins ? responseAdded : base;
		const resultantIndex = responseWins ? addedIndex : baseIndex;

		const pitman = excelRound((inputs.flowPitmanM3s[i] ?? 0) * SECONDS_PER_DAY, 0);
		const natural = resultant > 0 ? resultant : pitman > 0 ? pitman : 0;

		cols.isSummer[i] = summer;
		cols.rainUsedMm[i] = rain;
		cols.baseFlow[i] = base;
		cols.baseIndex[i] = baseIndex;
		cols.responseStart[i] = responseStart;
		cols.rainFlow[i] = rainFlow;
		cols.addedIndex[i] = addedIndex;
		cols.responseAdded[i] = responseAdded;
		cols.resultantFlow[i] = resultant;
		cols.resultantIndex[i] = resultantIndex;
		cols.pitmanM3Day[i] = pitman;
		cols.naturalFlowM3Day[i] = natural;

		prevSummer = summer;
		prevRain = rain;
		prevBase = base;
		prevBaseIndex = baseIndex;
		prevAddedIndex = addedIndex;
		prevResponseAdded = responseAdded;
		prevResultant = resultant;
		prevResultantIndex = resultantIndex;
	}
	return cols;
}

/** Catchment natural flow (m³/day) from rain, plus the useful intermediates. */
export function computeNaturalFlow(cal: CalibrationParams, inputs: NaturalFlowInputs): NaturalFlowResult {
	const c = computeFlowColumns(cal, inputs);
	return {
		naturalFlowM3Day: c.naturalFlowM3Day,
		series: [
			{ key: 'rain_used', label: 'Rain used', unit: 'mm', values: c.rainUsedMm },
			{ key: 'is_summer', label: 'Summer (1) / winter (0)', unit: 'flag', values: c.isSummer },
			{ key: 'rain_flow', label: 'Rain-added flow', unit: 'm³/day', values: c.rainFlow },
			{ key: 'base_flow', label: 'Underlying base flow', unit: 'm³/day', values: c.baseFlow },
			{ key: 'response_flow', label: 'Response flow', unit: 'm³/day', values: c.responseAdded },
			{ key: 'resultant_flow', label: 'Resultant rain flow', unit: 'm³/day', values: c.resultantFlow }
		]
	};
}
