// A small streaming XML tokenizer for the workbook parts the importer reads
// (WP-1.31 memory fix): bytes in, in whatever chunks the inflater produces;
// start tags, end tags, text and CDATA out, as they're found. Nothing builds
// a tree or holds a whole part, so a 40 MB sheet costs one chunk of memory
// plus whatever the handler keeps.
//
// The parts come from an untrusted upload, so it's strict where that's cheap
// and safe, and never clever:
// - no DTD at all: a <!DOCTYPE …> (or any other <!…> declaration) is refused,
//   so there are no entity definitions to expand. Entity references are left
//   in the text exactly as written; the value decoders below expand only the
//   five XML built-ins and numeric references;
// - every token (a tag with its attributes, a comment, a CDATA section, a
//   processing instruction) has a length cap, so a huge attribute value or an
//   unterminated comment is a typed error, not an unbounded buffer;
// - element nesting is checked (end tags must match, depth is capped, one
//   root, nothing after it), so an unclosed or mismatched tag is a typed error;
// - UTF-16 parts are refused (Excel writes UTF-8; a leading UTF-8 BOM is fine).
//
// Values are handed on as raw bytes in a "binary string" (one char per byte)
// and decoded with a port of SheetJS's utf8read. Cell text (sheet.ts,
// sharedStrings.ts) is then decoded as openpyxl reads it, since the Python
// importer is the reference (decodeXmlText, issue #22); the workbook part's
// names and number formats keep SheetJS's unescapexml (unescapeXml).
import { UnreadableWorkbookError } from './errors';

export interface XmlLimits {
	/** Longest single token: a start tag with its attributes, a comment, CDATA section or processing instruction. */
	maxTokenBytes: number;
	/** Deepest element nesting. */
	maxDepth: number;
}

/** Far beyond anything Excel writes (its longest tags are well under 1 KB, nesting under 20). */
export const XML_LIMITS: XmlLimits = { maxTokenBytes: 1 << 20, maxDepth: 128 };

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QM = 0x3f;
const DQ = 0x22;
const SQ = 0x27;
const EQ = 0x3d;

const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/** Bytes as a binary string, one char per byte (SheetJS reads XML parts this way). */
export function binary(buf: Uint8Array, start: number, end: number): string {
	if (end - start <= 64) {
		let s = '';
		for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]!);
		return s;
	}
	let s = '';
	for (let i = start; i < end; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(end, i + 8192)) as unknown as number[]);
	return s;
}

/**
 * SheetJS's utf8read on its browser code path (utf8reada): UTF-8 bytes held
 * in a binary string → text. Malformed sequences decode the way SheetJS
 * decoded them, not as U+FFFD.
 */
export function utf8read(orig: string): string {
	// Pure ASCII (every cell number, most names) needs no work.
	if (!/[\x80-\xff]/.test(orig)) return orig;
	const out: string[] = [];
	let i = 0;
	while (i < orig.length) {
		const c = orig.charCodeAt(i++);
		if (c < 128) {
			out.push(String.fromCharCode(c));
			continue;
		}
		const d = orig.charCodeAt(i++);
		if (c > 191 && c < 224) {
			out.push(String.fromCharCode(((c & 31) << 6) | (d & 63)));
			continue;
		}
		const e = orig.charCodeAt(i++);
		if (c < 240) {
			out.push(String.fromCharCode(((c & 15) << 12) | ((d & 63) << 6) | (e & 63)));
			continue;
		}
		const f = orig.charCodeAt(i++);
		const w = (((c & 7) << 18) | ((d & 63) << 12) | ((e & 63) << 6) | (f & 63)) - 65536;
		out.push(String.fromCharCode(0xd800 + ((w >>> 10) & 1023)), String.fromCharCode(0xdc00 + (w & 1023)));
	}
	return out.join('');
}

const ENTITIES: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&gt;': '>', '&lt;': '<', '&amp;': '&' };
const ENTITY_RE = /&(?:quot|apos|gt|lt|amp|#x?([\da-fA-F]+));/gi;
const CODE_RE = /_x([\da-fA-F]{4})_/gi;

function replaceEntities(s: string): string {
	return s
		.replace(ENTITY_RE, (all: string, code: string | undefined) => ENTITIES[all] || String.fromCharCode(parseInt(code!, all.indexOf('x') > -1 ? 16 : 10)) || all)
		.replace(CODE_RE, (_m, c: string) => String.fromCharCode(parseInt(c, 16)));
}

/**
 * SheetJS's unescapexml, for the workbook part's sheet names, defined names
 * and number formats (cell text uses decodeXmlText): the five XML entities
 * and numeric references (as UTF-16 code units, as SheetJS does), Excel's
 * _xHHHH_ escapes, and CDATA sections kept literally. Nothing else is
 * expanded. Where a CDATA section is unterminated or its end comes first
 * (never in well-formed XML), the rest is decoded as plain text; SheetJS's
 * recursion there was quadratic in the value's length.
 */
export function unescapeXml(text: string): string {
	let out = '';
	let s = text;
	for (;;) {
		const i = s.indexOf('<![CDATA[');
		if (i === -1) {
			out += replaceEntities(s);
			break;
		}
		const j = s.indexOf(']]>');
		if (j < i) {
			out += replaceEntities(s);
			break;
		}
		out += replaceEntities(s.slice(0, i)) + s.slice(i + 9, j);
		s = s.slice(j + 3);
	}
	return out;
}

const XML_ENTITIES: Record<string, string> = { quot: '"', apos: "'", gt: '>', lt: '<', amp: '&' };
const XML_REF_RE = /&(?:(quot|apos|gt|lt|amp)|#([0-9]+)|#x([0-9a-fA-F]+));/g;

/** Whether a code point is an XML 1.0 Char, the only ones a character reference may name. */
function isXmlChar(cp: number): boolean {
	return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

function replaceXmlRefs(s: string): string {
	if (s.indexOf('&') === -1) return s;
	return s.replace(XML_REF_RE, (all: string, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
		if (name !== undefined) return XML_ENTITIES[name]!;
		const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16);
		return isXmlChar(cp) ? String.fromCodePoint(cp) : all;
	});
}

/**
 * Character data (already UTF-8 decoded) as an XML parser hands it on, and so
 * as openpyxl reads a cell's text (issue #22): literal line breaks (CRLF, a
 * lone CR) become LF; the five built-in entities and numeric character
 * references are expanded once, a reference to a code point beyond U+FFFF as
 * that one character; CDATA sections are kept literally. Nothing else:
 * Excel's _xHHHH_ escapes stay as written, and a CR written as &#13; stays a
 * CR. A reference XML doesn't define (a named entity, upper case &AMP; or
 * &#X41;, a number that isn't an XML character) is left as written, where an
 * XML parser would refuse the whole file; Excel never writes one.
 */
export function decodeXmlText(text: string): string {
	const s = text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
	if (s.indexOf('<![CDATA[') === -1) return replaceXmlRefs(s);
	let out = '';
	let rest = s;
	for (;;) {
		const i = rest.indexOf('<![CDATA[');
		const j = i === -1 ? -1 : rest.indexOf(']]>', i + 9);
		if (j === -1) return out + replaceXmlRefs(rest);
		out += replaceXmlRefs(rest.slice(0, i)) + rest.slice(i + 9, j);
		rest = rest.slice(j + 3);
	}
}

/** SheetJS's parsexmlbool (xsd:boolean; anything else is false). */
export function parseXmlBool(value: string | undefined): boolean {
	return value === '1' || value === 'true';
}

/**
 * The start tag being reported to XmlHandler.open(). The scanner reuses one
 * instance for every tag, so read what you need inside open().
 */
export class Tag {
	buf: Uint8Array = new Uint8Array(0);
	start = 0;
	end = 0;
	nameEnd = 0;
	constructor(private readonly part: string) {}

	/** The whole tag as a binary string. */
	text(): string {
		return binary(this.buf, this.start, this.end);
	}

	/**
	 * Every attribute as [qualified name, raw value] (entity references not
	 * decoded, as a binary string), in document order.
	 */
	attributes(): [string, string][] {
		const { buf } = this;
		const stop = buf[this.end - 2] === SLASH ? this.end - 2 : this.end - 1;
		const out: [string, string][] = [];
		let i = this.nameEnd;
		for (;;) {
			while (i < stop && isSpace(buf[i]!)) i++;
			if (i >= stop) return out;
			const n0 = i;
			while (i < stop && buf[i] !== EQ && !isSpace(buf[i]!)) i++;
			const name = binary(buf, n0, i);
			while (i < stop && isSpace(buf[i]!)) i++;
			if (buf[i] !== EQ || !name) throw notWellFormed(this.part, 'an attribute has no value');
			i++;
			while (i < stop && isSpace(buf[i]!)) i++;
			const q = buf[i];
			if (q !== DQ && q !== SQ) throw notWellFormed(this.part, 'an attribute value is not quoted');
			const v0 = ++i;
			while (i < stop && buf[i] !== q) i++;
			if (i >= stop) throw notWellFormed(this.part, 'an attribute value is not closed');
			out.push([name, binary(buf, v0, i)]);
			i++;
		}
	}

	/** One attribute by local name (any prefix; a later duplicate wins, as in SheetJS); undefined if absent. */
	attr(local: string): string | undefined {
		let v: string | undefined;
		for (const [name, value] of this.attributes()) {
			if (name === local || (name.endsWith(`:${local}`) && !name.startsWith('xmlns:'))) v = value;
		}
		return v;
	}
}

export interface XmlHandler {
	/** A start tag; `local` is its name without a prefix. A self-closing tag is followed by close(). */
	open(local: string, tag: Tag, selfClosing: boolean): void;
	close(local: string): void;
	/** Character data inside the root element, raw (entity references undecoded), possibly in several pieces. */
	text(buf: Uint8Array, start: number, end: number): void;
	/** A CDATA section's content. */
	cdata(buf: Uint8Array, start: number, end: number): void;
	/** A comment or processing instruction inside the root element, the whole token. */
	markup?(buf: Uint8Array, start: number, end: number): void;
}

export function notWellFormed(part: string, why: string): UnreadableWorkbookError {
	return new UnreadableWorkbookError(`a part of it (${part}) is not well-formed XML: ${why}`, 'corrupt');
}

function indexOfSeq(buf: Uint8Array, seq: readonly number[], from: number): number {
	for (let i = buf.indexOf(seq[0]!, from); i !== -1 && i + seq.length <= buf.length; i = buf.indexOf(seq[0]!, i + 1)) {
		let k = 1;
		while (k < seq.length && buf[i + k] === seq[k]) k++;
		if (k === seq.length) return i;
	}
	return -1;
}

const PI_END = [QM, GT];
const COMMENT_END = [0x2d, 0x2d, GT];
const CDATA_END = [0x5d, 0x5d, GT];
const CDATA_START = [LT, BANG, 0x5b, 0x43, 0x44, 0x41, 0x54, 0x41, 0x5b]; // <![CDATA[
const COMMENT_START = [LT, BANG, 0x2d, 0x2d];

/** Whether buf[at…] starts with seq; null when the buffer ends before that can be told. */
function startsWith(buf: Uint8Array, at: number, seq: readonly number[]): boolean | null {
	for (let k = 0; k < seq.length; k++) {
		if (at + k >= buf.length) return null;
		if (buf[at + k] !== seq[k]) return false;
	}
	return true;
}

/**
 * Push parser: push() each chunk, then end(). Throws UnreadableWorkbookError
 * on anything malformed.
 *
 * A token split across chunks is kept in a growing buffer and its scan
 * resumes where it stopped, so a long token arriving in many small chunks
 * costs time linear in its length, never a rescan per chunk.
 */
export class XmlScanner {
	/** The unfinished token (it starts at 0 with '<'), or the first bytes before the BOM check. */
	private pend = new Uint8Array(0);
	private pendLen = 0;
	/** How far the scan of the unfinished token got (offsets from its '<'), so it can resume there. */
	private resume: { at: number; q: number; nameEnd: number } | null = null;
	private readonly stack: string[] = [];
	private rootSeen = false;
	private first = true;
	private readonly tag: Tag;
	private readonly limits: XmlLimits;

	constructor(
		private readonly h: XmlHandler,
		private readonly part: string,
		limits: Partial<XmlLimits> = {}
	) {
		this.limits = { ...XML_LIMITS, ...limits };
		this.tag = new Tag(part);
	}

	private fail(why: string): UnreadableWorkbookError {
		return notWellFormed(this.part, why);
	}

	/** Keep buf[from…] as the unfinished part, in the pending buffer (which buf may already be a view of). */
	private keep(buf: Uint8Array, from: number): void {
		const len = buf.length - from;
		if (len > this.limits.maxTokenBytes) throw this.fail('a tag or comment is longer than any workbook writes');
		if (buf.buffer === this.pend.buffer && buf.byteOffset === this.pend.byteOffset) this.pend.copyWithin(0, from, buf.length);
		else {
			if (this.pend.length < len) this.pend = new Uint8Array(Math.max(len, 256));
			this.pend.set(buf.subarray(from));
		}
		this.pendLen = len;
	}

	push(chunk: Uint8Array): void {
		let buf = chunk;
		if (this.pendLen) {
			const len = this.pendLen + chunk.length;
			if (len - chunk.length > this.limits.maxTokenBytes) throw this.fail('a tag or comment is longer than any workbook writes');
			if (this.pend.length < len) {
				const grown = new Uint8Array(Math.max(len, this.pend.length * 2));
				grown.set(this.pend.subarray(0, this.pendLen));
				this.pend = grown;
			}
			this.pend.set(chunk, this.pendLen);
			this.pendLen = len;
			buf = this.pend.subarray(0, len);
		}
		let pos = 0;
		if (this.first) {
			if (buf.length < 3) {
				this.keep(buf, 0);
				return;
			}
			this.first = false;
			if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) throw this.fail('it is UTF-16, which the importer does not read');
			if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) pos = 3;
		}
		while (pos < buf.length) {
			const lt = buf.indexOf(LT, pos);
			const textEnd = lt === -1 ? buf.length : lt;
			if (textEnd > pos) this.text(buf, pos, textEnd);
			if (lt === -1) break;
			const next = this.token(buf, lt);
			if (next === -1) {
				this.keep(buf, lt);
				return;
			}
			if (next - lt > this.limits.maxTokenBytes) throw this.fail('a tag or comment is longer than any workbook writes');
			pos = next;
		}
		this.pendLen = 0;
	}

	end(): void {
		if (this.pendLen) {
			if (this.first && this.pend.subarray(0, this.pendLen).every(isSpace)) this.pendLen = 0;
			else throw this.fail('it ends inside a tag');
		}
		if (!this.rootSeen) throw this.fail('it has no root element');
		if (this.stack.length) throw this.fail(`<${this.stack[this.stack.length - 1]}> is never closed`);
	}

	private text(buf: Uint8Array, start: number, end: number): void {
		if (this.stack.length) {
			this.h.text(buf, start, end);
			return;
		}
		for (let i = start; i < end; i++) if (!isSpace(buf[i]!)) throw this.fail('it has text outside the root element');
	}

	/** Remember how far the unfinished token at lt was scanned; returns -1 (the "incomplete" result). */
	private stop(lt: number, at: number, q = 0, nameEnd = -1): number {
		this.resume = { at: at - lt, q, nameEnd: nameEnd < 0 ? -1 : nameEnd - lt };
		return -1;
	}

	/** Handle the token at buf[lt] ('<'); the index after it, or -1 when the buffer ends first. */
	private token(buf: Uint8Array, lt: number): number {
		// A resumed token always sits at 0 of the pending buffer.
		const r = lt === 0 ? this.resume : null;
		this.resume = null;
		const n = buf.length;
		if (lt + 1 >= n) return -1; // too little to tell what it is: rescanned from its start
		const c1 = buf[lt + 1];
		if (c1 === SLASH) {
			const gt = buf.indexOf(GT, Math.max(lt + 2, r ? r.at : 0));
			if (gt === -1) return this.stop(lt, n);
			let e = gt;
			while (e > lt + 2 && isSpace(buf[e - 1]!)) e--;
			const name = binary(buf, lt + 2, e);
			const open = this.stack.pop();
			if (open !== name) throw this.fail(open === undefined ? `</${name}> closes nothing` : `<${open}> is closed by </${name}>`);
			this.h.close(localName(name));
			return gt + 1;
		}
		if (c1 === QM) {
			const e = indexOfSeq(buf, PI_END, Math.max(lt + 2, r ? r.at - 1 : 0));
			if (e === -1) return this.stop(lt, n);
			if (this.stack.length) this.h.markup?.(buf, lt, e + 2);
			return e + 2;
		}
		if (c1 === BANG) {
			const comment = startsWith(buf, lt, COMMENT_START);
			if (comment === null) return -1;
			if (comment) {
				const e = indexOfSeq(buf, COMMENT_END, Math.max(lt + 4, r ? r.at - 2 : 0));
				if (e === -1) return this.stop(lt, n);
				if (this.stack.length) this.h.markup?.(buf, lt, e + 3);
				return e + 3;
			}
			const cdata = startsWith(buf, lt, CDATA_START);
			if (cdata === null) return -1;
			if (!cdata) throw this.fail('it has a DTD or other declaration, which the importer does not read');
			const e = indexOfSeq(buf, CDATA_END, Math.max(lt + 9, r ? r.at - 2 : 0));
			if (e === -1) return this.stop(lt, n);
			if (!this.stack.length) throw this.fail('it has a CDATA section outside the root element');
			this.h.cdata(buf, lt + 9, e);
			return e + 3;
		}
		// A start tag: the name, then attributes up to the '>' outside quotes.
		let i = r ? lt + r.at : lt + 1;
		let nameEnd = r && r.nameEnd >= 0 ? lt + r.nameEnd : -1;
		if (nameEnd < 0) {
			while (i < n && !isSpace(buf[i]!) && buf[i] !== SLASH && buf[i] !== GT) i++;
			if (i >= n) return this.stop(lt, i);
			nameEnd = i;
			if (nameEnd === lt + 1) throw this.fail('a tag has no name');
		}
		let q = r ? r.q : 0;
		for (; i < n; i++) {
			const b = buf[i]!;
			if (q) {
				if (b === q) q = 0;
				else if (b === LT) throw this.fail('an attribute value has a < in it');
			} else if (b === DQ || b === SQ) q = b;
			else if (b === GT) break;
			else if (b === LT) throw this.fail('a tag is not closed');
		}
		if (i >= n) return this.stop(lt, i, q, nameEnd);
		const selfClosing = buf[i - 1] === SLASH && i - 1 >= nameEnd;
		const name = binary(buf, lt + 1, nameEnd);
		if (!this.stack.length && this.rootSeen) throw this.fail('it has content after the root element');
		this.rootSeen = true;
		if (this.stack.length >= this.limits.maxDepth) throw this.fail('its elements nest deeper than any workbook writes');
		const t = this.tag;
		t.buf = buf;
		t.start = lt;
		t.end = i + 1;
		t.nameEnd = nameEnd;
		const local = localName(name);
		if (!selfClosing) this.stack.push(name);
		this.h.open(local, t, selfClosing);
		if (selfClosing) this.h.close(local);
		return i + 1;
	}
}

function localName(name: string): string {
	const c = name.indexOf(':');
	return c === -1 ? name : name.slice(c + 1);
}

/** Scan one whole part held in memory (the small ones: workbook, styles). */
export function scanXml(bytes: Uint8Array, part: string, h: XmlHandler, limits?: Partial<XmlLimits>): void {
	const s = new XmlScanner(h, part, limits);
	s.push(bytes);
	s.end();
}
