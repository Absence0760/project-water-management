// A defensive zip reader: reads the central directory, then inflates only
// the entries asked for, with the platform's `DecompressionStream('deflate-raw')`
// (native zlib; browsers, workers and Node 24 alike), and streams them. Pure,
// so the browser's workbook import (frontend spreadsheet/import/) and the
// evidence pack's reproduction check (evidence/bundle.ts, scripts/reproduce-pack)
// share it; moved here from the frontend on its third caller (issue #71).
//
// Why it exists (WP-1.31 memory fix): SheetJS's own zip reader inflates every
// entry before it looks at any, so a large b023 workbook's memory peaked far
// above the file's size. This streams each entry to a sink as its chunks come
// out (the workbook reader parses each part that way, so no sheet is ever held
// whole), and reads a Blob slice by slice (Blob.slice), never loading it whole
// (issue #23).
//
// The file is untrusted. Every offset and length is bounds-checked against
// the file; each inflated entry and the total are capped before anything is
// allocated, and an entry that inflates past its declared size is stopped at
// once (a zip bomb gets a too-large error, not an out-of-memory tab);
// encrypted entries, ZIP64, split archives and methods other than stored and
// deflate are refused; the CRC-32 of every inflated entry is checked. Nothing
// here executes anything from the file.
//
// Errors come from a ZipErrors factory, so each caller throws its own typed
// errors in its own words (the workbook import: UnreadableWorkbookError and
// WorkbookTooLargeError); the default throws ZipFormatError / ZipTooLargeError.
import { crc32 } from './write';

/**
 * Why an archive couldn't be read: not a zip at all, an encrypted or ZIP64
 * archive, a compression method other than stored or deflate, or a damaged
 * container.
 */
export type ZipUnreadableReason = 'not-zip' | 'encrypted' | 'zip64' | 'method' | 'corrupt';

/** The default error for an archive that can't be read. */
export class ZipFormatError extends Error {
	constructor(
		readonly reason: ZipUnreadableReason,
		readonly detail: string
	) {
		super(`the file couldn't be read as a zip archive (${detail})`);
		this.name = 'ZipFormatError';
	}
}

/** The default error for an entry, or the total inflated, over a limit. */
export class ZipTooLargeError extends Error {
	constructor(
		readonly actual: number,
		readonly limit: number
	) {
		super(`the archive's entries unpack to more than ${Math.floor(limit / 1e6)} MB, the limit`);
		this.name = 'ZipTooLargeError';
	}
}

/** How a caller's errors are made. `detail` is plain text, "it is encrypted". */
export interface ZipErrors {
	unreadable(reason: ZipUnreadableReason, detail: string): Error;
	tooLarge(actual: number, limit: number): Error;
}

export const ZIP_ERRORS: ZipErrors = {
	unreadable: (reason, detail) => new ZipFormatError(reason, detail),
	tooLarge: (actual, limit) => new ZipTooLargeError(actual, limit)
};

/** The detail for an OLE compound file (an old .xls, or a password-protected Office file): a caller may word it for its users. */
export const ZIP_DETAIL_OLE = 'it is an OLE compound file (an old-format Office file, or a password-protected one), not a zip archive';
/** The detail for anything else that isn't a zip. */
export const ZIP_DETAIL_NOT_ZIP = "it isn't a zip archive";

export interface ZipLimits {
	/** Most entries the central directory may list. */
	maxEntries?: number;
	/** Largest single entry, inflated. */
	maxEntryBytes?: number;
	/** Most bytes read() inflates in total, across every entry it's asked for. */
	maxTotalBytes?: number;
}

/**
 * Defaults sized for large b023 workbooks (the import's use): a few hundred
 * zip entries, and the largest sheet the importer reads ([Flow data], a
 * multi-decade daily record) inflating well under the per-entry cap. Other
 * callers pass their own.
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

/** A zip archive's directory, with on-demand, capped inflation of single entries. */
export class ZipArchive {
	private readonly entries = new Map<string, ZipEntryInfo>();
	private readonly lower = new Map<string, string>();
	private inflated = 0;
	readonly limits: Required<ZipLimits>;

	private constructor(
		private readonly file: Blob,
		limits: ZipLimits,
		private readonly errors: ZipErrors
	) {
		this.limits = { ...ZIP_LIMITS, ...limits };
	}

	/**
	 * Parse the end record and the central directory, reading only those from
	 * the file. Throws `errors.unreadable` on anything malformed. Bytes
	 * already in memory are wrapped in a Blob.
	 */
	static async open(file: Blob | Uint8Array<ArrayBuffer>, limits: ZipLimits = {}, errors: ZipErrors = ZIP_ERRORS): Promise<ZipArchive> {
		const zip = new ZipArchive(file instanceof Blob ? file : new Blob([file]), limits, errors);
		await zip.readDirectory();
		return zip;
	}

	/** The file's bytes [start, end), which the caller has checked lie inside it. */
	private async slice(start: number, end: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; view: DataView }> {
		const buf = await this.file.slice(start, end).arrayBuffer();
		return { bytes: new Uint8Array(buf), view: new DataView(buf) };
	}

	/** Every entry name, in directory order. */
	get names(): string[] {
		return [...this.entries.keys()];
	}

	/** The entry's exact name, else one matching case-insensitively (as SheetJS matches OOXML parts); undefined if absent. */
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

	private async readDirectory(): Promise<void> {
		const size = this.file.size;
		const head = await this.slice(0, Math.min(size, 8));
		if (size >= 8 && head.view.getUint32(0, false) === 0xd0cf11e0 && head.view.getUint32(4, false) === 0xa1b11ae1) {
			throw this.errors.unreadable('not-zip', ZIP_DETAIL_OLE);
		}
		if (size < 22) throw this.errors.unreadable('not-zip', ZIP_DETAIL_NOT_ZIP);
		// The end record is the last 22 bytes plus a comment of up to 65535;
		// the tail read also takes the 20 bytes a ZIP64 locator would fill.
		const tailStart = Math.max(0, size - 22 - U16_MAX - 20);
		const tail = await this.slice(tailStart, size);
		let end = -1;
		for (let i = size - 22; i >= Math.max(0, size - 22 - U16_MAX); i--) {
			if (tail.view.getUint32(i - tailStart, true) === SIG_END && i + 22 + tail.view.getUint16(i - tailStart + 20, true) <= size) {
				end = i;
				break;
			}
		}
		if (end < 0) throw this.errors.unreadable('not-zip', ZIP_DETAIL_NOT_ZIP);
		const e = end - tailStart;
		const disk = tail.view.getUint16(e + 4, true);
		const cdDisk = tail.view.getUint16(e + 6, true);
		const onDisk = tail.view.getUint16(e + 8, true);
		const count = tail.view.getUint16(e + 10, true);
		const cdSize = tail.view.getUint32(e + 12, true);
		const cdOffset = tail.view.getUint32(e + 16, true);
		if ((end >= 20 && tail.view.getUint32(e - 20, true) === SIG_ZIP64_LOCATOR) || count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
			throw this.errors.unreadable('zip64', 'it uses the ZIP64 format, which this reader does not read');
		}
		if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw this.errors.unreadable('corrupt', 'it is a split or damaged zip archive');
		if (count > this.limits.maxEntries) throw this.errors.unreadable('corrupt', `it lists ${count} entries, more than the ${this.limits.maxEntries} allowed`);
		if (cdOffset + cdSize > end) throw this.errors.unreadable('corrupt', 'its zip directory is damaged');

		// The directory alone, offsets from its start.
		const { bytes, view } = await this.slice(cdOffset, cdOffset + cdSize);
		let p = 0;
		for (let i = 0; i < count; i++) {
			if (p + 46 > cdSize || view.getUint32(p, true) !== SIG_CENTRAL) throw this.errors.unreadable('corrupt', 'its zip directory is damaged');
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
			if (next > cdSize) throw this.errors.unreadable('corrupt', 'its zip directory is damaged');
			if (compressedSize === U32_MAX || size === U32_MAX || localOffset === U32_MAX) {
				throw this.errors.unreadable('zip64', 'it uses the ZIP64 format, which this reader does not read');
			}
			// Names are read as UTF-8; a name that isn't can't be one a caller asks for, so lossy decoding is harmless.
			const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
			if (this.entries.has(name)) throw this.errors.unreadable('corrupt', 'it lists the same entry twice');
			this.entries.set(name, { name, method, flags, crc, compressedSize, size, localOffset });
			if (!this.lower.has(name.toLowerCase())) this.lower.set(name.toLowerCase(), name);
			p = next;
		}
	}

	/** Where the entry's data lies, from its local header, checked against the file and the directory. */
	private async dataRange(e: ZipEntryInfo): Promise<[number, number]> {
		const h = e.localOffset;
		if (h + 30 > this.file.size) throw this.errors.unreadable('corrupt', `its entry ${e.name} is damaged`);
		const { view } = await this.slice(h, h + 30);
		if (view.getUint32(0, true) !== SIG_LOCAL) throw this.errors.unreadable('corrupt', `its entry ${e.name} is damaged`);
		const start = h + 30 + view.getUint16(26, true) + view.getUint16(28, true);
		const stop = start + e.compressedSize;
		if (stop > this.file.size) throw this.errors.unreadable('corrupt', `its entry ${e.name} is truncated`);
		return [start, stop];
	}

	/** The checks read() and stream() share: flags, method, and the size caps against the declared size. */
	private checked(name: string): ZipEntryInfo {
		const e = this.info(name);
		if (!e) throw this.errors.unreadable('corrupt', `it has no entry ${name}`);
		if (e.flags & 0x2041) throw this.errors.unreadable('encrypted', 'it is encrypted');
		if (e.method !== 0 && e.method !== 8) throw this.errors.unreadable('method', `an entry uses zip compression method ${e.method}, which this reader does not read`);
		const { maxEntryBytes, maxTotalBytes } = this.limits;
		if (e.size > maxEntryBytes) throw this.errors.tooLarge(e.size, maxEntryBytes);
		if (this.inflated + e.size > maxTotalBytes) throw this.errors.tooLarge(this.inflated + e.size, maxTotalBytes);
		return e;
	}

	/**
	 * One entry, inflated chunk by chunk into `sink`, never held whole: how
	 * the reader parses a 40 MB sheet in a chunk's worth of memory. The same
	 * checks as read(): the declared size against the caps before anything is
	 * inflated, inflation stopped the moment it passes that size, and the
	 * CRC-32 checked at the end (the sink has seen the data by then, so a
	 * caller discards what it built when this throws). An error the sink
	 * throws stops inflation and propagates unchanged.
	 */
	async stream(name: string, sink: (chunk: Uint8Array) => void): Promise<void> {
		const e = this.checked(name);
		const [start, stop] = await this.dataRange(e);
		const read = async (at: number, to: number) => (await this.slice(start + at, start + to)).bytes;
		let crc = 0;
		let n = 0;
		const feed = (chunk: Uint8Array) => {
			if (n + chunk.length > e.size) throw this.errors.unreadable('corrupt', `its entry ${e.name} unpacks to more than its zip header says`);
			crc = crc32(chunk, crc);
			n += chunk.length;
			sink(chunk);
		};
		if (e.method === 0) {
			if (e.compressedSize !== e.size) throw this.errors.unreadable('corrupt', `its entry ${e.name} is damaged`);
			for (let i = 0; i < e.size; i += STORED_CHUNK) feed(await read(i, Math.min(e.size, i + STORED_CHUNK)));
		} else {
			await inflateRawChunks(read, stop - start, e.name, feed, this.errors);
		}
		if (n !== e.size) throw this.errors.unreadable('corrupt', `its entry ${e.name} is shorter than its zip header says`);
		if (crc !== e.crc) throw this.errors.unreadable('corrupt', `its entry ${e.name} is damaged (checksum mismatch)`);
		this.inflated += n;
	}

	/** One entry, inflated whole (the small parts: content types, relationships, workbook, styles). */
	async read(name: string): Promise<Uint8Array> {
		const out = new Uint8Array(this.checked(name).size);
		let n = 0;
		await this.stream(name, (chunk) => {
			out.set(chunk, n);
			n += chunk.length;
		});
		return out;
	}
}

/** Stored entries go to a stream() sink in slices of this size, as inflated ones arrive in chunks. */
const STORED_CHUNK = 64 * 1024;

/** Compressed bytes go into the inflater in slices of this size (see inflateRawChunks). */
const INFLATE_SLICE = 64 * 1024;

/**
 * Raw inflate of `length` compressed bytes, which `read(from, to)` returns a
 * slice at a time; each inflated chunk is handed to `feed` as it comes out. A
 * failure of the compressed data itself is `errors.unreadable('corrupt')`;
 * whatever `feed` throws cancels the inflater and propagates as it is.
 */
async function inflateRawChunks(
	read: (from: number, to: number) => Promise<Uint8Array<ArrayBuffer>>,
	length: number,
	name: string,
	feed: (chunk: Uint8Array) => void,
	errors: ZipErrors
): Promise<void> {
	// Pulled in slices, on demand, never enqueued whole: WebKit's
	// DecompressionStream inflates each input chunk into a single output
	// chunk, so a large packed [Flow data] handed over at once came out as
	// one chunk several times its size (issue #23). A slice at a time keeps every browser's
	// output chunks small, and only one slice of the file is read at once.
	let at = 0;
	const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
		async pull(c) {
			if (at >= length) return c.close();
			const to = Math.min(length, at + INFLATE_SLICE);
			c.enqueue(await read(at, to));
			at = to;
		}
	});
	const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
	for (;;) {
		let step: Awaited<ReturnType<typeof reader.read>>;
		try {
			step = await reader.read();
		} catch {
			throw errors.unreadable('corrupt', `its entry ${name} is damaged`);
		}
		if (step.done) return;
		try {
			feed(step.value);
		} catch (e) {
			await reader.cancel().catch(() => {});
			throw e;
		}
	}
}

/**
 * Raw inflate into a buffer of exactly `size` bytes. Output beyond `size`
 * (a lying header, or a bomb) stops the stream at once and throws.
 */
export async function inflateRaw(packed: Uint8Array<ArrayBuffer>, size: number, name = 'a part', errors: ZipErrors = ZIP_ERRORS): Promise<Uint8Array> {
	const out = new Uint8Array(size);
	let n = 0;
	await inflateRawChunks(
		async (from, to) => packed.subarray(from, to),
		packed.length,
		name,
		(chunk) => {
			if (n + chunk.length > size) throw errors.unreadable('corrupt', `its entry ${name} unpacks to more than its zip header says`);
			out.set(chunk, n);
			n += chunk.length;
		},
		errors
	);
	if (n !== size) throw errors.unreadable('corrupt', `its entry ${name} is shorter than its zip header says`);
	return out;
}

export interface StoredEntry {
	name: string;
	data: Uint8Array;
	/** CRC-32 of `data`, already known (ZipArchive.read() checked it). */
	crc: number;
}

/**
 * The entries as a zip with no compression (method 0): test support, and the
 * frontend's SheetJS reference reader the parity tests compare against
 * (spreadsheet/import/sheetjsReference.ts).
 */
export function storedZip(entries: readonly StoredEntry[]): Uint8Array<ArrayBuffer> {
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
