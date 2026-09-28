// A minimal zip writer for the workbook: every part deflated with the
// platform's own `CompressionStream('deflate-raw')` (real zlib deflate, in
// every browser the app supports, in Node and in workers). SheetJS's zip
// writer, which the export used before ./writer.ts, uses a fixed-Huffman
// deflate in the browser, which left a long run's workbook about 2.5 times
// larger. ./writer.ts writes every part; this only packs them.
//
// The container is plain PKZIP as OOXML requires (ECMA-376 Part 2): local
// file headers, the central directory and its end record; method 8 (deflate)
// with sizes and CRC-32 in the local header (no data descriptors), no zip64
// (a part over 4 GB throws), no encryption, ASCII names.

export interface ZipEntry {
	/** Path inside the zip, no leading slash: "xl/worksheets/sheet1.xml". */
	name: string;
	data: Uint8Array;
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

/**
 * CRC-32 (ISO 3309, the zip checksum). Pass the CRC of the bytes before
 * `data` as `crc` to continue it over data that arrives in chunks.
 */
export function crc32(data: Uint8Array, crc = 0): number {
	let c = (crc ^ 0xffffffff) >>> 0;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Raw deflate (RFC 1951) through the platform's CompressionStream. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 1980-01-01 00:00 in MS-DOS format: a fixed, valid stamp, so the same workbook zips to the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const MAX_U32 = 0xffffffff;

/** The entries as one zip file, each deflated. */
export async function zip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		if (!/^[\x20-\x7e]+$/.test(e.name) || e.name.startsWith('/')) throw new Error(`zip: unsupported entry name ${JSON.stringify(e.name)}`);
		const name = new TextEncoder().encode(e.name);
		const packed = await deflateRaw(e.data);
		const crc = crc32(e.data);
		if (e.data.length > MAX_U32 || packed.length > MAX_U32 || offset > MAX_U32) throw new Error('zip: a workbook part is over 4 GB');

		const local = new Uint8Array(30 + name.length);
		const l = new DataView(local.buffer);
		l.setUint32(0, 0x04034b50, true); // local file header signature
		l.setUint16(4, 20, true); // version needed: 2.0 (deflate)
		l.setUint16(6, 0, true); // flags
		l.setUint16(8, 8, true); // method: deflate
		l.setUint16(10, DOS_TIME, true);
		l.setUint16(12, DOS_DATE, true);
		l.setUint32(14, crc, true);
		l.setUint32(18, packed.length, true);
		l.setUint32(22, e.data.length, true);
		l.setUint16(26, name.length, true);
		l.setUint16(28, 0, true); // extra length
		local.set(name, 30);

		const cd = new Uint8Array(46 + name.length);
		const c = new DataView(cd.buffer);
		c.setUint32(0, 0x02014b50, true); // central directory header signature
		c.setUint16(4, 20, true); // version made by
		c.setUint16(6, 20, true); // version needed
		c.setUint16(8, 0, true);
		c.setUint16(10, 8, true);
		c.setUint16(12, DOS_TIME, true);
		c.setUint16(14, DOS_DATE, true);
		c.setUint32(16, crc, true);
		c.setUint32(20, packed.length, true);
		c.setUint32(24, e.data.length, true);
		c.setUint16(28, name.length, true);
		// extra, comment, disk start, internal and external attributes: 0
		c.setUint32(42, offset, true); // local header offset
		cd.set(name, 46);

		parts.push(local, packed);
		central.push(cd);
		offset += local.length + packed.length;
	}
	const cdSize = central.reduce((n, x) => n + x.length, 0);
	if (entries.length > 0xffff || offset > MAX_U32) throw new Error('zip: too many parts or too large');
	const end = new Uint8Array(22);
	const d = new DataView(end.buffer);
	d.setUint32(0, 0x06054b50, true); // end of central directory signature
	d.setUint16(8, entries.length, true);
	d.setUint16(10, entries.length, true);
	d.setUint32(12, cdSize, true);
	d.setUint32(16, offset, true);

	const out = new Uint8Array(offset + cdSize + end.length);
	let o = 0;
	for (const p of [...parts, ...central, end]) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
