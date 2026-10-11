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

/**
 * One box's Expected format (issue #477): the words FormatHelp shows beside
 * the box and the File formats help page (/help/formats) shows under its
 * title, from this one object, so the two can't differ. Kept beside the
 * box's parser, whose tests read the example back through it. The text takes
 * a small markup (formatInline): `code` in a monospace face, **bold**, *italics*.
 */
export interface FileFormat {
	/** Its anchor on the File formats page (`/help/formats#<id>`): lowercase, hyphenated, unique (fileFormats.test.ts). */
	id: string;
	/** Its heading on the File formats page ("Planted areas, a row per planting"). */
	title: string;
	/** Where in the app the box is, for the File formats page ("Crops & demand → Import plantings"). */
	where: string;
	/** The file types (and limits) the box takes, as a sentence: "CSV (.csv), at most 2 MB." */
	accepts: string;
	/** A paragraph before the rules. */
	lead?: string;
	/** The structure, a line each: columns, units, what is read as a gap, what is refused. */
	rules: readonly string[];
	/** A paragraph after the rules. */
	after?: string;
	/** A few lines of a valid file, shown as they would be typed. */
	example?: string;
	/** Example files to download (each with its own words when there are several). */
	files?: readonly ExampleFile[];
}

/** A run of format text: plain, `code`, **bold** or *italics*. */
export type FormatPart = { kind: 'text' | 'code' | 'strong' | 'em'; text: string };

const FORMAT_INLINE = /`([^`]+)`|\*\*(.+?)\*\*|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g;

/** Splits format text into its runs (never HTML, so nothing is {@html}). */
export function formatInline(text: string): FormatPart[] {
	const out: FormatPart[] = [];
	let last = 0;
	for (const m of text.matchAll(FORMAT_INLINE)) {
		if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
		last = m.index + m[0].length;
		if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
		else if (m[2] !== undefined) out.push({ kind: 'strong', text: m[2] });
		else out.push({ kind: 'em', text: m[3]! });
	}
	if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
	return out;
}

/** Format text with the markup removed (a test reading the words, a search). */
export const formatPlain = (text: string) =>
	formatInline(text)
		.map((p) => p.text)
		.join('');

/** The File formats help page's path for one format (`base` is prepended by the caller). */
export const formatPath = (id: string) => `/help/formats#${id}`;
