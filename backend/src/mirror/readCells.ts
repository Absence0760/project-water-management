// Reading a feed's cells from the mirror (issue #604): the same answer the
// fetcher gives today from CHC's files (sources/chirps.ts fetchChirpsCells →
// fetch.ts CellsResult's `cells`), so the cell cache merges it unchanged
// (R2-C wires it in; nothing in production imports this yet).
//
// Which days are published comes from the manifests, not the arrays: an
// unwritten chunk is NaN, the same as the sea, so a day reads as `f` only when
// the product's manifest says its finals reach it (`finalThrough`, within
// `years`), and a `sat` day after that as `p` when the `prelim` manifest's
// `prelimThrough` reaches it. Every other day is `-` (not read, null values).
// On a day read, NaN is no data (encodeCellValue's -1); every other value is
// the stored float32, bit for bit.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { encodeCellValue, type GridCell } from '../feeds/cellCache.js';
import { FeedFormatError, FeedUnavailableError } from '../feeds/errors.js';
import type { CellsResult } from '../feeds/fetch.js';
import { DAY_FINAL_ONLY, DAY_SKIP } from '../feeds/sources/chirps.js';
import { type Block, DAILY_CHUNK, FINALS_CHUNK, type FinalsProduct, openDaily, openFinals, readDailyBlock, readFinalsBlock } from './arrays.js';
import { cellsByChunk, dayIndex, doyIndex, MIRROR_REGION, mirrorCell } from './grid.js';
import { type Manifest, readManifest } from './manifest.js';
import type { MirrorStore } from './store.js';

/** The copy doesn't hold the product yet (no manifest or no array): the feed tries again later. */
export class MirrorNotReadyError extends FeedUnavailableError {}

/** What readCells answers: CellsResult's `cells` (no file tags: the mirror has revisions instead), and the revisions it read. */
export interface MirrorCells {
	cells: Omit<CellsResult['cells'], 'tags'>;
	/** The manifests' revisions the values came from: the product's, and `prelim`'s for a `sat` read that used it. */
	revision: { final: number; prelim: number | null };
}

/**
 * The values of `cells` (CHC grid cells, feeds/cellCache.ts) over `window`
 * (inclusive ISO days) from the mirror's `product`. `plan` (optional, one
 * DAY_* character per day, as planFetch gives) leaves DAY_SKIP days unread
 * and reads DAY_FINAL_ONLY days from the finals only. A cell outside the
 * region throws MirrorOutsideRegionError; a value outside 0–2000 mm throws a
 * FeedFormatError, as a read from the files does.
 */
export async function readCells(
	store: MirrorStore,
	product: FinalsProduct,
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
	const at = cells.map((c) => mirrorCell(c, MIRROR_REGION));

	const manifest = await readManifest(store, product);
	const finals = await openFinals(store, product);
	if (!manifest || !finals) throw new MirrorNotReadyError(`the rain data copy has no ${product} data yet`);
	let prelimManifest: Manifest | null = null;
	let prelim = null;
	if (product === 'sat') {
		prelimManifest = await readManifest(store, 'prelim');
		prelim = prelimManifest ? await openDaily(store, 'prelim') : null;
		if (prelimManifest && !prelim) throw new MirrorNotReadyError('the rain data copy has a prelim manifest but no prelim array');
	}

	const days = Array.from({ length: n }, (_, i) => fromEpochDay(s + i));
	const isFinal = (day: string) =>
		manifest.finalThrough !== null && day <= manifest.finalThrough && Number(day.slice(0, 4)) >= manifest.years.first && Number(day.slice(0, 4)) <= manifest.years.last;
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
	for (const [year, idx] of finalYears) {
		const doy0 = doyIndex(days[idx[0]!]!);
		const doy1 = doyIndex(days[idx.at(-1)!]!);
		for (const g of finalGroups) {
			const block = blockOf(g);
			const got = await readFinalsBlock(finals, year, doy0, doy1, block);
			for (const i of idx) {
				const d = doyIndex(days[i]!) - doy0;
				for (const c of g.cells) put(c, i, got.values[(d * block.h + (at[c]!.y - block.y0)) * block.w + (at[c]!.x - block.x0)]!);
			}
		}
	}

	// Preliminary days (sat only): one read per chunk over the run of `p` days.
	const pIdx = days.map((_, i) => i).filter((i) => read[i] === 'p');
	if (prelim && pIdx.length) {
		const d0 = dayIndex(prelim.firstDay, days[pIdx[0]!]!);
		const d1 = dayIndex(prelim.firstDay, days[pIdx.at(-1)!]!);
		for (const g of cellsByChunk(at, DAILY_CHUNK[1], DAILY_CHUNK[2])) {
			const block = blockOf(g);
			const got = await readDailyBlock(prelim, d0, d1, block);
			for (const i of pIdx) {
				const d = dayIndex(prelim.firstDay, days[i]!) - d0;
				for (const c of g.cells) put(c, i, got.values[(d * block.h + (at[c]!.y - block.y0)) * block.w + (at[c]!.x - block.x0)]!);
			}
		}
	}

	return {
		cells: { product, startDate: window.start, read, cells: cells.map((c) => [c.row, c.col] as [number, number]), values },
		revision: { final: manifest.revision, prelim: pIdx.length ? prelimManifest!.revision : null }
	};
}
