// The assistant's answers, parsed into a small tree the sheet renders as Svelte
// elements (AnswerText.svelte; issue #610, docs/ui.md § Assistant). Models
// write Markdown whatever they are told, and raw `**bold**`, `### headings`,
// `---` and `- ` lists read badly as literal characters (the 2026-10-30
// production test). The sheet shows a small subset, which the system prompt
// names (backend/src/assistant/prompt.ts): paragraphs, bullet and numbered
// lists, **bold**; a heading shows as a bold line, a horizontal rule as a
// paragraph break, `code` and *italics* as themselves without their marks, a
// fenced block as preformatted text. Anything else (a table, a link, HTML)
// stays text as written.
//
// Safe by construction: the tree holds only strings, every one rendered as a
// text node through Svelte's escaping, never `{@html}` (rawHtml.test.ts). No
// link is made, so a URL in an answer is text. Linear time: each marker is
// matched with one forward search, so a long or hostile line can't backtrack.
//
// Streaming: the text is parsed again as each delta arrives, so an answer
// changes shape only where the markup decides it. With `streaming`, the last
// line's unclosed `**` or backtick runs to the end as bold or code (the closing
// mark is usually a delta away), and a last line that is only the start of a
// marker ("#", "-", "1.", "*") isn't shown yet, so no stray mark flashes up.

export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };

/** A paragraph's lines (kept apart, as the answer broke them), a heading, a list, or a fenced block. */
export type Block =
	| { kind: 'p'; lines: Inline[][] }
	| { kind: 'heading'; parts: Inline[] }
	| { kind: 'ul'; items: Inline[][] }
	| { kind: 'ol'; start: number; items: Inline[][] }
	| { kind: 'pre'; text: string };

const isSpace = (c: string | undefined) => c === undefined || c === ' ' || c === '\t';
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** One line's inline marks: **bold**, *italics*, `code`. Unmatched marks are text. */
export function parseInline(line: string, open = false): Inline[] {
	const out: Inline[] = [];
	let buf = '';
	const flush = () => {
		if (buf) out.push({ kind: 'text', text: buf });
		buf = '';
	};
	let i = 0;
	while (i < line.length) {
		const c = line[i]!;
		if (c === '*' && line[i + 1] === '*') {
			const end = line.indexOf('**', i + 2);
			if (end > i + 2) {
				flush();
				out.push({ kind: 'strong', text: line.slice(i + 2, end) });
				i = end + 2;
				continue;
			}
			if (end === -1 && open) {
				// Streaming: its close is still to come.
				flush();
				if (i + 2 < line.length) out.push({ kind: 'strong', text: line.slice(i + 2) });
				return out;
			}
			buf += '**';
			i += 2;
			continue;
		}
		if (c === '`') {
			const end = line.indexOf('`', i + 1);
			if (end > i + 1) {
				flush();
				out.push({ kind: 'code', text: line.slice(i + 1, end) });
				i = end + 1;
				continue;
			}
			if (end === -1 && open) {
				flush();
				if (i + 1 < line.length) out.push({ kind: 'code', text: line.slice(i + 1) });
				return out;
			}
			buf += c;
			i++;
			continue;
		}
		// *italics* only where the asterisks stand apart from a word, so 5*3*2 or a*b stays as written.
		if (c === '*' && !isWord(line[i - 1]) && !isSpace(line[i + 1])) {
			const end = line.indexOf('*', i + 1);
			if (end > i + 1 && line[end + 1] !== '*' && !isSpace(line[end - 1]) && !isWord(line[end + 1])) {
				flush();
				out.push({ kind: 'em', text: line.slice(i + 1, end) });
				i = end + 1;
				continue;
			}
		}
		buf += c;
		i++;
	}
	flush();
	return out;
}

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^[ \t]*[-*+•][ \t]+(.*)$/;
const NUMBERED = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
/** A fenced block ends only at a bare fence line, so ```js inside it stays text. */
const FENCE_END = /^ {0,3}(```|~~~)[ \t]*$/;
/** A line that is only the start of a marker, while it streams. */
const PARTIAL = /^[ \t]*(#{1,6}|[-*+•_]{1,2}|\d{1,9}[.)]?|`{1,2}|~{1,2})[ \t]*$/;

/** A heading's words without its closing #s ("## Fit ##" → "Fit"), by hand: a regex for it backtracks on long runs of spaces. */
function headingText(raw: string): string {
	let t = raw.trimEnd();
	let k = t.length;
	while (k > 0 && t[k - 1] === '#') k--;
	if (k < t.length && (k === 0 || isSpace(t[k - 1]))) t = t.slice(0, k).trimEnd();
	return t;
}

/** The answer's blocks. `streaming`: the text is still arriving (see the header). */
export function parseAnswer(text: string, streaming = false): Block[] {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	if (streaming && lines.length && PARTIAL.test(lines.at(-1)!)) lines.pop();
	const blocks: Block[] = [];
	// The block being built: a paragraph or list gathers lines until a blank line or another kind ends it.
	let cur: Block | null = null;
	// A blank line (or a rule) after a list: the list goes on if the next item is of the same kind (a loose list).
	let gap = false;
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n]!;
		const open = streaming && n === lines.length - 1;
		if (cur?.kind === 'pre') {
			if (FENCE_END.test(line)) {
				blocks.push(cur);
				cur = null;
			} else cur.text += (cur.text ? '\n' : '') + line;
			continue;
		}
		const h = HEADING.exec(line);
		const b = h ? null : BULLET.exec(line);
		const o = h || b ? null : NUMBERED.exec(line);
		const blank = !line.trim() || RULE.test(line);
		// A blank line inside a list leaves it open for its next item; a rule ends it.
		if (!line.trim() && (cur?.kind === 'ul' || cur?.kind === 'ol')) {
			gap = true;
			continue;
		}
		// An indented line under a list item carries the item on.
		if (!gap && (cur?.kind === 'ul' || cur?.kind === 'ol') && !h && !b && !o && !blank && !FENCE.test(line) && /^[ \t]+\S/.test(line)) {
			cur.items.at(-1)!.push({ kind: 'text', text: ' ' }, ...parseInline(line.trim(), open));
			continue;
		}
		const kind = FENCE.test(line) ? 'pre' : blank ? null : h ? 'heading' : b ? 'ul' : o ? 'ol' : 'p';
		if (cur && cur.kind !== kind) {
			blocks.push(cur);
			cur = null;
		}
		gap = false;
		if (kind === 'pre') cur = { kind: 'pre', text: '' };
		else if (kind === 'heading') {
			const parts = parseInline(headingText(h![1]!), open);
			if (parts.length) blocks.push({ kind: 'heading', parts });
		}
		else if (kind === 'ul') {
			cur ??= { kind: 'ul', items: [] };
			if (cur.kind === 'ul') cur.items.push(parseInline(b![1]!, open));
		} else if (kind === 'ol') {
			cur ??= { kind: 'ol', start: Number(o![1]), items: [] };
			if (cur.kind === 'ol') cur.items.push(parseInline(o![2]!, open));
		} else if (kind === 'p') {
			cur ??= { kind: 'p', lines: [] };
			if (cur.kind === 'p') cur.lines.push(parseInline(line, open));
		}
	}
	if (cur) blocks.push(cur);
	return blocks;
}
