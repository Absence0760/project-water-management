// The "Expected format" note beside a file or paste box (FormatHelp.svelte,
// issue #456; docs/ui.md § Expected format): the example file it offers to
// download, built in the browser from the same text the note shows, so the
// two can't drift apart and nothing is fetched.

/** An example file the note offers: its name, its text and its media type. */
export interface ExampleFile {
	name: string;
	text: string;
	/** Default `text/csv`. */
	type?: string;
	/** The link's words when a note offers several files ("Download an example .rul, m³/s"); default "Download an example file". */
	label?: string;
}

/**
 * The download link's `href`: a data URL of the example's text. A CSV starts
 * with a byte-order mark, so Excel opens m³ and other non-ASCII text as UTF-8
 * (every CSV reader in the app skips it).
 */
export function exampleHref(file: ExampleFile): string {
	const type = file.type ?? 'text/csv';
	const bom = type === 'text/csv' ? '﻿' : '';
	return `data:${type};charset=utf-8,${encodeURIComponent(bom + file.text)}`;
}
