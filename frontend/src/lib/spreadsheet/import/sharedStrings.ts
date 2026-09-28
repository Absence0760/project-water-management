// Shared strings (xl/sharedStrings.xml) and inline strings, from the
// streaming tokenizer's events: which text makes up the string is decided the
// way SheetJS's parse_si decided it, and the text is decoded the way openpyxl
// decodes it (issue #22).
//
// The shared-string table of a large workbook holds every label of every
// sheet, including the per-farm result sheets the importer never reads, so
// readSharedStrings() keeps only the entries the read sheets refer to.
//
// SheetJS's rules for one <si> (and a cell's <is>), reproduced here:
// - plain: when its first child is <t>, the value is that <t>'s content,
//   whitespace kept as written (xml:space is not consulted);
// - rich: otherwise, when it has an <r> run, the value is the text of every
//   <t> outside the phonetic runs (<rPh>) joined, skipping a <t> that holds
//   anything but character data;
// - otherwise the empty string.
//
// That text is then decoded as openpyxl reads it, since the Python importer
// is the reference the port matches (xml.ts decodeXmlText): UTF-8, literal
// line breaks to LF, the five XML entities and numeric references expanded
// once, CDATA kept literally. Excel's _xHHHH_ escapes are left as written
// (SheetJS turned _x000D_ into a CR), and a CR written as &#13; stays a CR
// (SheetJS turned CRLF into LF after decoding). A shared string then loses
// every "x005F_", as openpyxl's read_string_table does (so Excel's escaped
// underscore _x005F_x000D_ reads _x000D_); an inline string doesn't.
// stringDecoding.test.ts pins these to openpyxl's committed output and lists
// them as the deliberate differences from SheetJS.
//
// Two departures, both where SheetJS read markup as text: a self-closing <t/>
// first child is '' (SheetJS took whatever markup followed it as the value),
// and a self-closing <si/> is one empty entry (SheetJS merged it into the next
// entry, shifting every later index). And a needed string whose plain <t>
// holds an element (schema-invalid; Excel never writes it) is refused as
// corrupt, where SheetJS kept the markup as text.
import { binary, decodeXmlText, notWellFormed, type Tag, utf8read, type XmlHandler } from './xml';

/** Longest string collected: Excel's cell limit is 32 767 characters, so this is far beyond any real one. */
export const MAX_STRING_CHARS = 1 << 20;

/** Collects one <si> or <is>: begin(), the events of its descendants, then finish(). */
export class SiCollector {
	private depth = 0;
	private firstChild: 'none' | 't' | 'other' = 'none';
	private leading = false;
	/** 0: no plain <t>; 1: inside it; 2: closed. */
	private plain = 0;
	private plainRaw: string[] = [];
	private rich = false;
	private runs: string[] = [];
	private tDepth = -1;
	private tRaw: string[] = [];
	private tPure = true;
	private rPh = 0;
	private chars = 0;

	constructor(private readonly part: string) {}

	begin(): void {
		this.depth = 0;
		this.firstChild = 'none';
		this.leading = false;
		this.plain = 0;
		this.plainRaw = [];
		this.rich = false;
		this.runs = [];
		this.tDepth = -1;
		this.tRaw = [];
		this.tPure = true;
		this.rPh = 0;
		this.chars = 0;
	}

	private add(list: string[], s: string): void {
		this.chars += s.length;
		if (this.chars > MAX_STRING_CHARS) throw notWellFormed(this.part, 'a string is longer than Excel allows');
		list.push(s);
	}

	open(local: string, selfClosing: boolean): void {
		if (this.plain === 1) throw notWellFormed(this.part, 'a string has markup inside its text');
		if (this.depth === 0 && this.firstChild === 'none') {
			this.firstChild = local === 't' && !this.leading ? 't' : 'other';
			if (this.firstChild === 't') this.plain = selfClosing ? 2 : 1;
		}
		if (local === 'r') this.rich = true;
		if (this.tDepth >= 0) this.tPure = false;
		if (local === 'rPh' && !selfClosing) this.rPh++;
		else if (local === 't' && this.rPh === 0 && !selfClosing && this.tDepth < 0) {
			this.tDepth = this.depth;
			this.tRaw = [];
			this.tPure = true;
		}
		this.depth++;
	}

	close(local: string): void {
		this.depth--;
		if (this.plain === 1 && this.depth === 0) this.plain = 2;
		if (this.tDepth === this.depth && local === 't') {
			if (this.tPure) this.add(this.runs, this.tRaw.join(''));
			this.tDepth = -1;
		} else if (local === 'rPh' && this.rPh > 0) this.rPh--;
	}

	text(s: string): void {
		if (this.depth === 0 && this.firstChild === 'none' && /\S/.test(s)) this.leading = true;
		if (this.plain === 1) this.add(this.plainRaw, s);
		if (this.tDepth >= 0) this.tRaw.push(s);
	}

	cdata(s: string): void {
		if (this.depth === 0 && this.firstChild === 'none') this.leading = true;
		if (this.plain === 1) this.add(this.plainRaw, `<![CDATA[${s}]]>`);
		if (this.tDepth >= 0) this.tPure = false;
	}

	markup(raw: string): void {
		if (this.depth === 0 && this.firstChild === 'none') this.leading = true;
		if (this.plain === 1) this.add(this.plainRaw, raw);
		if (this.tDepth >= 0) this.tPure = false;
	}

	finish(): string {
		if (this.plain) return decodeXmlText(utf8read(this.plainRaw.join('')));
		if (this.rich) return decodeXmlText(utf8read(this.runs.join('')));
		return '';
	}
}

/**
 * xl/sharedStrings.xml as an XmlHandler: every <si> in the <sst> is one entry,
 * in order; only the entries in `needed` are decoded and kept.
 */
export class SharedStringsReader implements XmlHandler {
	readonly strings = new Map<number, string>();
	/** Entries seen. */
	count = 0;
	/** Whether the part had an <sst> element at all. */
	found = false;
	private depth = 0;
	/** 0: before the <sst>; 1: inside it; 2: after it (only the first counts). */
	private state = 0;
	private sstDepth = -1;
	private itemDepth = -1;
	private collecting = false;
	private readonly si: SiCollector;

	constructor(
		private readonly needed: ReadonlySet<number>,
		part: string
	) {
		this.si = new SiCollector(part);
	}

	open(local: string, _tag: Tag, selfClosing: boolean): void {
		if (this.itemDepth >= 0) {
			if (this.collecting) this.si.open(local, selfClosing);
		} else if (this.state === 0) {
			if (local === 'sst' && !selfClosing) {
				this.state = 1;
				this.sstDepth = this.depth;
				this.found = true;
			}
		} else if (this.state === 1 && (local === 'si' || local === 'sstItem')) {
			const i = this.count++;
			this.collecting = this.needed.has(i);
			if (selfClosing) {
				if (this.collecting) this.strings.set(i, '');
			} else {
				this.itemDepth = this.depth;
				if (this.collecting) this.si.begin();
			}
		}
		this.depth++;
	}

	close(local: string): void {
		this.depth--;
		if (this.itemDepth >= 0) {
			if (this.depth === this.itemDepth) {
				// openpyxl's read_string_table: text.replace('x005F_', '').
				if (this.collecting) this.strings.set(this.count - 1, this.si.finish().replaceAll('x005F_', ''));
				this.itemDepth = -1;
				this.collecting = false;
			} else if (this.collecting) this.si.close(local);
		} else if (this.state === 1 && this.depth === this.sstDepth) this.state = 2;
	}

	text(buf: Uint8Array, start: number, end: number): void {
		if (this.collecting) this.si.text(binary(buf, start, end));
	}

	cdata(buf: Uint8Array, start: number, end: number): void {
		if (this.collecting) this.si.cdata(binary(buf, start, end));
	}

	markup(buf: Uint8Array, start: number, end: number): void {
		if (this.collecting) this.si.markup(binary(buf, start, end));
	}

	/**
	 * Entry i's text. SheetJS kept one extra, empty entry after the last
	 * (what followed the final </si>), so index `count` reads as ''; anything
	 * else missing is undefined.
	 */
	get(i: number): string | undefined {
		const s = this.strings.get(i);
		if (s !== undefined) return s;
		return this.found && i === this.count ? '' : undefined;
	}
}
