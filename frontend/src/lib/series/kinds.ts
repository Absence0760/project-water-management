import { SERIES_KIND_LABELS, SERIES_KINDS } from '@water-management/engine';

/** The engine's one table (SERIES_KIND_LABELS), which the backend's alert mails name series by too. */
export function kindLabel(kind: string): string {
	return (SERIES_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/** Default unit implied by the kind's suffix. */
export function defaultUnit(kind: string): string {
	if (kind.endsWith('_mm')) return 'mm';
	if (kind.endsWith('_m3s')) return 'm³/s';
	return '';
}

export const KIND_OPTIONS = SERIES_KINDS.map((k) => ({ value: k, label: kindLabel(k) }));
