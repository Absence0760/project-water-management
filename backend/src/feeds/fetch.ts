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
import { chirpsProduct, configSchema, type DwsConfig, type FeedConfig, type FeedSource, FEED_SOURCES, type GridConfig, gridCells } from './config.js';
import { FEED_ERROR_MAX, feedErrorMessage, FeedFormatError, FeedNoDataError } from './errors.js';
import type { FeedHttp } from './http.js';
import { CELL_VALUE_MAX_BITS, CHC_COLS, CHC_ROWS, cellCentre, encodeCellValue, RECHECK_HEAD_DAYS, RECHECK_READ_DAYS } from './cellCache.js';
import { BBOX_MAX_CELLS, BBOX_MAX_ROWS, CHIRPS_DAILY_PRODUCTS, CHIRPS_PRODUCT_FIRST_DAY } from './config.js';
import { FILE_TAG_MAX, FILE_TAG_RE } from './http.js';
import { cellsUsed, fetchChirps, fetchChirpsCells, fetchGefs, type NoDataPolicy, recheckChirpsFinals } from './sources/chirps.js';
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
	 * CHIRPS through the cell cache (feeds/cellCache.ts planFetch, what every
	 * feed_fetch job sends since 208_chirps_cell_cache): the grid cells to
	 * read, as [row, column], and one DAY_* character per day of the window.
	 * The answer is each cell's own values (CellsResult), never the mean.
	 */
	cells?: { cells: [number, number][]; plan: string };
	/**
	 * CHIRPS, with `cells` only: the re-check of cached finals CHC may have
	 * rewritten in place (feeds/cellCache.ts RECHECK_*, claimed by the fetch
	 * job, 210_chirps_final_recheck): the final files to HEAD, and the days to
	 * read again at the feed's cells (all of them, [row, column]). Answered in
	 * CellsResult's `recheck`.
	 */
	recheck?: { cells: [number, number][]; head: string[]; read: string[] };
	/**
	 * A CHIRPS request without `cells`, from a worker before the cell cache
	 * (one still in flight while a release rolls out): the feed's newest day,
	 * when it falls in the window. A `sat` day on or before it with no final
	 * value out isn't read again (fetchChirps). Answered with the mean, as
	 * before.
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

/** Text Postgres will store: it refuses U+0000 in text and in jsonb. */
const StoredText = (max: number) => z.string().max(max).refine((s) => !s.includes('\u0000'), 'contains U+0000');
/**
 * The most bytes of meta JSON a result may carry: data_feed.last_meta holds at
 * most 4096 (018_feeds.sql CHECK), and the ingest adds `merged`, `kept`, `through` and `finalThrough`, and jsonb's
 * text form adds a space after each colon and comma. The per-field limits
 * alone allow ~8.5 KB of multi-byte characters.
 */
export const FEED_META_MAX_BYTES = 3072;

/** What the source said about the data, for the status panel. Small and flat. */
const FetchMeta = z
	.record(StoredText(40), z.union([StoredText(100), z.number().finite()]))
	.refine((m) => Object.keys(m).length <= 20)
	.refine((m) => Buffer.byteLength(JSON.stringify(m)) <= FEED_META_MAX_BYTES, `meta is over ${FEED_META_MAX_BYTES} bytes`);

/** The fetcher's answer: days to merge (nulls are gaps, never erasures), or a failure. */
export const FetchResult = z.discriminatedUnion('ok', [
	z
		.object({
			ok: z.literal(true),
			/** Null (with no values) when the source had nothing for the window. */
			startDate: SeriesStartDate.nullable(),
			values: z.array(z.number().finite().nonnegative().nullable()).max(MAX_SERIES_VALUES),
			/** What the source said about the data, for the status panel. Small and flat. */
			meta: FetchMeta
		})
		.strict()
		.refine((r) => (r.startDate === null) === (r.values.length === 0), 'startDate goes with values'),
	z.object({ ok: z.literal(false), error: StoredText(FEED_ERROR_MAX).min(1) }).strict()
]);
export type FetchResult = z.output<typeof FetchResult>;

/**
 * One cell's value in a CellsResult (feeds/cellCache.ts encodeCellValue): the
 * float32's bit pattern of 0–2000 mm, -1 for no data (the sea), null where
 * the day wasn't read.
 */
const CellValue = z.union([z.literal(-1), z.number().int().min(0).max(CELL_VALUE_MAX_BITS)]).nullable();
/** A file's tag (http.ts fileTag), as the fetcher reports it: checked again by the cache's functions (chirps_tag_ok). */
const FileTag = z.string().max(FILE_TAG_MAX).regex(FILE_TAG_RE);
const CellGrid = z.tuple([z.number().int().min(0).max(CHC_ROWS - 1), z.number().int().min(0).max(CHC_COLS - 1)]);
/** Days of a re-check: each once, in order. */
const RecheckDays = (max: number) =>
	z
		.array(SeriesStartDate)
		.max(max)
		.refine((ds) => ds.every((d, i) => i === 0 || d > ds[i - 1]!), 'each day once, in order');

/**
 * The fetcher's answer to a request with `cells`: each cell's own values,
 * which the worker merges into the shared cell cache (feeds/cellCacheStore.ts)
 * before computing the feed's days from it. Untrusted like every answer: the
 * shape is checked here, the days against the window and the cells against
 * the feed's in the ingest, and every value again by the cache's merge
 * function (208_chirps_cell_cache.sql chirps_cache_merge).
 *
 * Size: at most 100 cells × 120 days, a value at most ten digits of JSON, so
 * the largest answer is about 135 KB, inside SQS's 256 KB with the envelope
 * and the meta (fetch.test.ts checks the worst case).
 */
export const CellsResult = z
	.object({
		ok: z.literal(true),
		cells: z
			.object({
				product: z.enum(CHIRPS_DAILY_PRODUCTS),
				startDate: SeriesStartDate,
				/** Per day: `f` read from the final file, `p` the preliminary, `-` not read. */
				read: z.string().regex(/^[-fp]*$/).max(CHIRPS_MAX_DAYS),
				/** [row, column] of the CHC grid. */
				cells: z.array(z.tuple([z.number().int().min(0).max(CHC_ROWS - 1), z.number().int().min(0).max(CHC_COLS - 1)])).max(BBOX_MAX_CELLS),
				/** Per cell, per day of `read`. */
				values: z.array(z.array(CellValue).max(CHIRPS_MAX_DAYS)).max(BBOX_MAX_CELLS),
				/** Per day of `read`: the final file's tag on an `f` day, else null. Absent from a fetcher before 210. */
				tags: z.array(FileTag.nullable()).max(CHIRPS_MAX_DAYS).optional()
			})
			.strict()
			.superRefine((c, ctx) => {
				const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
				if (c.tags && (c.tags.length !== c.read.length || c.tags.some((t, d) => t !== null && c.read[d] !== 'f'))) return bad('a tag on a final day only, one per day');
				if (c.values.length !== c.cells.length) return bad('one row of values per cell');
				if (new Set(c.cells.map(([r, k]) => `${r},${k}`)).size !== c.cells.length) return bad('a cell is listed twice');
				if (c.product === 'rnl' && c.read.includes('p')) return bad('rnl has no preliminary files');
				for (const row of c.values) {
					if (row.length !== c.read.length) return bad('one value per day');
					// A day read gives every cell a value or no data; a day not read gives none.
					for (let d = 0; d < row.length; d++) if ((row[d] === null) !== (c.read[d] === '-')) return bad('a value for exactly the days read');
				}
			}),
		/**
		 * The re-check the request asked for (FetchRequest.recheck): each HEADed
		 * file's tag, and each day read again with a value per cell (in the
		 * request's cells' order, encoded as above, never null), or none when
		 * the file is gone. Which days were asked for is the worker's to check
		 * (210 chirps_recheck_apply takes only the days the fetch claimed or
		 * the feed's cells hold stale).
		 */
		recheck: z
			.object({
				head: z.array(z.object({ day: SeriesStartDate, tag: FileTag.nullable() }).strict()).max(RECHECK_HEAD_DAYS),
				read: z
					.array(
						z
							.object({ day: SeriesStartDate, tag: FileTag.nullable(), values: z.array(CellValue.unwrap()).max(BBOX_MAX_CELLS).nullable() })
							.strict()
							.refine((r) => r.values !== null || r.tag === null, 'no tag for a file that is gone')
					)
					.max(RECHECK_READ_DAYS)
			})
			.strict()
			.refine((r) => r.head.every((h, i) => i === 0 || h.day > r.head[i - 1]!.day) && r.read.every((h, i) => i === 0 || h.day > r.read[i - 1]!.day), 'each day once, in order')
			.optional(),
		meta: FetchMeta
	})
	.strict();
export type CellsResult = z.output<typeof CellsResult>;

/** What the fetcher answers: a CHIRPS request with `cells` gets a CellsResult, every other request a FetchResult. */
export type FetchAnswer = FetchResult | CellsResult;

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
		heldThrough: SeriesStartDate.optional(),
		cells: z
			.object({
				cells: z
					.array(z.tuple([z.number().int().min(0).max(CHC_ROWS - 1), z.number().int().min(0).max(CHC_COLS - 1)]))
					.min(1)
					.max(BBOX_MAX_CELLS)
					// The same read cost as a feed's own cells: one strip per grid row per day.
					.refine((cs) => new Set(cs.map(([r]) => r)).size <= BBOX_MAX_ROWS, `at most ${BBOX_MAX_ROWS} grid rows`)
					.refine((cs) => new Set(cs.map(([r, c]) => `${r},${c}`)).size === cs.length, 'a cell is listed twice'),
				plan: z.string().regex(/^[012]+$/)
			})
			.strict()
			.optional(),
		recheck: z
			.object({
				cells: z
					.array(CellGrid)
					.min(1)
					.max(BBOX_MAX_CELLS)
					.refine((cs) => new Set(cs.map(([r]) => r)).size <= BBOX_MAX_ROWS, `at most ${BBOX_MAX_ROWS} grid rows`)
					.refine((cs) => new Set(cs.map(([r, c]) => `${r},${c}`)).size === cs.length, 'a cell is listed twice'),
				head: RecheckDays(RECHECK_HEAD_DAYS),
				read: RecheckDays(RECHECK_READ_DAYS)
			})
			.strict()
			.optional()
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
		// The cell cache's plan: CHIRPS only, one character per day of the window, never with heldThrough.
		if (v.cells !== undefined && (v.source !== 'chirps' || v.heldThrough !== undefined || v.cells.plan.length !== Math.max(0, days))) {
			ctx.addIssue({ code: 'custom', path: ['cells'], message: 'not a CHIRPS plan of one day per day of the window' });
			return z.NEVER;
		}
		// The re-check goes with a cell-cache request, and asks only for final files the product can have by today.
		if (v.recheck !== undefined) {
			const first = CHIRPS_PRODUCT_FIRST_DAY[chirpsProduct(config.data as GridConfig)];
			const days = [...v.recheck.head, ...v.recheck.read];
			if (v.cells === undefined || days.some((d) => d < first || d > v.today) || new Set(days).size !== days.length) {
				ctx.addIssue({ code: 'custom', path: ['recheck'], message: 'not a re-check of final files the product has' });
				return z.NEVER;
			}
		}
		if (v.cells !== undefined && chirpsProduct(config.data) === 'rnl' && v.cells.plan.includes('2')) {
			ctx.addIssue({ code: 'custom', path: ['cells'], message: 'rnl has no preliminary days to hold' });
			return z.NEVER;
		}
		return { ...v, config: config.data };
	});

/**
 * The cells a grid feed reads, and for a box with skipNoData its no-data
 * policy and `cellsUsed` for the meta: how many of the box's cells had data.
 * The sea mask is static, so that count changing from one fetch to the next
 * means the grid itself changed (docs/architecture.md § Data feeds).
 */
export function gridRead(config: GridConfig): { cells: ReturnType<typeof gridCells>; noData?: NoDataPolicy; used: () => { cellsUsed?: number } } {
	const cells = gridCells(config);
	if (!(config.bbox && config.skipNoData)) return { cells, used: () => ({}) };
	const noData: NoDataPolicy = { mask: null };
	return { cells, noData, used: () => (cellsUsed(noData) === null ? {} : { cellsUsed: cellsUsed(noData)! }) };
}

/** Run one fetch. Never throws: a failure is a result, with a message written by us. */
export async function runFetch(req: FetchRequest, http: FeedHttp): Promise<FetchAnswer> {
	try {
		switch (req.source) {
			case 'chirps': {
				const product = chirpsProduct(req.config);
				if (req.cells) {
					// The cell cache's fetch: each planned cell's own values, read at its centre.
					const cells = req.cells.cells;
					const r = await fetchChirpsCells(http, cells.map(([row, col]) => cellCentre({ row, col })), req.start, req.cells.plan, product, { today: req.today });
					const read = [...r.read].filter((d) => d !== '-').length;
					const answer: CellsResult = {
						ok: true,
						cells: { product, startDate: r.startDate, read: r.read, cells, values: r.values.map((row) => row.map(encodeCellValue)), tags: r.tags },
						meta: { product, daysRead: read, cellDaysRead: read * cells.length }
					};
					if (req.recheck) {
						const rc = req.recheck;
						const got = await recheckChirpsFinals(http, rc.cells.map(([row, col]) => cellCentre({ row, col })), product, rc.head, rc.read);
						answer.recheck = { head: got.head, read: got.read.map((d) => ({ ...d, values: d.values && d.values.map((v) => encodeCellValue(v)!) })) };
						// A failed HEAD or read is left out (its claim comes due again) and counted, never failing the feed's own fetch.
						answer.meta = { ...answer.meta, filesChecked: got.head.length, recheckDaysRead: got.read.filter((d) => d.values).length, ...(got.failed ? { recheckFailed: got.failed } : {}) };
					}
					return answer;
				}
				const { cells, noData, used } = gridRead(req.config as GridConfig);
				const r = await fetchChirps(http, cells, req.start, req.end, product, { heldThrough: req.heldThrough ?? null, today: req.today, noData });
				// Held preliminary days not read again still count (the feed card's "N preliminary days").
				if (!r.values.length) return { ok: true, startDate: null, values: [], meta: r.prelimDays ? { days: 0, prelimDays: r.prelimDays, product } : { days: 0, product } };
				const meta: Record<string, string | number> = { days: r.values.length, prelimDays: r.prelimDays, product, ...used() };
				if (r.finalThrough) meta.finalThrough = r.finalThrough;
				return { ok: true, startDate: r.startDate, values: r.values, meta };
			}
			case 'chirps_gefs': {
				const { cells, noData, used } = gridRead(req.config as GridConfig);
				const r = await fetchGefs(http, cells, req.today, undefined, noData);
				if (!r) throw new FeedFormatError('no forecast was issued today or yesterday');
				return { ok: true, startDate: r.startDate, values: r.values, meta: { days: r.values.length, issued: r.issued, ...used() } };
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
		return fetchFailure(err, req.config);
	}
}

/**
 * A fetch's failure as a result, with our message: what runFetch answers, and
 * what the ingest records when a feed's days computed from the cell cache
 * fail the same checks (feeds/ingest.ts, cellCache.ts seriesFromCache).
 */
export function fetchFailure(err: unknown, config: FeedConfig): Extract<FetchResult, { ok: false }> {
	if (!(err instanceof Error) || !/^Feed(Format|Unavailable)Error$/.test(err.name)) console.error('feed fetch failed:', err);
	// A box skips a sea cell only when asked to (skipNoData): otherwise it would quietly shrink the area the mean is over.
	if (err instanceof FeedNoDataError && 'bbox' in config && config.bbox && !config.skipNoData) {
		return { ok: false, error: feedErrorMessage(new FeedFormatError(`${err.message}, inside the bounding box: shrink the box to the land, list the cells instead, or let the feed leave out sea cells (skipNoData)`)) };
	}
	return { ok: false, error: feedErrorMessage(err) };
}
