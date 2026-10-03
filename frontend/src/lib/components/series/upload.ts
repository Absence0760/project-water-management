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

/** The form's submit button, for a dialog that draws it in its own action row (series/AddDataDialog.svelte). */
export interface UploadSubmit {
	label: string;
	disabled: boolean;
	/** Asking before an overwrite: the row shows Back beside the button. */
	confirming: boolean;
	/** The upload is on its way: the dialog can't be closed (the request would finish anyway). */
	uploading: boolean;
}

/**
 * A file's values in the unit the series is stored in (engine units.ts), so
 * the merge preview compares them with stored days like for like: compared
 * raw, 1 200 l/s against a stored 1.2 m³/s counted as a changed day. A unit
 * the table doesn't know is left as given, for the server to refuse.
 */
export function inStoredUnit(kind: string, unit: string, values: (number | null)[]): { unit: string; values: (number | null)[] } {
	const u = seriesUnit(kind, unit);
	return u.ok ? { unit: u.unit, values: scaleValues(values, u.factor) } : { unit, values };
}

/**
 * Reads a picked file's text, the latest pick only: a read that a later pick
 * (or a cleared one, null) started after resolves to null, so a large file
 * still being read can't land over a smaller one picked after it (the form
 * would show and upload the first file's days under the second's name).
 */
export function latestFileText(): (f: Pick<Blob, 'text'> | null) => Promise<string | null> {
	let latest = 0;
	return async (f) => {
		const mine = ++latest;
		if (!f) return null;
		let text: string;
		try {
			text = await f.text();
		} catch (err) {
			if (mine !== latest) return null; // a superseded read's failure is no longer news
			throw err;
		}
		return mine === latest ? text : null;
	};
}
