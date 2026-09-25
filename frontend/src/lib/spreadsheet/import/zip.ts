// A defensive reader for the zip container of an uploaded workbook, so the
// import inflates only the parts it reads (WP-1.31 memory fix).
//
// SheetJS's own zip reader inflates every entry before it looks at any: a
// client-size b023 workbook (~90 MB on disk) unpacks to ~600 MB, most of it a
// calculation chain and dozens of per-farm result sheets the importer never
// reads, which peaked at about a gigabyte of memory. This reads the central
// directory, then inflates only the entries asked for, with the platform's
// `DecompressionStream('deflate-raw')` (native zlib; browsers, workers and
// Node alike). readWorkbook() packs those into a small stored zip for SheetJS.
//
// The file is untrusted. Every offset and length is bounds-checked against
// the buffer; each inflated entry and the total are capped before anything is
// allocated, and an entry that inflates past its declared size is stopped at
// once (a zip bomb gets WorkbookTooLargeError, not an out-of-memory tab);
// encrypted entries, ZIP64, split archives and methods other than stored and
// deflate are refused with UnreadableWorkbookError; the CRC-32 of every
// inflated entry is checked. Nothing here executes anything from the file.
import { crc32 } from '../export/zip';
import { UnreadableWorkbookError, WorkbookTooLargeError } from './errors';

export interface ZipLimits {
	/** Most entries the central directory may list. */
	maxEntries?: number;
	/** Largest single entry, inflated. */
	maxEntryBytes?: number;
	/** Most bytes read() inflates in total, across every entry it's asked for. */
	maxTotalBytes?: number;
}

/**
 * Defaults sized from the real workbooks: a b023 workbook has about 300 zip
 * entries, and the largest sheet the importer reads ([Flow data], a 40-year
 * daily record) inflates to under a third of the per-entry cap.
 */
export const ZIP_LIMITS: Required<ZipLimits> = {
	maxEntries: 10_000,
	maxEntryBytes: 128 * 1024 * 1024,
	maxTotalBytes: 256 * 1024 * 1024
};

export interface ZipEntryInfo {
	name: string;
	method: number;
	flags: number;
	crc: number;
	compressedSize: number;
	size: number;
	/** Offset of the local file header. */
	localOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const unreadable = (reason: UnreadableWorkbookError['reason'], detail: string) => new UnreadableWorkbookError(detail, reason);

/** A zip archive's directory, with on-demand, capped inflation of single entries. */
export class ZipArchive {
	private readonly entries = new Map<string, ZipEntryInfo>();
	private readonly lower = new Map<string, string>();
	private inflated = 0;
	readonly limits: Required<ZipLimits>;

	private constructor(
		private readonly bytes: Uint8Array,
		private readonly view: DataView,
		limits: ZipLimits
	) {
		this.limits = { ...ZIP_LIMITS, ...limits };
	}

	/** Parse the end record and the central directory. Throws a WorkbookImportError on anything malformed. */
	static open(bytes: Uint8Array, limits: ZipLimits = {}): ZipArchive {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const zip = new ZipArchive(bytes, view, limits);
		zip.readDirectory();
		return zip;
	}

	/** Every entry name, in directory order. */
	get names(): string[] {
		return [...this.entries.keys()];
	}

	/** The entry's exact name, matched case-insensitively as SheetJS does; undefined if absent. */
	find(name: string): string | undefined {
		return this.entries.has(name) ? name : this.lower.get(name.toLowerCase());
	}

	info(name: string): ZipEntryInfo | undefined {
		const n = this.find(name);
		return n === undefined ? undefined : this.entries.get(n);
	}

	/** Bytes inflated so far by read(). */
	get inflatedBytes(): number {
		return this.inflated;
	}

	private readDirectory(): void {
		const { bytes, view } = this;
		if (bytes.length >= 8 && view.getUint32(0, false) === 0xd0cf11e0 && view.getUint32(4, false) === 0xa1b11ae1) {
			throw unreadable('not-zip', "it's password-protected or an old-format .xls file; save it from Excel as .xlsm or .xlsx, without a password");
		}
		if (bytes.length < 22) throw unreadable('not-zip', "it isn't an .xlsx or .xlsm file");
		// The end record is the last 22 bytes plus a comment of up to 65535.
		let end = -1;
		for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - U16_MAX); i--) {
			if (view.getUint32(i, true) === SIG_END && i + 22 + view.getUint16(i + 20, true) <= bytes.length) {
				end = i;
				break;
			}
		}
		if (end < 0) throw unreadable('not-zip', "it isn't an .xlsx or .xlsm file");
		const disk = view.getUint16(end + 4, true);
		const cdDisk = view.getUint16(end + 6, true);
		const onDisk = view.getUint16(end + 8, true);
		const count = view.getUint16(end + 10, true);
		const cdSize = view.getUint32(end + 12, true);
		const cdOffset = view.getUint32(end + 16, true);
		if ((end >= 20 && view.getUint32(end - 20, true) === SIG_ZIP64_LOCATOR) || count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
			throw unreadable('zip64', 'it uses the ZIP64 format, which the importer does not read');
		}
		if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw unreadable('corrupt', 'it is a split or damaged zip archive');
		if (count > this.limits.maxEntries) throw unreadable('corrupt', `it lists ${count} parts, more than a workbook has`);
		if (cdOffset + cdSize > end) throw unreadable('corrupt', 'its zip directory is damaged');

		let p = cdOffset;
		for (let i = 0; i < count; i++) {
			if (p + 46 > cdOffset + cdSize || view.getUint32(p, true) !== SIG_CENTRAL) throw unreadable('corrupt', 'its zip directory is damaged');
			const flags = view.getUint16(p + 8, true);
			const method = view.getUint16(p + 10, true);
			const crc = view.getUint32(p + 16, true);
			const compressedSize = view.getUint32(p + 20, true);
			const size = view.getUint32(p + 24, true);
			const nameLen = view.getUint16(p + 28, true);
			const extraLen = view.getUint16(p + 30, true);
			const commentLen = view.getUint16(p + 32, true);
			const localOffset = view.getUint32(p + 42, true);
			const next = p + 46 + nameLen + extraLen + commentLen;
			if (next > cdOffset + cdSize) throw unreadable('corrupt', 'its zip directory is damaged');
			if (compressedSize === U32_MAX || size === U32_MAX || localOffset === U32_MAX) {
				throw unreadable('zip64', 'it uses the ZIP64 format, which the importer does not read');
			}
			// OOXML part names are ASCII; a non-UTF-8 name can't be one the importer asks for, so lossy decoding is harmless.
			const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
			if (this.entries.has(name)) throw unreadable('corrupt', 'it lists the same part twice');
			this.entries.set(name, { name, method, flags, crc, compressedSize, size, localOffset });
			if (!this.lower.has(name.toLowerCase())) this.lower.set(name.toLowerCase(), name);
			p = next;
		}
	}

	/** Where the entry's data starts, checked against the buffer and the directory. */
	private dataRange(e: ZipEntryInfo): [number, number] {
		const { view } = this;
		const h = e.localOffset;
		if (h + 30 > this.bytes.length || view.getUint32(h, true) !== SIG_LOCAL) throw unreadable('corrupt', `a part of it (${e.name}) is damaged`);
		const start = h + 30 + view.getUint16(h + 26, true) + view.getUint16(h + 28, true);
		const stop = start + e.compressedSize;
		if (stop > this.bytes.length) throw unreadable('corrupt', `a part of it (${e.name}) is truncated`);
		return [start, stop];
	}

	/**
	 * One entry, inflated. The entry's declared size is checked against the
	 * per-entry cap and the remaining total before anything is allocated, and
	 * inflation stops the moment it produces more than that declared size.
	 */
	async read(name: string): Promise<Uint8Array> {
		const e = this.info(name);
		if (!e) throw unreadable('corrupt', `it has no part ${name}`);
		if (e.flags & 0x2041) throw unreadable('encrypted', 'it is encrypted');
		if (e.method !== 0 && e.method !== 8) throw unreadable('method', `a part of it uses zip compression method ${e.method}, which the importer does not read`);
		const { maxEntryBytes, maxTotalBytes } = this.limits;
		if (e.size > maxEntryBytes) throw new WorkbookTooLargeError('unpacked', e.size, maxEntryBytes);
		if (this.inflated + e.size > maxTotalBytes) throw new WorkbookTooLargeError('unpacked', this.inflated + e.size, maxTotalBytes);
		const [start, stop] = this.dataRange(e);
		const packed = this.bytes.subarray(start, stop);
		let out: Uint8Array;
		if (e.method === 0) {
			if (e.compressedSize !== e.size) throw unreadable('corrupt', `a part of it (${e.name}) is damaged`);
			out = packed.slice();
		} else {
			out = await inflateRaw(packed, e.size, e.name);
		}
		if (crc32(out) !== e.crc) throw unreadable('corrupt', `a part of it (${e.name}) is damaged (checksum mismatch)`);
		this.inflated += out.length;
		return out;
	}
}

/**
 * Raw inflate into a buffer of exactly `size` bytes. Output beyond `size`
 * (a lying header, or a bomb) stops the stream at once and throws.
 */
export async function inflateRaw(packed: Uint8Array, size: number, name = 'a part'): Promise<Uint8Array> {
	const out = new Uint8Array(size);
	const source = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(packed);
			c.close();
		}
	});
	const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
	let n = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (n + value.length > size) {
				await reader.cancel().catch(() => {});
				throw unreadable('corrupt', `a part of it (${name}) unpacks to more than its zip header says`);
			}
			out.set(value, n);
			n += value.length;
		}
	} catch (e) {
		if (e instanceof UnreadableWorkbookError) throw e;
		throw unreadable('corrupt', `a part of it (${name}) is damaged`);
	}
	if (n !== size) throw unreadable('corrupt', `a part of it (${name}) is shorter than its zip header says`);
	return out;
}

export interface StoredEntry {
	name: string;
	data: Uint8Array;
	/** CRC-32 of `data`, already known (ZipArchive.read() checked it). */
	crc: number;
}

/**
 * The entries as a zip with no compression, for SheetJS to open. Stored
 * entries cost SheetJS a slice each, where deflated ones would be inflated a
 * second time.
 */
export function storedZip(entries: readonly StoredEntry[]): Uint8Array {
	const enc = new TextEncoder();
	const names = entries.map((e) => enc.encode(e.name));
	const localSize = entries.reduce((n, e, i) => n + 30 + names[i]!.length + e.data.length, 0);
	const cdSize = names.reduce((n, nm) => n + 46 + nm.length, 0);
	const out = new Uint8Array(localSize + cdSize + 22);
	const v = new DataView(out.buffer);
	const offsets: number[] = [];
	let o = 0;
	entries.forEach((e, i) => {
		const nm = names[i]!;
		offsets.push(o);
		v.setUint32(o, SIG_LOCAL, true);
		v.setUint16(o + 4, 10, true); // version needed 1.0 (stored)
		v.setUint16(o + 8, 0, true); // method: stored
		v.setUint16(o + 12, 0x21, true); // 1980-01-01
		v.setUint32(o + 14, e.crc, true);
		v.setUint32(o + 18, e.data.length, true);
		v.setUint32(o + 22, e.data.length, true);
		v.setUint16(o + 26, nm.length, true);
		out.set(nm, o + 30);
		out.set(e.data, o + 30 + nm.length);
		o += 30 + nm.length + e.data.length;
	});
	const cdStart = o;
	entries.forEach((e, i) => {
		const nm = names[i]!;
		v.setUint32(o, SIG_CENTRAL, true);
		v.setUint16(o + 4, 10, true);
		v.setUint16(o + 6, 10, true);
		v.setUint16(o + 14, 0x21, true);
		v.setUint32(o + 16, e.crc, true);
		v.setUint32(o + 20, e.data.length, true);
		v.setUint32(o + 24, e.data.length, true);
		v.setUint16(o + 28, nm.length, true);
		v.setUint32(o + 42, offsets[i]!, true);
		out.set(nm, o + 46);
		o += 46 + nm.length;
	});
	v.setUint32(o, SIG_END, true);
	v.setUint16(o + 8, entries.length, true);
	v.setUint16(o + 10, entries.length, true);
	v.setUint32(o + 12, o - cdStart, true);
	v.setUint32(o + 16, cdStart, true);
	return out;
}
