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
import { readFileSync } from 'node:fs';
import { openFinals, readFinalsBlock, type FinalsProduct } from '../../backend/src/mirror/arrays.js';
import { regionSize, MIRROR_REGION } from '../../backend/src/mirror/grid.js';
import { manifestHash, readManifest } from '../../backend/src/mirror/manifest.js';
import { openStore } from '../../backend/src/mirror/store.js';

interface Spec {
	product: FinalsProduct;
	months: { url: string; year: number; doy0: number; doy1: number; values: string }[];
}

const [url, specPath] = process.argv.slice(2);
if (!url || !specPath) {
	console.error('usage: roundtrip.ts <MIRROR_URL> <spec.json>');
	process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
const store = openStore(url);
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
