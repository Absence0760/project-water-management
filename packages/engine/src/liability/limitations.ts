// The known limitations a validation statement and a sign-off show (roadmap
// WP-3.13): generated from docs/engine-audit.md, so an open audit item can't
// be left out quietly. An item is open while its decision still waits on
// someone's judgement: "pending the hydrologist" (or the assessor), "Needs
// hydrologist", or an item that is only warned about or built off by
// default. Fixed and removed items are closed.
//
// The parser is pure (it takes the Markdown as a string). The list the app
// uses is the committed limitations.generated.ts, written by
// `pnpm gen:limitations`; limitations.test.ts parses the doc again and fails
// when the two differ, so a change to an audit item's status has to
// regenerate the list in the same change.

export interface Limitation {
	/** The audit's own id: H1, N2, B3, W1–W5, Q17 … */
	id: string;
	/** Which table of engine-audit.md it came from. */
	source: 'finding' | 'quirk';
	/** The finding's severity column; null for a workbook quirk. */
	severity: string | null;
	/** What is wrong or uncertain, in one sentence. */
	title: string;
	/** Where it stands: the decision's lead ("Decided (…; pending the hydrologist) — engine 0.16.0"). */
	status: string;
}

/** Plain text from a table cell: no bold, italics, code ticks or link targets. */
export function plainMarkdown(s: string): string {
	// Bracketed spans exclude "[" and whitespace is collapsed first: a long run of "[" or of spaces
	// otherwise made each pattern rescan the rest of the cell from every position (CodeQL js/polynomial-redos).
	return s
		.replace(/\s+/g, ' ')
		.replace(/\[([^[\]]+)\]\([^)]*\)/g, '$1')
		// Reference-style citations ([Beven 2012]) are for the doc's reader, not a limitation list.
		.replace(/ ?\(\[[^[\]]+\]\)/g, '')
		.replace(/\[([^[\]]+)\]/g, '$1')
		.replace(/\*\*/g, '')
		.replace(/(^|[\s(])\*([^*]+)\*/g, '$1$2')
		.replace(/`/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The first bold span; failing that, the sentence that says what is pending, or the first sentence. */
function lead(cell: string): string {
	const bold = /\*\*(.+?)\*\*/.exec(cell);
	if (bold) return plainMarkdown(bold[1]!).replace(/[.:]$/, '');
	const sentences = plainMarkdown(cell).split(/(?<=[.!?])\s+/);
	const text = sentences.find((x) => /\bpending\b/i.test(x)) ?? sentences[0] ?? '';
	return text.replace(/[.:]$/, '');
}

/** Cells of one Markdown table row, splitting on unescaped pipes. */
function cells(row: string): string[] {
	const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
	return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** The body rows of the first table under a `## heading` that starts with `title`. */
function tableUnder(markdown: string, title: string): string[][] {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).startsWith(title));
	if (start < 0) throw new Error(`engine-audit.md has no "## ${title}" section`);
	const rows: string[][] = [];
	let inTable = false;
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i]!;
		if (l.startsWith('## ')) break;
		if (l.startsWith('|')) {
			inTable = true;
			rows.push(cells(l));
		} else if (inTable) break;
	}
	// Header and separator rows.
	return rows.slice(2);
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Open means someone still has to judge it (see the file comment). */
export function isOpenDecision(decision: string): boolean {
	const d = plainMarkdown(decision).toLowerCase();
	return /\bpending\b/.test(d) || d.includes('needs hydrologist') || /^(warned|built)\b/.test(d);
}

/** Every open item of docs/engine-audit.md, findings first then workbook quirks, in the doc's order. */
export function parseAuditLimitations(markdown: string): Limitation[] {
	const out: Limitation[] = [];
	for (const row of tableUnder(markdown, 'Findings')) {
		const [id, severity, , finding, , decision] = row;
		if (!id || finding === undefined || decision === undefined) throw new Error(`engine-audit.md: a findings row has too few columns: ${row.join(' | ')}`);
		if (!isOpenDecision(decision)) continue;
		out.push({ id: plainMarkdown(id), source: 'finding', severity: plainMarkdown(severity ?? ''), title: lead(finding), status: lead(decision) });
	}
	for (const row of tableUnder(markdown, 'Workbook quirks')) {
		const [label, decision] = row;
		if (!label || decision === undefined) throw new Error(`engine-audit.md: a quirks row has too few columns: ${row.join(' | ')}`);
		if (!isOpenDecision(decision)) continue;
		const m = /^(Q\d+(?:,\s*Q\d+)*)\s*(.*)$/.exec(plainMarkdown(label));
		out.push({ id: m?.[1] ?? plainMarkdown(label), source: 'quirk', severity: null, title: capitalise(m?.[2] || plainMarkdown(label)), status: lead(decision) });
	}
	return out;
}
