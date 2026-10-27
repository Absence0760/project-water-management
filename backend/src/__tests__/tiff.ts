// A classic GeoTIFF built byte by byte for the raster readers' tests
// (loadCropland.test.ts, loadCropTypes.test.ts): one 8-bit band, tiled or
// striped, Deflate or none, predictor 1 or 2, an optional no-data value.
import { deflateSync } from 'node:zlib';

export interface TiffSpec {
	width: number;
	height: number;
	pixels: Uint8Array;
	west: number;
	north: number;
	pixel: number;
	tile?: number;
	/** Rows per strip, when not tiled. */
	strip?: number;
	compression?: 1 | 8;
	predictor?: 1 | 2;
	noData?: string;
	/** GeoKeys: the model type (2 geographic) and the datum (4326). */
	geoKeys?: [number, number];
	bits?: number;
}

/** A little-endian classic GeoTIFF of one 8-bit band. */
export function tiff(s: TiffSpec): Buffer {
	const bw = s.tile ?? s.width;
	const bh = s.tile ?? s.strip ?? s.height;
	const blocks: Buffer[] = [];
	for (let by = 0; by < s.height; by += bh) {
		for (let bx = 0; bx < s.width; bx += bw) {
			const h = s.tile ? bh : Math.min(bh, s.height - by);
			const b = new Uint8Array(bw * h);
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < bw; x++) {
					const v = by + y < s.height && bx + x < s.width ? s.pixels[(by + y) * s.width + bx + x]! : 0;
					b[y * bw + x] = v;
				}
				if (s.predictor === 2) for (let x = bw - 1; x > 0; x--) b[y * bw + x] = (b[y * bw + x]! - b[y * bw + x - 1]! + 256) & 255;
			}
			blocks.push(s.compression === 8 ? deflateSync(b) : Buffer.from(b));
		}
	}
	type Entry = { tag: number; type: number; values: number[] | string };
	const entries: Entry[] = [
		{ tag: 256, type: 4, values: [s.width] },
		{ tag: 257, type: 4, values: [s.height] },
		{ tag: 258, type: 3, values: [s.bits ?? 8] },
		{ tag: 259, type: 3, values: [s.compression ?? 1] },
		{ tag: 277, type: 3, values: [1] },
		{ tag: 317, type: 3, values: [s.predictor ?? 1] },
		{ tag: 339, type: 3, values: [1] },
		{ tag: 33550, type: 12, values: [s.pixel, s.pixel, 0] },
		{ tag: 33922, type: 12, values: [0, 0, 0, s.west, s.north, 0] }
	];
	if (s.tile) entries.push({ tag: 322, type: 3, values: [bw] }, { tag: 323, type: 3, values: [bh] });
	else entries.push({ tag: 278, type: 3, values: [bh] });
	const [modelType, datum] = s.geoKeys ?? [2, 4326];
	entries.push({ tag: 34735, type: 3, values: [1, 1, 0, 2, 1024, 0, 1, modelType, 2048, 0, 1, datum] });
	if (s.noData !== undefined) entries.push({ tag: 42113, type: 2, values: `${s.noData}\0` });
	// Offsets and counts last: their values are known once the layout is.
	const offTag = s.tile ? 324 : 273;
	const cntTag = s.tile ? 325 : 279;
	entries.push({ tag: offTag, type: 4, values: blocks.map(() => 0) }, { tag: cntTag, type: 4, values: blocks.map((b) => b.length) });
	entries.sort((a, b) => a.tag - b.tag);
	const size = (e: Entry) => (typeof e.values === 'string' ? e.values.length : e.values.length * (e.type === 12 ? 8 : e.type === 4 ? 4 : 2));
	const ifdAt = 8;
	const ifdLen = 2 + entries.length * 12 + 4;
	let extra = ifdAt + ifdLen;
	const extraAt = new Map<Entry, number>();
	for (const e of entries) if (size(e) > 4) (extraAt.set(e, extra), (extra += size(e)));
	let dataAt = extra;
	const offsets = blocks.map((b) => ((dataAt += b.length), dataAt - b.length));
	entries.find((e) => e.tag === offTag)!.values = offsets;
	const out = Buffer.alloc(dataAt);
	out.write('II', 0, 'latin1');
	out.writeUInt16LE(42, 2);
	out.writeUInt32LE(ifdAt, 4);
	out.writeUInt16LE(entries.length, ifdAt);
	entries.forEach((e, i) => {
		const at = ifdAt + 2 + i * 12;
		out.writeUInt16LE(e.tag, at);
		out.writeUInt16LE(e.type, at + 2);
		out.writeUInt32LE(typeof e.values === 'string' ? e.values.length : e.values.length, at + 4);
		const where = extraAt.get(e) ?? at + 8;
		if (extraAt.has(e)) out.writeUInt32LE(where, at + 8);
		if (typeof e.values === 'string') out.write(e.values, where, 'latin1');
		else
			e.values.forEach((v, k) => {
				if (e.type === 12) out.writeDoubleLE(v, where + k * 8);
				else if (e.type === 4) out.writeUInt32LE(v, where + k * 4);
				else out.writeUInt16LE(v, where + k * 2);
			});
	});
	let at = extra;
	for (const b of blocks) (b.copy(out, at), (at += b.length));
	return out;
}
