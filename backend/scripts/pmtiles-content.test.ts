import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { writePmtiles } from '../src/delineation/pmtiles.js';
import { encodePng } from '../src/delineation/png.js';
import { archiveDifferences } from './pmtiles-content.js';

/** A 4 × 4 PNG of a gradient, `bump` added to one pixel. */
const png = (bump = 0) => {
	const argb = new Uint32Array(16).map((_, i) => (0xff000000 | (i * 9 + (i === 5 ? bump : 0))) >>> 0);
	return encodePng({ width: 4, height: 4, argb });
};

/** The same PNG with its image data deflated again at `level`: other bytes, the same pixels. */
function recompressed(p: Buffer, level: number): Buffer {
	const ihdr = p.subarray(8, 33);
	const idatLength = p.readUInt32BE(33);
	const raw = inflateSync(p.subarray(41, 41 + idatLength));
	const data = deflateSync(raw, { level });
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write('IDAT', 4, 'latin1');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([p.subarray(0, 8), ihdr, head, data, crc, p.subarray(41 + idatLength + 4)]);
}

const archive = (tiles: Buffer[], metadata: Record<string, unknown> = { name: 'x' }) =>
	writePmtiles(
		tiles.map((data, i) => ({ z: 10, x: 570 + i, y: 612, data })),
		{ tileType: 2, bounds: [20, -34, 21, -33], metadata }
	);

describe('archiveDifferences', () => {
	const base = archive([png(), png()]);

	it('ignores how the parts were compressed: other deflate output, or the gzip header naming another OS', () => {
		const other = recompressed(png(), 1);
		expect(Buffer.compare(other, png())).not.toBe(0);
		expect(archiveDifferences(base, archive([other, png()]))).toEqual([]);
		const mac = Buffer.from(base);
		mac[127 + 9] = 19;
		expect(archiveDifferences(base, mac)).toEqual([]);
	});

	it('reports a changed pixel, with its tile and position', () => {
		expect(archiveDifferences(base, archive([png(), png(1)]))).toEqual([expect.stringMatching(/^tile \d+: 1 pixel\(s\) differ, first at \(1, 1\): ff00002e, expected ff00002d$/)]);
	});

	it('reports changed metadata, a changed directory and a changed header', () => {
		expect(archiveDifferences(base, archive([png(), png()], { name: 'y' }))).toEqual([expect.stringMatching(/^metadata/)]);
		expect(archiveDifferences(base, writePmtiles([{ z: 10, x: 570, y: 612, data: png() }, { z: 10, x: 570, y: 613, data: png() }], { tileType: 2, bounds: [20, -34, 21, -33], metadata: { name: 'x' } }))).toEqual([expect.stringMatching(/^directory/)]);
		expect(archiveDifferences(base, archive([png()]))).toEqual([expect.stringMatching(/^header byte 72/)]);
	});
});
