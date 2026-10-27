// The mirror's two D2 array layouts (issue #604), read and written with
// zarrita. Both are Zarr v3, float32, fill NaN (sea or no data; CHC's -9999
// becomes NaN), codecs bytes (little-endian) then gzip 6, default chunk keys
// with "/". A chunk never written is all fill: zarr-python skips writing
// all-NaN chunks, so a reader treats a missing chunk as NaN (zarrita does).
//
//   finals (`rnl`, `sat`, `era5l`): (year, doy[366], lat, lon), chunk
//     (1, 366, 20, 20) on either grid. year index = year − attrs.firstYear;
//     doy index = days since 1 January, so index 365 stays NaN in a year with
//     no 29 February.
//   daily (`prelim`, `imerg_late`, `gefs/<issue>`): (day, lat, lon), chunk
//     (1, 110, 124) on the 0.05° grid and (1, 55, 62) on the 0.1° grid: 25
//     chunks a day either way. day index = days since attrs.firstDay.
//
// Both carry attrs.region {w,s,e,n} and attrs.grid {origin {lat, lon}, step},
// the step the product's (grid.ts PRODUCT_GRIDS): an array on another grid is
// refused. era5l's year axis starts in 1950, and its array may carry
// attrs.attribution, Copernicus's credit (a string); no other array may.
import type { AbsolutePath } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { FeedFormatError } from '../feeds/errors.js';
import { gridOf, isLeapYear, MIRROR_REGION, type MirrorGrid, PRODUCT_GRIDS, productStep, type Region, regionSize } from './grid.js';
import { type MirrorStore, registerNodeGzip } from './store.js';

export const FINALS_CHUNK = [1, 366, 20, 20] as const;
/** The daily layout's chunk on CHC's 0.05° grid. */
export const DAILY_CHUNK = [1, 110, 124] as const;
/** The daily layout's chunk on the 0.1° grid: the same 25 chunks a day. */
export const DAILY_CHUNK_P1 = [1, 55, 62] as const;
/** The daily layout's chunk for a grid step. */
export const dailyChunk = (step: number): readonly [1, number, number] => (step === 0.1 ? DAILY_CHUNK_P1 : DAILY_CHUNK);
export const FINALS_DIMS = ['year', 'doy', 'lat', 'lon'];
export const DAILY_DIMS = ['day', 'lat', 'lon'];
export const CODECS = [
	{ name: 'bytes', configuration: { endian: 'little' } },
	{ name: 'gzip', configuration: { level: 6 } }
];
/** The CHIRPS finals' first year: rnl's, 1981 (sat's year axis starts there too, its years before 1998 unwritten). */
export const FINALS_FIRST_YEAR = 1981;

/** The products each layout holds, as the store's paths name them. */
export type ChcFinalsProduct = 'rnl' | 'sat';
export type FinalsProduct = ChcFinalsProduct | 'era5l';
export type DailyProduct = 'prelim' | 'imerg_late' | `gefs/${string}`;
export type MirrorProduct = FinalsProduct | DailyProduct;
export const PRODUCT_RE = /^(rnl|sat|prelim|era5l|imerg_late|gefs\/\d{4}-\d{2}-\d{2})$/;

/** The mirror's array is missing or isn't laid out as D2 says. */
export class MirrorFormatError extends FeedFormatError {}

export type MirrorArray = zarr.Array<'float32', MirrorStore>;

export interface FinalsArray {
	kind: 'finals';
	arr: MirrorArray;
	firstYear: number;
	region: Region;
	grid: MirrorGrid;
}
export interface DailyArray {
	kind: 'daily';
	arr: MirrorArray;
	firstDay: string;
	region: Region;
	grid: MirrorGrid;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const path = (p: string) => `/${p}` as AbsolutePath;

/** The attributes every array carries for its region, on its product's grid. */
const regionAttrs = (region: Region, step: number) => ({ region: { ...region }, grid: gridOf(region, step) });

async function readJson(store: MirrorStore, key: string): Promise<unknown> {
	const bytes = await store.get(path(key));
	if (bytes === undefined) return undefined;
	try {
		return JSON.parse(dec.decode(bytes));
	} catch {
		throw new MirrorFormatError(`the rain data copy's ${key} is not valid JSON`);
	}
}

/** Make sure the group metadata of the root and of each parent of `product` exists (Zarr v3 has no implicit groups). */
async function ensureGroups(store: MirrorStore, product: string): Promise<void> {
	const parts = product.split('/').slice(0, -1);
	for (let i = 0; i <= parts.length; i++) {
		const dir = parts.slice(0, i).join('/');
		const key = dir ? `${dir}/zarr.json` : 'zarr.json';
		if ((await store.get(path(key))) === undefined) await zarr.create(dir ? zarr.root(store).resolve(dir) : zarr.root(store), { attributes: {} });
	}
}

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Check an opened array against D2: dtype, chunks, dims, codecs, region and grid. */
function checkLayout(arr: MirrorArray, product: string, kind: 'finals' | 'daily', meta: Record<string, unknown>): { region: Region; grid: MirrorGrid } {
	const bad = (what: string) => new MirrorFormatError(`the rain data copy's ${product} array is not laid out as expected (${what})`);
	if (arr.dtype !== 'float32') throw bad(`data type ${arr.dtype}`);
	const step = productStep(product);
	const chunk = kind === 'finals' ? FINALS_CHUNK : dailyChunk(step);
	if (!same(arr.chunks, chunk)) throw bad(`chunks ${arr.chunks.join('×')}`);
	if (!same(arr.dimensionNames ?? [], kind === 'finals' ? FINALS_DIMS : DAILY_DIMS)) throw bad('dimension names');
	if (JSON.stringify(meta.codecs) !== JSON.stringify(CODECS)) throw bad('codecs');
	const fill = arr.fillValue;
	if (typeof fill !== 'number' || !Number.isNaN(fill)) throw bad('fill value');
	const a = arr.attrs as { region?: Region; grid?: MirrorGrid; attribution?: unknown };
	// era5l's ingest keeps Copernicus's credit beside the values (ingest/era5land.py ATTRIBUTION); no other product carries one.
	if ('attribution' in a && (product !== 'era5l' || typeof a.attribution !== 'string' || !a.attribution)) throw bad('attribution');
	const r = a.region;
	if (!r || ![r.w, r.s, r.e, r.n].every(Number.isFinite) || r.w >= r.e || r.s >= r.n) throw bad('region');
	const g = gridOf(r, step);
	if (!a.grid || a.grid.step !== g.step || a.grid.origin?.lat !== g.origin.lat || a.grid.origin?.lon !== g.origin.lon) throw bad('grid');
	const { rows, cols } = regionSize(r, step);
	const shape = arr.shape;
	if (shape.at(-2) !== rows || shape.at(-1) !== cols) throw bad(`shape ${shape.join('×')}`);
	if (kind === 'finals' && shape[1] !== 366) throw bad('day-of-year axis');
	return { region: { w: r.w, s: r.s, e: r.e, n: r.n }, grid: g };
}

/** Open `product`'s finals array, or null when the copy doesn't hold it yet. */
export async function openFinals(store: MirrorStore, product: FinalsProduct): Promise<FinalsArray | null> {
	registerNodeGzip();
	const meta = (await readJson(store, `${product}/zarr.json`)) as Record<string, unknown> | undefined;
	if (meta === undefined) return null;
	const arr = (await zarr.open.v3(zarr.root(store).resolve(product), { kind: 'array' })) as MirrorArray;
	const { region, grid } = checkLayout(arr, product, 'finals', meta);
	const firstYear = (arr.attrs as { firstYear?: unknown }).firstYear;
	if (!Number.isInteger(firstYear)) throw new MirrorFormatError(`the rain data copy's ${product} array has no firstYear`);
	// era5l's year axis starts with its record (1950); a CHIRPS finals array's start is its own attribute.
	if (product === 'era5l' && firstYear !== PRODUCT_GRIDS.era5l.firstYear) throw new MirrorFormatError(`the rain data copy's era5l array starts in ${String(firstYear)}, not ${PRODUCT_GRIDS.era5l.firstYear}`);
	return { kind: 'finals', arr, firstYear: firstYear as number, region, grid };
}

/** Open a daily-layout array, or null when the copy doesn't hold it yet. */
export async function openDaily(store: MirrorStore, product: DailyProduct): Promise<DailyArray | null> {
	registerNodeGzip();
	const meta = (await readJson(store, `${product}/zarr.json`)) as Record<string, unknown> | undefined;
	if (meta === undefined) return null;
	const arr = (await zarr.open.v3(zarr.root(store).resolve(product), { kind: 'array' })) as MirrorArray;
	const { region, grid } = checkLayout(arr, product, 'daily', meta);
	const firstDay = (arr.attrs as { firstDay?: unknown }).firstDay;
	if (typeof firstDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(firstDay)) throw new MirrorFormatError(`the rain data copy's ${product} array has no firstDay`);
	return { kind: 'daily', arr, firstDay, region, grid };
}

/**
 * Grow an array's outer axis to `length` by rewriting its zarr.json shape.
 * Safe because the outer axis is chunked by 1: no chunk moves or changes.
 */
async function growOuter(store: MirrorStore, product: string, length: number): Promise<void> {
	const meta = (await readJson(store, `${product}/zarr.json`)) as { shape: number[] };
	if (meta.shape[0]! >= length) return;
	meta.shape = [length, ...meta.shape.slice(1)];
	await store.set(path(`${product}/zarr.json`), enc.encode(JSON.stringify(meta, null, 2)));
}

/**
 * The finals array of `product` holding years up to `lastYear`: created with
 * the D2 metadata when missing, its year axis grown when shorter.
 */
export async function ensureFinals(
	store: MirrorStore,
	product: FinalsProduct,
	lastYear: number,
	opts: { firstYear?: number; region?: Region } = {}
): Promise<FinalsArray> {
	registerNodeGzip();
	const existing = await openFinals(store, product);
	if (existing) {
		await growOuter(store, product, lastYear - existing.firstYear + 1);
		return (await openFinals(store, product))!;
	}
	const firstYear = opts.firstYear ?? PRODUCT_GRIDS[product].firstYear;
	const region = opts.region ?? MIRROR_REGION;
	const step = productStep(product);
	const { rows, cols } = regionSize(region, step);
	await ensureGroups(store, product);
	await zarr.create(zarr.root(store).resolve(product), {
		shape: [lastYear - firstYear + 1, 366, rows, cols],
		chunkShape: [...FINALS_CHUNK],
		dtype: 'float32',
		fillValue: Number.NaN,
		codecs: CODECS,
		dimensionNames: FINALS_DIMS,
		attributes: { firstYear, ...regionAttrs(region, step) }
	});
	return (await openFinals(store, product))!;
}

/** The daily array of `product` from `firstDay` holding at least `days` days: created when missing, grown when shorter. */
export async function ensureDaily(store: MirrorStore, product: DailyProduct, firstDay: string, days: number, opts: { region?: Region } = {}): Promise<DailyArray> {
	registerNodeGzip();
	const existing = await openDaily(store, product);
	if (existing) {
		if (existing.firstDay !== firstDay) throw new MirrorFormatError(`the rain data copy's ${product} array starts on ${existing.firstDay}, not ${firstDay}`);
		await growOuter(store, product, days);
		return (await openDaily(store, product))!;
	}
	const region = opts.region ?? MIRROR_REGION;
	const step = productStep(product);
	const { rows, cols } = regionSize(region, step);
	await ensureGroups(store, product);
	await zarr.create(zarr.root(store).resolve(product), {
		shape: [days, rows, cols],
		chunkShape: [...dailyChunk(step)],
		dtype: 'float32',
		fillValue: Number.NaN,
		codecs: CODECS,
		dimensionNames: DAILY_DIMS,
		attributes: { firstDay, ...regionAttrs(region, step) }
	});
	return (await openDaily(store, product))!;
}

/** A block of cells: rows y0… (northwards) and columns x0… (eastwards), h × w. */
export interface Block {
	y0: number;
	x0: number;
	h: number;
	w: number;
}

const checkBlock = (b: Block, rows: number, cols: number) => {
	if (b.h < 1 || b.w < 1 || b.y0 < 0 || b.x0 < 0 || b.y0 + b.h > rows || b.x0 + b.w > cols) throw new RangeError('the block is outside the region');
};

/**
 * Write one year of a block of cells into a finals array: `values` in (doy,
 * y, x) C order, 366 days (index 365 must be NaN in a non-leap year).
 */
export async function writeFinalsYear(f: FinalsArray, year: number, block: Block, values: Float32Array): Promise<void> {
	const yi = year - f.firstYear;
	if (yi < 0 || yi >= f.arr.shape[0]!) throw new RangeError(`year ${year} is outside the array (grow it first)`);
	checkBlock(block, f.arr.shape[2]!, f.arr.shape[3]!);
	if (values.length !== 366 * block.h * block.w) throw new RangeError('one value per day of year per cell');
	if (!isLeapYear(year) && !values.subarray(365 * block.h * block.w).every(Number.isNaN)) {
		throw new RangeError(`${year} has no 29 February, so its day-of-year index 365 must stay NaN`);
	}
	await zarr.set(f.arr, [yi, null, zarr.slice(block.y0, block.y0 + block.h), zarr.slice(block.x0, block.x0 + block.w)], {
		data: values,
		shape: [366, block.h, block.w],
		stride: [block.h * block.w, block.w, 1]
	});
}

/** Write days `d0`… of a block into a daily array: `values` in (day, y, x) C order. */
export async function writeDailyDays(d: DailyArray, d0: number, block: Block, values: Float32Array): Promise<void> {
	const days = values.length / (block.h * block.w);
	if (!Number.isInteger(days) || days < 1) throw new RangeError('whole days of values');
	if (d0 < 0 || d0 + days > d.arr.shape[0]!) throw new RangeError('the days are outside the array (grow it first)');
	checkBlock(block, d.arr.shape[1]!, d.arr.shape[2]!);
	await zarr.set(d.arr, [zarr.slice(d0, d0 + days), zarr.slice(block.y0, block.y0 + block.h), zarr.slice(block.x0, block.x0 + block.w)], {
		data: values,
		shape: [days, block.h, block.w],
		stride: [block.h * block.w, block.w, 1]
	});
}

/** A block read back: values in (day, y, x) C order, NaN for no data or an unwritten chunk. */
export interface BlockRead {
	days: number;
	block: Block;
	values: Float32Array;
}

/** Days [doy0, doy1] (inclusive) of `year` for a block of a finals array; all NaN for a year outside the array. */
export async function readFinalsBlock(f: FinalsArray, year: number, doy0: number, doy1: number, block: Block): Promise<BlockRead> {
	const days = doy1 - doy0 + 1;
	if (doy0 < 0 || doy1 > 365 || days < 1) throw new RangeError('day-of-year indices 0–365');
	checkBlock(block, f.arr.shape[2]!, f.arr.shape[3]!);
	const yi = year - f.firstYear;
	if (yi < 0 || yi >= f.arr.shape[0]!) return { days, block, values: new Float32Array(days * block.h * block.w).fill(Number.NaN) };
	const got = await zarr.get(f.arr, [yi, zarr.slice(doy0, doy1 + 1), zarr.slice(block.y0, block.y0 + block.h), zarr.slice(block.x0, block.x0 + block.w)]);
	return { days, block, values: contiguous(got, [days, block.h, block.w]) };
}

/** Days [d0, d1] (inclusive, day indices) for a block of a daily array; NaN for days outside the array. */
export async function readDailyBlock(d: DailyArray, d0: number, d1: number, block: Block): Promise<BlockRead> {
	const days = d1 - d0 + 1;
	if (days < 1) throw new RangeError('at least one day');
	checkBlock(block, d.arr.shape[1]!, d.arr.shape[2]!);
	const out = new Float32Array(days * block.h * block.w).fill(Number.NaN);
	const lo = Math.max(d0, 0);
	const hi = Math.min(d1, d.arr.shape[0]! - 1);
	if (lo <= hi) {
		const got = await zarr.get(d.arr, [zarr.slice(lo, hi + 1), zarr.slice(block.y0, block.y0 + block.h), zarr.slice(block.x0, block.x0 + block.w)]);
		out.set(contiguous(got, [hi - lo + 1, block.h, block.w]), (lo - d0) * block.h * block.w);
	}
	return { days, block, values: out };
}

/** zarrita's chunk as a C-ordered Float32Array (it may hand back other strides). */
function contiguous(chunk: zarr.Chunk<'float32'>, shape: [number, number, number]): Float32Array {
	const [a, b, c] = shape;
	const [s0, s1, s2] = chunk.stride as [number, number, number];
	const data = chunk.data as Float32Array;
	if (s0 === b * c && s1 === c && s2 === 1 && data.length === a * b * c) return data;
	const out = new Float32Array(a * b * c);
	for (let i = 0; i < a; i++) for (let j = 0; j < b; j++) for (let k = 0; k < c; k++) out[(i * b + j) * c + k] = data[i * s0 + j * s1 + k * s2]!;
	return out;
}
