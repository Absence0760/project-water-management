// Spike #604 Round 0, check 5. Run outside the repo with zarrita@0.7.5, @zarrita/storage@0.2.0, numcodecs@0.3.2 (exact pins) in Node 24:
//   node read.mjs <store.zarr>   reads write_zarr.py output; NODE_GZIP=1 also writes, through the node:zlib codec below
// Reads zarr-python's D2 arrays with zarrita (exact pin) and checks float32 bits; then writes with zarrita for Python to read back.
import * as zarr from 'zarrita';
import FileSystemStore from '@zarrita/storage/fs';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
// zarrita 0.7.5's gzip codec decodes only (encode throws UnsupportedError): register a node:zlib one for writing.
class NodeGzip { kind = 'bytes_to_bytes'; constructor(level) { this.level = level ?? 6; } static fromConfig(c) { return new NodeGzip(c?.level); }
	encode(b) { return new Uint8Array(gzipSync(b, { level: this.level })); } decode(b) { return new Uint8Array(gunzipSync(b)); } }
if (process.env.NODE_GZIP === '1') zarr.registry.set('gzip', async () => NodeGzip);
const dir = process.argv[2];
const exp = JSON.parse(readFileSync(dir + '.expect.json', 'utf8'));
const store = new FileSystemStore(dir);
const root = zarr.root(store);
const bits = (f) => Array.from(new Uint32Array(new Float32Array(f).buffer));
let ok = 0, bad = 0;
const rnl = await zarr.open.v3(root.resolve('rnl'), { kind: 'array' });
const prelim = await zarr.open.v3(root.resolve('prelim'), { kind: 'array' });
console.log('rnl', rnl.shape, rnl.chunks, rnl.dtype, '| prelim', prelim.shape, prelim.chunks);
let t = performance.now();
for (const p of exp.probes) {
	const fin = await zarr.get(rnl, [1, zarr.slice(exp.d0, exp.d0 + 30), p.y, p.x]);
	const day = await zarr.get(prelim, [null, p.y, p.x]);
	const a = bits(fin.data), b = bits(day.data);
	const same = a.every((v, i) => v === p.bits[i]) && b.every((v, i) => v === p.bits[i]);
	same ? ok++ : bad++;
	console.log('probe', p.y, p.x, same ? 'bit-equal' : 'DIFFERS', Number.isNaN(fin.data[0]) ? '(NaN: sea)' : fin.data[0]);
}
// A missing chunk (year 0 never written: zarr-python skips all-fill chunks) reads as the fill value.
const empty = await zarr.get(rnl, [0, zarr.slice(0, 366), 31, 177]);
console.log('unwritten year reads as fill NaN:', Array.from(empty.data).every(Number.isNaN));
// A 10x10-cell block, whole year: the D3 "one year per job" read.
const block = await zarr.get(rnl, [1, null, zarr.slice(25, 35), zarr.slice(170, 180)]);
console.log('block', block.shape, 'in', (performance.now() - t).toFixed(0), 'ms');
// Write side (R1-C): zarrita creates a D2 finals array and sets one chunk.
const w = await zarr.create(root.resolve('node_written'), { shape: [1, 366, 40, 40], chunkShape: [1, 366, 20, 20], dtype: 'float32', fillValue: NaN, dimensionNames: ['year', 'doy', 'lat', 'lon'], codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'gzip', configuration: { level: 6 } }] });
const vals = new Float32Array(366 * 20 * 20).map((_, i) => (i % 97) / 7);
await zarr.set(w, [0, null, zarr.slice(0, 20), zarr.slice(0, 20)], { data: vals, shape: [366, 20, 20], stride: [400, 20, 1] });
console.log('zarrita wrote node_written; checks', ok, 'ok', bad, 'bad');
process.exit(bad ? 1 : 0);
