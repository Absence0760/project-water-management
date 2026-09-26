import { scaleValues, seriesUnit } from '@water-management/engine';
import type { SeriesWriteResult } from '$lib/api/types';

/** What UploadForm reports after a successful upload. */
export interface UploadResult {
	/** The series written, and when the automatic re-run it queued is due (WP-2.11). */
	meta: SeriesWriteResult;
	/** Days that gained a value (merge) or that carry a value (new / replace). */
	added: number;
	changed: number;
	message: string;
}

/**
 * A file's values in the unit the series is stored in (engine units.ts), so a
 * merge compares them with stored days like for like and can fill the file's
 * blank days from stored values: the merge then sends them in that unit, and
 * the server scales nothing. Sent in the file's own unit, a stored m³/s value
 * copied into a blank day of an l/s file came back 1 000 × too small. A unit
 * the table doesn't know is left as given, for the server to refuse.
 */
export function inStoredUnit(kind: string, unit: string, values: (number | null)[]): { unit: string; values: (number | null)[] } {
	const u = seriesUnit(kind, unit);
	return u.ok ? { unit: u.unit, values: scaleValues(values, u.factor) } : { unit, values };
}
