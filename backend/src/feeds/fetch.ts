// One fetch of one feed: which days to ask for (fetchWindow), and asking
// (runFetch). The fetch needs no database, so the same code runs inline in the
// local worker (FEED_FETCHER=inline) and in the production fetcher Lambda,
// which has internet but no VPC (lambda-fetcher.ts).
//
// A FetchResult is what crosses from the fetcher back to the database. In
// production it rides the `ingest-results` queue, so the worker treats it as
// untrusted input and validates it (FetchResult below) before anything merges.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import { z } from 'zod';
import { configSchema, type DwsConfig, type FeedConfig, type FeedSource, FEED_SOURCES, type GridConfig } from './config.js';
import { FEED_ERROR_MAX, feedErrorMessage, FeedFormatError } from './errors.js';
import type { FeedHttp } from './http.js';
import { fetchChirps, fetchGefs } from './sources/chirps.js';
import { dwsUrl, DWS_MAX_YEARS, parseDwsDaily } from './sources/dws.js';
import { MAX_SERIES_VALUES, SeriesStartDate } from '../series/merge.js';

/** Today's date in UTC: CHIRPS days, DWS days and the schedule all count UTC calendar days. */
export const utcToday = (now = new Date()) => now.toISOString().slice(0, 10);

const addDays = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

/**
 * CHIRPS re-reads this many days before the newest it has, so a preliminary
 * day is overwritten by the final value once that is out (about three weeks
 * after the month ends).
 */
export const CHIRPS_REVISION_DAYS = 50;
/** The most CHIRPS days one fetch reads (a long backfill continues next time). */
export const CHIRPS_MAX_DAYS = 120;
/** First fetch, with no start date configured. */
export const CHIRPS_FIRST_DAYS = 60;
/** DWS re-reads a year: verified data is revised in arrears. */
export const DWS_REVISION_DAYS = 365;
export const DWS_FIRST_YEARS = 10;

export interface FetchRequest {
	source: FeedSource;
	config: FeedConfig;
	/** Inclusive; ignored by the forecast (which reads the newest issue). */
	start: string;
	end: string;
	today: string;
}

/** The days to ask for, from what the feed already has. */
export function fetchWindow(source: FeedSource, config: FeedConfig, lastDataDate: string | null, today: string): { start: string; end: string } {
	switch (source) {
		case 'chirps': {
			const end = addDays(today, -1);
			const start = lastDataDate ? addDays(lastDataDate, -CHIRPS_REVISION_DAYS) : (config.startDate ?? addDays(today, -CHIRPS_FIRST_DAYS));
			const capped = toEpochDay(end) - toEpochDay(start) + 1 > CHIRPS_MAX_DAYS ? addDays(start, CHIRPS_MAX_DAYS - 1) : end;
			return { start, end: capped };
		}
		case 'chirps_gefs':
			return { start: today, end: addDays(today, 15) };
		case 'dws': {
			const start = lastDataDate ? addDays(lastDataDate, -DWS_REVISION_DAYS) : (config.startDate ?? addDays(today, -365 * DWS_FIRST_YEARS));
			const limit = addDays(start, 365 * DWS_MAX_YEARS - 1);
			return { start, end: limit < today ? limit : today };
		}
	}
}

/**
 * The most UTF-8 bytes of JSON a result's meta may take. data_feed.last_meta
 * holds 4096 (018_feeds.sql CHECK) and ingest adds the merged count, so a
 * result that passed the key / length limits but not the column's byte limit
 * would fail its job on the CHECK instead of being refused as invalid.
 */
export const FETCH_META_MAX_BYTES = 3900;
const metaBytes = (m: object) => new TextEncoder().encode(JSON.stringify(m)).length;

/** The fetcher's answer: days to merge (nulls are gaps, never erasures), or a failure. */
export const FetchResult = z.discriminatedUnion('ok', [
	z
		.object({
			ok: z.literal(true),
			/** Null (with no values) when the source had nothing for the window. */
			startDate: SeriesStartDate.nullable(),
			values: z.array(z.number().finite().nonnegative().nullable()).max(MAX_SERIES_VALUES),
			/** What the source said about the data, for the status panel. Small and flat. */
			meta: z.record(z.string().max(40), z.union([z.string().max(100), z.number().finite()])).refine((m) => Object.keys(m).length <= 20 && metaBytes(m) <= FETCH_META_MAX_BYTES)
		})
		.strict()
		.refine((r) => (r.startDate === null) === (r.values.length === 0), 'startDate goes with values'),
	z.object({ ok: z.literal(false), error: z.string().min(1).max(FEED_ERROR_MAX) }).strict()
]);
export type FetchResult = z.output<typeof FetchResult>;

/** The longest window per source, as fetchWindow caps it (GEFS reads its 16 days whatever the window). */
const MAX_WINDOW_DAYS: Record<FeedSource, number> = { chirps: CHIRPS_MAX_DAYS, chirps_gefs: 16, dws: 365 * DWS_MAX_YEARS };

/** A fetch request as the fetcher Lambda receives it: the config is checked against its source's schema again. */
export const FetchRequestSchema = z
	.object({
		source: z.enum(FEED_SOURCES),
		config: z.unknown(),
		start: SeriesStartDate,
		end: SeriesStartDate,
		today: SeriesStartDate
	})
	.strict()
	.transform((v, ctx): FetchRequest => {
		const config = configSchema(v.source).safeParse(v.config);
		if (!config.success) {
			ctx.addIssue({ code: 'custom', path: ['config'], message: 'not a valid config for the source' });
			return z.NEVER;
		}
		// No more days than fetchWindow ever asks for: the fetcher is the
		// door to the internet, and a request is a message off a queue.
		const days = toEpochDay(v.end) - toEpochDay(v.start) + 1;
		if (days > MAX_WINDOW_DAYS[v.source]) {
			ctx.addIssue({ code: 'custom', path: ['end'], message: 'the window is longer than one fetch reads' });
			return z.NEVER;
		}
		return { ...v, config: config.data };
	});

/** Run one fetch. Never throws: a failure is a result, with a message written by us. */
export async function runFetch(req: FetchRequest, http: FeedHttp): Promise<FetchResult> {
	try {
		switch (req.source) {
			case 'chirps': {
				const r = await fetchChirps(http, (req.config as GridConfig).cells, req.start, req.end);
				return r.values.length
					? { ok: true, startDate: r.startDate, values: r.values, meta: { days: r.values.length, prelimDays: r.prelimDays } }
					: { ok: true, startDate: null, values: [], meta: { days: 0 } };
			}
			case 'chirps_gefs': {
				const r = await fetchGefs(http, (req.config as GridConfig).cells, req.today);
				if (!r) throw new FeedFormatError('no forecast was issued today or yesterday');
				return { ok: true, startDate: r.startDate, values: r.values, meta: { days: r.values.length, issued: r.issued } };
			}
			case 'dws': {
				const page = await http.text(dwsUrl((req.config as DwsConfig).station, req.start, req.end));
				if (page === null) throw new FeedFormatError('the DWS page was not found');
				const r = parseDwsDaily(page);
				const meta: Record<string, string | number> = { days: r.values.length, gaps: r.values.filter((v) => v === null).length };
				if (r.rejected) meta.rejected = r.rejected;
				for (const [code, n] of Object.entries(r.quality).slice(0, 10)) meta[`quality ${code.slice(0, 20)}`] = n;
				return r.startDate === null ? { ok: true, startDate: null, values: [], meta } : { ok: true, startDate: r.startDate, values: r.values, meta };
			}
		}
	} catch (err) {
		if (!(err instanceof Error) || !/^Feed(Format|Unavailable)Error$/.test(err.name)) console.error('feed fetch failed:', err);
		return { ok: false, error: feedErrorMessage(err) };
	}
}
