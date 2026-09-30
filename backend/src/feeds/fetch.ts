// One fetch of one feed: which days to ask for (fetchWindow), and asking
// (runFetch). The fetch needs no database, so the same code runs inline in the
// local worker (FEED_FETCHER=inline) and in the production fetcher Lambda,
// which has internet but no VPC (lambda-fetcher.ts).
//
// A FetchResult is what crosses from the fetcher back to the database. In
// production it rides the `ingest-results` queue, so the worker treats it as
// untrusted input and validates it (FetchResult below) before anything merges.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { z } from 'zod';
import { chirpsProduct, configSchema, type DwsConfig, type FeedConfig, type FeedSource, FEED_SOURCES, type GridConfig } from './config.js';
import { FEED_ERROR_MAX, feedErrorMessage, FeedFormatError } from './errors.js';
import type { FeedHttp } from './http.js';
import { fetchChirps, fetchGefs } from './sources/chirps.js';
import { dwsUrl, DWS_MAX_YEARS, parseDwsDaily } from './sources/dws.js';
import { MAX_SERIES_VALUES, SeriesStartDate } from '../series/limits.js';

/**
 * Today's date in UTC, the fetch plumbing's clock: which days to ask a source
 * for, the newest day it can have, and the schedule. CHIRPS and CHIRPS-GEFS
 * days are UTC days. A DWS day is a South African one, and UTC's today is
 * never after it, so bounding a window by it can only leave the newest day
 * for the next fetch, never ask for a day that can't exist yet. Nothing a
 * person reads is dated by it: a feed's health and the alerts count to the
 * project's own day (health.ts, alerts/evaluate.ts; projects/timeZone.ts).
 */
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
	/**
	 * CHIRPS: the feed's newest day, when it falls in the window (heldThrough
	 * below). A `sat` day on or before it with no final value out isn't read
	 * again (fetchChirps).
	 */
	heldThrough?: string;
}

/** The inclusive days one fetch asks for (FetchRequest's start and end). */
export interface FetchWindow {
	start: string;
	end: string;
}

/**
 * The days to ask for, from what the feed already has. A configured startDate
 * is a floor for every fetch, not just the first: the revision re-read never
 * reaches before it, where the target series may hold the owner's own data.
 *
 * `readThrough` is the last day the feed's previous successful fetch asked
 * for (data_feed.last_meta.through, written by the ingest from the window it
 * checked the answer against). The newest date alone can't mark progress
 * through days that have no data: a backfill starting before the station's
 * record, or a gap longer than one window, would ask for the same empty
 * window forever (issue #29). So when the window would end without reaching
 * a day after readThrough, it starts from readThrough instead (less the
 * revision re-read, as it would from the newest date). A caught-up feed,
 * whose window reaches past readThrough anyway, is unchanged.
 *
 * `finalThrough` (CHIRPS only; data_feed.last_meta.finalThrough, kept by the
 * ingest) is the last day through which the feed's series holds final CHIRPS
 * values, every day from before its latest window on. A final value is never
 * revised, so the revision re-read starts after it instead of re-reading
 * those days every fetch (issue #69): the window starts at finalThrough + 1
 * when that is later, never after the window's end (all final through
 * yesterday leaves a one-day window, the cheapest valid request), and the
 * 120-day cap counts from there. The startDate floor still holds, since the
 * marker only ever moves the start later.
 */
export function fetchWindow(
	source: FeedSource,
	config: FeedConfig,
	lastDataDate: string | null,
	today: string,
	readThrough: string | null = null,
	finalThrough: string | null = null
): FetchWindow {
	const from = (revisionDays: number, firstDays: number, maxDays: number, newest: string) => {
		let start = lastDataDate ? addDays(lastDataDate, -revisionDays) : (config.startDate ?? addDays(today, -firstDays));
		if (readThrough && readThrough < newest && addDays(start, maxDays - 1) <= readThrough) start = addDays(readThrough, 1 - revisionDays);
		return config.startDate && start < config.startDate ? config.startDate : start;
	};
	switch (source) {
		case 'chirps': {
			const end = addDays(today, -1);
			let start = from(CHIRPS_REVISION_DAYS, CHIRPS_FIRST_DAYS, CHIRPS_MAX_DAYS, end);
			if (finalThrough && finalThrough >= start && start <= end) start = finalThrough < end ? addDays(finalThrough, 1) : end;
			const capped = toEpochDay(end) - toEpochDay(start) + 1 > CHIRPS_MAX_DAYS ? addDays(start, CHIRPS_MAX_DAYS - 1) : end;
			return { start, end: capped };
		}
		case 'chirps_gefs':
			return { start: today, end: addDays(today, 15) };
		case 'dws': {
			const start = from(DWS_REVISION_DAYS, 365 * DWS_FIRST_YEARS, 365 * DWS_MAX_YEARS, today);
			const limit = addDays(start, 365 * DWS_MAX_YEARS - 1);
			return { start, end: limit < today ? limit : today };
		}
	}
}

/**
 * What a CHIRPS fetch may skip as already held: the last day D such that
 * every day from the window's first through D holds a value in `series`, the
 * series the answer will merge into (store.ts heldSeries: its days from the
 * window's first on). Not the feed's newest day: a day before it can be
 * empty (published late, deleted, or a gap the merge kept), and a skipped
 * day is never filled until its final is out. None for another source, an
 * empty window, or when the first day holds nothing.
 */
export function heldThrough(source: FeedSource, window: FetchWindow, series: { startDate: string; values: (number | null)[] } | null): string | undefined {
	if (source !== 'chirps' || series === null || window.start > window.end) return undefined;
	const from = toEpochDay(window.start) - toEpochDay(series.startDate);
	if (from < 0) return undefined;
	const last = Math.min(toEpochDay(window.end) - toEpochDay(series.startDate), series.values.length - 1);
	let i = from;
	while (i <= last && series.values[i] !== null && series.values[i] !== undefined) i++;
	return i > from ? addDays(series.startDate, i - 1) : undefined;
}

/** Text Postgres will store: it refuses U+0000 in text and in jsonb. */
const StoredText = (max: number) => z.string().max(max).refine((s) => !s.includes('\u0000'), 'contains U+0000');
/**
 * The most bytes of meta JSON a result may carry: data_feed.last_meta holds at
 * most 4096 (018_feeds.sql CHECK), and the ingest adds `merged`, `kept`, `through` and `finalThrough`, and jsonb's
 * text form adds a space after each colon and comma. The per-field limits
 * alone allow ~8.5 KB of multi-byte characters.
 */
export const FEED_META_MAX_BYTES = 3072;

/** The fetcher's answer: days to merge (nulls are gaps, never erasures), or a failure. */
export const FetchResult = z.discriminatedUnion('ok', [
	z
		.object({
			ok: z.literal(true),
			/** Null (with no values) when the source had nothing for the window. */
			startDate: SeriesStartDate.nullable(),
			values: z.array(z.number().finite().nonnegative().nullable()).max(MAX_SERIES_VALUES),
			/** What the source said about the data, for the status panel. Small and flat. */
			meta: z
				.record(StoredText(40), z.union([StoredText(100), z.number().finite()]))
				.refine((m) => Object.keys(m).length <= 20)
				.refine((m) => Buffer.byteLength(JSON.stringify(m)) <= FEED_META_MAX_BYTES, `meta is over ${FEED_META_MAX_BYTES} bytes`)
		})
		.strict()
		.refine((r) => (r.startDate === null) === (r.values.length === 0), 'startDate goes with values'),
	z.object({ ok: z.literal(false), error: StoredText(FEED_ERROR_MAX).min(1) }).strict()
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
		today: SeriesStartDate,
		heldThrough: SeriesStartDate.optional()
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
		// Only as the feed_fetch job gives it: a CHIRPS sat day inside the window (rnl has no preliminary days).
		if (v.heldThrough !== undefined && (v.source !== 'chirps' || chirpsProduct(config.data) !== 'sat' || v.heldThrough < v.start || v.heldThrough > v.end)) {
			ctx.addIssue({ code: 'custom', path: ['heldThrough'], message: 'not a CHIRPS sat day inside the window' });
			return z.NEVER;
		}
		return { ...v, config: config.data };
	});

/** Run one fetch. Never throws: a failure is a result, with a message written by us. */
export async function runFetch(req: FetchRequest, http: FeedHttp): Promise<FetchResult> {
	try {
		switch (req.source) {
			case 'chirps': {
				const product = chirpsProduct(req.config);
				const r = await fetchChirps(http, (req.config as GridConfig).cells, req.start, req.end, product, { heldThrough: req.heldThrough ?? null, today: req.today });
				// Held preliminary days not read again still count (the feed card's "N preliminary days").
				if (!r.values.length) return { ok: true, startDate: null, values: [], meta: r.prelimDays ? { days: 0, prelimDays: r.prelimDays, product } : { days: 0, product } };
				const meta: Record<string, string | number> = { days: r.values.length, prelimDays: r.prelimDays, product };
				if (r.finalThrough) meta.finalThrough = r.finalThrough;
				return { ok: true, startDate: r.startDate, values: r.values, meta };
			}
			case 'chirps_gefs': {
				const r = await fetchGefs(http, (req.config as GridConfig).cells, req.today);
				if (!r) throw new FeedFormatError('no forecast was issued today or yesterday');
				return { ok: true, startDate: r.startDate, values: r.values, meta: { days: r.values.length, issued: r.issued } };
			}
			case 'dws': {
				const page = await http.text(dwsUrl((req.config as DwsConfig).station, req.start, req.end));
				if (page === null) throw new FeedFormatError('the DWS page was not found');
				// Never a day after today: the feed's newest day drives its next window and its health.
				const r = parseDwsDaily(page, { start: req.start, end: req.end < req.today ? req.end : req.today });
				const meta: Record<string, string | number> = { days: r.values.length, gaps: r.values.filter((v) => v === null).length };
				if (r.rejected) meta.rejected = r.rejected;
				if (r.outside) meta.outside = r.outside;
				for (const [code, n] of Object.entries(r.quality).slice(0, 10)) meta[`quality ${code.slice(0, 20)}`] = n;
				return r.startDate === null ? { ok: true, startDate: null, values: [], meta } : { ok: true, startDate: r.startDate, values: r.values, meta };
			}
		}
	} catch (err) {
		if (!(err instanceof Error) || !/^Feed(Format|Unavailable)Error$/.test(err.name)) console.error('feed fetch failed:', err);
		return { ok: false, error: feedErrorMessage(err) };
	}
}
