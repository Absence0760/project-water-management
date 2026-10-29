// A minimal cloud-optimised GeoTIFF reader: it reads the header, then only
// the tiles a window touches, with HTTP range requests, never the whole file.
// Its callers: Digital Earth Africa's WOfS scenes (issue #604 R5-C,
// docs/architecture.md § Dam observations → WOfS), and the coming WaPOR
// actual ET (issue #623) and Sentinel-1/2 (issue #624) passes. Each caller
// says what it accepts (`CogAccept`), so a WOfS pass still refuses a
// non-uint8 or non-UTM scene with a reason.
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
// as the EPSG code says. A WaPOR v3 dekad (#623) is a ~2.1 GB BigTIFF COG on
// EPSG:4326 at 1/1024°, int16, LZW, 512-pixel tiles, nodata −9999, so its
// tile tables alone are ~2.8 MB: readWindow reads only the slice of them for
// the tile rows it needs. Sentinel-1 RTC (#624) is float32 on a 0.0002°
// EPSG:4326 grid; Sentinel-2 L2A is uint16 in UTM.
//
// Read: classic TIFF or BigTIFF, of either byte order; tiled; one sample of
// uint8, int16, uint16 or float32; no compression, DEFLATE (8, or the old
// 32946) through node:zlib, or LZW (5, TIFF's MSB-first variant, the
// CHIRPS reader's decoder), each bounded to the tile's size; predictor 1,
// 2 on integer samples, or 3 (floating point) on float32; projected UTM on
// WGS 84 (EPSG 326xx / 327xx) in metres, or geographic WGS 84 (EPSG:4326)
// in degrees; GDAL_NODATA (an integer in range for an integer type; a
// number or "nan" for float32); an empty tile (offset and size 0, GDAL's
// SPARSE_OK) as all no-data; a GDAL scale and offset only when the caller
// accepts them. Refused with a FeedFormatError, never guessed at: strips,
// more than one band, another sample type, a reversed fill order, another
// CRS or units, a ModelTransformation (a rotated grid), old-style LZW,
// implausible sizes, and whatever the caller's CogAccept leaves out. A
// format change must fail loudly, never write a wrong value.
//
// No dependency: the `geotiff` package would pull in a decoder zoo, and
// feeds/sources/tiff.ts (the CHIRPS strip reader) refuses tiles on purpose.
// cog.test.ts round-trips this reader through cogWrite.ts.
import { inflateSync } from 'node:zlib';
import { FeedFormatError } from '../feeds/errors.js';
import { gdalItems, lzwDecode, type RangeRead } from '../feeds/sources/tiff.js';

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

/** Bytes per value of each TIFF field type; 16–18 are BigTIFF's LONG8, SLONG8 and IFD8. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

/** DEFLATE: TIFF's own code (8) and the older Adobe one (32946); both are zlib streams. */
const DEFLATE = new Set([8, 32946]);
const LZW = 5;

/** Upper bounds, so a corrupt header can't make us request or allocate absurd amounts (WaPOR's global 1/1024° grid is 368 640 wide). */
const MAX_DIM = 400_000;
const MAX_TILE_SIDE = 4096;
/** A 512 × 512 tile is 256 KB raw at uint8, 1 MB at float32; stored, it is a few KB to a few hundred. */
const MAX_TILE_BYTES = 4 * 1024 * 1024;
/** The first read: a WOfS scene's IFDs and tile tables end within ~14 KB of the start. */
export const HEADER_READ_BYTES = 16 * 1024;
/** The longest single range readWindow asks for: the live client refuses a response over 4 MiB (feeds/http.ts). */
export const WINDOW_READ_MAX_BYTES = 2 * 1024 * 1024;
/** Tiles this close together in the file are read in one range, the bytes between them thrown away. */
const WINDOW_READ_GAP_BYTES = 16 * 1024;
/** The most stored bytes one readWindow may read: a dam or a unit's parcels are a few tiles. */
const WINDOW_READ_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
/** The most pixels one window may hold: ~120 km a side at 30 m. */
export const WINDOW_MAX_PIXELS = 16 * 1024 * 1024;
/** The most tile-table entries one window's slice may hold (a few tile rows of a continental grid). */
const MAX_TABLE_SLICE = 256 * 1024;

export type SampleType = 'uint8' | 'int16' | 'uint16' | 'float32';
export type Samples = Uint8Array | Int16Array | Uint16Array | Float32Array;
/** UTM on WGS 84 (metres), or geographic WGS 84, EPSG:4326 (degrees). */
export type CrsKind = 'utm' | 'geographic';

/** BitsPerSample and SampleFormat (1 unsigned, 2 signed, 3 float) of each sample type. */
const SAMPLE: Record<SampleType, { bits: number; format: number; bytes: number }> = {
	uint8: { bits: 8, format: 1, bytes: 1 },
	int16: { bits: 16, format: 2, bytes: 2 },
	uint16: { bits: 16, format: 1, bytes: 2 },
	float32: { bits: 32, format: 3, bytes: 4 }
};
const RANGE: Record<Exclude<SampleType, 'float32'>, [number, number]> = { uint8: [0, 255], int16: [-32768, 32767], uint16: [0, 65535] };

/** What a caller reads; anything else is refused at open. */
export interface CogAccept {
	/** Default: all four. */
	sampleTypes?: readonly SampleType[];
	/** Default: both. */
	crs?: readonly CrsKind[];
	/** Read a GDAL scale and offset into CogInfo (default false: refuse one, since the samples would not be what the caller thinks). */
	scaleOffset?: boolean;
}

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
	bigTiff: boolean;
	sampleType: SampleType;
	compression: 1 | 5 | 8;
	predictor: 1 | 2 | 3;
	littleEndian: boolean;
	crs: CrsKind;
	/** EPSG 326xx (UTM north), 327xx (UTM south) or 4326 (geographic). */
	epsg: number;
	/** The top-left corner of pixel (0, 0): easting / northing in metres, or longitude / latitude in degrees. */
	originX: number;
	originY: number;
	/** Metres (UTM) or degrees (geographic) per pixel, both positive (rows run southward). */
	pixelSizeX: number;
	pixelSizeY: number;
	/** GDAL_NODATA, when the file gives a usable one (WOfS: 1; WaPOR: −9999; NaN for a float "nan"). */
	nodata: number | null;
	/** The GDAL band scale and offset (value = sample × scale + offset); 1 and 0 unless the caller accepted them. */
	scale: number;
	offset: number;
	/** Tiles `first` … `first + count - 1` (row-major across the image): offsets and stored byte counts, one read of each table slice. */
	tiles(first: number, count: number): Promise<{ offset: number; bytes: number }[]>;
	/** Tile `i`'s offset and stored byte count. */
	tile(i: number): Promise<{ offset: number; bytes: number }>;
}

/**
 * Opens a COG by reading its header and first IFD (the full-resolution
 * image). Returns null when the resource doesn't exist (HTTP 404).
 */
export async function openCog(read: RangeRead, accept: CogAccept = {}): Promise<CogInfo | null> {
	const block = await read(0, HEADER_READ_BYTES - 1);
	if (!block) return null;
	if (block.length < 8) throw new FeedFormatError('the scene is shorter than a TIFF header');
	const le = block[0] === 0x49 && block[1] === 0x49;
	if (!le && !(block[0] === 0x4d && block[1] === 0x4d)) throw new FeedFormatError('the scene is not a TIFF');
	const bv = new DataView(block.buffer, block.byteOffset, block.byteLength);
	const magic = bv.getUint16(2, le);
	if (magic !== 42 && magic !== 43) throw new FeedFormatError('the scene is not a TIFF');
	const big = magic === 43;
	const u64 = (v: DataView, at: number): number => {
		const x = v.getBigUint64(at, le);
		if (x > BigInt(Number.MAX_SAFE_INTEGER)) throw new FeedFormatError('the scene has an implausible offset or count');
		return Number(x);
	};
	let ifdOffset: number;
	if (big) {
		// BigTIFF: offset size 8, a zero, then the first IFD's 8-byte offset.
		if (block.length < 16 || bv.getUint16(4, le) !== 8 || bv.getUint16(6, le) !== 0) throw new FeedFormatError('the scene’s BigTIFF header is not valid');
		ifdOffset = u64(bv, 8);
		if (ifdOffset < 16) throw new FeedFormatError('the scene has no image directory');
	} else {
		ifdOffset = bv.getUint32(4, le);
		if (ifdOffset < 8) throw new FeedFormatError('the scene has no image directory');
	}

	// Bytes [start, start + len) of the file: from the first read when inside it, else a read of their own.
	const bytesAt = async (start: number, len: number): Promise<DataView> => {
		if (start + len <= block.length) return new DataView(block.buffer, block.byteOffset + start, len);
		if (len > MAX_TILE_BYTES) throw new FeedFormatError('the scene’s image directory is implausibly large');
		const got = await read(start, start + len - 1);
		if (!got || got.length < len) throw new FeedFormatError('the scene ends inside its image directory');
		return new DataView(got.buffer, got.byteOffset, len);
	};

	// An IFD: a count (2 bytes, or 8 in BigTIFF), then 12-byte (20-byte) entries of tag, type, count and an inline value or offset (4 bytes, or 8).
	const countBytes = big ? 8 : 2;
	const entryBytes = big ? 20 : 12;
	const inlineBytes = big ? 8 : 4;
	const head = await bytesAt(ifdOffset, countBytes);
	const n = big ? u64(head, 0) : head.getUint16(0, le);
	if (n === 0 || n > 512) throw new FeedFormatError('the scene’s image directory is implausible');
	const ifd = await bytesAt(ifdOffset + countBytes, n * entryBytes);
	const entries = new Map<number, Entry>();
	for (let i = 0; i < n; i++) {
		const p = i * entryBytes;
		const tag = ifd.getUint16(p, le);
		const type = ifd.getUint16(p + 2, le);
		const count = big ? u64(ifd, p + 4) : ifd.getUint32(p + 4, le);
		if (!TYPE_SIZE[type]) continue; // an unknown type in a tag we don't read
		const size = TYPE_SIZE[type]! * count;
		const valueAt = p + (big ? 12 : 8);
		const offset = size <= inlineBytes ? ifdOffset + countBytes + valueAt : big ? u64(ifd, valueAt) : ifd.getUint32(valueAt, le);
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
			case 13:
				return v.getUint32(i * 4, le);
			case 16:
			case 18:
				return u64(v, i * 8);
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
	if ((await scalar(TAG.samplesPerPixel, 1)) !== 1) throw new FeedFormatError('the scene has more than one band');
	const bits = await scalar(TAG.bitsPerSample);
	const format = await scalar(TAG.sampleFormat, 1);
	const sampleType = (Object.keys(SAMPLE) as SampleType[]).find((t) => SAMPLE[t].bits === bits && SAMPLE[t].format === format);
	if (!sampleType) throw new FeedFormatError(`the scene’s samples (${bits}-bit, sample format ${format}) are not uint8, int16, uint16 or float32`);
	const acceptTypes = accept.sampleTypes ?? (Object.keys(SAMPLE) as SampleType[]);
	if (!acceptTypes.includes(sampleType)) throw new FeedFormatError(`the scene’s samples are ${sampleType}, not ${acceptTypes.join(' or ')}`);
	if ((await scalar(TAG.planarConfig, 1)) !== 1) throw new FeedFormatError('the scene’s planar configuration is not supported');
	if ((await scalar(TAG.fillOrder, 1)) !== 1) throw new FeedFormatError('the scene uses a reversed bit fill order, which is not supported');
	const compression = await scalar(TAG.compression, 1);
	if (compression !== 1 && compression !== LZW && !DEFLATE.has(compression)) throw new FeedFormatError(`the scene uses TIFF compression ${compression}, which is not supported`);
	const predictor = await scalar(TAG.predictor, 1);
	if (predictor !== 1 && predictor !== 2 && predictor !== 3) throw new FeedFormatError(`the scene uses TIFF predictor ${predictor}, which is not supported`);
	if (predictor === 3 && sampleType !== 'float32') throw new FeedFormatError('the scene uses the floating-point predictor on integer samples');
	if (predictor === 2 && sampleType === 'float32') throw new FeedFormatError('the scene uses the horizontal predictor on float samples, which is not supported');

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
	// GTModelTypeGeoKey: 1 projected, 2 geographic.
	const model = geo.get(1024);
	let crs: CrsKind;
	let epsg: number;
	if (model === 1) {
		const code = geo.get(3072);
		if (code === undefined || !isUtmEpsg(code)) throw new FeedFormatError(`the scene’s coordinate system is not WGS 84 / UTM (EPSG ${code ?? 'unset'})`);
		if ((geo.get(3076) ?? 9001) !== 9001) throw new FeedFormatError('the scene’s units are not metres');
		crs = 'utm';
		epsg = code;
	} else if (model === 2) {
		const code = geo.get(2048);
		if (code !== 4326) throw new FeedFormatError(`the scene’s geographic coordinate system is not WGS 84 (EPSG ${code ?? 'unset'})`);
		if ((geo.get(2054) ?? 9102) !== 9102) throw new FeedFormatError('the scene’s angular units are not degrees');
		crs = 'geographic';
		epsg = 4326;
	} else {
		throw new FeedFormatError('the scene is neither in projected nor in geographic coordinates');
	}
	const acceptCrs = accept.crs ?? (['utm', 'geographic'] as const);
	if (!acceptCrs.includes(crs)) {
		throw new FeedFormatError(crs === 'geographic' ? 'the scene is in geographic coordinates, not projected' : 'the scene is in projected coordinates, not geographic');
	}
	const rasterType = geo.get(1025) ?? 1;
	if (rasterType !== 1 && rasterType !== 2) throw new FeedFormatError(`the scene has an unknown raster type ${rasterType}`);
	// PixelIsPoint (§ 2.5.2.2): the tiepoint is pixel (ti, tj)'s centre, so its corner is half a pixel west and north.
	const half = rasterType === 2 ? 0.5 : 0;
	const originX = tx! - (ti! + half) * scaleX!;
	const originY = ty! + (tj! + half) * scaleY!;
	if (crs === 'geographic' && !(Math.abs(originX) <= 360 && Math.abs(originY) <= 90 && scaleX! <= 10 && scaleY! <= 10)) {
		throw new FeedFormatError('the scene has no usable georeferencing');
	}

	const tilesAcross = Math.ceil(width / tileWidth);
	const tilesDown = Math.ceil(height / tileHeight);
	const tileCount = tilesAcross * tilesDown;
	const offsets = entries.get(TAG.tileOffsets);
	const counts = entries.get(TAG.tileByteCounts);
	if (!offsets || !counts || offsets.count < tileCount || counts.count < tileCount) {
		throw new FeedFormatError('the scene’s tile table is missing or short');
	}

	let nodata: number | null = null;
	const nd = entries.get(TAG.gdalNodata);
	if (nd && nd.type === 2 && nd.count <= 256) {
		const text = new TextDecoder().decode(await valuesOf(nd)).replace(/\0+$/, '').trim();
		nodata = parseNodata(text, sampleType);
	}

	// A band scale or offset (GDAL metadata) means the samples are not the values: refused unless the caller reads them.
	let scale = 1;
	let offset = 0;
	const md = entries.get(TAG.gdalMetadata);
	if (md && md.type === 2) {
		if (md.count > 1024 * 1024) throw new FeedFormatError('the scene’s GDAL metadata is implausibly large');
		const xml = new TextDecoder().decode(await valuesOf(md));
		for (const { role, text } of gdalItems(xml)) {
			const v = Number(text.trim());
			if (text.trim() === '' || !Number.isFinite(v)) throw new FeedFormatError('the scene’s GDAL scale or offset is not a number');
			if (v === (role === 'scale' ? 1 : 0)) continue;
			if (!accept.scaleOffset) throw new FeedFormatError('the scene applies a scale or offset to its samples, which is not supported');
			if (role === 'scale') scale = v;
			else offset = v;
		}
	}

	const tiles = async (first: number, count: number) => {
		if (!(Number.isInteger(first) && Number.isInteger(count) && first >= 0 && count >= 0 && first + count <= tileCount)) {
			throw new RangeError(`tiles ${first}…${first + count - 1} are outside the scene's ${tileCount}`);
		}
		if (count > MAX_TABLE_SLICE) throw new RangeError('the tile-table slice is implausibly large');
		if (count === 0) return [];
		const ov = await valuesOf(offsets, first, count);
		const cv = await valuesOf(counts, first, count);
		return Array.from({ length: count }, (_, i) => ({ offset: num(ov, offsets.type, i), bytes: num(cv, counts.type, i) }));
	};

	return {
		width,
		height,
		tileWidth,
		tileHeight,
		tilesAcross,
		tilesDown,
		bigTiff: big,
		sampleType,
		compression: compression === 1 ? 1 : compression === LZW ? 5 : 8,
		predictor: predictor as 1 | 2 | 3,
		littleEndian: le,
		crs,
		epsg,
		originX,
		originY,
		pixelSizeX: scaleX!,
		pixelSizeY: scaleY!,
		nodata,
		scale,
		offset,
		tiles,
		async tile(i) {
			return (await tiles(i, 1))[0]!;
		}
	};
}

/** GDAL_NODATA's text as a value of the sample type, or null when it isn't one (an integer type's nodata out of its range, say). */
export function parseNodata(text: string, type: SampleType): number | null {
	if (text === '') return null;
	if (type === 'float32') {
		if (/^[+-]?nan$/i.test(text)) return Number.NaN;
		const v = Number(text);
		return Number.isFinite(v) ? Math.fround(v) : null;
	}
	const v = Number(text);
	const [lo, hi] = RANGE[type];
	return Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

/** Whether a sample is the scene's no-data value (NaN matches a NaN no-data). */
export function isNodata(cog: Pick<CogInfo, 'nodata'>, v: number): boolean {
	return cog.nodata !== null && (v === cog.nodata || (Number.isNaN(cog.nodata) && Number.isNaN(v)));
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

/** A lon/lat box, degrees. */
export interface LonLatBox {
	west: number;
	south: number;
	east: number;
	north: number;
}

/**
 * The pixels of a geographic (EPSG:4326) scene that a lon/lat box touches,
 * clipped to the image, or null when the box misses it. A UTM scene is
 * refused: project the outline instead (raster/mask.ts).
 */
export function bboxWindow(cog: Pick<CogInfo, 'crs' | 'width' | 'height' | 'originX' | 'originY' | 'pixelSizeX' | 'pixelSizeY'>, box: LonLatBox): PixelWindow | null {
	if (cog.crs !== 'geographic') throw new RangeError('bboxWindow needs a geographic scene');
	const { west, south, east, north } = box;
	if (![west, south, east, north].every(Number.isFinite) || west > east || south > north) throw new RangeError('the box is not a lon/lat box');
	const col0 = Math.max(0, Math.floor((west - cog.originX) / cog.pixelSizeX));
	const col1 = Math.min(cog.width - 1, Math.ceil((east - cog.originX) / cog.pixelSizeX) - 1);
	const row0 = Math.max(0, Math.floor((cog.originY - north) / cog.pixelSizeY));
	const row1 = Math.min(cog.height - 1, Math.ceil((cog.originY - south) / cog.pixelSizeY) - 1);
	return col0 <= col1 && row0 <= row1 ? { col0, row0, col1, row1 } : null;
}

const CTOR = { uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array, float32: Float32Array } as const;

/**
 * The samples of `win` (inside the image), row-major, `col1 - col0 + 1`
 * wide, as the scene's sample type (a Uint8Array for uint8, …); the GDAL
 * scale and offset are not applied. Reads the tile tables' slice for the
 * window's tile rows (one read each, unless the header held them), then each
 * tile the window touches once, adjacent tiles' bytes as one range (a COG
 * stores a tile row's tiles back to back), one request at a time: the
 * caller paces them.
 */
export async function readWindow(read: RangeRead, cog: CogInfo, win: PixelWindow): Promise<Samples> {
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
	// One slice of each tile table: from the window's first tile to its last (the full rows between them, nothing more).
	const first = tr0 * cog.tilesAcross + tc0;
	const table = await cog.tiles(first, tr1 * cog.tilesAcross + tc1 - first + 1);
	const tiles: { tr: number; tc: number; offset: number; bytes: number }[] = [];
	for (let tr = tr0; tr <= tr1; tr++) {
		for (let tc = tc0; tc <= tc1; tc++) {
			const { offset, bytes } = table[tr * cog.tilesAcross + tc - first]!;
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

	const out = new CTOR[cog.sampleType](w * h);
	for (const t of tiles) {
		let data: Samples;
		if (t.bytes === 0) {
			data = new CTOR[cog.sampleType](cog.tileWidth * cog.tileHeight).fill(cog.nodata!);
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
			(out as Uint8Array).set((data as Uint8Array).subarray(from, from + (c1 - c0 + 1)), (r - row0) * w + (c0 - col0));
		}
	}
	return out;
}

type TileForm = Pick<CogInfo, 'tileWidth' | 'tileHeight' | 'compression' | 'predictor' | 'sampleType' | 'littleEndian'>;

/** One tile's samples from its stored bytes: decompressed (bounded to the tile's size), the predictor undone, in the file's byte order. */
export function decodeTile(cog: TileForm, raw: Uint8Array): Samples {
	const px = cog.tileWidth * cog.tileHeight;
	const bps = SAMPLE[cog.sampleType].bytes;
	const expected = px * bps;
	let data: Uint8Array;
	if (cog.compression === 1) {
		data = raw;
	} else if (cog.compression === 5) {
		// libtiff's test for the pre-6.0 LSB-first "old-style" LZW, which nobody writes any more.
		if (raw.length >= 2 && raw[0] === 0 && (raw[1]! & 1) === 1) throw new FeedFormatError('a tile of the scene is old-style LZW, which is not supported');
		try {
			// Decodes at most the tile's bytes: an LZW bomb stops there.
			data = lzwDecode(raw, expected);
		} catch {
			throw new FeedFormatError('a tile of the scene is not valid LZW');
		}
	} else {
		try {
			// A tile never inflates past its size: a deflate bomb stops there.
			data = inflateSync(raw, { maxOutputLength: expected });
		} catch (e) {
			throw new FeedFormatError((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'a tile of the scene inflates past its size' : 'a tile of the scene does not inflate');
		}
	}
	if (data.length < expected) throw new FeedFormatError('a tile of the scene is truncated');
	const { tileWidth: tw, tileHeight: th, littleEndian: le } = cog;

	if (cog.sampleType === 'uint8') {
		// Copy: the predictor is undone in place, and a raw tile is a view of the read.
		const out = Uint8Array.from(data.subarray(0, expected));
		if (cog.predictor === 2) {
			// Horizontal differencing (TIFF 6.0 § 14), one 8-bit sample: each byte is the previous plus itself, mod 256.
			for (let r = 0; r < th; r++) {
				const base = r * tw;
				for (let c = 1; c < tw; c++) out[base + c] = (out[base + c]! + out[base + c - 1]!) & 0xff;
			}
		}
		return out;
	}

	const view = new DataView(data.buffer, data.byteOffset, expected);
	if (cog.sampleType === 'float32') {
		const out = new Float32Array(px);
		if (cog.predictor !== 3) {
			for (let i = 0; i < px; i++) out[i] = view.getFloat32(i * 4, le);
			return out;
		}
		// The floating-point predictor (Adobe TIFF Technote 3, libtiff's fpAcc): each row is its samples' bytes
		// as four planes, most significant first whatever the file's byte order, then byte-differenced across the row.
		const row = new Uint8Array(tw * 4);
		const rv = new DataView(new ArrayBuffer(4));
		for (let r = 0; r < th; r++) {
			row.set(data.subarray(r * tw * 4, (r + 1) * tw * 4));
			for (let i = 1; i < row.length; i++) row[i] = (row[i]! + row[i - 1]!) & 0xff;
			for (let c = 0; c < tw; c++) {
				for (let b = 0; b < 4; b++) rv.setUint8(b, row[b * tw + c]!);
				out[r * tw + c] = rv.getFloat32(0, false);
			}
		}
		return out;
	}

	// 16-bit: the samples in the file's byte order, then the horizontal predictor undone mod 2¹⁶.
	const u = new Uint16Array(px);
	for (let i = 0; i < px; i++) u[i] = view.getUint16(i * 2, le);
	if (cog.predictor === 2) {
		for (let r = 0; r < th; r++) {
			const base = r * tw;
			for (let c = 1; c < tw; c++) u[base + c] = (u[base + c]! + u[base + c - 1]!) & 0xffff;
		}
	}
	return cog.sampleType === 'int16' ? new Int16Array(u.buffer) : u;
}
