// The cross-language round trip (issue #604 R2-A): read a copy the Python
// ingest wrote with the Node reader the app uses (backend/src/mirror/), and
// compare it bit for bit with the values the Python side decoded from the
// NetCDF. Run by ingest/test_roundtrip.py, which writes the copy and the
// expected values and checks what this prints:
//
//   backend/node_modules/.bin/tsx ingest/tests/roundtrip.ts <MIRROR_URL> <spec.json>
//
// spec.json: { product, months: [{ url, year, doy0, doy1, values: "<file of float32 LE, (day, lat, lon) C order>" }] }
// Prints JSON: { manifest: {revision, finalThrough, years, changes, files: [{url, valuesSha256}]},
//                months: [{ url, mismatches, firstMismatch, nodeSha256 }] }
// and exits 1 when any value differs.
//
// The 0.1° products (issue #604 R4: `era5l`, `imerg_late`) go through the
// app's cell reader instead, readCells, at known cells and days:
//
// spec.json: { mode: "cells", product, window: {start, end}, cells: [{ y, x }] }   (y, x: the mirror's 0.1° row and column)
// Prints JSON: { manifest: {revision, finalThrough, prelimThrough, years, files: [{url, valuesSha256, version?}]},
//                read, values: [[bits | null | -1 per day] per cell], versions? }
// (readCells' answer: each value the stored float32's bits, -1 for NaN, null for a day not read.)
//
// The reference evaporation products (issue #604 R5-E: `agera5_et0` finals,
// `power_et0` daily, both 0.1°) are read whole, a region block per file, on
// their own grid (openFinals + readFinalsBlock, or openDaily + readDailyBlock):
//
// spec.json: { mode: "blocks", product, files: [{ url, start, days, values: "<file of float32 LE, (day, lat, lon) C order>" }] }
// Prints JSON: { manifest: {revision, finalThrough, prelimThrough, years, files: [{url, valuesSha256}]},
//                files: [{ url, mismatches, firstMismatch, nodeSha256 }] }
// and exits 1 when any value differs. A file's days lie in one year.
import { readFileSync } from 'node:fs';
import { type DailyProduct, openDaily, openFinals, readDailyBlock, readFinalsBlock, type FinalsProduct, type MirrorProduct } from '../../backend/src/mirror/arrays.js';
import { chcCellOf, dayIndex, doyIndex, regionSize, MIRROR_REGION, productGrid, productStep } from '../../backend/src/mirror/grid.js';
import { manifestHash, readManifest } from '../../backend/src/mirror/manifest.js';
import { type CellsProduct, readCells } from '../../backend/src/mirror/readCells.js';
import { openStore } from '../../backend/src/mirror/store.js';

interface Spec {
	product: FinalsProduct;
	months: { url: string; year: number; doy0: number; doy1: number; values: string }[];
}
interface CellsSpec {
	mode: 'cells';
	product: CellsProduct;
	window: { start: string; end: string };
	cells: { y: number; x: number }[];
}

const [url, specPath] = process.argv.slice(2);
if (!url || !specPath) {
	console.error('usage: roundtrip.ts <MIRROR_URL> <spec.json>');
	process.exit(2);
}
interface BlocksSpec {
	mode: 'blocks';
	product: MirrorProduct;
	files: { url: string; start: string; days: number; values: string }[];
}

const raw = JSON.parse(readFileSync(specPath, 'utf8')) as Spec | CellsSpec | BlocksSpec;
const store = openStore(url);

/** Compare a block read back with the expected float32 bits; the mismatch count, the first, and Node's hash of the block's days. */
function compare(values: Float32Array, days: number, expectedFile: string, plane: number) {
	const buf = readFileSync(expectedFile);
	const expected = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
	const actual = new Uint32Array(values.buffer, values.byteOffset, values.length);
	let mismatches = 0;
	let firstMismatch: number | null = null;
	if (expected.length !== actual.length) mismatches = Math.max(expected.length, actual.length);
	else
		for (let i = 0; i < actual.length; i++) {
			if (actual[i] !== expected[i]) {
				mismatches++;
				firstMismatch ??= i;
			}
		}
	const slices = Array.from({ length: days }, (_, d) => values.subarray(d * plane, (d + 1) * plane));
	return { mismatches, firstMismatch, nodeSha256: manifestHash(slices) };
}

if ('mode' in raw && raw.mode === 'blocks') {
	const m = await readManifest(store, raw.product);
	const g = productGrid(raw.product);
	if (!m || !g) throw new Error(`the copy at ${url} has no ${raw.product} manifest`);
	const { rows, cols } = regionSize(MIRROR_REGION, g.step);
	const block = { y0: 0, x0: 0, h: rows, w: cols };
	const finals = g.kind === 'finals' ? await openFinals(store, raw.product as FinalsProduct) : null;
	const daily = g.kind === 'daily' ? await openDaily(store, raw.product as DailyProduct) : null;
	if (!finals && !daily) throw new Error(`the copy at ${url} has no ${raw.product} array`);
	let failed = false;
	const files = [];
	for (const f of raw.files) {
		const last = new Date(Date.parse(f.start) + (f.days - 1) * 86_400_000).toISOString().slice(0, 10);
		const got = finals
			? await readFinalsBlock(finals, Number(f.start.slice(0, 4)), doyIndex(f.start), doyIndex(last), block)
			: await readDailyBlock(daily!, dayIndex(daily!.firstDay, f.start), dayIndex(daily!.firstDay, last), block);
		const r = compare(got.values, got.days, f.values, rows * cols);
		if (r.mismatches > 0) failed = true;
		files.push({ url: f.url, ...r });
	}
	console.log(
		JSON.stringify({
			manifest: { revision: m.revision, finalThrough: m.finalThrough, prelimThrough: m.prelimThrough, years: m.years, files: m.files.map((f) => ({ url: f.url, valuesSha256: f.valuesSha256 })) },
			files
		})
	);
	process.exit(failed ? 1 : 0);
}

if ('mode' in raw && raw.mode === 'cells') {
	const m = await readManifest(store, raw.product);
	if (!m) throw new Error(`the copy at ${url} has no ${raw.product} manifest`);
	const step = productStep(raw.product);
	const got = await readCells(store, raw.product, raw.cells.map((c) => chcCellOf(c, MIRROR_REGION, step)), raw.window);
	console.log(
		JSON.stringify({
			manifest: {
				revision: m.revision,
				finalThrough: m.finalThrough,
				prelimThrough: m.prelimThrough,
				years: m.years,
				files: m.files.map((f) => ({ url: f.url, valuesSha256: f.valuesSha256, ...(f.version ? { version: f.version } : {}) }))
			},
			read: got.cells.read,
			values: got.cells.values,
			...(got.versions ? { versions: got.versions } : {})
		})
	);
	process.exit(0);
}
const spec = raw as Spec;
const manifest = await readManifest(store, spec.product);
const finals = await openFinals(store, spec.product);
if (!manifest || !finals) throw new Error(`the copy at ${url} has no ${spec.product}`);

const { rows, cols } = regionSize(MIRROR_REGION);
let failed = false;
const months = [];
for (const m of spec.months) {
	const got = await readFinalsBlock(finals, m.year, m.doy0, m.doy1, { y0: 0, x0: 0, h: rows, w: cols });
	const buf = readFileSync(m.values);
	const expected = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
	const actual = new Uint32Array(got.values.buffer, got.values.byteOffset, got.values.length);
	let mismatches = 0;
	let firstMismatch: number | null = null;
	if (expected.length !== actual.length) {
		mismatches = Math.max(expected.length, actual.length);
	} else {
		for (let i = 0; i < actual.length; i++) {
			if (actual[i] !== expected[i]) {
				mismatches++;
				firstMismatch ??= i;
			}
		}
	}
	if (mismatches > 0) failed = true;
	const plane = rows * cols;
	const days = Array.from({ length: got.days }, (_, d) => got.values.subarray(d * plane, (d + 1) * plane));
	months.push({ url: m.url, mismatches, firstMismatch, nodeSha256: manifestHash(days) });
}

console.log(
	JSON.stringify({
		manifest: {
			revision: manifest.revision,
			finalThrough: manifest.finalThrough,
			years: manifest.years,
			changes: manifest.changes,
			files: manifest.files.map((f) => ({ url: f.url, valuesSha256: f.valuesSha256 }))
		},
		months
	})
);
process.exit(failed ? 1 : 0);
