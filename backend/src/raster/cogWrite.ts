// Writes a small tiled GeoTIFF in the layouts cog.ts reads, for synthetic
// fixtures and cog.test.ts. By default it is laid out like a Digital Earth
// Africa WOfS scene: classic TIFF, one uint8 band, tiles, DEFLATE through
// node:zlib with the horizontal predictor, GDAL's 4-byte size before each
// tile, GDAL_NODATA, and GeoKeys for WGS 84 / UTM. It also writes the forms
// the WaPOR (#623) and Sentinel (#624) passes meet: BigTIFF, LZW (the CHIRPS
// writer's encoder), int16 / uint16 / float32 samples (the sample type is
// the values' array type), the floating-point predictor, EPSG:4326 grids, a
// GDAL scale and offset, and tile tables placed past the header read. The
// fixture sources (dams/observed/wofs/fixtures.ts) serve scenes made here,
// and cog.test.ts round-trips the reader through it, so the reader is
// exercised on the layout it meets in production. Also writes the legal
// variants the reader must still read (big-endian, no compression, no
// predictor, an empty tile, PixelIsPoint) and, through `override`, the ones
// it must refuse.
import { deflateSync } from 'node:zlib';
import { lzwEncode } from '../feeds/sources/tiff-write.js';
import type { Samples, SampleType } from './cog.js';

export interface CogSpec {
	width: number;
	height: number;
	/** Row-major samples, width × height; the array type is the sample type. */
	values: Samples;
	/** EPSG 326xx / 327xx, or 4326. */
	epsg: number;
	/** Top-left corner of pixel (0, 0): metres, or degrees for 4326. */
	originX: number;
	originY: number;
	/** Metres (or degrees) per pixel (default 30). */
	pixelSize?: number;
	/** Tile side (default 512, as WOfS). */
	tile?: number;
	compression?: 1 | 5 | 8;
	/** Default 2 for integer samples, 3 for float32. */
	predictor?: 1 | 2 | 3;
	/** GDAL_NODATA text (default "1" for uint8, as WOfS, else none); null writes none. */
	nodata?: string | null;
	bigEndian?: boolean;
	bigTiff?: boolean;
	/** Write the tiepoint as pixel (0, 0)'s centre (GTRasterTypeGeoKey 2, PixelIsPoint). */
	pixelIsPoint?: boolean;
	/** Tiles (row-major indices) written empty, offset and size 0 (GDAL's SPARSE_OK). */
	sparse?: number[];
	/** A GDAL band scale and offset, written as GDAL metadata. */
	scaleOffset?: { scale: number; offset: number };
	/** Bytes of padding before the tile tables, so they lie past the reader's first read (as a continental grid's do). */
	tableGap?: number;
	/** Replace or add tags (tag → [type, values]), or drop one (null): for malformed files. */
	override?: Record<number, [number, number[]] | null>;
	/** Replace GeoKeys (key → value), or drop one (null). */
	geoKeys?: Record<number, number | null>;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8, 16: 8 };

export function sampleTypeOf(values: Samples): SampleType {
	if (values instanceof Uint8Array) return 'uint8';
	if (values instanceof Int16Array) return 'int16';
	if (values instanceof Uint16Array) return 'uint16';
	return 'float32';
}

const FORM: Record<SampleType, { bits: number; format: number; bytes: number }> = {
	uint8: { bits: 8, format: 1, bytes: 1 },
	int16: { bits: 16, format: 2, bytes: 2 },
	uint16: { bits: 16, format: 1, bytes: 2 },
	float32: { bits: 32, format: 3, bytes: 4 }
};

/** One tile's bytes as the file stores them before compression: the predictor applied, in the file's byte order. */
function tileBytes(t: Samples, type: SampleType, tile: number, predictor: 1 | 2 | 3, le: boolean): Uint8Array {
	if (type === 'uint8') {
		const b = Uint8Array.from(t as Uint8Array);
		if (predictor === 2) for (let r = 0; r < tile; r++) for (let c = tile - 1; c >= 1; c--) b[r * tile + c] = (b[r * tile + c]! - b[r * tile + c - 1]!) & 0xff;
		return b;
	}
	const out = new Uint8Array(tile * tile * FORM[type].bytes);
	const v = new DataView(out.buffer);
	if (type === 'float32') {
		if (predictor !== 3) {
			t.forEach((x, i) => v.setFloat32(i * 4, x, le));
			return out;
		}
		// The floating-point predictor: per row, the samples' big-endian bytes as four planes, then byte differences.
		const be = new DataView(new ArrayBuffer(4));
		for (let r = 0; r < tile; r++) {
			const row = out.subarray(r * tile * 4, (r + 1) * tile * 4);
			for (let c = 0; c < tile; c++) {
				be.setFloat32(0, t[r * tile + c]!, false);
				for (let b = 0; b < 4; b++) row[b * tile + c] = be.getUint8(b);
			}
			for (let i = row.length - 1; i >= 1; i--) row[i] = (row[i]! - row[i - 1]!) & 0xff;
		}
		return out;
	}
	const u = new Uint16Array(type === 'int16' ? Int16Array.from(t as Int16Array).buffer : Uint16Array.from(t as Uint16Array).buffer);
	if (predictor === 2) for (let r = 0; r < tile; r++) for (let c = tile - 1; c >= 1; c--) u[r * tile + c] = (u[r * tile + c]! - u[r * tile + c - 1]!) & 0xffff;
	u.forEach((x, i) => v.setUint16(i * 2, x, le));
	return out;
}

/** The scene's tiles, each `tile × tile` (edge tiles padded with no-data), as stored before compression. */
function tilesOf(spec: CogSpec, type: SampleType, tile: number, pad: number, predictor: 1 | 2 | 3, le: boolean): Uint8Array[] {
	const across = Math.ceil(spec.width / tile);
	const down = Math.ceil(spec.height / tile);
	const Ctor = spec.values.constructor as new (n: number) => Samples;
	const out: Uint8Array[] = [];
	for (let tr = 0; tr < down; tr++) {
		for (let tc = 0; tc < across; tc++) {
			const t = new Ctor(tile * tile).fill(pad);
			for (let r = 0; r < tile; r++) {
				const y = tr * tile + r;
				if (y >= spec.height) break;
				const x0 = tc * tile;
				const n = Math.min(tile, spec.width - x0);
				(t as Uint8Array).set((spec.values as Uint8Array).subarray(y * spec.width + x0, y * spec.width + x0 + n), r * tile);
			}
			out.push(tileBytes(t, type, tile, predictor, le));
		}
	}
	return out;
}

export function writeCog(spec: CogSpec): Uint8Array {
	if (spec.values.length !== spec.width * spec.height) throw new RangeError('values must hold width × height samples');
	const type = sampleTypeOf(spec.values);
	const tile = spec.tile ?? 512;
	const size = spec.pixelSize ?? 30;
	const compression = spec.compression ?? 8;
	const predictor = spec.predictor ?? (type === 'float32' ? 3 : 2);
	const nodata = spec.nodata === undefined ? (type === 'uint8' ? '1' : null) : spec.nodata;
	const le = !spec.bigEndian;
	const big = spec.bigTiff ?? false;
	const sparse = new Set(spec.sparse ?? []);
	const pad = nodata === null || /nan/i.test(nodata) ? (type === 'float32' && nodata !== null ? Number.NaN : 0) : Number(nodata);
	const raw = tilesOf(spec, type, tile, pad, predictor, le);
	const compress = (t: Uint8Array) => (compression === 8 ? new Uint8Array(deflateSync(t)) : compression === 5 ? lzwEncode(t) : t);
	const stored = raw.map((t, i) => (sparse.has(i) ? new Uint8Array(0) : compress(t)));

	const geographic = spec.epsg === 4326;
	const keys: Record<number, number> = geographic
		? { 1024: 2, 1025: spec.pixelIsPoint ? 2 : 1, 2048: 4326, 2054: 9102 }
		: { 1024: 1, 1025: spec.pixelIsPoint ? 2 : 1, 3072: spec.epsg, 3076: 9001 };
	for (const [k, v] of Object.entries(spec.geoKeys ?? {})) {
		if (v === null) delete keys[Number(k)];
		else keys[Number(k)] = v;
	}
	const keyList = Object.entries(keys).sort(([a], [b]) => Number(a) - Number(b));
	const geoKeyDir = [1, 1, 0, keyList.length, ...keyList.flatMap(([k, v]) => [Number(k), 0, 1, v])];
	const half = spec.pixelIsPoint ? 0.5 : 0;
	const tableType = big ? 16 : 4;

	const tags: Record<number, [number, number[]]> = {
		256: [3, [spec.width]],
		257: [3, [spec.height]],
		258: [3, [FORM[type].bits]],
		259: [3, [compression]],
		262: [3, [1]],
		277: [3, [1]],
		284: [3, [1]],
		317: [3, [predictor]],
		322: [3, [tile]],
		323: [3, [tile]],
		324: [tableType, stored.map(() => 0)], // filled in below
		325: [tableType, stored.map((s) => s.length)],
		339: [3, [FORM[type].format]],
		33550: [12, [size, size, 0]],
		33922: [12, [0, 0, 0, spec.originX + half * size, spec.originY - half * size, 0]],
		34735: [3, geoKeyDir]
	};
	const ascii: Record<number, string> = {};
	if (nodata !== null) ascii[42113] = `${nodata}\0`;
	if (spec.scaleOffset) {
		const { scale, offset } = spec.scaleOffset;
		ascii[42112] = `<GDALMetadata>\n  <Item name="SCALE" sample="0" role="scale">${scale}</Item>\n  <Item name="OFFSET" sample="0" role="offset">${offset}</Item>\n</GDALMetadata>\0`;
	}
	for (const [k, v] of Object.entries(spec.override ?? {})) {
		if (v === null) {
			delete tags[Number(k)];
			delete ascii[Number(k)];
		} else if (v[0] === 2) {
			ascii[Number(k)] = String.fromCharCode(...v[1]);
		} else {
			tags[Number(k)] = v;
		}
	}

	// Layout: header (8, or 16) | IFD | out-of-line values | [gap | tile tables] | tiles (each a 4-byte size, then its bytes).
	const headerSize = big ? 16 : 8;
	const entrySize = big ? 20 : 12;
	const inlineSize = big ? 8 : 4;
	const all = [...Object.keys(tags), ...Object.keys(ascii)].map(Number).sort((a, b) => a - b);
	const ifdOffset = headerSize;
	const ifdSize = (big ? 8 : 2) + all.length * entrySize + (big ? 8 : 4);
	let cursor = ifdOffset + ifdSize;
	const outOfLine = new Map<number, number>();
	const sizeOf = (tag: number) => (tag in ascii ? ascii[tag]!.length : TYPE_SIZE[tags[tag]![0]]! * tags[tag]![1].length);
	const isTable = (tag: number) => spec.tableGap !== undefined && (tag === 324 || tag === 325);
	const place = (tag: number) => {
		const s = sizeOf(tag);
		if (s > inlineSize) {
			cursor += cursor % 2; // word-aligned values
			outOfLine.set(tag, cursor);
			cursor += s;
		}
	};
	for (const tag of all) if (!isTable(tag)) place(tag);
	if (spec.tableGap !== undefined) {
		cursor += spec.tableGap;
		for (const tag of all) if (isTable(tag)) place(tag);
	}
	const offsets: number[] = [];
	for (const s of stored) {
		if (s.length === 0) {
			offsets.push(0);
			continue;
		}
		cursor += 4; // GDAL's BLOCK_LEADER: the tile's size as a uint32
		offsets.push(cursor);
		cursor += s.length;
	}
	if (tags[324] && !(spec.override && 324 in spec.override)) tags[324] = [tableType, offsets];

	const buf = new Uint8Array(cursor);
	const v = new DataView(buf.buffer);
	buf[0] = buf[1] = le ? 0x49 : 0x4d;
	if (big) {
		v.setUint16(2, 43, le);
		v.setUint16(4, 8, le);
		v.setUint16(6, 0, le);
		v.setBigUint64(8, BigInt(ifdOffset), le);
		v.setBigUint64(ifdOffset, BigInt(all.length), le);
	} else {
		v.setUint16(2, 42, le);
		v.setUint32(4, ifdOffset, le);
		v.setUint16(ifdOffset, all.length, le);
	}
	const put = (at: number, type: number, values: number[]) => {
		values.forEach((x, i) => {
			const p = at + i * TYPE_SIZE[type]!;
			if (type === 1) v.setUint8(p, x);
			else if (type === 3) v.setUint16(p, x, le);
			else if (type === 4) v.setUint32(p, x, le);
			else if (type === 16) v.setBigUint64(p, BigInt(x), le);
			else v.setFloat64(p, x, le);
		});
	};
	all.forEach((tag, i) => {
		const p = ifdOffset + (big ? 8 : 2) + i * entrySize;
		const isAscii = tag in ascii;
		const t = isAscii ? 2 : tags[tag]![0];
		const values = isAscii ? [...ascii[tag]!].map((c) => c.charCodeAt(0)) : tags[tag]![1];
		v.setUint16(p, tag, le);
		v.setUint16(p + 2, t, le);
		if (big) v.setBigUint64(p + 4, BigInt(values.length), le);
		else v.setUint32(p + 4, values.length, le);
		const valueAt = p + (big ? 12 : 8);
		const at = outOfLine.get(tag);
		if (at !== undefined) {
			if (big) v.setBigUint64(valueAt, BigInt(at), le);
			else v.setUint32(valueAt, at, le);
		}
		put(at ?? valueAt, isAscii ? 1 : t, values);
	});
	stored.forEach((s, i) => {
		if (s.length === 0) return;
		v.setUint32(offsets[i]! - 4, s.length, le);
		buf.set(s, offsets[i]!);
	});
	return buf;
}
