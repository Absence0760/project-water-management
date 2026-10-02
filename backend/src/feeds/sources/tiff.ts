// A minimal GeoTIFF reader: just enough to read a handful of pixels out of a
// CHIRPS or CHIRPS-GEFS daily grid with HTTP range requests, never the whole
// file (a global CHIRPS v3 day is ~15 MB, a GEFS day ~65 MB).
//
// What the CHC files are (checked against the live files, 2026-09; see
// docs/architecture.md § Data feeds): classic little-endian TIFF, one float32
// band (SampleFormat 3), LZW (Compression 5) with no predictor, one row per
// strip, the IFD at the END of the file, a 0.05° WGS 84 grid whose tiepoint
// is (-180, 60) (GeoKeys: geographic, EPSG:4326, degrees, PixelIsArea), and
// -9999 over the sea. A big-endian file or several rows
// per strip are legal TIFF and read as such. Anything else (BigTIFF, tiles, a
// predictor, several bands, a reversed fill order, a GDAL scale / offset) is
// refused with a FeedFormatError rather than guessed at: a format change must
// fail loudly, never write garbage.
//
// No dependency: the roadmap's `geotiff` package would pull in a decoder zoo
// for one codec. The reader is ~200 lines, its LZW is TIFF's own variant
// ("early change", MSB-first), and tiff.test.ts round-trips it through an
// encoder written the other way round.
import { FeedFormatError } from '../errors.js';

/** Reads bytes [start, end] (inclusive) of one resource; null when it doesn't exist (HTTP 404). */
export type RangeRead = (start: number, end: number) => Promise<Uint8Array | null>;

const TAG = {
	width: 256,
	height: 257,
	bitsPerSample: 258,
	compression: 259,
	fillOrder: 266,
	stripOffsets: 273,
	samplesPerPixel: 277,
	rowsPerStrip: 278,
	stripByteCounts: 279,
	planarConfig: 284,
	predictor: 317,
	tileWidth: 322,
	sampleFormat: 339,
	pixelScale: 33550,
	tiepoint: 33922,
	geoKeys: 34735,
	gdalMetadata: 42112,
	gdalNodata: 42113
} as const;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Entry {
	tag: number;
	type: number;
	count: number;
	/** Absolute file offset of the values (inline values point into the IFD itself). */
	offset: number;
}

export interface GridInfo {
	width: number;
	height: number;
	rowsPerStrip: number;
	compression: 1 | 5;
	/** The file's byte order, which its samples follow too (TIFF 6.0 § 2). */
	littleEndian: boolean;
	/** Longitude / latitude of the top-left corner of pixel (0, 0). */
	originLon: number;
	originLat: number;
	/** Degrees per pixel, both positive. */
	scaleLon: number;
	scaleLat: number;
	nodata: number | null;
	/** Reads strip `i`'s offset and byte count. */
	strip(i: number): Promise<{ offset: number; bytes: number }>;
}

/** A value at or below this, or NaN, is "no data" whatever the file says (CHIRPS writes -9999 over the sea). */
const NODATA_FLOOR = -9000;

/** Upper bounds, so a corrupt header can't make us request or allocate absurd amounts. */
const MAX_DIM = 100_000;
const MAX_STRIP_BYTES = 8 * 1024 * 1024;
/** Decoded: a CHC row is 7200 × 4 bytes (28.8 KB); allow ~70 such rows per strip. */
const MAX_DECODED_STRIP_BYTES = 2 * 1024 * 1024;

/**
 * Opens a GeoTIFF by reading its header and first IFD. Returns null when the
 * resource doesn't exist (the day isn't published yet).
 */
export async function openGrid(read: RangeRead): Promise<GridInfo | null> {
	const head = await read(0, 15);
	if (!head) return null;
	if (head.length < 8) throw new FeedFormatError('the grid file is shorter than a TIFF header');
	const le = head[0] === 0x49 && head[1] === 0x49;
	if (!le && !(head[0] === 0x4d && head[1] === 0x4d)) throw new FeedFormatError('the grid file is not a TIFF');
	const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const magic = hv.getUint16(2, le);
	if (magic === 43) throw new FeedFormatError('BigTIFF grids are not supported');
	if (magic !== 42) throw new FeedFormatError('the grid file is not a TIFF');
	const ifdOffset = hv.getUint32(4, le);
	if (ifdOffset < 8) throw new FeedFormatError('the grid file has no image directory');

	// The IFD and, in the CHC files, its arrays follow it to the end of the
	// file: one read usually has everything (a server clips the range at EOF).
	const IFD_READ = 64 * 1024;
	const block = await read(ifdOffset, ifdOffset + IFD_READ - 1);
	if (!block || block.length < 2) throw new FeedFormatError('the grid file ends before its image directory');
	const bv = new DataView(block.buffer, block.byteOffset, block.byteLength);
	const n = bv.getUint16(0, le);
	if (n === 0 || 2 + n * 12 > block.length) throw new FeedFormatError('the grid file’s image directory is truncated');

	const entries = new Map<number, Entry>();
	for (let i = 0; i < n; i++) {
		const p = 2 + i * 12;
		const tag = bv.getUint16(p, le);
		const type = bv.getUint16(p + 2, le);
		const count = bv.getUint32(p + 4, le);
		const size = (TYPE_SIZE[type] ?? 0) * count;
		if (!TYPE_SIZE[type]) continue; // an unknown type in a tag we don't read
		const offset = size <= 4 ? ifdOffset + p + 8 : bv.getUint32(p + 8, le);
		entries.set(tag, { tag, type, count, offset });
	}

	// Values: from the block when they're inside it, else a read of their own.
	const bytesOf = async (e: Entry, first = 0, count = e.count): Promise<DataView> => {
		const size = TYPE_SIZE[e.type]!;
		const start = e.offset + first * size;
		const len = count * size;
		if (start >= ifdOffset && start + len <= ifdOffset + block.length) {
			return new DataView(block.buffer, block.byteOffset + (start - ifdOffset), len);
		}
		const got = await read(start, start + len - 1);
		if (!got || got.length < len) throw new FeedFormatError('the grid file ends inside its image directory');
		return new DataView(got.buffer, got.byteOffset, len);
	};
	const num = (v: DataView, type: number, i: number): number => {
		switch (type) {
			case 1:
			case 7:
				return v.getUint8(i);
			case 3:
				return v.getUint16(i * 2, le);
			case 4:
				return v.getUint32(i * 4, le);
			case 11:
				return v.getFloat32(i * 4, le);
			case 12:
				return v.getFloat64(i * 8, le);
			default:
				throw new FeedFormatError(`the grid file uses TIFF type ${type} where a number was expected`);
		}
	};
	const scalar = async (tag: number, fallback?: number): Promise<number> => {
		const e = entries.get(tag);
		if (!e) {
			if (fallback === undefined) throw new FeedFormatError(`the grid file lacks TIFF tag ${tag}`);
			return fallback;
		}
		return num(await bytesOf(e, 0, 1), e.type, 0);
	};
	const doubles = async (tag: number, count: number): Promise<number[]> => {
		const e = entries.get(tag);
		if (!e || e.type !== 12 || e.count < count) throw new FeedFormatError('the grid file has no usable georeferencing');
		const v = await bytesOf(e, 0, count);
		return Array.from({ length: count }, (_, i) => v.getFloat64(i * 8, le));
	};

	if (entries.has(TAG.tileWidth)) throw new FeedFormatError('tiled grids are not supported');
	const width = await scalar(TAG.width);
	const height = await scalar(TAG.height);
	if (!(width >= 1 && width <= MAX_DIM && height >= 1 && height <= MAX_DIM)) throw new FeedFormatError('the grid has implausible dimensions');
	if ((await scalar(TAG.bitsPerSample)) !== 32 || (await scalar(TAG.sampleFormat, 1)) !== 3) {
		throw new FeedFormatError('the grid is not 32-bit floating point');
	}
	if ((await scalar(TAG.samplesPerPixel, 1)) !== 1) throw new FeedFormatError('the grid has more than one band');
	if ((await scalar(TAG.planarConfig, 1)) !== 1) throw new FeedFormatError('the grid’s planar configuration is not supported');
	if ((await scalar(TAG.predictor, 1)) !== 1) throw new FeedFormatError('the grid uses a TIFF predictor, which is not supported');
	if ((await scalar(TAG.fillOrder, 1)) !== 1) throw new FeedFormatError('the grid uses a reversed bit fill order, which is not supported');
	const compression = await scalar(TAG.compression, 1);
	if (compression !== 1 && compression !== 5) throw new FeedFormatError(`the grid uses TIFF compression ${compression}, which is not supported`);
	const rowsPerStrip = Math.min(await scalar(TAG.rowsPerStrip, height), height);
	if (!(rowsPerStrip >= 1)) throw new FeedFormatError('the grid has no rows per strip');

	// IDL writes the 0.05° scale from a float32, as 0.05000000074505806: over
	// 7200 columns that drifts a whole pixel. Seven significant digits is all
	// a float32 carries, so snap to them.
	const [scaleLon, scaleLat] = (await doubles(TAG.pixelScale, 2)).map((v) => Number(v.toPrecision(7)));
	const [ti, tj, , tx, ty] = await doubles(TAG.tiepoint, 6);
	if (!(scaleLon! > 0 && scaleLat! > 0) || ![ti, tj, tx, ty].every(Number.isFinite)) throw new FeedFormatError('the grid has no usable georeferencing');

	// The GeoKey directory (GeoTIFF 1.0 § 2.4): SHORTs [version, revision,
	// minor, key count], then [key, tag location, count, value] per key; a
	// location of 0 means the value is inline. The scale and tiepoint only
	// mean degrees on WGS 84 if these keys say so, and whether the tiepoint is
	// a pixel's corner or its centre is the raster type's call.
	const gk = entries.get(TAG.geoKeys);
	if (!gk || gk.type !== 3 || gk.count < 4 || gk.count > 4096) throw new FeedFormatError('the grid does not say its coordinate system');
	const gv = await bytesOf(gk);
	const short = (i: number) => gv.getUint16(i * 2, le);
	const keyCount = short(3);
	if (4 + keyCount * 4 > gk.count) throw new FeedFormatError('the grid’s GeoKey directory is truncated');
	const geo = new Map<number, number>();
	for (let k = 0; k < keyCount; k++) {
		const at = 4 + k * 4;
		if (short(at + 1) === 0) geo.set(short(at), short(at + 3));
	}
	if (geo.get(1024) !== 2) throw new FeedFormatError('the grid is not in geographic (latitude / longitude) coordinates');
	if (geo.get(2048) !== 4326) throw new FeedFormatError('the grid’s coordinate system is not WGS 84 (EPSG:4326)');
	if ((geo.get(2054) ?? 9102) !== 9102) throw new FeedFormatError('the grid’s angles are not in degrees');
	const rasterType = geo.get(1025) ?? 1;
	if (rasterType !== 1 && rasterType !== 2) throw new FeedFormatError(`the grid has an unknown raster type ${rasterType}`);
	// PixelIsPoint (§ 2.5.2.2): the tiepoint is the centre of pixel (ti, tj), so its corner is half a pixel west and north.
	const half = rasterType === 2 ? 0.5 : 0;

	const offsets = entries.get(TAG.stripOffsets);
	const counts = entries.get(TAG.stripByteCounts);
	const strips = Math.ceil(height / rowsPerStrip);
	if (!offsets || !counts || offsets.count < strips || counts.count < strips) throw new FeedFormatError('the grid file’s strip table is missing or short');

	let nodata: number | null = null;
	const nd = entries.get(TAG.gdalNodata);
	if (nd && nd.type === 2 && nd.count <= 256) {
		const text = new TextDecoder().decode(await bytesOf(nd)).replace(/\0+$/, '').trim();
		const v = Number(text);
		// The samples are float32: compare with the float32 the writer stored, not the decimal text.
		if (text !== '' && Number.isFinite(v)) nodata = Math.fround(v);
	}

	// GDAL keeps a band's scale and offset (value = raw × scale + offset) in its
	// XML metadata. The CHC files have none; a file that does means something
	// other than mm in its raw samples, so refuse it rather than read it raw.
	const md = entries.get(TAG.gdalMetadata);
	if (md && md.type === 2) {
		if (md.count > 1024 * 1024) throw new FeedFormatError('the grid’s GDAL metadata is implausibly large');
		const xml = new TextDecoder().decode(await bytesOf(md));
		for (const { role, text } of gdalItems(xml)) {
			const v = Number(text.trim());
			if (text.trim() === '' || v !== (role === 'scale' ? 1 : 0)) {
				throw new FeedFormatError('the grid applies a scale or offset to its samples, which is not supported');
			}
		}
	}

	return {
		width,
		height,
		rowsPerStrip,
		compression: compression as 1 | 5,
		littleEndian: le,
		originLon: tx! - (ti! + half) * scaleLon!,
		originLat: ty! + (tj! + half) * scaleLat!,
		scaleLon: scaleLon!,
		scaleLat: scaleLat!,
		nodata,
		async strip(i) {
			return {
				offset: num(await bytesOf(offsets, i, 1), offsets.type, 0),
				bytes: num(await bytesOf(counts, i, 1), counts.type, 0)
			};
		}
	};
}

/**
 * The scale and offset `<Item role="…">value</Item>` entries of GDAL's
 * metadata XML. A scan with indexOf, linear in the text: the regex it
 * replaces backtracked quadratically on a megabyte of `<Item` with no `>`.
 */
export function gdalItems(xml: string): { role: 'scale' | 'offset'; text: string }[] {
	const lower = xml.toLowerCase();
	const out: { role: 'scale' | 'offset'; text: string }[] = [];
	let i = 0;
	for (;;) {
		i = lower.indexOf('<item', i);
		if (i < 0) break;
		const after = lower[i + 5];
		const gt = lower.indexOf('>', i);
		if (gt < 0) break;
		const start = i;
		i = gt + 1;
		// `<Item` as a whole name (`\b`): followed by space, `/` or `>`.
		if (after !== undefined && !/[\s/>]/.test(after)) continue;
		const role = /\brole="(scale|offset)"/.exec(lower.slice(start, gt))?.[1] as 'scale' | 'offset' | undefined;
		if (!role) continue;
		const lt = lower.indexOf('<', i);
		if (lt < 0 || !lower.startsWith('</item>', lt)) continue;
		out.push({ role, text: xml.slice(i, lt) });
		i = lt + 7;
	}
	return out;
}

/** The pixel (row, col) holding a point, or null outside the grid. */
export function pixelOf(g: Pick<GridInfo, 'width' | 'height' | 'originLon' | 'originLat' | 'scaleLon' | 'scaleLat'>, lat: number, lon: number) {
	// A point on a pixel edge belongs to the pixel east / south of it, except
	// on the grid's own east / south edge, where there is no such pixel: the
	// CHC grid ends at 180° E and 60° S, both of which a feed may name.
	const EPS = 1e-6;
	const index = (x: number, n: number) => {
		const i = Math.floor(x + EPS);
		return i === n && x - n < EPS ? n - 1 : i;
	};
	const col = index((lon - g.originLon) / g.scaleLon, g.width);
	const row = index((g.originLat - lat) / g.scaleLat, g.height);
	// Written so NaN (a non-number coordinate) fails too.
	if (!(row >= 0 && col >= 0 && row < g.height && col < g.width)) return null;
	return { row, col };
}

/**
 * The values at `points` (lat/lon), each null where the grid says "no data".
 * Reads one strip per distinct strip needed. Throws FeedFormatError for a
 * point outside the grid or a corrupt strip.
 */
export async function readPoints(read: RangeRead, grid: GridInfo, points: readonly { lat: number; lon: number }[]): Promise<(number | null)[]> {
	const where = points.map((p) => {
		const px = pixelOf(grid, p.lat, p.lon);
		if (!px) throw new FeedFormatError(`the point ${p.lat}, ${p.lon} is outside the grid`);
		return px;
	});
	const decoded = new Map<number, DataView>();
	const rowBytes = grid.width * 4;
	for (const s of new Set(where.map((w) => Math.floor(w.row / grid.rowsPerStrip)))) {
		const { offset, bytes } = await grid.strip(s);
		if (!(bytes > 0 && bytes <= MAX_STRIP_BYTES)) throw new FeedFormatError('a strip of the grid has an implausible size');
		const raw = await read(offset, offset + bytes - 1);
		if (!raw || raw.length < bytes) throw new FeedFormatError('the grid file ends inside a strip');
		const rows = Math.min(grid.rowsPerStrip, grid.height - s * grid.rowsPerStrip);
		const expected = rows * rowBytes;
		// Bound what the header makes us allocate, not only what we read.
		if (expected > MAX_DECODED_STRIP_BYTES) throw new FeedFormatError('a strip of the grid would decode to an implausible size');
		const data = grid.compression === 5 ? lzwDecode(raw, expected) : raw.subarray(0, expected);
		if (data.length < expected) throw new FeedFormatError('a strip of the grid is truncated');
		decoded.set(s, new DataView(data.buffer, data.byteOffset, data.byteLength));
	}
	return where.map(({ row, col }) => {
		const s = Math.floor(row / grid.rowsPerStrip);
		const v = decoded.get(s)!.getFloat32(((row - s * grid.rowsPerStrip) * grid.width + col) * 4, grid.littleEndian);
		if (Number.isNaN(v) || v <= NODATA_FLOOR || (grid.nodata !== null && v === grid.nodata)) return null;
		return v;
	});
}

const CLEAR = 256;
const EOI = 257;

/**
 * TIFF LZW (TIFF 6.0 § 13): MSB-first codes of 9–12 bits, Clear 256, End 257,
 * and "early change": the width grows one code before the table fills.
 * Decodes at most `expected` bytes; stops at End, or when the input runs out.
 */
export function lzwDecode(input: Uint8Array, expected: number): Uint8Array {
	const out = new Uint8Array(expected);
	let op = 0;
	const table: Uint8Array[] = new Array(4096);
	for (let i = 0; i < 256; i++) table[i] = Uint8Array.of(i);
	let next = 258;
	let width = 9;
	let bit = 0;
	const totalBits = input.length * 8;
	const readCode = (): number => {
		if (bit + width > totalBits) return EOI;
		let v = 0;
		for (let i = 0; i < width; i++, bit++) v = (v << 1) | ((input[bit >> 3]! >> (7 - (bit & 7))) & 1);
		return v;
	};
	const emit = (s: Uint8Array) => {
		const n = Math.min(s.length, expected - op);
		out.set(n === s.length ? s : s.subarray(0, n), op);
		op += n;
	};
	let prev: Uint8Array | null = null;
	while (op < expected) {
		const code = readCode();
		if (code === EOI) break;
		if (code === CLEAR) {
			next = 258;
			width = 9;
			prev = null;
			continue;
		}
		let entry: Uint8Array;
		if (code < next && table[code]) {
			entry = table[code]!;
		} else if (code === next && prev) {
			entry = new Uint8Array(prev.length + 1);
			entry.set(prev);
			entry[prev.length] = prev[0]!;
		} else {
			throw new FeedFormatError('a strip of the grid is not valid LZW');
		}
		emit(entry);
		if (prev) {
			if (next >= 4096) throw new FeedFormatError('a strip of the grid is not valid LZW');
			const add = new Uint8Array(prev.length + 1);
			add.set(prev);
			add[prev.length] = entry[0]!;
			table[next++] = add;
			if (next >= (1 << width) - 1 && width < 12) width++;
		}
		prev = entry;
	}
	return op === expected ? out : out.subarray(0, op);
}
