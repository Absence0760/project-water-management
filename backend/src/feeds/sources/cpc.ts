// NOAA CPC's climate indices (issue #620, docs/data-sources.md
// § climate-indices): the Oceanic Niño Index (ONI) and the monthly Antarctic
// Oscillation (AAO, CPC's index of the Southern Annular Mode). US-government
// work, public domain; CPC asks that the series be credited. The fetcher's
// indices pass (ingest/indices.ts) copies both into the data mirror for the
// seasonal outlook's climate-state analogues (engine outlook/climate.ts).
//
// Two plain-text files, each fetched whole (a few tens of kB):
//   ONI  `SEAS  YR  TOTAL  ANOM`, one row per overlapping 3-month season,
//        `DJF 1950 …` to the newest. Kept under the season's centre month
//        (DJF → January of YR, NDJ → December of YR: CPC labels a season by
//        its centre month's year).
//   AAO  `YYYY  M  value`, one row per month from January 1979.
// Both are parsed strictly: a row that isn't one, a season label out of
// place, a month twice or out of order, or a value outside the physical
// range refuses the whole file (FeedFormatError), so a changed page is
// noticed rather than half read.
import type { MonthlyIndexSeries } from '@water-management/engine';
import { FeedFormatError } from '../errors.js';

export const CPC_BASE = 'https://www.cpc.ncep.noaa.gov';
export const ONI_URL = `${CPC_BASE}/data/indices/oni.ascii.txt`;
export const AAO_URL = `${CPC_BASE}/products/precip/CWlink/daily_ao_index/aao/monthly.aao.index.b79.current.ascii`;

/** The 3-month season labels in order of their centre month (January … December). */
export const ONI_SEASONS = ['DJF', 'JFM', 'FMA', 'MAM', 'AMJ', 'MJJ', 'JJA', 'JAS', 'ASO', 'SON', 'OND', 'NDJ'] as const;

/** Each index's checks: the physical range, and the earliest first month we accept (a much shorter file is a changed one). */
export const CPC_INDEX_LIMITS = {
	oni: { min: -5, max: 5, firstBy: '1950-01' },
	aao: { min: -8, max: 8, firstBy: '1979-01' }
} as const;

/** The most bytes a file may be (both are under 40 kB today). */
export const CPC_FILE_MAX_BYTES = 512 * 1024;

const ym = (i: number) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;

/** Monthly values, in order with no month twice and no gap, into a series. */
function toSeries(id: 'oni' | 'aao', rows: { month: number; value: number }[]): MonthlyIndexSeries {
	const lim = CPC_INDEX_LIMITS[id];
	if (!rows.length) throw new FeedFormatError(`the ${id.toUpperCase()} file holds no values`);
	for (let i = 1; i < rows.length; i++) {
		if (rows[i]!.month !== rows[i - 1]!.month + 1) throw new FeedFormatError(`the ${id.toUpperCase()} file's months are not one after another (at ${ym(rows[i]!.month)})`);
	}
	for (const r of rows) {
		if (!(r.value >= lim.min && r.value <= lim.max)) throw new FeedFormatError(`the ${id.toUpperCase()} file has ${r.value} for ${ym(r.month)}, outside ${lim.min} to ${lim.max}`);
	}
	if (ym(rows[0]!.month) > lim.firstBy) throw new FeedFormatError(`the ${id.toUpperCase()} file starts at ${ym(rows[0]!.month)}, later than ${lim.firstBy}`);
	return { id, firstMonth: ym(rows[0]!.month), values: rows.map((r) => r.value) };
}

const NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

/** CPC's oni.ascii.txt into a monthly series, each season under its centre month. */
export function parseOni(text: string): MonthlyIndexSeries {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (!/^SEAS\s+YR\s+TOTAL\s+ANOM$/.test(lines[0] ?? '')) throw new FeedFormatError('the ONI file does not start with its SEAS YR TOTAL ANOM header');
	const rows = lines.slice(1).map((l) => {
		const f = l.split(/\s+/);
		const k = ONI_SEASONS.indexOf(f[0] as (typeof ONI_SEASONS)[number]);
		if (f.length !== 4 || k < 0 || !/^\d{4}$/.test(f[1]!) || !NUMBER.test(f[2]!) || !NUMBER.test(f[3]!)) throw new FeedFormatError('the ONI file has a row that is not a season, a year and two values');
		return { month: Number(f[1]) * 12 + k, value: Number(f[3]) };
	});
	return toSeries('oni', rows);
}

/** CPC's monthly AAO file into a monthly series. */
export function parseAao(text: string): MonthlyIndexSeries {
	const rows = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const f = l.split(/\s+/);
			if (f.length !== 3 || !/^\d{4}$/.test(f[0]!) || !/^(?:[1-9]|1[0-2])$/.test(f[1]!) || !NUMBER.test(f[2]!)) throw new FeedFormatError('the AAO file has a row that is not a year, a month and a value');
			return { month: Number(f[0]) * 12 + Number(f[1]) - 1, value: Number(f[2]) };
		});
	return toSeries('aao', rows);
}

// --- The synthetic files FEED_SOURCE=fixtures serves (feeds/fixtures.ts) ------------------
// Invented values, not NOAA's: smooth sums of sines of the month count, so
// every year differs and both indices swing through both signs. Re-dated to
// "today" as CPC publishes: the ONI season centred two months before today's
// month is the newest (JAS is out in October), the AAO's month before today's.

/** The synthetic ONI for a month (year, month 1–12). */
export function oniFixtureValue(y: number, m: number): number {
	const t = y * 12 + m;
	return Math.round((1.1 * Math.sin((2 * Math.PI * t) / 47) + 0.55 * Math.sin((2 * Math.PI * t) / 29 + 1) + 0.2 * Math.sin((2 * Math.PI * t) / 11 + 2)) * 100) / 100;
}

/** The synthetic AAO for a month. */
export function aaoFixtureValue(y: number, m: number): number {
	const t = y * 12 + m;
	return Math.round((0.9 * Math.sin((2 * Math.PI * t) / 7 + 0.5) + 0.7 * Math.sin((2 * Math.PI * t) / 23) + 0.5 * Math.sin((2 * Math.PI * t) / 3.3 + 1)) * 10000) / 10000;
}

/** The newest month (index) each synthetic file holds on `today` (ISO). */
export function fixtureThrough(id: 'oni' | 'aao', today: string): number {
	const m = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
	return id === 'oni' ? m - 2 : m - 1;
}

/** The synthetic ONI file on `today`, in CPC's layout. */
export function oniFixtureText(today: string): string {
	const rows = ['SEAS  YR   TOTAL   ANOM'];
	for (let i = 1950 * 12; i <= fixtureThrough('oni', today); i++) {
		const y = Math.floor(i / 12);
		const v = oniFixtureValue(y, (i % 12) + 1);
		rows.push(`  ${ONI_SEASONS[i % 12]} ${y}  ${(27 + v).toFixed(2)}  ${v.toFixed(2)}`);
	}
	return `${rows.join('\n')}\n`;
}

/** The synthetic AAO file on `today`, in CPC's layout. */
export function aaoFixtureText(today: string): string {
	const rows: string[] = [];
	for (let i = 1979 * 12; i <= fixtureThrough('aao', today); i++) {
		const y = Math.floor(i / 12);
		rows.push(` ${y}    ${(i % 12) + 1}   ${aaoFixtureValue(y, (i % 12) + 1).toFixed(4)}`);
	}
	return `${rows.join('\n')}\n`;
}
