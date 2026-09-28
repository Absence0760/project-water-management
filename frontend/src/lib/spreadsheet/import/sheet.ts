// One worksheet's cells, from the streaming tokenizer's events (WP-1.31
// memory fix). Replaces SheetJS's worksheet parser for the importer: SheetJS
// held the sheet's XML as one string, split it into row and cell strings and
// made an object per cell, several hundred MB at the peak for a multi-decade
// [Flow data] sheet. This keeps each cell as a few typed-array slots (about
// 21 bytes) and never holds more of the XML than one inflated chunk.
//
// The cells are the ones SheetJS gave the parser, with the options it used
// (cached values, number formats, no stubs, no dates):
// - a cell with neither a type nor a value is skipped (no stub), as is a
//   number or shared-string cell with no value: an empty formula cell reads
//   as blank;
// - t="n" (or none): parseFloat of the value; t="s": the shared string;
//   t="str" (a formula's cached text): the value; t="inlineStr": the <is>
//   text; t="b": xsd:boolean; t="e": the error text's code; t="d": an ISO
//   date turned into a serial number; anything else reads as blank;
// - numbers carry their number format (styles.xml), so a date cell is told
//   from a number exactly as before;
// - the address is the r attribute (or the next column / row when absent), a
//   later cell at the same address wins;
// - the used range (lastRow) is the <dimension> element's when it has a valid
//   range, else the rows and columns seen, as SheetJS's !ref was.
//
// One departure: a value is decoded as openpyxl decodes it, since the Python
// importer is the reference the port matches (issue #22; xml.ts
// decodeXmlText): UTF-8, literal line breaks to LF, the five XML entities and
// numeric references expanded once, no _xHHHH_ handling. SheetJS decoded a
// formula's cached text twice (a&amp;amp;b read a&b, openpyxl a&amp;b) and
// turned _x000D_ into a CR. Shared and inline strings: ./sharedStrings.ts.
import { UnreadableWorkbookError } from './errors';
import type { RawCell, SheetSource } from './source';
import { SiCollector } from './sharedStrings';
import type { Styles } from './workbookParts';
import { binary, decodeXmlText, notWellFormed, parseXmlBool, type Tag, utf8read, type XmlHandler } from './xml';

const K_NUM = 1;
const K_SST = 2;
const K_STR = 3;
const K_BOOL = 4;
const K_ERR = 5;
const K_BLANK = 6;

/** SheetJS's RBErr: error text → code (B023Workbook maps the code back to text). */
const ERROR_CODES: Record<string, number> = {
	'#NULL!': 0x00,
	'#DIV/0!': 0x07,
	'#VALUE!': 0x0f,
	'#REF!': 0x17,
	'#NAME?': 0x1d,
	'#NUM!': 0x24,
	'#N/A': 0x2a,
	'#GETTING_DATA': 0x2b,
	'#WTF?': 0xff
};

/** Addresses are stored as row × 2^24 + column: exact in a double for every row below 2^28. */
const COL_SPAN = 2 ** 24;
const ROW_SPAN = 2 ** 28;

/** Longest cell value collected (Excel's limit is 32 767 characters). */
const MAX_VALUE_CHARS = 1 << 20;

// --- SheetJS address and date helpers ------------------------------------------

/** SheetJS decode_cell: digits anywhere make the row, capitals anywhere the column; 0-based. */
function decodeCell(s: string): { r: number; c: number } {
	let r = 0;
	let c = 0;
	for (let i = 0; i < s.length; i++) {
		const cc = s.charCodeAt(i);
		if (cc >= 48 && cc <= 57) r = 10 * r + (cc - 48);
		else if (cc >= 65 && cc <= 90) c = 26 * c + (cc - 64);
	}
	return { r: r - 1, c: c - 1 };
}

/** The column of a cell reference's leading capitals, 0-based (-1 for none), as SheetJS's cell scan counts it. */
function leadingColumn(s: string): number {
	let idx = 0;
	for (let i = 0; i < s.length; i++) {
		const cc = s.charCodeAt(i) - 64;
		if (cc < 1 || cc > 26) break;
		idx = 26 * idx + cc;
	}
	return idx - 1;
}

interface Range {
	sr: number;
	sc: number;
	er: number;
	ec: number;
}

/** SheetJS safe_decode_range. */
function safeDecodeRange(range: string): Range {
	let i = 0;
	let cc = 0;
	const len = range.length;
	let idx = 0;
	for (; i < len; ++i) {
		if ((cc = range.charCodeAt(i) - 64) < 1 || cc > 26) break;
		idx = 26 * idx + cc;
	}
	const sc = --idx;
	for (idx = 0; i < len; ++i) {
		if ((cc = range.charCodeAt(i) - 48) < 0 || cc > 9) break;
		idx = 10 * idx + cc;
	}
	const sr = --idx;
	if (i === len || cc != 10) return { sr, sc, er: sr, ec: sc };
	++i;
	for (idx = 0; i != len; ++i) {
		if ((cc = range.charCodeAt(i) - 64) < 1 || cc > 26) break;
		idx = 26 * idx + cc;
	}
	const ec = --idx;
	for (idx = 0; i != len; ++i) {
		if ((cc = range.charCodeAt(i) - 48) < 0 || cc > 9) break;
		idx = 10 * idx + cc;
	}
	return { sr, sc, er: --idx, ec };
}

const DN_THRESH = Date.UTC(1899, 11, 30, 0, 0, 0);
const DN_THRESH1 = Date.UTC(1899, 11, 31, 0, 0, 0);
const DN_THRESH2 = Date.UTC(1904, 0, 1, 0, 0, 0);

/** SheetJS parseDate (t="d" cells only; Excel itself never writes them). */
function parseDate(str: string, date1904: boolean): Date {
	let m = str.match(/^(\d+):(\d+)(:\d+)?(\.\d+)?$/);
	if (m) {
		return new Date(
			(date1904 ? DN_THRESH2 : DN_THRESH1) +
				((parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10)) * 60 + (m[3] ? parseInt(m[3].slice(1), 10) : 0)) * 1000 +
				(m[4] ? parseInt((m[4] + '000').slice(1, 4), 10) : 0)
		);
	}
	m = str.match(/^(\d+)-(\d+)-(\d+)$/);
	if (m) return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, 0, 0, 0, 0));
	m = str.match(/^(\d+)-(\d+)-(\d+)[T ](\d+):(\d+)(:\d+)?(\.\d+)?$/);
	if (m) {
		return new Date(
			Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, (m[6] && parseInt(m[6].slice(1), 10)) || 0, (m[7] && parseInt((m[7] + '0000').slice(1, 4), 10)) || 0)
		);
	}
	return new Date(str);
}

/** SheetJS datenum. */
function datenum(v: Date, date1904: boolean): number {
	const res = (v.getTime() - DN_THRESH) / 86_400_000;
	if (date1904) {
		const r = res - 1462;
		return r < -1402 ? r - 1 : r;
	}
	return res < 60 ? res - 1 : res;
}

// --- storage -------------------------------------------------------------------

/** One sheet's cells, sorted by address for lookup. */
export class SheetCells implements SheetSource {
	/** Resolves shared-string indices; set once the shared strings are read. */
	sharedStrings: (i: number) => string | undefined = () => undefined;

	constructor(
		readonly lastRow: number,
		private readonly keys: Float64Array,
		private readonly kinds: Uint8Array,
		private readonly nums: Float64Array,
		private readonly fmts: Int32Array,
		private readonly strings: string[],
		private readonly formats: readonly (string | undefined)[]
	) {}

	/** Cells stored. */
	get size(): number {
		return this.keys.length;
	}

	cell(col: number, row: number): RawCell | undefined {
		const key = (row - 1) * COL_SPAN + (col - 1);
		const { keys } = this;
		let lo = 0;
		let hi = keys.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const k = keys[mid]!;
			if (k < key) lo = mid + 1;
			else if (k > key) hi = mid - 1;
			else return this.at(mid);
		}
		return undefined;
	}

	private at(i: number): RawCell | undefined {
		const v = this.nums[i]!;
		switch (this.kinds[i]) {
			case K_NUM:
				return { t: 'n', v, z: this.formats[this.fmts[i]!] };
			case K_SST:
				return { t: 's', v: this.sharedStrings(v) };
			case K_STR:
				return { t: 's', v: this.strings[v] };
			case K_BOOL:
				return { t: 'b', v: v === 1 };
			case K_ERR:
				return { t: 'e', v: Number.isNaN(v) ? undefined : v };
			default:
				return undefined;
		}
	}

	*addresses(): Iterable<[number, number]> {
		for (const k of this.keys) yield [(k % COL_SPAN) + 1, Math.floor(k / COL_SPAN) + 1];
	}

	/** Every shared-string index the sheet refers to. */
	sharedIndices(): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.kinds.length; i++) if (this.kinds[i] === K_SST) out.push(this.nums[i]!);
		return out;
	}
}

/** Growable columns of cells, in the order the sheet lists them. */
class CellStore {
	keys = new Float64Array(1024);
	kinds = new Uint8Array(1024);
	nums = new Float64Array(1024);
	fmts = new Int32Array(1024);
	n = 0;
	sorted = true;
	private last = -1;

	push(key: number, kind: number, num: number, fmt: number): void {
		if (this.n === this.keys.length) this.grow();
		const i = this.n++;
		this.keys[i] = key;
		this.kinds[i] = kind;
		this.nums[i] = num;
		this.fmts[i] = fmt;
		if (key <= this.last) this.sorted = false;
		this.last = key;
	}

	private grow(): void {
		const size = this.keys.length * 2;
		const k = new Float64Array(size);
		k.set(this.keys);
		this.keys = k;
		const t = new Uint8Array(size);
		t.set(this.kinds);
		this.kinds = t;
		const v = new Float64Array(size);
		v.set(this.nums);
		this.nums = v;
		const f = new Int32Array(size);
		f.set(this.fmts);
		this.fmts = f;
	}

	/** Trimmed to size, sorted by address, a later duplicate winning. */
	finish(): { keys: Float64Array; kinds: Uint8Array; nums: Float64Array; fmts: Int32Array } {
		const { n } = this;
		if (this.sorted) {
			return { keys: this.keys.slice(0, n), kinds: this.kinds.slice(0, n), nums: this.nums.slice(0, n), fmts: this.fmts.slice(0, n) };
		}
		const order = new Uint32Array(n);
		for (let i = 0; i < n; i++) order[i] = i;
		order.sort((a, b) => this.keys[a]! - this.keys[b]! || a - b);
		let m = 0;
		for (let i = 0; i < n; i++) {
			if (i + 1 < n && this.keys[order[i + 1]!] === this.keys[order[i]!]) continue; // the later one wins
			order[m++] = order[i]!;
		}
		const keys = new Float64Array(m);
		const kinds = new Uint8Array(m);
		const nums = new Float64Array(m);
		const fmts = new Int32Array(m);
		for (let i = 0; i < m; i++) {
			const j = order[i]!;
			keys[i] = this.keys[j]!;
			kinds[i] = this.kinds[j]!;
			nums[i] = this.nums[j]!;
			fmts[i] = this.fmts[j]!;
		}
		return { keys, kinds, nums, fmts };
	}
}

// --- the handler ---------------------------------------------------------------

/** A worksheet part as an XmlHandler; finish() once the scanner has ended. */
export class SheetReader implements XmlHandler {
	private depth = 0;
	/** 0: before <sheetData>; 1: inside it; 2: after it. */
	private phase = 0;
	private sheetDataDepth = -1;
	/** Whether a <sheetData> with an end tag was seen (SheetJS's split needs one). */
	private sheetDataClosed = false;
	private dimAny: string | undefined;
	private dimBefore: string | undefined;

	private rowDepth = -1;
	private tagr = 0;
	private tagc = -1;
	/** A self-closing <row/>'s r attribute (null: none pending; undefined: no r). */
	private pendingRow: string | undefined | null = null;
	private sr = 2_000_000;
	private sc = 2_000_000;
	private er = 0;
	private ec = 0;

	private cellDepth = -1;
	private cellR: string | undefined;
	private cellS: string | undefined;
	private cellT: string | undefined;
	private cellCol = -1;
	/** 0: no <v> yet; 1: inside the first; 2: done. */
	private vState = 0;
	private vDepth = -1;
	private vRaw: string[] = [];
	private vChars = 0;
	private isState = 0;
	private isDepth = -1;
	private isValue = '';

	private readonly store = new CellStore();
	private readonly strings: string[] = [];
	private readonly si: SiCollector;

	constructor(
		private readonly part: string,
		private readonly styles: Styles,
		private readonly date1904: boolean
	) {
		this.si = new SiCollector(part);
	}

	open(local: string, tag: Tag, selfClosing: boolean): void {
		const d = this.depth++;
		if (local === 'dimension' && this.dimAny === undefined) {
			this.dimAny = tag.text();
			if (this.phase === 0) this.dimBefore = this.dimAny;
		}
		if (this.phase === 0) {
			if (local === 'sheetData') {
				this.phase = selfClosing ? 2 : 1;
				this.sheetDataDepth = d;
			}
			return;
		}
		if (this.phase !== 1) return;
		if (this.cellDepth >= 0) {
			this.cellChild(local, selfClosing, d);
		} else if (this.rowDepth >= 0) {
			if (d === this.rowDepth + 1 && local === 'c') this.startCell(tag, d);
		} else if (d === this.sheetDataDepth + 1 && local === 'row') {
			const r = tag.attr('r');
			if (selfClosing) this.pendingRow = r;
			else {
				this.pendingRow = null;
				this.startRow(r);
				this.rowDepth = d;
			}
		}
	}

	close(local: string): void {
		const d = --this.depth;
		if (this.phase !== 1) return;
		if (this.cellDepth >= 0) {
			if (d === this.cellDepth) this.finishCell();
			else if (this.vState === 1 && d === this.vDepth) this.vState = 2;
			else if (this.isState === 1) {
				if (d === this.isDepth) {
					this.isValue = this.si.finish();
					this.isState = 2;
				} else this.si.close(local);
			}
		} else if (this.rowDepth >= 0) {
			if (d === this.rowDepth) this.rowDepth = -1;
		} else if (d === this.sheetDataDepth) {
			// Trailing self-closing rows: SheetJS counted the last of them in the used range.
			if (this.pendingRow !== null) this.startRow(this.pendingRow);
			this.pendingRow = null;
			this.phase = 2;
			this.sheetDataClosed = true;
		}
	}

	text(buf: Uint8Array, start: number, end: number): void {
		if (this.cellDepth < 0) return;
		if (this.vState === 1) this.addV(binary(buf, start, end));
		else if (this.isState === 1) this.si.text(binary(buf, start, end));
	}

	cdata(buf: Uint8Array, start: number, end: number): void {
		if (this.cellDepth < 0) return;
		if (this.vState === 1) this.addV(`<![CDATA[${binary(buf, start, end)}]]>`);
		else if (this.isState === 1) this.si.cdata(binary(buf, start, end));
	}

	markup(buf: Uint8Array, start: number, end: number): void {
		if (this.cellDepth < 0) return;
		if (this.vState === 1) this.addV(binary(buf, start, end));
		else if (this.isState === 1) this.si.markup(binary(buf, start, end));
	}

	private addV(s: string): void {
		this.vChars += s.length;
		if (this.vChars > MAX_VALUE_CHARS) throw notWellFormed(this.part, 'a cell value is longer than Excel allows');
		this.vRaw.push(s);
	}

	private startRow(r: string | undefined): void {
		this.tagr = r !== undefined ? parseInt(r, 10) : this.tagr + 1;
		this.tagc = -1;
		if (this.sr > this.tagr - 1) this.sr = this.tagr - 1;
		if (this.er < this.tagr - 1) this.er = this.tagr - 1;
	}

	private startCell(tag: Tag, d: number): void {
		let r: string | undefined;
		let s: string | undefined;
		let t: string | undefined;
		for (const [name, value] of tag.attributes()) {
			const local = name.slice(name.indexOf(':') + 1);
			if (local === 'r') r = value;
			else if (local === 's') s = value;
			else if (local === 't') t = value;
		}
		this.cellR = r;
		this.cellS = s;
		this.cellT = t;
		this.cellCol = this.tagc = r !== undefined ? leadingColumn(r) : this.tagc + 1;
		this.cellDepth = d;
		this.vState = 0;
		this.vRaw = [];
		this.vChars = 0;
		this.isState = 0;
		this.isValue = '';
	}

	private cellChild(local: string, selfClosing: boolean, d: number): void {
		if (this.vState === 1) throw notWellFormed(this.part, 'a cell value has markup inside it');
		if (this.isState === 1) this.si.open(local, selfClosing);
		else if (local === 'v' && this.vState === 0) {
			this.vState = selfClosing ? 2 : 1;
			this.vDepth = d;
		} else if (local === 'is' && this.isState === 0) {
			this.isState = selfClosing ? 2 : 1;
			this.isDepth = d;
			if (!selfClosing) this.si.begin();
		}
	}

	private finishCell(): void {
		this.cellDepth = -1;
		const raw = this.vRaw.length ? this.vRaw.join('') : '';
		const v = raw === '' ? undefined : decodeXmlText(utf8read(raw));
		const t = this.cellT;
		if (t === undefined && v === undefined) return;
		const type = t || 'n';
		const col = this.cellCol;
		if (this.sc > col) this.sc = col;
		if (this.ec < col) this.ec = col;
		let kind: number;
		let num = 0;
		let fmt = -1;
		switch (type) {
			case 'n':
				if (v === undefined || v === '') return;
				kind = K_NUM;
				num = parseFloat(v);
				fmt = this.styles.zIndex(this.cellS);
				break;
			case 's':
				if (v === undefined) return;
				kind = K_SST;
				num = parseInt(v, 10);
				break;
			case 'str':
				kind = K_STR;
				num = this.strings.push(v ?? '') - 1;
				break;
			case 'inlineStr':
				kind = K_STR;
				num = this.strings.push(this.isValue) - 1;
				break;
			case 'b':
				kind = K_BOOL;
				num = parseXmlBool(v) ? 1 : 0;
				break;
			case 'd':
				if (v === undefined) throw new UnreadableWorkbookError(`a date cell in it (${this.part}) has no value`, 'corrupt');
				kind = K_NUM;
				num = datenum(parseDate(v, this.date1904), this.date1904);
				fmt = this.styles.zIndex(this.cellS);
				break;
			case 'e':
				kind = K_ERR;
				num = v !== undefined && Object.hasOwn(ERROR_CODES, v) ? ERROR_CODES[v]! : NaN;
				break;
			default:
				kind = K_BLANK;
		}
		const { r, c } = this.cellR !== undefined ? decodeCell(this.cellR) : { r: this.tagr - 1, c: col };
		// Cells outside the sheet's grid can never be asked for; SheetJS stored them where no read reached.
		if (!(r >= 0 && r < ROW_SPAN && c >= 0 && c < COL_SPAN)) return;
		this.store.push(r * COL_SPAN + c, kind, num, fmt);
	}

	/** The cells, and the used range as SheetJS's !ref gave it. */
	finish(): SheetCells {
		const dim = this.sheetDataClosed ? this.dimBefore : this.dimAny;
		let lastRow = -1;
		const m = dim === undefined ? null : /"(\w*:\w*)"/.exec(dim.slice(0, 50));
		if (m) {
			const d = safeDecodeRange(m[1]!);
			if (d.sr <= d.er && d.sc <= d.ec && d.sr >= 0 && d.sc >= 0) lastRow = d.er + 1;
		}
		if (lastRow < 0) lastRow = this.ec >= this.sc && this.er >= this.sr ? this.er + 1 : 0;
		const { keys, kinds, nums, fmts } = this.store.finish();
		return new SheetCells(lastRow, keys, kinds, nums, fmts, this.strings, this.styles.formats);
	}
}
