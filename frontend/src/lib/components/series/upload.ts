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
