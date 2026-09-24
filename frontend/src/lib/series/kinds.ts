import { SERIES_KINDS, type SeriesKind } from '@water-management/engine';

const LABELS: Record<SeriesKind, string> = {
	rain_catchment_mm: 'Rainfall — catchment',
	rain_chirps_mm: 'Rainfall — CHIRPS',
	rain_forecast_mm: 'Rainfall — forecast',
	flow_observed_m3s: 'Flow — observed gauge',
	flow_logger_m3s: 'Flow — logger',
	flow_reference_m3s: 'Flow — reference gauge (other catchment)'
};

export function kindLabel(kind: string): string {
	return (LABELS as Record<string, string>)[kind] ?? kind;
}

/** Default unit implied by the kind's suffix. */
export function defaultUnit(kind: string): string {
	if (kind.endsWith('_mm')) return 'mm';
	if (kind.endsWith('_m3s')) return 'm³/s';
	return '';
}

export const KIND_OPTIONS = SERIES_KINDS.map((k) => ({ value: k, label: kindLabel(k) }));
