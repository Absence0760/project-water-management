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
import { FeedFormatError, FeedUnavailableError } from '../errors.js';
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
 * The weighted mean over `cells` of one grid file, or null when the file
 * isn't published (404). A cell over the sea, or outside the grid, is a
 * configuration error and fails the fetch rather than skewing the mean.
 */
export async function gridMean(http: FeedHttp, url: string, cells: readonly Cell[]): Promise<number | null> {
	const read = (start: number, end: number) => http.range(url, start, end);
	const grid = await openGrid(read);
	if (!grid) return null;
	const values = await readPoints(read, grid, cells);
	let sum = 0;
	let weights = 0;
	values.forEach((v, i) => {
		const c = cells[i]!;
		if (v === null) throw new FeedFormatError(`the grid has no data at ${c.lat}, ${c.lon} (the sea, or outside the product’s coverage)`);
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
	opts: { concurrency?: number; heldThrough?: string | null; today?: string } = {}
): Promise<GridDays> {
	const concurrency = opts.concurrency ?? 6;
	const heldThrough = opts.heldThrough ?? null;
	// Without a today, the day after the window: its last month is the one still being published.
	const today = toEpochDay(opts.today ?? fromEpochDay(toEpochDay(end) + 1));
	const s = toEpochDay(start);
	const days = Array.from({ length: Math.max(0, toEpochDay(end) - s + 1) }, (_, i) => fromEpochDay(s + i));
	let got: { v: number | null; prelim: boolean }[];
	let held = 0;
	if (product === 'rnl') {
		got = await mapLimit(days, concurrency, async (day) => ({ v: await gridMean(http, chirpsRnlUrl(day), cells), prelim: false }));
	} else {
		const finals = new Array<number | null>(days.length).fill(null);
		for (let probed = 0, size = 1; probed < days.length; size = concurrency) {
			const batch = await mapLimit(days.slice(probed, probed + size), concurrency, (day) => gridMean(http, chirpsFinalUrl(day), cells));
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
			const prelim = await gridMean(http, chirpsPrelimUrl(day), cells);
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
export async function fetchGefs(http: FeedHttp, cells: readonly Cell[], today: string, concurrency = 6): Promise<Forecast | null> {
	let partial: { issued: string; days: number } | null = null;
	for (const back of [0, 1]) {
		const issued = fromEpochDay(toEpochDay(today) - back);
		const first = await gridMean(http, gefsUrl(issued, issued), cells);
		if (first === null) continue;
		const rest = await mapLimit(
			Array.from({ length: GEFS_DAYS - 1 }, (_, i) => fromEpochDay(toEpochDay(issued) + i + 1)),
			concurrency,
			(day) => gridMean(http, gefsUrl(issued, day), cells)
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
