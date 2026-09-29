// The Calibration record's quality-flag fields (settings.qualityFlags, engine
// ≥ 1.20.0, calibration research CR-18/19): each record's gauged range and
// how the fit scores flagged days. The form's error mirrors the backend's
// SettingsPatch (the engine's ratingError), so Save is blocked with a
// readable message instead of a 400. QualityFlagsFields.svelte renders it.
import { CALIBRATION_FLOW_KINDS, ratingError, type CalibrationFlowKind, type GaugeRating, type QualityFlagSettings } from '@water-management/engine';

export const RECORD_NAME: Record<CalibrationFlowKind, string> = { flow_observed_m3s: 'Gauge record', flow_logger_m3s: 'Logger record' };

export const ABOVE_OPTIONS = [
	{ value: 'censor', label: 'Censor: only ask the model to reach the highest gauging (default)' },
	{ value: 'exclude', label: 'Leave out' },
	{ value: 'include', label: 'Score as recorded' }
] as const;
export const FLAG_OPTIONS = [
	{ value: 'exclude', label: 'Leave out (default)' },
	{ value: 'include', label: 'Score as recorded' }
] as const;

/** The records a gauged range can be entered for: those the project has, or both when not known. */
export function ratedKinds(seriesKinds: readonly string[] | null): CalibrationFlowKind[] {
	return CALIBRATION_FLOW_KINDS.filter((k) => seriesKinds === null || seriesKinds.includes(k));
}

const EMPTY: GaugeRating = { gaugedMaxM3s: null, gaugedMinM3s: null, source: '' };

/** A record's rating as the form shows it (empty when none). */
export const ratingField = (q: QualityFlagSettings, kind: CalibrationFlowKind): GaugeRating => q.ratings[kind] ?? EMPTY;

/**
 * The ratings with one record's fields changed. A rating left with no bound
 * and no source is removed, so an emptied form stores nothing.
 */
export function withRating(ratings: QualityFlagSettings['ratings'], kind: CalibrationFlowKind, patch: Partial<GaugeRating>): QualityFlagSettings['ratings'] {
	const next = { ...(ratings[kind] ?? EMPTY), ...patch };
	const out = { ...ratings };
	if (next.gaugedMaxM3s === null && next.gaugedMinM3s === null && !next.source.trim()) delete out[kind];
	else out[kind] = next;
	return out;
}

/** The first problem with the form's quality-flag settings, or null. */
export function qualityFlagsError(q: QualityFlagSettings | null | undefined): string | null {
	for (const k of CALIBRATION_FLOW_KINDS) {
		const r = q?.ratings?.[k];
		if (!r) continue;
		const err = ratingError(r);
		if (err) return `${RECORD_NAME[k]} gauged range: ${err.charAt(0).toUpperCase()}${err.slice(1)}.`;
	}
	return null;
}
