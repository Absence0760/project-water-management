// The synthetic files laid out as the real ones (cogLayouts.ts) hold the
// real headers' tags, and the production CogAccepts read them: the reader is
// held to what FAO and DE Africa publish, not only to what cogWrite.ts writes
// by default. Invented samples only.
import { describe, expect, it } from 'vitest';
import { S1_MASK_ACCEPT, S1_VV_ACCEPT } from '../dams/observed/sentinel/s1.js';
import { S2_BAND_ACCEPT, S2_SCL_ACCEPT } from '../dams/observed/sentinel/s2.js';
import { WAPOR_ACCEPT, WAPOR_SCALE } from '../water-use/observed/wapor.js';
import { isNodata, openCog, readWindow, type CogAccept, type Samples } from './cog.js';
import { REAL_HEADERS, S1_MASK_LAYOUT, S1_VV_LAYOUT, s2BandLayout, s2SclLayout, WAPOR_LAYOUT, type CogLayout, type RealHeader } from './cogLayouts.js';
import { writeCog } from './cogWrite.js';

/** Every IFD's tag → type map, by walking the chain from the header (classic or BigTIFF, little-endian). */
function ifdChain(bytes: Uint8Array): Record<number, number>[] {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const big = v.getUint16(2, true) === 43;
	const out: Record<number, number>[] = [];
	let at = big ? Number(v.getBigUint64(8, true)) : v.getUint32(4, true);
	while (at !== 0 && out.length < 32) {
		const n = big ? Number(v.getBigUint64(at, true)) : v.getUint16(at, true);
		const first = at + (big ? 8 : 2);
		const size = big ? 20 : 12;
		const tags: Record<number, number> = {};
		for (let i = 0; i < n; i++) tags[v.getUint16(first + i * size, true)] = v.getUint16(first + i * size + 2, true);
		out.push(tags);
		const next = first + n * size;
		at = big ? Number(v.getBigUint64(next, true)) : v.getUint32(next, true);
	}
	return out;
}

/** Invented samples: a ramp, with a run of no-data. */
function samples(kind: RealHeader['sampleType'], n: number, nodata: number): Samples {
	const out = kind === 'int16' ? new Int16Array(n) : kind === 'uint8' ? new Uint8Array(n) : kind === 'uint16' ? new Uint16Array(n) : new Float32Array(n);
	for (let i = 0; i < n; i++) {
		if (i % 97 < 5) out[i] = nodata;
		else if (kind === 'float32') out[i] = 0.001 + (i % 400) / 1000;
		else if (kind === 'uint8') out[i] = 1 + (i % 2);
		else out[i] = 1000 + (i % 3000);
	}
	return out;
}

interface Case {
	name: keyof typeof REAL_HEADERS;
	layout: CogLayout;
	accept: CogAccept;
	epsg: number;
	originX: number;
	originY: number;
	pixelSize: number;
	width: number;
	height: number;
}

const CASES: Case[] = [
	{ name: 'wapor', layout: WAPOR_LAYOUT, accept: WAPOR_ACCEPT, epsg: 4326, originX: 20, originY: -33, pixelSize: 1 / 1024, width: 600, height: 530 },
	{ name: 's1Vv', layout: S1_VV_LAYOUT, accept: S1_VV_ACCEPT, epsg: 4326, originX: 19, originY: -34, pixelSize: 0.0002, width: 300, height: 280 },
	{ name: 's1Mask', layout: S1_MASK_LAYOUT, accept: S1_MASK_ACCEPT, epsg: 4326, originX: 19, originY: -34, pixelSize: 0.0002, width: 300, height: 280 },
	{ name: 's2Green', layout: s2BandLayout(32734), accept: S2_BAND_ACCEPT, epsg: 32734, originX: 300000, originY: 6300040, pixelSize: 10, width: 1100, height: 1040 },
	{ name: 's2Swir16', layout: s2BandLayout(32734, 512), accept: S2_BAND_ACCEPT, epsg: 32734, originX: 300000, originY: 6300040, pixelSize: 20, width: 550, height: 520 },
	{ name: 's2Scl', layout: s2SclLayout(32734), accept: S2_SCL_ACCEPT, epsg: 32734, originX: 300000, originY: 6300040, pixelSize: 20, width: 550, height: 520 }
];

describe.each(CASES)('a synthetic $name file in the real layout', (c) => {
	const real: RealHeader = REAL_HEADERS[c.name];
	const values = samples(real.sampleType, c.width * c.height, real.nodata);
	const bytes = writeCog({ ...c.layout, width: c.width, height: c.height, values, epsg: c.epsg, originX: c.originX, originY: c.originY, pixelSize: c.pixelSize, overviews: real.ifds - 1 });
	const read = async (a: number, b: number) => bytes.subarray(a, b + 1);

	it('holds the real header’s tags, of the same types, and as many IFDs', () => {
		const chain = ifdChain(bytes);
		expect(chain[0]).toEqual(real.tags);
		expect(chain).toHaveLength(real.ifds);
		// The overviews say so (NewSubfileType 1); the full image doesn't.
		expect(chain.slice(1).every((t) => 254 in t)).toBe(true);
		expect(new TextDecoder().decode(bytes.subarray(real.bigTiff ? 16 : 8, real.bigTiff ? 59 : 51))).toBe('GDAL_STRUCTURAL_METADATA_SIZE=000140 bytes\n');
	});

	it('opens through the production CogAccept as the real file did', async () => {
		const cog = (await openCog(read, c.accept))!;
		expect(cog).toMatchObject({
			bigTiff: real.bigTiff,
			sampleType: real.sampleType,
			compression: real.compression,
			predictor: real.predictor,
			tileWidth: real.tile,
			tileHeight: real.tile,
			epsg: c.epsg,
			crs: c.epsg === 4326 ? 'geographic' : 'utm',
			originX: c.originX,
			originY: c.originY,
			scale: real.scale,
			offset: real.offset
		});
		expect(cog.pixelSizeX).toBeCloseTo(c.pixelSize, 12);
		expect(isNodata(cog, real.nodata)).toBe(true);
	});

	it('reads a window across tiles back to the invented samples', async () => {
		const cog = (await openCog(read, c.accept))!;
		const win = { col0: real.tile - 7, row0: Math.min(c.height - 9, real.tile - 3), col1: real.tile + 8, row1: c.height - 1 };
		const got = await readWindow(read, cog, win);
		const w = win.col1 - win.col0 + 1;
		for (let r = win.row0; r <= win.row1; r++) {
			for (let col = win.col0; col <= win.col1; col++) {
				const want = values[r * c.width + col]!;
				const v = got[(r - win.row0) * w + (col - win.col0)]!;
				if (Number.isNaN(want)) expect(v).toBeNaN();
				else expect(v).toBe(want);
			}
		}
	});
});

describe('what the real layouts mean for the passes', () => {
	it('the WaPOR file’s band scale is the one the pass expects', () => {
		expect(REAL_HEADERS.wapor.scale).toBe(WAPOR_SCALE);
		expect(WAPOR_LAYOUT.scaleOffset).toEqual({ scale: WAPOR_SCALE, offset: 0 });
	});

	it('an S2 band’s own GDAL scale and offset is the item’s −1000 DN offset at 1e-4 a DN', () => {
		const { scale, offset } = REAL_HEADERS.s2Green;
		// DN 1000 is zero reflectance either way; DN 2500 is 0.15.
		expect(1000 * scale + offset).toBeCloseTo(0, 12);
		expect(2500 * scale + offset).toBeCloseTo((2500 - 1000) * 1e-4, 12);
	});

	it('the default cogWrite layout is still read where the real ones differ', async () => {
		// The WOfS layout the reader was first checked against (no ghost, planar 1, 512 tiles) is unchanged.
		const bytes = writeCog({ width: 40, height: 40, values: new Uint8Array(1600), epsg: 32734, originX: 0, originY: 0 });
		expect(ifdChain(bytes)).toHaveLength(1);
		expect((await openCog(async (a, b) => bytes.subarray(a, b + 1)))!.tileWidth).toBe(512);
	});
});
