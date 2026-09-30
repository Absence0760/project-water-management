// Gap filling for the observed flow records (engine ≥ 1.23.0, issue #66,
// docs/model.md §2.10i). Opt-in per record through settings.flowGapFill:
// with no spec a run is exactly what it was before.
//
// Two methods, in this order, on the record's interior gaps (a run of
// missing days with a reading on both sides; a record's lead-in and tail are
// never filled, since nothing bounds them):
//
//  1. Log-linear interpolation of a gap of at most `interpolateMaxDays` days
//     between the readings either side: Q = a·(b/a)^f, f the day's fraction
//     of the way across. A recession is exponential (Q(t) = Q0·k^t), so a
//     log-linear line follows one exactly, where a straight line would
//     overstate its volume. Linear where either side is 0 (no logarithm).
//     Short on purpose: an interpolated gap can't hold a flood it didn't see.
//  2. A longer gap, up to `donorMaxDays`, from another record (`donor`: the
//     other observed record on the same reach, or the reference gauge on a
//     neighbouring river) × the ratio Σ record / Σ donor over the days both
//     have a reading, the whole stored record. Refused, with the reason in
//     the summary, when they share fewer than `donorMinOverlapDays` days or
//     their daily flows correlate below DONOR_MIN_CORRELATION. A filled day
//     is clamped to the record's own highest reading: a donor's flood scaled
//     past anything the gauge has measured is outside its rating.
//
// Filled values never touch the stored series. The result carries a per-day
// method code (FLOW_FILL_CODE), which the run exports as its own column and
// the per-day quality flags (CR-18, ./calibrate/dayFlags.ts
// observedInfillMask) read as `infilled`. Whether a filled day is scored is
// the quality flags' one control, settings.qualityFlags.infilled: 'exclude'
// (the default) leaves filled days out of the fit and, since they are not
// readings, out of the run's calibration statistics, the EWR test on the
// observed record and the plausibility checks too; 'include' scores them
// everywhere. Filled days are always shown, exported and warned about.
import { toEpochDay } from './calendar';
import type { DailySeries, SeriesKind } from './project';

/** The records a spec can fill: the observed gauge and the logger (CALIBRATION_FLOW_KINDS). */
export const GAP_FILL_KINDS = ['flow_observed_m3s', 'flow_logger_m3s'] as const;
export type GapFillKind = (typeof GAP_FILL_KINDS)[number];
/** The records a gap can be filled from: any other flow record of the project. */
export const GAP_FILL_DONORS = ['flow_observed_m3s', 'flow_logger_m3s', 'flow_reference_m3s'] as const;
export type GapFillDonor = (typeof GAP_FILL_DONORS)[number];

/** How one record's gaps are filled. */
export interface FlowGapFillSpec {
	/** Longest gap filled by log-linear interpolation, days (0 = none). Default 5. */
	interpolateMaxDays: number;
	/** The record longer gaps are filled from (not the record itself); null = none. */
	donor: GapFillDonor | null;
	/** Longest gap filled from the donor, days. Default 60. */
	donorMaxDays: number;
	/** Fewest days both records must share for the ratio. Default 365. */
	donorMinOverlapDays: number;
}

/**
 * settings.flowGapFill: a spec per record (null = not filled). Whether filled
 * days are scored is settings.qualityFlags.infilled, not a field here (the
 * `useFilledDays` switch it replaced was never deployed; a stored one is
 * ignored with a warning).
 */
export interface FlowGapFillSettings {
	flow_observed_m3s: FlowGapFillSpec | null;
	flow_logger_m3s: FlowGapFillSpec | null;
}

/** Per-day method codes (the run's `*_fill` columns): 0 = measured or still missing. */
export const FLOW_FILL_CODE = { none: 0, interpolated: 1, donor: 2 } as const;
export type FlowFillCode = (typeof FLOW_FILL_CODE)[keyof typeof FLOW_FILL_CODE];

export const DEFAULT_FLOW_GAP_SPEC: Readonly<FlowGapFillSpec> = Object.freeze({ interpolateMaxDays: 5, donor: null, donorMaxDays: 60, donorMinOverlapDays: 365 });
export const defaultFlowGapFill = (): FlowGapFillSettings => ({ flow_observed_m3s: null, flow_logger_m3s: null });

/** Bounds a spec is checked against (and the settings route's schema). */
export const GAP_FILL_LIMITS = { interpolateMaxDays: 30, donorMaxDays: 366, donorMinOverlapDaysMin: 30, donorMinOverlapDaysMax: 36_600 } as const;
/**
 * A donor whose daily flows correlate below this with the record's, on the
 * shared days, fills nothing: it doesn't rise and fall with the river. A
 * draft, pending the hydrologist (Pearson r on the daily flows).
 */
export const DONOR_MIN_CORRELATION = 0.5;

const RECORD_LABEL: Record<GapFillDonor, string> = {
	flow_observed_m3s: 'observed gauge flow',
	flow_logger_m3s: 'logger flow',
	flow_reference_m3s: 'reference gauge'
};
export const gapFillRecordLabel = (k: GapFillDonor): string => RECORD_LABEL[k];

const isWhole = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** One record's spec, checked: invalid fields fall back to their default with a warning; null / absent = not filled. */
function resolveSpec(kind: GapFillKind, raw: unknown, warnings: string[]): FlowGapFillSpec | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		warnings.push(`flow gap filling for the ${RECORD_LABEL[kind]} is not a fill setting; the record is not filled`);
		return null;
	}
	const r = raw as Record<string, unknown>;
	const d = DEFAULT_FLOW_GAP_SPEC;
	const pick = (key: 'interpolateMaxDays' | 'donorMaxDays' | 'donorMinOverlapDays', lo: number, hi: number): number => {
		const v = r[key];
		if (v === undefined) return d[key];
		if (isWhole(v, lo, hi)) return v;
		warnings.push(`flow gap filling ${key} = ${JSON.stringify(v)} for the ${RECORD_LABEL[kind]} is not a whole number of days, ${lo}–${hi}; using ${d[key]}`);
		return d[key];
	};
	let donor: GapFillDonor | null = null;
	if (r.donor !== undefined && r.donor !== null) {
		if ((GAP_FILL_DONORS as readonly unknown[]).includes(r.donor) && r.donor !== kind) donor = r.donor as GapFillDonor;
		else warnings.push(`flow gap filling donor ${JSON.stringify(r.donor)} for the ${RECORD_LABEL[kind]} is not another flow record; no gap is filled from a donor`);
	}
	return {
		interpolateMaxDays: pick('interpolateMaxDays', 0, GAP_FILL_LIMITS.interpolateMaxDays),
		donor,
		donorMaxDays: pick('donorMaxDays', 1, GAP_FILL_LIMITS.donorMaxDays),
		donorMinOverlapDays: pick('donorMinOverlapDays', GAP_FILL_LIMITS.donorMinOverlapDaysMin, GAP_FILL_LIMITS.donorMinOverlapDaysMax)
	};
}

/** settings.flowGapFill as a run uses it: absent or invalid parts off, with a warning for what was invalid. */
export function resolveFlowGapFill(raw: unknown, warnings: string[] = []): FlowGapFillSettings {
	const out = defaultFlowGapFill();
	if (raw === null || raw === undefined) return out;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		warnings.push('flow gap filling is not a fill setting; no flow record is filled');
		return out;
	}
	const r = raw as Record<string, unknown>;
	for (const k of GAP_FILL_KINDS) out[k] = resolveSpec(k, r[k], warnings);
	// Retired before any deploy: settings.qualityFlags.infilled is the one control now.
	if (r.useFilledDays === true) {
		warnings.push('flow gap filling useFilledDays is retired and ignored: whether filled days are scored is Settings → Calibration record → Quality flags, infilled days');
	}
	return out;
}

/** A spec that can fill anything (interpolation or a donor). */
export const specFills = (s: FlowGapFillSpec | null | undefined): s is FlowGapFillSpec => !!s && (s.interpolateMaxDays > 0 || s.donor !== null);

/** The donor's fit: what scales it, on how many shared days, how well it follows the record. */
export interface DonorFit {
	kind: GapFillDonor;
	/** Σ record / Σ donor over the shared days. */
	ratio: number;
	overlapDays: number;
	/** Pearson r of the daily flows on the shared days; null when either is constant. */
	correlation: number | null;
}

/** What a fill did, over the days it is counted on. */
export interface FlowFillSummary {
	kind: GapFillKind;
	spec: FlowGapFillSpec;
	interpolatedDays: number;
	interpolatedGaps: number;
	donorDays: number;
	donorGaps: number;
	/** Donor days lowered to the record's highest reading. */
	clampedDays: number;
	/** The record's highest reading (m³/s), the clamp; null without readings. */
	clampM3s: number | null;
	/** The donor's fit, when a donor is named and present (refused or not). */
	donor: DonorFit | null;
	/** Why no gap was filled from the donor; null when it filled, or none is named. */
	donorRefused: string | null;
	/** Interior gaps (and their missing days) still open after filling. */
	openGaps: number;
	openDays: number;
}

/** A filled record: the same days as the stored series. */
export interface FlowFill {
	kind: GapFillKind;
	startDate: string;
	/** The record with its filled days (m³/s); a negative reading is missing, as the run reads it. */
	values: (number | null)[];
	/** FLOW_FILL_CODE per day. */
	code: Uint8Array;
	/** Over the whole stored record. */
	summary: FlowFillSummary;
}

/** A flow reading as a run reads it: finite and not negative, else missing (engine 1.16.0, prepare.ts alignFlow). */
const reading = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function pearson(x: number[], y: number[]): number | null {
	const n = x.length;
	if (n < 2) return null;
	let mx = 0;
	let my = 0;
	for (let i = 0; i < n; i++) {
		mx += x[i]!;
		my += y[i]!;
	}
	mx /= n;
	my /= n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i++) {
		const a = x[i]! - mx;
		const b = y[i]! - my;
		sxy += a * b;
		sxx += a * a;
		syy += b * b;
	}
	return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** The donor's ratio and correlation over the days both records have a reading. */
export function fitDonor(record: DailySeries, donor: DailySeries, kind: GapFillDonor): DonorFit {
	const r0 = toEpochDay(record.startDate);
	const d0 = toEpochDay(donor.startDate);
	const x: number[] = [];
	const y: number[] = [];
	let sr = 0;
	let sd = 0;
	for (let i = 0; i < record.values.length; i++) {
		const a = reading(record.values[i]);
		if (a === null) continue;
		const b = reading(donor.values[r0 + i - d0]);
		if (b === null) continue;
		x.push(a);
		y.push(b);
		sr += a;
		sd += b;
	}
	return { kind, ratio: sd > 0 ? sr / sd : NaN, overlapDays: x.length, correlation: pearson(x, y) };
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));

/**
 * Fill a record's interior gaps by `spec` (see the module comment). `donor`
 * is the donor record when the spec names one and the project has it. The
 * stored values are never changed: the result is a new array.
 */
export function fillFlowGaps(kind: GapFillKind, record: DailySeries, spec: FlowGapFillSpec, donor: DailySeries | null = null): FlowFill {
	const n = record.values.length;
	const values = Array.from({ length: n }, (_, i) => reading(record.values[i]));
	const code = new Uint8Array(n);
	let clamp: number | null = null;
	for (const v of values) if (v !== null && (clamp === null || v > clamp)) clamp = v;
	const summary: FlowFillSummary = {
		kind,
		spec: { ...spec },
		interpolatedDays: 0,
		interpolatedGaps: 0,
		donorDays: 0,
		donorGaps: 0,
		clampedDays: 0,
		clampM3s: clamp,
		donor: null,
		donorRefused: null,
		openGaps: 0,
		openDays: 0
	};

	let fit: DonorFit | null = null;
	if (spec.donor && donor) {
		fit = fitDonor(record, donor, spec.donor);
		summary.donor = fit;
		if (fit.overlapDays < spec.donorMinOverlapDays) summary.donorRefused = `the two records share ${fit.overlapDays} days with a reading, fewer than the ${spec.donorMinOverlapDays} the ratio needs`;
		else if (!(fit.ratio > 0) || !Number.isFinite(fit.ratio)) summary.donorRefused = 'one of the records has no flow on the days they share, so there is no ratio';
		else if (fit.correlation === null || fit.correlation < DONOR_MIN_CORRELATION)
			summary.donorRefused = `their daily flows correlate at r = ${fit.correlation === null ? 'n/a' : fit.correlation.toFixed(2)} on the shared days, below ${DONOR_MIN_CORRELATION}`;
	} else if (spec.donor) summary.donorRefused = `the project has no ${RECORD_LABEL[spec.donor]} record`;
	const useDonor = !!fit && summary.donorRefused === null;
	const r0 = toEpochDay(record.startDate);
	const d0 = donor ? toEpochDay(donor.startDate) : 0;

	let i = 0;
	// Skip the lead-in: nothing bounds a gap before the first reading.
	while (i < n && values[i] === null) i++;
	while (i < n) {
		if (values[i] !== null) {
			i++;
			continue;
		}
		const from = i;
		while (i < n && values[i] === null) i++;
		if (i >= n) break; // the tail: nothing bounds it
		const to = i - 1;
		const len = to - from + 1;
		const a = values[from - 1]!;
		const b = values[to + 1]!;
		if (len <= spec.interpolateMaxDays) {
			for (let k = 1; k <= len; k++) {
				const f = k / (len + 1);
				values[from + k - 1] = a > 0 && b > 0 ? a * Math.pow(b / a, f) : a + (b - a) * f;
				code[from + k - 1] = FLOW_FILL_CODE.interpolated;
			}
			summary.interpolatedDays += len;
			summary.interpolatedGaps++;
			continue;
		}
		let filled = 0;
		if (useDonor && len <= spec.donorMaxDays) {
			for (let t = from; t <= to; t++) {
				const q = reading(donor!.values[r0 + t - d0]);
				if (q === null) continue;
				let v = q * fit!.ratio;
				if (clamp !== null && v > clamp) {
					v = clamp;
					summary.clampedDays++;
				}
				values[t] = v;
				code[t] = FLOW_FILL_CODE.donor;
				filled++;
			}
		}
		if (filled) {
			summary.donorDays += filled;
			summary.donorGaps++;
		}
		if (filled < len) {
			summary.openGaps++;
			summary.openDays += len - filled;
		}
	}
	return { kind, startDate: record.startDate, values, code, summary };
}

/** The summary's counts over run days `start … start + days − 1` only (the gap and donor fit stay the record's). */
export function fillSummaryInWindow(f: FlowFill, start: number, days: number): FlowFillSummary {
	const f0 = toEpochDay(f.startDate);
	const s = { ...f.summary, interpolatedDays: 0, donorDays: 0 };
	const lo = Math.max(0, start - f0);
	const hi = Math.min(f.code.length, start + days - f0);
	for (let i = lo; i < hi; i++) {
		if (f.code[i] === FLOW_FILL_CODE.interpolated) s.interpolatedDays++;
		else if (f.code[i] === FLOW_FILL_CODE.donor) s.donorDays++;
	}
	return s;
}

/** The run warning for one record's fill, or null when it filled nothing and refused nothing. */
export function flowFillWarning(s: FlowFillSummary, scored: boolean): string | null {
	const parts: string[] = [];
	if (s.interpolatedDays) parts.push(`${s.interpolatedDays} days interpolated across gaps of up to ${s.spec.interpolateMaxDays} days`);
	if (s.donorDays && s.donor)
		parts.push(
			`${s.donorDays} days from the ${RECORD_LABEL[s.donor.kind]} × ${fmt(s.donor.ratio)} (fitted on ${s.donor.overlapDays} shared days, r = ${s.donor.correlation?.toFixed(2) ?? 'n/a'})` +
				(s.clampedDays ? `, ${s.clampedDays} of them lowered to the record's highest reading, ${fmt(s.clampM3s!)} m³/s` : '')
		);
	const refused = s.donorRefused ? ` No gap was filled from the ${RECORD_LABEL[s.spec.donor!]}: ${s.donorRefused}.` : '';
	if (!parts.length && !refused) return null;
	const reads = scored
		? ' Infilled days are scored (quality flags): the fit, the calibration statistics, the EWR test on the observed record and the plausibility checks read the filled days.'
		: ' Infilled days are left out (quality flags, the default): no statistic reads the filled days; they are shown and exported only.';
	return `${RECORD_LABEL[s.kind]}: ${parts.length ? `gaps filled in the run, ${parts.join('; ')}.` : 'no gap filled in the run.'}${refused}${parts.length ? reads : ''} The stored record is unchanged.`;
}

/** The run's per-day columns for a filled record (engine ≥ 1.23.0): the filled values, and the method code. */
export const FLOW_FILL_COLUMNS = {
	observed_flow: {
		values: { key: 'observed_flow_filled', label: 'Observed flow: filled gap days only (interpolated or from a donor record)' },
		code: { key: 'observed_flow_fill', label: 'Observed flow gap fill (1 = interpolated, 2 = from a donor record)' }
	},
	observed_flow_other: {
		values: { key: 'observed_flow_other_filled', label: 'Other observed flow: filled gap days only (interpolated or from a donor record)' },
		code: { key: 'observed_flow_other_fill', label: 'Other observed flow gap fill (1 = interpolated, 2 = from a donor record)' }
	}
} as const;

/**
 * A reading (a finite value ≥ 0) in `s` on an epoch day before `day`: whether an input carries a record's history
 * before a resumed run's start (the gap fill here, the quality flags in ../calibrate/dayFlags.ts, ../run.ts).
 */
export function hasReadingBefore(s: DailySeries | null | undefined, day: number): boolean {
	if (!s) return false;
	const n = Math.min(s.values.length, day - toEpochDay(s.startDate));
	for (let i = 0; i < n; i++) {
		const v = s.values[i];
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return true;
	}
	return false;
}

/** The donor kinds a record may name (every flow record but itself). */
export const donorOptions = (kind: GapFillKind): GapFillDonor[] => GAP_FILL_DONORS.filter((k) => k !== kind);

/** A kind is one a spec fills. */
export const isGapFillKind = (k: SeriesKind | string): k is GapFillKind => (GAP_FILL_KINDS as readonly string[]).includes(k);
