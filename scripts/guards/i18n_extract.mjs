// The frontend's messages, read from the source (WP-2.5; docs/ui.md
// § Language). A message is its English, written where it is used; this finds
// every one for the translation sheet (i18n_sheet.mjs), gettext style:
//
//   t('English', vars?, 'context?')      tRich('English', vars?, 'context?')
//   t(cond ? 'One' : 'Other', …)          every string leaf of a ?: chain
//   msg('English')                        a message kept in a table or a variable
//   plural({ one: '…', other: '…' })     a counted word's forms (tn() takes it)
//   tn({ one: '…', other: '…' }, n)      the same, written at the call
//
// Only files that import $lib/i18n/locale.svelte or $lib/i18n/msg are read,
// and only their code: comments, and the text of a Svelte component's markup,
// are skipped (a `{…}` expression in the markup is code).
//
// Each message belongs to a section of the sheet, set by a marker comment
// before it in its file (`// i18n-section: farm.dam`, or
// `<!-- i18n-section: account -->` in a component's markup); a marker holds
// until the next one. A message used in more than one section goes to
// `common`. The sections' descriptions and the translator's notes live in
// frontend/src/lib/i18n/sheet.ts.
//
// Plain JavaScript, no dependencies (the estate's guard pattern); ids come from
// frontend/src/lib/i18n/msg.ts, the same code the app runs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SRC = 'frontend/src';

const { messageId, pluralId, PLURAL_CATEGORIES } = await import(pathToFileURL(path.join(ROOT, 'frontend/src/lib/i18n/msg.ts')).href);
export { messageId, pluralId, PLURAL_CATEGORIES };

/** A file whose code can hold messages: it imports the message functions or msg(). */
const USES_I18N = /\bfrom\s+['"](?:\$lib\/i18n|\.{1,2}(?:\/[\w.-]+)*)\/(?:locale\.svelte|msg)['"]/;
const MARKER = /i18n-section:\s*([\w.-]+)/;

// ---- Lexing: code only, with every position kept ------------------------------

/** Characters after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await']);

/**
 * Scans JavaScript from `i` and calls back for comments; stops at an
 * unmatched `}` (when `inBraces`) or the end. Returns the index it stopped at.
 * `out` is the code with comments blanked to spaces.
 */
function scanJs(src, i, end, out, onComment, inBraces) {
	let depth = 0;
	let last = '';
	let lastWord = '';
	while (i < end) {
		const c = src[i];
		const next = src[i + 1];
		if (c === '/' && next === '/') {
			const stop = src.indexOf('\n', i);
			const j = stop < 0 || stop > end ? end : stop;
			onComment(src.slice(i, j), i);
			for (let k = i; k < j; k++) out[k] = ' ';
			i = j;
			continue;
		}
		if (c === '/' && next === '*') {
			const stop = src.indexOf('*/', i + 2);
			const j = stop < 0 ? end : stop + 2;
			onComment(src.slice(i, j), i);
			for (let k = i; k < j; k++) if (src[k] !== '\n') out[k] = ' ';
			i = j;
			continue;
		}
		if (c === '"' || c === "'") {
			i = skipString(src, i, c);
			last = 'str';
			continue;
		}
		if (c === '`') {
			i = skipTemplate(src, i, out, onComment);
			last = 'str';
			continue;
		}
		if (c === '/' && (REGEX_AFTER.has(last) || (last === 'id' && REGEX_KEYWORDS.has(lastWord)))) {
			i = skipRegex(src, i);
			last = 'regex';
			continue;
		}
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (/[\w$]/.test(c)) {
			lastWord = /^[\w$]+/.exec(src.slice(i, i + 200))[0];
			last = 'id';
			i += lastWord.length;
			continue;
		}
		if (c === '{') depth++;
		if (c === '}') {
			if (inBraces && depth === 0) return i;
			depth--;
		}
		last = c;
		i++;
	}
	return i;
}

function skipString(src, i, quote) {
	i++;
	while (i < src.length && src[i] !== quote) {
		if (src[i] === '\\') i++;
		else if (src[i] === '\n') break;
		i++;
	}
	return i + 1;
}

function skipTemplate(src, i, out, onComment) {
	i++;
	while (i < src.length && src[i] !== '`') {
		if (src[i] === '\\') i += 2;
		else if (src[i] === '$' && src[i + 1] === '{') i = scanJs(src, i + 2, src.length, out, onComment, true) + 1;
		else i++;
	}
	return i + 1;
}

function skipRegex(src, i) {
	i++;
	let cls = false;
	while (i < src.length && src[i] !== '\n') {
		const c = src[i];
		if (c === '\\') i++;
		else if (c === '[') cls = true;
		else if (c === ']') cls = false;
		else if (c === '/' && !cls) break;
		i++;
	}
	i++;
	while (/[a-z]/.test(src[i] ?? '')) i++;
	return i;
}

/**
 * The file with everything but code blanked to spaces (positions and line
 * breaks kept), and its section markers in order: [{ at, section }].
 */
export function codeOf(src, file) {
	const markers = [];
	const onComment = (text, at) => {
		const m = MARKER.exec(text);
		if (m) markers.push({ at, section: m[1] });
	};
	if (!file.endsWith('.svelte')) {
		const out = src.split('');
		scanJs(src, 0, src.length, out, onComment, false);
		return { code: out.join(''), markers };
	}
	const out = src.split('').map((c) => (c === '\n' ? '\n' : ' '));
	const code = src.split('');
	let i = 0;
	while (i < src.length) {
		if (src.startsWith('<!--', i)) {
			const stop = src.indexOf('-->', i);
			const j = stop < 0 ? src.length : stop + 3;
			onComment(src.slice(i, j), i);
			i = j;
			continue;
		}
		const block = /^<(script|style)\b[^>]*>/.exec(src.slice(i, i + 200));
		if (block) {
			const open = i + block[0].length;
			const close = src.indexOf(`</${block[1]}>`, open);
			const j = close < 0 ? src.length : close;
			if (block[1] === 'script') {
				scanJs(src, open, j, code, onComment, false);
				for (let k = open; k < j; k++) out[k] = code[k];
			}
			i = j + block[1].length + 3;
			continue;
		}
		if (src[i] === '{') {
			const j = scanJs(src, i + 1, src.length, code, onComment, true);
			for (let k = i; k <= j && k < src.length; k++) out[k] = code[k];
			i = j + 1;
			continue;
		}
		i++;
	}
	return { code: out.join(''), markers };
}

// ---- Reading the calls ----------------------------------------------------------

/** The value of a string literal at `code[i]` ('…', "…" or `…` without ${}), or null. */
function literalAt(code, i) {
	const q = code[i];
	if (q !== "'" && q !== '"' && q !== '`') return null;
	const end = q === '`' ? skipTemplate(code, i, code.split(''), () => {}) : skipString(code, i, q);
	const raw = code.slice(i, end);
	if (q === '`' && /\$\{/.test(raw)) return { end, value: null, raw };
	// The literal's value, the way JavaScript reads it (its escapes).
	const body = raw.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
		if (e[0] === 'u') return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
		if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
		return { n: '\n', t: '\t', r: '\r', '0': '\0', '\n': '' }[e] ?? e;
	});
	return { end, value: body, raw };
}

/** Tokens of an argument list from `(`: strings, punctuation and words, with depth. Stops at the matching `)`. */
function tokens(code, open) {
	const out = [];
	let depth = 0;
	let i = open;
	while (i < code.length) {
		const c = code[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const lit = literalAt(code, i);
		if (lit) {
			out.push({ type: 'str', value: lit.value, raw: lit.raw, depth, at: i });
			i = lit.end;
			continue;
		}
		if ('([{'.includes(c)) {
			out.push({ type: 'open', value: c, depth, at: i });
			depth++;
			i++;
			continue;
		}
		if (')]}'.includes(c)) {
			depth--;
			out.push({ type: 'close', value: c, depth, at: i });
			i++;
			if (depth === 0) break;
			continue;
		}
		const word = /^[\w$.]+/.exec(code.slice(i, i + 200));
		if (word) {
			out.push({ type: 'word', value: word[0], depth, at: i });
			i += word[0].length;
			continue;
		}
		// Multi-character operators matter only as "not ? or :".
		out.push({ type: 'punct', value: c, depth, at: i });
		i++;
	}
	return out;
}

/** The tokens of each top-level argument (depth 1 inside the call's parentheses). */
function splitArgs(toks) {
	const args = [[]];
	for (const tk of toks.slice(1, -1)) {
		if (tk.depth === 1 && tk.type === 'punct' && tk.value === ',') args.push([]);
		else args[args.length - 1].push(tk);
	}
	return args.filter((a, i) => a.length || i === 0);
}

const isQ = (tk, depth) => tk && tk.type === 'punct' && (tk.value === '?' || tk.value === ':') && tk.depth === depth;

/**
 * The string leaves of an argument: the whole argument, or each branch of a
 * ?: chain, also inside grouping parentheses (`a ? (b ? 'x' : 'y') : 'z'`).
 * A literal in a condition (`lang === 'en' ? …`) or passed to another call
 * isn't one.
 */
function leaves(arg) {
	const out = [];
	/** The '(' at arg[i] groups (it doesn't call or index what precedes it). */
	const grouping = (i) => arg[i]?.type === 'open' && arg[i].value === '(' && !['word', 'close', 'str'].includes(arg[i - 1]?.type ?? '');
	arg.forEach((tk, i) => {
		if (tk.type !== 'str') return;
		const before = arg[i - 1];
		const after = arg[i + 1];
		const startsBranch = !before || isQ(before, tk.depth) || (grouping(i - 1) && before.depth === tk.depth - 1);
		const endsBranch = !after || (after.type === 'punct' && after.value === ':' && after.depth === tk.depth) || (after.type === 'close' && after.value === ')' && after.depth === tk.depth - 1);
		if (startsBranch && endsBranch) out.push(tk);
	});
	return out;
}

/** A plural's forms from an object literal argument `{ one: '…', other: '…' }`, or null. */
function formsOf(arg) {
	if (arg[0]?.type !== 'open' || arg[0].value !== '{') return null;
	const forms = {};
	for (let i = 1; i < arg.length; i++) {
		const [key, colon, value] = [arg[i], arg[i + 1], arg[i + 2]];
		if (key.depth === 2 && key.type === 'word' && colon?.value === ':' && value?.type === 'str') forms[key.value] = value;
	}
	return forms;
}

/** A call of one of the message functions: not a method (`x.t(`), but a spread (`...tRich(`) is one. */
const CALL = /(?<![\w$])(?<!(?:^|[^.])\.)(t|tRich|tn|msg|plural)\s*\(/g;

/**
 * Every message in one file: [{ kind: 'text' | 'plural', english | forms,
 * context, at, line, section }], and problems ([string]).
 */
export function messagesIn(src, file) {
	const { code, markers } = codeOf(src, file);
	const found = [];
	const problems = [];
	const lineOf = (at) => src.slice(0, at).split('\n').length;
	const sectionAt = (at) => {
		let s = null;
		for (const m of markers) if (m.at < at) s = m.section;
		return s;
	};
	for (const m of code.matchAll(CALL)) {
		const fn = m[1];
		const open = m.index + m[0].length - 1;
		const args = splitArgs(tokens(code, open));
		const where = `${file}:${lineOf(m.index)}`;
		if (fn === 'tn' || fn === 'plural') {
			const forms = formsOf(args[0] ?? []);
			if (!forms) continue; // tn(DAYS, n): the forms were read at plural()
			const english = {};
			for (const [k, tk] of Object.entries(forms)) {
				if (!PLURAL_CATEGORIES.includes(k)) problems.push(`${where}: "${k}" isn't a plural category (${PLURAL_CATEGORIES.join(', ')})`);
				else if (tk.value == null) problems.push(`${where}: a plural form can't be a template with \${…}; use {placeholders}`);
				else english[k] = tk.value;
			}
			if (english.other == null) problems.push(`${where}: a plural needs an "other" form`);
			else found.push({ kind: 'plural', forms: english, context: undefined, at: m.index, line: lineOf(m.index), file, section: sectionAt(m.index) });
			continue;
		}
		const context = fn === 'msg' ? undefined : args[2]?.length === 1 && args[2][0].type === 'str' ? args[2][0].value : undefined;
		if (fn !== 'msg' && args[2]?.length && context === undefined) problems.push(`${where}: a message's context must be a string literal`);
		for (const leaf of leaves(args[0] ?? [])) {
			if (leaf.value == null) {
				problems.push(`${where}: a message can't be a template with \${…}; use {placeholders} and vars`);
				continue;
			}
			found.push({ kind: 'text', english: leaf.value, context, at: leaf.at, line: lineOf(leaf.at), file, section: sectionAt(leaf.at) });
		}
	}
	return { found, problems };
}

// ---- The whole frontend ---------------------------------------------------------

function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = path.join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

/** The source files read for messages, repo-relative and sorted. */
export function sourceFiles(root = ROOT) {
	return walk(path.join(root, SRC))
		.map((p) => path.relative(root, p).split(path.sep).join('/'))
		.filter((f) => /\.(ts|svelte)$/.test(f) && !/\.test\.ts$/.test(f) && !/\/i18n\/(sheet|msg)\.ts$|\/i18n\/messages\//.test(f))
		.sort();
}

/**
 * Every message, once each, keyed by id: Map(id → { id, kind, english | forms,
 * context, section, uses: ['file:line'] }), with the problems found.
 * `sections` (sheet.ts SECTIONS) is the list of known section names.
 */
export function extract({ root = ROOT, files = sourceFiles(root), read = (f) => readFileSync(path.join(root, f), 'utf8'), sections = null } = {}) {
	const messages = new Map();
	const problems = [];
	for (const file of files) {
		const src = read(file);
		if (!USES_I18N.test(src)) continue;
		const r = messagesIn(src, file);
		problems.push(...r.problems);
		for (const f of r.found) {
			const where = `${file}:${f.line}`;
			if (!f.section) {
				problems.push(`${where}: no section for "${f.english ?? f.forms.other}"; add an i18n-section marker comment before it`);
				continue;
			}
			if (sections && !sections.includes(f.section)) problems.push(`${where}: unknown section "${f.section}" (add it to frontend/src/lib/i18n/sheet.ts SECTIONS)`);
			const id = f.kind === 'plural' ? pluralId(f.forms, f.context) : messageId(f.english, f.context);
			const have = messages.get(id);
			if (have) {
				const same = f.kind === have.kind && (f.kind === 'plural' ? JSON.stringify(f.forms) === JSON.stringify(have.forms) : f.english === have.english) && f.context === have.context;
				if (!same) {
					problems.push(`${where}: id ${id} is also ${have.uses[0]}'s message; give one of them a context`);
					continue;
				}
				have.uses.push(where);
				have.sections.add(f.section);
				continue;
			}
			messages.set(id, { id, kind: f.kind, english: f.english, forms: f.forms, context: f.context, sections: new Set([f.section]), uses: [where] });
		}
	}
	for (const m of messages.values()) {
		m.section = m.sections.size > 1 ? 'common' : [...m.sections][0];
		delete m.sections;
	}
	return { messages, problems };
}
