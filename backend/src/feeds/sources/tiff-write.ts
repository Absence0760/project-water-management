// Writes a small GeoTIFF laid out like the Climate Hazards Center's daily
// files (sources/tiff.ts has the layout): little-endian, one float32 band,
// LZW, one row per strip, the IFD and its arrays after the image data, a
// float32-rounded pixel scale and a (lon, lat) tiepoint. The fixture source
// (feeds/fixtures.ts) serves grids made here, and tiff.test.ts round-trips
// the reader through it, so the reader is exercised on exactly the layout it
// meets in production. Also writes the legal variants the reader must still
// read right (big-endian, several rows per strip) and the ones it must refuse.

export interface GridSpec {
	width: number;
	height: number;
	originLon: number;
	originLat: number;
	scale: number;
	/** Row-major values; NaN or -9999 for "no data". */
	values: Float32Array | number[];
	compression?: 1 | 5;
	/** Extra or replacement tags, for writing malformed files: tag → [type, values]. */
	override?: Record<number, [number, number[]] | null>;
	/** A GDAL_NODATA tag (ASCII). */
	nodata?: string;
	/** Byte order of the whole file, header to samples (default little-endian, like the CHC files). */
	bigEndian?: boolean;
	/** Rows per strip (default 1, like the CHC files); the last strip may be shorter. */
	rowsPerStrip?: number;
}

const CLEAR = 256;
const EOI = 257;

/** TIFF LZW encoding (MSB-first, early change), the inverse of tiff.ts lzwDecode. */
export function lzwEncode(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	let acc = 0;
	let bits = 0;
	let width = 9;
	const write = (code: number) => {
		acc = (acc << width) | code;
		bits += width;
		while (bits >= 8) {
			out.push((acc >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
		acc &= (1 << bits) - 1;
	};
	let dict = new Map<string, number>();
	let next = 258;
	const reset = () => {
		dict = new Map();
		next = 258;
		width = 9;
	};
	write(CLEAR);
	let w = '';
	let wCode = -1;
	for (const byte of data) {
		const wc = w + String.fromCharCode(byte);
		const known = wc.length === 1 ? byte : dict.get(wc);
		if (known !== undefined) {
			w = wc;
			wCode = known;
			continue;
		}
		write(wCode);
		dict.set(wc, next++);
		if (next > (1 << width) - 1 && width < 12) width++;
		if (next >= 4094) {
			write(CLEAR);
			reset();
		}
		w = String.fromCharCode(byte);
		wCode = byte;
	}
	if (wCode !== -1) write(wCode);
	// The decoder grows its width one entry later than we do; match it for End.
	if (next + 1 > (1 << width) - 1 && width < 12) width++;
	write(EOI);
	if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
	return Uint8Array.from(out);
}

export function writeGrid(spec: GridSpec): Uint8Array {
	const { width, height } = spec;
	const compression = spec.compression ?? 5;
	const le = !spec.bigEndian;
	const rowsPerStrip = spec.rowsPerStrip ?? 1;
	const strips: Uint8Array[] = [];
	for (let r0 = 0; r0 < height; r0 += rowsPerStrip) {
		const rows = Math.min(rowsPerStrip, height - r0);
		const strip = new Uint8Array(rows * width * 4);
		const dv = new DataView(strip.buffer);
		for (let i = 0; i < rows * width; i++) dv.setFloat32(i * 4, Number(spec.values[r0 * width + i] ?? NaN), le);
		strips.push(compression === 5 ? lzwEncode(strip) : strip);
	}

	const chunks: Uint8Array[] = [];
	let pos = 8;
	const header = new Uint8Array(8);
	chunks.push(header);
	const offsets: number[] = [];
	for (const s of strips) {
		offsets.push(pos);
		chunks.push(s);
		pos += s.length;
	}
	if (pos % 2) {
		chunks.push(new Uint8Array(1));
		pos++;
	}

	const f32 = (v: number) => Math.fround(v);
	const tags: Record<number, [number, number[]]> = {
		256: [3, [width]],
		257: [3, [height]],
		258: [3, [32]],
		259: [3, [compression]],
		262: [3, [1]],
		273: [4, offsets],
		277: [3, [1]],
		278: [3, [rowsPerStrip]],
		279: [4, strips.map((s) => s.length)],
		284: [3, [1]],
		339: [3, [3]],
		33550: [12, [f32(spec.scale), f32(spec.scale), 0]],
		33922: [12, [0, 0, 0, spec.originLon, spec.originLat, 0]],
		34735: [3, [1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102]]
	};
	if (spec.nodata !== undefined) tags[42113] = [2, [...new TextEncoder().encode(`${spec.nodata}\0`)]];
	for (const [k, v] of Object.entries(spec.override ?? {})) {
		if (v === null) delete tags[Number(k)];
		else tags[Number(k)] = v;
	}

	const SIZE: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };
	const ids = Object.keys(tags).map(Number).sort((a, b) => a - b);
	const ifdOffset = pos;
	const ifdSize = 2 + ids.length * 12 + 4;
	let extra = ifdOffset + ifdSize;
	const ifd = new Uint8Array(ifdSize);
	const iv = new DataView(ifd.buffer);
	iv.setUint16(0, ids.length, le);
	const tail: Uint8Array[] = [];
	const put = (dv: DataView, at: number, type: number, vals: number[]) => {
		vals.forEach((v, i) => {
			if (type === 2) dv.setUint8(at + i, v);
			else if (type === 3) dv.setUint16(at + i * 2, v, le);
			else if (type === 4) dv.setUint32(at + i * 4, v, le);
			else dv.setFloat64(at + i * 8, v, le);
		});
	};
	ids.forEach((id, i) => {
		const [type, vals] = tags[id]!;
		const p = 2 + i * 12;
		iv.setUint16(p, id, le);
		iv.setUint16(p + 2, type, le);
		iv.setUint32(p + 4, vals.length, le);
		const size = SIZE[type]! * vals.length;
		if (size <= 4) {
			put(iv, p + 8, type, vals);
		} else {
			iv.setUint32(p + 8, extra, le);
			const buf = new Uint8Array(size + (size % 2));
			put(new DataView(buf.buffer), 0, type, vals);
			tail.push(buf);
			extra += buf.length;
		}
	});
	const hv = new DataView(header.buffer);
	header[0] = header[1] = le ? 0x49 : 0x4d;
	hv.setUint16(2, 42, le);
	hv.setUint32(4, ifdOffset, le);

	const all = [...chunks, ifd, ...tail];
	const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
	let o = 0;
	for (const c of all) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}
