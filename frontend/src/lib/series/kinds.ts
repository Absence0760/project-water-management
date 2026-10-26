import { SERIES_KIND_LABELS, SERIES_KINDS } from '@water-management/engine';

/** The engine's one table (SERIES_KIND_LABELS), which the backend's alert mails name series by too. */
export function kindLabel(kind: string): string {
	return (SERIES_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/** Add data's kind for a rainfall station (issue #553): stored as catchment rain (`rain_catchment_mm`, no site) with the station's details. */
export const STATION_KIND_LABEL = 'Rainfall — station';

/**
 * A stored series' kind as the app names it (issue #589): a rainfall station
 * (catchment rain at no site that carries a station's details, which Add
 * data's *Rainfall — station* sends and Series details edits) is *Rainfall —
 * station*, not the catchment rain kind it is stored as; any other series is
 * its kind's label. A catchment rain series without details (one uploaded as
 * *Rainfall — catchment*, or before #553) keeps the catchment label.
 */
export function seriesKindLabel(s: { kind: string; siteNodeId?: string | null; station?: unknown }): string {
	return s.kind === 'rain_catchment_mm' && !s.siteNodeId && s.station ? STATION_KIND_LABEL : kindLabel(s.kind);
}

/** Default unit implied by the kind's suffix. */
export function defaultUnit(kind: string): string {
	if (kind.endsWith('_mm')) return 'mm';
	if (kind.endsWith('_m3s')) return 'm³/s';
	return '';
}

export const KIND_OPTIONS = SERIES_KINDS.map((k) => ({ value: k, label: kindLabel(k) }));
