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

/**
 * A volume bias in plain words, the calibration panel's one convention
 * (issue #51): "57.6% too dry", "12.3% too wet", "0.0%". PBIAS (Moriasi:
 * positive = too dry) and the volume error (positive = too wet) are the
 * same quantity with opposite signs; side by side, "+57.6 %" and "−57.6 %"
 * read as two different answers, so the panel shows neither sign.
 * `simMinusObsPct`: 100 × (Σsim − Σobs) / Σobs, the volume error.
 */
export function volumeBiasText(simMinusObsPct: number | null | undefined): string {
	if (simMinusObsPct == null || !Number.isFinite(simMinusObsPct)) return '–';
	if (Math.abs(simMinusObsPct) < 0.05) return `${fmtNum(0, 1)}%`;
	return `${fmtNum(Math.abs(simMinusObsPct), 1)}% too ${simMinusObsPct < 0 ? 'dry' : 'wet'}`;
}

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
			label: 'Volume bias (PBIAS)',
			// PBIAS is 100 × Σ(obs − sim)/Σobs, the volume error's negative.
			value: volumeBiasText(c.pbias == null ? null : -c.pbias),
			help: 'How much less water (too dry) or more (too wet) the model gives than was observed over the scored days. Exports carry it signed as PBIAS: positive = too dry.'
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
