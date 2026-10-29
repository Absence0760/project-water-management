// What § 8 Future yield reads from the copy (issue #621 slice 4;
// docs/evidence-pack.md § Future yield): NEX-GDDP-CMIP6's monthly aggregates
// (`cmip6/<model>/<scenario>`, ingest/cmip6_delta.py, backend/fixtures/mirror/
// cmip6/ in dev, CI and e2e) over a catchment's 0.25° cells, as the engine's
// buildFutureFactorTable takes them, with each product's files in the
// windows digested for the factor table (FutureSourceFile).
//
// A year counts as held when the product's manifest lists a file for each
// of pr, tasmax and tasmin in it; only held years inside the method's
// windows are read. The arrays are (year, month, lat, lon), float32, NaN for
// no data; °C and mm, as the ingest stores them.
import { createHash } from 'node:crypto';
import type { AbsolutePath } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { buildFutureFactorTable, canonicalJson, FUTURE_WINDOWS, type ClimateYear, type FutureFactorTable, type FutureModelCells, type FutureSourceFile } from '@water-management/engine';
import { contiguous, type MirrorArray } from '../mirror/arrays.js';
import { CMIP6_PRODUCT } from '../mirror/grid.js';
import { cmip6FileKey, readManifest, type Manifest } from '../mirror/manifest.js';
import type { MirrorStore } from '../mirror/store.js';
import { registerNodeGzip } from '../mirror/store.js';
import type { MirrorProduct } from '../mirror/arrays.js';
import type { ClimateGridCell } from './cells.js';

const SCENARIOS = ['historical', 'ssp245', 'ssp585'] as const;
type Scenario = (typeof SCENARIOS)[number];
const VARIABLES = { pr: 'pr_mm', tasmax: 'tasmax_c', tasmin: 'tasmin_c' } as const;

/** The copy's credit and licence words for the product (its groups' attributes; the same on every group). */
export interface Cmip6Copy {
	models: string[];
	citation: string;
	licence: string;
}

/** The copy holds no usable NEX-GDDP-CMIP6 product yet. */
export class Cmip6NotInCopyError extends Error {
	override readonly name = 'Cmip6NotInCopyError';
}

const dec = new TextDecoder();
const path = (p: string) => `/${p}` as AbsolutePath;
async function json(store: MirrorStore, key: string): Promise<unknown> {
	const b = await store.get(path(key));
	return b === undefined ? undefined : JSON.parse(dec.decode(b));
}

/** The models the copy holds all three scenarios of (cmip6/index.json), sorted, with the product's words; throws Cmip6NotInCopyError when none. */
export async function cmip6Copy(store: MirrorStore): Promise<Cmip6Copy> {
	const index = (await json(store, 'cmip6/index.json')) as { products?: Record<string, Record<string, unknown>> } | undefined;
	const models = Object.entries(index?.products ?? {})
		.filter(([m, s]) => CMIP6_PRODUCT.test(`cmip6/${m}/historical`) && SCENARIOS.every((x) => Array.isArray(s?.[x]) && (s[x] as unknown[]).length > 0))
		.map(([m]) => m)
		.sort();
	if (!models.length) throw new Cmip6NotInCopyError('the data copy holds no NEX-GDDP-CMIP6 model yet');
	const attrs = ((await json(store, `cmip6/${models[0]}/historical/zarr.json`)) as { attributes?: { citation?: unknown; licence?: unknown } } | undefined)?.attributes ?? {};
	return { models, citation: String(attrs.citation ?? 'NEX-GDDP-CMIP6'), licence: String(attrs.licence ?? '') };
}

/** The years of `m` with a file for every variable, inside `from`–`to`. */
function heldYears(m: Manifest, from: number, to: number): number[] {
	const by = new Map<number, Set<string>>();
	for (const f of m.files) {
		const k = cmip6FileKey(f.url);
		if (!k || k.year < from || k.year > to) continue;
		by.set(k.year, (by.get(k.year) ?? new Set()).add(k.variable));
	}
	return [...by.entries()].filter(([, v]) => Object.keys(VARIABLES).every((x) => v.has(x))).map(([y]) => y).sort((a, b) => a - b);
}

/** The windows a scenario's years are read for. */
const windowsOf = (s: Scenario): { from: number; to: number }[] => (s === 'historical' ? [FUTURE_WINDOWS.baseline] : [FUTURE_WINDOWS.mid, FUTURE_WINDOWS.late]);

/**
 * One model's catchment cells (each with its yearly monthly climate per
 * scenario, the held years of the windows only) and its products' sources.
 * A cell with a value that isn't a number in a held year (the sea, a gap) is
 * dropped, said in `dropped`.
 */
export async function readModelCells(store: MirrorStore, model: string, cells: readonly ClimateGridCell[]): Promise<{ cells: FutureModelCells; sources: FutureSourceFile[]; dropped: number }> {
	registerNodeGzip();
	if (!cells.length) throw new Error('no catchment cell to read');
	const y0 = Math.min(...cells.map((c) => c.row));
	const y1 = Math.max(...cells.map((c) => c.row));
	const x0 = Math.min(...cells.map((c) => c.col));
	const x1 = Math.max(...cells.map((c) => c.col));
	const h = y1 - y0 + 1;
	const w = x1 - x0 + 1;
	const sources: FutureSourceFile[] = [];
	const per: Record<Scenario, ClimateYear[][]> = { historical: cells.map(() => []), ssp245: cells.map(() => []), ssp585: cells.map(() => []) };
	const bad = new Set<number>();
	for (const scenario of SCENARIOS) {
		const product = `cmip6/${model}/${scenario}`;
		const manifest = await readManifest(store, product as MirrorProduct);
		if (!manifest) throw new Cmip6NotInCopyError(`the data copy has no manifest for ${product}`);
		const years = windowsOf(scenario).flatMap((win) => heldYears(manifest, win.from, win.to));
		const inWindows = manifest.files
			.filter((f) => {
				const k = cmip6FileKey(f.url);
				return !!k && years.includes(k.year);
			})
			.sort((a, b) => (a.url < b.url ? -1 : 1));
		sources.push({
			product,
			revision: manifest.revision,
			files: inWindows.length,
			filesSha256: createHash('sha256').update(canonicalJson(inWindows.map((f) => ({ url: f.url, valuesSha256: f.valuesSha256 })))).digest('hex'),
			versions: [...new Set(inWindows.map((f) => f.version ?? null).filter((v): v is string => v !== null))].sort(),
			licenses: [...new Set(inWindows.map((f) => f.license ?? null))].sort((a, b) => String(a).localeCompare(String(b)))
		});
		const arrays = {} as Record<keyof typeof VARIABLES, { arr: MirrorArray; firstYear: number }>;
		for (const [v, name] of Object.entries(VARIABLES) as [keyof typeof VARIABLES, string][]) {
			const arr = (await zarr.open.v3(zarr.root(store).resolve(`${product}/${name}`), { kind: 'array' })) as MirrorArray;
			const firstYear = (arr.attrs as { firstYear?: unknown }).firstYear;
			if (!Number.isInteger(firstYear) || arr.shape.length !== 4 || arr.shape[1] !== 12) throw new Error(`the data copy's ${product}/${name} is not laid out as the ingest writes it`);
			arrays[v] = { arr, firstYear: firstYear as number };
		}
		for (const year of years) {
			const block: Record<string, Float32Array> = {};
			for (const v of Object.keys(VARIABLES) as (keyof typeof VARIABLES)[]) {
				const { arr, firstYear } = arrays[v];
				const yi = year - firstYear;
				if (yi < 0 || yi >= arr.shape[0]!) throw new Error(`the data copy's ${product} lists ${year} but its array doesn't hold it`);
				const got = await zarr.get(arr, [yi, null, zarr.slice(y0, y1 + 1), zarr.slice(x0, x1 + 1)]);
				block[v] = contiguous(got as zarr.Chunk<'float32'>, [12, h, w]);
			}
			cells.forEach((c, i) => {
				const at = (v: string, m: number) => block[v]![(m * h + (c.row - y0)) * w + (c.col - x0)]!;
				const y: ClimateYear = {
					year,
					prMm: Array.from({ length: 12 }, (_, m) => at('pr', m)),
					tasmaxC: Array.from({ length: 12 }, (_, m) => at('tasmax', m)),
					tasminC: Array.from({ length: 12 }, (_, m) => at('tasmin', m))
				};
				if (![...y.prMm, ...y.tasmaxC, ...y.tasminC].every(Number.isFinite)) bad.add(i);
				per[scenario][i]!.push(y);
			});
		}
	}
	const kept = cells.flatMap((c, i) => (bad.has(i) ? [] : [{ lat: c.lat, weight: c.weight, historical: per.historical[i]!, ssp245: per.ssp245[i]!, ssp585: per.ssp585[i]! }]));
	if (!kept.length) throw new Cmip6NotInCopyError(`the data copy's ${model} has no value over the catchment`);
	return { cells: { model, cells: kept }, sources, dropped: bad.size };
}

/**
 * The factor table over a catchment's cells: every model the copy holds,
 * read and worked out (engine buildFutureFactorTable), with a note for each
 * model that left cells out. § 8's future_yield job and the Scenarios tab's
 * climate_factors job both read the copy through it. Throws
 * Cmip6NotInCopyError when the copy holds no usable model.
 */
export async function readFactorTable(store: MirrorStore, cells: readonly ClimateGridCell[]): Promise<{ factors: FutureFactorTable; warnings: string[] }> {
	const copy = await cmip6Copy(store);
	const models: FutureModelCells[] = [];
	const sources: FutureSourceFile[] = [];
	const warnings: string[] = [];
	for (const model of copy.models) {
		const read = await readModelCells(store, model, cells);
		if (read.dropped) warnings.push(`${model}: ${read.dropped} of the catchment's 0.25° cells hold no value (the sea, or a gap) and were left out`);
		models.push(read.cells);
		sources.push(...read.sources);
	}
	return { factors: buildFutureFactorTable(models, { sources, citation: copy.citation, licence: copy.licence }), warnings };
}
