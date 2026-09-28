// Pure helpers for the calibration panel and the calibration-window fields.
import type { AnnualVolume, CalibrationStats } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

export interface MetricRow {
	key: string;
	label: string;
	value: string;
	unit?: string;
	/** One-line plain-language explanation. */
	help: string;
}

const pct = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? '–' : `${fmtNum(v, digits)}%`);

/** The metric tiles, in reading order. Fields missing on old runs show "–". */
export function metricRows(c: CalibrationStats): MetricRow[] {
	return [
		{
			key: 'nse',
			label: 'Nash–Sutcliffe (NSE)',
			value: fmtNum(c.nse, 2),
			help: '1 is a perfect fit; 0 or below is no better than always predicting the observed mean.'
		},
		{
			key: 'kge',
			label: 'Kling–Gupta (KGE)',
			value: fmtNum(c.kge, 2),
			help: 'Combines timing, variability and volume; 1 is perfect, above −0.41 beats the mean flow.'
		},
		{
			key: 'pbias',
			label: 'Percent bias (PBIAS)',
			value: pct(c.pbias),
			help: 'Share of observed volume the model misses; positive = model too dry, negative = too wet.'
		},
		{
			key: 'logNse',
			label: 'Log NSE (low flows)',
			value: fmtNum(c.logNse, 2),
			help: 'NSE on the logarithm of flow, so dry-season flows count as much as floods.'
		},
		{
			key: 'r2',
			label: 'R²',
			value: fmtNum(c.r2, 2),
			help: 'Share of the day-to-day variation in observed flow that the model follows.'
		},
		{
			key: 'volumeErrorPct',
			label: 'Volume error',
			value: pct(c.volumeErrorPct),
			help: 'Simulated minus observed volume over the window, as a share of observed.'
		},
		{
			key: 'rmseM3s',
			label: 'RMSE',
			value: fmtNum(c.rmseM3s, 3),
			unit: 'm³/s',
			help: 'Typical size of a daily error, in flow units.'
		}
	];
}

/** KGE components as a short sentence: "r 0.74 · α 1.06 · β 1.18". */
export function kgeComponents(c: CalibrationStats): string | null {
	if (c.kgeR == null && c.kgeAlpha == null && c.kgeBeta == null) return null;
	return `r ${fmtNum(c.kgeR, 2)} · α ${fmtNum(c.kgeAlpha, 2)} · β ${fmtNum(c.kgeBeta, 2)}`;
}

/** True when the run predates engine 0.3.0 and lacks the extended metrics. */
export function isLegacyStats(c: CalibrationStats): boolean {
	return c.kge === undefined && c.annualVolumes === undefined;
}

/** Water year 2010 → "2010/11"; 1999 → "1999/00". */
export function waterYearLabel(y: number): string {
	return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

/** A year with observations on under 90% of its window days is flagged as partial. */
export function isPartYear(y: AnnualVolume): boolean {
	return y.days < 0.9 * y.daysInWindow;
}

export const FLOW_KIND_LABEL: Record<string, string> = {
	flow_observed_m3s: 'Observed gauge flow',
	flow_logger_m3s: 'Logger flow'
};

/** The simulated series a calibration was scored against: the outflow for a
 *  gauge or logger. `natural_flow` only appears on runs from engine ≤ 0.9.0,
 *  which could score a Pitman record (docs/engine-audit.md C1, P1). */
export const SIMULATED_LABEL: Record<NonNullable<CalibrationStats['simulatedKey']>, string> = {
	natural_flow: 'Simulated natural flow (before hydrological units and dams)',
	simulated_outflow: 'Simulated outflow at the outlet'
};

/** Validation message for a calibration window, or null when it is fine. */
export function windowError(start: string | null, end: string | null): string | null {
	const iso = /^\d{4}-\d{2}-\d{2}$/;
	for (const [label, v] of [
		['start', start],
		['end', end]
	] as const) {
		if (v && (!iso.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) return `Calibration ${label} must be a date (YYYY-MM-DD).`;
	}
	if (start && end && start > end) return 'Calibration start must be before the end.';
	return null;
}

/** "2005-10-01 – 2012-09-30", "from 2005-10-01", "whole record". */
export function describeWindow(start: string | null | undefined, end: string | null | undefined): string {
	if (start && end) return `${start} – ${end}`;
	if (start) return `from ${start}`;
	if (end) return `up to ${end}`;
	return 'whole record';
}
