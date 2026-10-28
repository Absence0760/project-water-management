// Writes a small tiled GeoTIFF laid out like a Digital Earth Africa WOfS
// scene (cog.ts has the layout): classic TIFF, one uint8 band, tiles,
// DEFLATE through node:zlib with the horizontal predictor, GDAL's 4-byte size
// before each tile, GDAL_NODATA, and GeoKeys for WGS 84 / UTM. The fixture
// source (wofs/fixtures.ts) serves scenes made here, and cog.test.ts
// round-trips the reader through it, so the reader is exercised on the
// layout it meets in production. Also writes the legal variants the reader
// must still read (big-endian, no compression, no predictor, an empty tile,
// PixelIsPoint) and, through `override`, the ones it must refuse.
import { deflateSync } from 'node:zlib';

export interface CogSpec {
	width: number;
	height: number;
	/** Row-major samples, width × height. */
	values: Uint8Array;
	/** EPSG 326xx / 327xx. */
	epsg: number;
	/** Top-left corner of pixel (0, 0), metres. */
	originX: number;
	originY: number;
	/** Metres per pixel (default 30). */
	pixelSize?: number;
	/** Tile side (default 512, as WOfS). */
	tile?: number;
	compression?: 1 | 8;
	predictor?: 1 | 2;
	/** GDAL_NODATA text (default "1", as WOfS); null writes none. */
	nodata?: string | null;
	bigEndian?: boolean;
	/** Write the tiepoint as pixel (0, 0)'s centre (GTRasterTypeGeoKey 2, PixelIsPoint). */
	pixelIsPoint?: boolean;
	/** Tiles (row-major indices) written empty, offset and size 0 (GDAL's SPARSE_OK). */
	sparse?: number[];
	/** Replace or add tags (tag → [type, values]), or drop one (null): for malformed files. */
	override?: Record<number, [number, number[]] | null>;
	/** Replace GeoKeys (key → value), or drop one (null). */
	geoKeys?: Record<number, number | null>;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

/** The scene's tiles, each `tile × tile` (edge tiles padded with no-data), predictor applied. */
function tilesOf(spec: CogSpec, tile: number, pad: number): Uint8Array[] {
	const across = Math.ceil(spec.width / tile);
	const down = Math.ceil(spec.height / tile);
	const out: Uint8Array[] = [];
	for (let tr = 0; tr < down; tr++) {
		for (let tc = 0; tc < across; tc++) {
			const t = new Uint8Array(tile * tile).fill(pad);
			for (let r = 0; r < tile; r++) {
				const y = tr * tile + r;
				if (y >= spec.height) break;
				const x0 = tc * tile;
				const n = Math.min(tile, spec.width - x0);
				t.set(spec.values.subarray(y * spec.width + x0, y * spec.width + x0 + n), r * tile);
			}
			if ((spec.predictor ?? 2) === 2) {
				for (let r = 0; r < tile; r++) for (let c = tile - 1; c >= 1; c--) t[r * tile + c] = (t[r * tile + c]! - t[r * tile + c - 1]!) & 0xff;
			}
			out.push(t);
		}
	}
	return out;
}

export function writeCog(spec: CogSpec): Uint8Array {
	if (spec.values.length !== spec.width * spec.height) throw new RangeError('values must hold width × height samples');
	const tile = spec.tile ?? 512;
	const size = spec.pixelSize ?? 30;
	const compression = spec.compression ?? 8;
	const nodata = spec.nodata === undefined ? '1' : spec.nodata;
	const le = !spec.bigEndian;
	const sparse = new Set(spec.sparse ?? []);
	const raw = tilesOf(spec, tile, nodata === null ? 0 : Number(nodata));
	const stored = raw.map((t, i) => (sparse.has(i) ? new Uint8Array(0) : compression === 8 ? new Uint8Array(deflateSync(t)) : t));

	const keys: Record<number, number> = { 1024: 1, 1025: spec.pixelIsPoint ? 2 : 1, 3072: spec.epsg, 3076: 9001 };
	for (const [k, v] of Object.entries(spec.geoKeys ?? {})) {
		if (v === null) delete keys[Number(k)];
		else keys[Number(k)] = v;
	}
	const keyList = Object.entries(keys).sort(([a], [b]) => Number(a) - Number(b));
	const geoKeyDir = [1, 1, 0, keyList.length, ...keyList.flatMap(([k, v]) => [Number(k), 0, 1, v])];
	const half = spec.pixelIsPoint ? 0.5 : 0;

	const tags: Record<number, [number, number[]]> = {
		256: [3, [spec.width]],
		257: [3, [spec.height]],
		258: [3, [8]],
		259: [3, [compression]],
		262: [3, [1]],
		277: [3, [1]],
		284: [3, [1]],
		317: [3, [spec.predictor ?? 2]],
		322: [3, [tile]],
		323: [3, [tile]],
		324: [4, stored.map(() => 0)], // filled in below
		325: [4, stored.map((s) => s.length)],
		339: [3, [1]],
		33550: [12, [size, size, 0]],
		33922: [12, [0, 0, 0, spec.originX + half * size, spec.originY - half * size, 0]],
		34735: [3, geoKeyDir]
	};
	const ascii: Record<number, string> = {};
	if (nodata !== null) ascii[42113] = `${nodata}\0`;
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

	// Layout: header (8) | IFD | out-of-line values | tiles (each a 4-byte size, then its bytes).
	const all = [...Object.keys(tags), ...Object.keys(ascii)].map(Number).sort((a, b) => a - b);
	const ifdOffset = 8;
	const ifdSize = 2 + all.length * 12 + 4;
	let cursor = ifdOffset + ifdSize;
	const outOfLine = new Map<number, number>();
	const sizeOf = (tag: number) => (tag in ascii ? ascii[tag]!.length : TYPE_SIZE[tags[tag]![0]]! * tags[tag]![1].length);
	for (const tag of all) {
		const s = sizeOf(tag);
		if (s > 4) {
			cursor += cursor % 2; // word-aligned values
			outOfLine.set(tag, cursor);
			cursor += s;
		}
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
	if (tags[324] && !(spec.override && 324 in spec.override)) tags[324] = [4, offsets];

	const buf = new Uint8Array(cursor);
	const v = new DataView(buf.buffer);
	buf[0] = buf[1] = le ? 0x49 : 0x4d;
	v.setUint16(2, 42, le);
	v.setUint32(4, ifdOffset, le);
	v.setUint16(ifdOffset, all.length, le);
	const put = (at: number, type: number, values: number[]) => {
		values.forEach((x, i) => {
			const p = at + i * TYPE_SIZE[type]!;
			if (type === 1) v.setUint8(p, x);
			else if (type === 3) v.setUint16(p, x, le);
			else if (type === 4) v.setUint32(p, x, le);
			else v.setFloat64(p, x, le);
		});
	};
	all.forEach((tag, i) => {
		const p = ifdOffset + 2 + i * 12;
		const isAscii = tag in ascii;
		const type = isAscii ? 2 : tags[tag]![0];
		const values = isAscii ? [...ascii[tag]!].map((c) => c.charCodeAt(0)) : tags[tag]![1];
		v.setUint16(p, tag, le);
		v.setUint16(p + 2, type, le);
		v.setUint32(p + 4, values.length, le);
		const at = outOfLine.get(tag);
		if (at !== undefined) v.setUint32(p + 8, at, le);
		put(at ?? p + 8, isAscii ? 1 : type, values);
	});
	stored.forEach((s, i) => {
		if (s.length === 0) return;
		v.setUint32(offsets[i]! - 4, s.length, le);
		buf.set(s, offsets[i]!);
	});
	return buf;
}
