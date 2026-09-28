// The import's zip reader on well-formed, malformed and hostile archives:
// every refusal is a typed WorkbookImportError, never a hang, an unbounded
// allocation or a SheetJS stack trace.
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { crc32, zip as deflatedZip } from '../export/zip';
import { UnreadableWorkbookError, WorkbookTooLargeError } from './errors';
import { ZipArchive, inflateRaw, storedZip } from './zip';

const enc = new TextEncoder();
const entry = (name: string, text: string) => ({ name, data: enc.encode(text), crc: crc32(enc.encode(text)) });

/** A one-entry deflated zip whose header fields can then be tampered with. */
function oneDeflated(data: Uint8Array, name = 'a.xml'): { bytes: Uint8Array; view: DataView; cd: number } {
	const packed = new Uint8Array(deflateRawSync(data));
	const nm = enc.encode(name);
	const local = 30 + nm.length;
	const cd = local + packed.length;
	const out = new Uint8Array(cd + 46 + nm.length + 22);
	const v = new DataView(out.buffer);
	v.setUint32(0, 0x04034b50, true);
	v.setUint16(8, 8, true);
	v.setUint32(14, crc32(data), true);
	v.setUint32(18, packed.length, true);
	v.setUint32(22, data.length, true);
	v.setUint16(26, nm.length, true);
	out.set(nm, 30);
	out.set(packed, local);
	v.setUint32(cd, 0x02014b50, true);
	v.setUint16(cd + 10, 8, true);
	v.setUint32(cd + 16, crc32(data), true);
	v.setUint32(cd + 20, packed.length, true);
	v.setUint32(cd + 24, data.length, true);
	v.setUint16(cd + 28, nm.length, true);
	out.set(nm, cd + 46);
	const end = cd + 46 + nm.length;
	v.setUint32(end, 0x06054b50, true);
	v.setUint16(end + 8, 1, true);
	v.setUint16(end + 10, 1, true);
	v.setUint32(end + 12, 46 + nm.length, true);
	v.setUint32(end + 16, cd, true);
	return { bytes: out, view: v, cd };
}

const reasonOf = async (p: Promise<unknown> | (() => unknown)) => {
	try {
		await (typeof p === 'function' ? p() : p);
	} catch (e) {
		if (e instanceof UnreadableWorkbookError) return e.reason;
		if (e instanceof WorkbookTooLargeError) return `too-large:${e.what}`;
		throw e;
	}
	return 'ok';
};

describe('ZipArchive: well-formed archives', () => {
	it('round-trips a stored zip and finds names case-insensitively', async () => {
		const z = await ZipArchive.open(storedZip([entry('[Content_Types].xml', '<Types/>'), entry('xl/Workbook.xml', '<workbook/>')]));
		expect(z.names).toEqual(['[Content_Types].xml', 'xl/Workbook.xml']);
		expect(z.find('xl/workbook.xml')).toBe('xl/Workbook.xml');
		expect(new TextDecoder().decode(await z.read('xl/workbook.xml'))).toBe('<workbook/>');
		expect(z.inflatedBytes).toBe(11);
	});

	it('reads the deflated zips the export writes and SheetJS writes', async () => {
		const text = 'x'.repeat(10_000) + 'end';
		const ours = await ZipArchive.open(await deflatedZip([{ name: 'a.txt', data: enc.encode(text) }]));
		expect(new TextDecoder().decode(await ours.read('a.txt'))).toBe(text);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1, 'two']]), 'S');
		const sheetjs = await ZipArchive.open(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer));
		expect(new TextDecoder().decode(await sheetjs.read('xl/workbook.xml'))).toContain('<sheet ');
	});
});

describe('ZipArchive: malformed and hostile archives', () => {
	it('refuses what is not a zip', async () => {
		await expect(ZipArchive.open(new Uint8Array(0))).rejects.toThrow(UnreadableWorkbookError);
		await expect(ZipArchive.open(enc.encode('PK not really a zip, just text that is long enough'))).rejects.toThrow(UnreadableWorkbookError);
	});

	it('refuses a directory that points outside the file', async () => {
		const { bytes, view, cd } = oneDeflated(enc.encode('hello'));
		const end = bytes.length - 22;
		view.setUint32(end + 16, bytes.length, true); // directory offset past the end
		expect(await reasonOf(() => ZipArchive.open(bytes))).toBe('corrupt');
		view.setUint32(end + 16, cd, true);
		view.setUint16(end + 10, 5, true); // more entries than the directory holds
		view.setUint16(end + 8, 5, true);
		expect(await reasonOf(() => ZipArchive.open(bytes))).toBe('corrupt');
	});

	it('refuses a local header offset or a compressed size past the end', async () => {
		const a = oneDeflated(enc.encode('hello'));
		a.view.setUint32(a.cd + 42, a.bytes.length - 10, true);
		expect(await reasonOf((await ZipArchive.open(a.bytes)).read('a.xml'))).toBe('corrupt');
		const b = oneDeflated(enc.encode('hello'));
		b.view.setUint32(b.cd + 20, 0x7fffffff, true);
		expect(await reasonOf((await ZipArchive.open(b.bytes)).read('a.xml'))).toBe('corrupt');
	});

	it('refuses ZIP64, split archives and duplicate names', async () => {
		const a = oneDeflated(enc.encode('hello'));
		a.view.setUint32(a.cd + 24, 0xffffffff, true);
		expect(await reasonOf(() => ZipArchive.open(a.bytes))).toBe('zip64');
		const b = oneDeflated(enc.encode('hello'));
		b.view.setUint16(b.bytes.length - 22 + 10, 0xffff, true);
		expect(await reasonOf(() => ZipArchive.open(b.bytes))).toBe('zip64');
		const c = oneDeflated(enc.encode('hello'));
		c.view.setUint16(c.bytes.length - 22 + 4, 1, true); // disk number
		expect(await reasonOf(() => ZipArchive.open(c.bytes))).toBe('corrupt');
		const dup = storedZip([entry('a.xml', 'one'), entry('a.xml', 'two')]);
		expect(await reasonOf(() => ZipArchive.open(dup))).toBe('corrupt');
	});

	it('refuses encrypted entries and unknown compression methods', async () => {
		const a = oneDeflated(enc.encode('hello'));
		a.view.setUint16(a.cd + 8, 1, true);
		expect(await reasonOf((await ZipArchive.open(a.bytes)).read('a.xml'))).toBe('encrypted');
		const b = oneDeflated(enc.encode('hello'));
		b.view.setUint16(b.cd + 10, 12, true); // bzip2
		expect(await reasonOf((await ZipArchive.open(b.bytes)).read('a.xml'))).toBe('method');
	});

	it('stops a zip bomb at its declared size, before it fills memory', async () => {
		// 16 MB of zeros deflates to ~16 KB; the header claims 1 KB.
		const bomb = oneDeflated(new Uint8Array(16 * 1024 * 1024));
		bomb.view.setUint32(bomb.cd + 24, 1024, true);
		expect(await reasonOf((await ZipArchive.open(bomb.bytes)).read('a.xml'))).toBe('corrupt');
	});

	it('caps each entry and the total by declared size before inflating anything', async () => {
		const big = oneDeflated(new Uint8Array(2_000_000));
		expect(await reasonOf((await ZipArchive.open(big.bytes, { maxEntryBytes: 1_000_000 })).read('a.xml'))).toBe('too-large:unpacked');
		const two = storedZip([entry('a', 'x'.repeat(600)), entry('b', 'y'.repeat(600))]);
		const z = await ZipArchive.open(two, { maxTotalBytes: 1000 });
		await z.read('a');
		expect(await reasonOf(z.read('b'))).toBe('too-large:unpacked');
		expect(z.inflatedBytes).toBe(600);
	});

	it('refuses too many entries', async () => {
		const many = storedZip(Array.from({ length: 30 }, (_, i) => entry(`p${i}`, '')));
		await expect(ZipArchive.open(many, { maxEntries: 20 })).rejects.toThrow(UnreadableWorkbookError);
	});

	it('detects a damaged entry: bad deflate data, short output, wrong checksum', async () => {
		const a = oneDeflated(enc.encode('hello world'));
		a.bytes.fill(0xff, 30 + 5, 30 + 5 + 4); // garbage in the deflate stream
		expect(await reasonOf((await ZipArchive.open(a.bytes)).read('a.xml'))).toBe('corrupt');
		const b = oneDeflated(enc.encode('hello world'));
		b.view.setUint32(b.cd + 24, 50, true); // claims more than it inflates to
		expect(await reasonOf((await ZipArchive.open(b.bytes)).read('a.xml'))).toBe('corrupt');
		const c = oneDeflated(enc.encode('hello world'));
		c.view.setUint32(c.cd + 16, 1234, true);
		expect(await reasonOf((await ZipArchive.open(c.bytes)).read('a.xml'))).toBe('corrupt');
	});
});

describe('ZipArchive.stream', () => {
	const collect = async (z: ZipArchive, name: string) => {
		const chunks: Uint8Array[] = [];
		await z.stream(name, (c) => chunks.push(c.slice()));
		return chunks;
	};

	it('hands an entry over in chunks that add up to it, deflated or stored', async () => {
		const data = enc.encode(Array.from({ length: 50_000 }, (_, i) => `<c r="A${i}"><v>${i * 7}</v></c>`).join(''));
		const deflated = await ZipArchive.open(oneDeflated(data).bytes);
		const chunks = await collect(deflated, 'a.xml');
		expect(chunks.length).toBeGreaterThan(1);
		expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(new TextDecoder().decode(data));
		expect(deflated.inflatedBytes).toBe(data.length);
		const stored = await ZipArchive.open(storedZip([{ name: 's.xml', data, crc: crc32(data) }]));
		const storedChunks = await collect(stored, 's.xml');
		expect(storedChunks.length).toBeGreaterThan(1);
		expect(Buffer.concat(storedChunks).equals(Buffer.from(data))).toBe(true);
	});

	it("stops at once on the sink's error and passes it on unchanged", async () => {
		const z = await ZipArchive.open(oneDeflated(new Uint8Array(4_000_000).fill(0x41)).bytes);
		const mine = new Error('the parser gave up');
		let calls = 0;
		await expect(
			z.stream('a.xml', () => {
				calls++;
				throw mine;
			})
		).rejects.toBe(mine);
		expect(calls).toBe(1);
		expect(z.inflatedBytes).toBe(0);
	});

	it('stops a bomb mid-stream and checks the checksum at the end', async () => {
		const bomb = oneDeflated(new Uint8Array(16 * 1024 * 1024));
		bomb.view.setUint32(bomb.cd + 24, 100_000, true);
		let seen = 0;
		expect(await reasonOf((await ZipArchive.open(bomb.bytes)).stream('a.xml', (c) => (seen += c.length)))).toBe('corrupt');
		expect(seen).toBeLessThanOrEqual(100_000);
		const bad = oneDeflated(enc.encode('hello world'));
		bad.view.setUint32(bad.cd + 16, 1234, true);
		expect(await reasonOf((await ZipArchive.open(bad.bytes)).stream('a.xml', () => {}))).toBe('corrupt');
		expect(await reasonOf((await ZipArchive.open(oneDeflated(new Uint8Array(2_000_000)).bytes, { maxEntryBytes: 1_000_000 })).stream('a.xml', () => {}))).toBe('too-large:unpacked');
	});
});

describe('ZipArchive over a File', () => {
	/** A Blob that records every slice read from it (issue #23: the file is read a slice at a time, never whole). */
	class SpyBlob extends Blob {
		reads: [number, number][] = [];
		override slice(start = 0, end = this.size, type?: string): Blob {
			this.reads.push([start, Math.min(end, this.size)]);
			return super.slice(start, end, type);
		}
	}
	const random = (n: number) => {
		const out = new Uint8Array(n);
		for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
		return out;
	};

	it('reads only the directory and the entry asked for, not the whole file', async () => {
		// A small part beside a 3 MB one that doesn't compress, as a workbook's
		// few read sheets sit beside its calculation chain and media.
		const bulk = random(3_000_000);
		const file = new SpyBlob([await deflatedZip([entry('[Content_Types].xml', '<Types/>'), { name: 'xl/media/big.bin', data: bulk }])]);
		const z = await ZipArchive.open(file);
		expect(new TextDecoder().decode(await z.read('[Content_Types].xml'))).toBe('<Types/>');
		const read = file.reads.reduce((n, [a, b]) => n + b - a, 0);
		expect(read).toBeLessThan(100_000);
		expect(file.reads.every(([a, b]) => b - a <= 22 + 65535 + 20)).toBe(true);
	});

	it('feeds the inflater bounded slices of a large entry, however big it is', async () => {
		// WebKit's DecompressionStream turns each input chunk into one output
		// chunk, so a whole entry handed over at once came out whole.
		const data = enc.encode(Array.from({ length: 200_000 }, (_, i) => `<c r="B${i}"><v>${(i * 0.37).toFixed(3)}</v></c>`).join(''));
		const file = new SpyBlob([oneDeflated(data).bytes]);
		const z = await ZipArchive.open(file);
		file.reads = [];
		let n = 0;
		await z.stream('a.xml', (c) => (n += c.length));
		expect(n).toBe(data.length);
		const slices = file.reads.slice(1); // after the local header
		expect(slices.length).toBeGreaterThan(1);
		expect(Math.max(...slices.map(([a, b]) => b - a))).toBeLessThanOrEqual(64 * 1024);
	});

	it('reads a File exactly as the same bytes in memory', async () => {
		const data = enc.encode('<sheetData>' + 'x'.repeat(300_000) + '</sheetData>');
		const bytes = oneDeflated(data).bytes;
		const fromFile = await (await ZipArchive.open(new File([bytes], 'w.xlsx'))).read('a.xml');
		expect(Buffer.from(fromFile).equals(Buffer.from(data))).toBe(true);
	});
});

describe('inflateRaw', () => {
	it('inflates into exactly the declared size', async () => {
		const data = enc.encode('abc'.repeat(1000));
		expect(await inflateRaw(new Uint8Array(deflateRawSync(data)), data.length)).toEqual(data);
	});
});
