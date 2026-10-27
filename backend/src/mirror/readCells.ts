// Reading a feed's cells from the mirror (issue #604): the same answer the
// fetcher gives today from CHC's files (sources/chirps.ts fetchChirpsCells →
// fetch.ts CellsResult's `cells`), so the cell cache merges it unchanged
// (R2-C wires it in; nothing in production imports this yet).
//
// Which days are published comes from the manifests, not the arrays: an
// unwritten chunk is NaN, the same as the sea, so a day reads as `f` only when
// the product's manifest says its finals reach it (`finalThrough`, within
// `years`, and no earlier than the first month its files hold:
// finalsCoverage; parseManifest already refuses a `finalThrough` past the
// contiguous run of months), and a `sat` day after that as `p` when the `prelim` manifest's
// `prelimThrough` reaches it. Every other day is `-` (not read, null values).
// On a day read, NaN is no data (encodeCellValue's -1); every other value is
// the stored float32, bit for bit.
//
// The other rain products read the same way, each on its own grid (grid.ts
// PRODUCT_GRIDS), its cells cells of that product's global grid
// (feeds/cellCache.ts productCell): `era5l` from its finals array, a day `f`
// within `years` from the first day its month requests hold (era5lCoverage)
// through `finalThrough`; and
// `imerg_late` from its daily array, a day `f` when a file names it
// (imergHeldDays: each day on its own, so a missing day is `-`, not held,
// and blocks none after it) up to its manifest's `prelimThrough` (IMERG Late is
// never final, but no final product follows it: the cache keeps each day as
// final, and a new version of a day reaches it as a revision), with each
// day's IMERG version (`versions`). The cache holds no preliminary day of either.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { encodeCellValue, type GridCell } from '../feeds/cellCache.js';
import type { CacheCells } from '../feeds/cellCacheStore.js';
import { FeedFormatError, FeedUnavailableError } from '../feeds/errors.js';
import { DAY_FINAL_ONLY, DAY_SKIP } from '../feeds/sources/chirps.js';
import { type Block, type DailyArray, dailyChunk, FINALS_CHUNK, type FinalsProduct, openDaily, openFinals, readDailyBlock, readFinalsBlock } from './arrays.js';
import { cellsByChunk, dayIndex, doyIndex, MIRROR_REGION, mirrorCell, productStep } from './grid.js';
import { era5lCoverage, finalsCoverage, imergHeldDays, imergVersions, type Manifest, readManifest } from './manifest.js';
import type { MirrorStore } from './store.js';

/** The copy doesn't hold the product yet (no manifest or no array): the feed tries again later. */
export class MirrorNotReadyError extends FeedUnavailableError {}

/** The products readCells reads: the finals layout's, and IMERG Late's daily one. */
export type CellsProduct = FinalsProduct | 'imerg_late';

/** What readCells answers: CellsResult's `cells` (no file tags: the mirror has revisions instead), and the revisions it read. */
export interface MirrorCells {
	cells: Omit<CacheCells, 'tags'>;
	/** The manifests' revisions the values came from: the product's, and `prelim`'s for a `sat` read that used it. */
	revision: { final: number; prelim: number | null };
	/** imerg_late only: each day's IMERG version (null on a day not read). */
	versions?: (string | null)[];
}

/**
 * The values of `cells` (cells of `product`'s global grid: CHC's for CHIRPS,
 * feeds/cellCache.ts productCell) over `window` (inclusive ISO days) from the
 * mirror's `product`. `plan` (optional, one
 * DAY_* character per day, as planFetch gives) leaves DAY_SKIP days unread
 * and reads DAY_FINAL_ONLY days from the finals only. A cell outside the
 * region throws MirrorOutsideRegionError; a value outside 0–2000 mm throws a
 * FeedFormatError, as a read from the files does.
 */
export async function readCells(
	store: MirrorStore,
	product: CellsProduct,
	cells: readonly GridCell[],
	window: { start: string; end: string },
	opts: { plan?: string } = {}
): Promise<MirrorCells> {
	const s = toEpochDay(window.start);
	const n = toEpochDay(window.end) - s + 1;
	if (!(n >= 1)) throw new RangeError('the window ends before it starts');
	const plan = opts.plan ?? '0'.repeat(n);
	if (plan.length !== n) throw new RangeError('one plan character per day of the window');
	// Refuse a cell outside the region before reading anything.
	const step = productStep(product);
	const at = cells.map((c) => mirrorCell(c, MIRROR_REGION, step));

	const manifest = await readManifest(store, product);
	let finals = null;
	let daily: DailyArray | null = null;
	if (product === 'imerg_late') daily = manifest ? await openDaily(store, product) : null;
	else finals = await openFinals(store, product);
	if (!manifest || !(finals ?? daily)) throw new MirrorNotReadyError(`the rain data copy has no ${product} data yet`);
	let prelimManifest: Manifest | null = null;
	let prelim = null;
	if (product === 'sat') {
		prelimManifest = await readManifest(store, 'prelim');
		prelim = prelimManifest ? await openDaily(store, 'prelim') : null;
		if (prelimManifest && !prelim) throw new MirrorNotReadyError('the rain data copy has a prelim manifest but no prelim array');
	}

	const days = Array.from({ length: n }, (_, i) => fromEpochDay(s + i));
	// The days the files hold: CHC's months, IMERG's days, or era5l's month requests (each the last day of the month before through its second-last day).
	// The cache takes imerg_late's days as final (nothing later replaces them but a revision), though its manifest holds
	// them through prelimThrough: IMERG Late is never final, but there is no final product of it to wait for.
	const heldThrough = product === 'imerg_late' ? manifest.prelimThrough : manifest.finalThrough;
	const held = product === 'era5l' ? era5lCoverage(manifest.files) : product === 'imerg_late' ? null : finalsCoverage(manifest.files);
	// imerg_late: the days its files name, each on its own (a gap is not held and blocks nothing after it).
	const heldDays = product === 'imerg_late' ? imergHeldDays(manifest.files) : null;
	const { first, last } = manifest.years;
	const isFinal = (day: string) =>
		(daily === null || day >= daily.firstDay) &&
		(heldDays === null ? held !== null && day >= held.from : heldDays.has(day)) &&
		heldThrough !== null &&
		day <= heldThrough &&
		first !== null &&
		Number(day.slice(0, 4)) >= first &&
		Number(day.slice(0, 4)) <= last!;
	const isPrelim = (day: string) =>
		prelim !== null && prelimManifest?.prelimThrough != null && day <= prelimManifest.prelimThrough && day >= prelim.firstDay;
	const read = days.map((day, i) => (plan[i] === DAY_SKIP ? '-' : isFinal(day) ? 'f' : plan[i] !== DAY_FINAL_ONLY && isPrelim(day) ? 'p' : '-')).join('');

	const values: (number | null)[][] = cells.map(() => new Array<number | null>(n).fill(null));
	const put = (cellIdx: number, i: number, v: number) => {
		if (!Number.isNaN(v) && (v < 0 || v > 2000)) {
			throw new FeedFormatError(`the rain data copy has an implausible rainfall of ${v} mm on ${days[i]} (${product})`);
		}
		values[cellIdx]![i] = encodeCellValue(v);
	};
	const blockOf = (g: { y0: number; y1: number; x0: number; x1: number }): Block => ({ y0: g.y0, x0: g.x0, h: g.y1 - g.y0 + 1, w: g.x1 - g.x0 + 1 });

	// Finals: one read per (year, chunk) over the year's run of `f` days in the window.
	const finalYears = new Map<number, number[]>();
	days.forEach((day, i) => {
		if (read[i] !== 'f') return;
		const y = Number(day.slice(0, 4));
		(finalYears.get(y) ?? finalYears.set(y, []).get(y)!).push(i);
	});
	const finalGroups = cellsByChunk(at, FINALS_CHUNK[2], FINALS_CHUNK[3]);
	for (const [year, idx] of finals ? finalYears : []) {
		const doy0 = doyIndex(days[idx[0]!]!);
		const doy1 = doyIndex(days[idx.at(-1)!]!);
		for (const g of finalGroups) {
			const block = blockOf(g);
			const got = await readFinalsBlock(finals!, year, doy0, doy1, block);
			for (const i of idx) {
				const d = doyIndex(days[i]!) - doy0;
				for (const c of g.cells) put(c, i, got.values[(d * block.h + (at[c]!.y - block.y0)) * block.w + (at[c]!.x - block.x0)]!);
			}
		}
	}

	// Days of a daily array (sat's preliminary days, or imerg_late's own): one read per chunk over the run of its days.
	const readDaily = async (arr: DailyArray, idx: number[]) => {
		if (!idx.length) return;
		const d0 = dayIndex(arr.firstDay, days[idx[0]!]!);
		const d1 = dayIndex(arr.firstDay, days[idx.at(-1)!]!);
		const [, ch, cw] = dailyChunk(step);
		for (const g of cellsByChunk(at, ch, cw)) {
			const block = blockOf(g);
			const got = await readDailyBlock(arr, d0, d1, block);
			for (const i of idx) {
				const d = dayIndex(arr.firstDay, days[i]!) - d0;
				for (const c of g.cells) put(c, i, got.values[(d * block.h + (at[c]!.y - block.y0)) * block.w + (at[c]!.x - block.x0)]!);
			}
		}
	};
	const pIdx = days.map((_, i) => i).filter((i) => read[i] === 'p');
	if (prelim) await readDaily(prelim, pIdx);
	if (daily) await readDaily(daily, days.map((_, i) => i).filter((i) => read[i] === 'f'));

	const out: MirrorCells = {
		cells: { product, startDate: window.start, read, cells: cells.map((c) => [c.row, c.col] as [number, number]), values },
		revision: { final: manifest.revision, prelim: pIdx.length ? prelimManifest!.revision : null }
	};
	if (daily) {
		const v = imergVersions(manifest);
		out.versions = days.map((day, i) => (read[i] === 'f' ? (v.get(day) ?? null) : null));
	}
	return out;
}
