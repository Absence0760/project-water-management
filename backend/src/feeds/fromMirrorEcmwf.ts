// An ECMWF ENS forecast feed (`ecmwf_ens`) read from our copy (issue #604
// D17, R4-C; docs/architecture.md § Our copy of the rain data).
//
// There is no per-feed path to ECMWF: the Python ingest job copies each 00
// UTC run's total precipitation for the region (ingest/ecmwf_forecast.py: ensemble
// mean and p10/p50/p90 per 0.1° cell and day, `ecmwf/<issue>`, listed in
// `ecmwf/index.json` once whole), and every `ecmwf_ens` feed_fetch reads that
// copy in this job, whatever CHIRPS_SOURCE or FEED_FETCHER say. The rule is
// the GEFS one (fromMirrorGefs.ts): today's issue, else yesterday's.
//
// What a feed writes: the ensemble **mean**, day by day from the issue date
// (15 days), as the weighted mean of the 0.1° cells holding the feed's cells
// (each feed cell's centre, with its weight: a 0.05° box or list lands on the
// 0.1° cells under it), through the same arithmetic as CHIRPS-GEFS
// (sources/chirps.ts meanOf: weights, the same refusals, 0.01 mm). The
// result is the FetchResult a forecast gives (startDate the issue date, meta
// days/issued/cellsUsed), merged by the same ingestResult as CHIRPS-GEFS.
//
// Quantile mapping (D17, "quantile-mapped to our corrected rain"): when the
// copy holds `ecmwf/qm.json` (ingest/ecmwf_qm_fit.py, an offline fit by the
// operator), each day's value is mapped through the pairs of the group whose
// region holds the feed's centre and whose months hold that day's month
// (ingest/ecmwf.ts applyQm), and meta.calibration names the fit
// (`quantile-mapped <fittedAt>`). With no fit, or no group for the place and
// season, the value is the model's own and meta.calibration is
// `not yet calibrated`, which the feeds panel shows.
//
// When the copy holds neither today's nor yesterday's issue, the copy is
// behind, not the feed broken: nothing is written and the fetch records only
// that it looked (no failure, no backoff), as for GEFS; the operator's signal
// is MirrorLagDays{Product=ecmwf}. A cell outside the region fails the fetch
// with a message naming the region.
//
// Fixtures mode (FEED_SOURCE=fixtures, dev, CI and e2e): the committed copy
// (backend/fixtures/mirror/, scripts/ecmwf-fixture.ts) holds one invented
// issue over a 4 × 4 block of 0.1° cells; it is read as today's issue, and a
// cell anywhere maps onto the block by its position modulo 4, so a feed
// anywhere in the region reads offline.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';
import {
	ECMWF_DAYS,
	type EcmwfCell,
	ecmwfCell,
	type EcmwfQm,
	applyQm,
	openEcmwfIssue,
	qmGroupFor,
	readEcmwfIndex,
	readEcmwfQm,
	readEcmwfStat
} from '../ingest/ecmwf.js';
import { feedFetcher } from '../jobs/transport.js';
import { MirrorNotReadyError } from '../mirror/readCells.js';
import { mirrorStore } from '../mirror/source.js';
import type { MirrorStore } from '../mirror/store.js';
import type { GridConfig } from './config.js';
import { FeedFormatError } from './errors.js';
import { fetchFailure, type FetchResult, type FetchWindow, gridRead } from './fetch.js';
import { feedSourceMode } from './http.js';
import { ingestResult } from './ingest.js';
import { meanOf } from './sources/chirps.js';
import { beginFeedFetch, type FeedRow, recordFeedChecked, takeFeedFetch } from './store.js';

/** The calibration label of a forecast with no fit applied. */
export const NOT_CALIBRATED = 'not yet calibrated';

/** One issue's ensemble mean at some cells (per day, per cell; NaN for no data), and the fit, if any. */
export interface EcmwfCells {
	issued: string;
	values: number[][];
	qm: EcmwfQm | null;
}

/** Reads the forecast a fetch on `today` uses, at `cells`; MirrorNotReadyError when the copy holds none it may use. */
export type EcmwfReader = (cells: readonly EcmwfCell[], today: string) => Promise<EcmwfCells>;

async function readIssueMean(store: MirrorStore, issue: string, cells: readonly EcmwfCell[]): Promise<number[][]> {
	const arr = await openEcmwfIssue(store, issue);
	// The index lists an issue only once it is written whole; a listed issue without its array is the copy's fault.
	if (!arr) throw new MirrorNotReadyError(`the rain data copy lists the ECMWF forecast issued ${issue} but doesn't hold it`);
	return readEcmwfStat(arr, 'mean', cells);
}

/** A live copy: today's issue if held, else yesterday's. */
export const liveEcmwfReader =
	(store: MirrorStore): EcmwfReader =>
	async (cells, today) => {
		const held = (await readEcmwfIndex(store))?.issues ?? [];
		const yesterday = fromEpochDay(toEpochDay(today) - 1);
		const issued = held.find((d) => d === today) ?? held.find((d) => d === yesterday);
		if (!issued) throw new MirrorNotReadyError(`the rain data copy holds no ECMWF forecast issued ${yesterday} or ${today} yet`);
		return { issued, values: await readIssueMean(store, issued, cells), qm: await readEcmwfQm(store) };
	};

/** The committed fixture issue and the 0.1° block it covers (scripts/ecmwf-fixture.ts writes it). */
export const ECMWF_FIXTURE = { issue: '2026-02-09', block: { y0: 152, x0: 150, h: 4, w: 4 } } as const;

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The committed copy as today's issue, every cell read from the fixture block (see the header). */
export const fixtureEcmwfReader =
	(store: MirrorStore): EcmwfReader =>
	async (cells, today) => {
		const held = (await readEcmwfIndex(store))?.issues ?? [];
		if (!held.length) throw new MirrorNotReadyError('the rain data copy holds no ECMWF forecast yet');
		const b = ECMWF_FIXTURE.block;
		const at = cells.map((c) => ({ y: b.y0 + mod(c.y - b.y0, b.h), x: b.x0 + mod(c.x - b.x0, b.w) }));
		return { issued: today, values: await readIssueMean(store, held[0]!, at), qm: await readEcmwfQm(store) };
	};

/** The reader for this process: the live copy, or the committed one as today's. */
export function ecmwfMirrorReader(store: MirrorStore = mirrorStore()): EcmwfReader {
	return feedSourceMode() === 'live' ? liveEcmwfReader(store) : fixtureEcmwfReader(store);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The forecast of `config`'s cells from the copy, as a forecast fetch
 * answers: the issue's 15 days of the ensemble mean, each the weighted mean
 * of the cells' 0.1° cells, quantile-mapped when a fit covers the place and
 * season. Throws MirrorOutsideRegionError for a cell outside the copy and
 * MirrorNotReadyError when the copy holds no issue the fetch may use.
 */
export async function ecmwfForecastFromMirror(config: GridConfig, today: string, reader: EcmwfReader): Promise<Extract<FetchResult, { ok: true }>> {
	const { cells, noData, used } = gridRead(config);
	const grid = cells.map((c) => ecmwfCell(c.lat, c.lon));
	const key = (g: EcmwfCell) => `${g.y},${g.x}`;
	const unique = [...new Map(grid.map((g) => [key(g), g])).values()];
	const index = new Map(unique.map((g, i) => [key(g), i]));
	const r = await reader(unique, today);
	if (r.values.length !== ECMWF_DAYS) throw new FeedFormatError(`the rain data copy's ECMWF forecast issued ${r.issued} is not a whole issue`);
	const atCell = (day: number[], g: EcmwfCell) => {
		const v = day[index.get(key(g))!]!;
		return Number.isNaN(v) ? null : v;
	};
	// The feed's centre (weighted), for the fit's group.
	const w = cells.reduce((s, c) => s + c.weight, 0);
	const lat = cells.reduce((s, c) => s + c.lat * c.weight, 0) / w;
	const lon = cells.reduce((s, c) => s + c.lon * c.weight, 0) / w;
	let calibrated: string | null = null;
	const values = r.values.map((day, d) => {
		const v = meanOf(
			grid.map((g) => atCell(day, g)),
			cells,
			noData
		);
		const month = Number(fromEpochDay(toEpochDay(r.issued) + d).slice(5, 7));
		const group = r.qm ? qmGroupFor(r.qm, lat, lon, month) : null;
		if (!group) return v;
		calibrated = `quantile-mapped ${r.qm!.fittedAt}`;
		return round2(applyQm(group.pairs, v));
	});
	return { ok: true, startDate: r.issued, values, meta: { days: values.length, issued: r.issued, model: 'ECMWF ENS mean', calibration: calibrated ?? NOT_CALIBRATED, ...used() } };
}

/** How a forecast fetch from the copy ended: merged (or failed, recorded on the feed), or the copy holds no issue yet. */
export type EcmwfMirrorOutcome = 'ingested' | 'not_ready';

/** One ECMWF feed_fetch read from the copy and ingested, in the job's transaction as its acting user (feed-fetch.ts). */
export async function fetchEcmwfFromMirror(
	db: Db,
	feed: FeedRow,
	window: FetchWindow,
	opts: { jobId: string; today: string; reader?: EcmwfReader }
): Promise<EcmwfMirrorOutcome> {
	const config = feed.config as GridConfig;
	// As fromMirrorGefs.ts: in production this is the feed's newest fetch, so a stray older answer is dropped.
	if (feedFetcher() === 'sqs') {
		await beginFeedFetch(db, feed.id, opts.jobId, window);
		await takeFeedFetch(db, feed.id, opts.jobId);
	}
	let result: FetchResult;
	try {
		result = await ecmwfForecastFromMirror(config, opts.today, opts.reader ?? ecmwfMirrorReader());
	} catch (err) {
		if (err instanceof MirrorNotReadyError) {
			await recordFeedChecked(db, feed.id);
			return 'not_ready';
		}
		result = fetchFailure(err, config);
	}
	await ingestResult(db, feed, result, window, { fetchJobId: opts.jobId });
	return 'ingested';
}
