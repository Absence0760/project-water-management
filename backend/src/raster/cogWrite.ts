// Writes a small tiled GeoTIFF in the layouts cog.ts reads, for synthetic
// fixtures and cog.test.ts. By default it is laid out like a Digital Earth
// Africa WOfS scene: classic TIFF, one uint8 band, tiles, DEFLATE through
// node:zlib with the horizontal predictor, GDAL's 4-byte size before each
// tile, GDAL_NODATA, and GeoKeys for WGS 84 / UTM. It also writes the forms
// the WaPOR (#623) and Sentinel (#624) passes meet: BigTIFF, LZW (the CHIRPS
// writer's encoder), int16 / uint16 / float32 samples (the sample type is
// the values' array type), the floating-point predictor, EPSG:4326 grids, a
// GDAL scale and offset, and tile tables placed past the header read; and,
// for the real files' tag layouts (cogLayouts.ts), GDAL's structural
// metadata before the first IFD, a 4-byte trailer after each tile,
// PlanarConfiguration 2 on one band, LONG dimensions, X/YResolution,
// GDAL metadata items beside the scale and offset, GeoKeys whose values sit
// in GeoAsciiParams or GeoDoubleParams, and overview IFDs after the first. The
// fixture sources (dams/observed/wofs/fixtures.ts) serve scenes made here,
// and cog.test.ts round-trips the reader through it, so the reader is
// exercised on the layout it meets in production. A continental grid (the
// WaPOR fixture's, water-use/observed/fixtures.ts) is written from
// `tileValues` instead of `values`: each tile made when written, a null one
// empty (GDAL's SPARSE_OK), so a grid of tens of thousands of tiles costs
// only the few that hold data. Also writes the legal
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
	/** GDAL metadata items written before the scale and offset (STATISTICS_*, OVR_RESAMPLING_ALG, …). */
	metadata?: { name: string; value: string; sample?: number }[];
	/** PlanarConfiguration (default 1); GDAL writes 2 on some one-band files, where it means the same bytes. */
	planar?: 1 | 2;
	/** Write ImageWidth and ImageLength as LONG even when they fit a SHORT. */
	longDims?: boolean;
	/** Write XResolution and YResolution (RATIONAL 1/1) and ResolutionUnit 1, as GDAL does for some files. */
	resolution?: boolean;
	/** Write GDAL's structural metadata (the COG "ghost area") between the header and the first IFD. */
	ghost?: boolean;
	/** Repeat each tile's last 4 bytes after it (GDAL's BLOCK_TRAILER=LAST_4_BYTES_REPEATED). */
	blockTrailer?: boolean;
	/** Overview IFDs after the first, each half the last's size, their tiles all empty: the reader must read only the first. */
	overviews?: number;
	/** GeoKeys whose values are text in GeoAsciiParams (34737), each ending in "|" (GTCitation 1026, GeogCitation 2049). */
	geoAscii?: Record<number, string>;
	/** GeoKeys whose values are doubles in GeoDoubleParams (34736) (GeogSemiMajorAxis 2057, GeogInvFlattening 2059). */
	geoDoubles?: Record<number, number>;
	/** Replace or add tags (tag → [type, values]), or drop one (null): for malformed files. */
	override?: Record<number, [number, number[]] | null>;
	/** Replace GeoKeys (key → value), or drop one (null). */
	geoKeys?: Record<number, number | null>;
}

/** A grid written from its tiles instead of its samples (see the header): for a large grid that is mostly empty. */
export type LazyCogSpec = Omit<CogSpec, 'values'> & {
	values?: undefined;
	/** Tile `i`'s samples (row-major tile indices, each `tile × tile`, edge tiles padded), or null for an empty tile. */
	tileValues: (i: number) => Samples | null;
	sampleType: SampleType;
};

/** Bytes per element of each type written; a RATIONAL (5) is given as two LONG elements, numerator and denominator. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 12: 8, 16: 8 };

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
function tilesOf(spec: CogSpec | LazyCogSpec, type: SampleType, tile: number, pad: number, predictor: 1 | 2 | 3, le: boolean): (Uint8Array | null)[] {
	const across = Math.ceil(spec.width / tile);
	const down = Math.ceil(spec.height / tile);
	const out: (Uint8Array | null)[] = [];
	if ('tileValues' in spec && spec.tileValues) {
		for (let i = 0; i < across * down; i++) {
			const t = spec.tileValues(i);
			if (t !== null && (t.length !== tile * tile || sampleTypeOf(t) !== type)) throw new RangeError(`tile ${i} is not ${tile} × ${tile} ${type} samples`);
			out.push(t === null ? null : tileBytes(t, type, tile, predictor, le));
		}
		return out;
	}
	const values = spec.values!;
	const Ctor = values.constructor as new (n: number) => Samples;
	for (let tr = 0; tr < down; tr++) {
		for (let tc = 0; tc < across; tc++) {
			const t = new Ctor(tile * tile).fill(pad);
			for (let r = 0; r < tile; r++) {
				const y = tr * tile + r;
				if (y >= spec.height) break;
				const x0 = tc * tile;
				const n = Math.min(tile, spec.width - x0);
				(t as Uint8Array).set((values as Uint8Array).subarray(y * spec.width + x0, y * spec.width + x0 + n), r * tile);
			}
			out.push(tileBytes(t, type, tile, predictor, le));
		}
	}
	return out;
}

export function writeCog(spec: CogSpec | LazyCogSpec): Uint8Array {
	if (spec.values ? 'tileValues' in spec : !('tileValues' in spec)) throw new RangeError('give values, or tileValues with a sampleType');
	if (spec.values && spec.values.length !== spec.width * spec.height) throw new RangeError('values must hold width × height samples');
	const type = spec.values ? sampleTypeOf(spec.values) : (spec as LazyCogSpec).sampleType;
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
	const stored = raw.map((t, i) => (t === null || sparse.has(i) ? new Uint8Array(0) : compress(t)));

	const geographic = spec.epsg === 4326;
	const keys: Record<number, number> = geographic
		? { 1024: 2, 1025: spec.pixelIsPoint ? 2 : 1, 2048: 4326, 2054: 9102 }
		: { 1024: 1, 1025: spec.pixelIsPoint ? 2 : 1, 3072: spec.epsg, 3076: 9001 };
	for (const [k, v] of Object.entries(spec.geoKeys ?? {})) {
		if (v === null) delete keys[Number(k)];
		else keys[Number(k)] = v;
	}
	// [key, location, count, value]: location 0 an inline value, 34737 / 34736 a slice of GeoAsciiParams / GeoDoubleParams.
	let geoAsciiText = '';
	const geoDoubleValues: number[] = [];
	const keyEntries = new Map<number, number[]>(Object.entries(keys).map(([k, v]) => [Number(k), [Number(k), 0, 1, v]]));
	for (const [k, text] of Object.entries(spec.geoAscii ?? {})) {
		keyEntries.set(Number(k), [Number(k), 34737, text.length, geoAsciiText.length]);
		geoAsciiText += text;
	}
	for (const [k, v] of Object.entries(spec.geoDoubles ?? {})) {
		keyEntries.set(Number(k), [Number(k), 34736, 1, geoDoubleValues.length]);
		geoDoubleValues.push(v);
	}
	const keyList = [...keyEntries.values()].sort((a, b) => a[0]! - b[0]!);
	const geoKeyDir = [1, 1, 0, keyList.length, ...keyList.flat()];
	const half = spec.pixelIsPoint ? 0.5 : 0;
	const tableType = big ? 16 : 4;
	const dimType = (n: number) => (spec.longDims || n > 0xffff ? 4 : 3);

	/** One image's tags; its tile tables are filled in once the tiles are placed. */
	const imageTags = (width: number, height: number, tiles: number): Record<number, [number, number[]]> => ({
		// SHORT, or LONG past 65 535 (a continental grid: WaPOR's is 368 640 wide).
		256: [dimType(width), [width]],
		257: [dimType(height), [height]],
		258: [3, [FORM[type].bits]],
		259: [3, [compression]],
		262: [3, [1]],
		277: [3, [1]],
		284: [3, [spec.planar ?? 1]],
		317: [3, [predictor]],
		322: [3, [tile]],
		323: [3, [tile]],
		324: [tableType, new Array<number>(tiles).fill(0)],
		325: [tableType, new Array<number>(tiles).fill(0)],
		339: [3, [FORM[type].format]]
	});
	const tags: Record<number, [number, number[]]> = {
		...imageTags(spec.width, spec.height, stored.length),
		33550: [12, [size, size, 0]],
		33922: [12, [0, 0, 0, spec.originX + half * size, spec.originY - half * size, 0]],
		34735: [3, geoKeyDir]
	};
	tags[325] = [tableType, stored.map((s) => s.length)];
	if (geoDoubleValues.length) tags[34736] = [12, geoDoubleValues];
	if (spec.resolution) {
		tags[282] = [5, [1, 1]];
		tags[283] = [5, [1, 1]];
		tags[296] = [3, [1]];
	}
	const ascii: Record<number, string> = {};
	if (geoAsciiText) ascii[34737] = `${geoAsciiText}\0`;
	if (nodata !== null) ascii[42113] = `${nodata}\0`;
	if (spec.scaleOffset || spec.metadata) {
		const items = (spec.metadata ?? []).map((m) => `  <Item name="${m.name}"${m.sample === undefined ? '' : ` sample="${m.sample}"`}>${m.value}</Item>\n`);
		if (spec.scaleOffset) {
			const { scale, offset } = spec.scaleOffset;
			// GDAL writes the offset first.
			items.push(`  <Item name="OFFSET" sample="0" role="offset">${offset}</Item>\n`, `  <Item name="SCALE" sample="0" role="scale">${scale}</Item>\n`);
		}
		ascii[42112] = `<GDALMetadata>\n${items.join('')}</GDALMetadata>\0`;
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

	// The overviews: each half the last's size, their tiles empty (offset and size 0), with NewSubfileType 1 and the no-data.
	const overviews: { tags: Record<number, [number, number[]]>; ascii: Record<number, string> }[] = [];
	for (let k = 1, w = spec.width, h = spec.height; k <= (spec.overviews ?? 0); k++) {
		w = Math.ceil(w / 2);
		h = Math.ceil(h / 2);
		const t = imageTags(w, h, Math.ceil(w / tile) * Math.ceil(h / tile));
		t[254] = [4, [1]];
		overviews.push({ tags: t, ascii: nodata === null ? {} : { 42113: `${nodata}\0` } });
	}

	// Layout: header (8, or 16) | [ghost] | IFD | its out-of-line values | overview IFDs and theirs | [gap | tile tables] | tiles
	// (each a 4-byte size, then its bytes, then [its last 4 bytes again]).
	const headerSize = big ? 16 : 8;
	const entrySize = big ? 20 : 12;
	const inlineSize = big ? 8 : 4;
	const ghost = spec.ghost ? ghostText(spec.blockTrailer ?? false) : '';
	const countOf = (t: number, values: number[]) => (t === 5 ? values.length / 2 : values.length);
	interface Ifd {
		tags: Record<number, [number, number[]]>;
		ascii: Record<number, string>;
		all: number[];
		at: number;
		outOfLine: Map<number, number>;
	}
	let cursor = headerSize + ghost.length;
	const placeIfd = (t: Record<number, [number, number[]]>, a: Record<number, string>, deferTables: boolean): Ifd => {
		cursor += cursor % 2; // word-aligned
		const all = [...Object.keys(t), ...Object.keys(a)].map(Number).sort((x, y) => x - y);
		const at = cursor;
		cursor += (big ? 8 : 2) + all.length * entrySize + (big ? 8 : 4);
		const outOfLine = new Map<number, number>();
		for (const tag of all) {
			if (deferTables && (tag === 324 || tag === 325)) continue;
			const s = tag in a ? a[tag]!.length : TYPE_SIZE[t[tag]![0]]! * t[tag]![1].length;
			if (s > inlineSize) {
				cursor += cursor % 2;
				outOfLine.set(tag, cursor);
				cursor += s;
			}
		}
		return { tags: t, ascii: a, all, at, outOfLine };
	};
	const first = placeIfd(tags, ascii, spec.tableGap !== undefined);
	const rest = overviews.map((o) => placeIfd(o.tags, o.ascii, false));
	if (spec.tableGap !== undefined) {
		cursor += spec.tableGap;
		for (const tag of [324, 325]) {
			if (!tags[tag]) continue;
			const s = TYPE_SIZE[tags[tag]![0]]! * tags[tag]![1].length;
			if (s > inlineSize) {
				cursor += cursor % 2;
				first.outOfLine.set(tag, cursor);
				cursor += s;
			}
		}
	}
	const trailer = spec.blockTrailer ? 4 : 0;
	const offsets: number[] = [];
	for (const s of stored) {
		if (s.length === 0) {
			offsets.push(0);
			continue;
		}
		cursor += 4; // GDAL's BLOCK_LEADER: the tile's size as a uint32
		offsets.push(cursor);
		cursor += s.length + trailer;
	}
	if (tags[324] && !(spec.override && 324 in spec.override)) tags[324] = [tableType, offsets];

	const buf = new Uint8Array(cursor);
	const v = new DataView(buf.buffer);
	buf[0] = buf[1] = le ? 0x49 : 0x4d;
	if (big) {
		v.setUint16(2, 43, le);
		v.setUint16(4, 8, le);
		v.setUint16(6, 0, le);
		v.setBigUint64(8, BigInt(first.at), le);
	} else {
		v.setUint16(2, 42, le);
		v.setUint32(4, first.at, le);
	}
	for (let i = 0; i < ghost.length; i++) buf[headerSize + i] = ghost.charCodeAt(i);
	const put = (at: number, type: number, values: number[]) => {
		values.forEach((x, i) => {
			const p = at + i * TYPE_SIZE[type]!;
			if (type === 1) v.setUint8(p, x);
			else if (type === 3) v.setUint16(p, x, le);
			else if (type === 4 || type === 5) v.setUint32(p, x, le);
			else if (type === 16) v.setBigUint64(p, BigInt(x), le);
			else v.setFloat64(p, x, le);
		});
	};
	const writeIfd = (ifd: Ifd, next: number) => {
		if (big) v.setBigUint64(ifd.at, BigInt(ifd.all.length), le);
		else v.setUint16(ifd.at, ifd.all.length, le);
		ifd.all.forEach((tag, i) => {
			const p = ifd.at + (big ? 8 : 2) + i * entrySize;
			const isAscii = tag in ifd.ascii;
			const t = isAscii ? 2 : ifd.tags[tag]![0];
			const values = isAscii ? [...ifd.ascii[tag]!].map((c) => c.charCodeAt(0)) : ifd.tags[tag]![1];
			v.setUint16(p, tag, le);
			v.setUint16(p + 2, t, le);
			const count = countOf(t, values);
			if (big) v.setBigUint64(p + 4, BigInt(count), le);
			else v.setUint32(p + 4, count, le);
			const valueAt = p + (big ? 12 : 8);
			const at = ifd.outOfLine.get(tag);
			if (at !== undefined) {
				if (big) v.setBigUint64(valueAt, BigInt(at), le);
				else v.setUint32(valueAt, at, le);
			}
			put(at ?? valueAt, isAscii ? 1 : t, values);
		});
		const nextAt = ifd.at + (big ? 8 : 2) + ifd.all.length * entrySize;
		if (big) v.setBigUint64(nextAt, BigInt(next), le);
		else v.setUint32(nextAt, next, le);
	};
	const chain = [first, ...rest];
	chain.forEach((ifd, i) => writeIfd(ifd, chain[i + 1]?.at ?? 0));
	stored.forEach((s, i) => {
		if (s.length === 0) return;
		v.setUint32(offsets[i]! - 4, s.length, le);
		buf.set(s, offsets[i]!);
		if (trailer) buf.set(s.subarray(Math.max(0, s.length - 4)), offsets[i]! + s.length + 4 - Math.min(4, s.length));
	});
	return buf;
}

/** GDAL's structural metadata, as a COG it writes carries it between the header and the first IFD (the size counts the lines after the first). */
function ghostText(trailer: boolean): string {
	const body = `LAYOUT=IFDS_BEFORE_DATA\nBLOCK_ORDER=ROW_MAJOR\nBLOCK_LEADER=SIZE_AS_UINT4\n${trailer ? 'BLOCK_TRAILER=LAST_4_BYTES_REPEATED\n' : ''}KNOWN_INCOMPATIBLE_EDITION=NO\n `;
	return `GDAL_STRUCTURAL_METADATA_SIZE=${String(body.length).padStart(6, '0')} bytes\n${body}`;
}
