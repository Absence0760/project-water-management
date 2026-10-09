// CHIRPS v3 daily rainfall and the CHIRPS-GEFS v3 16-day forecast, from the
// UCSB Climate Hazards Center's public file server. Both are daily global
// GeoTIFFs on the same 0.05° grid (sources/tiff.ts reads the few pixels a
// feed needs with range requests).
//
// Layout, checked against https://data.chc.ucsb.edu/products/ (2026-09):
//   CHIRPS final:   CHIRPS/v3.0/daily/final/sat/YYYY/chirps-v3.0.sat.YYYY.MM.DD.tif
//                   (monthly, complete by about the third week of the next month)
//   CHIRPS prelim:  CHIRPS/v3.0/daily/prelim/sat/YYYY/chirps-v3.0.prelim.YYYY.MM.DD.tif
//                   (two days after each pentad ends)
//   GEFS forecast:  CHIRPS-GEFS/v3/daily/global/YYYY/MM/DD/c3g_YYYY.MM.DD.tif
//                   (the directory is the issue date, ~08:30 UTC; 16 files,
//                   one per forecast day from the issue date)
//   CHIRPS rnl:     CHIRPS/v3.0/daily/final/rnl/YYYY/chirps-v3.0.rnl.YYYY.MM.DD.tif
//                   (from 1981; final only)
// "sat" is CHIRPS v3 disaggregated to days with IMERG, the only daily
// preliminary product, and it starts in 1998. "rnl" is the same pentads
// disaggregated with ERA5: it starts in 1981, lags 5–6 days and has no
// prelim. Their daily timing differs, so a feed reads one of them end to end
// (feeds/config.ts CHIRPS_DAILY_PRODUCTS), never rnl before 1998 and sat
// after: that splice would be a break of its own (issue #40 part c).
// Units are mm/day; the sea is -9999.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { FeedFormatError, FeedNoDataError, FeedUnavailableError } from '../errors.js';
import type { FeedHttp } from '../http.js';
import { openGrid, readPoints } from './tiff.js';

export const CHC_BASE = 'https://data.chc.ucsb.edu/products';

const dotted = (iso: string) => iso.replaceAll('-', '.');

export const chirpsFinalUrl = (iso: string) => `${CHC_BASE}/CHIRPS/v3.0/daily/final/sat/${iso.slice(0, 4)}/chirps-v3.0.sat.${dotted(iso)}.tif`;
export const chirpsRnlUrl = (iso: string) => `${CHC_BASE}/CHIRPS/v3.0/daily/final/rnl/${iso.slice(0, 4)}/chirps-v3.0.rnl.${dotted(iso)}.tif`;
export const chirpsPrelimUrl = (iso: string) => `${CHC_BASE}/CHIRPS/v3.0/daily/prelim/sat/${iso.slice(0, 4)}/chirps-v3.0.prelim.${dotted(iso)}.tif`;
export const gefsUrl = (issued: string, day: string) =>
	`${CHC_BASE}/CHIRPS-GEFS/v3/daily/global/${issued.slice(0, 4)}/${issued.slice(5, 7)}/${issued.slice(8, 10)}/c3g_${dotted(day)}.tif`;

/** Forecast days per GEFS issue. */
export const GEFS_DAYS = 16;

export interface Cell {
	lat: number;
	lon: number;
	weight: number;
}

/**
 * A bounding box's opt-in to leave out its no-data (sea) cells
 * (config.skipNoData). One per fetch: `mask` records which cells had data on
 * the first day read ('1' / '0' per cell), and every other day must match it.
 * The sea mask is static, so a land cell going no-data between days is a
 * corrupt or changed grid, and fails the fetch rather than quietly moving the
 * area the mean covers.
 */
export interface NoDataPolicy {
	mask: string | null;
}

/** How many cells a fetch's days were averaged over, once a day was read. */
export const cellsUsed = (p: NoDataPolicy): number | null => (p.mask === null ? null : [...p.mask].filter((b) => b === '1').length);

/**
 * The weighted mean over `cells` of one grid file, or null when the file
 * isn't published (404). A cell over the sea, or outside the grid, is a
 * configuration error and fails the fetch rather than skewing the mean,
 * unless `noData` is given: then no-data cells are left out and the other
 * weights renormalised (the day still fails when no cell has data).
 */
export async function gridMean(http: FeedHttp, url: string, cells: readonly Cell[], noData?: NoDataPolicy): Promise<number | null> {
	const read = (start: number, end: number) => http.range(url, start, end);
	const grid = await openGrid(read);
	if (!grid) return null;
	return meanOf(await readPoints(read, grid, cells), cells, noData);
}

/**
 * gridMean's arithmetic on one day's values (null = no data), one per cell
 * in `cells`' order: the same refusals, the same renormalising, the same
 * rounding. The cell cache computes a feed's days with it from cached cells
 * (feeds/cellCache.ts seriesFromCache), so a day is the same number whether
 * it was read from the file or from the cache.
 */
export function meanOf(values: readonly (number | null)[], cells: readonly Cell[], noData?: NoDataPolicy): number {
	let sum = 0;
	let weights = 0;
	if (noData) {
		const mask = values.map((v) => (v === null ? '0' : '1')).join('');
		if (!mask.includes('1')) {
			// Another day of this fetch had data: this file lost it all, which the sea never does.
			if (noData.mask !== null) throw new FeedFormatError('a day’s grid has no data in any cell of the box, though another day of the fetch had some: the file looks corrupt, or the grid has changed');
			throw new FeedNoDataError('the grid has no data in any cell of the bounding box (all sea, or outside the product’s coverage)');
		}
		noData.mask ??= mask;
		if (noData.mask !== mask) {
			throw new FeedFormatError(
				'the cells with data changed from one day to another within one fetch (a land cell read as no data): the grid is corrupt or has changed'
			);
		}
	}
	values.forEach((v, i) => {
		const c = cells[i]!;
		if (v === null && noData) return;
		if (v === null) throw new FeedNoDataError(`the grid has no data at ${c.lat}, ${c.lon} (the sea, or outside the product’s coverage)`);
		if (v < 0 || v > 2000) throw new FeedFormatError(`the grid has an implausible rainfall of ${v} mm at ${c.lat}, ${c.lon}`);
		sum += v * c.weight;
		weights += c.weight;
	});
	// Rainfall to 0.01 mm: the product's own precision is far coarser.
	return Math.round((sum / weights) * 100) / 100;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!, i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/**
 * Days after a month ends by which its final files are out: CHC says
 * "typically complete during the third week of the following month", and
 * this leaves some weeks' slack. A final still missing after that is a gap.
 */
export const CHIRPS_FINAL_EXPECTED_DAYS = 45;

/** Whether `day`'s final file should be out by `today` (epoch days): its month ended CHIRPS_FINAL_EXPECTED_DAYS before. */
function finalExpected(day: string, today: number): boolean {
	const y = Number(day.slice(0, 4));
	const m = Number(day.slice(5, 7));
	const monthEnd = toEpochDay(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`) - 1;
	return today - monthEnd > CHIRPS_FINAL_EXPECTED_DAYS;
}

export interface GridDays {
	startDate: string;
	values: (number | null)[];
	/**
	 * Preliminary days: read from the preliminary product, or already held as
	 * preliminary and not read again (`heldThrough`, below). The rest are final.
	 */
	prelimDays: number;
	/**
	 * The last day D such that every day from the first through D was read
	 * from the final product with a value (a final value is never revised, so
	 * the next fetch needn't read them again, issue #69). Absent when the first
	 * day isn't final.
	 */
	finalThrough?: string;
}

/**
 * CHIRPS for each day of [start, end] from one daily product: for `sat`, the
 * final value where it is out, else the preliminary one; for `rnl`, the final
 * value (it has no preliminary product); else null. Trailing days with
 * neither are dropped (not published yet); a day missing between published
 * ones stays null. `finalThrough` marks the leading run of final days.
 *
 * `sat` reads as little as the publishing allows (issue #69). CHC publishes
 * a month's final files together, about three weeks after it ends, so the
 * finals are probed from the first day, that day alone and then
 * `concurrency` at a time, until a batch's last day has none in a month
 * whose finals may still be on their way (it ended less than
 * CHIRPS_FINAL_EXPECTED_DAYS before `today`): no later day can have one, and
 * each is read from the preliminary product directly. A final missing from
 * an older month is a gap in the archive, not the publishing lag, so the
 * probing goes on past it and the later finals are read as finals. A day
 * with no final that the feed already holds (`heldThrough`: every day from
 * the window's first through it holds a value in the series the answer
 * merges into, jobs/handlers/feed-fetch.ts) is not read again: a
 * preliminary value is published once and only replaced by the final, so it
 * comes back null, which the merge leaves as it is (keepOnNull), and counts
 * in prelimDays.
 */
export async function fetchChirps(
	http: FeedHttp,
	cells: readonly Cell[],
	start: string,
	end: string,
	product: 'sat' | 'rnl' = 'sat',
	opts: { concurrency?: number; heldThrough?: string | null; today?: string; noData?: NoDataPolicy } = {}
): Promise<GridDays> {
	const concurrency = opts.concurrency ?? 6;
	const heldThrough = opts.heldThrough ?? null;
	const noData = opts.noData;
	// Without a today, the day after the window: its last month is the one still being published.
	const today = toEpochDay(opts.today ?? fromEpochDay(toEpochDay(end) + 1));
	const s = toEpochDay(start);
	const days = Array.from({ length: Math.max(0, toEpochDay(end) - s + 1) }, (_, i) => fromEpochDay(s + i));
	let got: { v: number | null; prelim: boolean }[];
	let held = 0;
	if (product === 'rnl') {
		got = await mapLimit(days, concurrency, async (day) => ({ v: await gridMean(http, chirpsRnlUrl(day), cells, noData), prelim: false }));
	} else {
		const finals = new Array<number | null>(days.length).fill(null);
		for (let probed = 0, size = 1; probed < days.length; size = concurrency) {
			const batch = await mapLimit(days.slice(probed, probed + size), concurrency, (day) => gridMean(http, chirpsFinalUrl(day), cells, noData));
			batch.forEach((v, i) => (finals[probed + i] = v));
			probed += batch.length;
			if (batch.at(-1) === null && !finalExpected(days[probed - 1]!, today)) break;
		}
		got = await mapLimit(days, concurrency, async (day, i) => {
			const f = finals[i]!;
			if (f !== null) return { v: f, prelim: false };
			if (heldThrough !== null && day <= heldThrough) {
				held++;
				return { v: null, prelim: false };
			}
			const prelim = await gridMean(http, chirpsPrelimUrl(day), cells, noData);
			return { v: prelim, prelim: prelim !== null };
		});
	}
	let last = got.length - 1;
	while (last >= 0 && got[last]!.v === null) last--;
	const kept = got.slice(0, last + 1);
	let final = 0;
	while (final < kept.length && kept[final]!.v !== null && !kept[final]!.prelim) final++;
	const out: GridDays = { startDate: start, values: kept.map((g) => g.v), prelimDays: kept.filter((g) => g.prelim).length + held };
	if (final > 0) out.finalThrough = days[final - 1]!;
	return out;
}

/**
 * One grid file's values at `points`, null where the grid says no data (the
 * sea), or null for the whole file when it isn't published (404). A value
 * outside 0–2000 mm fails the fetch, as gridMean's does.
 */
export async function gridValues(http: FeedHttp, url: string, points: readonly { lat: number; lon: number }[]): Promise<(number | null)[] | null> {
	return (await gridValuesTagged(http, url, points))?.values ?? null;
}

/**
 * gridValues, with the file's tag (FeedHttp.rangeTagged; null when the
 * client gives none): which version of the file the values came from. Every
 * range read of the file must carry the same tag, or the file was rewritten
 * while it was being read and its values may be half old, half new: that
 * fails the fetch as unavailable, so it is read again later.
 */
export async function gridValuesTagged(
	http: FeedHttp,
	url: string,
	points: readonly { lat: number; lon: number }[]
): Promise<{ values: (number | null)[]; tag: string | null } | null> {
	let tag: string | null | undefined;
	const read = async (start: number, end: number) => {
		if (!http.rangeTagged) return http.range(url, start, end);
		const got = await http.rangeTagged(url, start, end);
		if (!got) return null;
		if (tag === undefined) tag = got.tag;
		else if (got.tag !== tag) throw new FeedUnavailableError('a file changed while it was being read');
		return got.bytes;
	};
	const grid = await openGrid(read);
	if (!grid) return null;
	const values = await readPoints(read, grid, points);
	values.forEach((v, i) => {
		if (v !== null && (v < 0 || v > 2000)) throw new FeedFormatError(`the grid has an implausible rainfall of ${v} mm at ${points[i]!.lat}, ${points[i]!.lon}`);
	});
	return { values, tag: tag ?? null };
}

/**
 * What a cell-cache fetch does with each day of its window (feeds/cellCache.ts
 * planFetch): `0` read it (the final file, else the preliminary one), `1`
 * skip it (the cache holds every cell final, or there is nothing to read),
 * `2` read only its final file (the cache holds a preliminary value for every
 * cell, and a preliminary value is published once).
 */
export const DAY_READ = '0';
export const DAY_SKIP = '1';
export const DAY_FINAL_ONLY = '2';

/** Each cell's own days, as the cell cache stores them (feeds/cellCache.ts). */
export interface CellDays {
	startDate: string;
	/** Per day: `f` read from the final file, `p` from the preliminary one, `-` not read (skipped, or not published). */
	read: string;
	/** Per cell (the points' order), per day: mm, NaN for no data, null where the day wasn't read. */
	values: (number | null)[][];
	/** Per day: the final file's tag on a day read from it (gridValuesTagged), else null. */
	tags: (string | null)[];
}

/**
 * fetchChirps for the cell cache: each point's own value per day, never their
 * mean, and only the days `plan` asks for (one DAY_* character per day from
 * `start`). The same reading as fetchChirps otherwise: `rnl` reads its final
 * files; `sat` probes finals in date order (the first day alone, then
 * `concurrency` at a time, stopping after a batch whose last day has none in
 * a month whose finals may still be on their way), then reads the
 * preliminary file of each DAY_READ day that had no final. A DAY_FINAL_ONLY
 * day without a final is left unread: the cache's preliminary value stands.
 * Every point is the centre of one grid cell (feeds/cellCache.ts cellCentre).
 */
export async function fetchChirpsCells(
	http: FeedHttp,
	points: readonly { lat: number; lon: number }[],
	start: string,
	plan: string,
	product: 'sat' | 'rnl',
	opts: { concurrency?: number; today?: string } = {}
): Promise<CellDays> {
	const concurrency = opts.concurrency ?? 6;
	const s = toEpochDay(start);
	const days = Array.from({ length: plan.length }, (_, i) => fromEpochDay(s + i));
	const today = toEpochDay(opts.today ?? fromEpochDay(s + plan.length));
	const reads: ({ kind: 'f' | 'p'; v: (number | null)[]; tag: string | null } | null)[] = new Array(plan.length).fill(null);
	const want = days.map((_, i) => i).filter((i) => plan[i] !== DAY_SKIP);
	if (product === 'rnl') {
		await mapLimit(want, concurrency, async (i) => {
			const r = await gridValuesTagged(http, chirpsRnlUrl(days[i]!), points);
			if (r) reads[i] = { kind: 'f', v: r.values, tag: r.tag };
		});
	} else {
		for (let probed = 0, size = 1; probed < want.length; size = concurrency) {
			const idx = want.slice(probed, probed + size);
			const batch = await mapLimit(idx, concurrency, (i) => gridValuesTagged(http, chirpsFinalUrl(days[i]!), points));
			batch.forEach((r, k) => {
				if (r) reads[idx[k]!] = { kind: 'f', v: r.values, tag: r.tag };
			});
			probed += idx.length;
			if (batch.at(-1) === null && !finalExpected(days[idx.at(-1)!]!, today)) break;
		}
		const prelim = want.filter((i) => reads[i] === null && plan[i] === DAY_READ);
		await mapLimit(prelim, concurrency, async (i) => {
			const v = await gridValues(http, chirpsPrelimUrl(days[i]!), points);
			if (v) reads[i] = { kind: 'p', v, tag: null };
		});
	}
	return {
		startDate: start,
		read: reads.map((r) => (r ? r.kind : '-')).join(''),
		values: points.map((_, c) => reads.map((r) => (r ? (r.v[c] ?? Number.NaN) : null))),
		tags: reads.map((r) => (r?.kind === 'f' ? r.tag : null))
	};
}

/** The final file of `day` for a CHIRPS v3 daily product. */
export const chirpsFinalFileUrl = (product: 'sat' | 'rnl', day: string) => (product === 'rnl' ? chirpsRnlUrl(day) : chirpsFinalUrl(day));

/** What a re-check of cached finals found (feeds/cellCache.ts, docs/architecture.md § Data feeds → Re-checking finals). */
export interface RecheckDays {
	/** Each file HEADed: its tag now, null when it is gone or has none. */
	head: { day: string; tag: string | null }[];
	/** Each day read again: its final file's tag and each point's value (NaN = no data), or values null when the file is gone. */
	read: { day: string; tag: string | null; values: number[] | null }[];
	/** HEADs and reads that failed (left out of the two lists above). */
	failed: number;
}

/**
 * Re-check cached CHIRPS finals: HEAD the final file of each `head` day (a
 * request with no body: only its tag comes back), and read each `read` day's
 * final file at `points` (the cells' centres), as a fetch reads a final.
 * Only final files: a preliminary one is replaced by its final anyway.
 *
 * A day that fails (the source unreachable, a file rewritten while read, an
 * implausible value) is left out of the answer rather than failing the
 * feed's fetch: the re-check is a side job, and its claim simply comes due
 * again (a stale day at the feed's next fetch, a file after its interval).
 */
export async function recheckChirpsFinals(
	http: FeedHttp,
	points: readonly { lat: number; lon: number }[],
	product: 'sat' | 'rnl',
	head: readonly string[],
	read: readonly string[],
	concurrency = 6
): Promise<RecheckDays> {
	const settle = async <T>(f: () => Promise<T>): Promise<T | null> => {
		try {
			return await f();
		} catch {
			return null;
		}
	};
	const heads = await mapLimit(head, concurrency, (day) =>
		settle(async () => ({ day, tag: http.head ? ((await http.head(chirpsFinalFileUrl(product, day)))?.tag ?? null) : null }))
	);
	const reads = await mapLimit(read, concurrency, (day) =>
		settle(async () => {
			const r = await gridValuesTagged(http, chirpsFinalFileUrl(product, day), points);
			return r ? { day, tag: r.tag, values: r.values.map((v) => v ?? Number.NaN) } : { day, tag: null, values: null };
		})
	);
	const kept = <T>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null);
	const h = kept(heads);
	const r = kept(reads);
	return { head: h, read: r, failed: head.length + read.length - h.length - r.length };
}

export interface Forecast {
	issued: string;
	startDate: string;
	values: (number | null)[];
}

/**
 * The newest **complete** CHIRPS-GEFS forecast issued on `today` or the day
 * before (the day's issue appears around 08:30 UTC), or null when neither is
 * out at all.
 *
 * An issue is used whole or not at all. CHC writes its 16 files one after
 * another over a minute or so, so a fetch can catch the leading days only;
 * merging those would leave the older issue's tail in the series (two issues
 * mixed) until the next fetch, a day later. So a partly published issue gives
 * way to yesterday's complete one, and when neither is complete the fetch
 * fails as unavailable, which retries in 15 minutes.
 */
export async function fetchGefs(http: FeedHttp, cells: readonly Cell[], today: string, concurrency = 6, noData?: NoDataPolicy): Promise<Forecast | null> {
	let partial: { issued: string; days: number } | null = null;
	for (const back of [0, 1]) {
		const issued = fromEpochDay(toEpochDay(today) - back);
		const first = await gridMean(http, gefsUrl(issued, issued), cells, noData);
		if (first === null) continue;
		const rest = await mapLimit(
			Array.from({ length: GEFS_DAYS - 1 }, (_, i) => fromEpochDay(toEpochDay(issued) + i + 1)),
			concurrency,
			(day) => gridMean(http, gefsUrl(issued, day), cells, noData)
		);
		const values = [first, ...rest];
		if (values.every((v) => v !== null)) return { issued, startDate: issued, values };
		partial ??= { issued, days: values.filter((v) => v !== null).length };
	}
	if (partial) {
		throw new FeedUnavailableError(
			`the newest forecast (issued ${partial.issued}) is still being published: ${partial.days} of its ${GEFS_DAYS} days are out`
		);
	}
	return null;
}
