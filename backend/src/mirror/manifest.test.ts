import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { type Manifest, manifestHash, MirrorManifestError, parseManifest, readManifest, writeManifest } from './manifest.js';
import { openStore } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'mirror-manifest-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sample = (): Manifest => ({
	product: 'rnl',
	revision: 2,
	region: { w: 10, s: -35.5, e: 41, n: -8 },
	grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.05 },
	years: { first: 1981, last: 2026 },
	finalThrough: '2026-09-30',
	prelimThrough: null,
	files: [
		{
			url: 'https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/rnl/netcdf/byMonth/chirps-v3.0.2024.06.days_p05.nc',
			etag: '"abc-123"',
			lastModified: 'Tue, 05 Aug 2026 10:00:00 GMT',
			size: 362853441,
			valuesSha256: 'a'.repeat(64),
			revision: 2,
			fetchedAt: '2026-10-27T03:00:00.000Z'
		}
	],
	changes: [{ revision: 2, days: ['2024-06-01', '2024-06-30'], cellsChanged: 12, maxAbsDiff: 0.25 }]
});

describe('the manifest', () => {
	it('round-trips through the store', async () => {
		const store = openStore(pathToFileURL(dir).href);
		expect(await readManifest(store, 'rnl')).toBeNull();
		await writeManifest(store, sample());
		expect(await readManifest(store, 'rnl')).toEqual(sample());
	});

	it('refuses each kind of bad manifest, naming the field', () => {
		const bad: [string, (m: Manifest) => unknown, RegExp][] = [
			['an unknown product', (m) => ({ ...m, product: 'gefs/latest' }), /product/],
			['revision 0', (m) => ({ ...m, revision: 0 }), /revision/],
			['a missing field', (m) => ({ ...m, finalThrough: undefined }), /finalThrough/],
			['an extra field', (m) => ({ ...m, extra: 1 }), /extra|Unrecognized/i],
			['a bad date', (m) => ({ ...m, finalThrough: '2026-02-30' }), /finalThrough/],
			['another step', (m) => ({ ...m, grid: { ...m.grid, step: 0.1 } }), /grid\.step/],
			['an origin off the region', (m) => ({ ...m, grid: { ...m.grid, origin: { lat: -35.5, lon: 10 } } }), /south-west cell/],
			['an upside-down region', (m) => ({ ...m, region: { ...m.region, s: -5 } }), /region/],
			['a file from a later revision', (m) => ({ ...m, files: [{ ...m.files[0]!, revision: 3 }] }), /later revision/],
			['a bad hash', (m) => ({ ...m, files: [{ ...m.files[0]!, valuesSha256: 'A'.repeat(64) }] }), /valuesSha256/],
			['a local fetchedAt', (m) => ({ ...m, files: [{ ...m.files[0]!, fetchedAt: '2026-10-27T03:00:00+02:00' }] }), /fetchedAt/],
			['a file twice', (m) => ({ ...m, files: [m.files[0]!, m.files[0]!] }), /twice/],
			['days backwards', (m) => ({ ...m, changes: [{ ...m.changes[0]!, days: ['2024-06-30', '2024-06-01'] }] }), /days/],
			['a negative diff', (m) => ({ ...m, changes: [{ ...m.changes[0]!, maxAbsDiff: -1 }] }), /maxAbsDiff/],
			['rnl prelim days', (m) => ({ ...m, prelimThrough: '2026-10-01' }), /rnl has no preliminary/],
			['finalThrough outside years', (m) => ({ ...m, finalThrough: '1975-01-01' }), /outside years/],
			['finals in a daily product', (m) => ({ ...m, product: 'prelim' }), /prelim holds no final days/]
		];
		for (const [what, change, msg] of bad) {
			expect(() => parseManifest(change(sample())), what).toThrow(MirrorManifestError);
			expect(() => parseManifest(change(sample())), what).toThrow(msg);
		}
		// Positive control: the sample itself, and a daily product's shape.
		expect(() => parseManifest(sample())).not.toThrow();
		expect(() => parseManifest({ ...sample(), product: 'gefs/2026-10-27', finalThrough: null, prelimThrough: '2026-10-27', changes: [] })).not.toThrow();
	});

	it('refuses a manifest stored under another product, or not JSON', async () => {
		const store = openStore(pathToFileURL(dir).href);
		await store.set('/sat/manifest.json', new TextEncoder().encode(JSON.stringify(sample())));
		await expect(readManifest(store, 'sat')).rejects.toThrow(/at sat names product rnl/);
		await store.set('/prelim/manifest.json', new TextEncoder().encode('{'));
		await expect(readManifest(store, 'prelim')).rejects.toThrow(/not valid JSON/);
	});

	it('refuses to write an invalid manifest', async () => {
		const store = openStore(pathToFileURL(dir).href);
		await expect(writeManifest(store, { ...sample(), revision: -1 })).rejects.toThrow(MirrorManifestError);
	});
});

describe('manifestHash (valuesSha256)', () => {
	it('hashes float32 little-endian bytes in order, every NaN as 0x7FC00000', () => {
		const day = Float32Array.of(1.5, Number.NaN, 0, -0);
		new Uint32Array(day.buffer)[1] = 0xffc12345; // a NaN with sign and payload
		const bytes = Buffer.alloc(16);
		bytes.writeFloatLE(1.5, 0);
		bytes.writeUInt32LE(0x7fc00000, 4);
		bytes.writeFloatLE(0, 8);
		bytes.writeUInt32LE(0x80000000, 12);
		expect(manifestHash([day])).toBe(createHash('sha256').update(bytes).digest('hex'));
		// The days are concatenated: two days hash as one buffer of both.
		expect(manifestHash([day.subarray(0, 2), day.subarray(2)])).toBe(manifestHash([day]));
		// It never changes its input.
		expect(new Uint32Array(day.buffer)[1]).toBe(0xffc12345);
	});
});
