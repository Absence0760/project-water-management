// A minimal cloud-optimised GeoTIFF reader for Digital Earth Africa's WOfS
// scenes (issue #604 R5-C, docs/architecture.md § Dam observations → WOfS):
// it reads the header, then only the tiles a dam outline's box touches, with
// HTTP range requests, never the whole scene (~3 MB, 7 700 pixels a side).
//
// What a WOfS scene is (checked against a live 2026-09 Landsat 8 scene,
// wofs_ls 1-0-0, on 2026-10-27): classic little-endian TIFF (GDAL's COG
// layout: IFDS_BEFORE_DATA, a 4-byte size before each tile, the overviews
// after the full image's IFD), one uint8 band, 512 × 512 tiles, DEFLATE
// (Compression 8) with the horizontal predictor (Predictor 2), GDAL_NODATA
// "1", and GeoKeys for a projected WGS 84 / UTM CRS (ProjectedCSTypeGeoKey
// 326xx, metres, PixelIsArea) with a 30 m ModelPixelScale and a tiepoint at
// the top-left corner. DE Africa writes the southern hemisphere in the
// NORTHERN zone codes (EPSG:32634, northings negative), which utm.ts handles
// as the EPSG code says.
//
// Read: classic TIFF of either byte order; tiled; 8-bit unsigned, one sample;
// no compression, or DEFLATE (8, or the old 32946) through node:zlib with the
// inflated size bounded; predictor 1 or 2; projected UTM on WGS 84 (EPSG
// 326xx / 327xx); an empty tile (offset and size 0, GDAL's SPARSE_OK) as all
// no-data. Refused with a FeedFormatError, never guessed at: BigTIFF (WOfS
// isn't one), strips, more than one band or another sample type, a reversed
// fill order, another CRS, a ModelTransformation (a rotated grid), a GDAL
// scale or offset, implausible sizes. A format change must fail loudly,
// never write a wrong wet area.
//
// No dependency: the `geotiff` package would pull in a decoder zoo for one
// codec, and feeds/sources/tiff.ts (the CHIRPS strip reader) refuses tiles on
// purpose. cog.test.ts round-trips this reader through cogWrite.ts.
import { inflateSync } from 'node:zlib';
import { FeedFormatError } from '../../../feeds/errors.js';
import { gdalItems, type RangeRead } from '../../../feeds/sources/tiff.js';

export type { RangeRead };

const TAG = {
	width: 256,
	height: 257,
	bitsPerSample: 258,
	compression: 259,
	fillOrder: 266,
	stripOffsets: 273,
	samplesPerPixel: 277,
	planarConfig: 284,
	predictor: 317,
	tileWidth: 322,
	tileHeight: 323,
	tileOffsets: 324,
	tileByteCounts: 325,
	sampleFormat: 339,
	pixelScale: 33550,
	tiepoint: 33922,
	modelTransformation: 34264,
	geoKeys: 34735,
	gdalMetadata: 42112,
	gdalNodata: 42113
} as const;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** DEFLATE: TIFF's own code (8) and the older Adobe one (32946); both are zlib streams. */
const DEFLATE = new Set([8, 32946]);

/** Upper bounds, so a corrupt header can't make us request or allocate absurd amounts. */
const MAX_DIM = 200_000;
const MAX_TILE_SIDE = 4096;
/** A 512 × 512 uint8 tile is 256 KB raw; stored, it is a few KB to ~40 KB. */
const MAX_TILE_BYTES = 4 * 1024 * 1024;
/** The first read: a WOfS scene's IFDs and tile tables end within ~14 KB of the start. */
export const HEADER_READ_BYTES = 16 * 1024;
/** The longest single range readWindow asks for: the live client refuses a response over 4 MiB (feeds/http.ts). */
export const WINDOW_READ_MAX_BYTES = 2 * 1024 * 1024;
/** Tiles this close together in the file are read in one range, the bytes between them thrown away. */
const WINDOW_READ_GAP_BYTES = 16 * 1024;
/** The most stored bytes one readWindow may read: a dam is a few tiles. */
const WINDOW_READ_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
/** The most pixels one window may hold: ~120 km a side at 30 m. */
export const WINDOW_MAX_PIXELS = 16 * 1024 * 1024;

interface Entry {
	tag: number;
	type: number;
	count: number;
	/** Absolute file offset of the values (inline values point into the IFD itself). */
	offset: number;
}

export interface CogInfo {
	width: number;
	height: number;
	tileWidth: number;
	tileHeight: number;
	tilesAcross: number;
	tilesDown: number;
	compression: 1 | 8;
	predictor: 1 | 2;
	littleEndian: boolean;
	/** The projected CRS: EPSG 326xx (UTM north) or 327xx (UTM south). */
	epsg: number;
	/** Easting / northing of the top-left corner of pixel (0, 0), metres. */
	originX: number;
	originY: number;
	/** Metres per pixel, both positive (rows run southward). */
	pixelSizeX: number;
	pixelSizeY: number;
	/** GDAL_NODATA, when the file gives one (WOfS: 1). */
	nodata: number | null;
	/** Tile `i`'s (row-major across the image) offset and stored byte count. */
	tile(i: number): Promise<{ offset: number; bytes: number }>;
}

/**
 * Opens a COG by reading its header and first IFD (the full-resolution
 * image). Returns null when the resource doesn't exist (HTTP 404).
 */
export async function openCog(read: RangeRead): Promise<CogInfo | null> {
	const block = await read(0, HEADER_READ_BYTES - 1);
	if (!block) return null;
	if (block.length < 8) throw new FeedFormatError('the scene is shorter than a TIFF header');
	const le = block[0] === 0x49 && block[1] === 0x49;
	if (!le && !(block[0] === 0x4d && block[1] === 0x4d)) throw new FeedFormatError('the scene is not a TIFF');
	const bv = new DataView(block.buffer, block.byteOffset, block.byteLength);
	const magic = bv.getUint16(2, le);
	if (magic === 43) throw new FeedFormatError('the scene is a BigTIFF, which is not supported (WOfS scenes are classic TIFF)');
	if (magic !== 42) throw new FeedFormatError('the scene is not a TIFF');
	const ifdOffset = bv.getUint32(4, le);
	if (ifdOffset < 8) throw new FeedFormatError('the scene has no image directory');

	// Bytes [start, start + len) of the file: from the first read when inside it, else a read of their own.
	const bytesAt = async (start: number, len: number): Promise<DataView> => {
		if (start + len <= block.length) return new DataView(block.buffer, block.byteOffset + start, len);
		if (len > MAX_TILE_BYTES) throw new FeedFormatError('the scene’s image directory is implausibly large');
		const got = await read(start, start + len - 1);
		if (!got || got.length < len) throw new FeedFormatError('the scene ends inside its image directory');
		return new DataView(got.buffer, got.byteOffset, len);
	};

	const head = await bytesAt(ifdOffset, 2);
	const n = head.getUint16(0, le);
	if (n === 0 || n > 512) throw new FeedFormatError('the scene’s image directory is implausible');
	const ifd = await bytesAt(ifdOffset + 2, n * 12);
	const entries = new Map<number, Entry>();
	for (let i = 0; i < n; i++) {
		const p = i * 12;
		const tag = ifd.getUint16(p, le);
		const type = ifd.getUint16(p + 2, le);
		const count = ifd.getUint32(p + 4, le);
		if (!TYPE_SIZE[type]) continue; // an unknown type in a tag we don't read
		const size = TYPE_SIZE[type]! * count;
		const offset = size <= 4 ? ifdOffset + 2 + p + 8 : ifd.getUint32(p + 8, le);
		entries.set(tag, { tag, type, count, offset });
	}

	const valuesOf = (e: Entry, first = 0, count = e.count) => bytesAt(e.offset + first * TYPE_SIZE[e.type]!, count * TYPE_SIZE[e.type]!);
	const num = (v: DataView, type: number, i: number): number => {
		switch (type) {
			case 1:
			case 7:
				return v.getUint8(i);
			case 3:
				return v.getUint16(i * 2, le);
			case 4:
				return v.getUint32(i * 4, le);
			default:
				throw new FeedFormatError(`the scene uses TIFF type ${type} where an integer was expected`);
		}
	};
	const scalar = async (tag: number, fallback?: number): Promise<number> => {
		const e = entries.get(tag);
		if (!e) {
			if (fallback === undefined) throw new FeedFormatError(`the scene lacks TIFF tag ${tag}`);
			return fallback;
		}
		if (e.count < 1) throw new FeedFormatError(`the scene’s TIFF tag ${tag} is empty`);
		return num(await valuesOf(e, 0, 1), e.type, 0);
	};
	const doubles = async (tag: number, count: number): Promise<number[]> => {
		const e = entries.get(tag);
		if (!e || e.type !== 12 || e.count < count) throw new FeedFormatError('the scene has no usable georeferencing');
		const v = await valuesOf(e, 0, count);
		return Array.from({ length: count }, (_, i) => v.getFloat64(i * 8, le));
	};

	if (!entries.has(TAG.tileWidth)) {
		throw new FeedFormatError(entries.has(TAG.stripOffsets) ? 'the scene is striped, not tiled, which is not supported' : 'the scene has no tiles');
	}
	const width = await scalar(TAG.width);
	const height = await scalar(TAG.height);
	if (!(width >= 1 && width <= MAX_DIM && height >= 1 && height <= MAX_DIM)) throw new FeedFormatError('the scene has implausible dimensions');
	const tileWidth = await scalar(TAG.tileWidth);
	const tileHeight = await scalar(TAG.tileHeight);
	// TIFF 6.0 § 15: a tile's sides are multiples of 16.
	if (!(tileWidth >= 16 && tileHeight >= 16 && tileWidth <= MAX_TILE_SIDE && tileHeight <= MAX_TILE_SIDE && tileWidth % 16 === 0 && tileHeight % 16 === 0)) {
		throw new FeedFormatError('the scene has implausible tiles');
	}
	if ((await scalar(TAG.bitsPerSample)) !== 8 || (await scalar(TAG.sampleFormat, 1)) !== 1) throw new FeedFormatError('the scene is not 8-bit unsigned');
	if ((await scalar(TAG.samplesPerPixel, 1)) !== 1) throw new FeedFormatError('the scene has more than one band');
	if ((await scalar(TAG.planarConfig, 1)) !== 1) throw new FeedFormatError('the scene’s planar configuration is not supported');
	if ((await scalar(TAG.fillOrder, 1)) !== 1) throw new FeedFormatError('the scene uses a reversed bit fill order, which is not supported');
	const compression = await scalar(TAG.compression, 1);
	if (compression !== 1 && !DEFLATE.has(compression)) throw new FeedFormatError(`the scene uses TIFF compression ${compression}, which is not supported`);
	const predictor = await scalar(TAG.predictor, 1);
	if (predictor !== 1 && predictor !== 2) throw new FeedFormatError(`the scene uses TIFF predictor ${predictor}, which is not supported`);

	if (entries.has(TAG.modelTransformation)) throw new FeedFormatError('the scene’s grid is given by a transformation matrix (it may be rotated), which is not supported');
	const [scaleX, scaleY] = await doubles(TAG.pixelScale, 2);
	const [ti, tj, , tx, ty] = await doubles(TAG.tiepoint, 6);
	if (!(scaleX! > 0 && scaleY! > 0 && scaleX! < 10_000 && scaleY! < 10_000) || ![ti, tj, tx, ty].every(Number.isFinite)) {
		throw new FeedFormatError('the scene has no usable georeferencing');
	}

	// GeoKeys (GeoTIFF 1.0 § 2.4): [version, revision, minor, key count], then
	// [key, location, count, value] per key; location 0 is an inline value.
	const gk = entries.get(TAG.geoKeys);
	if (!gk || gk.type !== 3 || gk.count < 4 || gk.count > 4096) throw new FeedFormatError('the scene does not say its coordinate system');
	const gv = await valuesOf(gk);
	const short = (i: number) => gv.getUint16(i * 2, le);
	const keyCount = short(3);
	if (4 + keyCount * 4 > gk.count) throw new FeedFormatError('the scene’s GeoKey directory is truncated');
	const geo = new Map<number, number>();
	for (let k = 0; k < keyCount; k++) {
		const at = 4 + k * 4;
		if (short(at + 1) === 0) geo.set(short(at), short(at + 3));
	}
	if (geo.get(1024) !== 1) throw new FeedFormatError('the scene is not in projected coordinates');
	const epsg = geo.get(3072);
	if (epsg === undefined || !isUtmEpsg(epsg)) throw new FeedFormatError(`the scene’s coordinate system is not WGS 84 / UTM (EPSG ${epsg ?? 'unset'})`);
	if ((geo.get(3076) ?? 9001) !== 9001) throw new FeedFormatError('the scene’s units are not metres');
	const rasterType = geo.get(1025) ?? 1;
	if (rasterType !== 1 && rasterType !== 2) throw new FeedFormatError(`the scene has an unknown raster type ${rasterType}`);
	// PixelIsPoint (§ 2.5.2.2): the tiepoint is pixel (ti, tj)'s centre, so its corner is half a pixel west and north.
	const half = rasterType === 2 ? 0.5 : 0;

	const tilesAcross = Math.ceil(width / tileWidth);
	const tilesDown = Math.ceil(height / tileHeight);
	const offsets = entries.get(TAG.tileOffsets);
	const counts = entries.get(TAG.tileByteCounts);
	if (!offsets || !counts || offsets.count < tilesAcross * tilesDown || counts.count < tilesAcross * tilesDown) {
		throw new FeedFormatError('the scene’s tile table is missing or short');
	}

	let nodata: number | null = null;
	const nd = entries.get(TAG.gdalNodata);
	if (nd && nd.type === 2 && nd.count <= 256) {
		const text = new TextDecoder().decode(await valuesOf(nd)).replace(/\0+$/, '').trim();
		const v = Number(text);
		if (text !== '' && Number.isInteger(v) && v >= 0 && v <= 255) nodata = v;
	}

	// A band scale or offset (GDAL metadata) would mean the samples aren't WOfS's flags.
	const md = entries.get(TAG.gdalMetadata);
	if (md && md.type === 2) {
		if (md.count > 1024 * 1024) throw new FeedFormatError('the scene’s GDAL metadata is implausibly large');
		const xml = new TextDecoder().decode(await valuesOf(md));
		for (const { role, text } of gdalItems(xml)) {
			const v = Number(text.trim());
			if (text.trim() === '' || v !== (role === 'scale' ? 1 : 0)) throw new FeedFormatError('the scene applies a scale or offset to its samples, which is not supported');
		}
	}

	return {
		width,
		height,
		tileWidth,
		tileHeight,
		tilesAcross,
		tilesDown,
		compression: compression === 1 ? 1 : 8,
		predictor: predictor as 1 | 2,
		littleEndian: le,
		epsg,
		originX: tx! - (ti! + half) * scaleX!,
		originY: ty! + (tj! + half) * scaleY!,
		pixelSizeX: scaleX!,
		pixelSizeY: scaleY!,
		nodata,
		async tile(i) {
			return { offset: num(await valuesOf(offsets, i, 1), offsets.type, 0), bytes: num(await valuesOf(counts, i, 1), counts.type, 0) };
		}
	};
}

/** EPSG 32601–32660 (UTM north) or 32701–32760 (UTM south), both on WGS 84. */
export function isUtmEpsg(epsg: number): boolean {
	const zone = epsg % 100;
	return Number.isInteger(epsg) && (Math.floor(epsg / 100) === 326 || Math.floor(epsg / 100) === 327) && zone >= 1 && zone <= 60;
}

/** A window of the image in pixels, both ends inclusive. */
export interface PixelWindow {
	col0: number;
	row0: number;
	col1: number;
	row1: number;
}

/**
 * The samples of `win` (inside the image), row-major, `col1 - col0 + 1`
 * wide. Reads each tile the window touches once, adjacent tiles' bytes as
 * one range (a COG stores a tile row's tiles back to back), one request at a
 * time: the caller paces them.
 */
export async function readWindow(read: RangeRead, cog: CogInfo, win: PixelWindow): Promise<Uint8Array> {
	const { col0, row0, col1, row1 } = win;
	if (!([col0, row0, col1, row1].every(Number.isInteger) && col0 >= 0 && row0 >= 0 && col1 >= col0 && row1 >= row0 && col1 < cog.width && row1 < cog.height)) {
		throw new RangeError(`the window ${col0},${row0}–${col1},${row1} is outside the scene's ${cog.width} × ${cog.height}`);
	}
	const w = col1 - col0 + 1;
	const h = row1 - row0 + 1;
	if (w * h > WINDOW_MAX_PIXELS) throw new RangeError('the window is implausibly large');

	const tc0 = Math.floor(col0 / cog.tileWidth);
	const tc1 = Math.floor(col1 / cog.tileWidth);
	const tr0 = Math.floor(row0 / cog.tileHeight);
	const tr1 = Math.floor(row1 / cog.tileHeight);
	const tiles: { tr: number; tc: number; offset: number; bytes: number }[] = [];
	for (let tr = tr0; tr <= tr1; tr++) {
		for (let tc = tc0; tc <= tc1; tc++) {
			const { offset, bytes } = await cog.tile(tr * cog.tilesAcross + tc);
			if (bytes === 0 && offset === 0) {
				// GDAL's SPARSE_OK: an empty tile, all no-data.
				if (cog.nodata === null) throw new FeedFormatError('the scene has an empty tile but no no-data value');
			} else if (!(bytes > 0 && bytes <= MAX_TILE_BYTES)) {
				throw new FeedFormatError('a tile of the scene has an implausible size');
			}
			tiles.push({ tr, tc, offset, bytes });
		}
	}

	// Spans of the file holding the tiles: sorted by offset, merged when they overlap or nearly touch.
	const spans: { start: number; end: number; buf?: Uint8Array }[] = [];
	for (const t of tiles.filter((t) => t.bytes > 0).sort((a, b) => a.offset - b.offset)) {
		const last = spans.at(-1);
		const end = t.offset + t.bytes; // exclusive
		if (last && t.offset <= last.end + WINDOW_READ_GAP_BYTES) last.end = Math.max(last.end, end);
		else spans.push({ start: t.offset, end });
	}
	if (spans.reduce((s, sp) => s + sp.end - sp.start, 0) > WINDOW_READ_TOTAL_MAX_BYTES) {
		throw new FeedFormatError('the window would need an implausible amount of reading');
	}
	for (const sp of spans) {
		const buf = new Uint8Array(sp.end - sp.start);
		for (let at = sp.start; at < sp.end; at += WINDOW_READ_MAX_BYTES) {
			const to = Math.min(sp.end, at + WINDOW_READ_MAX_BYTES) - 1;
			const part = await read(at, to);
			if (!part || part.length < to - at + 1) throw new FeedFormatError('the scene ends inside a tile');
			buf.set(part.subarray(0, to - at + 1), at - sp.start);
		}
		sp.buf = buf;
	}

	const out = new Uint8Array(w * h);
	for (const t of tiles) {
		let data: Uint8Array;
		if (t.bytes === 0) {
			data = new Uint8Array(cog.tileWidth * cog.tileHeight).fill(cog.nodata!);
		} else {
			const sp = spans.find((s) => t.offset >= s.start && t.offset + t.bytes <= s.end)!;
			data = decodeTile(cog, sp.buf!.subarray(t.offset - sp.start, t.offset - sp.start + t.bytes));
		}
		const x0 = t.tc * cog.tileWidth;
		const y0 = t.tr * cog.tileHeight;
		const r0 = Math.max(row0, y0);
		const r1 = Math.min(row1, y0 + cog.tileHeight - 1);
		const c0 = Math.max(col0, x0);
		const c1 = Math.min(col1, x0 + cog.tileWidth - 1);
		for (let r = r0; r <= r1; r++) {
			const from = (r - y0) * cog.tileWidth + (c0 - x0);
			out.set(data.subarray(from, from + (c1 - c0 + 1)), (r - row0) * w + (c0 - col0));
		}
	}
	return out;
}

/** One tile's samples from its stored bytes: inflated (bounded) when compressed, the predictor undone. */
export function decodeTile(cog: Pick<CogInfo, 'tileWidth' | 'tileHeight' | 'compression' | 'predictor'>, raw: Uint8Array): Uint8Array {
	const expected = cog.tileWidth * cog.tileHeight;
	let data: Uint8Array;
	if (cog.compression === 1) {
		data = raw;
	} else {
		try {
			// A tile never inflates past its pixels: a deflate bomb stops there.
			data = inflateSync(raw, { maxOutputLength: expected });
		} catch (e) {
			throw new FeedFormatError((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'a tile of the scene inflates past its size' : 'a tile of the scene does not inflate');
		}
	}
	if (data.length < expected) throw new FeedFormatError('a tile of the scene is truncated');
	// Copy: the predictor is undone in place, and a raw tile is a view of the read.
	const out = Uint8Array.from(data.subarray(0, expected));
	if (cog.predictor === 2) {
		// Horizontal differencing (TIFF 6.0 § 14), one 8-bit sample: each byte is the previous plus itself, mod 256.
		for (let r = 0; r < cog.tileHeight; r++) {
			const base = r * cog.tileWidth;
			for (let c = 1; c < cog.tileWidth; c++) out[base + c] = (out[base + c]! + out[base + c - 1]!) & 0xff;
		}
	}
	return out;
}
