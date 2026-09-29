// Recession segments picked out of a daily flow record (engine ≥ 1.19.0,
// docs/model.md §2.10d "Recession diagnostics"; calibration-research.md CR-13).
//
// The specification is TOSSH (Gnann et al. 2021, the Toolbox for
// Streamflow Signatures in Hydrology), util_RecessionSegments.m and the
// defaults sig_RecessionAnalysis.m passes it:
//
//   recession_length   5     min. length of a recession, days
//   n_start            1     days removed after the peak (quickflow's tail)
//   eps                0     allowed increase in flow during a recession
//   start_of_recession 'peak' a recession starts at the peak
//   filter_par         0.925 Lyne–Hollick parameter, used only by
//                            start_of_recession 'baseflow' (not ported)
//
// TOSSH marks a step as falling when Q(t) < Q(t−1) + eps, sets zero flows to
// NaN (so they break a run), keeps a run of falling steps from the peak p to
// its last day e when e − p ≥ recession_length + n_start, and then starts the
// segment n_start days after the peak: [p + n_start, e]. With the defaults a
// kept segment has at least 6 days (5 steps).
//
// CR-13 adds what TOSSH leaves to the caller (Tallaksen 1995; Stoelzle et al.
// 2013; Dralle et al. 2017): a step into day t counts only when the
// catchment rain on t and on t − 1 is known and at most `rainThresholdMm`,
// and when both days' flows are usable: recorded, above zero, and not
// left out by the caller's mask (the run's calibration exclusions, and from
// engine 1.20.0 the days CR-18's flow quality flags mark extrapolated,
// infilled or suspect: ../calibrate/dayFlags.ts flaggedDayMask). A missing day, a wet day and a rise all end a run.
//
// Two departures from TOSSH, both about where a run ends, not what it is:
// a run cut off by the end of the record is kept like one cut off by a gap
// (TOSSH drops an unpaired last run); and there is no 'baseflow' start (the
// Lyne–Hollick start), since the rain rule and n_start already keep the
// quickflow out.

/** The recession settings; RECESSION_DEFAULTS holds TOSSH's and CR-13's defaults. */
export interface RecessionOptions {
	/** Min. length of a recession, days (TOSSH recession_length). */
	recessionLength: number;
	/** Days dropped after the peak (TOSSH n_start). */
	nStart: number;
	/** Allowed increase in flow during a recession, m³/s (TOSSH eps, there in mm/timestep). */
	epsM3s: number;
	/** A day is dry when its catchment rain and the day before's are at most this, mm (CR-13). */
	rainThresholdMm: number;
	/** How −dQ/dt is estimated (TOSSH util_dQdt `method`; see ./analysis.ts). */
	dQdtMethod: RecessionDqdtMethod;
}

/** TOSSH util_dQdt's methods: ETS (Roques et al. 2017, TOSSH's default), BN (Brutsaert & Nieber 1977), backwards (Thomas et al. 2015). */
export type RecessionDqdtMethod = 'ETS' | 'BN' | 'backwards';

/**
 * TOSSH's defaults (sig_RecessionAnalysis.m) and CR-13's rain threshold.
 * The 1 mm/day threshold is a house default for the hydrologist to confirm:
 * it is the usual "rain day" cut-off, below which a day's rain barely wets
 * the canopy, let alone reaches the river.
 */
export const RECESSION_DEFAULTS: Readonly<RecessionOptions> = Object.freeze({
	recessionLength: 5,
	nStart: 1,
	epsM3s: 0,
	rainThresholdMm: 1,
	dQdtMethod: 'ETS'
});

export interface RecessionSegmentInput {
	/** Daily flow, m³/s (null or NaN = missing). */
	flowM3s: ArrayLike<number | null>;
	/** The catchment rain on the same days, mm (null = missing: that day and the next are not dry). */
	rainMm: ArrayLike<number | null>;
	/** 1 on days to leave out (calibration exclusions, flow quality flags); absent = none. */
	excluded?: ArrayLike<number>;
}

/** A recession segment: its first and last day (indices into the series), inclusive. */
export type RecessionSegment = readonly [start: number, end: number];

const usable = (q: number | null | undefined): q is number => q != null && Number.isFinite(q) && q > 0;

/** The recession segments of a daily record, in day order (TOSSH util_RecessionSegments with CR-13's rain rule). */
export function recessionSegments(x: RecessionSegmentInput, options: Partial<RecessionOptions> = {}): RecessionSegment[] {
	const o = { ...RECESSION_DEFAULTS, ...options };
	const q = x.flowM3s;
	const rain = x.rainMm;
	const n = Math.min(q.length, rain.length);
	const ok = (t: number) => usable(q[t]) && !x.excluded?.[t];
	const dryRain = (t: number) => {
		const r = rain[t];
		return r != null && Number.isFinite(r) && r <= o.rainThresholdMm;
	};
	// Step t−1 → t is part of a recession.
	const falls = (t: number) => ok(t - 1) && ok(t) && dryRain(t) && dryRain(t - 1) && q[t]! < q[t - 1]! + o.epsM3s;
	const out: RecessionSegment[] = [];
	let t = 1;
	while (t < n) {
		if (!falls(t)) {
			t++;
			continue;
		}
		const peak = t - 1;
		while (t < n && falls(t)) t++;
		const end = t - 1;
		if (end - peak >= o.recessionLength + o.nStart) out.push([peak + o.nStart, end]);
	}
	return out;
}
