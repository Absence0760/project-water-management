// The ECMWF ENS forecast in our copy, as the Node side reads (and, for the
// committed fixture and the tests, writes) it (issue #604 D17, R4-C). The
// copy is written by the Python ingest job, ingest/ecmwf_forecast.py, whose header
// is the spec; in short:
//
//   ecmwf/index.json         {"issues": [...7 newest], "archived": [...]}, newest first
//   ecmwf/<issue>/           Zarr v3, float32, NaN fill, [bytes LE, gzip 6]
//                            shape (4, 15, 275, 310), dims (stat, day, lat, lon),
//                            chunk (1, 1, 55, 62); stats mean, p10, p50, p90;
//                            attrs firstDay (= issue), stats, members, region, grid
//                            (0.1°, origin -35.45 / 10.05: row 0 the south-west cell)
//   ecmwf/<issue>/manifest.json   the 15 step files, day order
//   ecmwf/qm.json            the quantile-mapping fit (ingest/ecmwf_qm_fit.py), if any
//
// Day d of an issue is the UTC day issue + d (the 00 UTC run's tp at
// 24(d+1) h less at 24d h), the same dates an issue of CHIRPS-GEFS covers
// from its issue date. Readers use only `issues` (held whole); `archived`
// issues keep only their mean, for the fit.
import { isIsoDate } from '@water-management/engine/calendar';
import type { AbsolutePath } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { z } from 'zod';
import { FeedFormatError } from '../feeds/errors.js';
import { CODECS } from '../mirror/arrays.js';
import { cellsByChunk, MIRROR_REGION, MirrorOutsideRegionError, type Region, regionSize } from '../mirror/grid.js';
import { MirrorManifestError } from '../mirror/manifest.js';
import { type MirrorStore, registerNodeGzip } from '../mirror/store.js';

export const ECMWF_DAYS = 15;
export const ECMWF_STATS = ['mean', 'p10', 'p50', 'p90'] as const;
export type EcmwfStat = (typeof ECMWF_STATS)[number];
export const ECMWF_STEP = 0.1;
export const ECMWF_CHUNK = [1, 1, 55, 62] as const;
export const ECMWF_DIMS = ['stat', 'day', 'lat', 'lon'];
export const ECMWF_REGION: Region = MIRROR_REGION;
/** Rows (south to north) and columns of the 0.1° grid on region D1: 275 × 310. */
export const ECMWF_SIZE = regionSize(ECMWF_REGION, ECMWF_STEP);
export const ECMWF_ORIGIN = { lat: -35.45, lon: 10.05 };

export const ecmwfProduct = (issue: string) => `ecmwf/${issue}`;
const path = (p: string) => `/${p}` as AbsolutePath;
const dec = new TextDecoder();
const enc = new TextEncoder();
const IsoDay = z.string().refine(isIsoDate, 'an ISO date (YYYY-MM-DD)');
const newestFirst = (xs: string[]) => xs.every((d, i) => i === 0 || d < xs[i - 1]!);

/** `ecmwf/index.json`. */
export const EcmwfIndex = z
	.object({ issues: z.array(IsoDay).max(28), archived: z.array(IsoDay).max(20_000) })
	.strict()
	.refine((x) => newestFirst(x.issues) && newestFirst(x.archived), 'issues and archived newest first, each once')
	.refine((x) => !x.issues.some((d) => x.archived.includes(d)), 'an issue both held and archived');
export type EcmwfIndex = z.output<typeof EcmwfIndex>;

async function readJson(store: MirrorStore, key: string): Promise<unknown> {
	const bytes = await store.get(path(key));
	if (bytes === undefined) return undefined;
	try {
		return JSON.parse(dec.decode(bytes));
	} catch {
		throw new MirrorManifestError(`the rain data copy’s ${key} is not valid JSON`);
	}
}

/** The index, or null when the copy holds no ECMWF issue yet. */
export async function readEcmwfIndex(store: MirrorStore): Promise<EcmwfIndex | null> {
	const raw = await readJson(store, 'ecmwf/index.json');
	if (raw === undefined) return null;
	const r = EcmwfIndex.safeParse(raw);
	if (!r.success) throw new MirrorManifestError(`the rain data copy’s ecmwf/index.json is invalid: ${r.error.issues[0]!.message}`);
	return r.data;
}

export async function writeEcmwfIndex(store: MirrorStore, index: EcmwfIndex): Promise<void> {
	const ok = EcmwfIndex.parse(index);
	await store.set(path('ecmwf/index.json'), enc.encode(`${JSON.stringify(ok, null, 2)}\n`));
}

// --- The 0.1° grid ----------------------------------------------------------------------

/** A 0.1° cell: y counted north from the region's south edge, x east from its west edge. */
export interface EcmwfCell {
	y: number;
	x: number;
}

/**
 * The 0.1° cell holding a point (a feed cell's centre, which lies on .025 or
 * .075, so never on a 0.1° edge), or MirrorOutsideRegionError.
 */
export function ecmwfCell(lat: number, lon: number, region: Region = ECMWF_REGION): EcmwfCell {
	const y = Math.floor((lat - region.s) / ECMWF_STEP + 1e-9);
	const x = Math.floor((lon - region.w) / ECMWF_STEP + 1e-9);
	if (y < 0 || y >= ECMWF_SIZE.rows || x < 0 || x >= ECMWF_SIZE.cols) throw new MirrorOutsideRegionError(lat, lon, region);
	return { y, x };
}

// --- An issue's array -------------------------------------------------------------------

export type EcmwfArray = zarr.Array<'float32', MirrorStore>;

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const near = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

/** Open a held issue's array, checked against the layout; null when the copy doesn't hold it. */
export async function openEcmwfIssue(store: MirrorStore, issue: string): Promise<EcmwfArray | null> {
	registerNodeGzip();
	const product = ecmwfProduct(issue);
	const meta = (await readJson(store, `${product}/zarr.json`)) as Record<string, unknown> | undefined;
	if (meta === undefined) return null;
	const arr = (await zarr.open.v3(zarr.root(store).resolve(product), { kind: 'array' })) as EcmwfArray;
	const bad = (what: string) => new FeedFormatError(`the rain data copy’s ECMWF forecast issued ${issue} is not laid out as expected (${what})`);
	if (arr.dtype !== 'float32') throw bad(`data type ${arr.dtype}`);
	if (!same(arr.chunks, ECMWF_CHUNK)) throw bad(`chunks ${arr.chunks.join('×')}`);
	if (!same(arr.dimensionNames ?? [], ECMWF_DIMS)) throw bad('dimension names');
	if (JSON.stringify(meta.codecs) !== JSON.stringify(CODECS)) throw bad('codecs');
	if (!same(arr.shape, [ECMWF_STATS.length, ECMWF_DAYS, ECMWF_SIZE.rows, ECMWF_SIZE.cols])) throw bad(`shape ${arr.shape.join('×')}`);
	const a = arr.attrs as { firstDay?: unknown; stats?: unknown; grid?: { origin?: { lat?: unknown; lon?: unknown }; step?: unknown } };
	if (a.firstDay !== issue) throw bad(`firstDay ${String(a.firstDay)}`);
	if (!Array.isArray(a.stats) || !same(a.stats, ECMWF_STATS)) throw bad('stats');
	if (!near(a.grid?.step, ECMWF_STEP) || !near(a.grid?.origin?.lat, ECMWF_ORIGIN.lat) || !near(a.grid?.origin?.lon, ECMWF_ORIGIN.lon)) throw bad('grid');
	return arr;
}

/** One statistic of days [d0, d1] at `cells`: per day, per cell (NaN for an unwritten chunk). */
export async function readEcmwfStat(arr: EcmwfArray, stat: EcmwfStat, cells: readonly EcmwfCell[], d0 = 0, d1 = ECMWF_DAYS - 1): Promise<number[][]> {
	const s = ECMWF_STATS.indexOf(stat);
	const out = Array.from({ length: d1 - d0 + 1 }, () => new Array<number>(cells.length).fill(Number.NaN));
	for (const g of cellsByChunk(cells, ECMWF_CHUNK[2], ECMWF_CHUNK[3])) {
		const h = g.y1 - g.y0 + 1;
		const w = g.x1 - g.x0 + 1;
		const got = await zarr.get(arr, [s, zarr.slice(d0, d1 + 1), zarr.slice(g.y0, g.y1 + 1), zarr.slice(g.x0, g.x1 + 1)]);
		const data = got.data as Float32Array;
		for (let d = 0; d <= d1 - d0; d++) for (const c of g.cells) out[d]![c] = data[(d * h + (cells[c]!.y - g.y0)) * w + (cells[c]!.x - g.x0)]!;
	}
	return out;
}

/**
 * Write an issue's array with `values` over one block of cells, (stat, day,
 * y, x) C order: what the Python job writes, for the committed fixture and
 * the tests (the job itself writes the whole region).
 */
export async function writeEcmwfIssue(store: MirrorStore, issue: string, block: { y0: number; x0: number; h: number; w: number }, values: Float32Array, members = 50): Promise<void> {
	registerNodeGzip();
	const n = ECMWF_STATS.length * ECMWF_DAYS * block.h * block.w;
	if (values.length !== n) throw new RangeError(`one value per statistic, day and cell (${n})`);
	for (const key of ['zarr.json', 'ecmwf/zarr.json']) {
		if ((await store.get(path(key))) === undefined) await zarr.create(key === 'zarr.json' ? zarr.root(store) : zarr.root(store).resolve('ecmwf'), { attributes: {} });
	}
	const arr = await zarr.create(zarr.root(store).resolve(ecmwfProduct(issue)), {
		shape: [ECMWF_STATS.length, ECMWF_DAYS, ECMWF_SIZE.rows, ECMWF_SIZE.cols],
		chunkShape: [...ECMWF_CHUNK],
		dtype: 'float32',
		fillValue: Number.NaN,
		codecs: CODECS,
		dimensionNames: ECMWF_DIMS,
		attributes: { firstDay: issue, stats: [...ECMWF_STATS], members, region: { ...ECMWF_REGION }, grid: { origin: { ...ECMWF_ORIGIN }, step: ECMWF_STEP } }
	});
	await zarr.set(arr, [null, null, zarr.slice(block.y0, block.y0 + block.h), zarr.slice(block.x0, block.x0 + block.w)], {
		data: values,
		shape: [ECMWF_STATS.length, ECMWF_DAYS, block.h, block.w],
		stride: [ECMWF_DAYS * block.h * block.w, block.h * block.w, block.w, 1]
	});
}

// --- Quantile mapping (D17) ---------------------------------------------------------------

const Pair = z.tuple([z.number().finite().min(0).max(5000), z.number().finite().min(0).max(5000)]);
const QmGroup = z
	.object({
		id: z.string().max(80),
		region: z.object({ w: z.number(), s: z.number(), e: z.number(), n: z.number() }).strict(),
		months: z.array(z.number().int().min(1).max(12)).min(1).max(12),
		samples: z.number().int().nonnegative(),
		pairs: z.array(Pair).min(2).max(1000)
	})
	.strict()
	.refine((g) => g.pairs.every((p, i) => i === 0 || (p[0] > g.pairs[i - 1]![0] && p[1] >= g.pairs[i - 1]![1])), 'pairs must increase');

/** `ecmwf/qm.json`, as ingest/ecmwf_qm_fit.py writes it. */
export const EcmwfQm = z
	.object({
		v: z.literal(1),
		product: z.literal('ecmwf'),
		stat: z.literal('mean'),
		fittedAt: z.iso.datetime({ offset: true }),
		method: z.string().max(500),
		observed: z.object({ product: z.string().max(20), fallback: z.string().max(20).nullable().optional(), scale: z.number().positive() }).strict(),
		forecasts: z.object({ issues: z.number().int().nonnegative(), first: IsoDay.nullable(), last: IsoDay.nullable() }).strict(),
		groups: z.array(QmGroup).max(200)
	})
	.strict();
export type EcmwfQm = z.output<typeof EcmwfQm>;

/** The fit, or null when there is none yet (the forecast is then not yet calibrated). A broken file fails the read. */
export async function readEcmwfQm(store: MirrorStore): Promise<EcmwfQm | null> {
	const raw = await readJson(store, 'ecmwf/qm.json');
	if (raw === undefined) return null;
	const r = EcmwfQm.safeParse(raw);
	if (!r.success) throw new MirrorManifestError(`the rain data copy’s ecmwf/qm.json is invalid: ${r.error.issues[0]!.path.join('.')} ${r.error.issues[0]!.message}`);
	return r.data;
}

/** The group a point and month fall in: the first whose region holds the point and whose months hold the month. */
export function qmGroupFor(qm: EcmwfQm, lat: number, lon: number, month: number): EcmwfQm['groups'][number] | null {
	return qm.groups.find((g) => lat >= g.region.s && lat <= g.region.n && lon >= g.region.w && lon <= g.region.e && g.months.includes(month)) ?? null;
}

/**
 * A daily total mapped through the pairs, the rule ingest/ecmwf_qm_fit.py
 * `apply` keeps: linear between pairs; past the last pair its offset carried
 * on; below the first, scaled towards 0 (or the first o when f starts at 0);
 * never below 0.
 */
export function applyQm(pairs: readonly (readonly [number, number])[], x: number): number {
	if (!pairs.length) return x;
	const [f0, o0] = pairs[0]!;
	const [fn, on] = pairs.at(-1)!;
	let y: number;
	if (x >= fn) y = on + (x - fn);
	else if (x <= f0) y = f0 <= 0 ? o0 : o0 * (x / f0);
	else {
		let i = 1;
		while (pairs[i]![0] < x) i++;
		const [fa, oa] = pairs[i - 1]!;
		const [fb, ob] = pairs[i]!;
		y = oa + ((ob - oa) * (x - fa)) / (fb - fa);
	}
	return Math.max(0, y);
}
