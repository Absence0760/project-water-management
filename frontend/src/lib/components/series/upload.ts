import type { SeriesMeta } from '@water-management/engine';

/** What UploadForm reports after a successful upload. */
export interface UploadResult {
	meta: SeriesMeta;
	/** Days that gained a value (merge) or that carry a value (new / replace). */
	added: number;
	changed: number;
	message: string;
}
