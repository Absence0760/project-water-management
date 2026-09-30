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
	const values = await readPoints(read, grid, cells);
	let sum = 0;
	let weights = 0;
	if (noData) {
		const mask = values.map((v) => (v === null ? '0' : '1')).join('');
		if (!mask.includes('1')) throw new FeedNoDataError('the grid has no data in any cell of the bounding box (all sea, or outside the product’s coverage)');
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

export interface GridDays {
	startDate: string;
	values: (number | null)[];
	/** Days read from the preliminary product (the rest are final). */
	prelimDays: number;
}

/**
 * CHIRPS for each day of [start, end] from one daily product: for `sat`, the
 * final value where it is out, else the preliminary one; for `rnl`, the final
 * value (it has no preliminary product); else null. Trailing days with
 * neither are dropped (not published yet); a day missing between published
 * ones stays null.
 */
export async function fetchChirps(
	http: FeedHttp,
	cells: readonly Cell[],
	start: string,
	end: string,
	product: 'sat' | 'rnl' = 'sat',
	concurrency = 6,
	noData?: NoDataPolicy
): Promise<GridDays> {
	const s = toEpochDay(start);
	const days = Array.from({ length: Math.max(0, toEpochDay(end) - s + 1) }, (_, i) => fromEpochDay(s + i));
	const got = await mapLimit(days, concurrency, async (day) => {
		if (product === 'rnl') return { v: await gridMean(http, chirpsRnlUrl(day), cells, noData), prelim: false };
		const final = await gridMean(http, chirpsFinalUrl(day), cells, noData);
		if (final !== null) return { v: final, prelim: false };
		const prelim = await gridMean(http, chirpsPrelimUrl(day), cells, noData);
		return { v: prelim, prelim: prelim !== null };
	});
	let last = got.length - 1;
	while (last >= 0 && got[last]!.v === null) last--;
	const kept = got.slice(0, last + 1);
	return { startDate: start, values: kept.map((g) => g.v), prelimDays: kept.filter((g) => g.prelim).length };
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
