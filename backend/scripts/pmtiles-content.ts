// Compares two PMTiles archives by what they hold, not by their bytes: the
// fixture tests (dem-fixture.test.ts, water-fixture.test.ts) check that the
// committed synthetic rasters are what their generators describe. A byte
// comparison also checked zlib's output, which isn't the fixture's content:
// the gzip header's OS byte differed on macOS, and another zlib build may
// deflate the same pixels differently. This decodes each archive with the
// app's own readers (the ones delineation and tracing a dam use) and lists
// every difference in the header's fields, the metadata, the directory and
// each tile's decoded pixels; an empty list means the same content.
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { parseDirectory, parseHeader, type Entry } from '../src/delineation/pmtiles.js';
import { decodePng } from '../src/delineation/png.js';

/**
 * Header byte ranges that hold content: the magic and version, the root's
 * offset, the leaf length, the tile counts, clustering, compression, tile
 * type, zooms, bounds and centre. The rest (lengths and offsets of the
 * gzip parts and the tile data) follow from the compressed sizes.
 */
const CONTENT_HEADER = [
	[0, 16],
	[48, 56],
	[72, 127]
] as const;

const GZIP = 2;

function decoded(archive: Uint8Array) {
	const header = parseHeader(archive);
	if (header.internalCompression !== GZIP) throw new Error(`internal compression ${header.internalCompression} (the fixtures write gzip)`);
	if (header.tileType !== 2) throw new Error(`tile type ${header.tileType} (the fixtures write PNG)`);
	const part = (o: number, l: number) => archive.subarray(o, o + l);
	const entries: Entry[] = parseDirectory(gunzipSync(part(header.rootOffset, header.rootLength)));
	const metadata = JSON.parse(gunzipSync(part(header.metadataOffset, header.metadataLength)).toString('utf8')) as unknown;
	const tile = (e: Entry) => decodePng(part(header.tileDataOffset + e.offset, e.length));
	return { entries, metadata, tile };
}

/** Every way `actual` holds different content from `expected` (empty: the same). */
export function archiveDifferences(expected: Uint8Array, actual: Uint8Array): string[] {
	const out: string[] = [];
	for (const [from, to] of CONTENT_HEADER) {
		for (let i = from; i < to; i++) {
			if (expected[i] !== actual[i]) {
				out.push(`header byte ${i}: ${actual[i]}, expected ${expected[i]}`);
				break;
			}
		}
	}
	if (out.length) return out;
	const e = decoded(expected);
	const a = decoded(actual);
	if (!isDeepStrictEqual(e.metadata, a.metadata)) out.push(`metadata ${JSON.stringify(a.metadata)}, expected ${JSON.stringify(e.metadata)}`);
	const ids = (d: typeof e) => d.entries.map((x) => `${x.tileId}×${x.runLength}`).join(' ');
	if (ids(e) !== ids(a)) return [...out, `directory ${ids(a)}, expected ${ids(e)}`];
	e.entries.forEach((entry, i) => {
		const want = e.tile(entry);
		const got = a.tile(a.entries[i]!);
		if (want.width !== got.width || want.height !== got.height) {
			out.push(`tile ${entry.tileId}: ${got.width} × ${got.height} px, expected ${want.width} × ${want.height}`);
			return;
		}
		const at = want.argb.findIndex((p, j) => p !== got.argb[j]);
		if (at >= 0) {
			const n = want.argb.reduce((c, p, j) => c + (p !== got.argb[j] ? 1 : 0), 0);
			const hex = (p: number) => p.toString(16).padStart(8, '0');
			out.push(`tile ${entry.tileId}: ${n} pixel(s) differ, first at (${at % want.width}, ${Math.floor(at / want.width)}): ${hex(got.argb[at]!)}, expected ${hex(want.argb[at]!)}`);
		}
	});
	return out;
}
