// A PMTiles v3 reader (and a small writer for the synthetic fixture): the
// archive format of the DEM (docs/design/delineation.md § The DEM; spec:
// https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md). Reads
// only the byte ranges it needs, so the same code reads a local file, the
// MinIO copy over HTTP, or S3 in production (dem.ts makes the sources).
import { gunzipSync, gzipSync } from 'node:zlib';

/** Reads `length` bytes at `offset`. */
export type ByteSource = (offset: number, length: number) => Promise<Uint8Array>;

export class PmtilesError extends Error {}

export const TILE_TYPES = { 1: 'mvt', 2: 'png', 3: 'jpeg', 4: 'webp', 5: 'avif' } as const;

export interface Header {
	rootOffset: number;
	rootLength: number;
	metadataOffset: number;
	metadataLength: number;
	leafOffset: number;
	tileDataOffset: number;
	internalCompression: number;
	tileCompression: number;
	tileType: number;
	minZoom: number;
	maxZoom: number;
	/** [west, south, east, north] */
	bounds: [number, number, number, number];
}

interface Entry {
	tileId: number;
	offset: number;
	length: number;
	runLength: number;
}

const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;

function readVarint(b: Uint8Array, p: { i: number }): number {
	let v = 0;
	let mul = 1;
	for (;;) {
		const byte = b[p.i++];
		if (byte === undefined) throw new PmtilesError('a directory ends inside a number');
		v += (byte & 0x7f) * mul;
		if (byte < 0x80) return v;
		mul *= 128;
		if (mul > 2 ** 56) throw new PmtilesError('a number too large');
	}
}

function writeVarint(out: number[], v: number) {
	while (v >= 0x80) {
		out.push((v % 128) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
}

function rotate(n: number, xy: [number, number], rx: number, ry: number) {
	if (ry === 0) {
		if (rx === 1) {
			xy[0] = n - 1 - xy[0];
			xy[1] = n - 1 - xy[1];
		}
		const t = xy[0];
		xy[0] = xy[1];
		xy[1] = t;
	}
}

/** The tile id of z/x/y: the tiles of every lower zoom, then the Hilbert index. */
export function tileId(z: number, x: number, y: number): number {
	if (z > 26) throw new PmtilesError('zoom above 26');
	const n = 2 ** z;
	if (x < 0 || y < 0 || x >= n || y >= n) throw new PmtilesError(`tile ${z}/${x}/${y} outside its zoom`);
	let acc = 0;
	for (let i = 0; i < z; i++) acc += 4 ** i;
	const xy: [number, number] = [x, y];
	let d = 0;
	for (let s = n / 2; s >= 1; s /= 2) {
		const rx = (xy[0] & s) > 0 ? 1 : 0;
		const ry = (xy[1] & s) > 0 ? 1 : 0;
		d += s * s * ((3 * rx) ^ ry);
		rotate(s, xy, rx, ry);
	}
	return acc + d;
}

function decompress(b: Uint8Array, compression: number): Uint8Array {
	if (compression === COMPRESSION_NONE) return b;
	if (compression === COMPRESSION_GZIP) return new Uint8Array(gunzipSync(b));
	throw new PmtilesError(`compression ${compression} is not supported (gzip or none)`);
}

function parseDirectory(b: Uint8Array): Entry[] {
	const p = { i: 0 };
	const n = readVarint(b, p);
	const entries: Entry[] = Array.from({ length: n }, () => ({ tileId: 0, offset: 0, length: 0, runLength: 0 }));
	let last = 0;
	for (const e of entries) e.tileId = last += readVarint(b, p);
	for (const e of entries) e.runLength = readVarint(b, p);
	for (const e of entries) e.length = readVarint(b, p);
	entries.forEach((e, i) => {
		const v = readVarint(b, p);
		e.offset = v === 0 && i > 0 ? entries[i - 1]!.offset + entries[i - 1]!.length : v - 1;
	});
	return entries;
}

function findEntry(entries: Entry[], id: number): Entry | null {
	let lo = 0;
	let hi = entries.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const c = entries[mid]!.tileId;
		if (c === id) return entries[mid]!;
		if (c < id) lo = mid + 1;
		else hi = mid - 1;
	}
	// The last entry before it: a run covering it, or a leaf directory.
	if (hi >= 0) {
		const e = entries[hi]!;
		if (e.runLength === 0) return e;
		if (id - e.tileId < e.runLength) return e;
	}
	return null;
}

const u64 = (dv: DataView, o: number) => Number(dv.getBigUint64(o, true));

export function parseHeader(b: Uint8Array): Header {
	if (b.length < 127 || String.fromCharCode(...b.subarray(0, 7)) !== 'PMTiles') throw new PmtilesError('not a PMTiles archive');
	if (b[7] !== 3) throw new PmtilesError(`PMTiles version ${b[7]} (3 is supported)`);
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	return {
		rootOffset: u64(dv, 8),
		rootLength: u64(dv, 16),
		metadataOffset: u64(dv, 24),
		metadataLength: u64(dv, 32),
		leafOffset: u64(dv, 40),
		tileDataOffset: u64(dv, 56),
		internalCompression: b[97]!,
		tileCompression: b[98]!,
		tileType: b[99]!,
		minZoom: b[100]!,
		maxZoom: b[101]!,
		bounds: [dv.getInt32(102, true) / 1e7, dv.getInt32(106, true) / 1e7, dv.getInt32(110, true) / 1e7, dv.getInt32(114, true) / 1e7]
	};
}

export class PmtilesReader {
	private header: Promise<{ header: Header; root: Entry[] }> | undefined;
	private readonly leaves = new Map<number, Promise<Entry[]>>();

	constructor(private readonly read: ByteSource) {}

	async getHeader(): Promise<Header> {
		return (await this.start()).header;
	}

	/** The archive's metadata JSON (the attribution, the build), or {} when it has none. */
	async getMetadata(): Promise<Record<string, unknown>> {
		const h = await this.getHeader();
		if (!h.metadataLength) return {};
		const raw = decompress(await this.read(h.metadataOffset, h.metadataLength), h.internalCompression);
		try {
			const m = JSON.parse(new TextDecoder().decode(raw)) as unknown;
			return m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
		} catch {
			throw new PmtilesError('the metadata is not JSON');
		}
	}

	private start() {
		this.header ??= (async () => {
			// The header and root directory sit in the first 16 KiB (spec § 2).
			const first = await this.read(0, 16384);
			const header = parseHeader(first);
			const rootBytes =
				header.rootOffset + header.rootLength <= first.length
					? first.subarray(header.rootOffset, header.rootOffset + header.rootLength)
					: await this.read(header.rootOffset, header.rootLength);
			return { header, root: parseDirectory(decompress(rootBytes, header.internalCompression)) };
		})();
		this.header.catch(() => (this.header = undefined));
		return this.header;
	}

	/** The tile's bytes (decompressed), or null when the archive has no such tile. */
	async getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
		const { header, root } = await this.start();
		const id = tileId(z, x, y);
		let dir = root;
		for (let depth = 0; depth < 4; depth++) {
			const e = findEntry(dir, id);
			if (!e) return null;
			if (e.runLength > 0) return decompress(await this.read(header.tileDataOffset + e.offset, e.length), header.tileCompression);
			const at = header.leafOffset + e.offset;
			let leaf = this.leaves.get(at);
			if (!leaf) {
				leaf = this.read(at, e.length).then((b) => parseDirectory(decompress(b, header.internalCompression)));
				leaf.catch(() => this.leaves.delete(at));
				if (this.leaves.size > 256) this.leaves.clear();
				this.leaves.set(at, leaf);
			}
			dir = await leaf;
		}
		throw new PmtilesError('directories nested too deep');
	}
}

/**
 * A small single-directory PMTiles archive (gzip directories, uncompressed
 * tiles): what backend/scripts/dem-fixture.ts writes the synthetic DEM as.
 */
export function writePmtiles(
	tiles: { z: number; x: number; y: number; data: Uint8Array }[],
	opts: { tileType: 2 | 4; bounds: [number, number, number, number]; metadata: Record<string, unknown> }
): Buffer {
	const sorted = tiles.map((t) => ({ ...t, id: tileId(t.z, t.x, t.y) })).sort((a, b) => a.id - b.id);
	const out: number[] = [];
	writeVarint(out, sorted.length);
	let last = 0;
	for (const t of sorted) {
		writeVarint(out, t.id - last);
		last = t.id;
	}
	for (let i = 0; i < sorted.length; i++) writeVarint(out, 1);
	for (const t of sorted) writeVarint(out, t.data.length);
	let offset = 0;
	sorted.forEach((t, i) => {
		writeVarint(out, i === 0 ? offset + 1 : 0);
		offset += t.data.length;
	});
	const root = gzipSync(Buffer.from(out));
	const meta = gzipSync(Buffer.from(JSON.stringify(opts.metadata)));
	const data = Buffer.concat(sorted.map((t) => t.data));
	const h = Buffer.alloc(127);
	h.write('PMTiles', 0, 'latin1');
	h[7] = 3;
	const rootOffset = 127;
	const metaOffset = rootOffset + root.length;
	const leafOffset = metaOffset + meta.length;
	const dataOffset = leafOffset;
	const put = (o: number, v: number) => h.writeBigUInt64LE(BigInt(v), o);
	put(8, rootOffset);
	put(16, root.length);
	put(24, metaOffset);
	put(32, meta.length);
	put(40, leafOffset);
	put(48, 0);
	put(56, dataOffset);
	put(64, data.length);
	put(72, sorted.length);
	put(80, sorted.length);
	put(88, sorted.length);
	h[96] = 1; // clustered
	h[97] = COMPRESSION_GZIP;
	h[98] = COMPRESSION_NONE;
	h[99] = opts.tileType;
	h[100] = Math.min(...sorted.map((t) => t.z));
	h[101] = Math.max(...sorted.map((t) => t.z));
	const [w, s, e, n] = opts.bounds;
	h.writeInt32LE(Math.round(w * 1e7), 102);
	h.writeInt32LE(Math.round(s * 1e7), 106);
	h.writeInt32LE(Math.round(e * 1e7), 110);
	h.writeInt32LE(Math.round(n * 1e7), 114);
	h[118] = h[101]!;
	h.writeInt32LE(Math.round(((w + e) / 2) * 1e7), 119);
	h.writeInt32LE(Math.round(((s + n) / 2) * 1e7), 123);
	return Buffer.concat([h, root, meta, data]);
}
