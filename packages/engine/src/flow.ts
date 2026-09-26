// Rain → natural flow: a port of the b023 WBT [Flow data] sheet, columns M–AB,
// and the workbook-level LAMBDA functions they call (fSorW2, fRainToFlow,
// fBaseFlow, fRecede, fRfIndex, fIndxAddedFlow, fRespAddedFlow).
//
// Each day carries two recession curves: an underlying *base flow* that
// recedes slowly and is reset by big rain, and a *response flow* that jumps on
// rain and then recedes from a shifted (steeper) point on the same curve. The
// natural flow is the larger of the two.
//
// The workbook rounds every column (INT on the rain flow, ROUND to whole m³ and
// to 4 dp on the indices). The engine does not (docs/engine-audit.md R1):
// rounding a receding state stops it at an arbitrary floor, e.g. 32 m³/day
// for a tail factor of 0.9845. flow.test.ts compares with a real workbook and
// lists where and why the results differ.
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
	/** AB — resultant natural flow (m³/day). */
	naturalFlowM3Day: number[];
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
	return flow * Math.max(0, fLo + p * (fHi - fLo));
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
	return Math.max(1, Math.min(lo + p, cal.recessionDaysMax));
}

/**
 * Problems with the recession table that make the model meaningless: a daily
 * factor outside [0, 1] (a recession that grows or turns negative), a curve
 * that rises (MATCH(…, -1) needs it descending), or tables of different length.
 */
export function recessionTableWarnings(cal: CalibrationParams): string[] {
	const out: string[] = [];
	const f = cal.recessionFactors;
	const c = cal.recessionCurveM3Day;
	f.forEach((v, i) => {
		if (!(v >= 0 && v <= 1)) out.push(`recession factor ${i + 1} is ${v}; daily recession factors must be between 0 and 1`);
	});
	for (let i = 1; i < c.length; i++) {
		if (c[i]! > c[i - 1]!) {
			out.push(`recession curve rises at row ${i + 1} (${c[i - 1]} → ${c[i]} m³/day); it must fall row by row for the index lookup`);
			break;
		}
	}
	if (c.length !== f.length) out.push(`recession curve has ${c.length} rows but there are ${f.length} recession factors`);
	return out;
}

/** fRainToFlow — peak flow (m³/day) produced by a day's rain. */
export function rainToFlow(cal: CalibrationParams, rainMm: number, summer: boolean): number {
	if (!(rainMm > 0)) return 0;
	const factor = summer ? cal.summerFactor : cal.winterFactor;
	// runModel resolves a null area to the summed farm areas before calling in.
	const rainToM3 = ((cal.catchmentAreaKm2 ?? 0) * 10 ** 6) / 1000; // rFlowData_RainToM3
	return cal.a * rainMm ** cal.b * rainToM3 * factor;
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
	// (The workbook also returns the base index when yesterday's index is blank,
	// which only happened on day 1; the engine seeds day 0's index instead.)
	return Math.min(addedFlow > 0 ? li : prevIndex + 1, cal.recessionDaysMax);
}

function rainUsed(threshold: number, catchment: number | null, chirps: number | null, forecast: number | null): number {
	const pick = catchment ?? chirps ?? forecast ?? 0;
	return pick > threshold ? pick : 0;
}

/**
 * The recession model's day-to-day state, the day before a run day
 * (engine ≥ 0.47.0, ./warmstart): the season flag and rain used, then the
 * base flow, its index, the response flow's index and flow, the resultant
 * flow and its index. Plain numbers so a model-state snapshot can carry it.
 */
export type LegacyFlowState = [summer: number, rain: number, base: number, baseIndex: number, addedIndex: number, responseAdded: number, resultant: number, resultantIndex: number];

/** Capture / resume for computeFlowColumns (engine ≥ 0.47.0). */
export interface FlowWarm {
	/** Start from this state instead of the steady base-flow day before the run. */
	initial?: Readonly<LegacyFlowState> | readonly number[];
	/** Return the state at the start of this run day (0 … days) as `captured`. */
	captureAt?: number;
}

/** Run the [Flow data] calculation and return every intermediate column. */
export function computeFlowColumns(cal: CalibrationParams, inputs: NaturalFlowInputs, warm: FlowWarm = {}): FlowColumns & { captured?: LegacyFlowState } {
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
		naturalFlowM3Day: new Array(n)
	};
	const day0 = toEpochDay(inputs.startDate);

	// The day before the run is a steady base-flow state: base flow and the
	// resultant flow both equal baseFlowInitial, and every index is that flow's
	// own position on the recession curve. The workbook's "reserved" row fills in only the base
	// flow and leaves its index blank (0), so day 1 receded at the extrapolated
	// factor 2·f1 − f2 (300 → 34 m³/day with the default curve, or a negative
	// base flow that can never reset when f2 > 2·f1) — audit E1.
	const initialIndex = recessionIndex(cal, cal.baseFlowInitial);
	let prevSummer = 0;
	let prevRain = 0;
	let prevBase = cal.baseFlowInitial;
	let prevBaseIndex = initialIndex;
	let prevAddedIndex = initialIndex;
	let prevResponseAdded = 0;
	let prevResultant = cal.baseFlowInitial;
	let prevResultantIndex = initialIndex;
	if (warm.initial) {
		if (warm.initial.length !== 8) throw new Error(`the legacy flow state has ${warm.initial.length} numbers, not 8`);
		[prevSummer, prevRain, prevBase, prevBaseIndex, prevAddedIndex, prevResponseAdded, prevResultant, prevResultantIndex] = warm.initial as LegacyFlowState;
	}
	let captured: LegacyFlowState | undefined;
	const save = (): LegacyFlowState => [prevSummer, prevRain, prevBase, prevBaseIndex, prevAddedIndex, prevResponseAdded, prevResultant, prevResultantIndex];

	for (let i = 0; i < n; i++) {
		if (i === warm.captureAt) captured = save();
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
		const base = reset ? rainFlow : receded;
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

		// [Flow data] AB fell back to a Pitman flow column when the rain model gave 0
		// (quirk Q7), mixing two sources in one series. The engine has no Pitman input.
		const natural = resultant > 0 ? resultant : 0;

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
	if (warm.captureAt === n) captured = save();
	return captured ? { ...cols, captured } : cols;
}

/** Catchment natural flow (m³/day) from rain, plus the useful intermediates. */
export function computeNaturalFlow(cal: CalibrationParams, inputs: NaturalFlowInputs, warm: FlowWarm = {}): NaturalFlowResult & { state?: LegacyFlowState } {
	const c = computeFlowColumns(cal, inputs, warm);
	return {
		...(c.captured ? { state: c.captured } : {}),
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
